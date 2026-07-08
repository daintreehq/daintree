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
        .then((scrollY: number) => {
          if (scrollCaptureGenerationRef.current !== captureGeneration) return;
          // Guard `> 0`: a CDP error returns 0, and the user being at top of
          // page has nothing worth restoring — both cases should leave any
          // prior stored position untouched rather than clobber it.
          if (typeof scrollY === "number" && Number.isFinite(scrollY) && scrollY > 0) {
            setDevPreviewScrollPosition(id, { url: currentWebviewUrl, scrollY });
          }
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
