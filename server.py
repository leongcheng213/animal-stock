#!/usr/bin/env python3
"""
Animal Stock — authoritative multiplayer server (spec section 12).

Stdlib only (no pip install needed): one TCP port serves both the static
mobile client (client/) and the WebSocket endpoint (/ws).

Run:
    python server.py [--port 8000]

Phones on the same Wi-Fi join via http://<your-lan-ip>:8000 and enter the
4-character room code. For play across networks, host this on anything that
supports long-lived connections (Fly.io, Railway, Render) — serverless
functions (e.g. Vercel defaults) will not hold WebSockets (spec section 12).

Protocol (JSON text frames):
  C->S: CREATE {name} | JOIN {room, name, playerId?} | START | TAKE_ORDER
        | CHOOSE_HALF {halfIndex} | HIPPO_FLIP {orderIndex|null} | RING_BELL
        | NEXT_ROUND | RESTART | LEAVE
        | ADD_BOTS {count} | REMOVE_BOT {playerId} | RESULTS
        The bell always judges the last face-up order's animal only.
        LEAVE mid-game turns your seat into a bot (game continues);
        JOIN mid-game takes over a bot seat. Reconnect with your playerId
        to reclaim a disconnected seat. ADD_BOTS fills lobby seats with
        bots for solo play (host only). A Hippo draw blocks the next
        player's bell for one turn (RING_BELL rejected).
  S->C: WELCOME {playerId, room} | STATE {state: redacted, youId}
        | DRAWN {card} | ERROR {message} | PING
"""
import argparse
import base64
import hashlib
import json
import mimetypes
import os
import random
import secrets
import select
import socket
import struct
import threading
import time
import traceback

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CLIENT_DIR = os.path.join(BASE_DIR, "client")
SHARED_DIR = os.path.join(BASE_DIR, "shared")

import sys
sys.path.insert(0, BASE_DIR)
from shared.game_logic import (
    setup_round, resolve_bell, redact_for_viewer, make_room_code,
    is_hippo, ANIMALS, hippo_flip_order,
)

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# A phone that locks or walks out of Wi-Fi stops reading; its TCP window fills
# and a send to it blocks. broadcast() writes to players in turn, so one dead
# handset used to hold up everyone else's update for the socket's whole 120s
# timeout. Sends get their own, much shorter budget instead: miss it and that
# connection is dropped (the client reconnects on its own and STATE is a full
# snapshot, so nothing is lost but the dead socket).
SEND_TIMEOUT = 5.0      # seconds to get one frame out before giving up on a peer
SEND_LOCK_WAIT = 0.5    # seconds to wait behind another thread writing to it
TURN_SECONDS = 30
# Taking a card and choosing its half are two separate decisions, so they get
# two separate clocks: drawing restarts the countdown rather than eating into
# whatever is left of the turn. Counting four species under a shared 15s clock
# was too tight for a new player. Kept equal so the client's ring animation
# has one window length to draw.
CHOOSE_SECONDS = TURN_SECONDS
MAX_PLAYERS = 6
MIN_PLAYERS = 2

# Bump when the protocol gains messages. Client solo-vs-bots needs v3+.
PROTOCOL_VERSION = 3

BOT_NAMES = ["Mochi", "Taro", "Pudding", "Miso", "Goma", "Yuzu",
             "Pocky", "Dango", "Soba", "Udon"]

rooms = {}          # code -> {"state":..., "conns": {playerId: [WSConn]}, "lock": Lock, "lastActive": ts}
rooms_lock = threading.Lock()


# ---------------------------------------------------------------- websocket

def ws_text_frame(obj):
    """Encode one JSON message as a finished websocket text frame.

    Returning bytes matters: once encoded, the payload can no longer be
    changed by another thread mutating the state it came from, so a frame
    built under a room's lock stays consistent after the lock is released.
    """
    data = json.dumps(obj).encode("utf-8")
    header = bytes([0x81])
    n = len(data)
    if n < 126:
        header += bytes([n])
    elif n < 65536:
        header += bytes([126]) + struct.pack(">H", n)
    else:
        header += bytes([127]) + struct.pack(">Q", n)
    return header + data


class WSConn:
    def __init__(self, sock):
        self.sock = sock
        self.send_lock = threading.Lock()
        self.closed = False
        self.player_id = None
        self.room_code = None

    def _write_frame(self, data):
        """Write one frame under SEND_TIMEOUT. Raises OSError if the peer will
        not take it in time — which leaves a partial frame on the wire, so the
        caller must drop the connection rather than send anything more."""
        view = memoryview(data)
        deadline = time.monotonic() + SEND_TIMEOUT
        while view:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise socket.timeout("send timed out")
            _, writable, _ = select.select((), (self.sock,), (), remaining)
            if not writable:
                continue
            sent = self.sock.send(view)
            if sent <= 0:
                raise OSError("peer closed")
            view = view[sent:]

    def send_raw(self, data):
        """Send one already-framed message, without blocking the caller behind
        a peer that has stopped reading."""
        if self.closed:
            return
        # a thread already stuck writing to this socket must not hold up the
        # room: skip this frame rather than queue behind it
        if not self.send_lock.acquire(timeout=SEND_LOCK_WAIT):
            return
        try:
            if self.closed:
                return
            self._write_frame(data)
        except OSError:
            self.close()
        finally:
            self.send_lock.release()

    def send_json(self, obj):
        self.send_raw(ws_text_frame(obj))

    def send_ping(self):
        self.send_raw(bytes([0x89, 0x00]))

    def close(self):
        self.closed = True
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


def recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("closed")
        buf += chunk
    return buf


def ws_recv_message(sock):
    """Read one WebSocket frame, return (opcode, payload bytes)."""
    hdr = recv_exact(sock, 2)
    b1, b2 = hdr[0], hdr[1]
    fin = (b1 & 0x80) != 0
    opcode = b1 & 0x0F
    masked = (b2 & 0x80) != 0
    length = b2 & 0x7F
    if length == 126:
        length = struct.unpack(">H", recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack(">Q", recv_exact(sock, 8))[0]
    key = recv_exact(sock, 4) if masked else None
    payload = recv_exact(sock, length) if length else b""
    if masked and key:
        payload = bytes(b ^ key[i % 4] for i, b in enumerate(payload))
    if not fin:
        # continuation: accumulate (messages here are small; loop simply)
        op2, more = ws_recv_message(sock)
        return opcode, payload + more
    return opcode, payload


# ---------------------------------------------------------------- rooms

def get_room(code):
    with rooms_lock:
        return rooms.get(code)


def broadcast(room_code):
    room = get_room(room_code)
    if not room:
        return
    targets = []
    with room["lock"]:
        state = room["state"]
        # Redact AND encode in here. A redacted payload still shares mutable
        # pieces with the live state (an order's flippedBy list, the
        # lastResolution dict), so serialising it after the lock was released
        # could ship a torn frame — or trip over a dict that changed size
        # mid-encode. One frame per player, reused across their sockets.
        for pid, conns in room["conns"].items():
            live = [c for c in conns if not c.closed]
            if not live:
                continue
            frame = ws_text_frame({"type": "STATE",
                                   "state": redact_for_viewer(state, pid)})
            for c in live:
                targets.append((c, frame))
        room["lastActive"] = time.time()
    # sending stays outside the lock — a slow peer must never hold the room
    for conn, frame in targets:
        try:
            conn.send_raw(frame)
        except Exception:
            pass


def send_drawn(room_code, player_id):
    room = get_room(room_code)
    if not room:
        return
    with room["lock"]:
        state = room["state"]
        pd = state.get("pendingDraw")
        if not pd or pd["by"] != player_id:
            return
        card = state["cards"].get(pd["cardId"])
        conns = list(room["conns"].get(player_id, []))
    for c in conns:
        if not c.closed and card:
            c.send_json({"type": "DRAWN", "card": card})


def error_to(conn, message):
    try:
        conn.send_json({"type": "ERROR", "message": message})
    except Exception:
        pass


def reset_turn_timer(state):
    state["turnDeadline"] = time.time() + TURN_SECONDS


def reset_choice_timer(state):
    """Fresh clock for picking a half / a Hippo target. The draw stops the
    turn clock draining into the choice: each decision gets its own window."""
    state["turnDeadline"] = time.time() + CHOOSE_SECONDS


# deal/shuffle animation plays on every client at round start — the first
# turn's clock starts only once it has finished
DEAL_SECONDS = 3.0


def reset_round_timer(state):
    state["turnDeadline"] = time.time() + TURN_SECONDS + DEAL_SECONDS
    state["aiActAt"] = None


# ---------------------------------------------------------------- bot AI
# A player who exits mid-game becomes a bot (p["ai"] = True) so the game
# continues. Bots play only with information a human would have: they never
# peek at their own hidden stock card (max 3 of any animal can hide there).

AI_THINK_MIN, AI_THINK_MAX = 2.0, 4.0
MAX_HIDDEN_PER_ANIMAL = 3  # most of one animal a hidden stock card can hold

# ---- bluff-calling tunables ------------------------------------------------
# A bot that rings only on a *provable* oversell never bluffs, so bot-heavy
# games drift to a deck-out instead of ending in an argument. These give bots a
# small, tunable willingness to call an oversell they only believe.
#
# BLUFF_RARITY is how far a bot trusts a gap it cannot prove, per species: the
# odds a hidden stock card is NOT quietly covering it. Driven by how much of the
# deck each animal occupies (34 animal cards, 113 animals in total):
#
#     toucan     48  (42.5%)   common — a hidden card very often holds toucans
#     zebra      32  (28.3%)
#     crocodile  23  (20.4%)
#     lion       10  ( 8.8%)   rare — a lion oversell is usually real
#
# Set BLUFF_BASE = 0.0 to switch bluffing off entirely and get the old
# provable-only bot back.
BLUFF_RARITY = {"toucan": 0.15, "zebra": 0.30, "crocodile": 0.50, "lion": 0.85}
BLUFF_BASE = 0.45        # scales every unprovable call
BLUFF_GAP_BONUS = 0.20   # added per animal of gap beyond the first
BLUFF_MAX = 0.75         # never a certainty — bots have to be wrong sometimes


def _bluff_chance(animal, gap):
    """Odds a bot calls an oversell it cannot prove.

    `gap` is how far the face-up orders exceed the stock this bot can SEE —
    which excludes its own card, so a small gap is often just its own card
    quietly covering the board. Rare animals are trusted more: there are only
    ten lions in the deck, so a lion gap is rarely a mirage.
    """
    if gap <= 0:
        return 0.0
    chance = BLUFF_BASE * BLUFF_RARITY.get(animal, 0.3) + BLUFF_GAP_BONUS * (gap - 1)
    return max(0.0, min(BLUFF_MAX, chance))


def _visible_stock(state, pid):
    """Stock the given player can actually see: others' cards + dummy."""
    tally = {a: 0 for a in ANIMALS}
    for p in state["players"]:
        cid = p.get("stockCardId")
        if not cid or p["id"] == pid:
            continue
        card = state["cards"].get(cid)
        if not card or is_hippo(card):
            continue
        for h in card["halves"]:
            tally[h["animal"]] += h["count"]
    dcid = state.get("dummyStockCardId")
    if dcid:
        card = state["cards"].get(dcid)
        if card and not is_hippo(card):
            for h in card["halves"]:
                tally[h["animal"]] += h["count"]
    return tally


def _faceup_tally(state):
    """Raw face-up orders. (Stock hippos are hidden info mid-round, so the
    bot — like a human — does not account for them.)"""
    tally = {a: 0 for a in ANIMALS}
    for o in state["orders"]:
        if o["faceUp"]:
            tally[o["animal"]] += o["count"]
    return tally


def ai_should_ring(state, pid):
    """Ring when the board is provably oversold from visible info alone, and
    sometimes when it is merely likely (see _bluff_chance). Never on a
    post-Hippo blocked turn.

    Every input here is public: face-up orders and the stock cards this bot can
    see. It never looks at its own stockCardId — the hidden card is exactly the
    doubt a bluff-call is gambling on.
    """
    if state.get("noRingFor") == pid:
        return False
    face = [o for o in state["orders"] if o["faceUp"]]
    if not face:
        return False
    vt = _visible_stock(state, pid)
    ft = _faceup_tally(state)
    checked = [face[-1]["animal"]]   # the bell judges the newest order only
    # provable: bigger than any single hidden card could be covering
    if any(ft[a] > vt[a] + MAX_HIDDEN_PER_ANIMAL for a in checked):
        return True
    # believable but unprovable: call it sometimes, readily on rare animals
    return any(random.random() < _bluff_chance(a, ft[a] - vt[a]) for a in checked)


def _ai_pick_half(state, pid, card):
    """Choose the half with the most headroom over visible stock."""
    vt = _visible_stock(state, pid)
    ft = _faceup_tally(state)
    headroom = [(vt[h["animal"]] + MAX_HIDDEN_PER_ANIMAL) - (ft[h["animal"]] + h["count"])
                for h in card["halves"]]
    if headroom[0] == headroom[1]:
        return random.randint(0, 1)
    return 0 if headroom[0] > headroom[1] else 1


def _ai_pick_flip(state):
    """Flip the biggest face-up order (ties -> most recent). None if empty."""
    best = None
    for i, o in enumerate(state["orders"]):
        if not o["faceUp"]:
            continue
        if best is None or (o["count"], i) >= (state["orders"][best]["count"], best):
            best = i
    return best


def maybe_schedule_ai(state):
    """If the ball is in a bot's court, give it a short 'thinking' delay."""
    if state.get("phase") != "playing":
        state["aiActAt"] = None
        return
    pd = state.get("pendingDraw")
    if pd:
        who = next((p for p in state["players"] if p["id"] == pd["by"]), None)
    else:
        who = next((p for p in state["players"] if p["seat"] == state["activeSeat"]), None)
    if who is not None and who.get("ai"):
        state["aiActAt"] = time.time() + random.uniform(AI_THINK_MIN, AI_THINK_MAX)
    else:
        state["aiActAt"] = None


def seat_of(state, player_id):
    for p in state["players"]:
        if p["id"] == player_id:
            return p["seat"]
    return None


def is_active(state, player_id):
    if state["phase"] != "playing":
        return False
    act = [p for p in state["players"] if p["seat"] == state["activeSeat"]]
    return bool(act and act[0]["id"] == player_id)


def _append_order(state, card, half, pid):
    """Append a chosen-half order, keeping the unchosen half for display."""
    h = card["halves"][half]
    other = card["halves"][1 - half]
    state["orders"].append({"cardId": card["id"], "halfIndex": half,
                            "faceUp": True, "placedBy": pid,
                            "animal": h["animal"], "count": h["count"],
                            "discarded": {"animal": other["animal"],
                                          "count": other["count"]}})
    state["lastOrderBy"] = pid
    # taking an order lifts your own post-Hippo ring block, if any
    if state.get("noRingFor") == pid:
        state["noRingFor"] = None
        state["noRingBy"] = None


def _block_ring_next(state, flipper_pid):
    """After a Hippo resolves, the incoming player may not ring this turn."""
    nxt = next((p for p in state["players"] if p["seat"] == state["activeSeat"]), None)
    if nxt is not None:
        state["noRingFor"] = nxt["id"]
        state["noRingBy"] = flipper_pid


def auto_play(room_code, reason="timeout", for_ai=False):
    """Spec section 11: auto-take-order on timeout rather than ending round.
    Also drives bot turns (for_ai=True), which may additionally ring the bell
    when provably oversold. Flipping a Hippo never changes lastOrderBy, so a
    flip can never make the flipper the blamed player that round."""
    room = get_room(room_code)
    if not room:
        return
    with room["lock"]:
        state = room["state"]
        if state["phase"] != "playing":
            return
        act = [p for p in state["players"] if p["seat"] == state["activeSeat"]]
        if not act:
            return
        pid = act[0]["id"]
        pd = state.get("pendingDraw")
        if pd and pd["by"] == pid:
            card = state["cards"].get(pd["cardId"])
            if card and is_hippo(card):
                # swap the picked/unpicked halves of a face-up order,
                # else discard with no effect
                idx = _ai_pick_flip(state)
                if idx is not None:
                    hippo_flip_order(state, idx, pd["cardId"])
                else:
                    state["hippoDiscards"].append(pd["cardId"])
                state["pendingDraw"] = None
                state["activeSeat"] = (state["activeSeat"] + 1) % len(state["players"])
                reset_turn_timer(state)
                _block_ring_next(state, pid)
                maybe_schedule_ai(state)
            elif card:
                _append_order(state, card, _ai_pick_half(state, pid, card), pid)
                state["pendingDraw"] = None
                state["activeSeat"] = (state["activeSeat"] + 1) % len(state["players"])
                reset_turn_timer(state)
                maybe_schedule_ai(state)
            need_broadcast = True
        else:
            # bots ring when they can prove an oversell (never on a blocked
            # turn); timed-out humans just take (never ring for them).
            face = [o for o in state["orders"] if o["faceUp"]]
            if for_ai and face and ai_should_ring(state, pid):
                try:
                    resolve_bell(state, pid)
                except ValueError:
                    pass
                else:
                    state["turnDeadline"] = None
                    state["aiActAt"] = None
                    state["revealAt"] = time.time()
                need_broadcast = True
            elif not state["deck"]:
                # section 11: deck out -> auto-resolve as if active rang
                if face:
                    try:
                        resolve_bell(state, pid)
                    except ValueError:
                        pass
                    else:
                        state["revealAt"] = time.time()
                need_broadcast = True
            else:
                cid = state["deck"].pop(0)
                card = state["cards"][cid]
                if is_hippo(card):
                    idx = _ai_pick_flip(state)
                    if idx is not None:
                        hippo_flip_order(state, idx, cid)
                    else:
                        state["hippoDiscards"].append(cid)
                    state["activeSeat"] = (state["activeSeat"] + 1) % len(state["players"])
                    reset_turn_timer(state)
                    _block_ring_next(state, pid)
                    maybe_schedule_ai(state)
                else:
                    _append_order(state, card, _ai_pick_half(state, pid, card), pid)
                    state["activeSeat"] = (state["activeSeat"] + 1) % len(state["players"])
                    reset_turn_timer(state)
                    maybe_schedule_ai(state)
                need_broadcast = True
    if need_broadcast:
        broadcast(room_code)


def timer_monitor():
    while True:
        time.sleep(1.0)
        now = time.time()
        expired = []
        ai_due = []
        reveal_due = []
        with rooms_lock:
            items = list(rooms.items())
        for code, room in items:
            try:
                with room["lock"]:
                    st = room["state"]
                    dl = st.get("turnDeadline")
                    ai_at = st.get("aiActAt")
                    phase = st.get("phase")
                    if phase == "playing" and dl and now > dl:
                        expired.append(code)
                    elif phase == "playing" and ai_at and now >= ai_at:
                        ai_due.append(code)
                    elif (phase == "reveal" and st.get("revealAt")
                            and now - st["revealAt"] > 6
                            and not any(p.get("connected") and not p.get("ai")
                                        for p in st["players"])):
                        # nobody human left watching — bots play on
                        reveal_due.append(code)
            except Exception:
                pass
        for code in expired:
            try:
                auto_play(code)
            except Exception:
                traceback.print_exc()
        for code in ai_due:
            try:
                auto_play(code, for_ai=True)
            except Exception:
                traceback.print_exc()
        for code in reveal_due:
            try:
                room = get_room(code)
                if room:
                    with room["lock"]:
                        if room["state"].get("phase") == "reveal":
                            if room["state"].get("loserId"):
                                room["state"]["phase"] = "gameOver"
                                room["state"]["turnDeadline"] = None
                                room["state"]["aiActAt"] = None
                                room["state"]["revealAt"] = None
                            else:
                                setup_round(room["state"])
                                reset_round_timer(room["state"])
                                maybe_schedule_ai(room["state"])
                    broadcast(code)
            except Exception:
                traceback.print_exc()
        # heartbeat + sweep
        try:
            with rooms_lock:
                items2 = list(rooms.items())
            for code, room in items2:
                with room["lock"]:
                    conns = [(pid, c) for pid, cs in room["conns"].items() for c in cs if not c.closed]
                    last = room.get("lastActive", now)
                for _, c in conns:
                    try:
                        c.send_ping()
                    except Exception:
                        pass
                if not conns and now - last > 7200:
                    with rooms_lock:
                        rooms.pop(code, None)
        except Exception:
            pass


# ---------------------------------------------------------------- handlers

def clean_name(name):
    name = str(name or "").strip()[:12]
    return name or "Player"


def handle_message(conn, msg):
    mtype = msg.get("type")
    if mtype == "CREATE":
        name = clean_name(msg.get("name"))
        pid = secrets.token_hex(4)
        for _ in range(20):
            code = make_room_code()
            with rooms_lock:
                if code not in rooms:
                    break
        from shared.game_logic import new_room_state
        state = new_room_state(code, pid, name)
        with rooms_lock:
            rooms[code] = {"state": state, "conns": {pid: [conn]},
                           "lock": threading.Lock(), "lastActive": time.time()}
        conn.player_id = pid
        conn.room_code = code
        conn.send_json({"type": "WELCOME", "playerId": pid, "room": code,
                        "v": PROTOCOL_VERSION})
        broadcast(code)
        return

    if mtype == "JOIN":
        code = str(msg.get("room") or "").strip().upper()
        name = clean_name(msg.get("name"))
        claimed = msg.get("playerId")
        room = get_room(code)
        if not room:
            error_to(conn, "Room not found. Check the 4-letter code.")
            return
        with room["lock"]:
            state = room["state"]
            existing = None
            if claimed:
                for p in state["players"]:
                    if p["id"] == claimed:
                        existing = p
                        break
            if existing:
                pid = existing["id"]
                existing["connected"] = True
                existing["ai"] = False  # taking your seat back from a bot
                if name and name != "Player":
                    existing["name"] = name
                took_over = False
            else:
                if state["phase"] != "lobby":
                    # mid-game join takes over a bot seat (keeps its history)
                    seat = next((p for p in state["players"] if p.get("ai")), None)
                    if seat is None:
                        error_to(conn, "Game already started — ask the host for the next round.")
                        return
                    names = {p["name"] for p in state["players"]}
                    base, i = name, 2
                    while name in names:
                        name = f"{base[:10]}{i}"
                        i += 1
                    seat["name"] = name
                    seat["ai"] = False
                    seat["connected"] = True
                    pid = seat["id"]
                    room["conns"].setdefault(pid, []).append(conn)
                    room["lastActive"] = time.time()
                    maybe_schedule_ai(state)
                    took_over = True
                else:
                    if len(state["players"]) >= MAX_PLAYERS:
                        error_to(conn, "Room is full (6 players max).")
                        return
                    # unique name guard
                    names = {p["name"] for p in state["players"]}
                    base, i = name, 2
                    while name in names:
                        name = f"{base[:10]}{i}"
                        i += 1
                    pid = secrets.token_hex(4)
                    state["players"].append({"id": pid, "name": name,
                                              "seat": len(state["players"]),
                                              "stockCardId": None, "tokens": [],
                                              "connected": True, "ai": False})
                    room["conns"].setdefault(pid, [])
                    took_over = False
                    # a bot must never hold the host crown — hand it to a human
                    host = next((p for p in state["players"] if p["id"] == state["hostId"]), None)
                    if host is None or host.get("ai"):
                        state["hostId"] = pid
            if not took_over:
                room["conns"].setdefault(pid, []).append(conn)
                room["lastActive"] = time.time()
        conn.player_id = pid
        conn.room_code = code
        conn.send_json({"type": "WELCOME", "playerId": pid, "room": code,
                        "v": PROTOCOL_VERSION})
        broadcast(code)
        return

    # all remaining messages require membership
    room_code = conn.room_code or str(msg.get("room") or "").upper()
    room = get_room(room_code)
    if not room:
        error_to(conn, "Room gone. Create a new one.")
        return
    pid = conn.player_id or msg.get("playerId")
    if not pid:
        error_to(conn, "Join a room first.")
        return

    with room["lock"]:
        state = room["state"]
        me = next((p for p in state["players"] if p["id"] == pid), None)
        if not me:
            error_to(conn, "Seat not found in this room.")
            return
        me["connected"] = True
        if me.get("ai"):
            me["ai"] = False  # acting again = taking your seat back from the bot
            maybe_schedule_ai(state)
        if conn not in room["conns"].get(pid, []):
            room["conns"].setdefault(pid, []).append(conn)
        room["lastActive"] = time.time()

    if mtype == "START":
        with room["lock"]:
            state = room["state"]
            if pid != state["hostId"]:
                error_to(conn, "Only the host can start.")
                return
            if state["phase"] != "lobby":
                return
            if len(state["players"]) < MIN_PLAYERS:
                error_to(conn, "Need at least 2 players to start.")
                return
            for p in state["players"]:
                p["tokens"] = []
            state["nextTokenValue"] = 1
            state["round"] = 0
            state["winners"] = []
            state["loserId"] = None
            setup_round(state)
            state["activeSeat"] = random.randrange(len(state["players"]))
            reset_round_timer(state)
            maybe_schedule_ai(state)
        broadcast(room_code)
        return

    if mtype == "TAKE_ORDER":
        with room["lock"]:
            state = room["state"]
            if state["phase"] != "playing":
                error_to(conn, "Not in a round.")
                return
            if not is_active(state, pid):
                error_to(conn, "Wait for your turn.")
                return
            if state.get("pendingDraw"):
                error_to(conn, "Finish choosing first.")
                return
            if not state["deck"]:
                # section 11: deck out -> auto-resolve as if active rang
                face = [o for o in state["orders"] if o["faceUp"]]
                if not face:
                    error_to(conn, "Deck is out and board is empty — ringing instead.")
                    return
                try:
                    resolve_bell(state, pid)
                except ValueError as e:
                    error_to(conn, str(e))
                    return
                state["turnDeadline"] = None
                state["aiActAt"] = None
                state["revealAt"] = time.time()
                need_drawn = False
            else:
                cid = state["deck"].pop(0)
                state["pendingDraw"] = {"by": pid, "cardId": cid}
                # the picker is its own decision — give it its own countdown
                reset_choice_timer(state)
                need_drawn = True
        broadcast(room_code)
        if need_drawn:
            send_drawn(room_code, pid)
        return

    if mtype == "CHOOSE_HALF":
        half = msg.get("halfIndex")
        with room["lock"]:
            state = room["state"]
            pd = state.get("pendingDraw")
            if not pd or pd["by"] != pid:
                error_to(conn, "Nothing to choose.")
                return
            card = state["cards"].get(pd["cardId"])
            if not card or is_hippo(card):
                error_to(conn, "That card needs a Hippo choice, not a half.")
                return
            if half not in (0, 1):
                error_to(conn, "Pick half A or B.")
                return
            _append_order(state, card, half, pid)
            state["pendingDraw"] = None
            state["activeSeat"] = (state["activeSeat"] + 1) % len(state["players"])
            reset_turn_timer(state)
            maybe_schedule_ai(state)
        broadcast(room_code)
        return

    if mtype == "HIPPO_FLIP":
        idx = msg.get("orderIndex")
        with room["lock"]:
            state = room["state"]
            pd = state.get("pendingDraw")
            if not pd or pd["by"] != pid:
                error_to(conn, "Nothing to choose.")
                return
            card = state["cards"].get(pd["cardId"])
            if not card or not is_hippo(card):
                error_to(conn, "That card needs a half choice, not a Hippo flip.")
                return
            face = [i for i, o in enumerate(state["orders"]) if o["faceUp"]]
            if not face:
                # section 6 edge case: no orders -> discard, no effect
                state["hippoDiscards"].append(pd["cardId"])
                state["pendingDraw"] = None
                state["activeSeat"] = (state["activeSeat"] + 1) % len(state["players"])
                reset_turn_timer(state)
                _block_ring_next(state, pid)
                maybe_schedule_ai(state)
            else:
                if idx is None or idx not in face:
                    error_to(conn, "Pick a face-up order to swap.")
                    return
                # swap picked/unpicked halves; the hippo parks beside the row
                hippo_flip_order(state, idx, pd["cardId"])
                state["pendingDraw"] = None
                state["activeSeat"] = (state["activeSeat"] + 1) % len(state["players"])
                reset_turn_timer(state)
                _block_ring_next(state, pid)
                maybe_schedule_ai(state)
        broadcast(room_code)
        return

    if mtype == "RING_BELL":
        with room["lock"]:
            state = room["state"]
            if state["phase"] != "playing":
                error_to(conn, "Not in a round.")
                return
            if not is_active(state, pid):
                error_to(conn, "Only the active player may ring (wait for your turn).")
                return
            if state.get("pendingDraw"):
                error_to(conn, "Finish choosing first.")
                return
            if state.get("noRingFor") == pid:
                error_to(conn, "Ring is blocked this turn - a Hippo was just played. Take an order.")
                return
            face = [o for o in state["orders"] if o["faceUp"]]
            if not face:
                error_to(conn, "Bell is illegal with no face-up orders — take an order.")
                return
            try:
                resolve_bell(state, pid)
            except ValueError as e:
                error_to(conn, str(e))
                return
            state["turnDeadline"] = None
            state["aiActAt"] = None
            state["revealAt"] = time.time()
        broadcast(room_code)
        return

    if mtype == "NEXT_ROUND":
        with room["lock"]:
            state = room["state"]
            if state["phase"] != "reveal":
                error_to(conn, "Round is not over yet.")
                return
            if state.get("loserId"):
                error_to(conn, "Game is over — see the results first.")
                return
            # activeSeat was already set to the blamed (token-taker) in resolve_bell
            setup_round(state)
            reset_round_timer(state)
            maybe_schedule_ai(state)
        broadcast(room_code)
        return

    if mtype == "RESULTS":
        # final round's audit was seen — now show the winning message
        with room["lock"]:
            state = room["state"]
            if state["phase"] != "reveal" or not state.get("loserId"):
                error_to(conn, "No results to show yet.")
                return
            state["phase"] = "gameOver"
            state["turnDeadline"] = None
            state["aiActAt"] = None
            state["revealAt"] = None
        broadcast(room_code)
        return

    if mtype == "RESTART":
        with room["lock"]:
            state = room["state"]
            if state["phase"] != "gameOver":
                return
            for p in state["players"]:
                p["tokens"] = []
            state["nextTokenValue"] = 1
            state["round"] = 0
            state["winners"] = []
            state["loserId"] = None
            setup_round(state)
            state["activeSeat"] = random.randrange(len(state["players"]))
            reset_round_timer(state)
            maybe_schedule_ai(state)
        broadcast(room_code)
        return
    if mtype == "ADD_BOTS":
        try:
            count = int(msg.get("count", 0))
        except (TypeError, ValueError):
            error_to(conn, "How many bots?")
            return
        with room["lock"]:
            state = room["state"]
            if state["phase"] != "lobby":
                error_to(conn, "Bots can only join in the lobby.")
                return
            if pid != state["hostId"]:
                error_to(conn, "Only the host can add bots.")
                return
            room_left = MAX_PLAYERS - len(state["players"])
            if count < 1 or room_left < 1:
                error_to(conn, "No room for bots (6 players max).")
                return
            count = min(count, room_left)
            taken = {p["name"] for p in state["players"]}
            pool = [n for n in BOT_NAMES if n not in taken]
            for k in range(count):
                name = pool.pop(0) if pool else f"Bot{len(state['players']) + 1}"
                taken.add(name)
                state["players"].append({"id": secrets.token_hex(4),
                                          "name": name,
                                          "seat": len(state["players"]),
                                          "stockCardId": None, "tokens": [],
                                          "connected": False, "ai": True})
        broadcast(room_code)
        return

    if mtype == "REMOVE_BOT":
        target = msg.get("playerId")
        with room["lock"]:
            state = room["state"]
            if state["phase"] != "lobby":
                error_to(conn, "Bots can only leave in the lobby.")
                return
            if pid != state["hostId"]:
                error_to(conn, "Only the host can remove bots.")
                return
            bot = next((p for p in state["players"]
                        if p["id"] == target and p.get("ai")), None)
            if bot is None:
                error_to(conn, "Bot not found (humans can't be removed).")
                return
            state["players"] = [p for p in state["players"] if p["id"] != target]
            for i, p in enumerate(state["players"]):
                p["seat"] = i
        broadcast(room_code)
        return

    if mtype == "LEAVE":
        with room["lock"]:
            state = room["state"]
            if state["phase"] == "lobby":
                state["players"] = [p for p in state["players"] if p["id"] != pid]
                for i, p in enumerate(state["players"]):
                    p["seat"] = i
                room["conns"].pop(pid, None)
                if state["players"]:
                    if state["hostId"] == pid:
                        humans = [p for p in state["players"] if not p.get("ai")]
                        state["hostId"] = (humans[0] if humans
                                           else state["players"][0])["id"]
                else:
                    room["empty"] = True
            else:
                # mid-game exit: a bot takes the seat and the game continues.
                # (Plain disconnects stay reconnectable; only an explicit
                # exit becomes a bot.)
                me["ai"] = True
                me["connected"] = False
                room["conns"].pop(pid, None)
                maybe_schedule_ai(state)
        conn.room_code = None
        if room.get("empty"):
            with rooms_lock:
                rooms.pop(room_code, None)
        else:
            broadcast(room_code)
        return

    error_to(conn, f"Unknown message {mtype!r}")


def handle_ws(sock, conn):
    room_code = conn.room_code
    try:
        while not conn.closed:
            opcode, payload = ws_recv_message(sock)
            if opcode == 0x8:  # close
                break
            if opcode == 0x9:  # ping -> pong
                conn.send_raw(bytes([0x8A, 0x00]))
                if conn.closed:
                    break
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode != 0x1:
                continue
            try:
                msg = json.loads(payload.decode("utf-8"))
            except Exception:
                error_to(conn, "Bad message.")
                continue
            try:
                handle_message(conn, msg)
            except Exception:
                traceback.print_exc()
                error_to(conn, "Server error handling that move.")
    except (ConnectionError, OSError):
        pass
    finally:
        # mark disconnected; keep seat for reconnect (phones lock constantly)
        try:
            if conn.room_code:
                room = get_room(conn.room_code)
                if room:
                    with room["lock"]:
                        lst = room["conns"].get(conn.player_id, [])
                        if conn in lst:
                            lst.remove(conn)
                        if not room["conns"].get(conn.player_id):
                            for p in room["state"]["players"]:
                                if p["id"] == conn.player_id:
                                    p["connected"] = False
                    broadcast(conn.room_code)
        except Exception:
            pass
        conn.close()


# ---------------------------------------------------------------- http

def serve_http(sock, method, path, headers):
    if path in ("/ws",):
        return False
    # strip query
    if "?" in path:
        path = path.split("?", 1)[0]
    if path == "/":
        path = "/index.html"
    # prevent traversal
    rel = path.lstrip("/").replace("\\", "/")
    if ".." in rel or rel.startswith("/"):
        body = b"bad path"
        sock.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 8\r\nConnection: close\r\n\r\n" + body)
        return True
    full = os.path.join(CLIENT_DIR, *rel.split("/"))
    if not os.path.abspath(full).startswith(os.path.abspath(CLIENT_DIR)):
        body = b"forbidden"
        sock.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 9\r\nConnection: close\r\n\r\n" + body)
        return True
    if os.path.isdir(full):
        full = os.path.join(full, "index.html")
    if not os.path.isfile(full):
        body = b"not found - Animal Stock server. Open / for the game."
        sock.sendall(b"HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: "
                     + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body)
        return True
    mime, _ = mimetypes.guess_type(full)
    # Windows registries sometimes map .js -> text/plain, which browsers
    # reject for <script type="module">. Force correct types.
    if full.endswith(".js"):
        mime = "application/javascript"
    elif full.endswith(".css"):
        mime = "text/css"
    elif full.endswith(".html"):
        mime = "text/html"
    mime = mime or "application/octet-stream"
    with open(full, "rb") as f:
        data = f.read()
    head = (f"HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {len(data)}\r\n"
            f"Cache-Control: no-cache\r\nConnection: close\r\n\r\n").encode()
    sock.sendall(head + data)
    return True


def handle_tcp(client, addr):
    try:
        client.settimeout(8)
        raw = b""
        while b"\r\n\r\n" not in raw:
            chunk = client.recv(4096)
            if not chunk:
                client.close()
                return
            raw += chunk
            if len(raw) > 65536:
                client.close()
                return
        head, _ = raw.split(b"\r\n\r\n", 1)
        lines = head.decode("latin-1").split("\r\n")
        method, path, _ver = (lines[0].split() + ["", "", ""])[:3]
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        is_ws = headers.get("upgrade", "").lower() == "websocket" or path in ("/ws", "/socket")
        if is_ws and "sec-websocket-key" in headers:
            key = headers["sec-websocket-key"]
            accept = base64.b64encode(
                hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
            resp = ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                    "Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n")
            client.sendall(resp.encode())
            client.settimeout(120)
            conn = WSConn(client)
            handle_ws(client, conn)
            return
        elif is_ws:
            body = b"websocket expected at /ws"
            client.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 27\r\nConnection: close\r\n\r\n" + body)
            client.close()
            return
        client.settimeout(10)
        serve_http(client, method, path, headers)
        client.close()
    except Exception:
        try:
            client.close()
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    ap.add_argument("--host", default="0.0.0.0")
    args = ap.parse_args()
    threading.Thread(target=timer_monitor, daemon=True).start()
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((args.host, args.port))
    srv.listen(100)
    print(f"Animal Stock server on http://{args.host}:{args.port}  (client dir: {CLIENT_DIR})")
    print("Phones on the same Wi-Fi: open http://<this-computer-ip>:%d and enter the room code." % args.port)
    while True:
        client, addr = srv.accept()
        threading.Thread(target=handle_tcp, args=(client, addr), daemon=True).start()


if __name__ == "__main__":
    main()
