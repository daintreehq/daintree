# Theme Token Reference

Complete reference for Daintree's semantic token system. Every built-in and custom theme must provide values for all tokens. The `createDaintreeTokens()` helper derives sensible defaults for most tokens from a smaller set of required palette values.

## Token Layers

| Layer    | Prefix                                               | Purpose                                                                          |
| -------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| Surface  | `surface-*`                                          | Depth hierarchy and interactive surfaces                                         |
| Text     | `text-*`                                             | Typography color hierarchy                                                       |
| Border   | `border-*`                                           | Edge and divider treatments                                                      |
| Accent   | `accent-*`                                           | Primary and optional secondary interaction color                                 |
| Status   | `status-*`                                           | Semantic outcome colors                                                          |
| Activity | `activity-*`                                         | Real-time agent state indicators                                                 |
| Overlay  | `overlay-*`                                          | Interactive state tinting ladder                                                 |
| Wash     | `wash-*`                                             | Atmospheric tinted fills                                                         |
| Scrim    | `scrim-*`                                            | Modal backdrop dimming                                                           |
| Shadow   | `shadow-*`                                           | Elevation shadow profiles                                                        |
| Material | `material-*`                                         | Backdrop blur/saturation strategy                                                |
| GitHub   | `github-*`                                           | PR/issue state colors                                                            |
| Search   | `search-*`                                           | Search highlighting (independent of accent)                                      |
| Terminal | `terminal-*`                                         | Terminal emulator layer (independent of workbench)                               |
| Syntax   | `syntax-*`                                           | Code editor token colors                                                         |
| Category | `category-*`                                         | 12 organizational label hues                                                     |
| Diff     | `diff-*`                                             | Diff viewer insert/delete/gutter colors                                          |
| Utility  | (various)                                            | Scrollbar, panel edge, focus ring, chrome noise, state chip/label pill opacities |
| Shared   | `focus-ring`, `shadow-color`, `tint`, `radius-scale` | Cross-cutting single tokens                                                      |

## Surface Tokens

Five-level depth hierarchy plus semantic interactive surfaces.

| Token                    | Purpose                                | Derived?                                           |
| ------------------------ | -------------------------------------- | -------------------------------------------------- |
| `surface-grid`           | Deepest recess — panel grid background | Required                                           |
| `surface-sidebar`        | Sidebar, toolbar, dock chrome          | Required                                           |
| `surface-canvas`         | Main app background (`<body>`)         | Required                                           |
| `surface-panel`          | Panel chrome, dropdowns, dialogs       | Required                                           |
| `surface-panel-elevated` | Focused panel, tooltips                | Required                                           |
| `surface-toolbar`        | Toolbar surface                        | Derived: `color-mix(sidebar, canvas)`              |
| `surface-input`          | Text input backgrounds                 | Derived: `panel-elevated` (dark) / `panel` (light) |
| `surface-inset`          | Recessed content within panels         | Derived: `tint` 3-4%                               |
| `surface-hover`          | Hover overlay on interactive elements  | Derived: `tint` 3-5%                               |
| `surface-active`         | Active/pressed overlay                 | Derived: `tint` 6-8%                               |

**Design rule:** Adjacent surface pairs must have clear perceptual separation. Grid -> sidebar -> canvas -> panel -> elevated should read as a smooth depth ramp.

## Text Tokens

| Token              | Purpose                                            | Derived?                       |
| ------------------ | -------------------------------------------------- | ------------------------------ |
| `text-primary`     | Headings, active labels, focused content           | Required                       |
| `text-secondary`   | Descriptions, subtitles, inactive tabs             | Required                       |
| `text-muted`       | Disabled text, timestamps (may fall below WCAG AA) | Required                       |
| `text-placeholder` | Input placeholder text                             | Derived: `text-primary` 32-35% |
| `text-inverse`     | Text on solid accent/color backgrounds             | Required                       |
| `text-link`        | Hyperlink color                                    | Derived: `accent-primary`      |

## Border Tokens

| Token                | Purpose                             | Dark default | Light default |
| -------------------- | ----------------------------------- | ------------ | ------------- |
| `border-default`     | Card outlines, input borders        | Required     | Required      |
| `border-subtle`      | Panel-internal dividers             | `white 8%`   | `black 5%`    |
| `border-strong`      | Focused panel borders               | `white 14%`  | `black 14%`   |
| `border-divider`     | Structural separators               | `white 5%`   | `black 4%`    |
| `border-interactive` | Hovered/focused interactive borders | `white 20%`  | `black 10%`   |

**Polarity pattern:** Dark themes use white-alpha; light themes use black-alpha.

## Accent Tokens

