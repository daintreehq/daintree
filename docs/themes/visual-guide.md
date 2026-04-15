# Daintree Visual Design Guide

This document paints a complete mental picture of every surface, component, and interaction in the Daintree app, explaining exactly how theme tokens map to what the user sees. Use this to evaluate theme designs without running the app.

---

## 1. The Big Picture: App Shell

Daintree is a full-screen Electron IDE that fills the entire window. The layout is a vertical stack:

```
+------------------------------------------------------------------+
|  TOOLBAR (48px)                                                   |
+------------+-----------------------------------------------------+
|            |                                                      |
|  SIDEBAR   |              CONTENT GRID                            |
|  (350px)   |              (remaining width)                       |
|            |                                                      |
|            |  +----------+  +----------+  +----------+            |
|            |  | PANEL 1  |  | PANEL 2  |  | PANEL 3  |            |
|            |  |          |  |          |  |          |            |
|            |  +----------+  +----------+  +----------+            |
|            |                                                      |
|            |  +----------+  +----------+                          |
|            |  | PANEL 4  |  | PANEL 5  |                          |
|            |  |          |  |          |                          |
|            |  +----------+  +----------+                          |
|            |                                                      |
+------------+-----------------------------------------------------+
|  DOCK BAR (bottom)                                                |
+------------------------------------------------------------------+
```

The entire window uses `surface-canvas` as the base body color. This is the deepest, most neutral surface — the "wall" behind everything. On macOS, the top ~28px is the native title bar (draggable, with traffic light buttons on the left).

---

## 2. Toolbar

The toolbar is a 48px-tall strip across the top of the window. It sits on `surface-toolbar` — a derived color that blends between `surface-sidebar` and `surface-canvas`. This gives it a slightly different tint than either the sidebar or the main content area.

```
+------------------------------------------------------------------+
| [=] [S] | [Agent1] [Agent2] [+] |  [ProjectName ▸ branch]  | [Issues 3] [PRs 2] [Commits 5] | [icons...] |
+------------------------------------------------------------------+
```

### Toolbar Surfaces

The toolbar background uses a CSS fallback chain:

```css
.surface-toolbar {
  background: var(--toolbar-bg, var(--theme-surface-toolbar));
  background-image: var(--toolbar-noise, var(--chrome-noise-texture));
  backdrop-filter: blur(var(--theme-material-blur)) saturate(var(--theme-material-saturation));
}
```

Most themes use a solid color here. The Highlands theme adds a subtle SVG noise texture for a tactile feel. Themes with `materialBlur > 0` get a frosted glass effect where the toolbar is slightly translucent and blurs content beneath it.

A thin shadow or border separates the toolbar from the content below:

```css
box-shadow: var(--toolbar-shadow, var(--theme-shadow-ambient));
```

### Project Selector (Center)

The project selector is a pill-shaped button in the center of the toolbar. It displays the current project emoji, name, and active git branch.

```
[ :tree: MyProject  ▸ feat/new-feature ]
```

**In dark themes (Daintree gold standard):** The pill uses a flat translucent fill identical to the stats wrapper — `rgba(255,255,255,0.05)`. No gradient, no inset shadow. Minimal and clean. Border matches the stats: the theme's overlay tone at ~50% of the border color.

**In light themes (Bondi gold standard):** The pill uses a subtle gradient — slightly lighter at top, slightly darker at bottom, over a base that's close to the toolbar surface. This gives a barely perceptible "raised" quality.

The branch chip inside the pill is a small rounded-full badge:

```css
.toolbar-project-chip {
  background: var(--toolbar-project-chip-bg, var(--theme-overlay-hover));
  border: 1px solid var(--toolbar-project-chip-border, var(--theme-border-subtle));
  font-size: var(--toolbar-project-chip-size, 10px);
}
```

On hover, the entire pill gets a slightly elevated background and the text color intensifies.

### Stats Wrapper (Right of Center)

The stats wrapper displays GitHub issues, PRs, and commit counts as a segmented pill with dividers between each section.

```
[ Issues 3 | PRs 2 | Commits 5 ]
```

```css
.toolbar-stats {
  background: var(--toolbar-stats-bg, var(--theme-overlay-hover));
  border: 1px solid var(--toolbar-stats-border, var(--theme-border-subtle));
  box-shadow: var(--toolbar-stats-shadow, var(--theme-shadow-ambient));
}
```

Each segment is a clickable button with an icon and a count in tabular-nums font. The dividers between segments use:

