# Theme Token Reference

Complete reference for Daintree's semantic token system. Every built-in and custom theme must provide values for all tokens. The `createDaintreeTokens()` helper derives sensible defaults for most tokens from a smaller set of required palette values.

## Token Layers

| Layer | Prefix | Purpose |
| --- | --- | --- |
| Surface | `surface-*` | Depth hierarchy and interactive surfaces |
| Text | `text-*` | Typography color hierarchy |
| Border | `border-*` | Edge and divider treatments |
| Accent | `accent-*` | Primary and optional secondary interaction color |
| Status | `status-*` | Semantic outcome colors |
| Activity | `activity-*` | Real-time agent state indicators |
| Form | `knob-base`, `state-modified` | Form component styling (Switch/Slider knobs, modified indicators) |
| Overlay | `overlay-*` | Interactive state tinting ladder |
| Wash | `wash-*` | Atmospheric tinted fills |
| Scrim | `scrim-*` | Modal backdrop dimming |
| Shadow | `shadow-*` | Elevation shadow profiles |
| Material | `material-*` | Backdrop blur/saturation strategy |
| PR state | `pr-*` | PR/issue state colors |
| Search | `search-*` | Search highlighting (independent of accent) |
| Terminal | `terminal-*` | Terminal emulator layer (independent of workbench) |
| Syntax | `syntax-*` | Code editor token colors |
| Category | `category-*` | 12 organizational label hues |
| Diff | `diff-*` | Diff viewer insert/delete/gutter colors |
| Utility | (various) | Scrollbar, panel edge, focus ring, chrome noise, state chip/label pill opacities |
| Shared | `focus-ring`, `shadow-color`, `tint`, `radius-scale` | Cross-cutting single tokens |

## Surface Tokens

Five-level depth hierarchy plus semantic interactive surfaces.

| Token | Purpose | Derived? |
| --- | --- | --- |
| `surface-grid` | Deepest recess — panel grid background | Required |
| `surface-sidebar` | Sidebar, toolbar, dock chrome | Required |
| `surface-canvas` | Main app background (`<body>`) | Required |
| `surface-panel` | Panel chrome, dropdowns, dialogs | Required |
| `surface-panel-elevated` | Focused panel, tooltips | Required |
| `surface-toolbar` | Toolbar surface | Derived: `color-mix(sidebar, canvas)` |
| `surface-input` | Text input backgrounds | Derived: `panel-elevated` (dark) / `panel` (light) |
| `surface-inset` | Recessed content within panels | Derived: `tint` 3-4% |
| `surface-hover` | Hover overlay on interactive elements | Derived: `tint` 3-5% |
| `surface-active` | Active/pressed overlay | Derived: `tint` 6-8% |
| `surface-disabled` | Disabled input background | Derived: `input` blended 70% with `canvas` |

**Design rule:** Adjacent surface pairs must have clear perceptual separation. Grid -> sidebar -> canvas -> panel -> elevated should read as a smooth depth ramp.

### OKLCH Audit Gates

The built-in theme test suite (`shared/theme/__tests__/builtInThemes.test.ts`) validates every theme against OKLCH-based perceptual thresholds. These gates run in CI and emit warnings for themes that fall below the target. Warnings are non-blocking; per-theme palette fixes are tracked in follow-up issues.

**Surface elevation ramp** (`auditSurfaceRamp`):

- Adjacent step ΔL ≥ **0.02** in OKLab. Below this Just-Noticeable Difference (JND) threshold, surfaces perceptually merge.
- Runaway ratio: the largest adjacent step must not exceed **3×** the smallest adjacent step. A ratio > 3:1 means one jump dominates the ramp and the elevation progression reads as uneven.

**Accent prominence** (`auditAccentProminence`):

- Lightness separation against `canvas`: ΔL ≥ **0.20**. Ensures the accent remains visible under grayscale / achromatopsia.
- Chroma floor: C ≥ **0.05** in OKLCH. Below this, the accent reads as a tinted neutral rather than unambiguously colored.

