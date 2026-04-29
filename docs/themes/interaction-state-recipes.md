# Canonical Interaction State Recipes

This document maps each interactive component role to its canonical Tailwind class string. Use these patterns as a single reference point so new components converge on established treatments instead of inventing variations.

## Critical Rules

- **Never use `transition-all`** — forces Chromium to interpolate every computed property on every frame. Use specific transitions: `transition-colors`, `transition-opacity`, `transition-transform`, or explicit property lists like `transition-[width,height]`. (See lesson #4738)
- **Never use `text-text-inverse` for hover states** — renders invisible in dark themes. Use theme-aware text colors like `text-daintree-text` or `text-canopy-text` instead. (See lesson #4630)
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

**Usage:** Combine with `transition-colors` for smooth transitions. Add `focus-visible:` variant for keyboard parity. Used in `button.tsx` ghost variant (line 21).

---

### List Row Hover

**Role:** File trees, quick switcher items, settings lists. Entire row highlights with subtle background tint.

```tsx
"hover:bg-overlay-subtle hover:text-daintree-text";
```

**Usage:** For selected state, use `bg-overlay-soft border-overlay` with a `before:` pseudo-element for the 2px accent rail (`before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-r before:bg-daintree-accent`). Used in `QuickSwitcherItem.tsx` (line 31).

---

### Card Hover

**Role:** Worktree cards (grid variant), settings cards. Use elevation or border change rather than large background shifts.

```tsx
"hover:border-accent-primary/50 hover:shadow-[var(--theme-shadow-floating)]";
```

**Usage:** Accent-tinged border and floating shadow create elevation without heavy background fills. Used in `WorktreeCard.tsx` grid variant (line 691).

---

### Settings Nav Active

**Role:** Active tab in settings subtabs, navigation bars with bottom-border indicators.

```tsx
"border-b-2 border-daintree-accent text-daintree-text";
```

**Usage:** Hover state: `hover:border-daintree-border hover:text-daintree-text`. Always use `border-b-2` for consistent 2px active indicator height. Used in `SettingsSubtabBar.tsx` (line 77).

---

### Dock Item Active

**Role:** Active dock button. Use border + ring combo for clear active state without heavy background.

```tsx
"bg-daintree-border border-daintree-accent/40 ring-1 ring-daintree-accent/30";
```

**Usage:** Semi-transparent accent at 30-40% creates subtle glow without overwhelming adjacent elements. Used in `HelpAgentDockButton.tsx` (line 27).

---

### Selected State (List Item)

**Role:** Selected list item in a picker. Uses background fill with accent rail via pseudo-element.

```tsx
"bg-overlay-soft border-overlay text-daintree-text before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-r before:bg-daintree-accent";
```

**Usage:** Selected items do not add hover overlay — the background fill and accent rail provide sufficient state distinction. Unselected items get `hover:bg-overlay-subtle`. Used in `QuickSwitcherItem.tsx` (line 30).

---

## Focus States

### Default Focus Ring

**Role:** Standard focus indicator for buttons, cards, form controls.

```tsx
"focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2";
```

**Usage:** 2px outline with 2px offset satisfies WCAG 2.2 SC 2.4.13 (3:1 contrast ratio and size requirements). Requires `focus-visible:outline` base class to enable outline rendering. Used in `SettingsInput.tsx` (line 7).

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

**Usage:** Base state includes `border-border-strong`. On focus, outline is added — do NOT change `border-width`. Changing width causes layout jitter. Used in `SettingsInput.tsx` (line 7) and `SettingsTextarea.tsx` (line 7).

---

### Input Focus (Border Shift)

**Role:** Standard form inputs where outline treatment is not desired. Shifts border color on focus without adding extra ring.

```tsx
"border border-border-strong focus:border-daintree-accent focus:outline-hidden transition-colors";
```

**Usage:** Border-shift is the lighter-weight alternative to outline-based focus. Base state must always have a visible border (`border-border-strong` or equivalent). On focus, only the border color changes — no outline or ring is added. Suitable for simple text inputs within constrained UIs. Used in `GitHubSettingsTab.tsx` (line 213) and `NotificationSettingsTab.tsx` (lines 217, 282, 415).

---

### Segmented Toggle Group Active State

**Role:** Active segment in a mutually exclusive toggle group (e.g., filter chips, tab-style selectors). Active state uses neutral overlay lift — never accent.

```tsx
"bg-overlay-medium text-daintree-text border-border-strong aria-selected:bg-overlay-medium aria-selected:text-daintree-text";
```

**Usage:** Combine with `transition-colors` for smooth toggle transitions. The active segment gets a neutral background fill and text emphasis; the border distinguishes it from inactive peers. Accent must NOT appear on any toggle segment. Current implementation in `FleetArmingDialog.tsx` ChipButton (lines 370-390) uses `bg-overlay-subtle`; this recipe prescribes the canonical target (`overlay-medium`).

---

### Switch-Row ON State

**Role:** Settings row containing a toggle switch. The row styling stays neutral regardless of switch state; accent is confined to the switch widget's track.

```tsx
"border-daintree-border text-daintree-text";
```

**Usage:** The row card always uses neutral border and text. A 2px left rail (`bg-daintree-accent`) on the row signals modified state. The switch track uses `bg-daintree-border` in OFF state and `data-[state=checked]:bg-daintree-accent` in ON state — accent is constrained to the switch track, the modified-state rail, and enabled-state icons, never the full row card. Apply `focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2` to the switch Root for keyboard focus. Used in `SettingsSwitchCard.tsx` + `SettingsSwitch.tsx`.

---

### Drag Handle During Sort

**Role:** Visual feedback on a drag handle during an active sort/drag operation. Uses neutral elevation and scale — never accent.

```tsx
"opacity-80 scale-105 shadow-[var(--theme-shadow-floating)] cursor-grabbing";
```

**Usage:** Apply during `isDragging` state. The floating shadow and slight scale-up signal elevation without color changes. **Caution:** Sortable containers must NOT use `content-visibility: auto` — it virtualizes layout and causes dnd-kit drag coordinate desync. Set `contentVisibility: 'visible'` during drag operations. (See lesson #4438.) Used in `PortalToolbar.tsx` (lines 107-109).

---

### Inline Rename Input

**Role:** Inline text input for renaming (e.g., tab labels, file names). Neutral border with accent focus outline — accent only on keyboard focus.

```tsx
"border border-border-strong text-daintree-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent";
```

**Usage:** The base border is neutral (`border-border-strong`), not accent-tinged. Accent only appears on the focus outline. Use `text-xs` for compact inline inputs. Current implementation in `TabButton.tsx` (line 275) uses `border-daintree-accent/50`; this recipe prescribes the canonical target (`border-border-strong` with accent only on focus).

---

## Transition Patterns

| Need                    | Use Instead                                     | Why                                                                        |
| ----------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| Color/bg/border changes | `transition-colors`                             | Covers color, background-color, border-color for most interactive states   |
| Width/height changes    | `transition-[width]` / `transition-[height]`    | Layout-impacting properties should be explicit                             |
| Opacity changes         | `transition-opacity`                            | Visual fades only                                                          |
| Transform changes       | `transition-transform`                          | Animations, scale effects                                                  |
| Multiple props          | `transition-[color,background-color,transform]` | Explicit is better than `transition-all` — forces all props to interpolate |

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

| Component             | File                                     | Key Pattern                                      |
| --------------------- | ---------------------------------------- | ------------------------------------------------ |
| Quick Switcher Item   | `QuickSwitcherItem.tsx`                  | Selected state with accent rail via `before:`    |
| Settings Input        | `SettingsInput.tsx`                      | Input focus with outline ring                    |
| Settings Textarea     | `SettingsTextarea.tsx`                   | Input focus with outline ring                    |
| Button Ghost          | `button.tsx` (line 21)                   | Ghost button hover with overlay-soft             |
| Button Pill           | `HelpAgentDockButton.tsx`                | Dock item active with border + ring combo        |
| Settings Subtab       | `SettingsSubtabBar.tsx`                  | Active tab with bottom border accent             |
| Worktree Card         | `WorktreeCard.tsx`                       | Card hover with accent-tinged border + elevation |
| GitHub Settings Tab   | `GitHubSettingsTab.tsx` (line 213)       | Input focus with border-shift (no outline)       |
| Notification Settings | `NotificationSettingsTab.tsx` (line 217) | Input focus with border-shift (no outline)       |
| Segmented Toggle      | `FleetArmingDialog.tsx` (line 370)       | Active segment with neutral overlay lift         |
| Settings Switch Row   | `SettingsSwitchCard.tsx`                 | Neutral row, accent only on switch track         |
| Portal Drag Handle    | `PortalToolbar.tsx` (line 107)           | Drag state with elevation + scale, no accent     |
| Inline Rename Input   | `TabButton.tsx` (line 274)               | Neutral border with accent focus outline only    |

---

## Where Accent IS Allowed

Accent color is a scarce resource, not a default. These are the only contexts where accent is permitted:

- **Focus rings** — Every interactive element. `focus-visible:outline-daintree-accent` on buttons, inputs, list items, tree nodes.
- **Primary view anchor** — The single load-bearing signal per view: armed terminal, focused worktree card, primary CTA button.
- **Editor caret** — The terminal cursor is a singleton position anchor. (`--color-terminal-cursor-accent` in `src/index.css` line 97.)
- **Theme mockup chrome** — Swatches and preview strips that display a theme's accent color are data, not interactive chrome (e.g., `PaletteStrip.tsx`, `AppThemePicker.tsx`).
- **Status-tone routing** — Where `accent` is one option among `success`/`warning`/`danger` for mapping a semantic state to a color (e.g., `SettingsSwitch.tsx` `COLOR_SCHEMES`).

For everything else, use the neutral overlay ladder (`bg-overlay-*`, `border-overlay`) or structural tokens (`border-border-strong`, `text-daintree-text`).

---

## See Also

- [Theme Token Reference](./theme-tokens.md) — Full token documentation including overlay ladder and focus tokens
- [Theme System](./theme-system.md) — Three-layer theming pipeline and component overrides
- [Visual Design Guide](./visual-guide.md) — Complete surface-by-surface visual description