```css
divide-x divide-[var(--toolbar-stats-divider)]
```

The overall pill has `rounded-[var(--toolbar-pill-radius, 0.5rem)]` corners, giving it a rounded rectangle shape.

### Toolbar Icon Buttons

To the right are icon buttons for notifications, settings, terminal problems, portal, and copy context. Each is a 32x32 hit target with:

```css
.toolbar-icon-button:hover {
  background: var(--toolbar-control-hover-bg, var(--theme-overlay-elevated));
  color: var(--toolbar-control-hover-fg, var(--theme-accent-primary));
}
```

On press (active state), buttons scale down to 98% for a tactile "click" feel.

### Toolbar Dividers

Thin vertical lines separate logical groups:

```css
.toolbar-divider {
  background: var(--toolbar-divider, var(--theme-border-divider));
}
```

These are typically 1px wide, the height of the toolbar content area, with low opacity.

---

## 3. Sidebar

The sidebar occupies the left 350px of the window (resizable 200-600px). Its background uses `.surface-chrome`:

```css
.surface-chrome {
  background: var(--chrome-bg, color-mix(in oklab, var(--theme-surface-sidebar) 95%, transparent));
  background-image: var(--chrome-noise, var(--chrome-noise-texture));
  box-shadow: var(--chrome-shadow, inset 0 1px 0 var(--theme-overlay-soft));
  backdrop-filter: blur(var(--theme-material-blur)) saturate(var(--theme-material-saturation));
}
```

This makes the sidebar sit at the `surface-sidebar` depth — slightly lighter than the grid in dark themes, slightly darker in light themes. The inset shadow creates a subtle highlight along the top edge.

A 1px border on the right edge separates it from the content grid:

```
border-right: 1px solid var(--theme-border-default)
```

### Worktree Cards

The sidebar contains a scrollable list of worktree cards. Each card represents a git worktree (branch) with its agent status.

**Default state:** Cards have no explicit background — they inherit the sidebar surface.

**Hover state:**

```css
.sidebar-worktree-card[data-hoverable="true"]:hover {
  background: var(--sidebar-hover-bg, var(--theme-overlay-hover));
}
```

A very subtle tint appears on hover — in dark themes this is ~3% white, in light themes ~2% black.

**Active/selected state:**

```css
.sidebar-worktree-card[data-active="true"] {
  background: var(--sidebar-active-bg, var(--theme-overlay-selected));
  box-shadow: var(--sidebar-active-shadow, var(--theme-shadow-ambient));
}
```

**In Bondi (light gold standard):** The active card uses `#FDFDFE` (nearly white) with a subtle `0 1px 3px rgba(0,0,0,0.05)` shadow. This makes the selected card appear to "lift" above the sidebar surface — a light card on a slightly darker sidebar.

**In Daintree (dark gold standard):** The active card uses `rgba(255,255,255,0.04)` — a barely-there brightness increase. No dramatic shadow.

Each worktree card shows:

- **Branch name** in `text-primary` (bold)
- **Agent status chip** — a small colored pill using `activity-*` tokens
- **Path/description** in `text-secondary`
- **Action buttons** (visible on hover) with `sidebar-action-hover-bg`

### Agent Status Chips

Status chips are small rounded pills that show the real-time state of an AI agent:

```
[Working]  [Idle]  [Waiting]  [Approval]
```

Their background uses the activity color at the theme's `state-chip-bg-opacity` (dark: 15%, light: 12%):

```css
background: rgba(var(--activity-color-rgb), var(--state-chip-bg-opacity));
border: 1px solid rgba(var(--activity-color-rgb), var(--state-chip-border-opacity));
```

Colors:

- **Working/Active:** `activity-working` (typically green) — pulsing animation
- **Idle:** `activity-idle` (gray/muted) — static
- **Waiting:** `activity-waiting` (amber/yellow) — needs user input
- **Completed:** `activity-completed` (defaults to `status-success`)
- **Failed:** `activity-failed` (defaults to `status-danger`)

### Resize Handle

Between the sidebar and content grid, there's a draggable resize handle:

```
| (drag handle: 3px wide, visible on hover as a 2px rounded bar)
```

The handle is nearly invisible by default (`text-daintree-text/20`), brightens on hover (`/35`), and turns accent-colored when actively dragging.

---

## 4. Content Grid

The content grid fills the remaining space to the right of the sidebar. Its background is `surface-grid` — the darkest surface tier in dark themes, the lightest gray base in light themes.

