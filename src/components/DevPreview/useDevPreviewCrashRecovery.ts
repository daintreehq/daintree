import { useCallback, useEffect, useRef, useState } from "react";
import { notify } from "@/lib/notify";

interface CrashDetails {
  reason: string;
  exitCode: number;
}

interface UseDevPreviewCrashRecoveryParams {
  id: string;
  currentUrl: string;
  /**
   * Parent-owned: `handleRenderProcessGone` is created (and must be passed
   * into `useDevPreviewLoadLifecycle`) before `performReload` exists in the
   * parent's lexical scope, so the parent keeps this ref and a separate
   * effect syncing it to `performReload` once that's defined. Reading it
   * through a ref here defers that dependency to invocation time.
   */
  crashReloadRef: React.RefObject<() => void>;
}

/**
 * Owns the webview renderer crash/unresponsive state machine: the
 * `render-process-gone` handler (with its 60s crash-loop notification),
 * the main-process unresponsive/responsive listeners, and the reset that
 * clears crash history at each of its trigger points (hard reload, full
 * webview state reset, eviction, a fresh URL navigation, and the crash
 * banner's own dismiss action).
 */
export function useDevPreviewCrashRecovery({
  id,
  currentUrl,
  crashReloadRef,
}: UseDevPreviewCrashRecoveryParams) {
  const [crashState, setCrashState] = useState<"none" | "crashed" | "unresponsive">("none");
  const [crashDetails, setCrashDetails] = useState<CrashDetails | null>(null);
  const crashTimestampsRef = useRef<number[]>([]);

  const handleRenderProcessGone = useCallback(
    (details: CrashDetails) => {
      const now = Date.now();
      const timestamps = crashTimestampsRef.current.filter((ts) => now - ts < 60_000);
      timestamps.push(now);
      crashTimestampsRef.current = timestamps;

      setCrashDetails(details);
      setCrashState("crashed");

      if (timestamps.length < 2) {
        crashReloadRef.current();
      } else {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Preview process crashed repeatedly",
          message: `The dev preview crashed (${details.reason}) twice within 60 seconds. Auto-recovery stopped. Use Reload or Hard restart to recover.`,
          priority: "high",
          duration: 0,
          context: { eventKind: "recovery", panelId: id },
          supersedeKey: `dev-preview-crash-loop:${id}`,
          correlationId: id,
        });
      }
    },
    [id, crashReloadRef]
  );

  // Listen for webview unresponsive/responsive events from the main process
  useEffect(() => {
    const cleanupUnresponsive = window.electron.webview.onUnresponsive((data) => {
      if (data.panelId !== id) return;
      setCrashState((prev) => (prev === "crashed" ? prev : "unresponsive"));
    });
    const cleanupResponsive = window.electron.webview.onResponsive((data) => {
      if (data.panelId !== id) return;
      setCrashState((prev) => (prev === "unresponsive" ? "none" : prev));
    });
    return () => {
      cleanupUnresponsive();
      cleanupResponsive();
    };
  }, [id]);

  const resetCrashHistory = useCallback(() => {
    setCrashState("none");
    setCrashDetails(null);
    crashTimestampsRef.current = [];
  }, []);

  const clearUnresponsiveState = useCallback(() => {
    setCrashState("none");
  }, []);

  // Clear crash state when the user navigates to a fresh URL. Depending on
  // crashState here would create an instant-reset loop: the effect would fire
  // the moment crashState transitions from "none" and clear it back. Track the
  // last URL we cleared at via a ref so this effect runs only on real URL
  // transitions.
  const lastClearedCrashUrlRef = useRef<string>(currentUrl);
  useEffect(() => {
    if (currentUrl === lastClearedCrashUrlRef.current) return;
    lastClearedCrashUrlRef.current = currentUrl;
    if (currentUrl && currentUrl !== "about:blank") {
      // Don't carry the prior URL's crash history into the new URL's 60s
      // window — that would mis-throttle the first auto-recovery there.
      resetCrashHistory();
    }
  }, [currentUrl, resetCrashHistory]);

  return {
    crashState,
    crashDetails,
    handleRenderProcessGone,
    resetCrashHistory,
    clearUnresponsiveState,
  };
}
