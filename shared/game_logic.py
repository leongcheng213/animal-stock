"""
Animal Stock — shared game logic (spec sections 3-11).

Pure functions with no networking. Imported by server.py and by tests.
Mirrors the suggested GameState shape from section 10.

Card model:
  Animal card: {"id": str, "halves": [{"animal": str, "count": int}, ...]}
  Hippo card:  {"id": str, "hippo": "bo" | "dozy" | "pip"}

Rules enforced here:
  - Deck composition from section 4.2 (34 animal + 3 hippo = 37)
  - Stock counts BOTH halves; orders count only the chosen half
  - Hippo-as-order flips a face-up order face-down (or discards if none)
  - Hippo-as-stock: Bo cancels count==3 orders, Pip cancels zebra orders, Dozy nothing
  - Verdict checks the last face-up order's animal only; blamed = that
    order's placer if oversold, else the ringer
  - Tokens 1..7 in order, game ends when any total >= 7, fewest wins
"""

import random

ANIMALS = ("toucan", "zebra", "crocodile", "lion")
HIPPOS = ("bo", "dozy", "pip")

# (halfA animal, halfA count, halfB animal, halfB count, copies)
# Half A is always the single (count==1) per section 4 load-bearing rule.
DECK_CONFIG = [
    ("toucan", 1, "zebra", 2, 4),
    ("toucan", 1, "zebra", 3, 3),
    ("toucan", 1, "crocodile", 2, 3),
    ("toucan", 1, "crocodile", 3, 2),
    ("toucan", 1, "lion", 2, 2),
    ("toucan", 1, "lion", 3, 1),
    ("zebra", 1, "toucan", 2, 4),
    ("zebra", 1, "toucan", 3, 3),
    ("zebra", 1, "crocodile", 2, 2),
    ("crocodile", 1, "toucan", 2, 3),
    ("crocodile", 1, "toucan", 3, 2),
    ("crocodile", 1, "zebra", 2, 2),
    ("lion", 1, "toucan", 2, 2),
    ("lion", 1, "zebra", 2, 1),
]

HIPPO_CARDS = [
    {"id": "h_bo", "hippo": "bo"},
    {"id": "h_dozy", "hippo": "dozy"},
    {"id": "h_pip", "hippo": "pip"},
]

ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

# The bell judges ONLY the last face-up order's animal. The spec's section 8
# scope (every animal type checked) was offered as a lobby option for a while;
# it is gone — this is the single rule now. See CLAUDE.md house rules.


def is_hippo(card):
    return "hippo" in card


def build_deck(shuffle=True, seed=None):
    """Build the full 37-card deck. Returns (cards_dict, deck_ids)."""
    cards = {}
    deck = []
    n = 0
    for a1, c1, a2, c2, copies in DECK_CONFIG:
        for _ in range(copies):
            n += 1
            cid = f"c{n:02d}"
            cards[cid] = {
                "id": cid,
                "halves": [
                    {"animal": a1, "count": c1},
                    {"animal": a2, "count": c2},
                ],
            }
    for h in HIPPO_CARDS:
        cards[h["id"]] = dict(h)
        deck.append(h["id"])
    # animal ids in order first, then hippos appended; shuffle below
    animal_ids = [cid for cid in cards if not cid.startswith("h")]
    deck = animal_ids + [h["id"] for h in HIPPO_CARDS]
    rng = random.Random(seed)
    if shuffle:
        rng.shuffle(deck)
    return cards, deck


def validate_deck(cards):
    """Sanity checks for the load-bearing card-structure rules."""
    assert len(cards) == 37, f"deck must be 37 cards, got {len(cards)}"
    animals = [c for c in cards.values() if not is_hippo(c)]
    hippos = [c for c in cards.values() if is_hippo(c)]
    assert len(animals) == 34 and len(hippos) == 3
    for c in animals:
        assert len(c["halves"]) == 2
        counts = sorted(h["count"] for h in c["halves"])
        # one half is always exactly 1, other is 2 or 3, different species
        assert counts[0] == 1, f"{c['id']} breaks single-half rule"
        assert counts[1] in (2, 3), f"{c['id']} bad count {counts[1]}"
        assert c["halves"][0]["animal"] != c["halves"][1]["animal"]
        # stock card always holds 3 or 4 animals across exactly 2 species
        total = sum(h["count"] for h in c["halves"])
        assert total in (3, 4), f"{c['id']} stock total {total}"


def new_room_state(room_code, host_id, host_name):
    return {
        "room": room_code,
        "phase": "lobby",
        "players": [{"id": host_id, "name": host_name, "seat": 0,
                     "stockCardId": None, "tokens": [], "connected": True,
                     "ai": False}],
        "hostId": host_id,
        "dummyStockCardId": None,
        "cards": {},
        "deck": [],
        "orders": [],          # {cardId, halfIndex, faceUp, placedBy, animal, count,
                               #  discarded: {animal, count} (unchosen half, display only)}
        "hippoDiscards": [],   # hippo order cards with no effect / used
        "activeSeat": 0,
        "lastOrderBy": None,
        "nextTokenValue": 1,
        "round": 0,
        "pendingDraw": None,   # {by, cardId} awaiting CHOOSE_HALF / HIPPO_FLIP
        "lastResolution": None,
        "turnDeadline": None,
        "aiActAt": None,       # when the active AI's move is due
        "revealAt": None,      # when the current reveal started (auto-advance)
        "noRingFor": None,     # player id that may not ring this turn (post-Hippo)
        "noRingBy": None,      # who played the Hippo causing it
        "winners": [],
        "loserId": None,
    }


