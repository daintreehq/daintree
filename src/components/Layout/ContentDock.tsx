import { useMemo, useRef, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  usePanelStore,
  useProjectStore,
  useWorktreeSelectionStore,
  type TerminalInstance,
} from "@/store";
import { DockedTerminalItem } from "./DockedTerminalItem";
import { DockedTabGroup } from "./DockedTabGroup";
import { TrashContainer } from "./TrashContainer";
import { WaitingContainer } from "./WaitingContainer";
import { BackgroundContainer } from "./BackgroundContainer";
import { HelpAgentDockButton } from "./HelpAgentDockButton";
import { DockLaunchButton } from "./DockLaunchButton";
import {
  DockLaunchMenuItems,
  type DockLaunchAgent,
  type DockLaunchMenuComponents,
} from "./DockLaunchMenuItems";
import {
  SortableDockItem,
  SortableDockPlaceholder,
  DOCK_PLACEHOLDER_ID,
} from "@/components/DragDrop";
import { useWorktrees } from "@/hooks/useWorktrees";
import { useHorizontalScrollControls } from "@/hooks";
import { useProjectSettings } from "@/hooks/useProjectSettings";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import type { ActionSource } from "@shared/types/actions";
import { actionService } from "@/services/ActionService";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

import { getAgentConfig, getAgentIds } from "@/config/agents";
import { isAgentInstalled, isAgentLaunchable } from "@shared/utils/agentAvailability";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { buildDockRenderItems, type DockRenderItem } from "./dockRenderItems";
import type { DockDensity } from "@/store/preferencesStore";

const CONTEXT_MENU_COMPONENTS: DockLaunchMenuComponents = {
  Item: ContextMenuItem,
  Label: ContextMenuLabel,
  Separator: ContextMenuSeparator,
};

export type { DockDensity } from "@/store/preferencesStore";

interface ContentDockProps {
  density?: DockDensity;
}

