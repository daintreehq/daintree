# Theme Review Workflow

How a Daintree theme actually gets from an idea to something shippable. This is the process Movile (#11874) went through; it took six review rounds and every one of them found something real.

The short version: **measure before you author, render before you judge, and get an adversarial second opinion on both the pixels and the code.** A theme that passes every test in the repo can still be wrong, because the tests are warn-only on dark for exactly the properties a dark theme is most likely to get wrong.

## 0. Before you write anything

Read `docs/themes/theme-system.md`, `docs/themes/theme-tokens.md` and `docs/themes/visual-guide.md`. The visual guide is the one people skip and the one that matters most: it tells you what each token actually paints in the real UI, which is the only way to know whether a value is load-bearing.

Then read the gates, not the docs about the gates:

- `shared/theme/contrast.ts` — `getThemeContrastWarnings()`, the hard gate
- `shared/theme/__tests__/builtInThemes.test.ts` — structural gates and cross-key invariants
- `shared/theme/__tests__/paletteDistinguishability.test.ts` — colour-vision floors
- `shared/theme/extensionRegistry.ts` — which extension keys are required per polarity
- `shared/theme/oklch.ts` — the ramp/accent audits, **warn-only for dark**

## 1. Derive the palette from the artwork, not from taste

If the theme has hero art, sample it. The image is committed and is not recoloured at runtime, so the UI has to live next to it.

```bash
magick public/themes/<id>.webp -resize 200x63 -colors 12 -format "%c" histogram:info: | sort -rn | head
# and per-region, e.g. the lit subject vs the surround
magick public/themes/<id>.webp -gravity Center -crop 260x220+0-40 +repage -colors 6 -format "%c" histogram:info: | sort -rn
```

Movile's palette came almost entirely out of this: the beam-lit calcite became `activity.waiting`, the wet rock became the border, the warm black became the surface ladder. That is not decoration — it is why the theme and its hero image read as the same place.

## 2. Solve the numbers in a scratch script BEFORE writing the theme file

Do not author hexes and then run the tests to see what breaks. Write a throwaway Node script that computes WCAG ratios, OKLab/OKLCH values, and CVD distances for candidate values, and iterate there. It is an order of magnitude faster and it makes the constraints visible.

`culori` is already a dependency, so CVD simulation is available:

```js
import { parse, filterDeficiencyProt, filterDeficiencyDeuter, filterDeficiencyTrit,
         useMode, modeOklab, differenceEuclidean } from "culori";
useMode(modeOklab);
const d = differenceEuclidean("oklab");
// pairwise across status tokens under each deficiency; floor is 0.005
```

**Worktree note:** worktrees have no `node_modules` of their own. Symlink the main checkout's rather than running `npm ci`, which wipes the shared install:

```bash
ln -s /path/to/main/checkout/node_modules ./node_modules
```

Run scratch scripts from the repo root so Node resolves `culori`.

## 3. Author, register, gate

Theme file in `shared/theme/builtInThemes/<id>.ts`, entry in `index.ts`, then:

```bash
npx vitest run shared/theme/
npx vitest run src/config/__tests__/ src/panels/file-browser/__tests__/fileTypeIcons.test.ts
npm run typecheck     # NEVER bare `tsc -b` — it emits ~300 untracked artifacts
npx prettier --write <files> && npx eslint <files>
```

## 4. Look at it in the real app

Token values do not tell you whether the app reads. Build and run the theme tour:

```bash
npm run build:e2e          # required — the harness launches the built app
npm run theme:tour         # interactive, movile vs daintree
DAINTREE_TOUR_THEME=<id> DAINTREE_TOUR_COMPARE=<other> npm run theme:tour
npm run theme:tour:shots   # unattended: walks all 19 scenes, writes PNGs, exits
```

The tour is theme-agnostic — it works on any built-in, light or dark, and is the tool for refining the existing themes as much as for building new ones.

Interactive mode opens the real Electron window with a control panel in the bottom-right: a scene list, prev/next, a **compare** button that hot-swaps between two themes without leaving the scene, and a **live contrast-budget readout** computed from the painted CSS variables. Auto mode (`theme:tour:shots`) walks every scene unattended and writes `artifacts/theme-tour/<theme>/NN-<scene>.png` — that is what you hand to a reviewer.

Scenes cover: workbench, multi-pane fleet, terminal with seeded ANSI, **a terminal selection**, sidebar hover and search, context menu, filter popover, action palette, project switcher, notifications, **the review hub with a diff open**, **the file viewer (syntax on `surface-canvas`, not on the terminal)**, settings, the theme picker with the hero art, the destructive confirm dialog, **a real agent working**, **a real agent waiting**, and the dock.

**A scene that cannot reach its surface must say so.** `review-hub` shipped for months capturing a hub whose file list was still collapsed behind "Show files (n)" — so the PNG held no diff at all, while the scene's own note told the reviewer they were looking at diff washes and syntax. Every scene that drives toward a specific surface now ends by checking **that surface** — not the control that was supposed to summon it — and `console.warn`s when it is absent. The check caught two more the day it went in: a `terminal-selection` scene dragging across the wrong pane, and an `action-palette` scene whose fallback shortcut opened a second, different palette on top of the one being reviewed. A capture that silently asserts a surface it never reached is worse than no capture, because someone signs it off.

The two agent scenes matter more than the rest combined for any theme that encodes agent state. They drive the genuine FSM through `e2e/helpers/fakeAgent.ts` (a fake `claude` emitting OSC 9;4 heartbeats), not a faked CSS class — so what you are looking at is the state the app actually produces.

**Detach the process.** The tour outlives a single tool call only if it is fully detached:

```bash
nohup env DAINTREE_TOUR=1 npx playwright test --project=screenshots theme-tour \
  --workers=1 --reporter=list > /tmp/tour.log 2>&1 < /dev/null & disown
```

## 5. Get Codex to review it — this is not optional

See the "Codex review" section of `SKILL.md`. Do not skip it and do not soften the prompt.

## 6. Iterate until the reviewer stops finding things

Movile needed six rounds. Rounds 2, 3 and 4 each found another colour family that escaped the budget, after the theme had twice been declared complete; rounds 5 and 6 moved on to the review instrument itself, which had been quietly mis-measuring the thing it existed to check. If the reviewer has found something in every round so far, assume there is one more.

## What review actually caught (Movile, #11874)

Every item below passed the full local test suite. None of it was caught by a gate.

| Round | Finding |
| --- | --- |
| 1 | `status.warning` was never updated in a retune — 3.98:1 while the file claimed 4.4x |
| 1 | `panelStateEdge: true` is a **no-op on dark** — only `.light .panel-state-*` reads the variable |
| 1 | `shadowStyle: "none"` does not stop the legacy `--shadow-overlay`/`--shadow-modal`/dock stacks |
| 1 | The starkness claim was false — elevated L 0.185 is above highlands' grid at 0.181 |
| 1 | The frosted material contributes nothing at near-black luminance; the rings do the work |
| 2 | `pr-*` inherited defaults render at 5.8-7.7:1 in resting chrome |
| 2 | `search-highlight-text` was 10.57:1 — brighter than `status.danger` |
| 2 | The review HUD's own definition of "loudest non-signal" was hiding both of the above |
| 3 | `state-modified` is derived toward WHITE on dark and lands at 5.26:1 |
| 3 | `--color-category-*-text` is the base mixed toward `text-primary`, so the label is always brighter than the value you tuned |
| 3 | The HUD's hex-only parser silently skipped every `oklch()` value it claimed to measure |
| 4 | Chromium can serialize computed colours back as `oklch()`/`oklab()`, so an `rgb()` parser still misses them |
| 4 | The raw category base is painted as text on its own alpha tint, so it owes AA, not 3:1 |
| 5 | A canvas sentinel that is not double-checked accepts a rejected colour as opaque black |
| 6 | The HUD scored dual-use category bases against the indicator cap, reporting "no budget" for a tier the cap does not govern |
| 6 | The HUD's unresolved-token tracker was reset after the first three measurements, so an unmeasurable signal or locator colour silently became 0 and passed the ordering test |
| 6 | A stale CVD figure in an inline comment (0.0082 vs the actual 0.0078) |

## Ship it with pictures

**Every theme PR — new or a refinement — must be opened with three screenshots in the description.** A palette diff is unreviewable; the pixels are the change.

Capture them with `npm run theme:tour:shots`, then pick three from `artifacts/theme-tour/<theme>/`:

1. **`01-workbench.png`** — the resting state. The theme's identity in one frame.
2. **`03-terminal.png`** — terminal with seeded ANSI and git output. Where the user actually spends their time, and the fastest read on whether the syntax and ANSI palettes are legible.
3. **`18-agent-waiting.png`** — the loudest state the theme can produce. For a theme that encodes agent state this is the whole claim; for one that does not, swap in `15-appearance.png` (the picker with the hero art) when the PR introduces new artwork.

On a **refinement** PR, spend that third slot on the surface the change actually moved — `13-file-viewer.png`, `12-review-hub.png`, `04-terminal-selection.png` — rather than re-showing something that did not change. And re-check the numbers against the current scene list before copying a filename: adding a scene renumbers every scene after it.

**Never commit review screenshots to the repository.** Anything committed on the branch merges to `develop` and stays there forever; that is how ten stale theme PNGs accumulated under `docs/`. There is no repo path that is "PR-only" — `.github/` included.

GitHub will not take a local path in a PR body, so the image has to be hosted. Two options, neither of which touches the repo:

1. **Drag the three PNGs into the PR description in the web UI.** GitHub stores them as attachments (`https://github.com/user-attachments/assets/…`) that live outside the repository. This is the only officially supported upload path — there is no REST/GraphQL endpoint for it and `gh` cannot do it, so this step is the human's, not the agent's.
2. **Reference a CDN URL** once the shots are on R2 (`https://updates.daintree.org/…`), and paste that into the body with `gh pr create`. This is the automatable path.

Downscale first — the tour captures at full window size, and a PR body does not need 200KB per image. Write the downscaled copy alongside the capture, inside gitignored `artifacts/`:

```bash
magick artifacts/theme-tour/<theme>/01-workbench.png -resize 1200x -quality 82 \
  artifacts/theme-tour/<theme>/01-workbench-pr.png
```

Alongside the images, the PR body should carry the measured numbers (the tier table), what the theme is for, and any deliberate exceptions with their reasoning — the same material as the Codex brief, which by this point you have already written.

## Traps worth knowing before you hit them

- **The dark OKLCH ramp audits are warn-only.** A surface ladder that collapses into one sheet prints a console warning and ships green. Nothing will stop you.
- **Dark themes have no border contrast floor.** `auditBorderSeparation` is light-only. If you collapse the borders, only your eyes will notice.
- **`text-muted` has no dark floor either** — namib runs ~2.2:1. If your theme is dark, floor it by hand; it carries timestamps and metadata.
- **`materialBlur` and `materialSaturation` must both exceed 0** for every built-in. A genuinely flat theme cannot zero them; the flatness has to come from the ladder, the ink and the shadow profile instead.
- **`scrollbar-track` must stay the derived `rgba(r,g,b,0.03)` form.** Overriding it with a hex fails a runtime-defaults test.
- **`grain-opacity` must be strictly in (0,1).** Kill the grain with `grainCharacter: "none"`, not with a zero opacity.
- **`state-modified` must keep its `color-mix` form** — a plain hex fails `builtInThemes.test.ts`. Mix toward the surface rather than the tint if you need it darker.
- **`toolbar-stats-divider` must equal `toolbar-divider`**, and styling the stats pill without the divider is a failure.
- **`location` and `heroImage` are optional on the type and hard-required by the tests.**
- **Never run bare `tsc -b`** — it errors AND emits ~300 untracked, non-gitignored files. Use `npm run typecheck`.

## The tier model

The lesson that took three rounds: **a single contrast cap across "everything that isn't a signal" is not implementable**, because the same token is often an indicator in one place and text in another, and text has an accessibility floor that a design cap cannot override.

What works is an explicit ordering, with each tier floored or capped by a different rule:

| tier | governed by |
| --- | --- |
| signals (waiting, danger) | nothing — these are the loud ones |
| text (secondary, muted, search, category labels) | WCAG AA **against the background they actually paint on** |
| dual-use (category bases: icon *and* chip text) | AA, because the text use binds |
| indicators (status, activity, accent, `pr-*`, `state-modified`) | the theme's own cap |

Then state the invariant that replaces the cap for the tiers it does not govern — for Movile, "every category label stays below `text.secondary`, so a coloured chip is never louder than the prose beside it".

**Measure text contrast against the real background.** A chip label sits on a 12-20% tint of its own colour, not on the panel. That difference is about 1.4:1 and it is the difference between passing and failing AA.

## Known systemic issue (not a theme defect)

`bg-<token>/15 text-<token>` — a semantic colour painted as text on a 15-20% tint of itself — fails AA on **every dark theme in the suite**, six of eight tokens on daintree included. Do not try to fix this inside one theme; it would mean pushing every status and PR colour ~1.3:1 brighter than the rest of the cohort for a constraint no other theme honours. The systemic repair is separate accessible foreground tokens, or neutral text with coloured borders and icons.