However, the empty grid area (when no panels are open) uses a special override:

```css
--color-grid-bg: var(--panel-grid-bg, var(--terminal-grid-bg, var(--theme-surface-grid)));
```

Themes can set `panel-grid-bg` to make the empty grid lighter than the structural grid surface. **Bondi sets this to `#FBFCFD`** — nearly white, so the empty state feels bright and airy rather than gray. All light themes now have this extension. The legacy `terminal-grid-bg` variable is still supported as a fallback for custom themes.

### Panel Arrangement

Panels are arranged in a CSS Grid with configurable columns and an 8px gap between them:

```css
gap: var(--grid-gap, 8px);
```

The gap area shows the grid background color. In dark themes, this creates dark "gutters" between panels. In light themes with `panel-grid-bg` overrides, these gutters are very light.

### Empty State

When no panels are open, the grid shows a welcome/dashboard view:

```
+-----------------------------------------------+
|                                                |
|   :leaves: Daintree                              |
|   Ready to work on [ProjectName]               |
|                                                |
|   +--Project Pulse Card--+                     |
|   |  Heatmap  |  Stats   |                     |
|   +-----------+----------+                     |
|                                                |
|   Quick Actions:                               |
|   [Explain Project] [What's Next]              |
|   [Terminal]        [Browser]                  |
|                                                |
+-----------------------------------------------+
```

Quick action buttons use `accent-primary` for the background and `accent-foreground` for text.

---

## 5. Individual Panels

Each panel is a rounded rectangle with its own chrome:

```css
background: var(--color-surface); /* = surface-panel */
border: 1px solid var(--theme-border-default);
border-radius: var(--radius-md);
box-shadow: var(--theme-shadow-ambient);
```

### Panel Header

The top of each panel has a header bar (~36px tall) with:

```
[ :grip: | Tab1 | Tab2 | + ]                    [ State ] [ :maximize: ] [ :x: ]
```

- **Drag handle:** A `GripVertical` icon for reordering panels in the grid
- **Tabs:** Horizontally draggable tab buttons for multi-terminal panels
- **Active tab indicator:** A colored bottom border using `accent-primary`
- **State indicator:** Shows agent activity state (working/waiting/idle)
- **Action buttons:** Maximize, restart, options menu, close

The header uses a subtle bottom border:

```css
border-bottom: 1px solid var(--theme-border-divider);
```

### Panel State Edge

Light themes show a colored left-edge rail on panels to indicate agent state:

```css
width: var(--panel-state-edge-width); /* 2px light, 0px dark */
inset-block: var(--panel-state-edge-inset-block); /* 4px */
border-radius: var(--panel-state-edge-radius); /* 2px */
```

This creates a thin colored bar on the left side of the panel header. The color matches the agent's activity state. Dark themes disable this (`width: 0px`).

### Panel Focus State

When a panel is focused (clicked/selected), it may show a highlighted border:

```css
border-color: var(--theme-accent-primary);
```

This is controlled by the `showGridAgentHighlights` preference.

### Terminal Content

Inside the panel, terminal content is rendered by xterm.js using terminal-specific tokens:

- **Background:** `terminal-background` — independent of the workbench. Light themes like Bondi use a dark terminal (`#1E252E`) inside a bright workbench.
- **Text:** `terminal-foreground` (`#C8D0D9` in Bondi)
- **ANSI colors:** 16 colors (`terminal-red` through `terminal-bright-white`) for syntax-colored output
- **Cursor:** `terminal-cursor` — often accent or yellow
- **Selection:** `terminal-selection` — a semi-transparent highlight

The terminal palette is completely independent from the workbench surface hierarchy. This is by design — terminals have their own visual world.

---

## 6. Dock Bar

The dock sits at the very bottom of the window. It's a horizontal bar showing minimized/backgrounded panels as compact tabs.

```
+------------------------------------------------------------------+
| [Agent1: working] [Agent2: idle] [Browser] | [waiting] | [bg]    |
+------------------------------------------------------------------+
```

```css
background: var(--dock-bg, var(--color-daintree-sidebar));
border-top: 1px solid var(--dock-border);
box-shadow: var(--dock-shadow);
```

**In Bondi:** The dock bg is `#F0F1F4` (matching the toolbar surface), with a subtle upward shadow: `0 -1px 4px rgba(0,0,0,0.04)`.

**In Daintree:** The dock inherits the sidebar color.

