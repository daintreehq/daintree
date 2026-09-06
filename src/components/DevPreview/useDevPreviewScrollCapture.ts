import { useCallback, useEffect, useRef } from "react";
import type { DevPreviewStatus } from "@/hooks/useDevServer";

interface UseDevPreviewScrollCaptureParams {
  id: string;
  status: DevPreviewStatus;
  webviewElement: Electron.WebviewTag | null;
  setDevPreviewScrollPosition: (id: string, position?: { url: string; scrollY: number }) => void;
}

/**
 * Owns the scroll-capture generation counter and the two distinct capture
 * strategies used across the pane. The running→not-running transition uses
 * `executeJavaScript("window.scrollY")`, safe because the page is guaranteed
 * unfrozen while `status === "running"`. The ref-cleanup and eviction call
 * sites use the main-process CDP `getScrollPosition` (Page.getLayoutMetrics)
 * instead: `useWebviewThrottle` freezes hidden webviews, and a frozen page's
 * suspended JS task queue makes `executeJavaScript` hang indefinitely. These
 * are deliberately different, not duplicated — do not collapse them into one
 * strategy.
 */
export function useDevPreviewScrollCapture({
  id,
  status,
  webviewElement,
  setDevPreviewScrollPosition,
}: UseDevPreviewScrollCaptureParams) {
  // Generation token to invalidate in-flight async scroll captures when the
  // user clears scroll state via hard restart. A pending executeJavaScript
  // promise that resolves after the clear must NOT write the stale position back.
  const scrollCaptureGenerationRef = useRef<number>(0);
  const prevStatusRef = useRef(status);

  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    prevStatusRef.current = status;

    if (prevStatus === "running" && status !== "running" && webviewElement) {
      try {
        const currentWebviewUrl = webviewElement.getURL();
        if (currentWebviewUrl && currentWebviewUrl !== "about:blank") {
          const captureGeneration = scrollCaptureGenerationRef.current;
          webviewElement
            .executeJavaScript("window.scrollY")
            .then((scrollY: number) => {
              if (scrollCaptureGenerationRef.current !== captureGeneration) return;
              if (typeof scrollY === "number" && Number.isFinite(scrollY)) {
                setDevPreviewScrollPosition(id, { url: currentWebviewUrl, scrollY });
              }
            })
            .catch(() => {});
        }
      } catch {
        // Webview already detached
      }
    }
  }, [status, id, webviewElement, setDevPreviewScrollPosition]);

  // Callers wrap this in their own try/catch: getURL()/getWebContentsId() can
  // throw synchronously on an already-detached webview, and each call site
  // has its own cleanup to run (or skip) when that happens.
  const captureScrollViaCdp = useCallback(
    (webview: Electron.WebviewTag): void => {
      const currentWebviewUrl = webview.getURL();
      if (!currentWebviewUrl || currentWebviewUrl === "about:blank") return;
      const captureGeneration = scrollCaptureGenerationRef.current;
      // Use main-process CDP Page.getLayoutMetrics instead of
      // executeJavaScript("window.scrollY"): hidden dock webviews are frozen
      // by useWebviewThrottle (via Page.setWebLifecycleState) which suspends
      // the JS task queue, so the executeJavaScript path hangs when
      // memory-pressure eviction fires while the page is frozen.
      const wcId = (webview as unknown as { getWebContentsId(): number }).getWebContentsId();
      window.electron.webview
        .getScrollPosition(wcId)
        .then((scrollY: number | null) => {
          if (scrollCaptureGenerationRef.current !== captureGeneration) return;
          // `null` is the read-failed sentinel — leave any prior stored
          // position alone. A successful `0` is a real position and must
          // overwrite, or scrolling back to the top before eviction leaves a
          // stale offset that a remount restores (#12298).
          if (scrollY === null || !Number.isFinite(scrollY)) return;
          // Now that a zero is persisted, the document it was measured on
          // matters: the eviction path blanks the guest immediately after
          // asking, and a reading landing after that would file the blank
          // page's 0 against the previous URL. Only a URL we can still read
          // *and* that differs is evidence of that — a detached tag can no
          // longer tell us, and the read was taken before teardown began, so
          // discarding it there would lose the eviction capture this path
          // exists for.
          let settledUrl: string | null;
          try {
            settledUrl = webview.getURL();
          } catch {
            settledUrl = null;
          }
          if (settledUrl === null) {
            // The tag is gone, so the document cannot be confirmed. A non-zero
            // offset could not have come from a freshly blanked page, so it is
            // safe to keep — this is the eviction capture doing its job. An
            // unconfirmable zero is exactly the blank-page reading that must
            // not be filed against the previous URL.
            if (scrollY === 0) return;
          } else if (settledUrl !== currentWebviewUrl) {
            return;
          }
          setDevPreviewScrollPosition(id, { url: currentWebviewUrl, scrollY });
        })
        .catch(() => {});
    },
    [id, setDevPreviewScrollPosition]
  );

  const invalidateScrollCaptures = useCallback((): void => {
    scrollCaptureGenerationRef.current += 1;
  }, []);

  return { captureScrollViaCdp, invalidateScrollCaptures };
}