| Token               | Purpose                                            | Derived?                                      |
| ------------------- | -------------------------------------------------- | --------------------------------------------- |
| `accent-primary`    | Solid accent — buttons, toggles, active indicators | Required                                      |
| `accent-hover`      | Hover state                                        | Derived: accent mixed 90% with polarity color |
| `accent-foreground` | Text on solid accent backgrounds                   | Derived: `text-inverse`                       |
| `accent-soft`       | Low-opacity tint (~12-18%)                         | Derived from accent-primary                   |
| `accent-muted`      | Medium-opacity tint (~20-30%)                      | Derived from accent-primary                   |
| `accent-rgb`        | Raw RGB triplet for `rgba()` usage                 | Derived from accent-primary                   |

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

| Token            | Hue family                     |
| ---------------- | ------------------------------ |
| `status-success` | Green — completed/ready states |
| `status-warning` | Amber — caution states         |
| `status-danger`  | Red — error/destructive states |
| `status-info`    | Blue — neutral informational   |

## Activity Tokens

Drive state chips in panel headers and worktree card indicators.

| Token                | Purpose                              | Derived?                  |
| -------------------- | ------------------------------------ | ------------------------- |
| `activity-active`    | Real-time working indicator (vivid)  | Required                  |
| `activity-working`   | Animated spinner color               | Required                  |
| `activity-waiting`   | Agent waiting for user input (amber) | Required                  |
| `activity-idle`      | Inactive/dormant state               | Required                  |
| `activity-completed` | Finished successfully                | Derived: `status-success` |
| `activity-failed`    | Finished with error                  | Derived: `status-danger`  |

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

Set `overlay-base` to a hued color to tint all hover and fill states (e.g. Fiordland: icy blue `#B4DCF0`, Arashiyama: warm cream `#FFECE6`).

## Wash Tokens

Atmospheric tinted fills using `overlay-base`:

| Token         | Opacity |
| ------------- | ------- |
| `wash-subtle` | 2%      |
| `wash-medium` | 4%      |
| `wash-strong` | 8%      |

## Scrim Tokens

| Token          | Dark default       | Light default     |
| -------------- | ------------------ | ----------------- |
| `scrim-soft`   | `rgba(0,0,0,0.2)`  | `rgba(0,0,0,0.3)` |
| `scrim-medium` | `rgba(0,0,0,0.45)` | `rgba(0,0,0,0.5)` |
| `scrim-strong` | `rgba(0,0,0,0.62)` | `rgba(0,0,0,0.7)` |

## Shadow Tokens

| Token             | Dark default                                            | Light default                                             |
| ----------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| `shadow-color`    | `rgba(0,0,0,0.5)`                                       | `rgba(0,0,0,0.12)`                                        |
| `shadow-ambient`  | `0 1px 3px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2)`  | `0 2px 8px rgba(0,0,0,0.06)`                              |
| `shadow-floating` | `0 4px 12px rgba(0,0,0,0.5), 0 1px 3px rgba(0,0,0,0.3)` | `0 4px 12px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.08)` |
| `shadow-dialog`   | Defaults to `shadow-floating`                           | Defaults to `shadow-floating`                             |

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

## GitHub Tokens

| Token           | Purpose                   |
| --------------- | ------------------------- |
| `github-open`   | Open issue/PR indicator   |
| `github-merged` | Merged PR indicator       |
| `github-closed` | Closed issue/PR indicator |
| `github-draft`  | Draft PR indicator        |

Dark themes use GitHub's dark-mode palette; light themes use GitHub's light-mode palette.

## Search Tokens

Search highlighting is independent of accent. Bondi uses blue (`#2B6CA8`) search while its accent is green (`#145A44`).

| Token                           | Purpose                               | Default                   |
| ------------------------------- | ------------------------------------- | ------------------------- |
| `search-highlight-background`   | `<mark>` background for matched text  | Derived from accent       |
| `search-highlight-text`         | Text color inside highlighted matches | Derived: `status-success` |
| `search-selected-result-border` | Border on selected search result row  | `accent-primary`          |
| `search-selected-result-icon`   | Icon color in selected result         | `accent-primary`          |
| `search-match-badge-background` | Match count badge background          | `accent-soft`             |
| `search-match-badge-text`       | Match count badge text                | `accent-primary`          |

Override when accent hue doesn't work as a text highlight.

## Terminal Tokens

Terminal is a first-class layer, independent of workbench. Light themes commonly use a dark terminal (e.g., Bondi: `#1E252E` terminal inside a light workbench).

