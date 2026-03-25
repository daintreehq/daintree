import { useState, useEffect, useCallback, useRef } from "react";
import { useTerminalStore } from "@/store";

/**
 * Tracks whether a panel's webview should be evicted (destroyed) due to
 * memory pressure. When evicted, the component should unmount its `<webview>`
 * tag and show a placeholder. When the panel becomes visible again, the
 * eviction is automatically cleared so the webview can be recreated.
 */
export function useWebviewEviction(
  panelId: string,
  location: string
): { isEvicted: boolean; evictingRef: React.RefObject<boolean> } {
  const [isEvicted, setIsEvicted] = useState(false);
  const evictingRef = useRef(false);
  const activeDockTerminalId = useTerminalStore((s) => s.activeDockTerminalId);

  // Auto-clear eviction when this panel becomes visible (dock panel activated)
  useEffect(() => {
    if (!isEvicted) return;

    if (location === "dock" && activeDockTerminalId === panelId) {
      evictingRef.current = false;
      setIsEvicted(false);
    }
  }, [isEvicted, location, activeDockTerminalId, panelId]);

  const handleDestroySignal = useCallback(
    (_payload: { tier: 1 | 2 }) => {
      // Only evict dock panels that are not the currently-open dock panel.
      // Grid panels are already efficiently managed by GridTabGroup (only the
      // active tab is rendered), so visible grid panels should never be evicted.
      const isHiddenDock = location === "dock" && activeDockTerminalId !== panelId;

      if (isHiddenDock) {
        evictingRef.current = true;
        setIsEvicted(true);
      }
    },
    [location, activeDockTerminalId, panelId]
  );

  useEffect(() => {
    const cleanup = window.electron.window.onDestroyHiddenWebviews(handleDestroySignal);
    return cleanup;
  }, [handleDestroySignal]);

  return { isEvicted, evictingRef };
}
