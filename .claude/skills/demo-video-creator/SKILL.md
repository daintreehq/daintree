---
name: demo-video-creator
description: Record a polished 4K screencast/demo video of Daintree by driving the in-app demo engine (window.electron.demo — animated cursor, spotlight, captions) from a Playwright spec. Use whenever the user wants to make a demo video, screencast, product/marketing clip, or feature walkthrough of Daintree — either from a standard fixture or from a specific existing project folder they point at ("create a video from this folder").
---

# Demo Video Creator

This skill produces a real recorded video (`.webm` master + `.mp4`) of Daintree in action. It does NOT mock anything — it launches the actual app with the demo engine enabled and choreographs a fake cursor, spotlight, and captions over a real project while MediaRecorder captures the frame to disk.

## How it works (architecture)

Two halves:

1. **The in-app demo engine** (already built, demo-mode only):
   - `src/components/Demo/DemoCursor.tsx` — animated cursor: auto-generated Bézier arcs, Fitts's-law timing, ballistic→settle, click ripples. You give it destinations; the realism is automatic.
   - `src/components/Demo/DemoOverlay.tsx` — spotlight (blur + dim, masked cutout, 300ms fades) and captions (placement presets, size tiers, 200ms fades).
   - `src/components/Demo/DemoCaptureBridge.tsx` — `getDisplayMedia` + MediaRecorder → streams chunks to the main process.
   - `electron/ipc/handlers/demo.ts` + `electron/preload.cts` — the `window.electron.demo` API.
2. **The Playwright driver** (the "scene"): `e2e/screenshots/demo-reel.spec.ts` is the **canonical template**. It boots a project with `--demo-mode`, then awaits `window.electron.demo.*` calls wrapped in `startCapture`/`stopCapture`.

Read `e2e/screenshots/demo-reel.spec.ts` first — copy/adapt it for each new video rather than starting from scratch.

## Two modes

**Mode A — standard fixture.** Reuse the marketing fixtures in `e2e/helpers/screenshotFixtures.ts` (`createBrushCmsRepo` = worktree dashboard, `createSurgeCheckoutRepo` = agent at work, `createOrbitalSyncRepo` = multi-agent, etc.). Each returns `{ dir, cleanup }`. This is the default — no setup, deterministic, no API key needed for the non-agent fixtures.

**Mode B — a specific project folder.** The user sets up a real project folder ("I created a whole project, now make a video from this folder") and gives you its absolute path. Open THAT path instead of a fixture: skip `createBrushCmsRepo()` and pass the user's path as the dir to `mockOpenDialog`. First **inspect the folder** (its worktrees, files, what's interesting) and choreograph the scene around its actual content — generic captions on unknown content look hollow.

The boot flow is identical for both; only the folder dir differs.

## Workflow

1. **Build** the e2e bundle (demo mode is stripped from prod but present in the test build):
   `npm run build:e2e`
2. **Author the scene** — copy `demo-reel.spec.ts` to `e2e/screenshots/<name>.spec.ts` (or edit in place for iteration) and write the beats (see API below). Wrap the visible beats in `startCapture(...)` / `stopCapture()`, inside a `try/finally` so capture always finalizes; make each beat best-effort (`safe()` wrapper) so one missing selector doesn't abort the recording.
3. **Record:**
   `npx playwright test e2e/screenshots/<name>.spec.ts --project=screenshots --reporter=line`
   (The `screenshots` Playwright project has a 30-min timeout. A transient macOS launch flake auto-retries.)
4. **Post-process** (output lands in `artifacts/demo/`, which is gitignored):
   - Fix the WebM duration (MediaRecorder omits it during live muxing): `ffmpeg -i in.webm -c copy fixed.webm`
   - Optional QuickTime-friendly copy: `ffmpeg -i fixed.webm -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart out.mp4`
5. **Verify before claiming done** — extract frames with `ffmpeg -ss <t> -i out.webm -frames:v 1 frame.png` and actually look at them (a tiled montage `-vf "fps=15,scale=300:-1,tile=7x3"` shows fades ramping). Confirm the feature is on screen, the cursor moves, and captions are legible.

## The `window.electron.demo` API (call via `page.evaluate`)

All calls return promises that resolve when the command's renderer round-trip completes, so `await` them. The cursor/overlay components must be mounted first — gate on `await page.waitForFunction(() => !!window.electron?.demo)`.

