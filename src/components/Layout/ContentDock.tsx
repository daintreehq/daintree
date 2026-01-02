import { useMemo, useRef, useCallback } from "react";
import type React from "react";
import { useShallow } from "zustand/react/shallow";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTerminalStore, useProjectStore, useWorktreeSelectionStore } from "@/store";
import { DockedTerminalItem } from "./DockedTerminalItem";
import { TrashContainer } from "./TrashContainer";
import { WaitingContainer } from "./WaitingContainer";
import { FailedContainer } from "./FailedContainer";
import {
  SortableDockItem,
  SortableDockPlaceholder,
  DOCK_PLACEHOLDER_ID,
} from "@/components/DragDrop";
import { useWorktrees } from "@/hooks/useWorktrees";
import { useNativeContextMenu, useHorizontalScrollControls } from "@/hooks";
import type { MenuItemOption } from "@/types";
import { actionService } from "@/services/ActionService";

const AGENT_OPTIONS = [
  { type: "claude" as const, label: "Claude" },
  { type: "gemini" as const, label: "Gemini" },
  { type: "codex" as const, label: "Codex" },
  { type: "opencode" as const, label: "OpenCode" },
  { type: "terminal" as const, label: "Terminal" },
  { type: "browser" as const, label: "Browser" },
];

export type DockDensity = "normal" | "compact";

interface ContentDockProps {
  density?: DockDensity;
}

export function ContentDock({ density = "normal" }: ContentDockProps) {
  const { showMenu } = useNativeContextMenu();
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);

  const dockTerminals = useTerminalStore(
    useShallow((state) =>
      state.terminals.filter(
        (t) =>
          t.location === "dock" && (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
      )
    )
  );

  const trashedTerminals = useTerminalStore(useShallow((state) => state.trashedTerminals));
  const terminals = useTerminalStore((state) => state.terminals);
  const currentProject = useProjectStore((s) => s.currentProject);

  const { worktrees } = useWorktrees();

  const activeWorktree = activeWorktreeId ? worktrees.find((w) => w.id === activeWorktreeId) : null;
  const cwd = activeWorktree?.path ?? currentProject?.path ?? "";

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { canScrollLeft, canScrollRight, scrollLeft, scrollRight } =
    useHorizontalScrollControls(scrollContainerRef);

  // Make the dock terminals area droppable
  const { setNodeRef: setDockDropRef, isOver } = useDroppable({
    id: "dock-container",
    data: { container: "dock" },
  });

  // Sync droppable ref with scroll container ref using stable callback
  // This prevents ResizeObserver thrashing that causes infinite update loops
  const combinedRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollContainerRef.current = node;
      setDockDropRef(node);
    },
    [setDockDropRef]
  );

  const handleAddTerminal = useCallback(
    (agentId: string) => {
      void actionService.dispatch(
        "agent.launch",
        {
          agentId: agentId as any,
          location: "dock",
          cwd,
          worktreeId: activeWorktreeId || undefined,
        },
        { source: "context-menu" }
      );
    },
    [activeWorktreeId, cwd]
  );

  const handleContextMenu = useCallback(
    async (event: React.MouseEvent) => {
      const template: MenuItemOption[] = AGENT_OPTIONS.map(({ type, label }) => ({
        id: `new:${type}`,
        label: `New ${label}`,
      }));

      const actionId = await showMenu(event, template);
      if (!actionId) return;

      if (actionId.startsWith("new:")) {
        handleAddTerminal(actionId.slice("new:".length));
      }
    },
    [handleAddTerminal, showMenu]
  );

  const trashedItems = Array.from(trashedTerminals.values())
    .map((trashed) => ({
      terminal: terminals.find((t) => t.id === trashed.id),
      trashedInfo: trashed,
    }))
    .filter((item) => item.terminal !== undefined) as {
    terminal: (typeof terminals)[0];
    trashedInfo: typeof trashedTerminals extends Map<string, infer V> ? V : never;
  }[];

  const activeDockTerminals = dockTerminals;

  // Terminal IDs for SortableContext
  const terminalIds = useMemo(() => {
    if (activeDockTerminals.length === 0) {
      return [DOCK_PLACEHOLDER_ID];
    }
    return activeDockTerminals.map((t) => t.id);
  }, [activeDockTerminals]);

  const isCompact = density === "compact";

  return (
    <div
      onContextMenu={handleContextMenu}
      className={cn(
        "bg-[var(--dock-bg)]/95 backdrop-blur-sm",
        "border-t border-[var(--dock-border)]",
        "shadow-[var(--dock-shadow)]",
        "flex items-center px-[var(--dock-padding-x)] py-[var(--dock-padding-y)] gap-[var(--dock-gap)]",
        "z-40 shrink-0"
      )}
      data-dock-density={density}
    >
      <div className="relative flex-1 min-w-0">
        {/* Left Scroll Chevron - Overlay */}
        {canScrollLeft && (
          <div className="absolute left-0 top-1/2 -translate-y-1/2 z-10 pointer-events-none bg-gradient-to-r from-[var(--dock-bg)] via-[var(--dock-bg)]/90 to-transparent pr-4">
            <button
              type="button"
              onClick={scrollLeft}
              className={cn(
                "pointer-events-auto p-1.5 text-canopy-text/60 hover:text-canopy-text",
                "rounded-[var(--radius-md)] transition-colors",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
              )}
              aria-label="Scroll left"
              title="Scroll left"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Scrollable Container */}
        <div
          ref={combinedRef}
          className={cn(
            "flex items-center gap-[var(--dock-gap)] overflow-x-auto flex-1 min-h-[var(--dock-item-height)] no-scrollbar scroll-smooth px-1",
            isOver &&
              "bg-white/[0.03] ring-2 ring-canopy-accent/30 ring-inset rounded-[var(--radius-md)]"
          )}
        >
          <SortableContext
            id="dock-container"
            items={terminalIds}
            strategy={horizontalListSortingStrategy}
          >
            <div className="flex items-center gap-[var(--dock-gap)] min-w-[100px] min-h-[calc(var(--dock-item-height)-4px)]">
              {activeDockTerminals.length === 0 ? (
                <SortableDockPlaceholder />
              ) : (
                activeDockTerminals.map((terminal, index) => (
                  <SortableDockItem key={terminal.id} terminal={terminal} sourceIndex={index}>
                    <DockedTerminalItem terminal={terminal} />
                  </SortableDockItem>
                ))
              )}
            </div>
          </SortableContext>
        </div>

        {/* Right Scroll Chevron - Overlay */}
        {canScrollRight && (
          <div className="absolute right-0 top-1/2 -translate-y-1/2 z-10 pointer-events-none bg-gradient-to-l from-[var(--dock-bg)] via-[var(--dock-bg)]/90 to-transparent pl-4">
            <button
              type="button"
              onClick={scrollRight}
              className={cn(
                "pointer-events-auto p-1.5 text-canopy-text/60 hover:text-canopy-text",
                "rounded-[var(--radius-md)] transition-colors",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
              )}
              aria-label="Scroll right"
              title="Scroll right"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {/* Separator between terminals and action containers */}
      {activeDockTerminals.length > 0 && (
        <div className="w-px h-5 bg-[var(--dock-border)] mx-1 shrink-0" />
      )}

      {/* Action containers: Waiting + Failed + Trash */}
      <div className="shrink-0 pl-1 flex items-center gap-2">
        <WaitingContainer compact={isCompact} />
        <FailedContainer compact={isCompact} />
        <TrashContainer trashedTerminals={trashedItems} compact={isCompact} />
      </div>
    </div>
  );
}
