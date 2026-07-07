import { createContext, useContext } from "react";
import type { DragHandleContextValue } from "@/components/DragDrop/DragHandleContext";

export interface DockPanelContextValue {
  // Relocate a dock panel's stable wrapper element into `destination` (the
  // popover's inner container) or back to the offscreen parking container when
  // `destination` is null. The wrapper itself is the permanent createPortal
  // container — React never sees it change identity — so the panel subtree is
  // never unmounted/remounted across open/close or tab switches.
  moveToDestination: (panelId: string, destination: HTMLElement | null) => void;
  // Publish the dock sortable's drag handle (dnd-kit listeners + activator ref)
  // for the given panel ids so DockPanelOffscreenContainer can re-provide it to
  // the portaled panel body across the createPortal boundary (grid parity —
  // #10990). SortableDockItem is the sole owner of the dock useSortable()
  // registration, but the popover body is a React *sibling* of that sortable
  // (portaled from here), so useDragHandle() would otherwise resolve to null and
  // the docked PanelHeader never becomes a drag handle. Returns a disposer. For
  // a tab group, pass every member id so whichever tab is active resolves the
  // group's shared handle.
  registerDragHandle: (panelIds: string[], handle: DragHandleContextValue) => () => void;
}

// Defined in its own module (no component exports) so Vite Fast Refresh never
// re-evaluates it on a component edit. If this context lived alongside the
// DockPanelOffscreenContainer component, editing that file would re-run
// createContext() and mint a new context identity, leaving the provider and
// consumers on mismatched contexts ("useDockPanelPortal must be used within
// DockPanelOffscreenContainer").
export const DockPanelContext = createContext<DockPanelContextValue | null>(null);

export function useDockPanelPortal() {
  const context = useContext(DockPanelContext);
  if (!context) {
    throw new Error("useDockPanelPortal must be used within DockPanelOffscreenContainer");
  }
  return context.moveToDestination;
}

// Stable no-op so SortableDockItem — which renders standalone in unit tests
// without the container — can register unconditionally without a null guard.
const NOOP_REGISTER: DockPanelContextValue["registerDragHandle"] = () => () => {};

// Non-throwing counterpart to useDockPanelPortal: outside the container this
// returns a stable no-op registrar rather than throwing, since a dock chip can
// legitimately render without the offscreen container present (unit tests,
// isolated stories).
export function useDockPanelDragHandleRegistration(): DockPanelContextValue["registerDragHandle"] {
  return useContext(DockPanelContext)?.registerDragHandle ?? NOOP_REGISTER;
}
