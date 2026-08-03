import { markEscapeYieldedToDialog, ESCAPE_BACKSTOP_DIALOG_ATTR } from "@/lib/dialogEscapeBackstop";

type RadixOutsideEvent = Event & {
  preventDefault: () => void;
  detail?: {
    originalEvent?: Event;
  };
};

function getOutsideEventTarget(event: RadixOutsideEvent): Element | null {
  const originalTarget = event.detail?.originalEvent?.target;
  if (originalTarget instanceof Element) return originalTarget;

  return event.target instanceof Element ? event.target : null;
}

/**
 * Prevents Radix Popover from dismissing when the user interacts with elements
 * inside a dock panel rendered via createPortal (which breaks the React context
 * chain that Radix's DismissableLayer relies on for nested floating elements).
 */
export function handleDockInteractOutside(
  event: RadixOutsideEvent,
  portalContainer: HTMLElement | null
) {
  const target = getOutsideEventTarget(event);
  if (!target) return;

  // Guard 1: Click originated inside the dock panel's portal container
  if (portalContainer?.contains(target)) {
    event.preventDefault();
    return;
  }

  // Guard 2: Click is on a Radix floating element (DropdownMenu, Tooltip, Select,
  // ContextMenu) descended from this dock popover. These portal to document.body,
  // so we can't rely on DOM containment — the dock popover's React subtree stamps
  // `data-dock-popover-child` on its own Radix content via DockPopoverChildContext,
  // which scopes the guard to *its* descendants rather than every Radix overlay
  // in the document.
  if (target.closest("[data-dock-popover-child]")) {
    event.preventDefault();
    return;
  }

  // Guard 3: Focus-driven dismissal (Radix FocusOutsideEvent) while focus lives
  // inside the portal. Typing into the portaled xterm/CodeMirror surface emits
  // `focusin`; during the portal migration the event's target can resolve to a
  // stale offscreen node so Guard 1 misses it, dismissing mid-keystroke (#8368).
  // The live `document.activeElement` is authoritative here. This is scoped to
  // focus events only — a real pointer-down outside must still dismiss even
  // while the terminal holds focus, so the pointer path never reaches here.
  const originalType = event.detail?.originalEvent?.type;
  if (
    (originalType === "focusin" || originalType === "focus") &&
    shouldSuppressDockClose(portalContainer)
  ) {
    event.preventDefault();
  }
}

/**
 * Prevents Radix Popover from dismissing on Escape when focus is inside the
 * dock panel's portal container (terminal or hybrid input editor). Allows
 * Escape-to-dismiss when focus is on header buttons or other non-terminal elements.
 */
export function handleDockEscapeKeyDown(
  event: KeyboardEvent & { preventDefault: () => void },
  portalContainer: HTMLElement | null
) {
  if (portalContainer?.contains(document.activeElement)) {
    event.preventDefault();
    return;
  }
  // A dialog opened from inside this popover (a file viewer, a kill
  // confirmation) portals to the body and traps focus, so the check above
  // misses it and Radix would dismiss the popover out from under a dialog the
  // user is looking at. The focused dialog owns Escape: block the dock's
  // dismissal and hand the keypress to `AppDialog`'s backstop, which otherwise
  // stands down on seeing this popover open (#11505).
  if (isFocusInsideBackstopDialog()) {
    event.preventDefault();
    markEscapeYieldedToDialog(event);
  }
}

/**
 * Whether focus sits inside a dialog whose Escape the shared backstop handles.
 * Scoped to that contract rather than `aria-modal`, so the popover only steps
 * aside for a surface that will actually take the keypress.
 */
function isFocusInsideBackstopDialog(): boolean {
  const active = document.activeElement;
  return active instanceof Element && active.closest(`[${ESCAPE_BACKSTOP_DIALOG_ATTR}]`) !== null;
}

/**
 * Blocks Radix's focus-driven dismissal of a dock popover outright. The hosted
 * terminal/editor is rendered offscreen and portaled into the popover
 * asynchronously, so right after open the focused node is not yet a DOM
 * descendant of the layer — Radix's DismissableLayer would fire a
 * FocusOutsideEvent and dismiss the just-opened popover (the
 * flash-open-then-minimise bug). Preventing default on the focus path
 * short-circuits that dismissal (react-dismissable-layer runs
 * `onFocusOutside → onInteractOutside → if (!defaultPrevented) onDismiss`),
 * while `onPointerDownOutside` and `onEscapeKeyDown` stay independent — so
 * clicking outside or pressing Escape still dismisses immediately. Dock
 * popovers intentionally never close just because focus moved (mirrors the
 * #8368 intent), so this is unconditional rather than time-windowed: a windowed
 * guard reintroduces the migration race the prior fixes lost.
 */
export function handleDockFocusOutside(event: RadixOutsideEvent): void {
  event.preventDefault();
}

/**
 * Returns `true` when focus currently lives inside the dock panel's portal
 * container (the xterm surface or the hybrid input editor). Used by
 * `handleDockInteractOutside`'s focus-event guard to suppress the spurious
 * mid-keystroke dismissal in #8368, and mirrors `handleDockEscapeKeyDown`'s
 * containment check. Deliberately *not* consulted on the pointer-down-outside
 * path — a real outside click must still dismiss while the terminal holds
 * focus, so this is only sound when the caller has already established the
 * originating event is focus-driven.
 */
export function shouldSuppressDockClose(portalContainer: HTMLElement | null): boolean {
  return portalContainer?.contains(document.activeElement) ?? false;
}
