import { createContext, useContext } from "react";

export interface DockPanelContextValue {
  portalTarget: (terminalId: string, target: HTMLElement | null) => void;
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
  return context.portalTarget;
}
