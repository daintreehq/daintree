import { useCallback, useEffect, useRef, useState } from "react";
import {
  getViewportPreset,
  getEffectiveViewportSize,
  computeFitScale,
} from "@/panels/dev-preview/viewportPresets";
import { getDevPreviewWebContents, buildEmulationParams } from "./viewportEmulation";
import type { ViewportPresetId } from "@shared/types/panel";

interface UseDevPreviewViewportParams {
  id: string;
  viewportPreset: ViewportPresetId | undefined;
  viewportRotated: boolean;
  viewportDpr: 1 | 2 | 3;
  viewportFit: boolean;
  isWebviewReady: boolean;
  webviewElement: Electron.WebviewTag | null;
  // Shared with useDevPreviewLoadLifecycle, which re-applies emulation after
  // cross-origin navigation — the parent owns this ref so both hooks see the
  // same seeded user agent.
  originalUaRef: React.MutableRefObject<string | null>;
  setViewportPreset: (id: string, preset: ViewportPresetId | undefined) => void;
  setViewportRotated: (id: string, rotated: boolean) => void;
  setViewportDpr: (id: string, dpr: 1 | 2 | 3) => void;
  setViewportFit: (id: string, fit: boolean) => void;
}

/**
 * Owns viewport-preset device emulation: the toolbar's four change handlers,
 * the zoom-to-fit container measurement, and the effect that applies/clears
 * `enableDeviceEmulation` + the spoofed user agent as the preset/rotation/DPR
 * change. Cross-origin re-apply after navigation lives in
 * useDevPreviewLoadLifecycle, not here — this effect only reacts to explicit
 * preset/rotation/DPR changes.
 */
export function useDevPreviewViewport({
  id,
  viewportPreset,
  viewportRotated,
  viewportDpr,
  viewportFit,
  isWebviewReady,
  webviewElement,
  originalUaRef,
  setViewportPreset,
  setViewportRotated,
  setViewportDpr,
  setViewportFit,
}: UseDevPreviewViewportParams) {
  const effectiveViewport = viewportPreset
    ? getEffectiveViewportSize(viewportPreset, viewportRotated)
    : null;

  const handleViewportPresetChange = useCallback(
    (preset: ViewportPresetId | undefined) => {
      setViewportPreset(id, preset);
    },
    [id, setViewportPreset]
  );

  const handleViewportRotateToggle = useCallback(() => {
    setViewportRotated(id, !viewportRotated);
  }, [id, setViewportRotated, viewportRotated]);

  const handleViewportDprChange = useCallback(
    (dpr: 1 | 2 | 3) => {
      setViewportDpr(id, dpr);
    },
    [id, setViewportDpr]
  );

  const handleViewportFitToggle = useCallback(() => {
    setViewportFit(id, !viewportFit);
  }, [id, setViewportFit, viewportFit]);

  // Measure the available preview area so zoom-to-fit can scale the device
  // frame down to fit both pane dimensions. A static scale would break on
  // pane resize, so this tracks the container via ResizeObserver.
  // Callback ref (not useRef) so the observer effect re-runs when the
  // fit-container div mounts for the first time — it lives in the webview
  // branch, which only renders once the dev server reaches "running", long
  // after viewportFit/viewportPreset may have been set.
  const [fitContainerEl, setFitContainerEl] = useState<HTMLDivElement | null>(null);
  const [fitContainerSize, setFitContainerSize] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });
  useEffect(() => {
    if (!viewportFit || !viewportPreset || !fitContainerEl) return;
    const el = fitContainerEl;
    const measure = () => {
      setFitContainerSize({ w: el.clientWidth, h: el.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [viewportFit, viewportPreset, fitContainerEl]);

  const fitScale =
    viewportFit && effectiveViewport
      ? computeFitScale(
          fitContainerSize.w,
          fitContainerSize.h,
          effectiveViewport.width,
          effectiveViewport.height
        )
      : 1;

  // Apply device emulation when viewport preset, rotation, or DPR changes.
  // Uses enableDeviceEmulation which drives CSS media queries and window.innerWidth
  // without a page reload, preserving in-page state across preset switches.
  const prevEmulationKeyRef = useRef<string | null>(null);
  const hasAppliedEmulationRef = useRef(false);
  useEffect(() => {
    if (!isWebviewReady || !webviewElement) return;
    const emulationKey = `${viewportPreset ?? "none"}-${viewportRotated}-${viewportDpr}`;
    if (prevEmulationKeyRef.current === emulationKey) return;
    const hadPrevious = hasAppliedEmulationRef.current;

    const wc = getDevPreviewWebContents(webviewElement);
    if (!wc) return;

    try {
      if (viewportPreset) {
        if (originalUaRef.current === null) {
          originalUaRef.current = wc.getUserAgent();
        }
        wc.setUserAgent(getViewportPreset(viewportPreset).userAgent);
        wc.enableDeviceEmulation(
          buildEmulationParams(viewportPreset, viewportRotated, viewportDpr)!
        );
        prevEmulationKeyRef.current = emulationKey;
        hasAppliedEmulationRef.current = true;
      } else if (hadPrevious) {
        try {
          wc.disableDeviceEmulation();
        } catch {
          // disableDeviceEmulation may throw if emulation was never enabled
        }
        if (originalUaRef.current) {
          wc.setUserAgent(originalUaRef.current);
        }
        prevEmulationKeyRef.current = emulationKey;
        hasAppliedEmulationRef.current = false;
      }
    } catch {
      // WebContents not available (webview detached)
    }
  }, [viewportPreset, viewportRotated, viewportDpr, isWebviewReady, webviewElement]);

  return {
    effectiveViewport,
    fitScale,
    setFitContainerEl,
    handleViewportPresetChange,
    handleViewportRotateToggle,
    handleViewportDprChange,
    handleViewportFitToggle,
  };
}
