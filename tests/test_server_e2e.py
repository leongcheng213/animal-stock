"""End-to-end server test (stdlib only). Starts server.py on a test port and
plays a real 2-player game over raw WebSockets. Run: python tests/test_server_e2e.py"""
import base64
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.request

PORT = int(os.environ.get("E2E_PORT", "18765"))


def pick_port():
    for p in (PORT, PORT + 1, PORT + 2, PORT + 3):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(("127.0.0.1", p))
            s.close()
            return p
        except OSError:
            continue
    return PORT
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class WS:
    def __init__(self):
        self.s = socket.create_connection(("127.0.0.1", PORT), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self.s.sendall(req.encode())
        head = b""
        while b"\r\n\r\n" not in head:
            head += self.s.recv(4096)
        assert b"101" in head, head[:200]
        self.buf = b""

    def send(self, obj):
        data = json.dumps(obj).encode()
        mask = os.urandom(4)
        hdr = bytes([0x81, 0x80 | len(data)]) if len(data) < 126 else bytes([0x81, 0x80 | 126]) + struct.pack(">H", len(data))
        self.s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv_frame(self):
        hdr = self._recvn(2)
        ln = hdr[1] & 0x7F
        if ln == 126:
            ln = struct.unpack(">H", self._recvn(2))[0]
        elif ln == 127:
            ln = struct.unpack(">Q", self._recvn(8))[0]
        if hdr[0] == 0x8A or hdr[0] == 0x89:
            return ("ctrl", b"")
        data = self._recvn(ln) if ln else b""
        return ("text", data)

    def _recvn(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(65536)
            if not chunk:
                raise ConnectionError("closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def next_of(self, types=("STATE", "DRAWN", "WELCOME", "ERROR"), timeout=5):
        self.s.settimeout(timeout)
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                kind, data = self.recv_frame()
            except socket.timeout:
                break
            if kind != "text":
                continue
            m = json.loads(data.decode())
            if m.get("type") in types:
                return m
        raise AssertionError(f"timed out waiting {types}")

    def drain_states(self):
        """Collect latest STATE, skipping intermediate ones.
        Returns (state_dict_or_None, extra_non_state_msg_or_None)."""
        self.s.settimeout(0.6)
        last = None
        try:
            while True:
                kind, data = self.recv_frame()
                if kind != "text":
                    continue
                m = json.loads(data.decode())
                if m.get("type") == "STATE":
                    last = m["state"]
                elif m.get("type") in ("DRAWN", "WELCOME", "ERROR"):
                    # put back by returning — caller handles; stash not needed for test flow
                    return last, m
        except (socket.timeout, ConnectionError):
            pass
        return last, None


def check_broadcast_payloads_are_never_torn():
    """A broadcast must finish each payload while it still holds the room lock.

    redact_for_viewer reads state["phase"] at the top and again at the bottom,
    so serialising it after the lock was released could splice two different
    moments together — and the nastiest splice LEAKS: it reads phase "reveal"
    (open everything), a new round is dealt underneath it, and the frame goes
    out as phase "playing" carrying the viewer's own fresh stock card.

    Thread switches are forced to be frequent, because at CPython's 5ms default
    a redaction is almost never preempted and the race hides.
    """
    sys.path.insert(0, BASE)
    import server
    from shared.game_logic import new_room_state, setup_round, resolve_bell

    torn, delivered, phases = [], [0], set()

    class Capture:
        def __init__(self, pid):
            self.player_id, self.room_code, self.closed = pid, "TORN", False

        def _check(self, msg):
            if msg.get("type") != "STATE":
                return
            st = msg["state"]
            delivered[0] += 1
            phases.add(st["phase"])
            me = next((p for p in st["players"] if p["id"] == self.player_id), None)
            if me is None:
                return
            if st["phase"] == "reveal":
                if st.get("lastResolution") is None:
                    torn.append("reveal with no resolution")
                if any(p["stockCardId"] is None for p in st["players"]):
                    torn.append("reveal with a stock card still hidden")
            elif st["phase"] == "playing" and me["stockCardId"] is not None:
                torn.append("LEAK: own stock card sent during play")

        def send_json(self, obj):
            self._check(json.loads(json.dumps(obj)))

        def send_raw(self, data):
            n = data[1] & 0x7F
            off = 2 + (2 if n == 126 else 8 if n == 127 else 0)
            self._check(json.loads(data[off:].decode("utf-8")))

    st = new_room_state("TORN", "p0", "P0")
    for i in (1, 2):
        st["players"].append({"id": f"p{i}", "name": f"P{i}", "seat": i,
                              "stockCardId": None, "tokens": [],
                              "connected": True, "ai": False})
    setup_round(st)
    room = {"state": st, "lock": threading.Lock(), "lastActive": time.time(),
            "conns": {p["id"]: [Capture(p["id"])] for p in st["players"]}}
    with server.rooms_lock:
        server.rooms["TORN"] = room

    stop = threading.Event()

    def mutator():
        while not stop.is_set():
            with room["lock"]:          # exactly how the real handlers mutate
                s = room["state"]
                if s["phase"] != "playing":
                    setup_round(s)
                    continue
                cid = s["deck"].pop(0) if s["deck"] else None
                if cid and "halves" in s["cards"][cid]:
                    h = s["cards"][cid]["halves"][0]
                    s["orders"].append({"cardId": cid, "halfIndex": 0, "faceUp": True,
                                        "placedBy": "p1", "animal": h["animal"],
                                        "count": h["count"], "flippedBy": [],
                                        "discarded": dict(s["cards"][cid]["halves"][1])})
                if s["orders"]:
                    try:
                        resolve_bell(s, "p0")
                    except ValueError:
                        pass

    def caster():
        while not stop.is_set():
            server.broadcast("TORN")

    old_interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    threads = [threading.Thread(target=mutator, daemon=True)]
    threads += [threading.Thread(target=caster, daemon=True) for _ in range(3)]
    try:
        for t in threads:
            t.start()
        time.sleep(2.0)
    finally:
        stop.set()
        for t in threads:
            t.join(timeout=5)
        sys.setswitchinterval(old_interval)
        with server.rooms_lock:
            server.rooms.pop("TORN", None)

    # the test is worthless if it never actually created contention
    assert delivered[0] > 300, f"only {delivered[0]} payloads — no real contention"
    assert {"playing", "reveal"} <= phases, f"phase never flipped: {phases}"
    assert not torn, (f"{len(torn)} torn payloads out of {delivered[0]}, e.g. "
                      f"{sorted(set(torn))[:3]}")
    print(f"no torn payloads across {delivered[0]} broadcasts under contention")


def check_dead_peer_does_not_stall_the_room():
    """A phone that locks stops reading and its TCP window fills. broadcast()
    writes to players in turn, so an unbounded send to that phone freezes
    everyone else's game until the socket's 120s timeout — measured at 118s
    before SEND_TIMEOUT existed. The send must give up long before that.
    """
    sys.path.insert(0, BASE)
    import server

    a, b = socket.socketpair()
    try:
        a.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 2048)
        b.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 2048)
        a.settimeout(120)   # what handle_tcp puts on a live websocket
        conn = server.WSConn(a)
        payload = {"type": "STATE", "state": {"filler": "x" * 20000}}
        t0 = time.time()
        while not conn.closed and time.time() - t0 < 60:
            conn.send_json(payload)     # b never reads a byte
        elapsed = time.time() - t0
        assert conn.closed, "sender never gave up on a peer that stopped reading"
        budget = server.SEND_TIMEOUT + server.SEND_LOCK_WAIT + 5
        assert elapsed < budget, (
            f"send to a dead peer took {elapsed:.1f}s, over budget {budget:.1f}s "
            f"— one locked phone can stall a whole room")
        print(f"dead peer dropped after {elapsed:.1f}s (not the 120s socket timeout)")
    finally:
        for sk in (a, b):
            try:
                sk.close()
            except OSError:
                pass


def main():
    global PORT
    PORT = pick_port()
    srv = subprocess.Popen([sys.executable, os.path.join(BASE, "server.py"), "--port", str(PORT)],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=BASE)
    try:
        for _ in range(50):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/", timeout=2) as r:
                    html = r.read().decode()
                    assert "Animal Stock" in html
                    print("HTTP OK:", len(html), "bytes")
                    break
            except Exception:
                time.sleep(0.2)
        else:
            print(srv.stdout.read().decode()[-3000:])
            raise SystemExit("server did not come up")

        a, b = WS(), WS()
        a.send({"type": "CREATE", "name": "Ann"})
        m = a.next_of(("WELCOME",))
        pid_a, room = m["playerId"], m["room"]
        print("created room", room)
        assert len(room) == 4
        st = a.next_of(("STATE",))["state"]
        assert st["phase"] == "lobby", st["phase"]

        b.send({"type": "JOIN", "room": room, "name": "Bo"})
        m = b.next_of(("WELCOME",))
        pid_b = m["playerId"]
        time.sleep(0.4)
        sa, extra_a = a.drain_states()
        sb, extra_b = b.drain_states()
        st = sa or sb
        assert st is not None, "no STATE after join"
        assert len(st["players"]) == 2, st["players"]
        print("lobby players:", [p["name"] for p in st["players"]])
        assert st.get("ruleMode") == "last_only", st.get("ruleMode")

        # host can switch bell-check rules in the lobby
        a.send({"type": "SET_MODE", "mode": "classic"})
        time.sleep(0.3)
        s1, _ = a.drain_states()
        s2, _ = b.drain_states()
        st = s1 or s2
        assert st["ruleMode"] == "classic", st
        # non-host cannot switch
        b.send({"type": "SET_MODE", "mode": "last_only"})
        errm = b.next_of(("ERROR", "STATE"))
        assert errm["type"] == "ERROR", errm
        a.send({"type": "SET_MODE", "mode": "last_only"})
        time.sleep(0.3)
        s1, _ = a.drain_states()
        st = s1 or st
        assert st["ruleMode"] == "last_only", st
        print("rule-mode switch OK (default last_only)")

        # host starts
        a.send({"type": "START"})
        time.sleep(0.4)
        sa, _ = a.drain_states()
        sb, _ = b.drain_states()
        st = sa or sb
        assert st["phase"] == "playing", st["phase"]
        assert st["round"] == 1
        # redaction: own card hidden
        me_a = next(p for p in st["players"] if p["id"] == st["youId"])
        assert me_a["stockCardId"] is None, "own card leaked!"
        other = next(p for p in st["players"] if p["id"] != st["youId"])
        assert other["stockCardId"] is not None, "others' card should be visible"
        assert "deck" not in st and st["deckCount"] == 37 - 3  # 2 players + dummy
        print(f"round 1 started, activeSeat={st['activeSeat']}, deck={st['deckCount']}")

        # illegal bell on empty board must be rejected (first action)
        active = a if next(p for p in st["players"] if p["seat"] == st["activeSeat"])["id"] == pid_a else b
        active_pid = pid_a if active is a else pid_b
        # clear stale broadcasts first
        a.drain_states(); b.drain_states()
        active.send({"type": "RING_BELL"})
        err = None
        for _ in range(5):
            m = active.next_of(("ERROR", "STATE"))
            if m["type"] == "ERROR":
                err = m
                break
        assert err is not None, "expected ERROR for empty-board bell"
        print("empty-board bell correctly rejected:", err["message"])
        # drain the broadcast that follows errors (none) — state unchanged, keep st
        time.sleep(0.3)
        a.drain_states(); b.drain_states()
        def sync():
            s1, _ = a.drain_states()
            s2, _ = b.drain_states()
            return s1 or s2

        def do_take(who):
            """Take + resolve one draw. Returns the drawn card."""
            who.send({"type": "TAKE_ORDER"})
            card = None
            for _ in range(6):
                m = who.next_of(("DRAWN", "STATE", "ERROR"))
                if m["type"] == "DRAWN":
                    card = m["card"]
                    break
                if m["type"] == "ERROR":
                    raise AssertionError(f"take rejected: {m}")
            assert card is not None, "never received DRAWN"
            time.sleep(0.2)
            return card

        def resolve_draw(who, card, cur):
            if "hippo" in card:
                face = [i for i, o in enumerate(cur["orders"]) if o["faceUp"]]
                who.send({"type": "HIPPO_FLIP", "orderIndex": face[0] if face else None})
            else:
                who.send({"type": "CHOOSE_HALF", "halfIndex": 0})
            time.sleep(0.3)
        # figure out current active again
        saw_discarded = False
        saw_results = False
        for rnd in range(1, 8):
            # take orders until >=2 face-up (hippo draws may add nothing), then ring
            for k in range(6):
                time.sleep(0.2)
                fresh = sync()
                if fresh:
                    st = fresh
                assert st is not None, "lost server state sync"
                if st["phase"] != "playing":
                    break
                face_n = sum(1 for o in st["orders"] if o["faceUp"])
                if face_n >= 2:
                    break
                ap = next(p for p in st["players"] if p["seat"] == st["activeSeat"])
                who = a if ap["id"] == pid_a else b
                other = b if who is a else a
                who.send({"type": "TAKE_ORDER"})
                card = None
                for _ in range(6):
                    m = who.next_of(("DRAWN", "STATE", "ERROR"))
                    if m["type"] == "DRAWN":
                        card = m["card"]
                        break
                    elif m["type"] == "ERROR":
                        raise AssertionError(f"TAKE_ORDER rejected: {m}")
                    # else stale STATE, keep waiting for DRAWN
                assert card is not None, "never received DRAWN"
                time.sleep(0.2)
                fresh = sync()
                if fresh:
                    st = fresh
                if "hippo" in card:
                    face = [i for i, o in enumerate(st["orders"]) if o["faceUp"]]
                    who.send({"type": "HIPPO_FLIP", "orderIndex": face[0] if face else None})
                else:
                    who.send({"type": "CHOOSE_HALF", "halfIndex": 0})
                time.sleep(0.3)
                fresh = sync()
                if fresh:
                    st = fresh
            # ring with active player (must have a face-up order by now)
            face_n = sum(1 for o in st["orders"] if o["faceUp"])
            assert face_n >= 1, f"no face-up orders after takes: {st['orders']}"
            for o in st["orders"]:
                if o.get("discarded"):
                    assert o["discarded"]["animal"] != o["animal"]
                    assert o["discarded"]["animal"] in (
                        "toucan", "zebra", "crocodile", "lion")
                    saw_discarded = True
            # ring with active player (must have a face-up order by now).
            # a fresh Hippo blocks the bell: take once to lift it, then ring.
            got_ring_error = None
            for attempt in range(3):
                fresh = sync()
                if fresh:
                    st = fresh
                if st["phase"] != "playing":
                    break
                ap = next(p for p in st["players"] if p["seat"] == st["activeSeat"])
                who = a if ap["id"] == pid_a else b
                a.drain_states(); b.drain_states()
                who.send({"type": "RING_BELL"})
                for _ in range(4):
                    m = who.next_of(("STATE", "ERROR"))
                    if m["type"] == "ERROR":
                        got_ring_error = m
                        break
                    if m["type"] == "STATE" and m["state"]["phase"] in ("reveal", "gameOver"):
                        st = m["state"]
                        break
                    # stale playing STATE — keep waiting
                if got_ring_error is None:
                    break
                assert "Hippo" in got_ring_error["message"], got_ring_error
                print(f"ring blocked by fresh Hippo (attempt {attempt + 1}), taking to lift it")
                # rejected rings change nothing: still `who`'s turn
                card = do_take(who)
                fresh = sync()
                if fresh:
                    st = fresh
                resolve_draw(who, card, st)
                time.sleep(0.3)
                fresh = sync()
                if fresh:
                    st = fresh
                got_ring_error = None
            assert got_ring_error is None, f"RING_BELL rejected: {got_ring_error}"
            time.sleep(0.4)
            fresh = sync()
            if fresh:
                st = fresh
            assert st["phase"] in ("reveal", "gameOver"), st["phase"]
            r = st["lastResolution"]
            assert r and "oversold" in r and "blamedId" in r and "tokenGiven" in r
            assert set(r["stockTally"]) == {"toucan", "zebra", "crocodile", "lion"}
            print(f"round {rnd}: oversold={r['oversold']} blamed={r['blamedId']} token={r['tokenGiven']} phase={st['phase']}")
            if st.get("loserId"):
                # final round: audit first, winning message only via RESULTS
                assert r["gameOver"] and r["gameOver"]["loserId"] == st["loserId"]
                a.drain_states(); b.drain_states()
                who.send({"type": "NEXT_ROUND"})
                errm = None
                for _ in range(4):
                    m = who.next_of(("ERROR", "STATE"))
                    if m["type"] == "ERROR":
                        errm = m
                        break
                assert errm is not None, "NEXT_ROUND should be refused on final audit"
                print("final NEXT_ROUND correctly refused:", errm["message"])
                who.send({"type": "RESULTS"})
                time.sleep(0.5)
                fresh = sync()
                if fresh:
                    st = fresh
                assert st["phase"] == "gameOver", st["phase"]
                assert sum(next(p for p in st["players"] if p["id"] == st["loserId"])["tokens"]) >= 7
                print("game over. winners:", st["winners"], "loser:", st["loserId"])
                saw_results = True
                who.send({"type": "RESTART"})
                time.sleep(0.4)
                fresh = sync()
                if fresh:
                    st = fresh
                assert st["phase"] == "playing" and st["round"] == 1
                print("restart OK")
                break
            (a if True else b).send({"type": "NEXT_ROUND"})
            time.sleep(0.4)
            fresh = sync()
            if fresh:
                st = fresh
            assert st is not None and st["phase"] == "playing", st
            print(f"round {st['round']} started, next token={st['nextTokenValue']}")

        assert saw_discarded, "no order carried its discarded half"
        assert saw_results, "never reached a final round (RESULTS flow untested)"

        # ---- post-Hippo ring block: next player must take, not ring ----
        fresh = sync()
        if fresh:
            st = fresh
        if st["phase"] == "reveal":
            a.send({"type": "NEXT_ROUND"})
            time.sleep(0.5)
            fresh = sync()
            if fresh:
                st = fresh
        if st["phase"] == "gameOver":
            a.send({"type": "RESTART"})
            time.sleep(0.5)
            fresh = sync()
            if fresh:
                st = fresh
        assert st["phase"] == "playing", st["phase"]

        # phase 1: guarantee a face-up order so the block error is unambiguous
        for _ in range(10):
            fresh = sync()
            if fresh:
                st = fresh
            if sum(1 for o in st["orders"] if o["faceUp"]) >= 1:
                break
            ap = next(p for p in st["players"] if p["seat"] == st["activeSeat"])
            card = do_take(a if ap["id"] == pid_a else b)
            fresh = sync()
            if fresh:
                st = fresh
            resolve_draw(a if ap["id"] == pid_a else b, card, st)
        # phase 2: hunt a hippo draw (bounded; deck always holds 3)
        drawer = other = None
        for _ in range(30):
            fresh = sync()
            if fresh:
                st = fresh
            if st["phase"] == "reveal":
                a.send({"type": "NEXT_ROUND"})  # deck-out edge; fresh deck
                time.sleep(0.4)
                continue
            assert st["phase"] == "playing", st["phase"]
            ap = next(p for p in st["players"] if p["seat"] == st["activeSeat"])
            who = a if ap["id"] == pid_a else b
            card = do_take(who)
            if "hippo" in card:
                drawer, other = who, (b if who is a else a)
                drawer_pid = pid_a if who is a else pid_b
                other_pid = pid_b if who is a else pid_a
                break
            fresh = sync()
            if fresh:
                st = fresh
            resolve_draw(who, card, st)
        assert drawer is not None, "never drew a hippo in 30 takes"
        fresh = sync()
        if fresh:
            st = fresh
        resolve_draw(drawer, card, st)  # flip; turn passes with the block set
        time.sleep(0.4)
        fresh = sync()
        if fresh:
            st = fresh
        assert st.get("noRingFor") == other_pid, st.get("noRingFor")
        assert st.get("noRingBy") == drawer_pid, st.get("noRingBy")
        print(f"ring block set: {drawer_pid} flipped -> {other_pid} blocked")
        # blocked ring is rejected with the Hippo reason
        a.drain_states(); b.drain_states()
        other.send({"type": "RING_BELL"})
        errm = None
        for _ in range(4):
            m = other.next_of(("ERROR", "STATE"))
            if m["type"] == "ERROR":
                errm = m
                break
        assert errm is not None and "Hippo" in errm["message"], errm
        print("blocked ring correctly rejected:", errm["message"])
        # taking lifts the block; the next ring is judged on the merits
        ap = next(p for p in st["players"] if p["seat"] == st["activeSeat"])
        assert ap["id"] == other_pid, "turn should be with the blocked player"
        card = do_take(other)
        fresh = sync()
        if fresh:
            st = fresh
        resolve_draw(other, card, st)
        time.sleep(0.4)
        fresh = sync()
        if fresh:
            st = fresh
        assert not st.get("noRingFor") or "hippo" in card, st.get("noRingFor")
        print("ring block lifted after taking")

        # ---- exit -> bot takes the seat, then a newcomer takes it back ----
        fresh = sync()
        if fresh:
            st = fresh
        if st["phase"] == "reveal":
            a.send({"type": "NEXT_ROUND"})
            time.sleep(0.5)
            fresh = sync()
            if fresh:
                st = fresh
        if st["phase"] == "gameOver":
            a.send({"type": "RESTART"})
            time.sleep(0.5)
            fresh = sync()
            if fresh:
                st = fresh
        assert st["phase"] == "playing", st["phase"]
        live = {"b": True}

        def sync2():
            s1, _ = a.drain_states()
            if live["b"]:
                s2, _ = b.drain_states()
            else:
                s2 = None
            return s1 or s2

        # steer the turn to B
        for _ in range(8):
            fresh = sync2()
            if fresh:
                st = fresh
            if st["phase"] != "playing":
                break
            ap = next(p for p in st["players"] if p["seat"] == st["activeSeat"])
            if ap["id"] == pid_b:
                break
            assert ap["id"] == pid_a, st
            a.send({"type": "TAKE_ORDER"})
            card = None
            for _ in range(6):
                m = a.next_of(("DRAWN", "STATE", "ERROR"))
                if m["type"] == "DRAWN":
                    card = m["card"]
                    break
                if m["type"] == "ERROR":
                    raise AssertionError(f"takeover setup rejected: {m}")
            assert card is not None
            time.sleep(0.2)
            fresh = sync2()
            if fresh:
                st = fresh
            if "hippo" in card:
                face = [i for i, o in enumerate(st["orders"]) if o["faceUp"]]
                a.send({"type": "HIPPO_FLIP",
                        "orderIndex": face[0] if face else None})
            else:
                a.send({"type": "CHOOSE_HALF", "halfIndex": 1})
            time.sleep(0.3)
        ap = next(p for p in st["players"] if p["seat"] == st["activeSeat"])
        assert ap["id"] == pid_b, "could not steer turn to B"

        b.send({"type": "LEAVE"})
        time.sleep(0.5)
        fresh = sync2()
        if fresh:
            st = fresh
        pb = next(p for p in st["players"] if p["id"] == pid_b)
        assert pb["ai"] is True and pb["connected"] is False, pb
        print("exit -> bot OK")
        live["b"] = False

        # the bot must act on its turn within seconds, untouched by us
        n_orders = len(st["orders"])
        seat_before = st["activeSeat"]
        phase_before = st["phase"]
        acted = False
        for _ in range(24):
            time.sleep(0.5)
            fresh = sync2()
            if fresh:
                st = fresh
            if (len(st["orders"]) != n_orders
                    or st["activeSeat"] != seat_before
                    or st["phase"] != phase_before):
                acted = True
                break
        assert acted, "bot never took its turn"
        print(f"bot acted alone: orders {n_orders}->{len(st['orders'])} "
              f"phase={st['phase']}")

        # a newcomer reclaims the bot seat mid-game (same id, history kept)
        if st["phase"] == "reveal":
            a.send({"type": "NEXT_ROUND"})
            time.sleep(0.5)
            fresh = sync2()
            if fresh:
                st = fresh
        if st["phase"] == "gameOver":
            a.send({"type": "RESTART"})
            time.sleep(0.5)
            fresh = sync2()
            if fresh:
                st = fresh
        c = WS()
        c.send({"type": "JOIN", "room": room, "name": "Cy"})
        m = c.next_of(("WELCOME",))
        assert m["playerId"] == pid_b, m
        time.sleep(0.4)
        sc, _ = c.drain_states()
        sa3 = sync2()
        stc = sc or sa3
        pc = next(p for p in stc["players"] if p["id"] == pid_b)
        assert pc["ai"] is False and pc["connected"] is True, pc
        assert pc["name"] == "Cy", pc
        print("takeover OK: Cy reclaimed the bot seat")

        # ---- solo mode: host fills the lobby with bots and starts ----
        d = WS()
        d.send({"type": "CREATE", "name": "Solo"})
        m = d.next_of(("WELCOME",))
        assert m.get("v", 1) >= 3, m  # solo-vs-bots needs protocol v3+
        pid_d, room2 = m["playerId"], m["room"]
        assert room2 != room
        time.sleep(0.3)
        d.drain_states()
        d.send({"type": "ADD_BOTS", "count": 2})
        st2 = None
        for _ in range(20):
            time.sleep(0.3)
            st2, _ = d.drain_states()
            if st2 and len(st2["players"]) == 3:
                break
        assert st2 and len(st2["players"]) == 3, st2
        assert sum(1 for p in st2["players"] if p["ai"]) == 2, st2["players"]
        print("bots added:", [p["name"] for p in st2["players"] if p["ai"]])
        # lobby bot management: remove one, re-add one
        gone = next(p["id"] for p in st2["players"] if p["ai"])
        d.send({"type": "REMOVE_BOT", "playerId": gone})
        for _ in range(20):
            time.sleep(0.3)
            st2, _ = d.drain_states()
            if st2 and len(st2["players"]) == 2:
                break
        assert st2 and len(st2["players"]) == 2
        d.send({"type": "ADD_BOTS", "count": 1})
        for _ in range(20):
            time.sleep(0.3)
            st2, _ = d.drain_states()
            if st2 and len(st2["players"]) == 3:
                break
        assert st2 and len(st2["players"]) == 3
        d.send({"type": "START"})
        time.sleep(0.5)
        st2, _ = d.drain_states()
        assert st2["phase"] == "playing", st2["phase"]
        # steer to a bot turn, then watch it play alone
        for _ in range(10):
            ap = next(p for p in st2["players"] if p["seat"] == st2["activeSeat"])
            if ap["ai"]:
                break
            assert ap["id"] == pid_d, st2
            d.send({"type": "TAKE_ORDER"})
            card = None
            for _ in range(6):
                m = d.next_of(("DRAWN", "STATE", "ERROR"))
                if m["type"] == "DRAWN":
                    card = m["card"]
                    break
                if m["type"] == "ERROR":
                    raise AssertionError(f"solo setup rejected: {m}")
            assert card is not None
            time.sleep(0.2)
            fresh, _ = d.drain_states()
            if fresh:
                st2 = fresh
            if "hippo" in card:
                face = [i for i, o in enumerate(st2["orders"]) if o["faceUp"]]
                d.send({"type": "HIPPO_FLIP",
                        "orderIndex": face[0] if face else None})
            else:
                d.send({"type": "CHOOSE_HALF", "halfIndex": 0})
            time.sleep(0.3)
            fresh, _ = d.drain_states()
            if fresh:
                st2 = fresh
        ap = next(p for p in st2["players"] if p["seat"] == st2["activeSeat"])
        assert ap["ai"], "never reached a bot turn"
        n2, s2, ph2 = len(st2["orders"]), st2["activeSeat"], st2["phase"]
        acted = False
        for _ in range(24):
            time.sleep(0.5)
            fresh, _ = d.drain_states()
            if fresh:
                st2 = fresh
            if (len(st2["orders"]) != n2 or st2["activeSeat"] != s2
                    or st2["phase"] != ph2):
                acted = True
                break
        assert acted, "solo bot never acted"
        print("solo mode OK: bot played its turn alone")

        check_broadcast_payloads_are_never_torn()
        check_dead_peer_does_not_stall_the_room()

        print("E2E PASS")
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=5)
        except Exception:
            srv.kill()


if __name__ == "__main__":
    main()
