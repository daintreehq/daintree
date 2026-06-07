import { createContext, useContext } from "react";

export interface DockPanelContextValue {
  // Relocate a dock panel's stable wrapper element into `destination` (the
  // popover's inner container) or back to the offscreen parking container when
  // `destination` is null. The wrapper itself is the permanent createPortal
  // container — React never sees it change identity — so the panel subtree is
  // never unmounted/remounted across open/close or tab switches.
  moveToDestination: (panelId: string, destination: HTMLElement | null) => void;
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
