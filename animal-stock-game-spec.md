# Animal Stock — Game Specification

A mobile web card game of hidden information, deduction and bluffing. Played on separate
phones via a room code, rendered with Three.js.
Rules are adapted from **Durian** (Masato Uesugi, Oink Games, 2020), with fruit replaced by animals.

> **Note for the implementer:** the rules below are reconstructed from the publisher's
> description and detailed reviews, not from a scan of the rulebook. Everything marked
> **[TUNABLE]** is a design/balance choice that is safe to change. Everything else is
> core mechanics and should be implemented as written.

---

## 1. One-paragraph summary

Every player has one **Stock card** placed so that *everyone else can see it but they
cannot see their own*. All the visible Stock cards together are the shop's inventory.
On your turn you either **take an order** (draw a card and add one half of it to the
order board) or **ring the bell** (accuse the table of having over-sold). When the bell
rings, all Stock cards are revealed and the orders are checked against the inventory,
animal type by animal type. If the orders exceed the stock, the player who took the
**last order** is blamed. If the orders were fine, the **bell-ringer** is blamed. The
blamed player takes an Angry Manager token, worth more each round. First player to
reach 7 points ends the game and loses; lowest score wins.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Animal type** | One of 4 species (see §3). |
| **Card** | A single card face divided into two halves: **Half A** and **Half B**. |
| **Stock card** | A card in front of a player. Represents inventory. Both halves count. |
| **Order** | One chosen half of a drawn card, placed on the order board. Only that half counts. |
| **Order board** | The shared area holding all accepted orders this round. |
| **Manager token** | Penalty token, values 1–7, taken in ascending order. |
| **Round** | Ends the moment the bell is rung. |

---

## 3. Animals

Four types, replacing strawberry / banana / grape / durian. Keep exactly four.

| # | Animal | Rarity in deck | Notes |
|---|---|---|---|
| 1 | Toucan | Most common | ~ strawberry |
| 2 | Zebra | Common | ~ banana (this is the type the "Pip" manager sibling cancels) |
| 3 | Crocodile | Uncommon | ~ grape |
| 4 | Lion | Rarest | ~ durian, the "dramatic" one |

**[TUNABLE]** The species themselves. The *rarity ordering* matters — it is a deduction
aid, because players reason about what is statistically likely to be on their own card.

The **Hippo** is not a stock animal. It is the manager and the three mischief siblings
(§6). Keep it visually distinct from the four stock animals. **[TUNABLE]**

---

## 4. Card structure

Every card has **two halves on the same face**:

- One half always shows **exactly 1 animal**.
- The other half shows **2 or 3 animals**, of a *different* type.

```json
{ "id": "c17", "halves": [
    { "animal": "toucan",  "count": 1 },
    { "animal": "crocodile", "count": 3 }
]}
```

This "one half is always a single animal" rule is load-bearing: it is how players catch
each other in impossible claims. Do not break it.

### 4.1 How the two halves are used

- **As a Stock card:** *both* halves count toward inventory. So each stock card holds
  3 or 4 animals total, always across exactly 2 species.
- **As an Order:** the player picks **one** half. Only that half becomes an order; the
  other half is discarded/ignored.

### 4.2 Default deck composition **[TUNABLE]**

34 animal cards + 3 Hippo Sibling cards = 37.

| Half A (single) | Half B | Copies |
|---|---|---|
| Toucan 1 | Zebra 2 | 4 |
| Toucan 1 | Zebra 3 | 3 |
| Toucan 1 | Crocodile 2 | 3 |
| Toucan 1 | Crocodile 3 | 2 |
| Toucan 1 | Lion 2 | 2 |
| Toucan 1 | Lion 3 | 1 |
| Zebra 1 | Toucan 2 | 4 |
| Zebra 1 | Toucan 3 | 3 |
| Zebra 1 | Crocodile 2 | 2 |
| Crocodile 1 | Toucan 2 | 3 |
| Crocodile 1 | Toucan 3 | 2 |
| Crocodile 1 | Zebra 2 | 2 |
| Lion 1 | Toucan 2 | 2 |
| Lion 1 | Zebra 2 | 1 |

Store this as a config array so it can be re-balanced without touching game logic.

---

## 5. Setup (each round)

1. Shuffle all 37 cards into one deck.
2. Deal **1 Stock card** to each player, face-up to everyone **except its owner**.
3. **[TUNABLE]** At 2 players, deal 1 extra "dummy" Stock card that *both* players can
   see. It belongs to no one, takes no turns, but counts as inventory.
