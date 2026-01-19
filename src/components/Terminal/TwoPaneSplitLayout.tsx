import { useCallback, useRef, useEffect, useState, useMemo } from "react";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { cn } from "@/lib/utils";
import { useTwoPaneSplitStore } from "@/store";
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
}

export function TwoPaneSplitLayout({
  terminals,
  focusedId,
  activeWorktreeId,
  isInTrash,
}: TwoPaneSplitLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [localRatio, setLocalRatio] = useState<number | null>(null);

  const ratioByWorktreeId = useTwoPaneSplitStore((state) => state.ratioByWorktreeId);
  const defaultRatio = useTwoPaneSplitStore((state) => state.config.defaultRatio);
  const preferPreview = useTwoPaneSplitStore((state) => state.config.preferPreview);
  const setWorktreeRatio = useTwoPaneSplitStore((state) => state.setWorktreeRatio);
  const resetWorktreeRatio = useTwoPaneSplitStore((state) => state.resetWorktreeRatio);

  const worktreeRatio = activeWorktreeId ? ratioByWorktreeId[activeWorktreeId] : undefined;

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
    if (worktreeRatio !== undefined) {
      return worktreeRatio;
    }
    return computeDefaultRatio();
  }, [localRatio, worktreeRatio, computeDefaultRatio]);

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

  const handleRatioChange = useCallback(
    (newRatio: number) => {
      setLocalRatio(newRatio);
    },
    []
  );

  const handleRatioCommit = useCallback(() => {
    if (localRatio !== null && activeWorktreeId) {
      setWorktreeRatio(activeWorktreeId, localRatio);
      setLocalRatio(null);
    }
  }, [localRatio, activeWorktreeId, setWorktreeRatio]);

  const handleDoubleClick = useCallback(() => {
    if (activeWorktreeId) {
      resetWorktreeRatio(activeWorktreeId);
    }
  }, [activeWorktreeId, resetWorktreeRatio]);

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
  const leftWidth = containerWidth > 0 ? containerWidth * clampedRatio - DIVIDER_WIDTH_PX / 2 : "50%";
  const rightWidth =
    containerWidth > 0 ? containerWidth * (1 - clampedRatio) - DIVIDER_WIDTH_PX / 2 : "50%";

  const terminalIds = useMemo(() => terminals.map((t) => t.id), [terminals]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      for (const terminal of terminals) {
        const managed = terminalInstanceService.get(terminal.id);
        if (managed?.hostElement.isConnected) {
          terminalInstanceService.fit(terminal.id);
        }
      }
    }, 50);

    return () => clearTimeout(timeoutId);
  }, [leftWidth, rightWidth, terminals]);

  return (
    <SortableContext id="grid-container" items={terminalIds} strategy={horizontalListSortingStrategy}>
      <div
        ref={containerRef}
        className={cn("h-full flex bg-noise p-1")}
        style={{
          gap: 0,
          backgroundColor: "var(--color-grid-bg)",
        }}
        role="grid"
        id="terminal-grid"
        aria-label="Panel grid - two pane split"
        data-grid-container="true"
        data-split-mode="true"
      >
        <div style={{ width: leftWidth, minWidth: MIN_TERMINAL_WIDTH_PX, flexShrink: 0 }}>
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
            />
          </SortableTerminal>
        </div>

        <TwoPaneSplitDivider
          containerRef={containerRef}
          ratio={clampedRatio}
          onRatioChange={handleRatioChange}
          onRatioCommit={handleRatioCommit}
          onDoubleClick={handleDoubleClick}
          minRatio={minRatio}
          maxRatio={maxRatio}
        />

        <div style={{ width: rightWidth, minWidth: MIN_TERMINAL_WIDTH_PX, flexShrink: 0 }}>
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
            />
          </SortableTerminal>
        </div>
      </div>
    </SortableContext>
  );
}
