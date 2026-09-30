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

**Role:** Rows in a list-detail browser that are not a roving cursor — the plugin manager, telemetry and event lists, the theme browser, and every file list (the file browser tree and folder listing, the diff file shelf, the cross-worktree diff, the worktree change list and overview, the Review Hub rows) — where a click picks the record the detail pane shows, or opens it.

```tsx
LIST_DETAIL_ROW_CLASS; // src/components/ui/paletteRowStyles.ts — selected, hover and menu target in one
LIST_ROW_HOVER_CLASS; // "not-aria-selected:not-data-[selected=true]:hover:bg-overlay-subtle"
("hover:bg-overlay-subtle"); // a row with no selection state at all
```

**Usage:** Only where hover and selection are genuinely two states. In a palette, picker, autocomplete or menu the pointer moves the cursor instead — see [Highlighted Row](#highlighted-row) — and a row there must never paint its own `hover:bg-*`, or the resting pointer lights a second row beside the one Enter acts on.

A row with a selection takes `LIST_DETAIL_ROW_CLASS` and marks itself with `aria-selected` (a tree item, a listbox option) or `data-selected="true"` (a plain row carrying its own controls, with `aria-current` on its button). The hover keys off those same attributes, so it can never paint on the selected row and can never be picked by a JS ternary that drifts — the file lists had each grown `isSelected ? "bg-overlay-subtle" : "hover:bg-tint/5"`, a 5% hover over a 2% selection. Hover is always `overlay-subtle`, never a raw `tint/N`, which is off the ladder the selection is measured against. A row whose border is spoken for (the worktree overview's divider) takes `aria-selected:bg-overlay-highlight` plus `LIST_ROW_HOVER_CLASS` instead. Pinned by `src/config/__tests__/fileListRows.contract.test.ts`.

**Keyboard:** a persistent file list — the diff file shelf, the cross-worktree diff, the worktree change list, the folder listing — is one tab stop, with Up/Down stepping and Home/End jumping over the list's data rather than its mounted rows, no wrap (`useRovingRows`, `src/hooks/useRovingRows.ts`; the stepping rule is under [Highlighted Row](#highlighted-row), **Keys**). A windowed list passes `windowed` and has its tab-stop row report its mount, so while that row is scrolled out the container holds the stop and forwards focus back to it. The rows carry their own controls, so they stay buttons that rove real focus rather than becoming listbox options; Enter/Space stay with the row's button, Shift+F10 still opens the row menu (`data-row-menu`), and a control taken out of the tab order gets a key on the row (the diff shelf's viewed box is `V`). The Review Hub file list, which is a true listbox, keeps `aria-activedescendant`.

---

### Row Menu Target

**Role:** The row a right-click (or Shift+F10) context menu is open on, in any list of rows.

```tsx
ROW_MENU_TARGET_CLASS; // data-[state=open]: a 1px inset border-strong outline, primary text
```

**Usage:** An outline, never a fill. The targeted row is usually also the hovered row and often the selected one, so a fill tier has to find a free rung between them — and on light themes there is none: `overlay-raised`, which this tier used to be, resolves to the same colour as `overlay-highlight`, so the menu target was indistinguishable from the selection. A ring composes with whichever fill is under it (Finder marks its context-menu target the same way). Neutral, because the accent in a list is keyboard focus. Radix writes `data-state="open"` onto the row through the `asChild` `ContextMenuTrigger`; when a `TooltipTrigger` shares the node, the context-menu trigger must be the outer one so its `data-state` wins.

---

### Card Hover

**Role:** Worktree cards (grid variant), settings cards. Use a subtle neutral background lift plus elevation rather than large background shifts or accent borders.

```tsx
"hover:bg-overlay-subtle hover:shadow-[var(--theme-shadow-ambient)]";
```

**Usage:** A neutral overlay tint and ambient shadow signal elevation without color changes — no accent border. Used in `WorktreeCard.tsx` grid variant.

---

### Choice Cards

**Role:** A whole card that is itself the control — a quick action, a recovery choice, an agent to pick, a starter prompt, a recipe, a portal link, a plugin, a theme radio.

```tsx
<ChoiceCard onClick={run} padding="sm">…</ChoiceCard>
<label className={cn(choiceCardVariants({ selected }), "flex-col")}><input type="radio" className="sr-only" />…</label>
```

**Usage:** `ChoiceCard` / `choiceCardVariants` in `src/components/ui/card.tsx` own the whole recipe; never respell it on a raw `<button>`. Rest is outlined and unfilled (`radius-lg`, `border-border-default`), because a resting wash is what hover paints and a filled card reads as already hovered. Hover is the `Card interactive` hover — `overlay-subtle` plus the border stepping to `border-strong` — and the border step is what carries it on light themes, so there is no per-theme override. Press is the Button snap (`active:scale-[0.98]`, 1ms in) behind the `press-scale` class, which is what removes it under reduced motion; `motion-reduce:` cannot, because the utility sets the individual `scale` property. Two sizes: `md` (`p-3`) for a card with a title and description, `sm` (`px-3 py-2`) for a single line or a row of chips. `tone="elevated"` lifts the one recommended card in a set (the welcome screen's first step for a new user) with a raised surface and the strong edge, never accent; its hover layers the same wash over that surface. `tone="row"` is for a navigation list of equivalent destinations (the portal launchpad): borderless at rest, since a column of outlines repeats what the logos already say, and the full card frame on hover. Name a card by its title (`aria-labelledby`) and hang the rest on `aria-describedby`; a radio card hides its decorative preview from assistive tech. Spell every utility out whole — Tailwind only generates classes it finds verbatim in source, so a hover assembled at runtime paints nothing. A radio card is a `<label>` over a native radio, painted with `choiceCardVariants({ selected })`: its selected edge is `text-secondary` over `overlay-selected`, the Pressed Toggle edge, so a hovered option never reads as the chosen one. An action card acts on click and carries no radio puck — a circle promises select-then-submit. A read-only block that merely looks like a card is `Card variant="subtle"`, never an `overlay-subtle` wash with a border, which is the hover state. When the choice is a plain confirm or dismiss, it is a dialog footer instead (below). Pinned by `src/components/ui/__tests__/card.test.tsx` and `src/config/__tests__/choiceCards.contract.test.ts`.

**Inline answers:** a pair of actions that answers something — a dialog footer, an inline report or add form — puts the safe answer leading and the one `contrast` primary trailing, whether it sits in `AppDialog.Footer` or inline beside a field. The safe answer is `ghost`, except in Settings, where row actions and `SettingsActions` draw it `outline` (`.claude/rules/settings-pages.md`). A panel list or other form inside a dialog answers from `AppDialog.Footer`, not from a button row in the body. A nudge card is not an answer pair: the welcome banners and the tour invite lead with their `outline` call to action and follow with a ghost "Not now", left-aligned in reading order, and never fill the CTA — the screen's lead action already owns the one filled button.

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

### Popover Header

**Role:** The strip across the top of any popover that has a title: the dock status popovers, the pane-header chip popovers (subagents, notices), the Codex session finder, recent tool calls, PR checks. Also the rules for the chips that open them and the small controls inside them.

```tsx
<div className={POPOVER_HEADER_CLASS}>
  <span id={headingId} className={POPOVER_TITLE_CLASS}>
    Codex sessions in this folder
  </span>
  <Button
    variant="ghost"
    size="icon-xs"
    className={POPOVER_HEADER_ACTION_CLASS}
    aria-label="Refresh sessions"
  >
    …
  </Button>
</div>
```

**Usage:** All from `src/components/ui/popoverHeader.ts`. `DOCK_POPOVER_HEADER_CLASS` and `DOCK_POPOVER_ROW_HOVER_CLASS` are the same constants under the dock's names.

- **Title strip** — `px-3 py-2`, `border-b border-divider`, no fill: the popover is the surface. The title is `text-xs font-medium` in secondary ink, because the list below is the content; a qualifier beside or under it is `POPOVER_HEADER_META_CLASS`. The popover takes `aria-labelledby` pointing at the title. In a popover with its own `p-1` inset (the fleet list), the strip cancels it with `-mx-1 -mt-1` so the rule runs edge to edge; a back button in the strip (the fleet picker) is a ghost `xs` Button trimmed with `-my-1`. A popover whose first line is a computed verdict rather than a name (PR checks: "2 checks failing") keeps the strip but gives the verdict primary ink, since it is the answer the reader opened it for.
- **Field strip** — a strip that holds a field (a search, the project name) keeps `p-3` so the field has room, and shares only the divider. The forge dropdowns' search strip, the worktree filter, the project identity editor and the event filters all do this. It is not a title strip, so it never takes the title padding.
- **Palette search strip** — the palette family's header (`AppPaletteDialog.Header`, and `FleetPickerContent`, which mounts in both the palette and the fleet popover) keeps the palette's `border-border-strong`, as does the Cmd+K HUD. That family has its own recipe and is not a popover header.
- **Rules** inside a popover (header, footer, section breaks) are `border-divider`, and a `divide-y` list between groups uses the same token through `divide-divider` (defined beside `border-divider` in `src/index.css`, since the divider is not a Tailwind theme colour). Not `border-[var(--border-divider)]`, `border-border-default`, `border-border-subtle` or the legacy `border-daintree-border`.
- **Header actions** — an icon button in the strip is a ghost `icon-xs` Button with `POPOVER_HEADER_ACTION_CLASS`, which trims it into the strip's height and sits its 14px glyph on the strip's inset. A busy refresh stays focusable (`aria-disabled`, the spin is the busy state).
- **Row hover** — `POPOVER_ROW_HOVER_CLASS`, the [List Row Hover](#list-row-hover) step. A row band that already rests on `overlay-subtle` (the fleet picker's worktree header) hovers to `overlay-hover`, one step up. Never a `tint/[…]` hover.
- **Empty and loading** — an empty list is `EmptyState scale="popover"`; a loading list is a `Skeleton` in the rows' own shape, never a spinner and a sentence.
- **Chip triggers** — a pane-header chip that opens a popover adds `HEADER_CHIP_TRIGGER_CLASS` (`src/components/Terminal/terminalHeaderChip.ts`): hover and open lift the fill to `overlay-medium`, one step over the chip's `overlay-soft` rest. A neutral chip's ink also steps to primary on hover; a toned chip (waiting, warning) keeps its tone. Open is read from `aria-expanded`, because a chip that is also a tooltip trigger carries the tooltip's `data-state`.
- **Small icon buttons** in and around these popovers are ghost `icon-xs` Buttons with a 14px glyph (`[&_svg]:size-3.5`); an X that dismisses a row is `DismissButton`. Where the host clips (pane header, a popover's scroller), ring inside with `focus-visible:-outline-offset-2`.

Pinned by `src/components/ui/__tests__/popoverHeaders.contract.test.ts`.

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
- **Keys** — one stepping rule. A list that writes its own key handler steps through `stepListboxCursor` (`src/hooks/useListboxCursor.ts`) rather than its own `Math.min`/`Math.max`; `useListboxCursor`, `useSearchablePalette`, `useBranchPicker`, `MoveToWorktreePicker`, `useRovingRows` and the dock popover list implement the same rule themselves. A palette, picker, autocomplete or suggestion list wraps: Down past the last row comes round to the first, Up past the first to the last. A combobox that has a resting position on the field itself (the typed address, the typed command, the commit search) passes `allowNone`, so Up from the first row returns to the field and a lap goes through it once. Home and End jump to the first and last row whenever the list is showing and has rows — they leave the caret alone only while it is shut or empty. A persistent list that roves focus or previews as it moves (the file lists, the Review Hub, the theme browser, the dock status popovers, the fleet picker) takes `wrap: false` and holds at its ends, because one press too many there throws the user to the far end of a long list; it still takes Home and End. The list steps on bare keys only (`hasKeyModifier`): Shift+Home selects the query, Cmd+Arrow moves the caret, and a chord belongs to whatever bound it. Two documented exceptions leave Home and End with the caret: the settings search field (#12965) and the theme browser's search field, whose lists sit beside a field the user is still editing; and the hybrid input bar's autocomplete, which lives in a multi-line editor where Home and End are line keys.
- **Committed value inside a picker** — the current project, the settings page a subject picker is on, the saved theme — is a check mark or a label with `aria-current`, never a competing fill, because the fill belongs to the cursor there.
- **Selected in a list-detail or navigation list** — the selected record, or the page a nav list is showing, takes the highlight fill itself, and hover is a lighter step in the same direction (`overlay-subtle` on dark; on light, the settings sidebar's white lift and a half-strength white hover). The pointer does not move that selection — pointing at a settings page must not open it. Where the list is keyboard-navigable (the settings nav is a roving-focus tablist with manual activation), keyboard focus is its own focus ring on top, never a second fill. No accent tint and no edge marker — the settings nav's sliding accent bar and its per-theme accent-tinted fills were removed for this.
- **No other mark lights a row.** A transient "you arrived here" flash (a deep link, a scroll-to) selects its target and lets the highlight do the work; a separate bordered fill outlives the selection when it moves and leaves two rows lit.
- **Destructive** — the highlighted fill swaps to `status-danger/10` with danger text; that is a semantic, not a second selection mechanism.
- **DOM focus** — rows that hold real focus (Radix items) add their inset `selection-outline` ring on keyboard focus, as every focused control does.
- **Increased contrast / forced colours** — `prefers-contrast: more` outlines the highlighted row in `selection-outline`; `forced-colors` outlines it in `Highlight`. Both live in `src/index.css`, in their separate blocks.

`overlay-highlight` is its own token rather than `overlay-raised` because, with no rail beside it, the fill alone has to be findable at a glance: 6% on dark (the `overlay-elevated` step brand marks are already measured against), the raised plane on light. WCAG 2.2's Understanding text for 1.4.11 does not hold a colour change between states of one component to 3:1, and hover treatments are supplemental; `selection-outline` is still gated at 3:1 against the fill and the surface (`getPaletteSelectionWarnings`) because it is drawn on the fill as a ring and as the increased-contrast outline.

A leading rail is not part of this language anywhere. It was removed from highlighted rows because it made the pointer and the keyboard draw different rows differently and read as heavier than every shipping palette's fill-only highlight (VS Code, Linear, Raycast, macOS menus, Radix).

`palette-row` is a hook for the two high-contrast blocks, not styling. The forced-colours outline is deliberately an outline and not a `SelectedItem` fill: these rows carry independently surfaced children (theme "Active" badges, action category chips, panel-kind icons with inline colour), and a fill would leave them painting on a pair with no contrast guarantee. The marker scopes those rules to palette rows, since `[role="option"]` is also used by the file pane, the settings selectors and the agent/forge dropdowns. Forge and commit rows, which spend `aria-selected` on membership, key the same fill off `data-active` and the same outlines off `.forge-row`.

**Row shape.** The highlight is shared; the box is written at each site, and it comes in two families. `src/config/__tests__/paletteRowShape.contract.test.ts` pins both, and bans a card radius (`radius-lg` and up), a resting `bg-*` fill and a border colour on any row composing `PALETTE_ROW_CLASS`:

| Family | Surfaces | Radius | Inset | Height |
| --- | --- | --- | --- | --- |
| Full-screen palette | `SearchablePalette` / `AppPaletteDialog` rows: action palette, quick switcher, worktree palette, quick create, new terminal, theme, prompt history, resume sessions | `rounded-[var(--radius-md)]` | `px-3` | `py-1.5` single line, `py-2` two lines |
| Popover picker | Anchored dropdowns whose rows sit beside menu rows: branch, agent and recipe pickers, subject picker, move-to-worktree, preset selector, env var editor, dock launch popover, project switcher | `rounded-[var(--radius-sm)]`, the menu row's radius | `px-2` | `py-1.5` (the switcher's dense scratch browse rows keep `py-1`) |

No row carries a resting fill: a backplate on every row reads as stacked cards, and the cursor then has to out-shout its neighbours instead of being the only lit row. A row whose second line is a path or a branch sets both in `font-mono`, so the two identifiers read as the same kind of thing. The height follows the row's own content: a row that renders a second line (a path, a description, a theme's location, a session's model) takes `py-2`, and one that doesn't keeps `py-1.5`, so an action palette mixes the two and the one-line prompt history is `py-1.5` throughout. Content that appears only under the cursor (the action palette's danger rationale) doesn't count, and no geometry utility takes a state prefix: a row that grows as the cursor lands on it shoves the list. The contract also rejects a second radius or padding utility on a row, `p-*` included, since `cn()` lets the later one win.

---

### Row Controls

**Role:** An inline control inside a row that is itself the focus target — a palette `option`, a launcher row, a menu item: pin, hide, assign shortcut, launch in dock, set as default.

```tsx
<RowControlTooltip label="Pin to toolbar" shortcut="Alt+P">
  <span role="presentation" onClick={…} className={cn(ROW_CONTROL_CLASS, "opacity-0 group-hover:opacity-100")} />
</RowControlTooltip>
```

**Usage:** Import both from `src/components/ui/RowControl.tsx`; never respell them. `ROW_CONTROL_CLASS` is a 24px target (WCAG 2.5.8, so never `h-5 w-5`), the Ghost recipe's `overlay-hover` fill, and a transition that names `background-color` beside `opacity` — `transition-opacity` alone snapped the fill while the reveal faded. Inside a 28px menu row it takes `-my-1` rather than shrinking. A control that owns a wider hit zone (the agent menu's set-default gutter) keeps the zone but draws the fill as a centred row control (`group-hover/gutter:`), never a full-height band.

These are `aria-hidden` or `role="presentation"` spans because a real button inside `option`/`menuitem` trips `nested-interactive`. So they have no focus and no keyboard route of their own; the row carries the chord (Alt+P, Alt+H, P, D) in its name or `aria-keyshortcuts`. `RowControlTooltip` is therefore pointer-only by construction: it names the action and shows the chord as keycaps, and it replaces `title=`, which was how every one of these explained itself. Full text of a truncated label uses `TruncatedTooltip`; inside a row that already owns the keyboard pass `focusable={false}` so it adds no tab stop. `rowControlsTooltips.contract.test.ts` pins all three rules, plus the unavailable dim below.

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

**Usage:** Rest is `bg-surface-input` with a `border-border-input` edge — the 3:1 boundary a field needs when the edge is all that identifies it. On focus, the outline is added — do NOT change `border-width` or the border colour. Changing width causes layout jitter, and a 1px colour shift is too small an area to be the indicator (WCAG 2.4.13). `focus-visible`, never `focus`: Radix returns focus to a select trigger after a pick, and a ring lit by every mouse choice is noise. Used in `src/components/ui/input.tsx` (`inputVariants`), `src/components/ui/textarea.tsx` (`textareaVariants`) and `src/components/ui/select.tsx` (`selectTriggerVariants`); the settings wrappers and `Worktree/views/WorktreeFormLayout.tsx` compose those rather than restating the recipe. Search fields are the one family with their own treatment (see Search Field). `ProjectIdentityEditor`'s name field is the one neutral field: it is autofocused on every opening, so it keeps this outline's width and offset but paints it in `selection-outline` rather than accent (an `Input` with `focus-visible:outline-selection-outline`), never a border-colour shift. On a dialog form's label rail an `Input` or `SelectTrigger` takes `FIELD_CONTROL_SIZE` so it sits at `FIELD_INPUT`'s 32px.

---

### Focused Pane Title Bar

**Role:** The compact title bar of the pane or side panel the keyboard is in: a grid pane's `PanelHeader`, the Daintree Assistant's header. One neutral step up, never accent.

```tsx
import { SURFACE_HEADER_FOCUS_LIFT_CLASS } from "@/components/ui/SurfaceHeader";
// "bg-[var(--panel-header-focus-bg,var(--color-overlay-medium))]"
<SurfaceHeader density="compact" className={cn(isFocused && SURFACE_HEADER_FOCUS_LIFT_CLASS)} />;
```

**Usage:** Import the constant; never respell the string, and never reach for `surface-highlight` (the assistant did, and read as a different family from the pane beside it). The divider under a lifted bar steps up to `--border-overlay`, which `index.css` already does for `.terminal-selected` headers and the assistant does in its own class list. Spell it `border-overlay`, never `border-b-[var(--border-overlay)]`: the frame carries `.border-divider`, a custom rule in `index.css` that outranks an arbitrary border colour utility, so the arbitrary one silently never paints. The fill stays on the bar, not the whole surface, so skeletons and empty states below keep their own background. The full pane-chrome contract (height, inset, status strip) is in [component-contract.md](./component-contract.md#pane-chrome).

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

### Resize Handle

**Role:** Every draggable edge that resizes a region: sidebar, assistant panel, two-pane split, diagnostics dock, dev-preview tool drawer, dock popovers, portal, file tree, scratchpad. One primitive, `src/components/ui/ResizeHandle.tsx`, with the keyboard in `src/hooks/useSplitterKeys.ts`. Never hand-roll the markup; the contract test rejects a `role="separator"` outside the primitive.

```tsx
// track
"outline-hidden focus-visible:bg-overlay-medium focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary";
isResizing ? "bg-overlay-medium" : "hover:bg-overlay-soft [.light_&]:hover:bg-overlay-medium";
// grip: 32px long, 1px thick at rest, 2px on hover, focus and drag
("bg-selection-outline group-hover/resize:bg-text-secondary group-focus-visible/resize:bg-text-primary"); // drag: bg-text-primary
```

**Usage:**

- **Target:** 12px across the drag axis. Edge handles (`edge="left" | "right"`) straddle the border as a `w-3` strip; a top handle (`edge="top"`) lines the inside of the edge as `h-3`; an in-flow horizontal splitter is an `h-3` row. The two-pane divider keeps the 6px track its grid template reserves and reaches 3px past each side with a `::before`, so its target is 12px too.
- **Keyboard:** arrows step and Shift+arrow takes the large step, in the direction that grows the pane (`growKey`). Home and End jump to the pane's smallest and largest size. Enter and Space reset. Arrows on the other axis are left alone. A horizontal splitter also takes PageUp/PageDown as the large step; a vertical one has no direction for them and ignores them. `aria-keyshortcuts` is generated from the same table.
- **Reset:** double-click, Enter or Space. The accessible name always ends "(double-click to reset)" — the primitive appends it, so a caller passes only "Resize sidebar".
- **Ink:** the grip is neutral in every state and every step is a solid theme token, never slash-alpha text ink. A grip is a user-interface component under WCAG 1.4.11, so it rests on `selection-outline` — the neutral indicator ink the theme contract holds to 3:1 against palette surfaces, which also clears 3:1 against the splitter surfaces on every built-in theme but three (`arashiyama` and `highlands` on `surface-panel-elevated`, `hokkaido` on `surface-grid`, 2.8–3.0:1) — and steps to `text-secondary` on hover and `text-primary` on focus and drag. `text-muted` is not a hover step: on `namib` and `redwoods` it is dimmer than the outline, so hover would read as a step down. `border-input` and `border-strong` are not substitutes: `border-input` reaches 3:1 only on the themes that opt in, and `border-strong` is a separation value (about 1.5:1 on `daintree`, 1.3:1 on `svalbard`). Hover styling is dropped while a drag is held, or the hover variant outranks the drag state and the two render identically.
- **Focus:** one solid 2px inset accent outline on the track, on every handle, including those in regions that spend accent elsewhere (dev-preview drawer, dock popovers). A focused handle is the active element of its region, so its outline is that region's one accent mark; the neutral lift alone was invisible in forced-colors and failed WCAG 2.4.7.

---

### Drag and Drop Feedback

**Role:** Every in-app drag: grid panels, dock chips and tab groups, the grid, dock and portal tab strips, worktree cards and their sessions, deleted-worktree rescues, the trash pill and the toolbar settings columns. One ink, one pickup, one ghost. Never accent: accent is the focus ring's, and a drop target can sit inside a region that already spends it.

```tsx
// src/components/DragDrop/dropIndicator.ts — ink text-primary/60 (3:1 on every built-in theme's drop surfaces)
DROP_INDICATOR_LINE; // 2px insertion line between chips, rows and tabs
DROP_SLOT_FRAME; // "border border-text-primary/60 bg-overlay-subtle": a slot held open (grid and dock placeholders)
DROP_TARGET_FRAME; // "outline-1 -outline-offset-1 outline-text-primary/60 bg-overlay-subtle": a container armed to take the drop
```

- **Target frame.** A container that accepts the drop as a whole (the grid, the dock rail, the trash pill, a toolbar settings column, a worktree card) draws `DROP_TARGET_FRAME` while the drop would land in it: the slot frame's ink and weight as an inset outline, so arming a target never shifts its layout. Not a ring: forced colours strip `box-shadow`, and the outline survives as dashed `CanvasText` (dashed because solid is the focus ring's shape there). The worktree card spells the same frame in `sidebar.css` as its `--card-edge`, because that file's unlayered base rules beat layered utilities; its selection-edge and focus rules exclude an armed card, since the active worktree is the likeliest target.
- **When it arms.** For a container that holds sortable items (the grid, the dock, a toolbar column), "over it" means over the container or any item sorted inside it, and only for something coming in from elsewhere: `useArmedDropTarget` and `isOverContainer` (`src/components/DragDrop/useArmedDropTarget.ts`). dnd-kit's own `isOver` matches the container's id alone, so the frame went out the moment the pointer crossed a chip or a row. A reorder inside the container arms nothing; its insertion line, slot or sortable gap already says where the item lands.
- **Cursor.** A drop moves or trashes, never duplicates, so an armed target never takes `cursor-copy`. The one drag state the cursor carries is rejection: `cursor-no-drop` on a dock that cannot take what is in hand.
- **Ghost.** The item in hand, wherever it still renders in its list, dims to `DRAG_GHOST_OPACITY` (0.4, `src/lib/animationUtils.ts`) and takes no lift of its own: no shadow, no scale, no opacity class. The floating overlay (`TerminalDragPreview`, `WorktreeDragPreview`, the toolbar button group overlay in `ToolbarSettingsTab.tsx`) is the lifted copy, on `--theme-shadow-floating` and never Tailwind's black `shadow-md` (see Elevation in `component-contract.md`); a tab strip with no overlay moves the dimmed tab itself.
- **Ghost headers.** `TerminalDragPreview` and `GridPlaceholder` wear the selected panel header's recipe: compact `SurfaceHeader`, `SURFACE_HEADER_FOCUS_LIFT_CLASS` and the stepped-up `border-overlay` divider that `.terminal-selected` paints, so the ghost reads as the focused panel in hand.
- **Pickup.** Every drag surface that is also a click target pairs a `MouseSensor` on `MOUSE_SENSOR_OPTIONS` (8px) with a `TouchSensor` on `TOUCH_SENSOR_OPTIONS` (150ms long-press), from `src/components/DragDrop/dragActivation.ts`, so a click turns into a drag at the same travel on a tab as on the panel it sits on. Never a `PointerSensor` there: it also takes touch, and a finger scrolling a tab strip would pick a tab up after 8px. A dedicated grip may pick up on the first move.
- **Keyboard.** Every sortable list takes `KeyboardSensor`. On a tab strip, Space and Enter select a background tab (manual activation) and pick up the tab that is already selected: split dnd-kit's `onKeyDown` out of the listeners and call it only for the selected tab (`TabButton.tsx`, `PortalToolbar.tsx`). While a keyboard drag is live the strip's own arrow-key handler stands down, since the sensor owns the arrows.
- **Grip.** A drag grip is a 24px box around a 12px `GripVertical` via `DRAG_GRIP_CLASS` / `DRAG_GRIP_ICON_CLASS` (`src/components/ui/dragGripStyles.ts`): secondary ink to primary on hover and focus, an inset accent focus outline, the grab cursors. A row that cannot move keeps the 24px slot empty so its icons stay on one rail. The worktree card's full-height gutter grip is a different control.

**Caution:** Sortable containers must NOT use `content-visibility: auto` — it virtualizes layout and causes dnd-kit drag coordinate desync. Set `contentVisibility: 'visible'` during drag operations. (See lesson #4438.) `src/config/__tests__/dragDropFeedback.contract.test.ts` pins the frame, cursor, threshold, grip and ghost rules.

---

### Inline Rename Input

**Role:** A name edited in place, where the label it replaces stood: a pane's tab and header title, a scratch workspace row in the project switcher, a custom agent preset's name.

```tsx
import {
  inlineRenameFieldClassName,
  inlineRenameFieldInputProps,
} from "@/components/Panel/inlineRenameField";
```

**Behaviour** is the same everywhere, and it is the part that drifts: select-all when editing starts, since a new name usually replaces the old one; Enter commits, unless it is confirming an IME composition (`e.nativeEvent.isComposing`); blur commits; Escape cancels; and after Enter or Escape unmounts the field, focus goes back to where the rename started (the tab, the rename button, the palette's input). Set a "settled" flag before Enter or Escape acts, so the blur that follows the unmount or the focus hand-back cannot commit a cancelled edit. Spread `inlineRenameFieldInputProps` (spellcheck, autocorrect and autocapitalise off) on every rename field. A field that creates something rather than renaming it (the scratch-workspace name) does not create on blur — creating switches to the new workspace, which is too much to do because focus moved — so its draft stays open for Enter or Escape.

**Look** depends on what the field replaces. Pane chrome (`TabButton.tsx`, the panel header title) uses `inlineRenameFieldClassName`: chrome-free by ruling (#7926), a soft `overlay-soft` wash with a transparent edge, the edge and a deeper wash appearing on focus, no accent. A rename that stands in for a row or a settings label is an `Input` with the standard accent outline, sized to the row it replaces (the scratch row's 30px, the preset label's `compact` density).

---

## Button States

One treatment per state, owned by `Button` (`src/components/ui/button.tsx`). A site that rebuilds one of these by hand is the inconsistency, not a variant of it.

- **Busy** — `loading`. The spinner overlays the label, which stays in place to hold the width and the accessible name; the button keeps keyboard focus and vetoes activation. Never swap the label to "Saving…", never put a `Spinner` in place of the icon, and never pair it with `disabled` for the same flag — `loading` outranks `disabled`, and the primitive neither natively disables nor dims a busy button. A rotating refresh glyph (`SpinningIcon`) on a refresh control is the one other busy pattern, with a static label. Busy never dims: a hand-rolled busy state (the copy-context button) shows its spinner at full strength with `aria-busy`, and keeps `aria-disabled` for genuine unavailability only.
- **Unavailable** — `disabled`, or `aria-disabled` plus `ARIA_DISABLED_CLASSES` when focus must survive: 50% opacity and `cursor-not-allowed`. Never 30%, 40%, 60% or 70%, and never a colour change alone. The same 50% applies off `Button` (segmented options, the disabled drag grip); a control whose click still goes somewhere (an agent that needs setup lands on recovery) takes the 50% and keeps its pointer. A row in a palette or menu does not fade at all: its label steps to `text-text-secondary` and the row states the reason ("Setup", "Overridden by Team"), because a fade takes the reason down with it. The ReviewHub primary CTAs keep their documented inset treatment (`REVIEW_HUB_DISABLED_CTA`).
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
| Popover Header | `ui/popoverHeader.ts` (subagent, notify, Codex sessions, recent calls, dock popovers) | Divider strip with secondary title, ghost `icon-xs` actions, chip triggers that lift on hover and open |
| Settings Subtab | `SettingsSubtabBar.tsx` | Active tab with bottom border accent |
| Document Tab | `ui/document-tab.tsx` (`TabButton`, `PortalToolbar`, `HelpSessionTabs`) | Accent underline on a lifted fill, one close control, manual activation |
| Worktree Card | `WorktreeCard.tsx` | Card hover with neutral overlay + ambient elevation |
| Settings Switch Row | `SettingsSwitchCard.tsx` + `ui/switch.tsx` | Neutral row, neutral switch track (accent only on focus) |
| Drag and Drop Feedback | `dropIndicator.ts`, `dragActivation.ts`, `dragGripStyles.ts` | Neutral insertion line, slot and target frames; 0.4 ghost; one pickup threshold; no accent |
| Inline Rename Input | `TabButton.tsx` (rename input) | Neutral `bg-overlay-soft`, transparent border |
| Progress Bar | `ui/ProgressBar.tsx` | Neutral `text-secondary` fill on an `overlay-medium` track, no accent; quota meters (`role="meter"`) keep their own heavier track |

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