**Cross-theme distinctness** (`auditCrossThemeAccents`):

- Primary accent pairwise distance within the same polarity: ΔE ≥ **0.12** in OKLab (`CROSS_THEME_DE_WARN`). Ensures themes have perceptibly different accent colors.
- No two themes may share the exact same `accentSecondary` hex value.

All thresholds are derived from CSS Color 4, APCA research, and Material 3 guidelines. The OKLCH conversion chain (sRGB → linear → LMS → OKLab → OKLCh) is implemented in `shared/theme/oklch.ts`.

## Text Tokens

| Token | Purpose | Derived? |
| --- | --- | --- |
| `text-primary` | Headings, active labels, focused content | Required |
| `text-secondary` | Descriptions, subtitles, inactive tabs | Required |
| `text-muted` | Disabled text, timestamps (may fall below WCAG AA) | Required |
| `text-placeholder` | Input placeholder text | Derived: `text-primary` 32-35% |
| `text-inverse` | Text on solid accent/color backgrounds | Required |
| `text-link` | Hyperlink color | Derived: `accent-primary` |

Dim or disabled icons must use a solid token (`text-text-muted` for disabled/needs-setup glyphs, `text-text-secondary` for de-emphasized ones), never a half-transparent one. The `icon-opacity-dimming/no-icon-opacity-dimming` ESLint rule blocks the two opacity-compositing patterns on `<svg>` and icon components — `opacity-*` utilities (other than the `opacity-0`/`opacity-100` visibility toggles) and the `grayscale` filter — because both blend the icon with whatever sits behind it and read differently on each palette. Prefer a solid token over slash-alpha color modifiers (`text-text-primary/50`) too; those aren't lint-enforced but carry the same compositing pitfall. Genuine visibility toggles (an icon that fades from `opacity-0`) opt out of the rule with an inline `eslint-disable-next-line` carrying a reason.

## Border Tokens

| Token                | Purpose                             | Dark default | Light default |
| -------------------- | ----------------------------------- | ------------ | ------------- |
| `border-default`     | Card outlines, input borders        | Required     | Required      |
| `border-subtle`      | Panel-internal dividers             | `white 8%`   | `black 5%`    |
| `border-strong`      | Focused panel borders               | `white 14%`  | `black 14%`   |
| `border-divider`     | Structural separators               | `white 5%`   | `black 4%`    |
| `border-interactive` | Hovered/focused interactive borders | `white 20%`  | `black 10%`   |
| `selection-outline`  | Palette selected-row hairline       | `text 42%`   | `text 53%`    |

**Polarity pattern:** Dark themes use white-alpha; light themes use black-alpha.

