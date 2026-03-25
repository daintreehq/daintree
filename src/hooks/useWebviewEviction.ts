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
  const focusedId = useTerminalStore((s) => s.focusedId);

  // Auto-clear eviction when this panel becomes visible
  useEffect(() => {
    if (!isEvicted) return;

    const isVisible =
      location !== "dock" || activeDockTerminalId === panelId || focusedId === panelId;

    if (isVisible) {
      evictingRef.current = false;
      setIsEvicted(false);
    }
  }, [isEvicted, location, activeDockTerminalId, focusedId, panelId]);

  const handleDestroySignal = useCallback(
    (payload: { tier: 1 | 2 }) => {
      const isHiddenDock = location === "dock" && activeDockTerminalId !== panelId;

      // Tier 1: evict hidden dock panels only
      // Tier 2: evict all non-focused panels (dock hidden + grid non-focused)
      const shouldEvict = payload.tier === 1 ? isHiddenDock : isHiddenDock || focusedId !== panelId;

      if (shouldEvict) {
        evictingRef.current = true;
        setIsEvicted(true);
      }
    },
    [location, activeDockTerminalId, focusedId, panelId]
  );

  useEffect(() => {
    const cleanup = window.electron.window.onDestroyHiddenWebviews(handleDestroySignal);
    return cleanup;
  }, [handleDestroySignal]);

  return { isEvicted, evictingRef };
}
