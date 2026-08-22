---
name: daintree-theme-creator
description: Guide for creating, modifying and REVIEWING Daintree themes. Use when working on theme palettes, semantic tokens, component extensions, built-in theme definitions, bundled theme preview imagery, or when visually reviewing/refining any existing theme in the real app.
---

# Daintree Theme Creator

Before starting, read the architecture documentation for full context:

- `docs/themes/theme-system.md` — Three-layer pipeline, core model, component override pattern, runtime application, import flow
- `docs/themes/theme-tokens.md` — Complete token reference (142 tokens), authoring vs resolved contracts, derivation defaults, contrast rules

**Before authoring or refining ANY theme, read [`resources/theme-review-workflow.md`](resources/theme-review-workflow.md).** It is the end-to-end process: sampling the hero art for real colours, solving the palette numerically before writing a line, the gate checklist, running the theme tour in the real app, the Codex review loop, the tier model, and a catalogue of traps that pass every test in the repo. It exists because Movile (#11874) needed six review rounds and every one found something the test suite could not.

When creating or replacing a built-in theme hero image or thumbnail, read [`resources/theme-preview-images.md`](resources/theme-preview-images.md) before generating anything. It defines the visual goal, reference-image workflow, exact asset sizes, hero and thumbnail source-crop workflows, and review gates.

## Three-Layer Pipeline

Daintree themes flow through three layers. Each layer has a specific role:

1. **Palette** — The visual foundation. A structured object defining surfaces, text, accent, borders, status, activity, terminal, syntax, and strategy. This is what theme authors write.
2. **Semantic tokens** — Compiled from the palette by `createSemanticTokens()`. These become `--theme-*` CSS variables. ~140 tokens covering every app-wide visual concern.
3. **Component extensions** — Optional per-component CSS variable overrides for targeted styling (toolbar chrome, sidebar states, settings dialog, pulse cards, etc.).

## Key Files

| Purpose                  | Path                                  |
| ------------------------ | ------------------------------------- |
| Palette type definition  | `shared/theme/palette.ts`             |
| Semantic token compiler  | `shared/theme/semantic.ts`            |
| Token key contract       | `shared/theme/types.ts`               |
| Contrast validation      | `shared/theme/contrast.ts`            |
| OKLCH audit gates        | `shared/theme/oklch.ts`               |
| Theme compilation        | `shared/theme/themes.ts`              |
| Built-in theme interface | `shared/theme/builtInThemeSources.ts` |
| Built-in theme index     | `shared/theme/builtInThemes/index.ts` |
| DOM application          | `src/theme/applyAppTheme.ts`          |
| CSS aliases & root vars  | `src/index.css` (lines 360-560)       |
| Theme system doc         | `docs/themes/theme-system.md`         |
| Token reference doc      | `docs/themes/theme-tokens.md`         |

### Component CSS (extension surfaces)

| Component | File | Variable prefix |
| --- | --- | --- |
| Toolbar | `src/styles/components/toolbar.css` | `--toolbar-*` |
| Sidebar / Worktree | `src/styles/components/sidebar.css` | `--sidebar-*`, `--worktree-*` |
| Settings dialog | `src/styles/components/settings.css` | `--settings-*` |
| Project Pulse | `src/styles/components/pulse.css` | `--pulse-*` |
| Panel chrome | `src/styles/components/panels.css` | `--chrome-*`, `--dialog-*`, `--floating-surface-*` |

## Palette Structure

A `ThemePalette` has these sections:

- **`type`**: `"dark"` or `"light"`
- **`surfaces`** (5 tiers, darkest to lightest for light themes, opposite for dark):
  - `grid` — Panel grid background, the structural base
  - `sidebar` — Left sidebar, toolbar surface
  - `canvas` — General content canvas
  - `panel` — Panel backgrounds, cards, dialogs
  - `elevated` — Tooltips, popovers, elevated cards
- **`text`**: `primary`, `secondary`, `muted`, `inverse`
- **`border`**: Single base border color
- **`accent`**: Primary accent color (optional `accentSecondary`)
- **`status`**: `success`, `warning`, `danger`, `info`
- **`activity`**: `active`, `idle`, `working`, `waiting`
- **`terminal`**: Full ANSI palette — `background`, `foreground`, `muted`, `cursor`, `selection`, 8 base colors, 8 bright variants
- **`syntax`**: `comment`, `punctuation`, `number`, `string`, `operator`, `keyword`, `function`, `link`, `quote`, `chip`
- **`strategy`** (optional):
  - `shadowStyle`: `"none"` | `"crisp"` | `"soft"` | `"atmospheric"`
  - `materialBlur`: backdrop blur in px (0 = disabled)
  - `materialSaturation`: backdrop saturation percentage
  - `radiusScale`: global border-radius multiplier
  - `noiseOpacity`: texture noise overlay opacity
  - `panelStateEdge`: colored edge indicator on panels

## Theme Source Interface

Built-in themes are authored as `BuiltInThemeSource`:

```typescript
{
  id: string;           // kebab-case identifier
  name: string;         // Display name
  type: "dark" | "light";
  builtin: true;
  palette: ThemePalette;
  tokens?: Partial<AppColorSchemeTokens>;  // Semantic token overrides
  extensions?: Record<string, string>;      // Component variable overrides
  location?: string;    // Geographic inspiration
  heroImage?: string;   // Theme preview image path
}
```

### When to use each layer

- **`palette`** — Always required. Defines the visual identity.
- **`tokens`** — Use sparingly to override specific semantic values that `createSemanticTokens()` doesn't derive well from the palette alone (e.g., fine-tuning overlay opacities, shadow composites, accent-muted values).
- **`extensions`** — Use for component-specific styling. These become bare CSS custom properties on `:root` (e.g., `"toolbar-project-bg": "..."` → `--toolbar-project-bg`).

## Component Extension Pattern

Component CSS files define fallback chains:

```css
.toolbar-project-pill {
  --_bg: var(--toolbar-project-bg, var(--theme-wash-medium));
  --_border: var(--toolbar-project-border, var(--theme-border-subtle));
}
```

The component checks for its own override first, then falls back to a semantic token. Themes that don't need custom component styling can omit extensions entirely — the fallbacks provide sensible defaults.

The grid background uses a similar pattern:

```css
--color-grid-bg: var(--panel-grid-bg, var(--terminal-grid-bg, var(--theme-surface-grid)));
```

So a theme can override just the grid area without changing the structural surface hierarchy.

## Contrast Requirements

`getThemeContrastWarnings()` (`shared/theme/contrast.ts`) must return **zero** warnings. It enforces considerably more than a headline list — read the source rather than this summary. The parts most often missed:

- `text-primary` >= 4.5:1 on all five surfaces, and again at 75% opacity
- `text-secondary` >= 3:1 on all five (and again, independently, via the file-tree icon guard)
- every `status-*` >= 3:1 on all five
- **`accent-primary` AND `accent-secondary` >= 3:1 on all five** (WCAG 1.4.11 non-text)
- `accent-foreground` >= 4.5:1 on `accent-primary` — it defaults to `text.inverse`, so a surface-coloured inverse often fails this
- `selection-outline` >= 3:1 against **both** the selected row fill and the surrounding surface
- `text-secondary` >= 3:1 as the recent-activity dot
- terminal: foreground OKLab dL >= 0.55 from the terminal background, every ANSI slot >= 0.18, base-vs-bright deltaE >= 0.03
- **syntax roles >= 4.5:1 on `surface-canvas`** — they render in the file viewer, not only the terminal
- `overlay-hover` Weber step >= 12% over `surface-canvas`

Separately gated: the four status tokens must stay >= 0.005 OKLab apart under protanopia, deuteranopia and tritanopia (`paletteDistinguishability.test.ts`), as must the twelve category tokens and category-vs-status.

**Not gated, and therefore your job:** dark themes have no border floor, no `text-muted` floor, and warn-only ramp/accent audits. And contrast must be measured **against the background a colour actually paints on** — a chip label sits on a 15-20% tint of its own colour, not on the panel, which is worth about 1.4:1.

## Look at it in the real app — the theme tour

Token values do not tell you whether a theme reads. There is a purpose-built harness, and it works on **any** built-in theme, light or dark — use it to refine existing themes as much as to build new ones.

```bash
npm run build:e2e          # required: the harness launches the BUILT app
npm run theme:tour         # interactive — opens the real Electron window
npm run theme:tour:shots   # unattended — walks all 19 scenes, writes PNGs, exits

DAINTREE_TOUR_THEME=bondi DAINTREE_TOUR_COMPARE=movile npm run theme:tour
```

Interactive mode gives you the app with a control panel bottom-right: a scene list you click through, prev/next, a **compare** button that hot-swaps two themes without leaving the current scene, and a **live contrast readout** computed from the CSS variables actually painted, not from authored values.

Auto mode writes `artifacts/theme-tour/<theme>/NN-<scene>.png`. Those PNGs are what you hand to Codex.

Scenes: workbench, multi-pane fleet, terminal with seeded ANSI, **terminal selection**, sidebar hover, sidebar search, context menu, filter popover, action palette, project switcher, notifications, **review hub with the diff open**, **file viewer (syntax on the canvas)**, settings, theme picker with hero art, destructive confirm dialog, **agent working**, **agent waiting**, dock.

Every scene that drives toward a specific surface ends by checking **that surface**, and warns to the console when it is absent. Take that seriously: `review-hub` used to capture a hub with the file list still collapsed, so the PNG contained no diff at all while the scene's own note claimed to be showing diff washes and syntax. A capture that quietly asserts a surface it never reached is worse than a missing capture, because a reviewer signs it off.

The two agent scenes drive the genuine agent-state FSM through `e2e/helpers/fakeAgent.ts` (a fake `claude` emitting OSC 9;4 heartbeats), not a faked CSS class — essential for any theme that encodes agent state, because that is the claim most likely to be wrong and the hardest to check by eye.

Source: `e2e/screenshots/theme-tour.spec.ts` (scenes), `e2e/helpers/themeTour.ts` (the HUD), `e2e/helpers/fakeAgent.ts` (the FSM driver). To add a scene, append to `SCENES` with an `id`, `label`, a `note` saying what the reviewer should judge, and a `run(page)`.

Detach the process or it dies with the shell that started it:

```bash
nohup env DAINTREE_TOUR=1 npx playwright test --project=screenshots theme-tour \
  --workers=1 --reporter=list > /tmp/tour.log 2>&1 < /dev/null & disown
```

`e2e/screenshots/theme-review.spec.ts` is the older sibling — pure PNG capture, no interactivity. The tour supersedes it for review.

## Codex review — REQUIRED, and do it properly

**If the Codex MCP is available (`mcp__codex__codex`), use it to review every theme: to verify it, to improve it, and specifically to look at the screenshots.** Codex reads rendered pixels well and catches contrast and token errors no test in this repo can. On Movile it found fourteen real defects across six rounds, including three separate colour families that escaped the contrast budget after the theme had already been declared finished twice.

Run it as **two separate sessions** — one visual, one code. A single combined session with all the screenshots and all the engine files exceeds the 30-minute idle timeout and produces worse results than two focused ones.

Call parameters, every time:

```
model: "gpt-5.6-sol"
config: { "model_reasoning_effort": "high" }   // "max" tends to exceed the idle timeout
sandbox: "read-only"
approval-policy: "never"
cwd: <absolute repo root>
```

Codex is stateless per call, so **the prompt must be self-contained**. Write a context brief to a temp directory and point at it by absolute path, next to the screenshots:

```
/tmp/<theme>-review/CONTEXT.md          the brief
/tmp/<theme>-review/screenshots/*.png   copied from artifacts/theme-tour/<theme>/
```

The brief must carry: the originating issue and the theme's goal, every design decision **and its rationale**, the measured numbers, what changed since the last round, and anything you deliberately did not do with your reasoning. Codex will overturn some of it — that is the point of writing it down.

Ask for a **straight ship / do-not-ship verdict**, and add "do not invent work to have something to say". Without that you get padding.

Three instructions that produced most of the value:

1. **"Verify my comments. I wrote them; do not trust them."** Inline comments accumulate stale contrast figures fast. Codex found false claims in every single round.
2. **"Sweep for any other derived, inherited or CSS-composed token that paints a semantic colour in resting chrome and escapes the budget."** This is how `pr-*`, `search-highlight-text`, `state-modified` and the `--color-category-*-text` derivatives were each found — one per round, after the theme looked finished.
3. **"Tell me plainly which of my push-backs I got wrong."** List what you disagreed with and why. Codex retracted one of its own findings when shown a measurement, and upheld a scope call when shown cohort data.

**Push back when Codex is wrong, with numbers.** It told me to raise an ANSI colour into a band it already sat above, and it initially treated a suite-wide AA failure as a Movile defect — measuring the whole cohort showed six of eight daintree tokens failing identically, and it accepted the scope call. Verify findings against the source before acting: it is right most of the time, not all of it.

## Ship it with pictures

**Every theme PR — new theme or a refinement to an existing one — must be opened with three screenshots in the description.** A palette diff is unreviewable; the pixels are the change.

Run `npm run theme:tour:shots`, then take three from `artifacts/theme-tour/<theme>/`:

1. **`01-workbench.png`** — the resting state, the theme's identity in one frame
2. **`03-terminal.png`** — terminal with seeded ANSI and git output, the fastest read on syntax and ANSI legibility
3. **`18-agent-waiting.png`** — the loudest state the theme can produce; swap in `15-appearance.png` (the picker with hero art) when the PR introduces new artwork and the theme does not lean on agent state

For a **refinement** PR, that third slot is better spent on whatever the change actually touched — `13-file-viewer.png`, `12-review-hub.png` or `04-terminal-selection.png` — since the reader needs to see the thing that moved, not the thing that did not. Check the numbers against the current scene list before copying a filename; adding a scene renumbers everything after it.

Commit the three (downscaled) under `docs/themes/review/<theme>/` on the branch and reference them by raw URL in the PR body — a relative path 404s until merge:

```
https://raw.githubusercontent.com/daintreehq/daintree/<branch>/docs/themes/review/<theme>/01-workbench.png
```

Include the measured numbers, what the theme is for, and any deliberate exceptions with reasoning. See `resources/theme-review-workflow.md` for the full recipe.

## Design Philosophy

Built-in themes are named after natural locations worldwide. Each theme evokes the colors, light, and atmosphere of its place:

- **Dark themes** use deep, rich surfaces with vibrant terminal palettes
- **Light themes** use airy, bright surfaces with enough contrast for readability
- The terminal palette is always independent from workbench surfaces — terminals are their own environment
- Shadows, material blur, and noise are atmospheric tools — use them to reinforce the theme's character
- Component extensions are for precision — use them to fine-tune specific UI regions without bloating the global token set

## Workflow for Creating a New Theme

1. Start with the palette — pick your 5 surface tiers, text colors, accent, and border
2. Run `createSemanticTokens()` mentally or in a test to see what it derives
3. Override any semantic tokens that don't look right via `tokens`
4. Add component extensions only where needed for polish
5. Validate contrast with `getThemeContrastWarnings()` — it must return ZERO warnings
6. Run the OKLCH audit gates: `npx vitest run shared/theme/__tests__/builtInThemes.test.ts` — checks surface ramp evenness (adjacent dL ≥ 0.02, no runaway steps > 3:1 ratio), accent prominence (dL ≥ 0.20 against canvas, chroma C ≥ 0.05), and cross-theme accent distinctness (ΔE ≥ 15 within polarity, no duplicate accentSecondary hexes). See `docs/themes/theme-tokens.md` for the full threshold reference.
7. Add the theme file to `shared/theme/builtInThemes/` and register in `index.ts`
8. Update the counts in `docs/themes/theme-system.md`, `README.md` and `docs/feature-curation.md`
9. Build and look at it: `npm run build:e2e && npm run theme:tour`
10. Review it with Codex (two sessions: visual, then code) and iterate until it stops finding things

## Workflow for Modifying an Existing Theme

1. Read the theme's source file in `shared/theme/builtInThemes/`
2. Understand the palette hierarchy — surfaces go from structural (grid) to elevated
3. Make palette changes first; they cascade through semantic token derivation
4. Adjust `tokens` overrides only if the derived values aren't right
5. Adjust `extensions` for component-specific refinements
6. Check contrast after changes — lightening surfaces can break text contrast. Also run the OKLCH audit gates (`npx vitest run shared/theme/__tests__/builtInThemes.test.ts`) to verify surface ramp evenness, accent prominence, and cross-theme distinctness. Remember the dark ramp/accent audits are WARN-ONLY: a collapsed ladder ships green.
7. Look at the result: `npm run build:e2e && DAINTREE_TOUR_THEME=<id> npm run theme:tour`. Use the **compare** button against a neighbouring theme — a side-by-side on the same scene surfaces problems a single view hides.
8. Review with Codex if available (see "Codex review" above).

$ARGUMENTS
