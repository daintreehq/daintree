---
paths:
  - "src/components/**/*.tsx"
  - "src/components/ui/**/*.ts"
  - "src/lib/tooltip*.ts"
---

# Overlay close-time focus and tooltips

## The problem

Radix opens tooltips on **focus** as well as hover, and every anchored overlay hands focus back when it closes. So a close left the trigger's tooltip open with the pointer nowhere near it — and because Chromium paints `:focus-visible` on a programmatic `.focus()`, a mouse user also got an accent ring nobody asked for.

## The primitives own this now

`DropdownMenu`, `Popover` and `ContextMenu` wire it once in `src/components/ui/overlay-focus-restore.ts`. **A new menu, popover, or context menu needs no per-site wiring**, and the old controlled-tooltip + `isRestoringFocusRef` pattern must not be hand-rolled again.

The policy, per close:

- **Pointer click away** → `preventDefault()` and restore nothing; the clicked target owns focus. Exception: a context menu (`restoreFocusOnPointerClose`) restores ringlessly, because its restore target is the surface the user was working in, not a control they dismissed — dropping focus on `document.body` there strands them.
- **Pointer click on an item** → `preventDefault()` and restore with `focus({ preventScroll: true, focusVisible: false })`. Never plain restoration (Chromium rings it) and never nothing (Radix has already unmounted the item, so focus falls to `document.body` and strands the keyboard user).
- **Keyboard** → leave it alone. Radix restores and the ring is correct.

Detection: `event.target.closest('[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"],button,[role="button"],a[href]')` **and** (`event.detail > 0` **or** a pointer went down inside the content during this opening). Radix implements keyboard select as a synthetic `.click()` with `detail === 0`, but its pointer-up fallback — press elsewhere, release over the item — fires one too, which the pointer-inside flag catches.

The plain interactive entries in that selector are load-bearing, not padding: a popover routinely closes from an ordinary button in its own body (`PresetColorPicker`'s Clear and Done) rather than anything role-flagged, and without them that close falls through to Radix's ringed `.focus()`.

The flags live on the overlay **root** and reset on every open. The content wrapper outlives each close, so a close that skips `onCloseAutoFocus` would otherwise strand them onto the next opening.

## The tooltip half

Element-scoped, in `src/lib/tooltipFocusSuppression.ts`: the close arms a one-shot **capture** `focusin` listener, marks whichever element focus lands on, and `Tooltip` refuses a focus-driven open for its own trigger while that mark stands. A genuine `pointerenter` clears it. React listens on the root container, below `document`, so the capture listener always wins the race.

`dismissAllTooltips()` (`src/lib/tooltipDismissRegistry.ts`) is for surfaces that can strand a tooltip **anywhere** — dialogs — and never for a menu. Blanket popover wiring was rejected in #11034.

`Select` gets the tooltip half only: returning focus to the trigger is what a combobox is supposed to do.

## Known local wiring

A consumer that preventDefaults `onCloseAutoFocus` itself keeps ownership of the outcome (`AppPalettePopover`).

Sanctioned survivors, because launching or switching moves focus away from the control entirely: `AgentButton.tsx`, `PluginTrayButton.tsx`, `DockLaunchButton.tsx` (controlled tooltip + `isRestoringFocusRef`), and `Toolbar.tsx`'s overflow menu (`isRestoringFocusPillRef`).

`ProjectSwitcher.tsx` also carries `isRestoringFocusRef` and is **not** on the sanctioned list — treat it as unreviewed rather than as precedent.

Anything else hand-rolling the pattern is a violation, not a survivor.

## Related

A `PopoverAnchor` without a `Trigger` has no focus target, so the shared policy drops focus on `document.body` — give it an explicit target and claim only the keyboard close.

`AppDialog`'s `stopPropagation` kills Radix 1.1.15+ deferred dismissal — see `docs/themes/interaction-state-recipes.md`.

Canonical: `src/components/ui/overlay-focus-restore.ts`, `src/components/ui/tooltip.tsx`.