### Dock Items

Each dock item is a small button:

```css
height: var(--dock-item-height, 2rem);
background: var(--dock-item-bg);
border: 1px solid var(--dock-item-border);
```

**Active item** (currently selected panel):

```css
background: var(--dock-item-bg-active); /* accent-primary at 12% */
border-color: var(--dock-item-border-active); /* accent-rgb at 32% */
```

**Failed item:**

```css
background: var(--dock-item-bg-failed); /* status-danger at 8% */
border-color: var(--dock-item-border-failed); /* status-danger at 40% */
```

Dock items expand into popovers on click, showing a preview of the panel content above the dock.

---

## 7. Floating Surfaces: Dropdowns, Popovers, Context Menus

All floating surfaces (dropdowns, popovers, tooltips, context menus) use the `.surface-overlay` utility class:

```css
.surface-overlay {
  background-color: color-mix(in oklab, var(--color-surface-sidebar) 94%, transparent);
  border: 1px solid var(--border-overlay);
  backdrop-filter: blur(var(--theme-material-blur)) saturate(var(--theme-material-saturation));
}
```

When `material-blur` is 0 (most themes), this is just a solid sidebar-colored surface. When blur is active (e.g., `materialBlur: 12`), it creates a frosted glass effect where the surface is 90% opaque and blurs the content behind it.

Shadows on floating surfaces:

```css
box-shadow: var(--shadow-floating);
/* or for dialogs: */
box-shadow: var(--shadow-dialog);
```

The shadow profiles are theme-controlled:

- **"crisp" (Bondi, Daintree):** Tight shadows close to the element: `0 4px 8px rgba(0,0,0,0.3)`
- **"soft" (default dark):** Medium-depth: `0 4px 12px rgba(0,0,0,0.12)`
- **"atmospheric" (Highlands, Redwoods, Bali, Svalbard):** Wide, diffused: `0 14px 40px rgba(0,0,0,0.25)`
- **"none":** No shadows, elevation only via borders

### Animation

Floating surfaces animate in/out:

- **Enter:** 200ms, spring-like easing, `opacity: 0 -> 1`, `translateY: -2px -> 0`, `scale: 0.99 -> 1`
- **Exit:** 120ms, ease-out, reverse

---

## 8. Dialogs (Settings, Modals)

Dialogs are centered modals that appear over a scrim backdrop:

```css
/* Scrim backdrop */
background: var(--theme-scrim-medium); /* dark: rgba(0,0,0,0.45), light: rgba(0,0,0,0.50) */
backdrop-filter: blur(4px);
```

The dialog surface itself:

```css
.themed-dialog-surface {
  background: var(--dialog-bg, var(--theme-surface-panel-elevated));
  box-shadow: var(--dialog-shadow, var(--theme-shadow-dialog));
}
```

### Settings Dialog Structure

The settings dialog is split into two panes:

```
+-------------------------------------------+
|  Settings                          [ X ]  |
+--------+----------------------------------+
| Search |  :icon: General                  |
+--------+----------------------------------+
| General|  [Overview] [Hibernation] [Disp] |
| Appear |  --------------------------------|
| Keybd  |                                  |
| Notifs |  Setting cards and controls      |
| Privacy|  go in this main content area    |
|--------|                                  |
| Panel  |  Each card uses:                 |
| Wktree |  bg: settings-card-bg            |
| Toolbar|  border: 1px daintree-border       |
| Environ|  rounded corners                 |
|--------|                                  |
| CLI    |                                  |
| GitHub |                                  |
| Editor |                                  |
+--------+----------------------------------+
```

**Left sidebar** (`settings-sidebar`):

```css
background: var(
  --settings-sidebar-bg,
  color-mix(in oklch, var(--theme-surface-canvas) 50%, transparent)
);
```

In Bondi: `rgba(248,249,251,0.50)` — a semi-transparent light wash.

**Main content body** (`settings-shell`):

```css
background: var(--settings-dialog-bg, var(--theme-surface-panel));
```

In Bondi: `#FCFCFD` — very close to white, making the settings feel open and airy.

**Header bar** (`dialog-header`):

```css
background: var(
  --dialog-header-bg,
  color-mix(in oklch, var(--theme-surface-sidebar) 50%, transparent)
);
```

A semi-transparent tinted bar showing the current section title and close button.

### Settings Navigation Items

Left sidebar nav items are vertical buttons:

**Default:** `text-secondary` with the icon

**Hover:**

