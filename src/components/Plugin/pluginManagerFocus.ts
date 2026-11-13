import type { KeyboardEvent } from "react";
import { isVisibleTabbableElement, TABBABLE_SELECTOR } from "@/lib/accessibility";
import { APP_DIALOG_SURFACE_ATTR } from "@/lib/appDialogSurface";
import { ESCAPE_BACKSTOP_DIALOG_ATTR } from "@/lib/dialogEscapeBackstop";
import { armTooltipFocusSuppression } from "@/lib/tooltipFocusSuppression";
import { focusPanelInput } from "@/components/Panel/panelFocusRegistry";
import { usePanelStore } from "@/store/panelStore";

/**
 * Whether the manager's close left focus with nowhere to be: on the body, in
 * the closing view, or on a control still behind an `inert` wrapper. Focus the
 * user or a newly opened surface has put somewhere usable is left alone.
 */
export function isFocusStranded(view: HTMLElement | null): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body) return true;
  return (view?.contains(active) ?? false) || active.closest("[inert]") !== null;
}

/**
 * Hand focus back after the manager closes. The opener first: a panel, or the
 * trigger of the menu it was opened from. A palette's input or a control that
 * has since unmounted can't take it, so then the focused panel, and failing
 * that the app shell's first control, so the keyboard never lands on the body.
 * The shell can still be inert under another overlay, the theme browser, and
 * then the first control in the document is what's left.
 */
export function handFocusBack(opener: HTMLElement | null): void {
  // Whichever control ends up with focus, its tooltip must not open on it.
  armTooltipFocusSuppression();
  if (opener?.isConnected) {
    opener.focus({ preventScroll: true });
    if (document.activeElement === opener) return;
  }
  const panelId = usePanelStore.getState().focusedId;
  // A panel's handler can report success for a focus it defers a frame, so
  // it's offered only a panel that can take focus at all.
  if (panelId !== null && isPanelReachable(panelId) && focusPanelInput(panelId)) return;
  fallbackTarget()?.focus({ preventScroll: true });
}

/**
 * The app shell's first control. While another overlay (the theme browser)
 * still keeps the shell inert, that overlay's first control instead, ahead of
 * a toast or anything else portalled earlier in the document.
 */
function fallbackTarget(): HTMLElement | null {
  const root = document.getElementById("root");
  const shell = root ? edgeTabbable(root, "start") : null;
  if (shell) return shell;
  const overlays = document.querySelectorAll<HTMLElement>('[aria-modal="true"]');
  for (let i = overlays.length - 1; i >= 0; i--) {
    const overlay = overlays[i]!;
    if (isClosing(overlay)) continue;
    const target = edgeTabbable(overlay, "start");
    if (target) return target;
  }
  return edgeTabbable(document.body, "start");
}

// A dialog fading out keeps `aria-modal` and isn't inert. An AppDialog drops
// its backstop mark as it starts to close; a Radix one reads closed.
function isClosing(overlay: HTMLElement): boolean {
  if (overlay.getAttribute("data-state") === "closed") return true;
  return (
    overlay.hasAttribute(APP_DIALOG_SURFACE_ATTR) &&
    !overlay.hasAttribute(ESCAPE_BACKSTOP_DIALOG_ATTR)
  );
}

// Not inert, hidden or parked offscreen: a parked dock panel is aria-hidden
// and content-visibility hidden rather than inert.
function isPanelReachable(id: string): boolean {
  for (const panel of document.querySelectorAll<HTMLElement>(
    "[data-panel-id][data-panel-location]"
  )) {
    if (panel.dataset.panelId === id) return isVisibleTabbableElement(panel);
  }
  return false;
}

/**
 * Keep Tab inside the manager while it covers the workspace. The workspace
 * behind it is inert, but the view is a region rather than a modal, so Tab
 * past either end walked out to whatever else in the document takes focus.
 */
export function containTab(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const root = event.currentTarget;
  const active = document.activeElement;
  // A dialog or popover portalled out of the view bubbles here through React,
  // and keeps its own Tab handling.
  if (!(active instanceof HTMLElement) || !root.contains(active)) return;
  const radios = radiosIn(root);
  const first = edgeTabbable(root, "start", radios);
  const last = edgeTabbable(root, "end", radios);
  if (!first || !last) {
    event.preventDefault();
    root.focus({ preventScroll: true });
    return;
  }
  // Tab from a radio leaves its whole group, so an option of the edge's group
  // is at the edge too, unless another stop sits between them.
  const atEdge = event.shiftKey
    ? active === root ||
      active === first ||
      follows(first, active) ||
      (sameRadioGroup(active, first) && !hasStopBetween(root, first, active, radios))
    : active === last ||
      follows(active, last) ||
      (sameRadioGroup(active, last) && !hasStopBetween(root, active, last, radios));
  if (!atEdge) return;
  event.preventDefault();
  (event.shiftKey ? last : first).focus({ preventScroll: true });
}

/** Whether `later` comes after `earlier` in the document, a descendant included. */
function follows(later: Element, earlier: Element): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

function sameRadioGroup(a: Element, b: Element): boolean {
  return (
    a instanceof HTMLInputElement &&
    b instanceof HTMLInputElement &&
    a.type === "radio" &&
    b.type === "radio" &&
    a.name !== "" &&
    a.name === b.name &&
    a.form === b.form
  );
}

function radiosIn(root: ParentNode): HTMLInputElement[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
}

/** Whether Tab can reach `el` at all, before radio groups are considered. */
function isReachable(el: HTMLElement): boolean {
  return el.matches(TAB_STOP_SELECTOR) && !el.matches(":disabled") && isVisibleTabbableElement(el);
}

/**
 * Whether sequential navigation stops on `el`. A radio group is one stop: its
 * checked option when Tab can reach it, else every option, so a scan from
 * either end lands on the option Tab enters the group by.
 */
function isTabStop(el: HTMLElement, radios: readonly HTMLInputElement[]): boolean {
  if (!isReachable(el)) return false;
  if (!(el instanceof HTMLInputElement) || el.type !== "radio" || el.name === "") return true;
  if (el.checked) return true;
  return !radios.some(
    (option) => option.checked && sameRadioGroup(option, el) && isReachable(option)
  );
}

function hasStopBetween(
  root: ParentNode,
  start: Element,
  end: Element,
  radios: readonly HTMLInputElement[]
): boolean {
  for (const el of root.querySelectorAll<HTMLElement>(TAB_STOP_SELECTOR)) {
    if (!follows(el, start) || !follows(end, el)) continue;
    if (!sameRadioGroup(el, start) && isTabStop(el, radios)) return true;
  }
  return false;
}

// The shared selector leaves out a details element's summary, which is a
// native tab stop.
const TAB_STOP_SELECTOR = `${TABBABLE_SELECTOR}, details > summary:first-of-type:not([tabindex^="-"])`;

// Scans in from one end and stops at the first stop, so a long plugin list
// costs a visibility check per Tab only at the edges.
function edgeTabbable(
  root: ParentNode,
  from: "start" | "end",
  radios: readonly HTMLInputElement[] = radiosIn(root)
): HTMLElement | null {
  const all = root.querySelectorAll<HTMLElement>(TAB_STOP_SELECTOR);
  for (let i = 0; i < all.length; i++) {
    const el = all[from === "start" ? i : all.length - 1 - i]!;
    if (isTabStop(el, radios)) return el;
  }
  return null;
}
