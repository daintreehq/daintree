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

**Usage:** For selected state, use the shared `PALETTE_ROW_CLASS` (`src/components/ui/paletteRowStyles.ts`) rather than respelling it — see [Selected State (List Item)](#selected-state-list-item). The raised token follows the `bondi.ts` "elevate-to-select for menu/palette rows" rationale (#9727) — `overlay-soft` is sub-threshold on near-white surfaces. Used in `QuickSwitcherItem.tsx`.

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

**Role:** Selected list item in a picker. A raised neutral fill plus a neutral leading rail — no accent.

```tsx
"palette-row relative border border-transparent transition-colors aria-selected:bg-overlay-raised aria-selected:text-daintree-text";
```

**Usage:** Do not respell this — import `PALETTE_ROW_CLASS` from `src/components/ui/paletteRowStyles.ts`, which 15 production component files and 17 rendered row definitions already share. Selected items do not add hover overlay; unselected items get `hover:bg-overlay-subtle`.

`selection-outline` is its own semantic token, not a member of the resting border ladder, because it is the row's only non-text indicator and so carries WCAG 1.4.11 alone: `overlay-raised` clears only ~1.1-1.2:1 against the palette surface, far short of 3:1. It is derived from each theme's `text-primary` (42% dark / 53% light) and gated at 3:1 against _both_ the selected fill and the surrounding surface by `getThemeContrastWarnings`. The fill is the binding pair — on dark the row lifts toward the rail, so a rail that looks safe against the surface can still vanish into the row it marks.

The token paints a **leading rail**, drawn as `.palette-row::before` in `src/index.css`: 3px wide, `inset-block: 6px`, `inset-inline-start: -1px` so it sits on the card's outer boundary rather than inside its padding. Anything further in lands about 2px from the status mark these rows carry, and the two read as one cluttered gutter. It fades on the same 150ms slot as the fill — cross-fading one and popping the other put the mark on the new row while the surface behind it was still arriving — and `@variant reduce-motion` drops both together, covering the OS preference and Daintree's own toggle.

Not four sides. The token has to hold 3:1 against both its neighbours, which lands it on a mid-grey stroke; drawn all the way round a row that is _not_ the DOM focus target, that reads as an empty form field. No shipping palette does it — VS Code leaves `list.focusOutline` unset in Quick Open, and Linear, Raycast, Spotlight, Arc and Slack are all fill-led. Making the fill carry 3:1 instead and dropping the mark entirely is not the escape: it needs ~33% white on these surfaces, far heavier than the stroke it replaces. WCAG 1.4.11 sets a ratio, not an area, so spending the same token on a rail is the cheaper way to buy the same guarantee. The reserved transparent border stays — it holds the row's content box on the palette's shared column, and the forced-colors fallback still draws an outline there.

The accent border and the 2px **accent** rail this recipe used to prescribe were removed in #11686: they put accent on the row, its rail and the focused input at once, breaking the one-load-bearing-signal rule. The rail is back, but neutral — accent stays on the focused input alone. The palette input's focus lift draws the same `selection-outline` (ring at half strength), so the field and the selected row stay one treatment — change them together.

`palette-row` is a forced-colors hook, not styling. Under `forced-colors: active` both the fill and the rail are stripped, so `src/index.css` falls back to a 2px `SelectedItem` outline. Deliberately an outline rather than a `SelectedItem` fill: these rows carry independently surfaced children (theme "Active" badges, action category chips, panel-kind icons with inline colour) that the engine maps to the forced palette on their own, and a fill would leave them painting `CanvasText` on `SelectedItem` — a pair with no contrast guarantee. The marker scopes the rule to palette rows, since `[role="option"]` is also used by the file pane, the settings selectors and the agent/forge dropdowns.

---

### Brand Mark States

**Role:** Third-party brand marks (agent and product logos) in toolbars, dock rails, panel title bars and palettes. Two inks: the brand colour a step back at rest, the brand colour itself when the mark is active.

```tsx
<BrandSurface surface="surface-panel" extension="panel-header-focus-bg" lift="overlay-subtle">
  {/* ...anything rendering a BrandMark... */}
</BrandSurface>
```

**Usage:** Never hand a colour to a brand glyph. The SVG stays on `currentColor`, `BrandMark` publishes `--brand-mark-rest` / `--brand-mark-active`, and `.brand-mark` in `src/index.css` owns the swap. Active is reached by `:hover`, `:focus-visible`, `[role="option"]/[role="tab"][aria-selected="true"]`, and `[data-brand-active]` for a container whose own notion of active is none of those — a focused panel title bar being the case that asked for it. Put `data-brand-active` on the glyph's own wrapper, not on a container that also holds other marks, or a focused panel lights up every tab in its strip.

These marks carry vendor hexes from `AgentConfig.color`, not theme tokens, so they are the one colour family the semantic palette cannot reach. `resolveBrandMarkInk` (`src/lib/brandIcon.ts`) places both states against the backdrop the mark is actually painted on:

- **Active** is the brand colour untouched wherever it clears WCAG 1.4.11's 3:1 _and_ APCA Lc 35 against the weaker of its two backdrops (a mark is painted on the hover backdrop when hovered and on the plain surface when it sits in a selected tab or the focused pane). Where it falls short, the smallest move along its own hue line that gets it there — hue held, chroma re-fitted by CSS Color 4 chroma reduction, never by clipping channels. Lc 35 rather than 3:1 alone because a fine outlined glyph and a solid square at the same ratio are not the same thing to read, and several dark violets cleared 3:1 while landing below the resting state they came from.
- **Rest** is that colour drawn back an OKLab ΔE of 0.07, _away from the backdrop_ — so on a light theme it sits darker than the brand and lightens into it, on a dark theme lighter and deepens into it. Most of the step is lightness; a fifth of the chroma goes with it so the reveal is a bloom of colour as well as a shift in weight. Fading toward the backdrop instead is what made the previous revision read as washed out.
- **A ceiling** holds the resting mark within 11 Lc of the theme's own `text-secondary` ink. The neutral controls beside a mark are painted in that ink, and a brand arriving near-white on a dark theme would otherwise rest louder than every control around it. What the ceiling takes off the lightness move comes back as chroma, so the fade keeps its size.
- **A brand with no chroma is not a colour**, so below OKLCH chroma 0.02 the mark is drawn as an icon instead: it rests at `text-secondary` and its active state is that ink one step _further_ from the backdrop. The direction is reversed on purpose — a colourless mark has no colour to gain on hover, so weight is the only reveal it has.

Every state is checked across the whole 150ms crossfade rather than at its endpoints: the control repaints its background in the same 150ms the glyph recolours, so both are moving and the minimum can sit between the ends. Foreground and backdrop are sampled as a grid rather than in lockstep — the glyph eases out while the surfaces under it ease — so any monotone pair of easings is covered without either being assumed. `src/lib/__tests__/brandMarkMatrix.test.ts` runs the whole agent registry against every built-in theme and every surface a mark can land on.

`BrandSurface` is how the backdrop is known. Wrap containers, not call sites — one on a title bar covers the header glyph and its whole tab strip. `extension` names a theme extension that replaces the surface where a theme defines one (several light themes repaint title bars through `panel-header-bg`), and `lift` names the overlay the container composites when it does not. Without a provider the mark answers to every surface at once, which is safe everywhere and generous nowhere. Floating material — menus, popovers — renders `BrandSurfaceReset` for that reason: React context reaches through a portal even though the DOM does not, so a menu opened from the toolbar would otherwise be measured against the toolbar.

## Focus States

### Default Focus Ring

**Role:** Standard focus indicator for buttons, cards, form controls.

```tsx
"focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2";
```

**Usage:** 2px outline with 2px offset satisfies WCAG 2.2 SC 2.4.13 (3:1 contrast ratio and size requirements). Requires `focus-visible:outline` base class to enable outline rendering. Used in `src/components/ui/input.tsx` (`inputVariants`).

---

### Inset Focus Ring

**Role:** Flush list items, tree nodes, or elements with no gaps where outline shouldn't overlap adjacent items.

```tsx
"focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-[-2px]";
```

**Usage:** Negative offset keeps indicator inside element bounds. Use when elements are packed tightly (e.g., list items, file tree rows) where default offset would bleed into neighbors.

**Radix row exception (menu, context-menu, select items):** these use `focus-visible:outline-selection-outline`, not accent, and add `focus-visible:outline-solid`. Both are deliberate, so a consistency pass should not "correct" them. `selection-outline` is the only ink `getPaletteSelectionWarnings` in `shared/theme/contrast.ts` holds to 3:1 against the raised `data-[highlighted]` fill, a destructive row's `status-danger/10` fill, and the `.surface-overlay` behind them — the three colours this ring actually touches; accent is scored against the display surfaces only. `outline-solid` is load-bearing wherever the element also carries `outline-hidden`, which these rows keep so `forced-colors` can still recolour the outline: `outline-hidden` sets `--tw-outline-style: none` on the element and the width utility reads that same variable back, so the ring paints nothing without it. `focusRingFallback.contract.test.ts` enforces the ring's presence, effective width, offset, style and that its ink paints something — but not that the ink is this particular token, which is why this note exists.

---

### Input Focus (Outline)

**Role:** Text inputs, textareas. Pre-allocate border width; only change color to avoid layout shifts.

```tsx
"focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2";
```

**Usage:** Base state includes `border-border-strong`. On focus, outline is added — do NOT change `border-width`. Changing width causes layout jitter. Used in `src/components/ui/input.tsx` (`inputVariants`) and `src/components/ui/textarea.tsx` (`textareaVariants`); the settings wrappers `SettingsInput.tsx` and `SettingsTextarea.tsx` compose those rather than restating the recipe.

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

**Usage:** The row card always uses neutral border and text. A 2px left rail (`bg-state-modified`) on the row signals modified state — semantic info hue, not accent. In the default `neutral` tone (`src/components/ui/switch.tsx` `switchVariants`), the track is `bg-surface-input` with an inset `ring-border-strong` in OFF state and `data-[state=checked]:bg-text-primary` in ON state — the ON fill is neutral text color, not accent. Accent on this widget is confined to the focus outline (`focus-visible:outline-daintree-accent`), never the track fill, the row card, or the modified-state rail. The Root already carries `focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2` for keyboard focus. Used in `SettingsSwitchCard.tsx` + `src/components/ui/switch.tsx`, with `SettingsSwitch.tsx` mapping the settings layer's color-scheme names onto the primitive's tones.

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
| Quick Switcher Item | `QuickSwitcherItem.tsx` | Selected state with neutral rail via `PALETTE_ROW_CLASS` |
| Text Input | `ui/input.tsx` (`inputVariants`) | Input focus with outline ring |
| Textarea | `ui/textarea.tsx` (`textareaVariants`) | Input focus with outline ring |
| Button Ghost | `button.tsx` (`ghost` variant) | Ghost button hover with overlay-soft |
| Dock Launch Button | `DockLaunchButton.tsx` (`pill` variant) | Neutral lift, no accent active state |
| Settings Subtab | `SettingsSubtabBar.tsx` | Active tab with bottom border accent |
| Worktree Card | `WorktreeCard.tsx` | Card hover with neutral overlay + ambient elevation |
| GitHub Settings Tab | `GitHubSettingsTab.tsx` | Input focus with border-shift (no outline) |
| Notification Settings | `NotificationSettingsTab.tsx` | Input focus with border-shift (no outline) |
| Settings Switch Row | `SettingsSwitchCard.tsx` + `ui/switch.tsx` | Neutral row, neutral switch track (accent only on focus) |
| Portal Drag Handle | `PortalToolbar.tsx` (`isDragging`) | Drag state with elevation + scale, no accent |
| Inline Rename Input | `TabButton.tsx` (rename input) | Neutral `bg-overlay-soft`, transparent border |

---

## Where Accent IS Allowed

Accent color is a scarce resource, not a default. These are the only contexts where accent is permitted:

- **Focus rings** — Every interactive element. `focus-visible:outline-daintree-accent` on buttons, inputs, list items, tree nodes.
- **Primary view anchor** — The single load-bearing signal per active focus region: armed terminal, focused worktree card, primary CTA button.
- **Editor caret** — The terminal cursor is a singleton position anchor. (`--color-terminal-cursor-accent` in `src/index.css`.)
- **Theme mockup chrome** — Swatches and preview strips that display a theme's accent color are data, not interactive chrome (e.g., `PaletteStrip.tsx`, `AppThemePicker.tsx`).
- **Status-tone routing** — Where `accent` is one option among `success`/`warning`/`danger` for mapping a semantic state to a color (e.g., `SettingsSwitchCard.tsx` `COLOR_SCHEMES`, where `accent` tints the row's leading icon).

For everything else, use the neutral overlay ladder (`bg-overlay-*`, `border-overlay`) or structural tokens (`border-border-strong`, `text-daintree-text`).

---

## See Also

- [Theme Token Reference](./theme-tokens.md) — Full token documentation including overlay ladder and focus tokens
- [Theme System](./theme-system.md) — Three-layer theming pipeline and component overrides
- [Visual Design Guide](./visual-guide.md) — Complete surface-by-surface visual description