```css
background: var(--settings-nav-hover-bg, var(--theme-overlay-hover));
```

**Active (selected):**

```css
background: var(--settings-nav-active-bg, var(--theme-overlay-selected));
box-shadow: var(--settings-nav-active-shadow, none);
```

The active nav item also shows a 2px-wide accent-colored bar on its left edge via a CSS `::before` pseudo-element. The text switches to `text-primary` weight.

### Settings Subtabs

Within some settings sections (e.g., General has Overview/Hibernation/Display), there's a horizontal subtab bar:

```
[Overview]  [Hibernation]  [Display]
  ________
```

The active subtab shows a 2px `accent-primary` colored line along the bottom:

```css
isactive?"border-b-2 border-daintree-accent text-daintree-text": "border-b-2 border-transparent text-text-secondary";
```

Inactive tabs have a transparent bottom border (same 2px so layout doesn't shift) and use `text-secondary`. On hover, inactive tabs show `border-daintree-border` (a subtle gray line).

### Settings Cards

Individual settings are grouped in cards:

```css
.settings-card {
  background: var(--settings-card-bg, var(--theme-surface-panel));
}
```

In Bondi: `#FEFEFE` — nearly pure white cards on the slightly off-white dialog body.

### Keyboard Shortcut Badges

Key badges in the settings:

```css
.settings-kbd {
  background: var(--settings-kbd-bg, var(--theme-surface-input));
  border: 1px solid var(--settings-kbd-border, var(--theme-border-default));
}
```

Small rounded rectangles showing key combinations like `Cmd+K`.

---

## 9. Project Pulse

Project Pulse is an activity dashboard that appears in the grid empty state and can be toggled. It shows a heatmap of recent activity and summary statistics.

```
+----------------------------------------+
|  Project Pulse              [< >] [~]  |
|                                        |
|  Mon  [][][][][][][][] ... [][][]      |
|  Tue  [][][][][][][][] ... [][][]      |
|  Wed  [][][][][][][][] ... [][][]      |
|  ...                                   |
|                                        |
|  [Working: 3] [Idle: 5] [Failed: 1]   |
+----------------------------------------+
```

### Pulse Card Surface

```css
.pulse-card {
  background: var(--pulse-card-bg, var(--theme-surface-panel-elevated));
  box-shadow: var(--pulse-card-shadow, var(--theme-shadow-ambient));
}
```

In Bondi: `#FDFDFE` with `0 1px 3px rgba(0,0,0,0.06)` — a white card with a barely-there shadow.

### Heatmap Cells

The heatmap shows rectangular cells for each day. Color intensity represents activity level:

- **Empty (no activity):** `pulse-empty-bg` (defaults to `surface-panel`)
- **Before range (future):** `pulse-before-bg` (defaults to `surface-sidebar`)
- **Missed (failed):** `pulse-missed-bg` (defaults to `status-danger` at 18%)
- **Low activity:** `accent-primary` at `pulse-heat-low-opacity` (14%)
- **Medium activity:** `accent-primary` at `pulse-heat-medium-opacity` (30%)
- **High activity:** `accent-primary` at `pulse-heat-high-opacity` (50%)

### Range Selector

```css
.pulse-range {
  background: var(--pulse-range-bg, var(--theme-surface-canvas));
}
```

Navigation controls (previous/next period):

```css
.pulse-control:hover {
  background: var(--pulse-control-hover-bg, var(--theme-overlay-hover));
}
```

### Loading Skeleton

While data loads, a shimmer animation plays:

```css
.pulse-skeleton-shimmer {
  background: var(--pulse-skeleton-gradient, linear-gradient(90deg, ...));
  animation: shimmer 1.5s infinite;
}
```

The gradient uses theme colors to create a smooth left-to-right sweep.

### Ring Offset

The agent status indicators in Pulse use a ring with an offset matching the card:

```css
--pulse-ring-offset: var(--theme-surface-panel-elevated);
```

This ensures the ring's gap color matches the card background.

---

## 10. Overlay Ladder: Interactive States

One of the most pervasive token systems is the **overlay ladder** — a set of semi-transparent fills used for hover, active, selected, and elevated states throughout the entire app.

The ladder is driven by `overlay-base` — a tint color that defaults to white (dark themes) or black (light themes). Themes can set this to a hued color for character. For example:

- **Fiordland:** `overlay-base: #B4DCF0` (icy blue) — all hovers have a cold blue tint
- **Arashiyama:** `overlay-base: #FFECD6` (warm cream) — all hovers feel warm
- **Serengeti:** `overlay-base: #2C210F` (dark amber) — warm earth tones

The ladder steps:

```
overlay-subtle (2%)  →  overlay-soft (3%)  →  overlay-medium (4-5%)
overlay-strong (6-8%)  →  overlay-emphasis (10-12%)
```

Plus semantic states that use the neutral tint (not the hued base):

```
overlay-hover (3-5%)  →  overlay-active (6-8%)
overlay-selected (4-5%)  →  overlay-elevated (6-8%)
```

These are used everywhere: list items on hover, selected sidebar cards, button backgrounds, table rows, dropdown items — any interactive element that needs a fill state.

### Atmospheric Wash

A lighter variant for broader backgrounds:

```
wash-subtle (2%)  →  wash-medium (4%)  →  wash-strong (8%)
```

Washes use the `overlay-base` tint color. They're used for toolbar project pill backgrounds, subtle section tints, and decorative fills.

---

## 11. Borders

Borders use a 5-tier system from nearly invisible to prominent:

| Token                | Opacity (Dark) | Opacity (Light) | Usage                                                   |
| -------------------- | -------------- | --------------- | ------------------------------------------------------- |
| `border-divider`     | white 5%       | black 4%        | Structural separators (toolbar sections, dock sections) |
| `border-subtle`      | white 8%       | black 5%        | Panel-internal dividers, card borders                   |
| `border-default`     | solid hex      | solid hex       | Primary borders on cards, inputs, panels                |
| `border-strong`      | white 14%      | black 14%       | Focused elements, emphasized containers                 |
| `border-interactive` | white 20%      | black 10%       | Hovered inputs, interactive element borders             |

**Polarity pattern:** Dark themes use white-alpha borders (they lighten). Light themes use black-alpha borders (they darken). This ensures borders are always visible as a step darker/lighter than their surface.

---

## 12. Shadows

Shadows have four tiers:

| Token             | Usage                                  | Character                                              |
| ----------------- | -------------------------------------- | ------------------------------------------------------ |
| `shadow-ambient`  | Cards, panels, pills, subtle elevation | Barely there — just enough to separate from background |
| `shadow-floating` | Dropdowns, popovers, tooltips          | Moderate depth — element clearly floats above content  |
| `shadow-dialog`   | Modal dialogs, palettes                | Maximum depth — element is the topmost layer           |
| `shadow-color`    | Base color for all composite shadows   | Single color input, opacity varied per depth           |

The `strategy.shadowStyle` in the palette controls all three profiles at once:

- **"none"**: All shadows disabled, borders provide depth cues
- **"crisp"**: Tight, close: `0 1px 2px` / `0 4px 8px` / `0 8px 16px`
- **"soft"** (default dark): Medium: `0 2px 8px` / `0 4px 12px` / `0 12px 32px`
- **"atmospheric"**: Wide, foggy: `0 4px 16px` / `0 14px 40px` / `0 20px 56px`

---

## 13. Text Hierarchy

| Token              | Weight        | Usage                                                           |
| ------------------ | ------------- | --------------------------------------------------------------- |
| `text-primary`     | Bold/semibold | Headings, panel titles, active labels, primary content          |
| `text-secondary`   | Regular       | Descriptions, inactive tabs, metadata, subtitles                |
| `text-muted`       | Regular       | Timestamps, disabled text, helper text (may fall below WCAG AA) |
| `text-placeholder` | Regular       | Input placeholder text (derived: primary at 32-35%)             |
| `text-inverse`     | Bold/regular  | Text on accent-colored backgrounds (buttons, badges)            |
| `text-link`        | Regular       | Hyperlinks (defaults to accent-primary)                         |

---

## 14. Accent Colors

The accent is the primary brand/interaction color. It's used for:

- **Buttons:** `accent-primary` background with `accent-foreground` text
- **Focus rings:** `focus-ring` (often derived from accent)
- **Active indicators:** Subtab underlines, nav item left bars
- **Links:** `text-link` defaults to accent
- **Soft fills:** `accent-soft` (12-18% opacity) for subtle tinted backgrounds
- **Medium fills:** `accent-muted` (20-30% opacity) for stronger tinted backgrounds

Some themes have a **secondary accent** — a second color lane:

- **Bali:** Primary green `#228243`, secondary sage `#6B8F71`
- **Table Mountain:** Primary pink `#A8456E`, secondary fynbos green `#6B8F71`
- **Serengeti:** Primary gold `#A28224`, secondary also gold (single-accent theme)

---

## 15. Status Colors

Four fixed hue families, each theme tunes brightness/saturation:

| Token            | Hue   | Usage                                                |
| ---------------- | ----- | ---------------------------------------------------- |
| `status-success` | Green | Completed states, positive outcomes, git additions   |
| `status-warning` | Amber | Caution states, pending items                        |
| `status-danger`  | Red   | Errors, failures, destructive actions, git deletions |
| `status-info`    | Blue  | Neutral information, help text                       |

These are used in badges, toast notifications, diff viewer gutters, and terminal ANSI color fallbacks.

---

## 16. GitHub Integration Colors

```
[Open]    → github-open (green)
[Merged]  → github-merged (purple)
[Closed]  → github-closed (red)
[Draft]   → github-draft (gray)
```

Dark themes use GitHub's dark-mode palette; light themes use GitHub's light-mode palette. Each theme can override these individually.

---

## 17. Search Highlighting

When searching in settings, file viewers, or panels:

```css
background: var(--search-highlight-background); /* accent at 12-20% */
color: var(--search-highlight-text); /* often status-success or a blue */
```

The selected search result row:

```css
border: 1px solid var(--search-selected-result-border);
```

Match count badges:

```css
background: var(--search-match-badge-background);
color: var(--search-match-badge-text);
```

Search highlighting is **independent of accent** — Bondi uses blue search (`#2B6CA8`) with green accent (`#145A44`). This allows themes where the accent hue wouldn't work as a text highlighter.

---

## 18. Category Colors (Entity Labeling)

12 perceptually uniform hues for labeling branches, worktrees, and organizational tags:

```
blue, purple, cyan, green, amber, orange, teal, indigo, rose, pink, violet, slate
```

Each generates 3 composite variants via `color-mix`:

- **`-subtle` (12%):** Light wash background for badges
- **`-text` (85%):** Readable colored text on any surface
- **`-border` (28%):** Subtle colored border

Dark themes use higher lightness (~0.70 oklch), light themes use lower (~0.55 oklch) to maintain contrast.

---

## 19. Diff Viewer

The diff viewer uses dedicated tokens for insert/delete coloring:

| Token                         | Purpose                                  |
| ----------------------------- | ---------------------------------------- |
| `diff-insert-background`      | Green-tinted line background (10-18%)    |
| `diff-insert-edit-background` | Stronger green for inline edits (20-28%) |
| `diff-delete-background`      | Red-tinted line background (10-18%)      |
| `diff-delete-edit-background` | Stronger red for inline edits (20-28%)   |
| `diff-gutter-insert`          | Green gutter indicator                   |
| `diff-gutter-delete`          | Red gutter indicator                     |
| `diff-selected-background`    | Blue/neutral tint for selected line      |

---

## 20. Scrollbars

Custom styled scrollbars using theme tokens:

```css
width: var(--scrollbar-width, 6px);
thumb color: var(--scrollbar-thumb);  /* usually activity-idle */
thumb hover: var(--scrollbar-thumb-hover);  /* idle mixed with text-primary */
track: var(--scrollbar-track, transparent);
```

Scrollbars are slim (6px) and unobtrusive, using the muted/idle color so they blend into the chrome.

---

## 21. Material Effects

Three strategy tokens control frosted glass and texture effects:

| Token                 | Effect                                                        |
| --------------------- | ------------------------------------------------------------- |
| `material-blur`       | Backdrop blur in px (0 = disabled, 12 = glass effect)         |
| `material-saturation` | Backdrop saturation boost (100% = no change, 120% = vivid)    |
| `material-opacity`    | Surface opacity when blur active (0.9 = slightly transparent) |

When enabled, surfaces like the toolbar, sidebar, and floating overlays become semi-transparent and blur the content behind them. Most themes keep `material-blur: 0` for solid surfaces.

The `chrome-noise-texture` token adds an SVG-based grain overlay to chrome surfaces (toolbar, sidebar). Only Highlands uses this — a subtle 1.5% opacity fractal noise that adds tactile character.

---

## 22. Border Radius

All radii are derived from a base value scaled by `radius-scale`:

```css
--radius: calc(0.625rem * var(--theme-radius-scale, 1));
```

Tiers:

- `radius-xs`: 1px (tiny badges)
- `radius-sm`: 3px (small chips)
- `radius-md`: 7px (buttons, inputs, cards)
- `radius-lg`: 10px (panels, dialogs)
- `radius-xl`: 17px (large containers)

---

## 23. Z-Index Stacking

Seven managed tiers prevent z-fighting:

| Layer         | Z-Index | Elements                            |
| ------------- | ------- | ----------------------------------- |
| Panel         | 40      | Dock, sidebar chrome                |
| Portal        | 50      | Portal overlay panel                |
| Maximized     | 55      | Maximized panel content             |
| Modal         | 60      | Dialogs, settings, palettes         |
| Popover       | 70      | Dropdowns, tooltips, context menus  |
| Nested Dialog | 75      | Dialogs opened from within popovers |
| Toast         | 80      | Notification toasts                 |

---

## 24. Scrim (Modal Backdrops)

When a dialog opens, a scrim covers the entire window:

| Token          | Dark             | Light            | Feel                                  |
| -------------- | ---------------- | ---------------- | ------------------------------------- |
| `scrim-soft`   | rgba(0,0,0,0.20) | rgba(0,0,0,0.30) | Subtle dimming, content still visible |
| `scrim-medium` | rgba(0,0,0,0.45) | rgba(0,0,0,0.50) | Standard modal backdrop               |
| `scrim-strong` | rgba(0,0,0,0.62) | rgba(0,0,0,0.70) | Heavy dimming, content barely visible |

Most dialogs use `scrim-medium` with a slight `backdrop-filter: blur(4px)`.

---

## 25. Animation & Motion

All transitions use consistent timing:

- **Default duration:** 150ms
- **Easing:** `cubic-bezier(0.4, 0, 0.2, 1)` (ease-in-out)
- **Button press:** `scale(0.98)` with 150ms
- **Dialog enter:** 200ms with spring-like easing
- **Dialog exit:** 120ms ease-out
- **Panel minimize:** 120ms `cubic-bezier(0.3, 0, 0.8, 0.15)`
- **Panel restore:** 200ms `cubic-bezier(0.16, 1, 0.3, 1)`

Performance mode (`data-performance-mode="true"`) disables all animations, backdrop filters, and transitions for maximum responsiveness.

---

## 26. Color Vision Deficiency Support

The app supports three modes via `applyColorVisionMode()`:

- **Default:** Standard theme colors
- **Red-green (protanopia/deuteranopia):** Replaces red/green with orange/blue alternatives
- **Blue-yellow (tritanopia):** Replaces blue/yellow with vermillion/sky alternatives

These override 19 specific tokens (status, activity, GitHub, diff colors) with science-based replacements that maintain perceptual distinguishability.

---

## 27. Theme Character Summary

Each theme creates a distinct atmosphere through the combination of surface tints, shadow style, overlay tinting, and accent colors:

**Dark themes:**

- **Daintree** (gold standard): Nearly neutral dark surfaces with green accent. Crisp shadows. Clean and professional.
- **Arashiyama:** Warm amber/brown surfaces (bamboo). Cream-tinted overlays. Earthy and organic.
- **Fiordland:** Deep blue surfaces (fjord water). Icy blue overlays. Cool and focused.
- **Galapagos:** Dark teal/green surfaces (volcanic island). Green-tinted overlays. Natural and rich.
- **Highlands:** Purple/heather surfaces. Atmospheric fog shadows. SVG noise texture. Moody and textured.
- **Namib:** Warm ochre/sand surfaces. Sandy-tinted overlays. Minimal opacity values. Quiet and vast.
- **Redwoods:** Deep warm brown (forest floor). Earth-tinted overlays. Atmospheric shadows. Dense and enveloping.

**Light themes:**

- **Bondi** (gold standard): Nearly white surfaces with subtle blue tint. Green accent. Crisp shadows. Bright and airy.
- **Table Mountain:** Warm sandstone tint. Pink accent with fynbos green secondary. Earthy warmth.
- **Atacama:** Warm mineral/sand tint. Teal accent. Crisp shadows. Arid clarity.
- **Bali:** Green-tinted surfaces (rice terraces). Green accent. Atmospheric shadows. Tropical and lush.
- **Hokkaido:** Lavender/purple tint (lavender fields). Indigo accent. Ethereal and crisp.
- **Serengeti:** Golden/warm surfaces (savanna). Gold accent. Rich warmth.
- **Svalbard:** Blue-gray surfaces (arctic ice). Blue accent. Atmospheric shadows. Clean and frozen.
