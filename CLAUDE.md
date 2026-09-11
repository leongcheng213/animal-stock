# Animal Stock

Mobile web multiplayer bluff card game. Players join a room with a 4-letter code on
their own phones. Each player sees everyone else's stock card but never their own.

Deployed at https://animal-stock.onrender.com/ (Render free tier — sleeps when idle).

## Source of truth

- `animal-stock-game-spec.md` — implementation spec. Rules, deck, resolver, edge cases.
- `animal-stock-rules.md` — player-facing rulebook.
- `shared/game_logic.py` — the authoritative rules implementation. If this and the spec
  disagree, stop and ask; do not silently pick one.

## Hard constraints

- **Python 3 standard library only.** No pip installs, no `requirements.txt` additions,
  no Node build step. The server must run with `python server.py` on a bare machine.
- **Hidden information is the entire game.** A player's own stock card must never reach
  their client. Redaction happens server-side, per socket, in `redact_for_viewer`.
  Any change touching state serialisation needs a test proving nothing leaks.
- Client is plain DOM + inline SVG (`client/`). No framework, no Three.js.
- Keep it single-port: one process serves both the static client and `/ws`.

## House rules that intentionally differ from the spec

These are deliberate. Don't "fix" them back to the spec.

- A drawn Hippo **swaps** a face-up order's picked/unpicked halves; it does not cancel.
- After a Hippo resolves, the next player may not ring the bell for one turn.
- Flipping never changes `lastOrderBy`, so a flipper can't become the blamed player.
- Whoever takes a token starts the next round (spec gives it to the player on their left).
- The bell judges ONLY the last face-up order's animal. The spec's every-animal
  check was a lobby option for a while; it has been removed, so there is no
  rule mode any more — do not reintroduce one.
- Max 6 players.

## Verify

    python tests/test_resolver.py      # rules unit tests
    python tests/test_server_e2e.py    # boots the server, plays real rounds over WS

Both must pass before any commit.

## Working style

- Small, single-purpose commits. One task per commit.
- No opportunistic refactors. If you spot something unrelated, note it, don't fix it.
- Ask before changing game balance, deck composition, or deploy config.