def setup_round(state, rng=None):
    """Setup for each round (spec section 5). Mutates state."""
    rng = rng or random
    cards, deck = build_deck(shuffle=True)
    # allow tests to inject a rigged rng with .shuffle and .randint
    try:
        rng.shuffle(deck)
    except Exception:
        random.shuffle(deck)
    state["cards"] = cards
    state["deck"] = deck
    state["orders"] = []
    state["hippoDiscards"] = []
    state["lastOrderBy"] = None
    state["pendingDraw"] = None
    state["lastResolution"] = None
    state["dummyStockCardId"] = None
    n = len(state["players"])
    for p in state["players"]:
        p["stockCardId"] = state["deck"].pop(0)
    if n == 2:
        state["dummyStockCardId"] = state["deck"].pop(0)
    state["round"] += 1
    state["phase"] = "playing"
    state["loserId"] = None
    state["winners"] = []
    state["noRingFor"] = None
    state["noRingBy"] = None
    return state


def stock_tally(state):
    """Sum BOTH halves of every stock card. Hippos contribute 0."""
    tally = {a: 0 for a in ANIMALS}
    ids = [p["stockCardId"] for p in state["players"] if p.get("stockCardId")]
    if state.get("dummyStockCardId"):
        ids.append(state["dummyStockCardId"])
    for cid in ids:
        card = state["cards"][cid]
        if is_hippo(card):
            continue
        for h in card["halves"]:
            tally[h["animal"]] += h["count"]
    return tally


def stock_hippos(state):
    out = []
    ids = [p["stockCardId"] for p in state["players"] if p.get("stockCardId")]
    if state.get("dummyStockCardId"):
        ids.append(state["dummyStockCardId"])
    for cid in ids:
        card = state["cards"][cid]
        if is_hippo(card):
            out.append(card["hippo"])
    return out


def effective_orders(state):
    """Face-up orders after applying STOCK hippo cancellations (spec section 8)."""
    hippos = stock_hippos(state)
    eff = []
    for o in state["orders"]:
        if not o["faceUp"]:
            continue
        cancelled = False
        if "bo" in hippos and o["count"] == 3:
            cancelled = True
        if "pip" in hippos and o["animal"] == "zebra":
            cancelled = True
        if not cancelled:
            eff.append(o)
    return eff


def orders_tally(state):
    tally = {a: 0 for a in ANIMALS}
    for o in effective_orders(state):
        tally[o["animal"]] += o["count"]
    return tally


def apply_hippo_swap(order, hippo_card_id):
    """Hippo flip: the order's unpicked half becomes the live order and the
    picked half becomes unavailable (they trade places). The hippo card id
    is recorded beside the row as a marker. Flipping places no order, so it
    never changes lastOrderBy and can never make the flipper blamed.
    Returns False when the order has no recorded unpicked half (legacy)."""
    disc = order.get("discarded")
    if not disc:
        return False
    picked = {"animal": order["animal"], "count": order["count"]}
    order["animal"] = disc["animal"]
    order["count"] = disc["count"]
    order["discarded"] = picked
    flips = order.get("flippedBy") or []
    flips.append(hippo_card_id)
    order["flippedBy"] = flips
    return True


def hippo_flip_order(state, idx, hippo_card_id):
    """Apply one hippo flip to orders[idx]: swap its picked/unpicked halves
    (the hippo parks beside the row as a marker) or, for legacy orders with
    no recorded unpicked half, turn it face-down. Always records the hippo
    in hippoDiscards. Never touches lastOrderBy, so a flip can never make
    the flipper the blamed player that round."""
    if not apply_hippo_swap(state["orders"][idx], hippo_card_id):
        state["orders"][idx]["faceUp"] = False
    state["hippoDiscards"].append(hippo_card_id)


