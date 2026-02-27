import { useMemo, useRef, useCallback } from "react";
import type React from "react";
import { useShallow } from "zustand/react/shallow";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useTerminalStore, useProjectStore, useWorktreeSelectionStore } from "@/store";
import { DockedTerminalItem } from "./DockedTerminalItem";
import { DockedTabGroup } from "./DockedTabGroup";
import { TrashContainer } from "./TrashContainer";
import { WaitingContainer } from "./WaitingContainer";
import { FailedContainer } from "./FailedContainer";
import { AssistantDockButton } from "@/components/Dock/AssistantDockButton";
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

  const trashedTerminals = useTerminalStore(useShallow((state) => state.trashedTerminals));
  const terminals = useTerminalStore((state) => state.terminals);
  const getTabGroups = useTerminalStore((state) => state.getTabGroups);
  const getTabGroupPanels = useTerminalStore((state) => state.getTabGroupPanels);
  const openDockTerminal = useTerminalStore((state) => state.openDockTerminal);
  const currentProject = useProjectStore((s) => s.currentProject);

  // Get tab groups for the dock
  const tabGroups = useMemo(
    () => getTabGroups("dock", activeWorktreeId ?? undefined),
    [getTabGroups, activeWorktreeId, terminals] // re-compute when terminals change
  );

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
    async (agentId: string) => {
      const result = await actionService.dispatch<{ terminalId: string | null }>(
        "agent.launch",
        {
          agentId: agentId as any,
          location: "dock",
          cwd,
          worktreeId: activeWorktreeId || undefined,
        },
        { source: "context-menu" }
      );

      if (result.ok && result.result?.terminalId) {
        openDockTerminal(result.result.terminalId);
      }
    },
    [activeWorktreeId, cwd, openDockTerminal]
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
        void handleAddTerminal(actionId.slice("new:".length));
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

  // Tab group IDs for SortableContext
  const terminalIds = useMemo(() => {
    if (tabGroups.length === 0) {
      return [DOCK_PLACEHOLDER_ID];
    }
    // Use first panel's ID for each group (consistent with terminal-based DnD)
    return tabGroups.map((g) => g.panelIds[0] ?? g.id);
  }, [tabGroups]);

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
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={scrollLeft}
                    className={cn(
                      "pointer-events-auto p-1.5 text-canopy-text/60 hover:text-canopy-text",
                      "rounded-[var(--radius-md)] transition-colors",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
                    )}
                    aria-label="Scroll left"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Scroll left</TooltipContent>
              </Tooltip>
            </TooltipProvider>
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
              {tabGroups.length === 0 ? (
                <SortableDockPlaceholder />
              ) : (
                tabGroups.map((group, index) => {
                  const groupPanels = getTabGroupPanels(group.id, "dock");
                  if (groupPanels.length === 0) return null;

                  // Single-panel group: render DockedTerminalItem directly
                  if (groupPanels.length === 1) {
                    const terminal = groupPanels[0];
                    return (
                      <SortableDockItem key={group.id} terminal={terminal} sourceIndex={index}>
                        <DockedTerminalItem terminal={terminal} />
                      </SortableDockItem>
                    );
                  }

                  // Multi-panel group: pass group context for group-aware DnD
                  const firstPanel = groupPanels[0];
                  return (
                    <SortableDockItem
                      key={group.id}
                      terminal={firstPanel}
                      sourceIndex={index}
                      groupId={group.id}
                      groupPanelIds={group.panelIds}
                    >
                      <DockedTabGroup group={group} panels={groupPanels} />
                    </SortableDockItem>
                  );
                })
              )}
            </div>
          </SortableContext>
        </div>

        {/* Right Scroll Chevron - Overlay */}
        {canScrollRight && (
          <div className="absolute right-0 top-1/2 -translate-y-1/2 z-10 pointer-events-none bg-gradient-to-l from-[var(--dock-bg)] via-[var(--dock-bg)]/90 to-transparent pl-4">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={scrollRight}
                    className={cn(
                      "pointer-events-auto p-1.5 text-canopy-text/60 hover:text-canopy-text",
                      "rounded-[var(--radius-md)] transition-colors",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
                    )}
                    aria-label="Scroll right"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Scroll right</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        )}
      </div>

      {/* Separator between terminals and action containers */}
      {tabGroups.length > 0 && <div className="w-px h-5 bg-[var(--dock-border)] mx-1 shrink-0" />}

      {/* Action containers: Waiting + Failed + Trash + Assistant */}
      <div className="shrink-0 pl-1 flex items-center gap-2">
        <WaitingContainer compact={isCompact} />
        <FailedContainer compact={isCompact} />
        <TrashContainer trashedTerminals={trashedItems} compact={isCompact} />
        <AssistantDockButton />
      </div>
    </div>
  );
}
