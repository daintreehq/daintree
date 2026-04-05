import { useCallback, useRef, useEffect, useState, useMemo } from "react";
import { createPortal } from "react-dom";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { cn } from "@/lib/utils";
import { useTwoPaneSplitStore } from "@/store";
import { resolveEffectiveRatio } from "@/store/twoPaneSplitStore";
import type { TerminalInstance } from "@/store";
import { SortableTerminal } from "@/components/DragDrop";
import { GridPanel } from "./GridPanel";
import { TwoPaneSplitDivider, DIVIDER_WIDTH_PX } from "./TwoPaneSplitDivider";
import { MIN_TERMINAL_WIDTH_PX } from "@/lib/terminalLayout";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

interface TwoPaneSplitLayoutProps {
  terminals: [TerminalInstance, TerminalInstance];
  focusedId: string | null;
  activeWorktreeId: string | null;
  isInTrash: (id: string) => boolean;
  onAddTabLeft?: () => void;
  onAddTabRight?: () => void;
}

export function TwoPaneSplitLayout({
  terminals,
  focusedId,
  activeWorktreeId,
  isInTrash,
  onAddTabLeft,
  onAddTabRight,
}: TwoPaneSplitLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [localRatio, setLocalRatio] = useState<number | null>(null);
  const [isDraggingDivider, setIsDraggingDivider] = useState(false);

  // Refs for unmount cleanup (avoid closure/dependency issues)
  const localRatioRef = useRef<number | null>(null);
  const activeWorktreeIdRef = useRef<string | null>(null);
  const terminalsRef = useRef(terminals);
  const commitRatioIfChangedRef = useRef<typeof commitRatioIfChanged>(null!);

  localRatioRef.current = localRatio;
  activeWorktreeIdRef.current = activeWorktreeId;
  terminalsRef.current = terminals;

  const ratioByWorktreeId = useTwoPaneSplitStore((state) => state.ratioByWorktreeId);
  const defaultRatio = useTwoPaneSplitStore((state) => state.config.defaultRatio);
  const preferPreview = useTwoPaneSplitStore((state) => state.config.preferPreview);
  const commitRatioIfChanged = useTwoPaneSplitStore((state) => state.commitRatioIfChanged);
  const resetWorktreeRatio = useTwoPaneSplitStore((state) => state.resetWorktreeRatio);

  commitRatioIfChangedRef.current = commitRatioIfChanged;

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
    const leftIsPreview = left.kind === "browser" || left.kind === "dev-preview";
    const rightIsPreview = right.kind === "browser" || right.kind === "dev-preview";

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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerWidth(entry.contentRect.width);
      }
    });

    observer.observe(container);
    setContainerWidth(container.clientWidth);

    return () => {
      observer.disconnect();
    };
  }, []);

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

      // Lock/unlock terminal resizing to prevent xterm from reacting to size changes during drag
      for (const terminal of terminals) {
        terminalInstanceService.lockResize(terminal.id, dragging);
      }
    },
    [terminals]
  );

  // Cleanup: unlock resize and flush pending ratio on unmount only
  useEffect(() => {
    return () => {
      // Read latest values from refs to avoid stale closures
      const pendingRatio = localRatioRef.current;
      const worktreeId = activeWorktreeIdRef.current;

      // Unlock resize for all terminals
      for (const terminal of terminalsRef.current) {
        terminalInstanceService.lockResize(terminal.id, false);
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
  const leftWidth =
    containerWidth > 0 ? containerWidth * clampedRatio - DIVIDER_WIDTH_PX / 2 : "50%";
  const rightWidth =
    containerWidth > 0 ? containerWidth * (1 - clampedRatio) - DIVIDER_WIDTH_PX / 2 : "50%";

  const terminalIds = useMemo(() => terminals.map((t) => t.id), [terminals]);

  // Track previous drag state to detect drag end
  const wasDraggingRef = useRef(false);

  // Fit terminals after resize, but skip during drag to avoid feedback loops
  useEffect(() => {
    const wasDragging = wasDraggingRef.current;
    wasDraggingRef.current = isDraggingDivider;

    // Don't fit during drag - wait for drag to end
    if (isDraggingDivider) return;

    // Use longer delay after drag ends to let layout fully stabilize
    const delay = wasDragging ? 100 : 50;

    const timeoutId = window.setTimeout(() => {
      for (const terminal of terminals) {
        const managed = terminalInstanceService.get(terminal.id);
        if (managed?.hostElement.isConnected) {
          terminalInstanceService.fit(terminal.id);
        }
      }
    }, delay);

    return () => clearTimeout(timeoutId);
  }, [leftWidth, rightWidth, terminals, isDraggingDivider]);

  return (
    <>
      <SortableContext
        id="grid-container"
        items={terminalIds}
        strategy={horizontalListSortingStrategy}
      >
        <div
          ref={containerRef}
          className={cn("h-full flex bg-noise p-1")}
          style={{
            gap: 0,
            backgroundColor: "var(--color-grid-bg)",
          }}
          role="grid"
          id="panel-grid"
          aria-label="Panel grid - two pane split"
          data-grid-container="true"
          data-split-mode="true"
        >
          <div
            style={{ width: leftWidth, minWidth: MIN_TERMINAL_WIDTH_PX, flexShrink: 0 }}
            className="relative"
          >
            <SortableTerminal
              terminal={terminals[0]}
              sourceLocation="grid"
              sourceIndex={0}
              disabled={isInTrash(terminals[0].id)}
            >
              <GridPanel
                terminal={terminals[0]}
                isFocused={terminals[0].id === focusedId}
                gridPanelCount={2}
                gridCols={2}
                onAddTab={onAddTabLeft}
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

          <div
            style={{ width: rightWidth, minWidth: MIN_TERMINAL_WIDTH_PX, flexShrink: 0 }}
            className="relative"
          >
            <SortableTerminal
              terminal={terminals[1]}
              sourceLocation="grid"
              sourceIndex={1}
              disabled={isInTrash(terminals[1].id)}
            >
              <GridPanel
                terminal={terminals[1]}
                isFocused={terminals[1].id === focusedId}
                gridPanelCount={2}
                gridCols={2}
                onAddTab={onAddTabRight}
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