- **Cursor:** `moveTo(xPct, yPct, durationMs?)` (x/y are 0–100 % of viewport), `moveToSelector(selector, durationMs?, offsetX?, offsetY?)`, `click()` (clicks at the cursor's current spot — move first), `drag(fromSel, toSel, durationMs?)`, `scroll(selector)`, `pressKey(key, code?, modifiers?, selector?)`, `type(selector, text, cps?)`.
- **Spotlight:** `spotlight(selector, padding?)` (blur + dim everything else, 300ms fade-in), `dismissSpotlight()`.
- **Captions:** `annotate(selector, text, placement?, size?, id?)` → returns `{ id }`. `dismissAnnotation(id?)` (omit id = clear all; 200ms fades both ways).
  - **placement:** element-anchored `top|bottom|left|right`; viewport `screen-bottom` (subtitle — the default for narration), `screen-top`, `screen-center`, `lower-third-left|right`, `top-left|top-right|bottom-left|bottom-right`; cursor `above-cursor|below-cursor`. For viewport/cursor placements pass `""` as the selector.
  - **size:** `sm|md|lg|xl` (resolved as % of frame height so it scales 1080p↔4K). Default `md`; subtitles read well at `lg`.
- **Timing/util:** `sleep(ms)`, `waitForSelector(selector, timeoutMs?)`, `waitForIdle(settleMs?, timeoutMs?)`, `pause()`/`resume()`, `screenshot()`.
- **Capture:** `startCapture({ outputPath, fps?, videoBitsPerSecond?, width?, height? })`, `stopCapture()` → `{ outputPath, frameCount }`, `getCaptureStatus()`. `outputPath` is a **main-process** filesystem path; the main process mkdirs its dirname.

## Quality / resolution knobs (env, read by the spec)

Defaults give a **4K master at the app's true desktop density** (the industry sweet spot — Screen Studio / Stripe / Linear all target logical 1920×1080 @ 2× → 4K). Do NOT zoom the interface by default: zooming reduces the effective layout and hides panels, and `setZoomFactor` literally magnifies fonts so little fits.

| Env | Default | Effect |
| --- | --- | --- |
| `DAINTREE_DEMO_RESOLUTION` | `4k` | `1080p` / `1440p` / `4k` output |
| `DAINTREE_DEMO_ZOOM` | `1.0` | UI magnification; >1 fits less, <1 fits more. Leave at 1.0 unless asked. |
| `DAINTREE_DEMO_FPS` | `60` | frame rate |
| `DAINTREE_DEMO_BITRATE_MBPS` | `50` (4k) | encode ceiling (VBR — static dark UI stays small) |

## Scene-authoring lessons (hard-won — follow these)

- **Tell one story.** Intro subtitle → 2–4 focused beats → outro subtitle. Don't narrate every pixel.
- **Captions are optional** and most users want few of them. When used: keep ≤2 lines, sentence case, and hold them long enough to read — ~15–17 characters/second (a 36-char line ≈ 2.2s minimum on screen).
- **Show the feature within the first ~0.5s** — open on the real UI, not a title card.
- **Cursor + click reads as intent.** `moveToSelector` then `click()` plays the press/ripple and (for worktree cards etc.) performs the real action — capture the resulting state change.
- **Spotlight to focus**, then dismiss before moving on. On Daintree's dark theme the blur (not the dim) is what makes the focus read.
- **Reading-friendly pacing:** `sleep` generously between beats; IPC round-trips already add latency, so the recording runs a touch longer than the sum of sleeps.

## Gotchas / why things are the way they are

- **Demo mode must reach the renderer.** It's gated on the renderer's `process.argv`; `--demo-mode` is forwarded into `additionalArguments` in `electron/window/createWindow.ts` and `ProjectViewManager.ts`. Launch via `launchApp({ extraArgs: ["--demo-mode"], windowSize, screenshotScale })`.
- **`getDisplayMedia` needs a relaxed Permissions-Policy.** `display-capture` is denied by default; `electron/setup/protocols.ts` relaxes it to `(self)` only in demo mode (gated on `!app.isPackaged`).
- **Page handle goes stale on open.** The project view reloads once during hydration. Re-acquire with `refreshActiveWindow` after opening the folder (the template does this twice) before driving the demo.
- **Capture file is small even at 4K** — that's efficient VBR on a static dark UI, not low quality. Judge sharpness from a native-res crop, not the byte count.
- **Animated camera zoom was removed** (`webFrame.setZoomFactor` thrashed xterm's WebGL atlas every frame). Z-axis "camera moves" belong in post (e.g. a CSS transform in Remotion), not at capture time.

## Output

Videos go to `artifacts/demo/` (gitignored). Commit only the code (engine + spec changes), never the rendered media.