4. Empty the order board.
5. Manager tokens 1–7 remain in a stack, lowest first, persisting across rounds.
6. Round 1: random start player. Later rounds: the player **to the left of whoever took
   the last token** starts.

---

## 6. Hippo Sibling cards

Three unique cards. Their behaviour depends on **where they end up**:

**Drawn from the deck on your turn (as an order):**
Instead of adding an order, choose any one face-up order already on the board and turn
it **face-down**. It no longer counts. Place the Hippo next to it.
*(Edge case: if there are no orders on the board yet, the card is discarded with no
effect and the turn ends. **[TUNABLE]** — an alternative is to redraw.)*

**Dealt as someone's Stock card (revealed only when the bell rings):**

| Sibling | Effect on reveal |
|---|---|
| **Bo** (big brother) | Cancel **every order showing 3 animals**. |
| **Dozy** (little brother) | No effect at all. |
| **Pip** (sister) | Cancel **every Zebra order**, regardless of count. |

A Hippo in the stock contributes **zero animals** to inventory. This is the main source
of drama: a player may be unknowingly holding a card that makes the whole table's
arithmetic wrong.

---

## 7. Turn structure

The active player must choose exactly one action.

### 7.1 Take an order
1. Draw the top card of the deck.
2. If Hippo → resolve per §6.
3. Otherwise choose Half A or Half B; that half goes face-up on the order board.
4. Turn passes to the left.

### 7.2 Ring the bell
Only legal if at least **1 face-up order** is on the board. (So the round's first player
must take an order.)

Ringing immediately ends the round and triggers resolution (§8).

**Important:** only the active player may ring. A player who spots an over-sale on
someone else's turn cannot act on it — they must wait for their own turn, by which point
someone else may have already rung.

---

## 8. Resolution algorithm

```
on_bell_rung(ringer):
    reveal all stock cards

    # 1. Apply hippo effects from STOCK cards only
    for hippo in stock_hippos:
        if hippo == BO: cancel every face-up order where count == 3
        if hippo == PIP:      cancel every face-up order where animal == ZEBRA
        if hippo == DOZY:       pass

    # 2. Tally
    for each animal type t:
        stock[t]   = sum of counts of t across BOTH halves of every stock card
        orders[t]  = sum of counts of t across all orders still face-up

    # 3. Verdict
    oversold = any(orders[t] > stock[t] for t in animal_types)

    if oversold:
        blamed = player who took the last face-up order   # NOT necessarily the one who broke it
        verdict = "MANAGER IS FURIOUS — the orders were bad"
    else:
        blamed = ringer
        verdict = "MANAGER IS FURIOUS — you called me for nothing"

    blamed.tokens.append(next_token_value)   # 1, then 2, then 3 ... then 7
    end_round(blamed)
```

Two details that are easy to get wrong:

- The check is **per animal type**, not on the grand total. 5 stock animals vs 4 ordered
  animals is still oversold if 3 Zebras were ordered and only 2 Zebras exist.
- The blamed player on an oversell is whoever placed the **most recent** order, even if
  an earlier player is the one who actually pushed it over the limit. You are on the hook
  for everyone's bluffs the moment you choose to add an order instead of ringing.

---

## 9. Scoring and game end

- Token values are taken strictly in order: 1, 2, 3, 4, 5, 6, 7. Round *n* is worth *n*.
- The game ends the instant a player's **total** reaches **7 or more**.
- That player loses. **The player with the fewest total points wins.**
- Ties for fewest: **[TUNABLE]** — suggest sharing the win.

Consequence: a game lasts at most 7 rounds, and stakes rise sharply. Early rounds are
cheap to lose; round 6 or 7 is usually fatal.

---

## 10. Game state shape (suggested)

```ts
type Animal = "toucan" | "zebra" | "crocodile" | "lion";
type Half   = { animal: Animal; count: 1 | 2 | 3 };
type Card   = { id: string; halves: [Half, Half] } | { id: string; hippo: "bo" | "dozy" | "pip" };

type GameState = {
  phase: "lobby" | "playing" | "reveal" | "roundEnd" | "gameOver";
  players: {
    id: string; name: string; seat: number;
    stockCardId: string | null;      // never sent to this player's own client
    tokens: number[];                // e.g. [2, 5]
  }[];
  dummyStockCardId: string | null;   // 2-player only
  deck: string[];                    // ids, server-side only
  orders: { cardId: string; halfIndex: 0 | 1; faceUp: boolean; placedBy: string }[];
  activeSeat: number;
  lastOrderBy: string | null;
  nextTokenValue: number;            // 1..7
  round: number;
};
```

