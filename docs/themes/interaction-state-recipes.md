# Canonical Interaction State Recipes

This document maps each interactive component role to its canonical Tailwind class string. Use these patterns as a single reference point so new components converge on established treatments instead of inventing variations.

## Critical Rules

- **Never use `transition-all`** — forces Chromium to interpolate every computed property on every frame. Use specific transitions: `transition-colors`, `transition-opacity`, `transition-transform`, or explicit property lists like `transition-[width,height]`. (See lesson #4738)
- **Never use `text-text-inverse` for hover states** — renders invisible in dark themes. Use theme-aware text colors like `text-daintree-text` or `text-canopy-text` instead. (See lesson #4630)
- **Use `outline` utilities, not `ring`** — `outline` is truly transparent and supports Windows High Contrast Mode. `ring` uses box-shadow which fails in HCM.
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

**Usage:** For selected state, use `bg-overlay-soft` with `border-daintree-accent` left accent edge. Used in `QuickSwitcherItem.tsx` (line 31).

---

### Card Hover

**Role:** Worktree cards (grid variant), settings cards. Use elevation or border change rather than large background shifts.

```tsx
"hover:border-border-default hover:shadow-[var(--theme-shadow-ambient)]";
```

**Usage:** Prefer border/shadow changes for elevation; avoid large background fills that feel heavy. Used in `WorktreeCard.tsx` grid variant (line 691).

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

### Selected + Hover Combo

**Role:** Selected items that also receive hover. Use pseudo-element overlay to avoid "color jump."

```tsx
// Base selected state
"bg-overlay-soft border-daintree-accent";
// Hover overlay added via :after pseudo-element
"hover:after:absolute hover:after:inset-0 hover:after:bg-white/10";
```

**Usage:** Pseudo-element overlay adds brightness on hover while maintaining selection indicator. Prevents jarring color transitions when user hovers over selected item. Pattern derived from QuickSwitcherItem (lines 29-31).

---

## Focus States

### Default Focus Ring

**Role:** Standard focus indicator for buttons, cards, form controls.

```tsx
"focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2";
```

**Usage:** 2px outline with 2px offset satisfies WCAG 2.2 SC 2.4.13 (3:1 contrast ratio and size requirements). Used in `SettingsInput.tsx` (line 7).

---

### Inset Focus Ring

**Role:** Flush list items, tree nodes, or elements with no gaps where outline shouldn't overlap adjacent items.

```tsx
"focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-[-2px]";
```

**Usage:** Negative offset keeps indicator inside element bounds. Use when elements are packed tightly (e.g., list items, file tree rows) where default offset would bleed into neighbors.

---

### Input Focus

**Role:** Text inputs, textareas. Pre-allocate border width; only change color to avoid layout shifts.

```tsx
"focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2";
```

**Usage:** Base state includes `border-border-strong`. On focus, outline is added — do NOT change `border-width`. Changing width causes layout jitter. Used in `SettingsInput.tsx` (line 7) and `SettingsTextarea.tsx` (line 7).

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

## Canonical Examples

| Component           | File                      | Key Pattern                                  |
| ------------------- | ------------------------- | -------------------------------------------- |
| Quick Switcher Item | `QuickSwitcherItem.tsx`   | Selected + hover with pseudo-element overlay |
| Settings Input      | `SettingsInput.tsx`       | Input focus with outline ring                |
| Settings Textarea   | `SettingsTextarea.tsx`    | Input focus with outline ring                |
| Button Ghost        | `button.tsx` (line 21)    | Ghost button hover with overlay-soft         |
| Button Pill         | `HelpAgentDockButton.tsx` | Dock item active with border + ring combo    |
| Settings Subtab     | `SettingsSubtabBar.tsx`   | Active tab with bottom border accent         |
| Worktree Card       | `WorktreeCard.tsx`        | Card hover with border/shadow elevation      |

---

## See Also

- [Theme Token Reference](./theme-tokens.md) — Full token documentation including overlay ladder and focus tokens
- [Theme System](./theme-system.md) — Three-layer theming pipeline and component overrides
- [Visual Design Guide](./visual-guide.md) — Complete surface-by-surface visual description