| Token                                                 | Purpose                        | Derived?                                                        |
| ----------------------------------------------------- | ------------------------------ | --------------------------------------------------------------- |
| `terminal-background`                                 | Terminal emulator background   | Derived: `surface-canvas`                                       |
| `terminal-foreground`                                 | Default terminal text          | Derived: `text-primary`                                         |
| `terminal-muted`                                      | Dimmed terminal text           | Derived: `text-muted`                                           |
| `terminal-cursor`                                     | Cursor block color             | Derived: `accent-primary`                                       |
| `terminal-cursor-accent`                              | Text behind cursor             | Derived: `terminal-background`                                  |
| `terminal-selection`                                  | Selection highlight background | Required                                                        |
| `terminal-black`                                      | ANSI black                     | Derived: `surface-canvas` (dark) / `text-primary` (light)       |
| `terminal-red`                                        | ANSI red                       | Required                                                        |
| `terminal-green`                                      | ANSI green                     | Required                                                        |
| `terminal-yellow`                                     | ANSI yellow                    | Required                                                        |
| `terminal-blue`                                       | ANSI blue                      | Required                                                        |
| `terminal-magenta`                                    | ANSI magenta                   | Required                                                        |
| `terminal-cyan`                                       | ANSI cyan                      | Required                                                        |
| `terminal-white`                                      | ANSI white                     | Derived: `text-primary` (dark) / `surface-canvas` (light)       |
| `terminal-bright-black`                               | Bright black                   | Derived: `activity-idle`                                        |
| `terminal-bright-red` through `terminal-bright-white` | Bright ANSI colors             | Required (6) / Derived (bright-black, bright-white via palette) |

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

| Token                          | Purpose                            | Dark default                          | Light default   |
| ------------------------------ | ---------------------------------- | ------------------------------------- | --------------- |
| `state-chip-bg-opacity`        | State chip background fill         | `0.15`                                | `0.12`          |
| `state-chip-border-opacity`    | State chip border                  | `0.40`                                | `0.35`          |
| `label-pill-bg-opacity`        | GitHub label pill background       | `0.10`                                | `0.08`          |
| `label-pill-border-opacity`    | GitHub label pill border           | `0.20`                                | `0.15`          |
| `scrollbar-width`              | Scrollbar track width              | `6px`                                 | `6px`           |
| `scrollbar-thumb`              | Thumb color at rest                | `activity-idle`                       | `activity-idle` |
| `scrollbar-thumb-hover`        | Thumb color on hover               | Derived: idle mixed with text-primary | Same            |
| `scrollbar-track`              | Track background                   | `transparent`                         | `transparent`   |
| `panel-state-edge-width`       | Rail width (0px = disabled)        | `0px`                                 | `2px`           |
| `panel-state-edge-inset-block` | Vertical inset from panel edges    | `4px`                                 | `4px`           |
| `panel-state-edge-radius`      | Rail end-cap radius                | `2px`                                 | `2px`           |
| `focus-ring-offset`            | Offset between element and ring    | `2px`                                 | `2px`           |
| `chrome-noise-texture`         | CSS `background-image` grain layer | `none`                                | `none`          |

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

| Class                 | Description                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| **Required**          | Must be in the palette (surfaces, text, border, accent, status, activity, terminal ANSI, syntax) |
| **Optional override** | Can be supplied via `tokens`; falls back to a derived value if omitted                           |
| **Derived**           | Always computed from palette inputs; never authored directly                                     |

## Creating a New Theme

### 1. Define the palette

Create a new file in `shared/theme/builtInThemes/` exporting a `BuiltInThemeSource` with a complete `ThemePalette`:

- 5 surface tiers + text (primary/secondary/muted/inverse) + border
- accent + optional accentSecondary
- 4 status colors + 4 activity states
- terminal palette (selection + 12 ANSI colors + brightWhite required; background/foreground/muted/cursor optional with fallbacks)
- 10 syntax colors
- optional strategy (shadowStyle, materialBlur, materialSaturation, radiusScale, noiseOpacity, panelStateEdge)

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

Common extension families: `toolbar-*`, `sidebar-*`, `settings-*`, `pulse-*`, `dock-*`, `panel-grid-bg`, `worktree-section-hover-bg`.

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
| Surface         | 10                                                    |
| Text            | 6                                                     |
| Border          | 5                                                     |
| Accent          | 9 (6 primary + 3 secondary)                           |
| Focus           | 1                                                     |
| Status          | 4                                                     |
| Activity        | 7                                                     |
| Overlay         | 10 (base + 5 ladder + hover/active/selected/elevated) |
| Wash            | 3                                                     |
| Scrim           | 3                                                     |
| Shadow          | 4 (color + ambient + floating + dialog)               |
| Tint            | 1                                                     |
| Material/Radius | 4                                                     |
| GitHub          | 4                                                     |
| Search          | 6                                                     |
| Terminal        | 22 (6 base + 16 ANSI)                                 |
| Syntax          | 10                                                    |
| Category        | 12                                                    |
| Diff            | 8                                                     |
| UI Utility      | 13                                                    |
| **Total**       | **142**                                               |

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
