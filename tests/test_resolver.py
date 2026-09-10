"""Unit tests for spec section 16 — run with: python -m pytest tests/ -v
(or python tests/test_resolver.py for stdlib-only)."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from shared.game_logic import (
    ANIMALS, build_deck, validate_deck, new_room_state, setup_round,
    stock_tally, orders_tally, effective_orders, resolve_bell, redact_for_viewer,
    apply_hippo_swap, DEFAULT_RULE_MODE,
)


def _mkstate(stock_cards, orders, ringer="p1", last_by=None):
    """Build a minimal state dict for resolver tests.

    stock_cards: list of card dicts (one per player)
    orders: list of (animal, count, placedBy, faceUp=True)
    """
    cards = {}
    players = []
    for i, c in enumerate(stock_cards):
        cards[c["id"]] = c
        pid = f"p{i+1}"
        players.append({"id": pid, "name": pid, "seat": i,
                        "stockCardId": c["id"], "tokens": [], "connected": True})
    for j, o in enumerate(orders):
        cid = f"o{j}"
        animal, count = o[0], o[1]
        placed_by = o[2] if len(o) > 2 else "p1"
        face_up = o[3] if len(o) > 3 else True
        cards[cid] = {"id": cid, "halves": [
            {"animal": animal, "count": count}, {"animal": "toucan" if animal != "toucan" else "zebra", "count": 1}]}
        # NOTE: for order cards the test harness stores the order half
        # directly; the second half is filler and never counted.
    state = {
        "room": "TEST", "phase": "playing", "players": players,
        "hostId": "p1", "dummyStockCardId": None, "cards": cards, "deck": [],
        "orders": [{"cardId": f"o{j}", "halfIndex": 0, "faceUp": o[3] if len(o) > 3 else True,
                    "placedBy": o[2] if len(o) > 2 else "p1",
                    "animal": o[0], "count": o[1]} for j, o in enumerate(orders)],
        "hippoDiscards": [], "activeSeat": 0,
        "lastOrderBy": last_by or (orders[-1][2] if orders else None),
        "nextTokenValue": 1, "round": 1, "pendingDraw": None,
        "lastResolution": None, "turnDeadline": None, "winners": [], "loserId": None,
        # real rooms always carry a mode (new_room_state sets it); tests that
        # want the other one set it explicitly rather than leaning on a default
        "ruleMode": DEFAULT_RULE_MODE,
    }
    return state


def _stock(halves):
    _mkstate_counter = getattr(_mkstate, "_n", 0) + 1
    _mkstate._n = _mkstate_counter
    return {"id": f"s{_mkstate_counter}_{random_suffix()}",
            "halves": [{"animal": a, "count": c} for a, c in halves]}


import random as _random

def random_suffix():
    return f"{_random.randint(1000,9999)}"


class TestResolver(unittest.TestCase):
    def test_01_not_oversold_ringer_blamed(self):
        s = _mkstate([{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]},
                      {"id": "s2", "halves": [{"animal": "zebra", "count": 1}, {"animal": "zebra", "count": 1}]}],
                     [("toucan", 3, "p2")])
        r = resolve_bell(s, "p1")
        self.assertFalse(r["oversold"])
        self.assertEqual(r["blamedId"], "p1")

    def test_02_oversold_fox_last_orderer_blamed(self):
        s = _mkstate([{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]},
                      {"id": "s2", "halves": [{"animal": "zebra", "count": 1}, {"animal": "zebra", "count": 1}]}],
                     [("toucan", 2, "p1"), ("zebra", 3, "p2")])
        r = resolve_bell(s, "p1")
        self.assertTrue(r["oversold"])
        self.assertIn("zebra", r["oversoldAnimals"])
        self.assertEqual(r["blamedId"], "p2")

    def test_03_totals_fine_but_elephant_oversold(self):
        # stock totals 6, orders total 5, lion 2 ordered vs 1 in stock
        s = _mkstate([{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "zebra", "count": 2}]},
                      {"id": "s2", "halves": [{"animal": "crocodile", "count": 1}, {"animal": "lion", "count": 1}]}],
                     [("toucan", 2, "p1"), ("zebra", 1, "p2"), ("lion", 2, "p1")])
        r = resolve_bell(s, "p2")
        self.assertTrue(r["oversold"])
        self.assertIn("lion", r["oversoldAnimals"])
        self.assertEqual(r["blamedId"], "p1")

    def test_04_bo_cancels_all_threes(self):
        s = _mkstate([{"id": "h_bo", "hippo": "bo"},
                      {"id": "s2", "halves": [{"animal": "toucan", "count": 2}, {"animal": "zebra", "count": 1}]}],
                     [("toucan", 3, "p1"), ("zebra", 3, "p2")])
        r = resolve_bell(s, "p1")
        self.assertFalse(r["oversold"])
        self.assertEqual(r["blamedId"], "p1")
        self.assertEqual(r["ordersTally"], {a: 0 for a in ANIMALS})

    def test_05_pip_cancels_fox(self):
        s = _mkstate([{"id": "h_pip", "hippo": "pip"},
                      {"id": "s2", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]}],
                     [("zebra", 3, "p1"), ("toucan", 1, "p2")])
        r = resolve_bell(s, "p2")
        self.assertFalse(r["oversold"])
        self.assertEqual(r["ordersTally"]["zebra"], 0)
        self.assertEqual(r["ordersTally"]["toucan"], 1)

    def test_06_hippo_stock_contributes_zero(self):
        s = _mkstate([{"id": "h_dozy", "hippo": "dozy"},
                      {"id": "s2", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]}],
                     [("toucan", 1, "p1")])
        self.assertEqual(stock_tally(s)["toucan"], 3)
        self.assertEqual(stock_tally(s)["zebra"], 0)

    def test_tally_excludes_facedown_orders(self):
        s = _mkstate([{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 2}]},
                      {"id": "s2", "halves": [{"animal": "lion", "count": 3}, {"animal": "lion", "count": 3}]}],
                     [("lion", 3, "p1", False), ("toucan", 1, "p2", True)])
        ot = orders_tally(s)
        self.assertEqual(ot["lion"], 0)
        self.assertEqual(ot["toucan"], 1)

    def test_08_token_sequence_and_game_end(self):
        s = _mkstate([{"id": "s1", "halves": [{"animal": "toucan", "count": 3}, {"animal": "zebra", "count": 1}]},
                      {"id": "s2", "halves": [{"animal": "toucan", "count": 3}, {"animal": "zebra", "count": 1}]}],
                     [("toucan", 1, "p1")])
        seq = []
        for rnd in range(1, 8):
            s["phase"] = "playing"
            s["orders"] = [{"cardId": "o0", "halfIndex": 0, "faceUp": True,
                            "placedBy": "p2", "animal": "toucan", "count": 1}]
            s["cards"]["o0"] = {"id": "o0", "halves": [
                {"animal": "toucan", "count": 1}, {"animal": "zebra", "count": 1}]}
            r = resolve_bell(s, "p1")  # not oversold -> ringer p1 blamed
            seq.append(r["tokenGiven"])
            if r["gameOver"]:
                break
        self.assertEqual(seq, [1, 2, 3, 4])
        # audit first: still reveal, with the decided game attached
        self.assertEqual(s["phase"], "reveal")
        self.assertEqual(s["loserId"], "p1")
        self.assertEqual(r["gameOver"], {"loserId": "p1", "winners": ["p2"]})

    def test_09_winner_fewest(self):
        s = _mkstate([{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "zebra", "count": 1}]},
                      {"id": "s2", "halves": [{"animal": "toucan", "count": 2}, {"animal": "zebra", "count": 1}]}],
                     [("toucan", 1, "p1")])
        s["players"][0]["tokens"] = [3]
        s["players"][1]["tokens"] = [2]
        s["nextTokenValue"] = 5
        s["orders"] = [{"cardId": "o0", "halfIndex": 0, "faceUp": True,
                        "placedBy": "p1", "animal": "toucan", "count": 1}]
        r = resolve_bell(s, "p2")  # ringer blamed -> p2 gets 5 -> total 7
        self.assertEqual(s["phase"], "reveal")
        self.assertEqual(r["gameOver"], {"loserId": "p2", "winners": ["p1"]})
        self.assertEqual(s["loserId"], "p2")
        self.assertEqual(s["winners"], ["p1"])

    def test_10_bell_empty_board_rejected(self):
        s = _mkstate([{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "zebra", "count": 1}]},
                      {"id": "s2", "halves": [{"animal": "toucan", "count": 2}, {"animal": "zebra", "count": 1}]}],
                     [])
        with self.assertRaises(ValueError):
            resolve_bell(s, "p1")

    def test_deck_composition(self):
        cards, deck = build_deck(shuffle=False)
        validate_deck(cards)
        self.assertEqual(len(deck), 37)

    def test_redaction_hides_own_card(self):
        cards, deck = build_deck(shuffle=True, seed=1)
        st = new_room_state("ABCD", "p1", "Ann")
        st["players"].append({"id": "p2", "name": "Bo", "seat": 1,
                              "stockCardId": None, "tokens": [], "connected": True})
        st["cards"] = cards
        st["deck"] = list(deck)
        st["players"][0]["stockCardId"] = st["deck"].pop(0)
        st["players"][1]["stockCardId"] = st["deck"].pop(0)
        st["phase"] = "playing"
        v1 = redact_for_viewer(st, "p1")
        by_id = {p["id"]: p for p in v1["players"]}
        self.assertIsNone(by_id["p1"]["stockCardId"])
        self.assertIsNotNone(by_id["p2"]["stockCardId"])
        self.assertNotIn("deck", v1)
        # during reveal, own card is shown
        st["phase"] = "reveal"
        v2 = redact_for_viewer(st, "p1")
        by_id2 = {p["id"]: p for p in v2["players"]}
        self.assertIsNotNone(by_id2["p1"]["stockCardId"])

    def test_token_taker_starts_next_round(self):        # Oversold -> blamed (p2, seat 1) starts, not the seat to their left.
        s = _mkstate([{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]},
                      {"id": "s2", "halves": [{"animal": "zebra", "count": 1}, {"animal": "zebra", "count": 1}]}],
                     [("toucan", 2, "p1"), ("zebra", 3, "p2")])
        r = resolve_bell(s, "p1")
        self.assertEqual(r["blamedId"], "p2")
        self.assertEqual(s["activeSeat"], 1)
        # Ringer blamed -> ringer (p2, seat 1) starts.
        s = _mkstate([{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]},
                      {"id": "s2", "halves": [{"animal": "zebra", "count": 1}, {"animal": "zebra", "count": 1}]}],
                     [("toucan", 1, "p1")])
        r = resolve_bell(s, "p2")
        self.assertEqual(r["blamedId"], "p2")
        self.assertEqual(s["activeSeat"], 1)

    def test_two_hippos_both_apply(self):
        s = _mkstate([{"id": "h_bo", "hippo": "bo"},
                      {"id": "h_pip", "hippo": "pip"}],
                     [("zebra", 3, "p1"), ("toucan", 3, "p2"), ("toucan", 1, "p1")])
        r = resolve_bell(s, "p2")
        self.assertEqual(r["ordersTally"]["zebra"], 0)
        self.assertEqual(r["ordersTally"]["toucan"], 1)

    # ---- last_only mode (default for new rooms) ----

    def _mkstate_last(self, stocks, orders):
        s = _mkstate(stocks, orders)
        s["ruleMode"] = "last_only"
        return s

    def test_last_only_ignores_earlier_oversell(self):
        # Zebra is oversold, but the LAST order is a safe Toucan -> ringer blamed.
        s = self._mkstate_last(
            [{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]},
             {"id": "s2", "halves": [{"animal": "zebra", "count": 1}, {"animal": "zebra", "count": 1}]}],
            [("zebra", 3, "p1"), ("toucan", 1, "p2")])
        r = resolve_bell(s, "p1")
        self.assertEqual(r["ruleMode"], "last_only")
        self.assertEqual(r["checkedAnimal"], "toucan")
        self.assertFalse(r["oversold"])
        self.assertEqual(r["blamedId"], "p1")
        # same board under classic rules IS oversold (zebra), blamed = last orderer
        s2 = _mkstate(
            [{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]},
             {"id": "s2", "halves": [{"animal": "zebra", "count": 1}, {"animal": "zebra", "count": 1}]}],
            [("zebra", 3, "p1"), ("toucan", 1, "p2")])
        s2["ruleMode"] = "classic"
        r2 = resolve_bell(s2, "p1")
        self.assertTrue(r2["oversold"])
        self.assertEqual(r2["blamedId"], "p2")

    def test_last_only_catches_bad_last_order(self):
        s = self._mkstate_last(
            [{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]},
             {"id": "s2", "halves": [{"animal": "zebra", "count": 1}, {"animal": "zebra", "count": 1}]}],
            [("toucan", 1, "p1"), ("zebra", 3, "p2")])
        r = resolve_bell(s, "p1")
        self.assertTrue(r["oversold"])
        self.assertEqual(r["checkedAnimal"], "zebra")
        self.assertEqual(r["oversoldAnimals"], ["zebra"])
        self.assertEqual(r["blamedId"], "p2")

    def test_last_only_with_bo_cancelling_last(self):
        # Last order is a 3, Bo wipes it -> checked column is 0 -> ringer blamed.
        s = self._mkstate_last(
            [{"id": "h_bo", "hippo": "bo"},
             {"id": "s2", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]}],
            [("toucan", 3, "p2")])
        r = resolve_bell(s, "p1")
        self.assertFalse(r["oversold"])
        self.assertEqual(r["blamedId"], "p1")

    def test_noring_lifecycle(self):
        s = _mkstate([{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]},
                      {"id": "s2", "halves": [{"animal": "zebra", "count": 1}, {"animal": "zebra", "count": 1}]}],
                     [("toucan", 1, "p1")])
        s["noRingFor"] = "p2"
        s["noRingBy"] = "p1"
        v = redact_for_viewer(s, "p2")
        self.assertEqual(v["noRingFor"], "p2")
        self.assertEqual(v["noRingBy"], "p1")
        resolve_bell(s, "p2")  # round over clears the block
        self.assertIsNone(s["noRingFor"])
        self.assertIsNone(s["noRingBy"])
        s["noRingFor"] = "p1"
        setup_round(s)  # new round clears the block
        self.assertIsNone(s["noRingFor"])
        self.assertIsNone(s["noRingBy"])

    def test_hippo_swap_changes_checked_animal(self):
        # A swapped last row is judged by its NEW animal.
        s = self._mkstate_last(
            [{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]},
             {"id": "s2", "halves": [{"animal": "zebra", "count": 1}, {"animal": "zebra", "count": 1}]}],
            [("toucan", 1, "p1")])
        s["orders"][0]["discarded"] = {"animal": "zebra", "count": 3}
        self.assertTrue(apply_hippo_swap(s["orders"][0], "h_bo"))
        r = resolve_bell(s, "p2")
        self.assertEqual(r["checkedAnimal"], "zebra")
        self.assertTrue(r["oversold"])  # 3 zebra ordered vs 2 in stock
        self.assertEqual(r["blamedId"], "p1")

    def test_discarded_half_ignored_by_tally(self):
        # The unchosen half is display-only; even absurd discards change nothing.
        s = _mkstate([{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]},
                      {"id": "s2", "halves": [{"animal": "zebra", "count": 1}, {"animal": "zebra", "count": 1}]}],
                     [("toucan", 1, "p1")])
        s["orders"][0]["discarded"] = {"animal": "lion", "count": 3}
        s["cards"]["o0"]["halves"] = [{"animal": "toucan", "count": 1},
                                      {"animal": "lion", "count": 3}]
        self.assertEqual(orders_tally(s)["lion"], 0)
        r = resolve_bell(s, "p2")
        self.assertFalse(r["oversold"])
        self.assertEqual(r["blamedId"], "p2")

    def test_hippo_flip_never_blames_flipper(self):
        # p2 swaps an order with a Hippo (places nothing themselves); the
        # flipper cannot become blamed because of the swap.
        s = self._mkstate_last(
            [{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]},
             {"id": "s2", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]},
             {"id": "s3", "halves": [{"animal": "zebra", "count": 1}, {"animal": "zebra", "count": 1}]}],
            [("toucan", 1, "p1"), ("zebra", 3, "p1")])
        s["orders"][1]["discarded"] = {"animal": "toucan", "count": 1}
        self.assertTrue(apply_hippo_swap(s["orders"][1], "h_pip"))
        s["lastOrderBy"] = "p1"  # swaps never touch lastOrderBy
        r = resolve_bell(s, "p3")
        self.assertEqual(r["checkedAnimal"], "toucan")
        self.assertFalse(r["oversold"])  # swapped last row is a safe toucan1
        self.assertEqual(r["blamedId"], "p3")  # ringer was wrong
        self.assertNotEqual(r["blamedId"], "p2")

    def test_apply_hippo_swap(self):
        o = {"cardId": "o0", "halfIndex": 0, "faceUp": True, "placedBy": "p1",
             "animal": "toucan", "count": 1,
             "discarded": {"animal": "zebra", "count": 3}}
        self.assertTrue(apply_hippo_swap(o, "h_bo"))
        self.assertEqual((o["animal"], o["count"]), ("zebra", 3))
        self.assertEqual(o["discarded"], {"animal": "toucan", "count": 1})
        self.assertEqual(o["flippedBy"], ["h_bo"])
        self.assertTrue(o["faceUp"])
        # second hippo stacks its marker and swaps back
        self.assertTrue(apply_hippo_swap(o, "h_pip"))
        self.assertEqual((o["animal"], o["count"]), ("toucan", 1))
        self.assertEqual(o["flippedBy"], ["h_bo", "h_pip"])
        # legacy order without a recorded unpicked half
        o2 = {"cardId": "o1", "faceUp": True, "placedBy": "p1",
              "animal": "zebra", "count": 3}
        self.assertFalse(apply_hippo_swap(o2, "h_bo"))

    def test_hippo_flip_order(self):
        from shared.game_logic import hippo_flip_order
        st = {"orders": [{"cardId": "o0", "halfIndex": 0, "faceUp": True,
                          "placedBy": "p1", "animal": "toucan", "count": 1,
                          "discarded": {"animal": "zebra", "count": 3}}],
              "hippoDiscards": [], "lastOrderBy": "p1"}
        hippo_flip_order(st, 0, "h_pip")
        o = st["orders"][0]
        self.assertEqual((o["animal"], o["count"]), ("zebra", 3))
        self.assertEqual(o["discarded"], {"animal": "toucan", "count": 1})
        self.assertEqual(o["flippedBy"], ["h_pip"])
        self.assertTrue(o["faceUp"])  # swapped rows stay live and counted
        self.assertEqual(st["hippoDiscards"], ["h_pip"])
        self.assertEqual(st["lastOrderBy"], "p1")  # flipper blameless
        # legacy fallback
        st2 = {"orders": [{"cardId": "o1", "faceUp": True, "placedBy": "p1",
                           "animal": "zebra", "count": 3}],
               "hippoDiscards": [], "lastOrderBy": "p1"}
        hippo_flip_order(st2, 0, "h_bo")
        self.assertFalse(st2["orders"][0]["faceUp"])
        self.assertEqual(st2["hippoDiscards"], ["h_bo"])


class TestBotLogic(unittest.TestCase):
    """Bot heuristics: fair info only, ring only when provable."""

    def _botstate(self):
        cards = {
            "sA": {"id": "sA", "halves": [{"animal": "toucan", "count": 2},
                                          {"animal": "toucan", "count": 1}]},
            "sB": {"id": "sB", "halves": [{"animal": "zebra", "count": 1},
                                          {"animal": "zebra", "count": 1}]},
        }
        players = [
            {"id": "bot", "name": "Bot", "seat": 0, "stockCardId": "sB",
             "tokens": [], "connected": False, "ai": True},
            {"id": "hum", "name": "Hum", "seat": 1, "stockCardId": "sA",
             "tokens": [], "connected": True, "ai": False},
        ]
        return {"room": "T", "phase": "playing", "players": players,
                "hostId": "hum", "dummyStockCardId": None, "cards": cards,
                "deck": [], "orders": [], "hippoDiscards": [], "activeSeat": 0,
                "lastOrderBy": None, "nextTokenValue": 1, "round": 1,
                "pendingDraw": None, "lastResolution": None,
                "turnDeadline": None, "aiActAt": None, "revealAt": None,
                "ruleMode": "last_only", "winners": [], "loserId": None}

    def _order(self, st, animal, count, by="hum"):
        i = len(st["orders"])
        cid = f"o{i}"
        st["cards"][cid] = {"id": cid, "halves": [
            {"animal": animal, "count": count}, {"animal": "zebra", "count": 1}]}
        st["orders"].append({"cardId": cid, "halfIndex": 0, "faceUp": True,
                             "placedBy": by, "animal": animal, "count": count,
                             "discarded": {"animal": "zebra", "count": 1}})

    def test_ring_only_when_provable_last_only(self):
        from server import ai_should_ring
        st = self._botstate()
        # bot sees toucan 3 (sA). 7 ordered > 3 + 3 hidden -> provable.
        self._order(st, "toucan", 3)
        self._order(st, "toucan", 3)
        self._order(st, "toucan", 1)
        self.assertTrue(ai_should_ring(st, "bot"))
        # last order safe -> no ring even though... (only toucan column here)
        st2 = self._botstate()
        self._order(st2, "toucan", 1)
        self.assertFalse(ai_should_ring(st2, "bot"))

    def test_ring_classic_any_column(self):
        from server import ai_should_ring
        st = self._botstate()
        st["ruleMode"] = "classic"
        self._order(st, "zebra", 3)
        self._order(st, "zebra", 3)  # zebra stock visible = 2, 6 > 2+3
        self._order(st, "toucan", 1)  # last is safe, classic still rings
        self.assertTrue(ai_should_ring(st, "bot"))

    def test_pick_half_with_headroom(self):
        from server import _ai_pick_half
        st = self._botstate()
        self._order(st, "lion", 3)
        self._order(st, "lion", 3)  # lion full (0 + 3 hidden = 3)
        card = {"id": "c", "halves": [{"animal": "toucan", "count": 1},
                                      {"animal": "lion", "count": 2}]}
        self.assertEqual(_ai_pick_half(st, "bot", card), 0)

    def test_bot_obeys_ring_block(self):
        from server import ai_should_ring
        st = self._botstate()
        self._order(st, "toucan", 3)
        self._order(st, "toucan", 3)
        self._order(st, "toucan", 1)
        self.assertTrue(ai_should_ring(st, "bot"))
        st["noRingFor"] = "bot"
        st["noRingBy"] = "hum"
        self.assertFalse(ai_should_ring(st, "bot"))

    def test_pick_flip_biggest(self):
        from server import _ai_pick_flip
        st = self._botstate()
        self.assertIsNone(_ai_pick_flip(st))
        self._order(st, "toucan", 1)
        self._order(st, "zebra", 3)
        self._order(st, "toucan", 2)
        self.assertEqual(_ai_pick_flip(st), 1)


class TestRedactionLeaks(unittest.TestCase):
    """Hidden information is the whole game (CLAUDE.md): these assert the three
    things redact_for_viewer must never ship, on a real dealt payload rather
    than a hand-built one. A leak here is a broken game, not a cosmetic bug.

    Leak checks scan the whole serialised payload for the quoted card id, so a
    card reaching the client through a new field fails the test too — not just
    the fields these tests know to look at today.
    """

    def _dealt(self, nplayers=3, seed=7):
        st = new_room_state("ABCD", "p1", "Ann")
        for i in range(1, nplayers):
            st["players"].append({"id": f"p{i+1}", "name": f"P{i+1}", "seat": i,
                                  "stockCardId": None, "tokens": [],
                                  "connected": True, "ai": False})
        setup_round(st, rng=_random.Random(seed))
        return st

    def _payload_mentions(self, payload, card_id):
        """True if card_id appears anywhere in the serialised payload, as a
        value or as a dict key."""
        return f'"{card_id}"' in json.dumps(payload)

    def test_own_stock_card_never_reaches_its_owner(self):
        st = self._dealt()
        for p in st["players"]:
            own = p["stockCardId"]
            self.assertIsNotNone(own)
            v = redact_for_viewer(st, p["id"])
            by_id = {q["id"]: q for q in v["players"]}
            self.assertIsNone(by_id[p["id"]]["stockCardId"],
                              f"{p['id']} was handed their own stock card id")
            self.assertNotIn(own, v["cards"],
                             f"{p['id']} was handed their own stock card contents")
            self.assertFalse(self._payload_mentions(v, own),
                             f"{own} leaked somewhere in {p['id']}'s payload")
            # every other player's stock is visible — that is the game
            for q in st["players"]:
                if q["id"] != p["id"]:
                    self.assertIn(q["stockCardId"], v["cards"])

    def test_own_stock_card_arrives_at_reveal(self):
        st = self._dealt()
        own = st["players"][0]["stockCardId"]
        st["phase"] = "reveal"
        v = redact_for_viewer(st, "p1")
        by_id = {q["id"]: q for q in v["players"]}
        self.assertEqual(by_id["p1"]["stockCardId"], own)
        self.assertIn(own, v["cards"])

    def test_pending_draw_is_masked_for_everyone_but_the_drawer(self):
        # A drawn card visible to the table before its owner picks a half kills
        # the bluff: the others would know the order's other option.
        st = self._dealt()
        drawn = st["deck"].pop(0)
        st["pendingDraw"] = {"by": "p1", "cardId": drawn}

        drawer = redact_for_viewer(st, "p1")
        self.assertTrue(drawer["hasPendingDraw"])
        self.assertEqual(drawer["pendingDrawCardId"], drawn)
        self.assertIn(drawn, drawer["cards"])

        for pid in ("p2", "p3"):
            v = redact_for_viewer(st, pid)
            self.assertFalse(v["hasPendingDraw"])
            self.assertIsNone(v["pendingDrawCardId"])
            self.assertNotIn(drawn, v["cards"])
            self.assertFalse(self._payload_mentions(v, drawn),
                             f"drawn card {drawn} leaked to {pid}")
            # they still learn that someone is choosing, just not what
            self.assertTrue(v["activeChoosing"])

    def test_deck_order_and_undealt_cards_never_ship(self):
        st = self._dealt()
        undealt = list(st["deck"])
        self.assertGreater(len(undealt), 0)
        for pid in ("p1", "p2", "p3"):
            v = redact_for_viewer(st, pid)
            self.assertNotIn("deck", v)
            self.assertEqual(v["deckCount"], len(undealt))
            for cid in undealt:
                self.assertNotIn(cid, v["cards"])
                self.assertFalse(self._payload_mentions(v, cid),
                                 f"undealt card {cid} leaked to {pid}")

    def test_reveal_does_not_open_the_undealt_deck(self):
        st = self._dealt()
        undealt = list(st["deck"])
        st["phase"] = "reveal"
        v = redact_for_viewer(st, "p1")
        self.assertNotIn("deck", v)
        for cid in undealt:
            self.assertFalse(self._payload_mentions(v, cid),
                             f"undealt card {cid} leaked at reveal")

    def test_two_player_dummy_is_public(self):
        # Spec section 5, step 3: at 2 players the extra "dummy" stock card is
        # one *both* players can see — visible by design, unlike your own card.
        st = self._dealt(nplayers=2)
        self.assertIsNotNone(st["dummyStockCardId"])
        v = redact_for_viewer(st, "p1")
        self.assertEqual(v["dummyStockCardId"], st["dummyStockCardId"])
        self.assertIn(st["dummyStockCardId"], v["cards"])


class _Tripwire(dict):
    """A card that screams if anything reads it. Stands in for a bot's own
    hidden stock card: bot code may know the id exists, never the contents.

    __len__ keeps it truthy — an empty dict is falsy, and a `if not card`
    guard would skip past the tripwire without ever springing it.
    """

    def _boom(self, *a, **k):
        raise AssertionError("bot read its own hidden stock card")

    def __len__(self):
        return 1

    __getitem__ = _boom
    __contains__ = _boom
    get = _boom
    keys = _boom
    values = _boom
    items = _boom


class TestBotBluffing(unittest.TestCase):
    """Bots ring on believable oversells, not only provable ones — without ever
    seeing their own card, which is the doubt the bluff-call is gambling on."""

    def _state(self, own_card=None):
        st = TestBotLogic._botstate(self)
        if own_card is not None:
            st["cards"]["sB"] = own_card
        return st

    _order = TestBotLogic._order

    def test_rarity_orders_the_odds(self):
        from server import _bluff_chance
        # Same unprovable gap, four species: rarer animal -> readier to call.
        odds = [_bluff_chance(a, 1) for a in ("toucan", "zebra", "crocodile", "lion")]
        self.assertEqual(odds, sorted(odds), f"rarity must order the odds: {odds}")
        self.assertLess(odds[0], odds[-1] / 2,
                        "a lion gap should be trusted far more than a toucan one")

    def test_no_chance_without_a_gap(self):
        from server import _bluff_chance
        for a in ANIMALS:
            self.assertEqual(_bluff_chance(a, 0), 0.0)
            self.assertEqual(_bluff_chance(a, -3), 0.0)

    def test_chance_is_capped_and_never_certain(self):
        from server import _bluff_chance, BLUFF_MAX
        for a in ANIMALS:
            self.assertLessEqual(_bluff_chance(a, 99), BLUFF_MAX)
        self.assertLess(BLUFF_MAX, 1.0, "a bot that is never wrong is not bluffing")

    def test_bluffs_on_an_unprovable_gap(self):
        import server
        st = self._state()
        # bot sees 3 toucans; 4 ordered. Its own card could be covering this,
        # so it is not provable — the old bot never rang here.
        self._order(st, "toucan", 3)
        self._order(st, "toucan", 1)
        vt_gap = 1
        self.assertGreater(server._bluff_chance("toucan", vt_gap), 0.0)
        rang = sum(server.ai_should_ring(st, "bot") for _ in _seeded(400))
        self.assertGreater(rang, 0, "bot never bluffs on a believable oversell")
        self.assertLess(rang, 400, "bot should not treat a guess as a certainty")

    def test_rare_gaps_are_called_more_often_than_common_ones(self):
        import server
        common = self._state()
        self._order(common, "toucan", 3)
        self._order(common, "toucan", 1)
        rare = self._state()
        self._order(rare, "lion", 1)
        n_common = sum(server.ai_should_ring(common, "bot") for _ in _seeded(400))
        n_rare = sum(server.ai_should_ring(rare, "bot") for _ in _seeded(400))
        self.assertGreater(n_rare, n_common,
                           f"lion {n_rare} should out-call toucan {n_common}")

    def test_bluffing_can_be_tuned_off(self):
        import server
        st = self._state()
        self._order(st, "toucan", 3)
        self._order(st, "toucan", 1)
        old = server.BLUFF_BASE
        try:
            server.BLUFF_BASE = 0.0
            self.assertEqual(sum(server.ai_should_ring(st, "bot") for _ in _seeded(200)), 0)
        finally:
            server.BLUFF_BASE = old

    def test_provable_oversell_still_always_rings(self):
        import server
        st = self._state()
        self._order(st, "toucan", 3)
        self._order(st, "toucan", 3)
        self._order(st, "toucan", 1)  # 7 > 3 visible + 3 hideable
        self.assertTrue(all(server.ai_should_ring(st, "bot") for _ in _seeded(50)))

    def test_blocked_turn_still_beats_the_urge_to_bluff(self):
        import server
        st = self._state()
        self._order(st, "lion", 3)  # rare + juicy: maximum temptation
        st["noRingFor"] = "bot"
        self.assertEqual(sum(server.ai_should_ring(st, "bot") for _ in _seeded(200)), 0)

    def test_never_reads_its_own_hidden_card(self):
        import server
        # The bot's own card is a tripwire: touching it at all fails the test.
        st = self._state(own_card=_Tripwire())
        self._order(st, "toucan", 3)
        self._order(st, "toucan", 1)
        for _ in _seeded(200):
            server.ai_should_ring(st, "bot")
        drawn = {"id": "d1", "halves": [{"animal": "lion", "count": 2},
                                        {"animal": "toucan", "count": 1}]}
        for _ in _seeded(50):
            server._ai_pick_half(st, "bot", drawn)
        server._ai_pick_flip(st)

    def test_decision_does_not_depend_on_own_card(self):
        import server
        # Same board, wildly different hidden cards -> identical behaviour.
        boards = []
        for own in ({"id": "sB", "halves": [{"animal": "toucan", "count": 3},
                                            {"animal": "zebra", "count": 1}]},
                    {"id": "sB", "halves": [{"animal": "lion", "count": 3},
                                            {"animal": "crocodile", "count": 1}]},
                    {"id": "sB", "hippo": "bo"}):
            st = self._state(own_card=own)
            self._order(st, "toucan", 3)
            self._order(st, "toucan", 1)
            boards.append([server.ai_should_ring(st, "bot") for _ in _seeded(200)])
        self.assertEqual(boards[0], boards[1])
        self.assertEqual(boards[1], boards[2])


def _seeded(n, seed=20260910):
    """Reseed the shared rng, then yield n times — makes bluff sampling
    reproducible without reaching into server's random module."""
    _random.seed(seed)
    return range(n)


if __name__ == "__main__":
    unittest.main(verbosity=2)
