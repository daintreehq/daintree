// Shared LIFO backstop for AppDialog and AppPaletteDialog Escape handling.
//
// Each open dialog registers a close-handler here. A single document-bubble
// Escape listener fires only the topmost registered handler, so layered
// dialogs (e.g. Settings underneath an Action Palette) close one at a time
// — preserving LIFO semantics even when Radix DismissableLayers preempt
// the regular escape-stack dispatcher in capture phase.

const stack: Array<() => void> = [];

export function registerDialogEscapeBackstop(handler: () => void): () => void {
  stack.push(handler);
  return () => {
    const idx = stack.lastIndexOf(handler);
    if (idx !== -1) stack.splice(idx, 1);
  };
}

export function isTopmostDialogBackstop(handler: () => void): boolean {
  return stack[stack.length - 1] === handler;
}

// Capture-phase probe runs BEFORE Radix DismissableLayer's capture handler
// (we install it at window-capture, the outermost target). It records
// whether ANY Radix layer was OPEN at the time the Escape key entered the
// event chain. The bubble backstop reads this snapshot to distinguish:
//
//   - Real Radix handling: a layer was open → Radix legitimately closed it
//     → backstop must NOT fire (otherwise the dialog underneath also closes).
//
//   - Spurious mid-exit Radix preventDefault: no layer was open at capture
//     time → Radix's `preventDefault` came from a stale `data-state="closed"`
//     layer still mounted by Presence → backstop SHOULD fire.
//
// Without this capture-time snapshot we cannot tell the two cases apart at
// bubble time, since by then Radix has already flipped the open layer to
// `data-state="closed"`.
let radixLayerOpenAtCapture = false;

// Flag set by the backstop when it has consumed the current Escape event.
// `useGlobalEscapeDispatcher` (window bubble) checks this and bails so the
// dialog underneath the one the backstop just closed doesn't also close.
// We avoid `e.preventDefault()` for that purpose because some downstream
// focus-restoration paths skip when the event was preventDefault'd.
let backstopConsumedEscape = false;

if (typeof window !== "undefined") {
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      radixLayerOpenAtCapture = isAnyRadixLayerOpen();
      backstopConsumedEscape = false;
    },
    true
  );
}

function isAnyRadixLayerOpen(): boolean {
  // Match every Radix primitive that mounts a DismissableLayer with an
  // Escape handler: Popover, Select, DropdownMenu, ContextMenu, HoverCard,
  // Tooltip. Dialogs are matched separately (`role="dialog"` without
  // `aria-modal`) — modal Dialogs are AppDialog/AppPaletteDialog and live
  // in the backstop stack, not the Radix-layer category.
  return (
    document.querySelector(
      '[role="listbox"][data-state="open"], ' +
        '[role="menu"][data-state="open"], ' +
        '[role="tooltip"][data-state="open"], ' +
        '[role="dialog"][data-state="open"]:not([aria-modal="true"])'
    ) !== null
  );
}

export function radixLayerWasOpenWhenEscapePressed(): boolean {
  return radixLayerOpenAtCapture;
}

export function markBackstopConsumedEscape(): void {
  backstopConsumedEscape = true;
}

export function backstopAlreadyConsumedEscape(): boolean {
  return backstopConsumedEscape;
}
