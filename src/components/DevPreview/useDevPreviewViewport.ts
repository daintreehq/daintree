import { useCallback, useEffect, useRef, useState } from "react";
import { getEffectiveViewportSize, computeFitScale } from "@/panels/dev-preview/viewportPresets";
import { applyDevPreviewEmulation } from "./viewportEmulation";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import type { ViewportPresetId } from "@shared/types/panel";

interface UseDevPreviewViewportParams {
  id: string;
  viewportPreset: ViewportPresetId | undefined;
  viewportRotated: boolean;
  viewportDpr: 1 | 2 | 3;
  viewportFit: boolean;
  isWebviewReady: boolean;
  webviewElement: Electron.WebviewTag | null;
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
  // The main process calls enableDeviceEmulation, which drives CSS media
  // queries and window.innerWidth without a page reload, preserving in-page
  // state across preset switches.
  const prevEmulationKeyRef = useRef<string | null>(null);
  const hasAppliedEmulationRef = useRef(false);
  // Applying is an async IPC round trip now, so two fast preset switches can
  // resolve out of order. Only the newest request may record what is applied.
  const emulationSeqRef = useRef(0);
  const inFlightEmulationRef = useRef(0);
  useEffect(() => {
    if (!isWebviewReady || !webviewElement) return;
    const emulationKey = `${viewportPreset ?? "none"}-${viewportRotated}-${viewportDpr}`;
    if (prevEmulationKeyRef.current === emulationKey) return;
    // Clearing emulation that was never applied is a no-op, but the key still
    // has to advance so a later switch back to the same desktop state is not
    // mistaken for a repeat. An in-flight request counts as applied for this
    // purpose: skipping the clear while a preset apply is still on the wire
    // would leave the guest emulated with the toolbar showing desktop.
    if (!viewportPreset && !hasAppliedEmulationRef.current && inFlightEmulationRef.current === 0) {
      prevEmulationKeyRef.current = emulationKey;
      return;
    }

    // eslint-disable-next-line react-compiler/react-compiler -- refs mutated inside an effect the compiler cannot prove is not render-phase
    const seq = ++emulationSeqRef.current;
    let request: Promise<boolean>;
    try {
      request = applyDevPreviewEmulation(
        webviewElement,
        id,
        viewportPreset,
        viewportRotated,
        viewportDpr
      );
    } catch {
      // getWebContentsId() throws on a detached webview; the next ready
      // transition re-runs this effect against the replacement guest.
      return;
    }

    inFlightEmulationRef.current += 1;
    safeFireAndForget(
      request
        .then((applied) => {
          // A superseded request must not record what it asked for, and main
          // reporting `applied: false` (guest gone, or not registered to this
          // panel) must not be cached as success — either way the next
          // preset/ready transition re-issues.
          if (!applied || emulationSeqRef.current !== seq) return;
          prevEmulationKeyRef.current = emulationKey;
          hasAppliedEmulationRef.current = viewportPreset !== undefined;
        })
        .finally(() => {
          inFlightEmulationRef.current -= 1;
        }),
      { context: "Applying dev-preview device emulation" }
    );
  }, [id, viewportPreset, viewportRotated, viewportDpr, isWebviewReady, webviewElement]);

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