**Critical:** a player's own `stockCardId` must never be sent to their own client — not
hidden with CSS, not sent-then-filtered. Redact it server-side. Anyone can open devtools.

---

## 11. Edge cases to handle explicitly

| Situation | Rule |
|---|---|
| First turn of a round | Bell is illegal; must take an order. |
| Hippo drawn, no face-up orders | Discard, no effect, turn ends. **[TUNABLE]** |
| Hippo drawn, all orders already face-down | Same as above. |
| Deck runs out mid-round | **[TUNABLE]** — suggest: round auto-resolves as if the active player rang the bell. With 37 cards this should be near-impossible. |
| Two stock Hippos at once | Both effects apply. An order cancelled twice is just cancelled. |
| All orders cancelled by Hippos | `orders[t] = 0` for all t → not oversold → the ringer is blamed. |
| Player disconnects mid-round | **[TUNABLE]** — suggest auto-take-order on timeout rather than ending the round. |

---

## 12. Architecture — rooms and networking

Each player is on their own phone, joining with a room code. Because the whole game is
built on information asymmetry, the server must be **authoritative and redacting**.

**Shape:**

- One small Node server. WebSocket (`ws` or Socket.IO) for realtime; no polling.
- A room is a 4-character code (avoid ambiguous chars: no `0/O`, `1/I`). Host creates,
  others join, host starts. Keep rooms in memory — a room dies when empty. No accounts,
  no database.
- The full `GameState` lives only on the server. Clients never compute rules; they send
  intents (`TAKE_ORDER`, `CHOOSE_HALF`, `RING_BELL`) and receive redacted state.
- **Redaction happens per socket.** Build the payload separately for each player, with
  their own `stockCardId` replaced by `null`. Never broadcast one shared state object and
  filter client-side.
- Validate every intent server-side: is it this player's turn, is the action legal
  (see §7.2), does the room exist. Assume a hostile client.
- Reconnect: store a `playerId` in `sessionStorage` and let a returning socket reclaim
  its seat. Phones lock screens constantly — this will happen every game.
- Turn timer **[TUNABLE]**: ~45s, then auto-take-order, so one distracted player doesn't
  stall a round.

**Hosting:** anything that supports persistent WebSocket connections — Fly.io, Railway,
Render. Vercel's default serverless functions will not work for this; if you want Vercel
for the client, put the socket server elsewhere. Serve over HTTPS so `wss://` works.

---

## 13. Rendering — Three.js

The table, cards and reveal are a Three.js scene. Two things to get right, since this is
a 2D card game rendered in 3D:

**Keep the UI in the DOM.** Buttons, the token track, the tally readout and the join
screen should be HTML overlaid on the canvas — not sprites in the scene. DOM gives you
free accessibility, text rendering, and thumb-sized tap targets that behave correctly on
mobile. Three.js earns its place on the *table*: cards standing in holders, the flip on
reveal, the bell. Fighting to build a settings menu out of meshes is wasted effort.

**Card rendering:**
- Each card is a `PlaneGeometry` with a texture. Generate textures at runtime by drawing
  your animal SVGs into an offscreen `<canvas>` (`CanvasTexture`), or pre-bake one atlas
  and offset UVs. An atlas is faster and worth it — there are only 37 cards.
- Set `texture.colorSpace = THREE.SRGBColorSpace` and `anisotropy` to the renderer max,
  or the card art will look muddy on a phone.
- Stock cards stand upright in a slight arc facing the camera; your own card is a plane
  showing the back, tilted away. Orders lie flat on the table surface.

**Mobile performance:**
- Cap `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))` — 3x on a modern phone will
  cook the battery for no visible gain.
- `MeshBasicMaterial` for the cards. Flat art needs no lighting; if you want depth, use a
  single `AmbientLight` + `DirectionalLight` with shadows off.
- Render on demand, not in a permanent `requestAnimationFrame` loop: this game is static
  between actions. Kick off the loop when an animation starts, stop it when it settles.
- Fixed camera. No OrbitControls — a player who rotates the table and gets lost is a
  support ticket. If you want life, allow a small parallax tied to device tilt.
- Handle `resize` and `visibilitychange` (phones background aggressively).

**Animation:** the reveal is the whole payoff. Stagger the card flips ~80ms apart, then
count the tally up per animal type, then land the verdict. Use a small tween library or
hand-rolled easing on a clock — you do not need a physics engine.

