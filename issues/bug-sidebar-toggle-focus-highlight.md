# Bug: highlight outline on sidebar/sidecar toggle after Esc

## Summary
When clicking the sidebar (left) or sidecar (right) toggle buttons in the top toolbar and then pressing `Escape`,
the toggle button shows a prominent focus outline/highlight. This reads like a “stuck highlight” state and is
visually distracting in the toolbar.

We should either eliminate the post-`Esc` highlight entirely or (preferred) make the app-wide focus indicator
significantly more subtle: a very faint white focus ring (low opacity) instead of the current bright accent green.

## Current Behavior
- Repro:
  1) Click **Toggle Sidebar** (left toolbar button)
  2) Press `Escape`
  3) The button shows a visible focus outline
- Same behavior for the **Context Sidecar** toggle button (right toolbar group).

Code locations:
- Toolbar toggle buttons:
  - `src/components/Layout/Toolbar.tsx:218` (sidebar show/hide)
  - `src/components/Layout/Toolbar.tsx:606` (sidecar open/close)
- Default button focus styling:
  - `src/components/ui/button.tsx:7`

## Root Cause
The toolbar toggles are `Button` components that apply a `focus-visible:outline` with the accent color. After
pressing `Escape`, keyboard modality is detected and the currently-focused button becomes `:focus-visible`,
so the accent outline appears.

This is correct behavior from an accessibility standpoint (focus should be visible for keyboard users), but the
current styling is too “loud” for the toolbar context.

## Desired Behavior
- Focus indication remains (keyboard accessibility), but it is:
  - subtle (faded white / low opacity),
  - consistent across the app (“general highlight for the system”),
  - not confused with “selected/active” state.
- Specifically for the toolbar toggle + `Escape` flow:
  - No bright green outline; the focus indicator should be barely-there.

## UX Proposal
### Focus indicator styling (app-wide)
- Use a subtle white ring as the default focus indicator:
  - Color: white with low opacity (start around `rgba(255,255,255,0.18)`; adjust after visual check)
  - Thickness: `2px` (or `1px` for tight icon buttons, if needed)
  - Offset: small, but avoid expanding the toolbar height (prefer ring vs outline-offset pushing layout)

### Component-level guidance
- Prefer `ring`-based focus styles (`box-shadow`) over `outline`, since the design system already has a `--ring`
  token and many components use `focus-visible:ring-*`.
- Keep special-case focus colors for semantic actions only (e.g., destructive buttons may keep red focus if they
  already do so intentionally).

## Implementation Guide
### 1) Add a dedicated focus color token
Add a Canopy token for focus color in `src/index.css` under `@theme inline`:
- `--color-canopy-focus: rgba(255, 255, 255, 0.18);`

Then map Shadcn/Tailwind ring tokens to it in `.dark`:
- Change `--ring` from `var(--color-canopy-accent)` to `var(--color-canopy-focus)`
- (Optional) also change `--sidebar-ring` to `var(--color-canopy-focus)` for consistent sidebar components

Why:
- Anything using `ring-ring` becomes subtle immediately and consistently.

### 2) Update the shared `Button` focus style to use the ring token
In `src/components/ui/button.tsx`, replace the outline-based focus styling with the ring token:
- From:
  - `focus-visible:outline ... focus-visible:outline-canopy-accent ...`
- To (suggested baseline):
  - `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0`

Notes:
- `ring-offset` should generally be `0` for icon buttons in the toolbar to avoid “floating” rings that look like
  a halo; increase offset only where it helps legibility.
- Keep the existing `*:focus-visible` transition in `src/index.css` (it already animates `box-shadow`).

### 3) Sweep “accent focus” usages where they feel too loud
Search hits to evaluate:
- `rg -n "focus-visible:outline-canopy-accent|ring-canopy-accent" src`

Update high-visibility/always-present UI (toolbar, dock buttons, settings list items) to use `ring-ring` or
an equivalent subtle style.

Keep exceptions:
- Places where focus color communicates semantic meaning (error actions already use
  `focus-visible:outline-[var(--color-status-error)]`).

### 4) Optional: reduce “stuck focus” for pointer interactions (only if needed)
If the subtle ring still reads as a bug in the toolbar, consider blurring icon buttons after pointer activation
only (do not blur keyboard activation):
- Add `onPointerUp` handler that calls `e.currentTarget.blur()` when `e.pointerType !== "keyboard"`.

This is optional; prefer keeping focus visibility for keyboard and relying on the subtle ring.

## Acceptance Criteria
- [ ] Clicking the sidebar toggle then pressing `Escape` does not show a bright accent-green outline.
- [ ] Focus indication remains visible for keyboard navigation, using a subtle faded-white ring.
- [ ] The sidecar toggle behaves the same as the sidebar toggle.
- [ ] Focus styling is consistent across the app (shared `Button` + ring token).
- [ ] No regressions to obvious keyboard navigation (Tab order, visible focus on primary controls).

## QA Checklist (manual)
- Toolbar:
  - Click sidebar toggle → `Escape` → subtle focus only
  - Click sidecar toggle → `Escape` → subtle focus only
  - Keyboard Tab to toggles → focus visible and readable
- Dialogs/menus:
  - Open a dialog and tab through buttons → focus visible and not too loud
- Inputs:
  - Focus a text input → ring is subtle but still discoverable

## Notes / Constraints
- Don’t fully remove focus indication globally: it harms keyboard accessibility.
- The design goal is to make focus visually distinct from “active/selected” state (active can remain accent).
