# Canonical Interaction State Recipes

This document maps each interactive component role to its canonical Tailwind class string. Use these patterns as a single reference point so new components converge on established treatments instead of inventing variations.

## Critical Rules

- **Never use `transition-all`** — forces Chromium to interpolate every computed property on every frame. Use specific transitions: `transition-colors`, `transition-opacity`, `transition-transform`, or explicit property lists like `transition-[width,height]`. (See lesson #4738)
- **Never use `text-text-inverse` for hover states** — renders invisible in dark themes. Use theme-aware text colors like `text-daintree-text` instead. (See lesson #4630)
- **Prefer `outline` for focus rings** — `outline` is transparent and supports Windows High Contrast Mode. `ring` (box-shadow-based) is acceptable for active/dock states (e.g., `ring-1 ring-daintree-accent/30`), but for keyboard focus, always use `focus-visible:outline-*`.
- **Always use `:focus-visible`** — `:focus` shows rings on mouse clicks; `:focus-visible` only shows for keyboard navigation.
- **Never use accent color as default hover** — it's a scarce resource reserved for one load-bearing signal per component.

---

## Hover States

### Ghost Button Hover

**Role:** Secondary toolbar buttons, icon-only buttons where minimal visual weight needed.

```tsx
"hover:bg-overlay-soft hover:text-daintree-text focus-visible:text-daintree-text";
```

**Usage:** Combine with `transition-colors` for smooth transitions. Add `focus-visible:` variant for keyboard parity. Used in `button.tsx` `ghost` variant.

---

### List Row Hover

**Role:** File trees, quick switcher items, settings lists. Entire row highlights with subtle background tint.

```tsx
"hover:bg-overlay-subtle hover:text-daintree-text";
```

**Usage:** For selected state, use `aria-selected:bg-overlay-raised aria-selected:border-overlay` with a `before:` pseudo-element for the 2px accent rail (`aria-selected:before:absolute aria-selected:before:left-0 aria-selected:before:top-2 aria-selected:before:bottom-2 aria-selected:before:w-[2px] aria-selected:before:bg-daintree-accent`). The raised token follows the `bondi.ts` "elevate-to-select for menu/palette rows" rationale (#9727) — `overlay-soft` is sub-threshold on near-white surfaces. Used in `QuickSwitcherItem.tsx`.

---

### Card Hover

**Role:** Worktree cards (grid variant), settings cards. Use a subtle neutral background lift plus elevation rather than large background shifts or accent borders.

```tsx
"hover:bg-overlay-subtle hover:shadow-[var(--theme-shadow-ambient)]";
```

**Usage:** A neutral overlay tint and ambient shadow signal elevation without color changes — no accent border. Used in `WorktreeCard.tsx` grid variant.

---

### Settings Nav Active

**Role:** Active tab in settings subtabs, navigation bars with bottom-border indicators.

```tsx
"border-b-2 border-daintree-accent text-daintree-text";
```

**Usage:** Hover state: `hover:border-daintree-border hover:text-daintree-text`. Always use `border-b-2` for consistent 2px active indicator height. Used in `SettingsSubtabBar.tsx`.

---

### Dock Item Active

**Role:** Dock buttons (launch pill, popover-open triggers). Use a neutral lift — no accent border or ring.

**Usage:** The accent border+ring active treatment previously documented here was deliberately retired (commit `e30d29638`, "replace accent ring on popover-open dock buttons with neutral lift"). Dock buttons now render via the `pill` Button variant (`button.tsx`) — neutral surface, ambient shadow, no accent active state. The launch pill (`DockLaunchButton.tsx`) goes further and intentionally does NOT keep its accent focus-visible ring after a pointer-dismissed dropdown (see comment near `wasPointerCloseRef`); keyboard dismissal still restores focus for WAI-ARIA. Reach for the neutral overlay ladder, not accent, for any new dock-state treatment.

---

### Selected State (List Item)

**Role:** Selected list item in a picker. Uses background fill with accent rail via pseudo-element.

```tsx
"aria-selected:bg-overlay-raised aria-selected:border-overlay aria-selected:text-daintree-text aria-selected:before:absolute aria-selected:before:left-0 aria-selected:before:top-2 aria-selected:before:bottom-2 aria-selected:before:w-[2px] aria-selected:before:bg-daintree-accent aria-selected:before:content-['']";
```

**Usage:** Selected items do not add hover overlay — the background fill and accent rail provide sufficient state distinction. Unselected items get `hover:bg-overlay-subtle`. Used in `QuickSwitcherItem.tsx`.

---

## Focus States

### Default Focus Ring

**Role:** Standard focus indicator for buttons, cards, form controls.

```tsx
"focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2";
```

**Usage:** 2px outline with 2px offset satisfies WCAG 2.2 SC 2.4.13 (3:1 contrast ratio and size requirements). Requires `focus-visible:outline` base class to enable outline rendering. Used in `SettingsInput.tsx` (`INPUT_CLASSES`).

---

### Inset Focus Ring

**Role:** Flush list items, tree nodes, or elements with no gaps where outline shouldn't overlap adjacent items.

```tsx
"focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-[-2px]";
```

**Usage:** Negative offset keeps indicator inside element bounds. Use when elements are packed tightly (e.g., list items, file tree rows) where default offset would bleed into neighbors.

---

### Input Focus (Outline)

**Role:** Text inputs, textareas. Pre-allocate border width; only change color to avoid layout shifts.

```tsx
"focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2";
```

**Usage:** Base state includes `border-border-strong`. On focus, outline is added — do NOT change `border-width`. Changing width causes layout jitter. Used in `SettingsInput.tsx` and `SettingsTextarea.tsx`.

---

### Input Focus (Border Shift)

**Role:** Standard form inputs where outline treatment is not desired. Shifts border color on focus without adding extra ring.

```tsx
"border border-border-strong focus:border-daintree-accent focus:outline-hidden transition-colors";
```

**Usage:** Border-shift is the lighter-weight alternative to outline-based focus. Base state must always have a visible border (`border-border-strong` or equivalent). On focus, only the border color changes — no outline or ring is added. Suitable for simple text inputs within constrained UIs. Used in `GitHubSettingsTab.tsx` and `NotificationSettingsTab.tsx` (several inputs share the same `focus:border-daintree-accent focus:outline-hidden` string).

---

### Segmented Toggle Group Active State

**Role:** Active segment in a mutually exclusive toggle group (e.g., filter chips, tab-style selectors). Active state uses neutral overlay lift — never accent.

```tsx
"bg-overlay-medium text-daintree-text border-border-strong aria-selected:bg-overlay-medium aria-selected:text-daintree-text";
```

**Usage:** Combine with `transition-colors` for smooth toggle transitions. The active segment gets a neutral background fill and text emphasis; the border distinguishes it from inactive peers. Accent must NOT appear on any toggle segment. The canonical target is `overlay-medium` for the active fill.

---

### Switch-Row ON State

**Role:** Settings row containing a toggle switch. The row styling stays neutral regardless of switch state; accent is confined to the switch widget's track.

```tsx
"border-daintree-border text-daintree-text";
```

**Usage:** The row card always uses neutral border and text. A 2px left rail (`bg-state-modified`) on the row signals modified state — semantic info hue, not accent. In the default `accent` color scheme (`SettingsSwitch.tsx` `COLOR_SCHEMES`), the switch track uses `bg-daintree-border` in OFF state and `data-[state=checked]:bg-daintree-text` in ON state — the ON fill is neutral text color, not accent. Accent on this widget is confined to the focus outline (`focus-visible:outline-daintree-accent`), never the track fill, the row card, or the modified-state rail. Apply `focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2` to the switch Root for keyboard focus. Used in `SettingsSwitchCard.tsx` + `SettingsSwitch.tsx`.

---

### Drag Handle During Sort

**Role:** Visual feedback on a drag handle during an active sort/drag operation. Uses neutral elevation and scale — never accent.

```tsx
"opacity-80 scale-105 shadow-[var(--theme-shadow-floating)] cursor-grabbing";
```

**Usage:** Apply during `isDragging` state. The floating shadow and slight scale-up signal elevation without color changes. **Caution:** Sortable containers must NOT use `content-visibility: auto` — it virtualizes layout and causes dnd-kit drag coordinate desync. Set `contentVisibility: 'visible'` during drag operations. (See lesson #4438.) Used in `PortalToolbar.tsx` (`isDragging` branch).

---

### Inline Rename Input

**Role:** Inline text input for renaming (e.g., tab labels, file names). Neutral, non-accent border.

```tsx
"text-xs bg-overlay-soft border border-transparent text-daintree-text focus:outline-hidden transition-colors";
```

**Usage:** The base border is neutral — `border-transparent` over an `bg-overlay-soft` fill, swapping to `border-status-error` on validation error. Use `text-xs` for compact inline inputs. The current implementation in `TabButton.tsx` (rename input) has converged on this neutral pattern and no longer uses any accent-tinged border. Note it uses `focus:outline-hidden` rather than the accent focus outline — the overlay fill plus the surrounding tab chrome already signal the edit state.

---

## Transition Patterns

| Need | Use Instead | Why |
| --- | --- | --- |
| Color/bg/border changes | `transition-colors` | Covers color, background-color, border-color for most interactive states |
| Width/height changes | `transition-[width]` / `transition-[height]` | Layout-impacting properties should be explicit |
| Opacity changes | `transition-opacity` | Visual fades only |
| Transform changes | `transition-transform` | Covers `transform`, `translate`, `scale`, `rotate` — safe for all transform utilities |
| Multiple props | `transition-[color,background-color,translate]` | Explicit is better than `transition-all` — forces all props to interpolate |

**Tailwind v4 trap:** `translate-*`, `scale-*`, and `rotate-*` utilities emit the individual `translate`/`scale`/`rotate` CSS properties, NOT `transform`. An arbitrary list like `transition-[opacity,transform]` silently skips them (the motion snaps while only the fade runs). In arbitrary lists, name the individual properties you animate (`transition-[opacity,translate,scale]`); only an inline `style={{ transform: ... }}` string is covered by `transform`. Same for reduced-motion neutralizers: `transform-none` does not reset `translate`/`scale` — use `translate-none` / `scale-none`.

---

## Token Ladder Reference

The overlay ladder drives most hover/fill states. See `theme-tokens.md` for full token definitions.

| Token              | Opacity (Dark) | Opacity (Light) | Usage                           |
| ------------------ | -------------- | --------------- | ------------------------------- |
| `overlay-subtle`   | base 2%        | base 2%         | Lightest interactive tint       |
| `overlay-soft`     | base 3%        | base 3%         | Hover state on list items       |
| `overlay-medium`   | base 4%        | base 5%         | Active/selected items           |
| `overlay-strong`   | base 6%        | base 8%         | Stronger fills, secondary hover |
| `overlay-emphasis` | base 10%       | base 12%        | Maximum-contrast fill           |

---

## Usage Pattern

Each recipe is a class fragment to apply to a suitable base component, not a standalone implementation. When a canonical example is cited, prefer extending it over recreating the pattern. Recipes document canonical app behavior. When a recipe prescribes a target that differs from the current implementation, the divergence is noted in Usage.

## Canonical Examples

| Component | File | Key Pattern |
| --- | --- | --- |
| Quick Switcher Item | `QuickSwitcherItem.tsx` | Selected state with accent rail via `before:` |
| Settings Input | `SettingsInput.tsx` | Input focus with outline ring |
| Settings Textarea | `SettingsTextarea.tsx` | Input focus with outline ring |
| Button Ghost | `button.tsx` (`ghost` variant) | Ghost button hover with overlay-soft |
| Dock Launch Button | `DockLaunchButton.tsx` (`pill` variant) | Neutral lift, no accent active state |
| Settings Subtab | `SettingsSubtabBar.tsx` | Active tab with bottom border accent |
| Worktree Card | `WorktreeCard.tsx` | Card hover with neutral overlay + ambient elevation |
| GitHub Settings Tab | `GitHubSettingsTab.tsx` | Input focus with border-shift (no outline) |
| Notification Settings | `NotificationSettingsTab.tsx` | Input focus with border-shift (no outline) |
| Settings Switch Row | `SettingsSwitchCard.tsx` | Neutral row, neutral switch track (accent only on focus) |
| Portal Drag Handle | `PortalToolbar.tsx` (`isDragging`) | Drag state with elevation + scale, no accent |
| Inline Rename Input | `TabButton.tsx` (rename input) | Neutral `bg-overlay-soft`, transparent border |

---

## Where Accent IS Allowed

Accent color is a scarce resource, not a default. These are the only contexts where accent is permitted:

- **Focus rings** — Every interactive element. `focus-visible:outline-daintree-accent` on buttons, inputs, list items, tree nodes.
- **Primary view anchor** — The single load-bearing signal per active focus region: armed terminal, focused worktree card, primary CTA button.
- **Editor caret** — The terminal cursor is a singleton position anchor. (`--color-terminal-cursor-accent` in `src/index.css`.)
- **Theme mockup chrome** — Swatches and preview strips that display a theme's accent color are data, not interactive chrome (e.g., `PaletteStrip.tsx`, `AppThemePicker.tsx`).
- **Status-tone routing** — Where `accent` is one option among `success`/`warning`/`danger` for mapping a semantic state to a color (e.g., `SettingsSwitch.tsx` `COLOR_SCHEMES`).

For everything else, use the neutral overlay ladder (`bg-overlay-*`, `border-overlay`) or structural tokens (`border-border-strong`, `text-daintree-text`).

---

## See Also

- [Theme Token Reference](./theme-tokens.md) — Full token documentation including overlay ladder and focus tokens
- [Theme System](./theme-system.md) — Three-layer theming pipeline and component overrides
- [Visual Design Guide](./visual-guide.md) — Complete surface-by-surface visual description
