import { useEffect, useRef, type RefObject } from "react";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { isStaleHiddenReading } from "./visibilityReadingGuard";
import { COMFORTABLE_PANEL_HEIGHT_PX } from "@/lib/terminalLayout";

interface TerminalVisibilityObserverParams {
  id: string;
  restartKey: number;
  /**
   * Advances once per live `attach()` of this pane's terminal. Re-arming on it
   * is what keeps the generation capture below honest: `attach()` runs inside
   * XtermAdapter's async setup, so on a cold open (the lazy Unicode11 addon is
   * awaited during construction) the passive effect here can capture the
   * PRE-attach generation and then be superseded. Without the re-arm every
   * later reading fails the guard at the write site and the pane's store
   * visibility freezes at whatever value it already held — permanently, since
   * nothing else re-runs this effect (#11445).
   */
  attachEpoch: number;
  isDragging: boolean;
  gridScrollRoot: HTMLElement | null;
  containerRef: RefObject<HTMLDivElement | null>;
  updateVisibility: (id: string, isVisible: boolean) => void;
}

/**
 * Grid-rooted visibility observation for a terminal pane — stable observer,
 * ref-gated callback, generation-guarded writes.
 *
 * Re-arming (rather than adopting a newer generation inside the callback) is
 * deliberate: IntersectionObserver only reports threshold crossings after the
 * initial observation, so a pane whose one callback landed before the attach
 * may never be called again. A fresh `observe()` is the only thing that
 * guarantees a delivery, and it re-captures the generation at the same time.
 */
export function useTerminalVisibilityObserver({
  id,
  restartKey,
  attachEpoch,
  isDragging,
  gridScrollRoot,
  containerRef,
  updateVisibility,
}: TerminalVisibilityObserverParams): void {
  // Track drag state in a ref to avoid useEffect cleanup timing issues.
  // If isDragging is in the dependency array, cleanup runs on drag START
  // with the OLD isDragging=false value, which would set visibility to false!
  const isDraggingRef = useRef(isDragging);
  useEffect(() => {
    isDraggingRef.current = isDragging;
  }, [isDragging]);

  // Capture attach generation so stale IntersectionObserver callbacks from a
  // previous mount site don't hide a terminal that has already been re-attached.
  useEffect(() => {
    if (!containerRef.current) return;

    const gen = terminalInstanceService.getAttachGeneration(id);

    const observer = new IntersectionObserver(
      (entries) => {
        // Under load a single callback can batch multiple entries for the same
        // element; only the most recent reading reflects current geometry.
        const entry = entries[entries.length - 1];

        // Don't update visibility during drag - CSS transforms cause false negatives
        if (isDraggingRef.current || !entry) return;

        // Suppress stale `false` readings that would freeze a visible terminal
        // at the BACKGROUND tier (#9780). Confirm against fresh element and root
        // geometry, read before any write to avoid a redundant layout reflow.
        if (
          isStaleHiddenReading(
            entry,
            () => containerRef.current?.getBoundingClientRect(),
            () =>
              gridScrollRoot?.getBoundingClientRect() ??
              new DOMRect(0, 0, window.innerWidth, window.innerHeight)
          )
        )
          return;

        // A callback queued from a previous mount site (warm-swap reattach)
        // must not write at all. setVisible already drops it via its
        // generation guard — dropping the store write under the same
        // condition keeps store and service from diverging permanently
        // (#10416). The live mount re-arms on `attachEpoch` instead of
        // adopting the newer generation here, so a superseded observer's
        // retained callback keeps failing this check.
        if (terminalInstanceService.getAttachGeneration(id) !== gen) return;

        updateVisibility(id, entry.isIntersecting);
        terminalInstanceService.setVisible(id, entry.isIntersecting, gen);
      },
      {
        // Grid-scoped root: when mounted inside the grid, the pre-warm margin
        // upgrades panels that are one comfortable row away from the viewport
        // from BACKGROUND → VISIBLE before they paint. Sized to the comfortable
        // row height so the pre-warm fires a full row ahead now that rows no
        // longer shrink to the minimum. Outside the grid we fall back to the
        // document viewport with no margin.
        root: gridScrollRoot ?? null,
        rootMargin: gridScrollRoot ? `${COMFORTABLE_PANEL_HEIGHT_PX}px 0px` : "0px",
        threshold: 0.1,
      }
    );

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [id, restartKey, attachEpoch, updateVisibility, gridScrollRoot, containerRef]);
}