export function ContentDock({ density = "normal" }: ContentDockProps) {
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);

  const trashedTerminals = usePanelStore(useShallow((state) => state.trashedTerminals));
  const panelsById = usePanelStore(useShallow((state) => state.panelsById));
  const storeTerminalIds = usePanelStore(useShallow((state) => state.panelIds));
  const getTabGroups = usePanelStore((state) => state.getTabGroups);
  const getTabGroupPanels = usePanelStore((state) => state.getTabGroupPanels);
  const openDockTerminal = usePanelStore((state) => state.openDockTerminal);
  const currentProject = useProjectStore((s) => s.currentProject);
  const helpTerminalId = useHelpPanelStore((s) => s.terminalId);
  const agentSettings = useAgentSettingsStore((s) => s.settings);
  const agentAvailability = useCliAvailabilityStore((s) => s.availability);
  const { settings: projectSettings } = useProjectSettings();
  const hasDevPreview = Boolean(projectSettings?.devServerCommand?.trim());

  // Get tab groups for the dock, excluding the help panel terminal
  const tabGroups = useMemo(() => {
    void storeTerminalIds;
    void panelsById;
    void trashedTerminals;
    const groups = getTabGroups("dock", activeWorktreeId ?? undefined);
    if (!helpTerminalId) return groups;
    return groups.filter((g) => !(g.panelIds.length === 1 && g.panelIds[0] === helpTerminalId));
  }, [
    getTabGroups,
    activeWorktreeId,
    storeTerminalIds,
    panelsById,
    trashedTerminals,
    helpTerminalId,
  ]);

  const dockTerminals = useMemo(() => {
    return storeTerminalIds
      .map((id) => panelsById[id])
      .filter(
        (terminal): terminal is TerminalInstance =>
          terminal !== undefined &&
          terminal.location === "dock" &&
          !trashedTerminals.has(terminal.id) &&
          terminal.id !== helpTerminalId &&
          (terminal.worktreeId == null || terminal.worktreeId === activeWorktreeId)
      );
  }, [storeTerminalIds, panelsById, trashedTerminals, helpTerminalId, activeWorktreeId]);

  const { worktrees } = useWorktrees();

  const activeWorktree = activeWorktreeId ? worktrees.find((w) => w.id === activeWorktreeId) : null;
  const cwd = activeWorktree?.path ?? currentProject?.path ?? "";

  const launchAgents = useMemo<DockLaunchAgent[]>(() => {
    const baseIds = getAgentIds();
    const settingsIds = agentSettings?.agents ? Object.keys(agentSettings.agents) : [];
    const extraIds = settingsIds.filter((id) => !baseIds.includes(id)).sort();
    return [...baseIds, ...extraIds]
      .filter((id) => isAgentInstalled(agentAvailability?.[id]))
      .map((id) => {
        const config = getAgentConfig(id);
        return {
          id,
          name: config?.name ?? id,
          icon: config?.icon,
          brandColor: config?.color,
          isEnabled: isAgentLaunchable(agentAvailability?.[id]),
        };
      });
  }, [agentAvailability, agentSettings]);

  const recipeContext = activeWorktree
    ? {
        issueNumber: activeWorktree.issueNumber,
        prNumber: activeWorktree.prNumber,
        branchName: activeWorktree.branch,
        worktreePath: activeWorktree.path,
      }
    : undefined;

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
    async (agentId: string, source: ActionSource = "menu") => {
      const result = await actionService.dispatch<{ terminalId: string | null }>(
        "agent.launch",
        {
          agentId,
          location: "dock",
          cwd,
          worktreeId: activeWorktreeId || undefined,
        },
        { source }
      );

      if (result.ok && result.result?.terminalId) {
        openDockTerminal(result.result.terminalId);
      }
    },
    [activeWorktreeId, cwd, openDockTerminal]
  );

  const trashedItems = Array.from(trashedTerminals.values())
    .map((trashed) => ({
      terminal: panelsById[trashed.id],
      trashedInfo: trashed,
    }))
    .filter((item) => item.terminal !== undefined) as {
    terminal: TerminalInstance;
    trashedInfo: typeof trashedTerminals extends Map<string, infer V> ? V : never;
  }[];

  const dockItems = useMemo<DockRenderItem[]>(() => {
    return buildDockRenderItems(
      tabGroups,
      (groupId) => getTabGroupPanels(groupId, "dock"),
      helpTerminalId,
      dockTerminals
    );
  }, [tabGroups, getTabGroupPanels, helpTerminalId, dockTerminals]);

  // Tab group IDs for SortableContext
  const panelIds = useMemo(() => {
    if (dockItems.length === 0) {
      return [DOCK_PLACEHOLDER_ID];
    }
    // Use first panel's ID for each group (consistent with terminal-based DnD)
    return dockItems.map((item) => item.panels[0]?.id ?? item.group.id);
  }, [dockItems]);

  const isCompact = density === "compact";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          id="dock-container"
          className={cn(
            "bg-[var(--dock-bg)]/95 backdrop-blur-sm",
            "border-t border-[var(--dock-border)]",
            "shadow-[var(--dock-shadow)]",
            "flex items-center px-[var(--dock-padding-x)] py-[var(--dock-padding-y)] gap-[var(--dock-gap)]",
            "z-40 shrink-0"
          )}
          data-dock-density={density}
        >
          <div className="shrink-0 flex items-center">
            <DockLaunchButton
              agents={launchAgents}
              hasDevPreview={hasDevPreview}
              onLaunchAgent={(agentId) => void handleAddTerminal(agentId, "menu")}
              activeWorktreeId={activeWorktreeId}
              cwd={cwd}
              recipeContext={recipeContext}
            />
          </div>

          <div className="relative flex-1 min-w-0">
            {/* Left Scroll Chevron - Overlay */}
            {canScrollLeft && (
              <div className="absolute left-0 top-1/2 -translate-y-1/2 z-10 pointer-events-none bg-gradient-to-r from-[var(--dock-bg)] via-[var(--dock-bg)]/90 to-transparent pr-4">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={scrollLeft}
                      className={cn(
                        "pointer-events-auto p-1.5 text-daintree-text/60 hover:text-daintree-text",
                        "rounded-[var(--radius-md)] transition-colors",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
                      )}
                      aria-label="Scroll left"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Scroll left</TooltipContent>
                </Tooltip>
              </div>
            )}

            {/* Scrollable Container */}
            <div
              ref={combinedRef}
              className={cn(
                "flex items-center gap-[var(--dock-gap)] overflow-x-auto overscroll-x-none flex-1 min-h-[var(--dock-item-height)] no-scrollbar scroll-smooth px-1",
                isOver &&
                  "bg-overlay-soft ring-2 ring-daintree-accent/30 ring-inset rounded-[var(--radius-md)]"
              )}
            >
              <SortableContext
                id="dock-container"
                items={panelIds}
                strategy={horizontalListSortingStrategy}
              >
                <div className="flex items-center gap-[var(--dock-gap)] min-w-[100px] min-h-[calc(var(--dock-item-height)-4px)]">
                  {dockItems.length === 0 ? (
                    <SortableDockPlaceholder />
                  ) : (
                    dockItems.map(({ group, panels }, index) => {
                      // Single-panel group: render DockedTerminalItem directly
                      if (panels.length === 1) {
                        const terminal = panels[0]!;
                        return (
                          <SortableDockItem key={group.id} terminal={terminal} sourceIndex={index}>
                            <DockedTerminalItem terminal={terminal} />
                          </SortableDockItem>
                        );
                      }

                      // Multi-panel group: pass group context for group-aware DnD
                      const firstPanel = panels[0]!;
                      return (
                        <SortableDockItem
                          key={group.id}
                          terminal={firstPanel}
                          sourceIndex={index}
                          groupId={group.id}
                          groupPanelIds={group.panelIds}
                        >
                          <DockedTabGroup group={group} panels={panels} />
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
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={scrollRight}
                      className={cn(
                        "pointer-events-auto p-1.5 text-daintree-text/60 hover:text-daintree-text",
                        "rounded-[var(--radius-md)] transition-colors",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
                      )}
                      aria-label="Scroll right"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Scroll right</TooltipContent>
                </Tooltip>
              </div>
            )}
          </div>

          {/* Separator between terminals and action containers */}
          {dockItems.length > 0 && (
            <div className="w-px h-5 bg-[var(--dock-border)] mx-1 shrink-0" />
          )}

          {/* Action containers: Background + Waiting + Trash */}
          <div className="shrink-0 pl-1 flex items-center gap-2">
            <BackgroundContainer compact={isCompact} />
            <WaitingContainer compact={isCompact} />
            <TrashContainer trashedTerminals={trashedItems} compact={isCompact} />
          </div>

          {/* Right-aligned cluster: help */}
          <div className="ml-auto shrink-0 flex items-center gap-2">
            <HelpAgentDockButton />
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <DockLaunchMenuItems
          components={CONTEXT_MENU_COMPONENTS}
          agents={launchAgents}
          hasDevPreview={hasDevPreview}
          activeWorktreeId={activeWorktreeId}
          cwd={cwd}
          recipeContext={recipeContext}
          onLaunchAgent={(agentId) => void handleAddTerminal(agentId, "context-menu")}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}
