import type { KeyboardEvent } from "react";
import { isVisibleTabbableElement, TABBABLE_SELECTOR } from "@/lib/accessibility";
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
  const root = document.getElementById("root");
  const fallback =
    (root ? edgeTabbable(root, "start") : null) ?? edgeTabbable(document.body, "start");
  fallback?.focus({ preventScroll: true });
}

function isPanelReachable(id: string): boolean {
  for (const panel of document.querySelectorAll<HTMLElement>(
    "[data-panel-id][data-panel-location]"
  )) {
    if (panel.dataset.panelId === id) return panel.closest("[inert]") === null;
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
  const first = edgeTabbable(root, "start");
  const last = edgeTabbable(root, "end");
  if (!first || !last) {
    event.preventDefault();
    root.focus({ preventScroll: true });
    return;
  }
  // A radio group is one tab stop, so any of its options at an edge is there.
  const atEdge = event.shiftKey
    ? active === root || active === first || follows(first, active) || sameRadioGroup(active, first)
    : active === last || follows(active, last) || sameRadioGroup(active, last);
  if (!atEdge) return;
  event.preventDefault();
  radioGroupStop(event.shiftKey ? last : first, root).focus({ preventScroll: true });
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

/**
 * The option Tab lands on in `el`'s radio group: the checked one, else the
 * option it entered from, which is `el` since the edges are the group's ends.
 */
function radioGroupStop(el: HTMLElement, root: ParentNode): HTMLElement {
  for (const option of root.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
    if (option.checked && sameRadioGroup(option, el)) return option;
  }
  return el;
}

// The shared selector leaves out a details element's summary, which is a
// native tab stop.
const TAB_STOP_SELECTOR = `${TABBABLE_SELECTOR}, details > summary:first-of-type:not([tabindex^="-"])`;

// Scans in from one end and stops at the first usable control, so a long
// plugin list costs a visibility check per Tab only at the edges.
function edgeTabbable(root: ParentNode, from: "start" | "end"): HTMLElement | null {
  const all = root.querySelectorAll<HTMLElement>(TAB_STOP_SELECTOR);
  for (let i = 0; i < all.length; i++) {
    const el = all[from === "start" ? i : all.length - 1 - i]!;
    if (isVisibleTabbableElement(el)) return el;
  }
  return null;
}
