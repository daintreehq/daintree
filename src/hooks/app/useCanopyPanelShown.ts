import { useEffect } from "react";
import { useCanopyStore } from "@/store/canopyStore";

/**
 * Whether this project view shows Canopy's panel: only before Canopy is on,
 * where it offers to turn it on. Once on, Canopy's one home is its own window
 * (#16578), so a panel asked for here, or left open as Canopy turned on, is
 * put away rather than shown, and can't come back if Canopy is turned off.
 */
export function useCanopyPanelShown(): boolean {
  const isOpen = useCanopyStore((s) => s.isOpen);
  const on = useCanopyStore((s) => s.mode === "on");
  useEffect(() => {
    if (isOpen && on) useCanopyStore.getState().close();
  }, [isOpen, on]);
  return isOpen && !on;
}
