import { useCallback, useRef, useEffect, useState, useMemo } from "react";
import { createPortal } from "react-dom";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { cn } from "@/lib/utils";
import { useTwoPaneSplitStore } from "@/store/twoPaneSplitStore";
import { resolveEffectiveRatio } from "@/store/twoPaneSplitStore";
import type { PanelInstance } from "@shared/types/panel";
import { SortableTerminal } from "@/components/DragDrop";
import { GridPanel } from "./GridPanel";
import { TwoPaneSplitDivider, DIVIDER_WIDTH_PX } from "./TwoPaneSplitDivider";
import { MIN_TERMINAL_WIDTH_PX } from "@/lib/terminalLayout";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { isBrowserPanel, isDevPreviewPanel, isReviewPanel } from "@shared/types/panel";
import {
  isSidebarMeasurementLocked,
  subscribeSidebarLayoutTransitionUnlock,
  subscribeSidebarHydrationUnlock,
} from "@/lib/layoutTransitionLock";

interface TwoPaneSplitLayoutProps {
  terminals: [PanelInstance, PanelInstance];
  focusedId: string | null;
  activeWorktreeId: string | null;
  isInTrash: (id: string) => boolean;
  // Stable panel-aware add-tab callback. GridPanel binds it to the
  // subscribed terminal internally so we never recreate inline closures here.
  onAddTabForPanel?: (terminal: PanelInstance) => void | Promise<void>;
}

