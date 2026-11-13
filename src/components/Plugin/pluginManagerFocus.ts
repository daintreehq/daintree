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
 */
export function handFocusBack(opener: HTMLElement | null): void {
  if (opener?.isConnected) {
    armTooltipFocusSuppression();
    opener.focus({ preventScroll: true });
    if (document.activeElement === opener) return;
  }
  const panelId = usePanelStore.getState().focusedId;
  if (panelId !== null && focusPanelInput(panelId)) return;
  const root = document.getElementById("root") ?? document.body;
  edgeTabbable(root, "start")?.focus({ preventScroll: true });
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
  const atEdge = event.shiftKey
    ? active === root || active === first || follows(first, active)
    : active === last || follows(active, last);
  if (!atEdge) return;
  event.preventDefault();
  (event.shiftKey ? last : first).focus({ preventScroll: true });
}

/** Whether `later` comes after `earlier` in the document, a descendant included. */
function follows(later: Element, earlier: Element): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

// Scans in from one end and stops at the first usable control, so a long
// plugin list costs a visibility check per Tab only at the edges.
function edgeTabbable(root: ParentNode, from: "start" | "end"): HTMLElement | null {
  const all = root.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR);
  for (let i = 0; i < all.length; i++) {
    const el = all[from === "start" ? i : all.length - 1 - i]!;
    if (isVisibleTabbableElement(el)) return el;
  }
  return null;
}