One honest caveat: none of the game *needs* 3D, so budget it as the polish layer. Build
the resolver and the socket layer first as plain logic with a throwaway HTML view, prove
a full 7-round game works end to end, then put the Three.js table on top. If the 3D
turns into a swamp, you still have a working game.

**Stack:** Vite + `three` for the client, Node + `ws` for the server, one repo, two
folders (`/client`, `/server`), shared rule code in `/shared` so the resolver is
importable by both — the server runs it, and you can unit test it directly (§16).

---

## 14. Interface requirements

Target: **portrait phone, played in a mobile browser, no install.**

Must be visible on one screen without scrolling during a turn:

1. **Other players' stock cards** — the core information. Face-up, name attached.
2. **Your own stock card** — shown as a card back. Never spoil it.
3. **The order board** — every face-up order, plus cancelled ones shown greyed/face-down.
4. **A running tally** the player can toggle: "orders so far: 3 Toucan, 2 Zebra, 1 Lion".
   Do not auto-compute what they *can't* know (i.e. never show inventory totals including
   their own card before reveal).
5. **Two big thumb-reachable buttons:** `Take an order` and `Ring the bell 🔔`.
6. **Token track** — who has what, and what the next token is worth. The rising stake is
   most of the tension.

Flow details worth getting right:

- Drawing a card should show the card large with both halves as two tappable targets, and
  a confirm step. Choosing a half is the whole decision.
- The reveal is the payoff moment: flip all stock cards with a short animation, then
  animate the tally per animal type, then show the verdict and who got blamed.
- Ring the bell should have a confirm ("Call the manager?") — it is irreversible.
- Sound: a bell and an angry hippo grunt, with a mute toggle. Optional but it is half
  the fun of the original.

---

## 15. Art direction

Reference style: flat geometric animals built from circles, half-circles and rounded
rectangles — two or three flat colours per animal, no outlines, no gradients, no shading.

- Draw them as **inline SVG**, not raster images. They must stay crisp and recolourable,
  and each animal needs to render legibly at ~24px (in a tally) and ~120px (on a card).
- Give each species one dominant colour that stays consistent everywhere it appears, so
  counting can happen by colour at a glance. Colour is the primary channel; also vary
  silhouette so it works for colour-blind players.
- Build **original** shapes in that style rather than tracing the reference image — the
  reference is a published illustration set and shouldn't be copied directly.
- Suggested palette direction: warm mid-tones on a light neutral background, one loud
  accent reserved exclusively for the hippo/manager UI so danger reads instantly.

---

## 16. Test cases

Implement these as unit tests against the resolver.

1. Stock: Toucan 3, Zebra 2. Orders: Toucan 3. → not oversold → ringer blamed.
2. Stock: Toucan 3, Zebra 2. Orders: Toucan 2, Zebra 3. → oversold (Zebra) → last orderer blamed.
3. Stock totals 6, orders total 5, but Lion 2 ordered vs 1 in stock → oversold.
4. Bo in stock; every order is a 3-count → all cancelled → not oversold → ringer blamed.
5. Pip in stock; orders are Zebra 3, Toucan 1; stock has 0 Zebra → Zebra cancelled → not oversold.
6. Hippo in stock contributes 0 animals — verify it is not counted as inventory.
7. A Hippo played as an order face-down a 3-Lion order → that order excluded from tally.
8. Token sequence across 7 rounds is exactly 1,2,3,4,5,6,7 and game ends at ≥7 total.
9. Player A has 3 points, player B has 7 → game over, A wins.
10. Bell attempted on an empty board → rejected as an illegal action.

---

## 17. Attribution

This is a personal reimplementation of Durian by Masato Uesugi, published by Oink Games.
Rules and mechanics aren't copyrightable, but the name, artwork, characters and the
specific rulebook text are. Use original animals, original art, and an original title —
don't ship it as "Durian" or reuse Oink's gorilla characters if this goes public. A line
in the credits crediting the original design is the right thing to do.

---

## 18. Decisions made

- **Multiplayer:** separate phones, shared room code, authoritative server (§12).
- **Stack:** Vite + Three.js client, Node + ws server, shared resolver (§12–13).
- **Manager:** Hippo, with three sibling hippos — Bo, Dozy, Pip. Not a stock animal.
- Stock animals: Toucan, Zebra, Crocodile, Lion.

Still open:

- [ ] Deck composition needs playtesting — the numbers in §4.2 are a starting point, not balanced.
- [ ] Bots for solo play / filling a room: not specified yet.
- [ ] Whether to keep the 2-player dummy stock card.
- [ ] Final title.