export function TwoPaneSplitLayout({
  terminals,
  focusedId,
  activeWorktreeId,
  isInTrash,
  onAddTabForPanel,
}: TwoPaneSplitLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [localRatio, setLocalRatio] = useState<number | null>(null);
  const [isDraggingDivider, setIsDraggingDivider] = useState(false);
  const isDraggingDividerRef = useRef(false);
  const dragLockedIdsRef = useRef<string[]>([]);
  useEffect(() => {
    isDraggingDividerRef.current = isDraggingDivider;
  }, [isDraggingDivider]);
  // Set when the sidebar transition unlocks during an in-flight divider drag —
  // the resync rAF skips in that case, so we run the deferred measurement on
  // the next drag-end edge instead.
  const pendingResyncAfterDragRef = useRef(false);

  // Refs for unmount cleanup (avoid closure/dependency issues)
  const localRatioRef = useRef<number | null>(null);
  const activeWorktreeIdRef = useRef<string | null>(null);
  const terminalsRef = useRef(terminals);
  const commitRatioIfChangedRef = useRef<typeof commitRatioIfChanged>(null!);

  useEffect(() => {
    localRatioRef.current = localRatio;
    activeWorktreeIdRef.current = activeWorktreeId;
    terminalsRef.current = terminals;
  });

  const ratioByWorktreeId = useTwoPaneSplitStore((state) => state.ratioByWorktreeId);
  const defaultRatio = useTwoPaneSplitStore((state) => state.config.defaultRatio);
  const preferPreview = useTwoPaneSplitStore((state) => state.config.preferPreview);
  const commitRatioIfChanged = useTwoPaneSplitStore((state) => state.commitRatioIfChanged);
  const resetWorktreeRatio = useTwoPaneSplitStore((state) => state.resetWorktreeRatio);

  useEffect(() => {
    commitRatioIfChangedRef.current = commitRatioIfChanged;
  }, [commitRatioIfChanged]);

  const setWorktreeRatio = useTwoPaneSplitStore((state) => state.setWorktreeRatio);

  const storedEntry = activeWorktreeId ? ratioByWorktreeId[activeWorktreeId] : undefined;

  // Backfill panel IDs for legacy entries migrated from v0 (panels are [null, null])
  useEffect(() => {
    if (
      storedEntry &&
      storedEntry.panels[0] === null &&
      storedEntry.panels[1] === null &&
      activeWorktreeId
    ) {
      setWorktreeRatio(activeWorktreeId, storedEntry.ratio, [terminals[0].id, terminals[1].id]);
    }
  }, [storedEntry, activeWorktreeId, terminals, setWorktreeRatio]);

  const effectiveStoredRatio = useMemo(
    () => resolveEffectiveRatio(storedEntry, terminals[0].id, terminals[1].id),
    [storedEntry, terminals]
  );

  const computeDefaultRatio = useCallback(() => {
    if (!preferPreview) return defaultRatio;

    const [left, right] = terminals;
    const leftIsPreview = isBrowserPanel(left) || isDevPreviewPanel(left) || isReviewPanel(left);
    const rightIsPreview =
      isBrowserPanel(right) || isDevPreviewPanel(right) || isReviewPanel(right);

    if (leftIsPreview && !rightIsPreview) {
      return 0.65;
    }
    if (rightIsPreview && !leftIsPreview) {
      return 0.35;
    }
    return defaultRatio;
  }, [terminals, preferPreview, defaultRatio]);

  const ratio = useMemo(() => {
    if (localRatio !== null) {
      return localRatio;
    }
    if (effectiveStoredRatio !== undefined) {
      return effectiveStoredRatio;
    }
    return computeDefaultRatio();
  }, [localRatio, effectiveStoredRatio, computeDefaultRatio]);

  // Observe container resizes with rAF deferral. Gate updates while the
  // sidebar layout transition lock is active — the flex parent reflows every
  // frame during the 250ms collapse and committing mid-animation widths into
  // the inline `width` styles re-snaps the right pane edge and produces
  // visible jitter (#7825, follow-up to #6979 which fixed the same class of
  // regression for the multi-panel grid).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let rafId: number | null = null;
    let latestEntry: ResizeObserverEntry | null = null;
    let finalRafId: number | null = null;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      latestEntry = entry;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const entry = latestEntry;
        latestEntry = null;
        if (isSidebarMeasurementLocked()) return;
        if (entry) {
          const width = entry.contentRect.width;
          setContainerWidth((prev) => (prev === width ? prev : width));
        }
      });
    });

    observer.observe(container);
    // Skip the initial measurement if a sidebar transition is in flight, or
    // while startup hydration is still pending (#10827) — the unlock
    // subscribers below resync once the animation completes / width restores.
    if (!isSidebarMeasurementLocked()) {
      setContainerWidth(container.clientWidth);
    }

    // Force a single measurement after the sidebar transition completes (or
    // after startup hydration lands, #10827) so the pane widths reach their
    // settled size even if no further RO entry fires. Shared by both unlock
    // subscribers.
    const remeasureAfterUnlock = () => {
      const node = containerRef.current;
      if (!node) return;
      if (finalRafId !== null) cancelAnimationFrame(finalRafId);
      finalRafId = requestAnimationFrame(() => {
        finalRafId = null;
        // Re-check both locks — a second toggle may have started in the ~16ms
        // between unlock and this rAF.
        if (isSidebarMeasurementLocked()) return;
        // Don't override an in-progress divider drag — changing
        // `containerWidth` mid-drag shifts `minRatio`/`maxRatio` clamping
        // bounds, which can snap the live ratio. Defer the resync until
        // the drag ends.
        if (isDraggingDividerRef.current) {
          pendingResyncAfterDragRef.current = true;
          return;
        }
        const measureNode = containerRef.current;
        if (!measureNode) return;
        const width = measureNode.clientWidth;
        setContainerWidth((prev) => (prev === width ? prev : width));
      });
    };

    const unsubscribeTransition = subscribeSidebarLayoutTransitionUnlock(remeasureAfterUnlock);
    // #10827: remeasure once the persisted sidebar width is restored. Fires
    // synchronously if hydration already completed before this effect mounted.
    const unsubscribeHydration = subscribeSidebarHydrationUnlock(remeasureAfterUnlock);

    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (finalRafId !== null) cancelAnimationFrame(finalRafId);
      unsubscribeTransition();
      unsubscribeHydration();
    };
  }, []);

  // Recover the deferred unlock-resync once the drag ends. Without this, a
  // sidebar transition that completed mid-drag would leave `containerWidth`
  // at its pre-animation value — no further RO event fires unless the outer
  // container changes again, so pane pixel widths would be stale.
  useEffect(() => {
    if (isDraggingDivider) return;
    if (!pendingResyncAfterDragRef.current) return;
    pendingResyncAfterDragRef.current = false;
    const node = containerRef.current;
    if (!node) return;
    const width = node.clientWidth;
    setContainerWidth((prev) => (prev === width ? prev : width));
  }, [isDraggingDivider]);

  const handleRatioChange = useCallback((newRatio: number) => {
    setLocalRatio(newRatio);
  }, []);

  const flushPendingRatio = useCallback(() => {
    if (localRatio !== null && activeWorktreeId) {
      const panels: [string, string] = [terminals[0].id, terminals[1].id];
      commitRatioIfChanged(activeWorktreeId, localRatio, panels);
      setLocalRatio(null);
    }
  }, [localRatio, activeWorktreeId, commitRatioIfChanged, terminals]);

  const handleRatioCommit = useCallback(() => {
    flushPendingRatio();
  }, [flushPendingRatio]);

  const handleDoubleClick = useCallback(() => {
    if (activeWorktreeId) {
      resetWorktreeRatio(activeWorktreeId);
    }
  }, [activeWorktreeId, resetWorktreeRatio]);

  const handleDragStateChange = useCallback(
    (dragging: boolean) => {
      setIsDraggingDivider(dragging);

      if (dragging) {
        const ids = terminals.map((terminal) => terminal.id);
        dragLockedIdsRef.current = ids;
        for (const id of ids) {
          terminalInstanceService.lockResize(id, true);
        }
      } else {
        const ids = dragLockedIdsRef.current;
        // Clear gesture ownership before unlocking so an already-queued re-arm
        // frame cannot restore the lock after drag end.
        dragLockedIdsRef.current = [];
        for (const id of ids) {
          terminalInstanceService.lockResize(id, false);
        }
        if (ids.length > 0) {
          terminalInstanceService.runResizePass(ids);
        }
      }
    },
    [terminals]
  );

  useEffect(() => {
    if (!isDraggingDivider) return;
    let rafId = 0;
    const rearm = () => {
      for (const id of dragLockedIdsRef.current) {
        terminalInstanceService.lockResize(id, true);
      }
      rafId = requestAnimationFrame(rearm);
    };
    rafId = requestAnimationFrame(rearm);
    return () => cancelAnimationFrame(rafId);
  }, [isDraggingDivider]);

  // Cleanup: unlock resize and flush pending ratio on unmount only
  useEffect(() => {
    return () => {
      // Read latest values from refs to avoid stale closures
      const pendingRatio = localRatioRef.current;
      const worktreeId = activeWorktreeIdRef.current;

      const lockedIds = dragLockedIdsRef.current;
      dragLockedIdsRef.current = [];
      for (const id of lockedIds) {
        terminalInstanceService.lockResize(id, false);
      }

      // Flush pending ratio if present
      if (pendingRatio !== null && worktreeId) {
        const panels: [string, string] = [terminalsRef.current[0].id, terminalsRef.current[1].id];
        commitRatioIfChangedRef.current(worktreeId, pendingRatio, panels);
      }
    };
  }, []);

  const minRatio = useMemo(() => {
    if (containerWidth <= 0) return 0.2;
    const calculated = MIN_TERMINAL_WIDTH_PX / containerWidth;
    return Math.max(0.2, Math.min(0.5, calculated));
  }, [containerWidth]);

  const maxRatio = useMemo(() => {
    if (containerWidth <= 0) return 0.8;
    const calculated = 1 - MIN_TERMINAL_WIDTH_PX / containerWidth;
    return Math.min(0.8, Math.max(0.5, calculated));
  }, [containerWidth]);

  const clampedRatio = Math.max(minRatio, Math.min(maxRatio, ratio));
  // Size the panes with a CSS grid template rather than JS-measured pixel
  // widths. The fractional (`fr`) tracks distribute the space around the fixed
  // divider track natively — the same self-correcting sizing the multi-panel
  // grid gets — so layout no longer depends on a measured `containerWidth`.
  // That measurement broke the two-pane layout whenever it was zero (first
  // paint) or stale (gated behind the sidebar transition lock): the old inline
  // pixel widths stopped matching the real container and, with `flexShrink: 0`,
  // overflowed instead of correcting. `minmax(0, …)` lets the tracks shrink
  // instead of overflowing on sub-pixel rounding; the MIN_TERMINAL_WIDTH_PX
  // floor is still enforced by the min/max-ratio clamp during drags.
  // `containerWidth` is still measured below, but only feeds that clamp now —
  // it is no longer load-bearing for layout.
  const gridTemplateColumns = `minmax(0, ${clampedRatio}fr) ${DIVIDER_WIDTH_PX}px minmax(0, ${1 - clampedRatio}fr)`;

  const panelIds = useMemo(() => terminals.map((t) => t.id), [terminals]);

  // Track previous drag state to detect drag end
  const wasDraggingRef = useRef(false);

  // Resize terminals after non-drag layout changes. Drag end owns its final
  // pass in handleDragStateChange so pending ownership starts synchronously
  // with the unlock and the watchdog cannot race the settled geometry.
  useEffect(() => {
    const wasDragging = wasDraggingRef.current;
    wasDraggingRef.current = isDraggingDivider;

    if (isDraggingDivider || wasDragging) return;

    terminalInstanceService.scheduleBatchResize(panelIds);
    return undefined;
    // `leftWidth`/`rightWidth` are now ratio-derived calc() strings, so they no
    // longer change on container resize — depend on `clampedRatio` (ratio drags,
    // double-click reset) and `containerWidth` (container/sidebar reflow) so
    // terminals still re-fit on both.
  }, [clampedRatio, containerWidth, panelIds, isDraggingDivider]);

  return (
    <>
      <SortableContext
        id="grid-container"
        items={panelIds}
        strategy={horizontalListSortingStrategy}
      >
        <div
          ref={containerRef}
          className={cn("h-full grid bg-noise p-1")}
          style={{
            gap: 0,
            gridTemplateColumns,
            backgroundColor: "var(--color-grid-bg)",
          }}
          id="panel-grid"
          data-grid-container="true"
          data-split-mode="true"
        >
          {/* min-h-0: the implicit row track is `auto`, so without it a panel
              with intrinsic-height content (file viewer) sizes the row to the
              content instead of the container (#11024). */}
          <div className="relative min-w-0 min-h-0">
            <SortableTerminal
              terminal={terminals[0]}
              sourceLocation="grid"
              sourceIndex={0}
              disabled={isInTrash(terminals[0].id)}
              layoutDependency={`${terminals[0].id}:${terminals[1].id}:${clampedRatio}`}
            >
              <GridPanel
                terminalId={terminals[0].id}
                isFocused={terminals[0].id === focusedId}
                isMultiPanelGrid={true}
                onAddTabForPanel={onAddTabForPanel}
              />
            </SortableTerminal>
          </div>

          <TwoPaneSplitDivider
            containerRef={containerRef}
            ratio={clampedRatio}
            onRatioChange={handleRatioChange}
            onRatioCommit={handleRatioCommit}
            onDoubleClick={handleDoubleClick}
            onDragStateChange={handleDragStateChange}
            minRatio={minRatio}
            maxRatio={maxRatio}
          />

          <div className="relative min-w-0 min-h-0">
            <SortableTerminal
              terminal={terminals[1]}
              sourceLocation="grid"
              sourceIndex={1}
              disabled={isInTrash(terminals[1].id)}
              layoutDependency={`${terminals[0].id}:${terminals[1].id}:${clampedRatio}`}
            >
              <GridPanel
                terminalId={terminals[1].id}
                isFocused={terminals[1].id === focusedId}
                isMultiPanelGrid={true}
                onAddTabForPanel={onAddTabForPanel}
              />
            </SortableTerminal>
          </div>
        </div>
      </SortableContext>

      {/* Drag overlay to prevent iframes from capturing mouse events */}
      {isDraggingDivider &&
        createPortal(
          <div
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 9999,
              cursor: "col-resize",
            }}
            aria-hidden="true"
          />,
          document.body
        )}
    </>
  );
}
