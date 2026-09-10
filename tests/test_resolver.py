"""Unit tests for spec section 16 — run with: python -m pytest tests/ -v
(or python tests/test_resolver.py for stdlib-only)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "shared"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from shared.game_logic import (
    ANIMALS, build_deck, validate_deck, new_room_state, setup_round,
    stock_tally, orders_tally, effective_orders, resolve_bell, redact_for_viewer,
    apply_hippo_swap,
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
            {"animal": animal, "count": count}, {"animal": "toucan" if animal != "toucan" else "fox", "count": 1}]}
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
                      {"id": "s2", "halves": [{"animal": "fox", "count": 1}, {"animal": "fox", "count": 1}]}],
                     [("toucan", 3, "p2")])
        r = resolve_bell(s, "p1")
        self.assertFalse(r["oversold"])
        self.assertEqual(r["blamedId"], "p1")

    def test_02_oversold_fox_last_orderer_blamed(self):
        s = _mkstate([{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]},
                      {"id": "s2", "halves": [{"animal": "fox", "count": 1}, {"animal": "fox", "count": 1}]}],
                     [("toucan", 2, "p1"), ("fox", 3, "p2")])
        r = resolve_bell(s, "p1")
        self.assertTrue(r["oversold"])
        self.assertIn("fox", r["oversoldAnimals"])
        self.assertEqual(r["blamedId"], "p2")

    def test_03_totals_fine_but_elephant_oversold(self):
        # stock totals 6, orders total 5, elephant 2 ordered vs 1 in stock
        s = _mkstate([{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "fox", "count": 2}]},
                      {"id": "s2", "halves": [{"animal": "leopard", "count": 1}, {"animal": "elephant", "count": 1}]}],
                     [("toucan", 2, "p1"), ("fox", 1, "p2"), ("elephant", 2, "p1")])
        r = resolve_bell(s, "p2")
        self.assertTrue(r["oversold"])
        self.assertIn("elephant", r["oversoldAnimals"])
        self.assertEqual(r["blamedId"], "p1")

    def test_04_bo_cancels_all_threes(self):
        s = _mkstate([{"id": "h_bo", "hippo": "bo"},
                      {"id": "s2", "halves": [{"animal": "toucan", "count": 2}, {"animal": "fox", "count": 1}]}],
                     [("toucan", 3, "p1"), ("fox", 3, "p2")])
        r = resolve_bell(s, "p1")
        self.assertFalse(r["oversold"])
        self.assertEqual(r["blamedId"], "p1")
        self.assertEqual(r["ordersTally"], {a: 0 for a in ANIMALS})

    def test_05_pip_cancels_fox(self):
        s = _mkstate([{"id": "h_pip", "hippo": "pip"},
                      {"id": "s2", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]}],
                     [("fox", 3, "p1"), ("toucan", 1, "p2")])
        r = resolve_bell(s, "p2")
        self.assertFalse(r["oversold"])
        self.assertEqual(r["ordersTally"]["fox"], 0)
        self.assertEqual(r["ordersTally"]["toucan"], 1)

    def test_06_hippo_stock_contributes_zero(self):
        s = _mkstate([{"id": "h_dozy", "hippo": "dozy"},
                      {"id": "s2", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]}],
                     [("toucan", 1, "p1")])
        self.assertEqual(stock_tally(s)["toucan"], 3)
        self.assertEqual(stock_tally(s)["fox"], 0)

    def test_tally_excludes_facedown_orders(self):
        s = _mkstate([{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 2}]},
                      {"id": "s2", "halves": [{"animal": "elephant", "count": 3}, {"animal": "elephant", "count": 3}]}],
                     [("elephant", 3, "p1", False), ("toucan", 1, "p2", True)])
        ot = orders_tally(s)
        self.assertEqual(ot["elephant"], 0)
        self.assertEqual(ot["toucan"], 1)

    def test_08_token_sequence_and_game_end(self):
        s = _mkstate([{"id": "s1", "halves": [{"animal": "toucan", "count": 3}, {"animal": "fox", "count": 1}]},
                      {"id": "s2", "halves": [{"animal": "toucan", "count": 3}, {"animal": "fox", "count": 1}]}],
                     [("toucan", 1, "p1")])
        seq = []
        for rnd in range(1, 8):
            s["phase"] = "playing"
            s["orders"] = [{"cardId": "o0", "halfIndex": 0, "faceUp": True,
                            "placedBy": "p2", "animal": "toucan", "count": 1}]
            s["cards"]["o0"] = {"id": "o0", "halves": [
                {"animal": "toucan", "count": 1}, {"animal": "fox", "count": 1}]}
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
        s = _mkstate([{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "fox", "count": 1}]},
                      {"id": "s2", "halves": [{"animal": "toucan", "count": 2}, {"animal": "fox", "count": 1}]}],
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
        s = _mkstate([{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "fox", "count": 1}]},
                      {"id": "s2", "halves": [{"animal": "toucan", "count": 2}, {"animal": "fox", "count": 1}]}],
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
                      {"id": "s2", "halves": [{"animal": "fox", "count": 1}, {"animal": "fox", "count": 1}]}],
                     [("toucan", 2, "p1"), ("fox", 3, "p2")])
        r = resolve_bell(s, "p1")
        self.assertEqual(r["blamedId"], "p2")
        self.assertEqual(s["activeSeat"], 1)
        # Ringer blamed -> ringer (p2, seat 1) starts.
        s = _mkstate([{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]},
                      {"id": "s2", "halves": [{"animal": "fox", "count": 1}, {"animal": "fox", "count": 1}]}],
                     [("toucan", 1, "p1")])
        r = resolve_bell(s, "p2")
        self.assertEqual(r["blamedId"], "p2")
        self.assertEqual(s["activeSeat"], 1)

    def test_two_hippos_both_apply(self):
        s = _mkstate([{"id": "h_bo", "hippo": "bo"},
                      {"id": "h_pip", "hippo": "pip"}],
                     [("fox", 3, "p1"), ("toucan", 3, "p2"), ("toucan", 1, "p1")])
        r = resolve_bell(s, "p2")
        self.assertEqual(r["ordersTally"]["fox"], 0)
        self.assertEqual(r["ordersTally"]["toucan"], 1)

    # ---- last_only mode (default for new rooms) ----

    def _mkstate_last(self, stocks, orders):
        s = _mkstate(stocks, orders)
        s["ruleMode"] = "last_only"
        return s

    def test_last_only_ignores_earlier_oversell(self):
        # Fox is oversold, but the LAST order is a safe Toucan -> ringer blamed.
        s = self._mkstate_last(
            [{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]},
             {"id": "s2", "halves": [{"animal": "fox", "count": 1}, {"animal": "fox", "count": 1}]}],
            [("fox", 3, "p1"), ("toucan", 1, "p2")])
        r = resolve_bell(s, "p1")
        self.assertEqual(r["ruleMode"], "last_only")
        self.assertEqual(r["checkedAnimal"], "toucan")
        self.assertFalse(r["oversold"])
        self.assertEqual(r["blamedId"], "p1")
        # same board under classic rules IS oversold (fox), blamed = last orderer
        s2 = _mkstate(
            [{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]},
             {"id": "s2", "halves": [{"animal": "fox", "count": 1}, {"animal": "fox", "count": 1}]}],
            [("fox", 3, "p1"), ("toucan", 1, "p2")])
        r2 = resolve_bell(s2, "p1")
        self.assertTrue(r2["oversold"])
        self.assertEqual(r2["blamedId"], "p2")

    def test_last_only_catches_bad_last_order(self):
        s = self._mkstate_last(
            [{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]},
             {"id": "s2", "halves": [{"animal": "fox", "count": 1}, {"animal": "fox", "count": 1}]}],
            [("toucan", 1, "p1"), ("fox", 3, "p2")])
        r = resolve_bell(s, "p1")
        self.assertTrue(r["oversold"])
        self.assertEqual(r["checkedAnimal"], "fox")
        self.assertEqual(r["oversoldAnimals"], ["fox"])
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

    def test_hippo_swap_changes_checked_animal(self):
        # A swapped last row is judged by its NEW animal.
        s = self._mkstate_last(
            [{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]},
             {"id": "s2", "halves": [{"animal": "fox", "count": 1}, {"animal": "fox", "count": 1}]}],
            [("toucan", 1, "p1")])
        s["orders"][0]["discarded"] = {"animal": "fox", "count": 3}
        self.assertTrue(apply_hippo_swap(s["orders"][0], "h_bo"))
        r = resolve_bell(s, "p2")
        self.assertEqual(r["checkedAnimal"], "fox")
        self.assertTrue(r["oversold"])  # 3 fox ordered vs 2 in stock
        self.assertEqual(r["blamedId"], "p1")

    def test_discarded_half_ignored_by_tally(self):
        # The unchosen half is display-only; even absurd discards change nothing.
        s = _mkstate([{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]},
                      {"id": "s2", "halves": [{"animal": "fox", "count": 1}, {"animal": "fox", "count": 1}]}],
                     [("toucan", 1, "p1")])
        s["orders"][0]["discarded"] = {"animal": "elephant", "count": 3}
        s["cards"]["o0"]["halves"] = [{"animal": "toucan", "count": 1},
                                      {"animal": "elephant", "count": 3}]
        self.assertEqual(orders_tally(s)["elephant"], 0)
        r = resolve_bell(s, "p2")
        self.assertFalse(r["oversold"])
        self.assertEqual(r["blamedId"], "p2")

    def test_hippo_flip_never_blames_flipper(self):
        # p2 swaps an order with a Hippo (places nothing themselves); the
        # flipper cannot become blamed because of the swap.
        s = self._mkstate_last(
            [{"id": "s1", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]},
             {"id": "s2", "halves": [{"animal": "toucan", "count": 2}, {"animal": "toucan", "count": 1}]},
             {"id": "s3", "halves": [{"animal": "fox", "count": 1}, {"animal": "fox", "count": 1}]}],
            [("toucan", 1, "p1"), ("fox", 3, "p1")])
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
             "discarded": {"animal": "fox", "count": 3}}
        self.assertTrue(apply_hippo_swap(o, "h_bo"))
        self.assertEqual((o["animal"], o["count"]), ("fox", 3))
        self.assertEqual(o["discarded"], {"animal": "toucan", "count": 1})
        self.assertEqual(o["flippedBy"], ["h_bo"])
        self.assertTrue(o["faceUp"])
        # second hippo stacks its marker and swaps back
        self.assertTrue(apply_hippo_swap(o, "h_pip"))
        self.assertEqual((o["animal"], o["count"]), ("toucan", 1))
        self.assertEqual(o["flippedBy"], ["h_bo", "h_pip"])
        # legacy order without a recorded unpicked half
        o2 = {"cardId": "o1", "faceUp": True, "placedBy": "p1",
              "animal": "fox", "count": 3}
        self.assertFalse(apply_hippo_swap(o2, "h_bo"))

    def test_hippo_flip_order(self):
        from shared.game_logic import hippo_flip_order
        st = {"orders": [{"cardId": "o0", "halfIndex": 0, "faceUp": True,
                          "placedBy": "p1", "animal": "toucan", "count": 1,
                          "discarded": {"animal": "fox", "count": 3}}],
              "hippoDiscards": [], "lastOrderBy": "p1"}
        hippo_flip_order(st, 0, "h_pip")
        o = st["orders"][0]
        self.assertEqual((o["animal"], o["count"]), ("fox", 3))
        self.assertEqual(o["discarded"], {"animal": "toucan", "count": 1})
        self.assertEqual(o["flippedBy"], ["h_pip"])
        self.assertTrue(o["faceUp"])  # swapped rows stay live and counted
        self.assertEqual(st["hippoDiscards"], ["h_pip"])
        self.assertEqual(st["lastOrderBy"], "p1")  # flipper blameless
        # legacy fallback
        st2 = {"orders": [{"cardId": "o1", "faceUp": True, "placedBy": "p1",
                           "animal": "fox", "count": 3}],
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
            "sB": {"id": "sB", "halves": [{"animal": "fox", "count": 1},
                                          {"animal": "fox", "count": 1}]},
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
            {"animal": animal, "count": count}, {"animal": "fox", "count": 1}]}
        st["orders"].append({"cardId": cid, "halfIndex": 0, "faceUp": True,
                             "placedBy": by, "animal": animal, "count": count,
                             "discarded": {"animal": "fox", "count": 1}})

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
        self._order(st, "fox", 3)
        self._order(st, "fox", 3)  # fox stock visible = 2, 6 > 2+3
        self._order(st, "toucan", 1)  # last is safe, classic still rings
        self.assertTrue(ai_should_ring(st, "bot"))

    def test_pick_half_with_headroom(self):
        from server import _ai_pick_half
        st = self._botstate()
        self._order(st, "elephant", 3)
        self._order(st, "elephant", 3)  # elephant full (0 + 3 hidden = 3)
        card = {"id": "c", "halves": [{"animal": "toucan", "count": 1},
                                      {"animal": "elephant", "count": 2}]}
        self.assertEqual(_ai_pick_half(st, "bot", card), 0)

    def test_pick_flip_biggest(self):
        from server import _ai_pick_flip
        st = self._botstate()
        self.assertIsNone(_ai_pick_flip(st))
        self._order(st, "toucan", 1)
        self._order(st, "fox", 3)
        self._order(st, "toucan", 2)
        self.assertEqual(_ai_pick_flip(st), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
