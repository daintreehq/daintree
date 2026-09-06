# Local harnesses

Scripts you run by hand on a dev machine. They are deliberately NOT part of any CI suite: each one drives a real engine against a real local backend, so it spends model calls and depends on services this machine happens to be running.

Nothing here opens a window. They talk to the engine over stdio, which is the same transport the panel uses, so a defect they reproduce is a defect the panel has.

## assistant-turn.mjs

Drives one real turn through the assistant engine and reports what came back on the wire.

```bash
# needs the local backend on 127.0.0.1:8473 and a built engine
node e2e/local/assistant-turn.mjs "Please create a claude code terminal"
node e2e/local/assistant-turn.mjs --clear "some prompt"   # then send /clear
```

It exists because of a specific failure: a single prompt produced the same preamble and the same tool batch NINE times in the panel. That is either the engine replaying rounds or the panel duplicating them, and the two need completely different fixes. This answers which — it counts what the ENGINE actually emitted, before any renderer touched it.

It also reports the token-arrival SHAPE — how many `turn:token` frames, how much of the answer landed in the largest one, and over what wall-clock. "Is it streaming?" cannot be answered from the final text, because a single frame carrying the whole answer and a thousand frames carrying a word each produce identical prose. Only arrival tells them apart.

## assistant-parity.spec.ts

The panel against a REAL engine and a REAL backend, in a real window, with screenshots.

```bash
npm run build && npx playwright test --project=local assistant-parity
```

The fake-engine suite (`e2e/full/panels/assistant-native-panel.spec.ts`) proves the panel handles a byte-exact event stream correctly, and it is what gates CI. It cannot prove the panel LOOKS like the terminal beside it, or that a real model turn survives the round trip. That is what this is for: it launches real Claude Code terminals next to the panel, asserts the two share a typeface, and runs a long real prompt end to end.

## assistant-modes.spec.ts

The panel driven through the states a user actually moves between — theme changed under it, terminal font resized mid-conversation, the rail dragged to 300px, a second turn on top of a finished one, a new session, the panel closed and reopened.

```bash
npm run build && npx playwright test --project=local assistant-modes
```

These are the paths a scripted single-turn test never walks, and they are where a panel that passes every unit test still falls over. The theme case found the worst defect on this branch: the panel painted its ground from the terminal theme and its ink from the app's tokens, so on a light app theme with a dark terminal the answer measured 1.03:1 against its own background — invisible.

## Screenshots

Everything here writes to `e2e/screenshots/local/`, which is gitignored. They are evidence for a person looking at them now, not fixtures anything asserts on.

## Requirements

- The local backend answering on `127.0.0.1:8473` (`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8473/health` → `200`).
- A built engine: `npm run build:assistant` (current architecture only; `--all` is for release).
- A CURRENT renderer build. `npx playwright test` launches from `dist/` and does NOT build, so a stale `dist/` means the suite exercises the previous renderer and reports it as a pass. Always `npm run build` first.
