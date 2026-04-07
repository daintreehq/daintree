import { useState, useEffect } from "react";
import { usePanelStore } from "@/store";

/**
 * Returns whether a panel has ever been visible. For grid panels this is
 * always `true`. For dock panels it latches to `true` the first time the
 * panel becomes the active dock panel and never reverts.
 *
 * Used to defer `<webview>` creation until the user actually views the panel,
 * avoiding the Chromium renderer process cost for background dock panels.
 */
export function useHasBeenVisible(panelId: string, location: string): boolean {
  const activeDockTerminalId = usePanelStore((s) => s.activeDockTerminalId);

  const [hasBeenVisible, setHasBeenVisible] = useState(() => {
    if (location !== "dock") return true;
    return usePanelStore.getState().activeDockTerminalId === panelId;
  });

  useEffect(() => {
    if (location !== "dock") {
      setHasBeenVisible(true);
      return;
    }
    if (activeDockTerminalId === panelId) {
      setHasBeenVisible(true);
    }
  }, [location, activeDockTerminalId, panelId]);

  return hasBeenVisible;
}
