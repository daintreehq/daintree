# Verifying a tour

A tour is done when every chapter has current timing, every frame shows what its narration says at that moment in Daintree's style, the capture has no unexplained warnings, and the plugin validates. A successful exit code alone proves none of that: stale timing and undefined cues are warnings, not failures. Read the capture and look at the frames.

## Capture

Build first — the preview plays `dist/`, not `src/`:

```bash
npm run build
npx daintree-plugin tour preview --headless --out .tour-preview/daintree
npx daintree-plugin tour preview --headless --out .tour-preview/svalbard --theme svalbard
```

The default theme `daintree` is dark; `svalbard` is a light one. Capture both: a scene that only reads in one of them is using a hard-coded colour. Other flags: `--tour <id>` when there are several tours, `--only <ids>` to recapture just the chapters you changed, `--settle <ms>` (default 750) for how long a scene settles after each seek.

It needs `playwright-core` and a Chromium (`npm install --save-dev playwright-core && npx playwright-core install chromium`). If they can't be installed, say that the visual check wasn't done; don't skip to "verified".

Each run writes one folder per chapter of PNG frames — `00-start.png` at 0s, then `01-<cue>.png` and on at each cue in firing order — and `capture.json`:

```ts
{
  version: 1,
  tourId: string,
  settleMs: number,
  canvas: { width: 640, height: 360 },
  scale: number,                       // frames are canvas × scale pixels
  chapters: [{
    id: string,
    duration: number,
    timingSource: "manifest" | "stale" | "estimate",
    undefinedCues: string[],           // cues the scene reads that the narration never marks
    error?: string,                    // the scene threw; its frames show the error
    frames: [{
      cue: string | null,              // null for the opening frame
      time: number,
      file: string,                    // relative to the capture folder
      anchors: Record<string, { x, y, width, height }>,  // canvas-space rects of every data-tour-anchor on screen
    }],
  }],
  warnings: string[],
}
```

## Read `capture.json` first

- `timingSource: "manifest"` is the only finished state. `"stale"` means the narration changed since it was voiced — re-voice. `"estimate"` means never voiced — voice it (or report that there was no key).
- `undefinedCues` must be empty; each entry is a `useCue` that never fires. Fix the scene or add the cue to the narration.
- `error` means the scene threw. Fix it before looking at anything else.
- Every warning is either fixed or explained to the author.
- Every anchor the narration points at appears in `anchors` at its cue, with a sensible size, inside the 640×360 canvas.

## Look at every frame

Open each PNG and hold it against the narration. For each frame, the narration text between this cue and the next is what the viewer hears while seeing it.

**Against the narration:**

- The thing the cue's word names is visible and is what changed from the previous frame.
- Labels, counts and names on screen match the words.
- The spotlight, cursor or callout (if any) sits on the element being talked about.
- Nothing appears before the narration introduces it, and nothing the narration has moved past is still demanding attention.

**Against Daintree's own scenes:** compare with the built-in tour (the scene sources are at <https://github.com/daintreehq/daintree/tree/develop/src/components/Tour/scenes>; if a Daintree checkout or earlier captures of the built-in tour are available, use those frames directly) and with `references/scenes.md`:

- **Layout** — one subject, generous empty canvas around it, aligned edges, nothing clipped at the canvas border.
- **Density** — only what the narration mentions; filler text is `MockLines` bars, not lorem ipsum or real paragraphs; small lists.
- **Colour** — surfaces, borders and text all from theme tokens, identical in character to the built-in scenes in both themes; at most one accent; no raw colour that stays the same across the two themes.
- **Type** — the same small sizes as the built-in scenes; no oversized headings.
- **Motion** — frames differ only where a cue says something happens. Check in the source that every change uses `reveal()`, `MockTyping`, `MockCursor` or `MockStreamingLines`, with no custom keyframes, `setTimeout` or wall-clock timers.

Frames capture each cue's settled state, `settleMs` after seeking to the cue's exact time. A state gated on a positive offset (`useCue("open", 0.7)`) is not in the frame for that cue; to check one, run `npx daintree-plugin tour preview` (without `--headless`) and open the printed URL with `?chapter=<id>&t=<seconds>` to freeze that moment, or reason about it from the source.

Fix what you find, rebuild, recapture the affected chapters with `--only`, and look again. Finish with one full capture in both themes so the final evidence covers every chapter.

## Validate and test

```bash
npx daintree-plugin validate
```

This must pass: it checks the tour entry against the same schema Daintree loads it with. Then run whatever the plugin itself has — `npm test`, `npm run typecheck`, `npx tsc --noEmit` — only scripts that exist in `package.json`; if there are none, say so. `npx daintree-plugin package --dry-run` confirms the scene module and the `tours/<id>/*.ogg` files the manifest points at are in the package.

## Report

Tell the author: chapters and voice, how timing was produced (voice, align, or still estimated), what the capture review found and what was changed, anything unverified and why, and the regeneration commands from `references/narration-and-audio.md`.
