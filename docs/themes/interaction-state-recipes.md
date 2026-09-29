# Canonical Interaction State Recipes

This document maps each interactive component role to its canonical Tailwind class string. Use these patterns as a single reference point so new components converge on established treatments instead of inventing variations.

## Critical Rules

- **Never use `transition-all`** — forces Chromium to interpolate every computed property on every frame. Use specific transitions: `transition-colors`, `transition-opacity`, `transition-transform`, or explicit property lists like `transition-[width,height]`. (See lesson #4738)
- **Never use `text-text-inverse` for hover states** — renders invisible in dark themes. Use theme-aware text colors like `text-text-primary` instead. (See lesson #4630)
- **Prefer `outline` for focus rings** — `outline` is transparent and supports Windows High Contrast Mode. `ring` (box-shadow-based) is acceptable for active/dock states (e.g., `ring-1 ring-accent-primary/30`), but for keyboard focus, always use `focus-visible:outline-*`.
- **Always use `:focus-visible`** — `:focus` shows rings on mouse clicks; `:focus-visible` only shows for keyboard navigation.
- **Never use accent color as default hover** — it's a scarce resource reserved for one load-bearing signal per component.

---

## Hover States

### Ghost Button Hover

**Role:** Secondary toolbar buttons, icon-only buttons where minimal visual weight needed.

```tsx
"hover:bg-overlay-hover hover:text-text-primary focus-visible:text-text-primary";
```

**Usage:** Reach for `<Button variant="ghost">` rather than respelling this; a raw `<button>` carrying these classes still misses the primitive's focus outline, press snap, cursor and disabled treatment. The fill is `overlay-hover` rather than `overlay-soft` because it is the one overlay the theme validator floors (`getOverlayContrastWarnings`, 12% Weber over `surface-canvas`): `overlay-soft` measures 9.6–10.8% on every light theme, which is what kept sending callers to hand-rolled `tint/*` and `overlay-emphasis` hovers. `button.test.tsx` pins the ghost to whichever token the validator reads.

---

### Link Button

**Role:** A text action that reads as a link — "Retry", "Clear filter", "Show dotfiles", an action inside a sentence.

```tsx
<Button variant="link">Clear filter</Button>
```

**Usage:** One treatment app-wide: secondary ink, underlined at rest (never hover-only, so it does not rely on colour alone — WCAG 1.4.1), stepping to primary on hover. With no `size` it takes the `inline` size — no height, no padding, no type size — so it inherits the sentence it sits in; pass `className="text-xs"` when it stands alone. Both high-contrast blocks in `src/index.css` exempt `[data-variant="link"]` from the blanket button frame, for the same reason as `.tip-action`. A popover's footer actions ("Clear", "Done") are buttons, not links — use `ghost`.

---

### List Row Hover

**Role:** Rows in a list-detail browser that are not a roving cursor — the plugin manager, telemetry and event lists, the theme browser — where a click picks the record the detail pane shows.

```tsx
"hover:bg-overlay-subtle";
```

**Usage:** Only where hover and selection are genuinely two states. In a palette, picker, autocomplete or menu the pointer moves the cursor instead — see [Highlighted Row](#highlighted-row) — and a row there must never paint its own `hover:bg-*`, or the resting pointer lights a second row beside the one Enter acts on.

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
"border-b-2 border-accent-primary text-text-primary";
```

**Usage:** Hover state: `hover:border-border-default hover:text-text-primary`. Always use `border-b-2` for consistent 2px active indicator height. Used in `SettingsSubtabBar.tsx`.

---

### Document Tab

**Role:** A horizontal strip of documents with one open: grid pane tab groups and dock tab groups (`TabButton`), portal browser tabs (`PortalToolbar`), assistant session lanes (`HelpSessionTabs`). All four draw from `ui/document-tab.tsx`.

```tsx
documentTabClassName(isActive); // text-xs font-medium, border-r divider, inset -2px accent focus ring
// selected: bg-tint/[0.04] text-text-primary + <DocumentTabIndicator /> (2px accent underline)
// unselected: text-text-secondary hover:text-text-primary hover:bg-overlay-subtle
```

**Usage:** Hosts add only geometry (padding, height, width limits). One weight across states, so selection never reflows widths. Close is `<DocumentTabClose />`: a 24px `icon-xs` ghost button with the red close hover, shown on the selected tab and revealed on hover or keyboard focus for the rest, `tabIndex={-1}` and `aria-hidden` because it sits inside the `tab`. Keyboard contract is APG tabs with manual activation (arrows and Home/End move focus, Enter/Space select, Delete/Backspace close via `useKeyboardTabClose`), with the single tab stop on the selected tab. Every tab carries `aria-controls`, `aria-keyshortcuts="Delete"` and `data-document-tab` (the forced-colors hook). Full titles go in `Tooltip`, never `title=`. Under manual activation the selected tab's underline and the focused tab's ring can sit on two different tabs at once; that is the one sanctioned case of two accent marks in a strip, because they answer different questions (which document is open, where the keyboard is).

---

### Dock Item Active

**Role:** Everything on the dock that opens a popover: the docked-panel chips (terminal and agent, tab group, file/browser/plugin), the status pills (Background, Waiting, Errors, Trash), the launch pill. Use a neutral lift — no accent border or ring.

```tsx
// chips — src/components/Layout/dockChipStyles.ts
cn(DOCK_CHIP_CLASS, isOpen && DOCK_CHIP_OPEN_CLASS);
// status pills — src/components/Layout/dockStatusPill.tsx
cn(DOCK_STATUS_PILL_CLASS, isOpen && DOCK_STATUS_PILL_OPEN_CLASS);
```

**Usage:** The accent border+ring active treatment previously documented here was deliberately retired (commit `e30d29638`, "replace accent ring on popover-open dock buttons with neutral lift"), first for the pills and then for the chips, which had kept it as a copy-pasted class string in three files. Do not respell either state — import the constants.

- **Open** is the neutral ladder's top rung: `bg-overlay-emphasis` on the pills; `--dock-item-bg-active` / `--dock-item-border-active` on the chips, whose `:root` defaults are `overlay-emphasis` and `border-strong` and which light themes lift to white. Neither default nor any theme override may be accent-derived. The open fill is repeated under `hover:` so pointing at an open item never drops it back to the hover step.
- **Hover** is one fill for the whole strip: `--dock-item-bg-hover` (`overlay-medium`), chips and pills alike.
- **Agent-state glyph** on a chip is `DOCK_STATE_GLYPH_CLASS` (12px), the size the tab strip, panel header and sidebar draw it beside a 14px kind icon. The plain-command spinner and finished check in the same slot take the same size.
- **Separators** inside a chip (title | command) are `bg-border-divider`, like every other separator.
- The launch pill (`DockLaunchButton.tsx`) intentionally does NOT keep its accent focus-visible ring after a pointer-dismissed dropdown (see comment near `wasPointerCloseRef`); keyboard dismissal still restores focus for WAI-ARIA.

Pinned by `src/components/Layout/__tests__/dockFamily.contract.test.ts` and the accent guard.

---

### Dock Status Popover List

**Role:** The lists inside the Background, Waiting, Errors and Trash popovers — short, sectioned ("This worktree" / "Other worktrees"), each row a panel with a primary action and a few secondary buttons.

```tsx
<div className={DOCK_POPOVER_HEADER_CLASS}>…</div>
<DockPopoverList>
  <div data-dock-row="" className={cn(rowLayout, DOCK_POPOVER_ROW_HOVER_CLASS)}>…</div>
</DockPopoverList>
```

**Usage:** All from `src/components/Layout/dockStatusPill.tsx`.

- **Header** — padding and a bottom divider, no fill of its own: the popover is the surface.
- **List** — `DockPopoverList`: a compact `ScrollShadow` (the overflow cue under auto-hiding scrollbars) with one height cap for all four, `min(360px, available height − 5rem)`. Never a local `max-h-[…]`.
- **Row hover** — `DOCK_POPOVER_ROW_HOVER_CLASS`, the [List Row Hover](#list-row-hover) step with the 150ms colour transition. A row's state (waiting, working) is its glyph and label, never a coloured rail or wash. A group's header is its own row; the group wrapper does not hover, so a member and its group never light together.
- **Keyboard** — after the NotificationCenter popover. A keyboard-opened pill focuses the popover root (`useDockPopoverFocusHandoff`), and Down/Home or Up/End enters the list; a pointer open leaves focus on the pill. The list is one Tab stop: Up/Down/Home/End move between rows onto each row's primary control (`data-dock-row-target`, else its first button), Left/Right move across that row's own buttons, and only the current row's buttons are tabbable. Keyboard focus is the focus ring, never a second fill.
- **Right-click** — a row that stands for a panel (Waiting, Background) opens that panel's own `TerminalContextMenu` as a `proxy` (see [Context Menu Targets](#context-menu-targets)), scoped to the row's `terminalId`. The menu is correct from there: a backgrounded panel offers Restore from background rather than moves, and a pane outside the active worktree is not offered Maximize.

---

### Highlighted Row

**Role:** The one row a surface is on right now: the row in a palette, picker, autocomplete, menu or select that Enter (or a click) will act on; the selected record in a list-detail browser; the page a navigation list is showing (the settings sidebar, global and project). One mark for all of them, so a user learns it once.

```tsx
"palette-row relative border border-transparent transition-colors aria-selected:bg-overlay-highlight aria-selected:text-text-primary";
```

**Usage:** Do not respell this — import `PALETTE_ROW_CLASS` from `src/components/ui/paletteRowStyles.ts`. The Radix item primitives (`dropdown-menu.tsx`, `context-menu.tsx`, `select.tsx`) paint the same `data-[highlighted]:bg-overlay-highlight`, so a highlighted row reads the same in every family.

The language, in full:

- **Highlighted** — a neutral `overlay-highlight` fill and nothing else. No leading rail, no outline, no accent.
- **One cursor** — the pointer and the arrow keys move the same highlight. Rows call the palette's hover callback on `pointermove` (never `pointerenter`, so rows scrolling under a resting pointer don't steal it) and carry no `hover:bg-*` of their own. Two lit rows is a defect.
- **Committed value inside a picker** — the current project, the settings page a subject picker is on, the saved theme — is a check mark or a label with `aria-current`, never a competing fill, because the fill belongs to the cursor there.
- **Selected in a list-detail or navigation list** — the selected record, or the page a nav list is showing, takes the highlight fill itself, and hover is a lighter step in the same direction (`overlay-subtle` on dark; on light, the settings sidebar's white lift and a half-strength white hover). The pointer does not move that selection — pointing at a settings page must not open it. Where the list is keyboard-navigable (the settings nav is a roving-focus tablist with manual activation), keyboard focus is its own focus ring on top, never a second fill. No accent tint and no edge marker — the settings nav's sliding accent bar and its per-theme accent-tinted fills were removed for this.
- **Destructive** — the highlighted fill swaps to `status-danger/10` with danger text; that is a semantic, not a second selection mechanism.
- **DOM focus** — rows that hold real focus (Radix items) add their inset `selection-outline` ring on keyboard focus, as every focused control does.
- **Increased contrast / forced colours** — `prefers-contrast: more` outlines the highlighted row in `selection-outline`; `forced-colors` outlines it in `Highlight`. Both live in `src/index.css`, in their separate blocks.

`overlay-highlight` is its own token rather than `overlay-raised` because, with no rail beside it, the fill alone has to be findable at a glance: 6% on dark (the `overlay-elevated` step brand marks are already measured against), the raised plane on light. WCAG 2.2's Understanding text for 1.4.11 does not hold a colour change between states of one component to 3:1, and hover treatments are supplemental; `selection-outline` is still gated at 3:1 against the fill and the surface (`getPaletteSelectionWarnings`) because it is drawn on the fill as a ring and as the increased-contrast outline.

A leading rail is not part of this language anywhere. It was removed from highlighted rows because it made the pointer and the keyboard draw different rows differently and read as heavier than every shipping palette's fill-only highlight (VS Code, Linear, Raycast, macOS menus, Radix).

`palette-row` is a hook for the two high-contrast blocks, not styling. The forced-colours outline is deliberately an outline and not a `SelectedItem` fill: these rows carry independently surfaced children (theme "Active" badges, action category chips, panel-kind icons with inline colour), and a fill would leave them painting on a pair with no contrast guarantee. The marker scopes those rules to palette rows, since `[role="option"]` is also used by the file pane, the settings selectors and the agent/forge dropdowns. Forge and commit rows, which spend `aria-selected` on membership, key the same fill off `data-active` and the same outlines off `.forge-row`.

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
"focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2";
```

**Usage:** 2px outline with 2px offset satisfies WCAG 2.2 SC 2.4.13 (3:1 contrast ratio and size requirements). Requires `focus-visible:outline` base class to enable outline rendering. Used in `src/components/ui/input.tsx` (`inputVariants`).

---

### Inset Focus Ring

**Role:** Flush list items, tree nodes, or elements with no gaps where outline shouldn't overlap adjacent items.

```tsx
"focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px]";
```

**Usage:** Negative offset keeps indicator inside element bounds. Use when elements are packed tightly (e.g., list items, file tree rows, segmented options, timeline segments) where default offset would bleed into neighbors, or when the host clips (`overflow-hidden` title groups and footers, a scroller with no padding). These are the only two offsets: `+2` outside, `-2` inside. Offsets of `0` or `±1` are not a third option.

**Radix row exception (menu, context-menu, select items):** these use `focus-visible:outline-selection-outline`, not accent, and add `focus-visible:outline-solid`. Both are deliberate, so a consistency pass should not "correct" them. `selection-outline` is the only ink `getPaletteSelectionWarnings` in `shared/theme/contrast.ts` holds to 3:1 against the raised `data-[highlighted]` fill, a destructive row's `status-danger/10` fill, and the `.surface-overlay` behind them — the three colours this ring actually touches; accent is scored against the display surfaces only. `outline-solid` is load-bearing wherever the element also carries `outline-hidden`, which these rows keep so `forced-colors` can still recolour the outline: `outline-hidden` sets `--tw-outline-style: none` on the element and the width utility reads that same variable back, so the ring paints nothing without it. `focusRingFallback.contract.test.ts` enforces the ring's presence, effective width, offset, style and that its ink paints something — but not that the ink is this particular token, which is why this note exists.

---

### Search Field

**Role:** Every place the app offers a query box — the Worktrees rail, the settings nav search, settings-page filters, palette header inputs, find bars, log and audit filters. One control: two inset sizes (dense and compact) plus the palette header size.

```tsx
<SearchField size="compact" value={q} onChange={...} onClear={...} aria-label="Search worktrees" />
```

**Usage:** Use `SearchField` (`src/components/ui/SearchField.tsx`); never hand-roll a wrapper, magnifier and input. Styling lives in `src/styles/components/search-field.css`, inside `@layer components` so a caller's utilities (a width, a flex basis) win. Two inset sizes and a header size, and sites never set their own height: `compact` is 28px `text-xs` for rails, nav columns and dropdown headers; `dense` is 24px `text-xs` for filter strips and pane toolbars, level with xs chips and icon buttons; `palette` is 38px `text-sm` for palette and dialog headers (`AppPaletteDialog.Input` renders it).

**Escape** clears before it closes. A `SearchField` given `onClear` claims Escape while it holds a query — clears it and stops the key there — and lets an empty field's Escape fall through to the surface. It runs after the caller's own `onKeyDown` and stands down if that handler claimed the key (a field that first closes its own popover), and during IME composition. Inside a Radix popover the layer dismisses on capture before the field sees the key, so the popover passes `clearSearchBeforeDismiss` from its `onEscapeKeyDown`. A site that can type a query has a clear button: pass `onClear`. In-page find bars (terminal, browser) are the exception: they own Escape and have no clear button.

Rest is a recessed well (`surface-canvas`, or the site's theme hook through `--search-field-bg`) with a `border-default` hairline: the magnifier (`text-secondary`) identifies the field, so it does not need `border-input`'s 3:1 edge (WCAG 1.4.11 asks for a boundary only when nothing else identifies the control). Focus is neutral: the edge steps to `selection-outline` and a wash layer fades in on the 150ms tier (a white-ink `overlay-hover` on dark; on light, a lift toward `surface-panel-elevated`, since ink over a pale well reads as grime). **No accent** — palette inputs are focused whenever their palette is open, and the owner ruled against an accent ring on search fields. The placeholder takes `text-secondary`, not the form placeholder tier: it is the field's visible label. `invalid` swaps the edge to `status-danger`. Forced-colors and increased-contrast handling are in the family CSS (separate blocks, forced-colors last); sites need none of their own. `PopoverSearchField` is the edge-to-edge strip variant at the top of a filtering popover and shares the same neutral focus.

---

### Input Focus (Outline)

**Role:** Every field-like control: text inputs, textareas, select triggers, dialog form fields (`FIELD_INPUT`, `FIELD_TRIGGER`). One focus language for all of them. Pre-allocate border width; only change color to avoid layout shifts.

```tsx
"focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2";
```

**Usage:** Rest is `bg-surface-input` with a `border-border-input` edge — the 3:1 boundary a field needs when the edge is all that identifies it. On focus, the outline is added — do NOT change `border-width` or the border colour. Changing width causes layout jitter, and a 1px colour shift is too small an area to be the indicator (WCAG 2.4.13). `focus-visible`, never `focus`: Radix returns focus to a select trigger after a pick, and a ring lit by every mouse choice is noise. Used in `src/components/ui/input.tsx` (`inputVariants`), `src/components/ui/textarea.tsx` (`textareaVariants`) and `src/components/ui/select.tsx` (`selectTriggerVariants`); the settings wrappers and `Worktree/views/WorktreeFormLayout.tsx` compose those rather than restating the recipe. Search fields are the one family with their own treatment (see Search Field); `ProjectIdentityEditor`'s always-autofocused name field is a documented neutral exception for the same reason.

---

### Segmented Toggle Group Active State

**Role:** Active segment in a mutually exclusive toggle group (e.g., filter chips, tab-style selectors). Active state uses neutral overlay lift — never accent.

```tsx
"bg-overlay-medium text-text-primary border-border-strong aria-selected:bg-overlay-medium aria-selected:text-text-primary";
```

**Usage:** Combine with `transition-colors` for smooth toggle transitions. The active segment gets a neutral background fill and text emphasis; the border distinguishes it from inactive peers. Accent must NOT appear on any toggle segment. The canonical target is `overlay-medium` for the active fill.

The sliding thumb of `SegmentedRadioGroup` sits on an inset track, where `border-strong` measured only 1.5–1.7:1 and the fill barely moves. It uses `border-text-secondary` for the boundary instead, which clears SC 1.4.11's 3:1 in both polarities.

`SegmentedRadioGroup` is the only segmented single-choice control: every mode switch, scope switch and range picker renders through it rather than hand-rolling a track and thumb, so they share one track, one thumb, one keyboard model and one slide. The quick-state filter bars (`QuickStateFilterBar`, `PilotFilterBar`) are a deliberate separate visual family — full-width segments with counts and an underline — but share the same radiogroup keyboard model.

---

### Pressed Toggle and Filter Chip

**Role:** A button that switches a mode or setting on and off, and a pill that narrows a list by one value. The same "on" state on two shapes.

```tsx
<Button variant="outline" size="sm" pressed={groupByTurn}>Group by turn</Button>
<FilterChip selected={isActive} count={count}>Info</FilterChip>
```

**Usage:** "On" is a `text-secondary` edge over `filter-selected-bg-strong` with primary ink, on both. The edge is what carries it: it clears WCAG 1.4.11's 3:1 in both polarities, where a fill step alone measured about 1.1:1 against the panel and the old toggles read the same pressed or not. `Button`'s `pressed` prop sets `aria-pressed` and draws the edge as a ring, so it costs no layout on any variant; `aria-pressed:` utilities are emitted after `hover:` and `active:`, so hovering a pressed toggle never takes the edge away. `FilterChip` (`src/components/ui/FilterChip.tsx`) is the worktree popover's pill: a real border in every state, `font-medium` when selected (the one axis hover does not touch), and an unavailable tier for a zero count that stays clickable. Forced colours strips fills and rings, so `data-toggle` and `data-filter-chip` take a 2px `ButtonText` border there. Increased contrast needs nothing extra, since every state already has an edge. No accent on either.

**Chip or toggle.** A control that narrows a list to rows matching its value, and sits in a set of such values, is a chip: worktree facets, inbox filters, plugin categories, event context values, and the Diagnostics log levels and event categories. A control that changes how something behaves or is shown is a toggle: group by turn, ignore last hour, actual size, code only, auto-scroll, telemetry preview, the default and summary pins, the watch bell. The log levels and event categories sat in the Diagnostics dock beside the auto-scroll toggle and were drawn as toggles, but they do the worktree chips' job, so they are chips. A button that opens a filter popover (Sources, Filters) is neither and never looks pressed; the count in its label says filters are narrowing the list.

A toggle keeps one name, and a glyph shows the state rather than the action: the watch bell is `Bell` at rest and `BellDot` while watching, never a slashed bell. Chrome icon toggles use the toolbar armed chip instead (`src/styles/components/toolbar.css`). Show/hide reveal buttons and media transport keep their glyph-only idiom.

---

### Switch-Row ON State

**Role:** Settings row containing a toggle switch. The row styling stays neutral regardless of switch state; accent is confined to the switch widget's track.

```tsx
"border-border-default text-text-primary";
```

**Usage:** The row card always uses neutral border and text. A 2px left rail (`bg-state-modified`) on the row signals modified state — semantic info hue, not accent. In the default `neutral` tone (`src/components/ui/switch.tsx` `switchVariants`), the track is `bg-surface-input` with an inset `ring-border-strong` in OFF state and `data-[state=checked]:bg-text-primary` in ON state — the ON fill is neutral text color, not accent. Accent on this widget is confined to the focus outline (`focus-visible:outline-accent-primary`), never the track fill, the row card, or the modified-state rail. The Root already carries `focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2` for keyboard focus. Used in `SettingsSwitchCard.tsx` + `src/components/ui/switch.tsx`, with `SettingsSwitch.tsx` mapping the settings layer's color-scheme names onto the primitive's tones.

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
"text-xs bg-overlay-soft border border-transparent text-text-primary focus:outline-hidden transition-colors";
```

**Usage:** The base border is neutral — `border-transparent` over an `bg-overlay-soft` fill, swapping to `border-status-error` on validation error. Use `text-xs` for compact inline inputs. The current implementation in `TabButton.tsx` (rename input) has converged on this neutral pattern and no longer uses any accent-tinged border. Note it uses `focus:outline-hidden` rather than the accent focus outline — the overlay fill plus the surrounding tab chrome already signal the edit state.

---

## Button States

One treatment per state, owned by `Button` (`src/components/ui/button.tsx`). A site that rebuilds one of these by hand is the inconsistency, not a variant of it.

- **Busy** — `loading`. The spinner overlays the label, which stays in place to hold the width and the accessible name; the button keeps keyboard focus and vetoes activation. Never swap the label to "Saving…", never put a `Spinner` in place of the icon, and never pair it with `disabled` for the same flag — `loading` outranks `disabled`, and the primitive neither natively disables nor dims a busy button. A rotating refresh glyph (`SpinningIcon`) on a refresh control is the one other busy pattern, with a static label.
- **Unavailable** — `disabled`, or `aria-disabled` plus `ARIA_DISABLED_CLASSES` when focus must survive: 50% opacity and `cursor-not-allowed`. Never 40% or 60%, and never a colour change alone. The ReviewHub primary CTAs keep their documented inset treatment (`REVIEW_HUB_DISABLED_CTA`).
- **Destructive** — `ghost-danger` (red at rest) for inline and row actions, filled `destructive` for a confirmation's footer. The exception is sidebar chrome (worktree cards, deleted-worktree rows), which stays neutral at rest and turns red on hover and focus: the sidebar repeats these on every card, and its red belongs to the interaction and the confirm. A fix action on an error band (Retry, Restart) is not destructive and is `outline`, like `InlineStatusBanner`'s.
- **Icon gap** — the size carries it (`default` 8px, `sm` 6px, `xs` 4px). Never add `mr-*`/`ml-*` to an icon inside a Button, and let the size set the glyph too.
- **Size** — pick the size whose height you want. `sm` forced to `h-6` is `xs`; `icon` forced to `h-7 w-7` is `icon-sm`. A row action under 24px fails WCAG 2.5.8: use `icon-xs` with a negative margin when the row cannot grow.
- **Copied** — `CopyButton` for any copy button, labelled or icon-only; it owns the check glyph, the "Copied" label swap, the dwell and the announcement. The check is neutral, never `text-status-success`. Menu-row copies confirm with a toast instead. See [Copy feedback](./component-contract.md#copy-feedback).

---

## Context Menu Targets

A right-click menu is scoped to the object under the pointer, never to whatever encloses it. Every tab owns its own menu, and so does every row that stands for something (a session, a file, a rescue chip). A tab strip inside the active panel's trigger, or a session row inside a worktree card's, must not fall through to the enclosing menu.

- **Panel stand-ins** — a tab, sidebar session row, rescue chip or dock status-popover row (Waiting, Background) wraps itself in `TerminalContextMenu` with `proxy`. A proxy stops the event at itself and leaves `data-context-trigger` to the panel's own surface, so `openPanelContextMenu` (Shift+F10) still finds the panel and not a row that stands for it. Grid and dock tabs get this from `TabButton`; pass `menuLocation` so layout commands match the strip.
- **Any other nested trigger** — pass `stopContextMenuPropagation` from `ui/context-menu` as the inner trigger's `onContextMenu`. Never `preventDefault()` there: Radix skips its own open when the default is already prevented. File rows use `stopFileRowMenuPropagation`, which does the same job.
- **A chip that stands for a group** (a dock tab-group chip) shows one member's identity, and its menu is that member's.
- **Canonical:** `PortalToolbar.tsx` (per-tab menu), `TabButton.tsx`, `WorktreeTerminalSection.tsx`, `HelpSessionTabs.tsx`. Pinned by `TabButton.contextMenu.test.tsx`, `WorktreeTerminalSection.contextMenu.test.tsx` and `HelpSessionTabs.contextMenu.test.tsx`.

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
| Quick Switcher Item | `QuickSwitcherItem.tsx` | Highlighted row via `PALETTE_ROW_CLASS`, pointer moves the cursor |
| Text Input | `ui/input.tsx` (`inputVariants`) | Input focus with outline ring |
| Select Trigger | `ui/select.tsx` (`selectTriggerVariants`) | Input chrome and outline ring |
| Search Field | `ui/SearchField.tsx` + `styles/components/search-field.css` | Search field (neutral focus, no accent) |
| Textarea | `ui/textarea.tsx` (`textareaVariants`) | Input focus with outline ring |
| Button Ghost | `button.tsx` (`ghost` variant) | Ghost button hover with overlay-hover |
| Button Link | `button.tsx` (`link` variant, `inline` size) | Underlined secondary text that inherits its sentence |
| Dock Launch Button | `DockLaunchButton.tsx` (`pill` variant) | Neutral lift, no accent active state |
| Dock Chip | `dockChipStyles.ts` (`DockedTerminalItem`, `DockedTabGroup`, `DockedNonPtyPanelItem`) | Neutral open lift shared with the status pills, 12px state glyph |
| Dock Status Popover | `dockStatusPill.tsx` (`DockPopoverList`, Waiting/Background/Status/Trash) | Shared header, scroll-shadowed list, row hover, one-Tab-stop keyboard list |
| Settings Subtab | `SettingsSubtabBar.tsx` | Active tab with bottom border accent |
| Document Tab | `ui/document-tab.tsx` (`TabButton`, `PortalToolbar`, `HelpSessionTabs`) | Accent underline on a lifted fill, one close control, manual activation |
| Worktree Card | `WorktreeCard.tsx` | Card hover with neutral overlay + ambient elevation |
| Settings Switch Row | `SettingsSwitchCard.tsx` + `ui/switch.tsx` | Neutral row, neutral switch track (accent only on focus) |
| Portal Drag Handle | `PortalToolbar.tsx` (`isDragging`) | Drag state with elevation + scale, no accent |
| Inline Rename Input | `TabButton.tsx` (rename input) | Neutral `bg-overlay-soft`, transparent border |

---

## Where Accent IS Allowed

Accent color is a scarce resource, not a default. These are the only contexts where accent is permitted:

- **Focus rings** — Every interactive element. `focus-visible:outline-accent-primary` on buttons, inputs, list items, tree nodes. Search fields are the exception: they take the neutral `selection-outline` edge (see Search Field).
- **Primary view anchor** — The single load-bearing signal per active focus region: armed terminal, focused worktree card, primary CTA button.
- **Editor caret** — The terminal cursor is a singleton position anchor. (`--color-terminal-cursor-accent` in `src/index.css`.)
- **Theme mockup chrome** — Swatches and preview strips that display a theme's accent color are data, not interactive chrome (e.g., `PaletteStrip.tsx`, `AppThemePicker.tsx`).
- **Status-tone routing** — Where `accent` is one option among `success`/`warning`/`danger` for mapping a semantic state to a color (e.g., `SettingsSwitchCard.tsx` `COLOR_SCHEMES`, where `accent` tints the row's leading icon).

For everything else, use the neutral overlay ladder (`bg-overlay-*`, `border-overlay`) or structural tokens (`border-border-strong`, `text-text-primary`).

---

## See Also

- [Theme Token Reference](./theme-tokens.md) — Full token documentation including overlay ladder and focus tokens
- [Theme System](./theme-system.md) — Three-layer theming pipeline and component overrides
- [Visual Design Guide](./visual-guide.md) — Complete surface-by-surface visual description