**`selection-outline` is deliberately outside that ladder.** It is derived from `text-primary` rather than the border ink, and sits 2-3x above `border-strong`, because it is the only border in the app that must satisfy WCAG 1.4.11 on its own — the raised fill it encloses clears barely 1.1-1.2:1 against the palette surface, so the outline is the whole non-text indicator. `getThemeContrastWarnings` gates it at 3:1 against both the selected fill and the surrounding surface, so retuning `text-primary` or the fill trips the theme contract rather than silently weakening the indicator. See [interaction-state-recipes.md](./interaction-state-recipes.md#selected-state-list-item).

## Accent Tokens

| Token | Purpose | Derived? |
| --- | --- | --- |
| `accent-primary` | Solid accent — buttons, toggles, active indicators | Required |
| `accent-hover` | Hover state | Derived: accent mixed 90% with polarity color |
| `accent-foreground` | Text on solid accent backgrounds | Derived: `text-inverse` |
| `accent-soft` | Low-opacity tint (~12-18%) | Derived from accent-primary |
| `accent-muted` | Medium-opacity tint (~20-30%) | Derived from accent-primary |
| `accent-rgb` | Raw RGB triplet for `rgba()` usage | Derived from accent-primary |

**Critical rule:** Accent must remain distinct from `status-success`. They serve different semantic roles.

### Secondary Accent Tokens

An optional second color lane for themes with two distinct interaction colors.

| Token                    | Purpose             | Default                |
| ------------------------ | ------------------- | ---------------------- |
| `accent-secondary`       | Second accent hue   | `status-success`       |
| `accent-secondary-soft`  | Low-opacity tint    | Derived from secondary |
| `accent-secondary-muted` | Medium-opacity tint | Derived from secondary |

## Status Tokens

Fixed hue families across all themes. Each theme tunes brightness/saturation.

| Token                   | Hue family                         | Derived?                         |
| ----------------------- | ---------------------------------- | -------------------------------- |
| `status-success`        | Green — completed/ready states     | Required                         |
| `status-warning`        | Amber — caution states             | Required                         |
| `status-danger`         | Red — error/destructive states     | Required                         |
| `status-info`           | Blue — neutral informational       | Required                         |
| `status-danger-surface` | Validation wash for invalid fields | Derived: `danger` at 8-10% alpha |

## Activity Tokens

Drive state chips in panel headers and worktree card indicators.

| Token                | Purpose                              | Derived?                  |
| -------------------- | ------------------------------------ | ------------------------- |
| `activity-active`    | Real-time working indicator (vivid)  | Required                  |
| `activity-working`   | Animated spinner color               | Required                  |
| `activity-waiting`   | Agent waiting for user input (amber) | Required                  |
| `activity-idle`      | Inactive/dormant state               | Required                  |
| `activity-completed` | Finished successfully                | Derived: `status-success` |

## Overlay Tokens

A single-knob color input (`overlay-base`) drives the entire opacity ladder.

| Token              | Purpose                           | Dark default | Light default |
| ------------------ | --------------------------------- | ------------ | ------------- |
| `overlay-base`     | Tint color for the ladder         | `#ffffff`    | `#000000`     |
| `overlay-subtle`   | Lightest interactive tint         | base 2%      | base 2%       |
| `overlay-soft`     | Hover state on list items         | base 3%      | base 3%       |
| `overlay-medium`   | Active/selected item, focus fills | base 4%      | base 5%       |
| `overlay-strong`   | Stronger fills, secondary hover   | base 6%      | base 8%       |
| `overlay-emphasis` | Maximum-contrast fill             | base 10%     | base 12%      |
| `overlay-hover`    | General hover                     | tint 5%      | tint 3%       |
| `overlay-active`   | General active/pressed            | tint 8%      | tint 6%       |
| `overlay-selected` | Selected state                    | tint 4%      | tint 5%       |
| `overlay-elevated` | Elevated hover                    | tint 6%      | tint 8%       |

**See [Canonical Interaction State Recipes](./interaction-state-recipes.md)** for hover/focus implementation patterns using these overlay tokens.

Set `overlay-base` to a hued color to tint all hover and fill states (e.g. Fiordland: icy blue `#B4DCF0`, Arashiyama: warm cream `#FFECE6`).

## Filter-Selected Tokens

Selected-state pill backgrounds (e.g. active filter chips). Tint-derived so they stay neutral across hued themes rather than picking up the accent or overlay hue.

| Token                       | Dark default  | Light default |
| --------------------------- | ------------- | ------------- |
| `filter-selected-bg-soft`   | `tint` at 8%  | `tint` at 6%  |
| `filter-selected-bg-strong` | `tint` at 12% | `tint` at 10% |

## Wash Tokens

Atmospheric tinted fills using `overlay-base`:

| Token         | Opacity |
| ------------- | ------- |
| `wash-subtle` | 2%      |
| `wash-medium` | 4%      |
| `wash-strong` | 8%      |

## Scrim Tokens

| Token                | Dark default       | Light default     |
| -------------------- | ------------------ | ----------------- |
| `scrim-soft`         | `rgba(0,0,0,0.2)`  | `rgba(0,0,0,0.3)` |
| `scrim-medium`       | `rgba(0,0,0,0.45)` | `rgba(0,0,0,0.5)` |
| `scrim-strong`       | `rgba(0,0,0,0.62)` | `rgba(0,0,0,0.7)` |
| `scrim-blur`         | `12px`             | `12px`            |
| `scrim-blur-palette` | `4px`              | `4px`             |

`scrim-blur` (modal/dialog backdrops, `AppDialog`) and `scrim-blur-palette` (command/panel palettes, `AppPaletteDialog`) control the backdrop blur depth behind the scrim — optical depth, which scrim color alpha cannot fake. This axis is legitimately pulled in both directions: fog biomes thicken it (16-20px reads as mist arriving), arid/clarity biomes sharpen it (0-4px dims without hazing) — `0px` is legal. Scrim _color_ stays on the `scrim-*` color tokens, so WCAG scrim-contrast gates are unaffected by blur changes.

## Shadow Tokens

| Token | Dark default | Light default |
| --- | --- | --- |
| `shadow-color` | `rgba(0,0,0,0.5)` | `rgba(0,0,0,0.12)` |
| `shadow-ambient` | `0 1px 3px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2)` | `0 2px 8px rgba(0,0,0,0.06)` |
| `shadow-floating` | `0 4px 12px rgba(0,0,0,0.5), 0 1px 3px rgba(0,0,0,0.3)` | `0 4px 12px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.08)` |
| `shadow-dialog` | Defaults to `shadow-floating` | Defaults to `shadow-floating` |

`createSemanticTokens()` overrides shadow profiles based on `strategy.shadowStyle`:

| Style           | Character                                              |
| --------------- | ------------------------------------------------------ |
| `"none"`        | No shadows, border-only elevation                      |
| `"crisp"`       | Tight, close shadows (default for light themes)        |
| `"soft"`        | Default medium-depth shadows (default for dark themes) |
| `"atmospheric"` | Wide, diffused fog-like shadows                        |

## Material/Radius Tokens

Derived from `ThemeStrategy` in the palette:

| Token                 | Purpose                          | Default                      |
| --------------------- | -------------------------------- | ---------------------------- |
| `material-blur`       | Backdrop blur in px              | `0px`                        |
| `material-saturation` | Backdrop saturation              | `100%`                       |
| `material-opacity`    | Surface opacity when blur active | `1` (or `0.9` when blur > 0) |
| `radius-scale`        | Global border-radius multiplier  | `1`                          |

## PR State Tokens

| Token       | Purpose                   |
| ----------- | ------------------------- |
| `pr-open`   | Open issue/PR indicator   |
| `pr-merged` | Merged PR indicator       |
| `pr-closed` | Closed issue/PR indicator |
| `pr-draft`  | Draft PR indicator        |

Provider-agnostic — these color any forge's PR/issue state. Defaults follow GitHub's dark/light palette; each theme can override them individually.

## Search Tokens

Search highlighting is independent of accent. Bondi tints its search highlight _text/icon_ blue (`#2B6CA8` — `search-highlight-text`, `search-match-badge-text`, `search-selected-result-icon`) while its accent is green (`#145A44`).

| Token | Purpose | Default |
| --- | --- | --- |
| `search-highlight-background` | `<mark>` background for matched text | Derived from accent |
| `search-highlight-text` | Text color inside highlighted matches | Derived: `status-success` |
| `search-selected-result-border` | Border on selected search result row | `accent-primary` |
| `search-selected-result-icon` | Icon color in selected result | `accent-primary` |
| `search-match-badge-background` | Match count badge background | `accent-soft` |
| `search-match-badge-text` | Match count badge text | `accent-primary` |

Override when accent hue doesn't work as a text highlight.

## Terminal Tokens

Terminal is a first-class layer, independent of workbench. Light themes commonly use a dark terminal (e.g., Bondi: `#1E252E` terminal inside a light workbench).

| Token | Purpose | Derived? |
| --- | --- | --- |
| `terminal-background` | Terminal emulator background | Derived: `surface-canvas` |
| `terminal-foreground` | Default terminal text | Derived: `text-primary` |
| `terminal-muted` | Dimmed terminal text | Derived: `text-muted` |
| `terminal-cursor` | Cursor block color | Derived: `accent-primary` |
| `terminal-cursor-accent` | Text behind cursor | Derived: `terminal-background` |
| `terminal-selection` | Selection highlight background | Required |
| `terminal-black` | ANSI black | Derived: `surface-canvas` (dark) / `text-primary` (light) |
| `terminal-red` | ANSI red | Required |
| `terminal-green` | ANSI green | Required |
| `terminal-yellow` | ANSI yellow | Required |
| `terminal-blue` | ANSI blue | Required |
| `terminal-magenta` | ANSI magenta | Required |
| `terminal-cyan` | ANSI cyan | Required |
| `terminal-white` | ANSI white | Derived: `text-primary` (dark) / `surface-canvas` (light) |
| `terminal-bright-black` | Bright black | Derived: `activity-idle` |
| `terminal-bright-red` through `terminal-bright-white` | Bright ANSI colors | Required (6) / Derived (bright-black, bright-white via palette) |

## Syntax Tokens

Code editor highlighting. Each theme provides a palette coherent with its atmosphere. All 10 are required in the palette.

| Token                | Purpose              |
| -------------------- | -------------------- |
| `syntax-comment`     | Lowest visual weight |
| `syntax-punctuation` | Brackets, semicolons |
| `syntax-number`      | Numeric literals     |
| `syntax-string`      | String literals      |
| `syntax-operator`    | Operators            |
| `syntax-keyword`     | Language keywords    |
| `syntax-function`    | Function names       |
| `syntax-link`        | URLs in code         |
| `syntax-quote`       | Block quotes         |
| `syntax-chip`        | Inline code chips    |

**Hierarchy rule:** `comment` is always lowest contrast; `keyword`, `function`, `string` are always highest.

## Category Tokens

12 perceptually uniform hues using `oklch()`. Dark themes use higher lightness (~0.70), light themes use lower (~0.55).

`category-blue`, `category-purple`, `category-cyan`, `category-green`, `category-amber`, `category-orange`, `category-teal`, `category-indigo`, `category-rose`, `category-pink`, `category-violet`, `category-slate`

CSS automatically generates `-subtle`, `-text`, and `-border` composite variants via `color-mix` in `src/index.css`.

## Diff Tokens

Theme-controlled colors for the diff viewer. Derived from `status-success` and `status-danger`.

| Token                         | Dark default            | Light default           |
| ----------------------------- | ----------------------- | ----------------------- |
| `diff-insert-background`      | `status-success` at 18% | `status-success` at 10% |
| `diff-insert-edit-background` | `status-success` at 28% | `status-success` at 20% |
| `diff-delete-background`      | `status-danger` at 18%  | `status-danger` at 10%  |
| `diff-delete-edit-background` | `status-danger` at 28%  | `status-danger` at 20%  |
| `diff-gutter-insert`          | `status-success`        | `status-success`        |
| `diff-gutter-delete`          | `status-danger`         | `status-danger`         |
| `diff-selected-background`    | `tint` at 6%            | `tint` at 6%            |
| `diff-omit-gutter-line`       | `activity-idle`         | `activity-idle`         |

## UI Utility Tokens

| Token | Purpose | Dark default | Light default |
| --- | --- | --- | --- |
| `state-chip-bg-opacity` | State chip background fill | `0.15` | `0.12` |
| `state-chip-border-opacity` | State chip border | `0.40` | `0.35` |
| `label-pill-bg-opacity` | GitHub label pill background | `0.10` | `0.08` |
| `label-pill-border-opacity` | GitHub label pill border | `0.20` | `0.15` |
| `scrollbar-width` | Scrollbar track width | `6px` | `6px` |
| `scrollbar-thumb` | Thumb color at rest | `activity-idle` | `activity-idle` |
| `scrollbar-thumb-hover` | Thumb color on hover | Derived: idle mixed with text-primary | Same |
| `scrollbar-track` | Track background | `transparent` | `transparent` |
| `panel-state-edge-width` | Rail width (0px = disabled) | `0px` | `2px` |
| `panel-state-edge-inset-block` | Vertical inset from panel edges | `4px` | `4px` |
| `panel-state-edge-radius` | Rail end-cap radius | `2px` | `2px` |
| `focus-ring-offset` | Offset between element and ring | `2px` | `2px` |
| `chrome-noise-texture` | CSS `background-image` grain layer | `none` | `none` |
| `grain-opacity` | `.bg-noise` grid texture opacity | `0.02` | `0.02` |
| `grain-blend` | `.bg-noise` grid texture `mix-blend-mode` | `overlay` | `overlay` |

`chrome-noise-texture` accepts ANY CSS `background-image` string, not just the engine's generated radial — the token replaces the generated value wholesale (see `resolveChromeNoiseTexture` in `shared/theme/themes.ts`), so the override carries its own alpha inside the string. Vertical sheens, relocated sun gradients, and `feTurbulence` data-URIs are all legitimate values; the surrounding chrome surface remains the contrast source of truth.

### Grid Grain

The `.bg-noise` grid texture is themeable on two axes: strength/compositing via the `grain-opacity` / `grain-blend` semantic tokens above, and texture choice via the `grainCharacter` strategy field.

- **Opacity ceiling:** keep `grain-opacity` ≤ `0.05`. Texture above ~4-5% reads as costume, not material; most themes should sit between `0.012` (mirror-quiet) and `0.035` (present weather).
- **`strategy.grainCharacter`** (`"fine" | "coarse" | "paper" | "none"`, optional): selects WHICH texture tiles on the grid. `coarse` is a granular turbulence tile (sand/basalt/salt biomes), `paper` a fractal-noise mottle (washi/fiber). Unset or `"fine"` emits nothing — the CSS fallback keeps the bundled `noise.png` (the asset reference must stay in `src/index.css` because a relative `url()` inside a `:root` custom property resolves against the document, not the stylesheet). `"none"` disables the layer.
- The resolved value is emitted as the conditionally-present `--grain-image` extension var (`resolveGrainImage` in `shared/theme/themes.ts`); an explicitly authored `grain-image` extension wins over the strategy field.
- The grain layer inherits all existing `.bg-noise` behavior (performance mode, polarity compositing) since the tokens only drive the existing pseudo-element's declarations.

## Form State Tokens

Specialized tokens for form component styling (Switch, Slider, validation states). These tokens split from existing tokens to enable finer control over form element appearance.

| Token | Purpose | Dark default | Light default |
| --- | --- | --- | --- |
| `knob-base` | Switch/Slider knob fill (polarity-aware) | `oklch(0.98 0.003 90)` | `oklch(0.18 0.01 240)` |
| `state-modified` | Modified-from-default indicator (distinct from accent) | Derived: `status-info` mixed 90% with `tint` | Same |

**Design notes:**

- `knob-base` uses polarity-aware static colors: off-white in dark themes, near-black in light themes. This avoids subpixel antialiasing artifacts from `text-inverse` and provides consistent contrast against accent-colored tracks.
- `state-modified` derives from `status-info` (blue) rather than `accent-primary` to allow independent tuning for "unsaved changes" indicators without affecting buttons and active rails.

## Shared Tokens

| Token          | Purpose                                                 |
| -------------- | ------------------------------------------------------- |
| `focus-ring`   | Keyboard focus indicator color (derived: `tint` 18%)    |
| `shadow-color` | Base color for elevation shadows                        |
| `tint`         | Overlay polarity: `#ffffff` (dark) or `#000000` (light) |

---

## Authoring vs. Resolved Tokens

The token system has two contracts:

**Palette authoring** — what a theme author provides via `BuiltInThemeSource.palette`. The `ThemePalette` structure requires surfaces, text, border, accent, status, activity, terminal colors, and syntax colors. `createSemanticTokens()` maps these to token inputs and calls `createDaintreeTokens()`.

**Token overrides** — `BuiltInThemeSource.tokens` allows overriding any derived semantic token when the automatic derivation doesn't produce the right result.

**Resolved output** — the complete `AppColorSchemeTokens` object. Every token in `APP_THEME_TOKEN_KEYS` is guaranteed to be present. This is the only contract components and the CSS variable pipeline consume.

Token classification:

| Class | Description |
| --- | --- |
| **Required** | Must be in the palette (surfaces, text, border, accent, status, activity, terminal ANSI, syntax) |
| **Optional override** | Can be supplied via `tokens`; falls back to a derived value if omitted |
| **Derived** | Always computed from palette inputs; never authored directly |

## Creating a New Theme

### 1. Define the palette

Create a new file in `shared/theme/builtInThemes/` exporting a `BuiltInThemeSource` with a complete `ThemePalette`:

- 5 surface tiers + text (primary/secondary/muted/inverse) + border
- accent + optional accentSecondary
- 4 status colors + 4 activity states
- terminal palette (selection + 12 ANSI colors + brightWhite required; background/foreground/muted/cursor optional with fallbacks)
- 10 syntax colors
- optional strategy (shadowStyle, materialBlur, materialSaturation, radiusScale, noiseOpacity, panelStateEdge, borderInkOverride, statusSurfaceOpacity, grainCharacter)

### 2. Override derived tokens as needed

Add a `tokens` object to override any semantic values that don't derive well. Common overrides:

- `overlay-base` — set to a hued color to tint hover/fill states
- `shadow-ambient` / `shadow-floating` / `shadow-dialog` — tune shadow personality
- `search-*` — if accent hue doesn't work as search highlighting
- `scrollbar-thumb` / `scrollbar-thumb-hover` — if you want custom scrollbar colors
- `focus-ring` — custom focus indicator color
- `accent-soft` / `accent-muted` — fine-tune accent opacity tints

### 3. Add component extensions

Add an `extensions` object for component-specific overrides. These become bare CSS custom properties. Only add what you need — omitted extensions fall back to semantic tokens.

Common extension families: `toolbar-*`, `sidebar-*`, `settings-*`, `pulse-*`, `dock-*`, `panel-grid-bg`, `worktree-section-hover-bg`, `worktree-filter-bar-bg` (opt-in distinct surface for the worktree sidebar's filter/search bar — unset themes keep the bar transparent), `worktree-search-input-bg` (opt-in raised field for the sidebar search input — unset themes keep the canvas-toned field), `sidebar-card-bg` / `sidebar-card-shadow` (opt-in opaque card plane + hairline ring for idle worktree cards — the light "white cards on tinted field" idiom; unset themes keep transparent cards), `dock-input-bg` (opt-in raised fill for the QuickRun command field — unset themes keep the overlay-soft ink wash), `review-commit-input-bg` (opt-in raised fill for the review-hub commit field — canvas fallback), `worktree-quick-state-active-bg` (opt-in lift for the active quick-state segment — overlay-subtle fallback), `settings-scope-bg` (opt-in fill for the settings scope select trigger — transparent fallback), `project-tile-wash` / `project-tile-shadow` (opt-in overlay + shadow for the project emoji tiles — black-wash/dark-inset fallbacks), `panel-header-bg` / `panel-header-focus-bg` (opt-in pane title-bar caps — transparent/overlay-subtle fallbacks).

Newer opt-in extension keys (all OPTIONAL; omission renders exactly the legacy recipe):

- `panel-focus-border` / `panel-focus-shadow` / `panel-selected-bg` — the focused/selected pane's border ink, glow shadow stack, and fill (`.terminal-selected` / `.terminal-selected-quiet` / `.assistant-focused` / `.terminal-focused` in `src/index.css`; fallbacks are the legacy `color-mix` recipes). `.terminal-selected-quiet` is the lone-pane cue (#11837) — it reads the border and shadow keys but never the fill, so a theme cannot give it a surface lift. Accent budget: focus is the one load-bearing signal per focus region, so accent-family ink here is legitimate — but a theme inking focus chrome from its accent must not also carry another accent fill in the panel region. High-contrast (`prefers-contrast: more` / `forced-colors`) recipes stay hardcoded and win over these keys.
- `panel-grid-bg` / `terminal-grid-bg` — accept full CSS `background` shorthand, gradients included. The audited flat `surfaces.grid` token stays the contrast/ramp source of truth: gradients must keep the flat hex as their final layer. The boot splash skeleton reads the flat `--theme-surface-grid`, so boot theming is unaffected.
- `welcome-field-wash` / `welcome-mark-color` — a full `background` shorthand layered behind `WelcomeScreen` (fallback `none`) and the brand-mark tint (fallback: tint at 50%). Washes stay whisper-alpha (≤8%) and existing text alphas must still clear their contrast floors over the composited wash — a design-review gate, and the wash counts against the theme's narrative-quote budget.
- `dock-item-bg` / `dock-item-bg-active` / `dock-item-border-active` — the dock pill's item fills/borders. Fallbacks (in the `:root` block of `src/index.css`) are the legacy idle overlay-subtle fill, accent@12% active fill, and accent@0.32 active border; light themes can replace the accent-tinted membership fill with a lift-toward-white plane.
- `settings-sidebar-scroll-fade` — the `--scroll-shadow-color` for the settings sidebar's `ScrollShadow` fades. Only needed when a theme also authors a custom `settings-sidebar-bg`; the fallback in `src/styles/components/settings.css` composites the default 50% canvas wash over the dialog shell (`color-mix(in srgb, var(--theme-surface-canvas) 50%, var(--settings-dialog-bg, var(--theme-surface-panel)))`), so unset themes color-match automatically. Author it as the sidebar's effective (composited, opaque) background so the fade dissolves into the surface instead of glowing.
- `grain-image` — not authored directly by built-ins; resolved from `strategy.grainCharacter` (see Grid Grain above).

### 4. Register the theme

Import and add to `shared/theme/builtInThemes/index.ts`.

### 5. Validate

- Run `getThemeContrastWarnings()` from `shared/theme/contrast.ts`
- `text-primary` on all surfaces >= 4.5:1 (WCAG AA)
- `text-secondary` on canvas/panel/elevated >= 3:1
- `accent-foreground` on `accent-primary` >= 4.5:1
- Terminal foreground on terminal background >= 4.5:1
- Terminal red/green on terminal background >= 3:1

## Token Count Summary

| Group           | Count                                                 |
| --------------- | ----------------------------------------------------- |
| Surface         | 11                                                    |
| Text            | 6                                                     |
| Border          | 5                                                     |
| Accent          | 9 (6 primary + 3 secondary)                           |
| Focus           | 1                                                     |
| Status          | 5                                                     |
| Activity        | 5                                                     |
| Overlay         | 10 (base + 5 ladder + hover/active/selected/elevated) |
| Filter-selected | 2                                                     |
| Wash            | 3                                                     |
| Scrim           | 5 (3 colors + 2 blur depths)                          |
| Shadow          | 4 (color + ambient + floating + dialog)               |
| Tint            | 1                                                     |
| Material/Radius | 4                                                     |
| PR state        | 4                                                     |
| Search          | 6                                                     |
| Terminal        | 22 (6 base + 16 ANSI)                                 |
| Syntax          | 10                                                    |
| Category        | 12                                                    |
| UI Utility      | 15                                                    |
| Form            | 2 (knob-base + state-modified)                        |
| Diff            | 8                                                     |
| **Total**       | **150**                                               |

## Tailwind Consumption

Components use semantic Tailwind classes generated from CSS variables:

```
bg-surface-panel        text-text-primary       border-border-default
bg-accent-primary       text-accent-foreground   ring-focus-ring
bg-search-highlight-background                   text-status-warning
bg-terminal-background  text-terminal-foreground
bg-activity-working     text-category-blue
```

No component should reference hex values or know which theme is active.
