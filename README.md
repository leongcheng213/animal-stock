# Animal Stock 🦛 — mobile web bluff card game

Play on your **phone's browser, no install**. One player creates a room, others join with the **4-character room code**. Based on the spec in `animal-stock-game-spec.md` (a reimplementation of *Durian* by Masato Uesugi / Oink Games — original animals, art & title here; credit to the original design).

> Stack note: the spec suggests Node + `ws`. This build uses a **Python 3 stdlib-only server** (no `pip install` needed) with the same authoritative, per-socket-redacted design, because it runs anywhere — including machines without Node. Game rules (§3–§11) are implemented exactly as specified.

## Run it (2 minutes)

Requires Python 3.8+ (3.10+ recommended). No dependencies.

```powershell
cd "Week 1 game"
python server.py
# Animal Stock server on http://0.0.0.0:8000
```

- **This computer:** open http://localhost:8000
- **Phones on the same Wi-Fi:** open `http://<your-computer-LAN-IP>:8000`
  (Windows: `ipconfig` → IPv4, e.g. `http://192.168.1.20:8000`). Allow Python through the firewall when asked.
- **Across networks:** host anywhere that keeps WebSockets alive (Fly.io, Railway, Render — set the `PORT` env var; the server reads it). Vercel-style serverless functions will **not** work for the socket server (§12). You can still serve `client/` statically from anywhere and point it at the socket host.

## Play online without your computer (hosting)

The folder ships deploy-ready (`Dockerfile`, `.dockerignore`, `render.yaml` — no dependencies to install, the image is tiny). Two routes:

**A. Free host with permanent link (computer can stay off).** Easiest is Render:
1. Push this folder to a GitHub repo (e.g. `animal-stock`).
2. On render.com → New → Blueprint → point it at the repo. It reads `render.yaml` and builds.
3. Open the `https://animal-stock-xxxx.onrender.com` link on any phone — create/join with the room code, same as local.
4. Free-tier note: the server sleeps after ~15 min idle, first visit of the day takes ~30–60 s to wake. Rooms are in-memory, so a sleeping server forgets old rooms (just create a new one).

**B. Instant temporary link (computer stays on).** No account needed:
1. `winget install --id Cloudflare.cloudflared`, then `cloudflared tunnel --url http://localhost:8000`.
2. Share the printed `https://xxxx.trycloudflare.com` link. Address changes on restart.

## How to play

1. Enter your name, then pick a table:
   - **👥 Friends** — one player taps **Create room** (host gets a code like `KQZT`), others enter the code → **Join**. 2–6 players, host taps **Start**.
   - **🤖 Vs bots** — pick total players (2–6, you + bots) → **Start vs bots**. The room fills instantly and the game begins; bots play fair (never peek at hidden cards).
2. You see **everyone else's stock card, never your own**. On your turn tap **Take order** (draw → tap half A or B → Confirm) or **Ring 🔔** (confirm — irreversible).
3. Bell → reveal: stocks flip and **only the newest order's animal is judged** (host can switch the lobby to all-animals classic). Oversold ⇒ last orderer takes the token; otherwise the ringer does. Tokens go 1,2,3… first to **7+ loses**, fewest wins.
4. Hippos 🦛: drawn = tap a face-up order **on the board** to swap its picked/unpicked halves (the Hippo parks beside that row as a marker). No orders ⇒ naps, no effect. In stock at reveal: **Bo** cancels all 3-counts, **Pip** cancels all Fox, **Dozy** naps. Swapping places no order, so it can never make *you* the blamed player that round.
5. 15 s turns: a frame traces the active player's box — the whole table on your turn — draining clockwise from the top-right (red flicker under 5 s), then auto-play. Reconnects reclaim your seat automatically.
6. Leaving mid-game (✕ button) hands your seat to a 🤖 **bot** that keeps playing fair (never peeks at its hidden card, rings only provable oversells). Anyone can join mid-game with the room code and **take the bot seat back**, history kept.

## Verify

```powershell
python tests/test_resolver.py      # 10 spec §16 cases + deck/redaction/double-hippo
python tests/test_server_e2e.py    # boots the real server, plays 2-player rounds over WebSockets
```

## Files

| Path | What |
|---|---|
| `server.py` | Authoritative server: rooms, redaction, timers, validation. One port serves HTTP + `/ws`. |
| `shared/game_logic.py` | Pure rules: 37-card deck (§4.2), stock/order tallies, §8 resolver, tokens, redaction. |
| `client/index.html` `styles.css` `app.js` | Portrait-phone DOM UI on one flat felt table: lobby, stocks, orders, tally toggle, deck-styled Take button, bell button, fullscreen draw picker, synth sounds + mute. |
| `client/animals.js` | Original flat-geometric animal art (half-disc style) as inline SVG. |
| `tests/` | Resolver unit tests + live server end-to-end test. |

## Details worth knowing

- **Bell-check rules:** new rooms default to **last-order-only** (simpler, faster). The host can switch to **all-animals classic** (spec §8 as written) in the lobby; the HUD shows `LAST`/`ALL` and the reveal highlights the judged column.
- **Order history:** each round's entry shows the picked half full-size with the unpicked half faded (50%) to its left — newest at the bottom. Counts live in the always-visible side tally (middle-right edge; the judged animal is highlighted), not under the cards. Hover/touch a Hippo stock card for a big centered note of what that sibling does; drawing a Hippo plays a full-screen pickup animation.
- **Whoever takes a token starts the next round** (house rule — spec §5.6 gives it to the player on their left instead).
- **Reveal messages are personal:** a ringer who catches bad orders sees a winner message, the token-taker is told plainly.
- **Orders show only the chosen half** — the tally counts face-up orders; your hidden stock is never included before reveal.
- **Art is original** flat-geometric work in a bauhaus half-disc style (not traced from any reference set), one dominant colour per species.

- **Hidden info is redacted server-side per socket** (`redact_for_viewer`): your own `stockCardId` is `null` until reveal, deck order is never sent. DevTools shows nothing extra.
- **2 players** get a shared visible `spare` stock card (§5.3).
- **Deck out mid-round** auto-resolves as if the active player rang (§11).
- After round 7 the next token stays at 7 (with 5–6 players a game can rarely run past 7 rounds; stakes stay maximal instead of running out of tokens).
- Sounds are synthesized (bell + grunt), mutable, no audio files.