def resolve_bell(state, ringer_id):
    """
    Resolution algorithm (spec section 8, narrowed): only the LAST face-up
    order's animal is checked. Oversold -> the placer of that order takes the
    token, otherwise the ringer does.
    Returns resolution dict and mutates state (tokens, phase).
    Raises ValueError on illegal bell (empty face-up board).
    """
    face_up = [o for o in state["orders"] if o["faceUp"]]
    # orders cancelled by hippo-as-order (face-down) do not count as face-up,
    # but hippo-cancelled-by-stock still sit face-up until this step.
    if not face_up:
        raise ValueError("Bell is illegal with no face-up orders")
    eff = effective_orders(state)
    st = stock_tally(state)
    ot = {a: 0 for a in ANIMALS}
    for o in eff:
        ot[o["animal"]] += o["count"]
    last_face = face_up[-1]  # orders are appended in placement order
    checked = [last_face["animal"]]
    oversold_animals = [a for a in checked if ot[a] > st[a]]
    oversold = len(oversold_animals) > 0
    if oversold:
        blamed = last_face["placedBy"]
        verdict = "MANAGER IS FURIOUS — the orders were bad"
    else:
        blamed = ringer_id
        verdict = "MANAGER IS FURIOUS — you called me for nothing"
    token = state["nextTokenValue"]
    for p in state["players"]:
        if p["id"] == blamed:
            p["tokens"].append(token)
            break
    state["nextTokenValue"] = min(7, token + 1)
    # Next starter: whoever just took the token starts the next round
    # (house rule — spec section 5.6 says the player to their left instead).
    seats = {p["id"]: p["seat"] for p in state["players"]}
    state["activeSeat"] = seats[blamed] if blamed in seats else 0
    resolution = {
        "oversold": oversold,
        "oversoldAnimals": oversold_animals,
        "checkedAnimal": last_face["animal"],
        "stockTally": st,
        "ordersTally": ot,
        "blamedId": blamed,
        "ringerId": ringer_id,
        "verdict": verdict,
        "tokenGiven": token,
        "stockHippos": stock_hippos(state),
    }
    state["lastResolution"] = resolution
    # game end check (section 9): decided here, but the table always sees
    # the calculation (reveal) first — the winner screen follows explicitly.
    loser = None
    for p in state["players"]:
        if sum(p["tokens"]) >= 7:
            loser = p["id"]
            break
    if loser:
        best = min(sum(p["tokens"]) for p in state["players"])
        state["loserId"] = loser
        state["winners"] = [p["id"] for p in state["players"]
                            if sum(p["tokens"]) == best]
    else:
        state["loserId"] = None
        state["winners"] = []
    resolution["gameOver"] = ({"loserId": state["loserId"],
                               "winners": list(state["winners"])}
                              if loser else None)
    state["phase"] = "reveal"
    state["noRingFor"] = None
    state["noRingBy"] = None
    return resolution


def player_total(player):
    return sum(player.get("tokens", []))


def make_room_code(rng=None):
    rng = rng or random
    return "".join(rng.choice(ROOM_CODE_ALPHABET) for _ in range(4))


def redact_for_viewer(state, viewer_id):
    """
    Build the per-socket redacted payload (spec sections 10 and 12).
    - Own stockCardId -> None (never leak)
    - Deck order never sent (only count)
    - cards dict only includes cards the viewer may see:
      other players' stocks, dummy, orders, hippo discards, and — during
      reveal/roundEnd/gameOver — everyone's stock.
    """
    reveal = state["phase"] in ("reveal", "gameOver")
    visible_ids = set()
    for o in state["orders"]:
        visible_ids.add(o["cardId"])
    for cid in state.get("hippoDiscards", []):
        visible_ids.add(cid)
    for p in state["players"]:
        cid = p.get("stockCardId")
        if not cid:
            continue
        if reveal or p["id"] != viewer_id:
            visible_ids.add(cid)
    if state.get("dummyStockCardId"):
        visible_ids.add(state["dummyStockCardId"])
    # active drawer sees their pending card privately (sent separately as
    # DRAWN, but including here is harmless since it is theirs to choose)
    pd = state.get("pendingDraw")
    if pd and pd["by"] == viewer_id:
        visible_ids.add(pd["cardId"])

    cards_out = {cid: state["cards"][cid] for cid in visible_ids
                 if cid in state.get("cards", {})}
    players_out = []
    for p in state["players"]:
        cid = p.get("stockCardId")
        if cid and not reveal and p["id"] == viewer_id:
            cid = None  # redact own card — not hidden with CSS, redacted here
        players_out.append({
            "id": p["id"], "name": p["name"], "seat": p["seat"],
            "stockCardId": cid, "tokens": list(p.get("tokens", [])),
            "connected": p.get("connected", True),
            "ai": bool(p.get("ai", False)),
            "total": sum(p.get("tokens", [])),
        })
    return {
        "room": state["room"],
        "phase": state["phase"],
        "players": players_out,
        "hostId": state["hostId"],
        "dummyStockCardId": state.get("dummyStockCardId"),
        "cards": cards_out,
        "orders": [dict(o) for o in state["orders"]],
        "hippoDiscards": list(state.get("hippoDiscards", [])),
        "deckCount": len(state.get("deck", [])),
        "activeSeat": state.get("activeSeat", 0),
        "lastOrderBy": state.get("lastOrderBy"),
        "nextTokenValue": state.get("nextTokenValue", 1),
        "round": state.get("round", 0),
        "lastResolution": state.get("lastResolution"),
        "hasPendingDraw": bool(pd and pd["by"] == viewer_id),
        "pendingDrawCardId": pd["cardId"] if (pd and pd["by"] == viewer_id) else None,
        "activeChoosing": bool(pd),
        "turnDeadline": state.get("turnDeadline"),
        "noRingFor": state.get("noRingFor"),
        "noRingBy": state.get("noRingBy"),
        "winners": list(state.get("winners", [])),
        "loserId": state.get("loserId"),
        "youId": viewer_id,
    }
