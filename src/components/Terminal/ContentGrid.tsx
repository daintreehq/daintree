import React, { useMemo, useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import {
  useTerminalStore,
  useLayoutConfigStore,
  useWorktreeSelectionStore,
  usePreferencesStore,
  useTwoPaneSplitStore,
  useSidecarStore,
  type TerminalInstance,
} from "@/store";
import { useProjectStore } from "@/store/projectStore";
import { useRecipeStore } from "@/store/recipeStore";
import { GridPanel } from "./GridPanel";
import { GridTabGroup } from "./GridTabGroup";
import { GridNotificationBar } from "./GridNotificationBar";
import { TerminalCountWarning } from "./TerminalCountWarning";
import { GridFullOverlay } from "./GridFullOverlay";
import { TwoPaneSplitLayout } from "./TwoPaneSplitLayout";
import {
  SortableTerminal,
  useDndPlaceholder,
  useIsDragging,
  GRID_PLACEHOLDER_ID,
  SortableGridPlaceholder,
} from "@/components/DragDrop";
import { AlertTriangle, Settings, Play, Pin, BookOpen, Sparkles } from "lucide-react";
import { CanopyIcon } from "@/components/icons";
import { ProjectPulseCard } from "@/components/Pulse";
import { Kbd } from "@/components/ui/Kbd";
import { svgToDataUrl, sanitizeSvg } from "@/lib/svg";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { computeGridColumns, MIN_TERMINAL_HEIGHT_PX } from "@/lib/terminalLayout";
import { useWorktrees } from "@/hooks/useWorktrees";
import { useNativeContextMenu, useProjectBranding } from "@/hooks";
import { actionService } from "@/services/ActionService";
import type { CliAvailability } from "@shared/types";
import type { MenuItemOption } from "@/types";
import { getRecipeGridClasses, getRecipeTerminalSummary } from "./utils/recipeUtils";
import { PROJECT_EXPLANATION_PROMPT, getDefaultAgentId } from "@/lib/projectExplanationPrompt";
import { buildWhatsNextPrompt } from "@/lib/whatsNextPrompt";
import { cliAvailabilityClient } from "@/clients";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import {
  GettingStartedChecklist,
  shouldShowGettingStartedChecklist,
} from "@/components/Setup/GettingStartedChecklist";
import { buildPanelDuplicateOptions } from "@/services/terminal/panelDuplicationService";
import { getEffectiveAgentIds, getEffectiveAgentConfig } from "@shared/config/agentRegistry";

export interface ContentGridProps {
  className?: string;
  defaultCwd?: string;
  agentAvailability?: CliAvailability;
}

function EmptyState({
  hasActiveWorktree,
  activeWorktreeName,
  activeWorktreeId,
  showProjectPulse,
  projectIconSvg,
  defaultCwd,
  agentAvailability,
}: {
  hasActiveWorktree: boolean;
  activeWorktreeName?: string | null;
  activeWorktreeId?: string | null;
  showProjectPulse: boolean;
  projectIconSvg?: string;
  defaultCwd?: string;
  agentAvailability?: CliAvailability;
}) {
  const allRecipes = useRecipeStore((state) => state.recipes);
  const runRecipe = useRecipeStore((state) => state.runRecipe);
  const recipes = useMemo(() => {
    return allRecipes.filter(
      (r) => r.worktreeId === activeWorktreeId || r.worktreeId === undefined
    );
  }, [allRecipes, activeWorktreeId]);

  // Combine pinned and recently-used recipes into a unified display
  // Pinned recipes first (sorted by lastUsedAt), then recent non-pinned
  const displayRecipes = useMemo(() => {
    const MAX_RECIPES = 6;

    // Get pinned recipes sorted by lastUsedAt
    const pinned = recipes
      .filter((r) => r.showInEmptyState)
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));

    // Get recently-used non-pinned recipes to backfill remaining slots
    const pinnedIds = new Set(pinned.map((r) => r.id));
    const remainingSlots = Math.max(0, MAX_RECIPES - pinned.length);
    const recent = recipes
      .filter((r) => !r.showInEmptyState && r.lastUsedAt != null && !pinnedIds.has(r.id))
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
      .slice(0, remainingSlots);

    // Combine: pinned first, then recent, up to MAX_RECIPES total
    return [...pinned, ...recent].slice(0, MAX_RECIPES);
  }, [recipes]);

  const handleOpenHelp = () => {
    void actionService.dispatch(
      "system.openExternal",
      { url: "https://github.com/gregpriday/canopy-electron#readme" },
      { source: "user" }
    );
  };

  const handleOpenProjectSettings = () => {
    window.dispatchEvent(new CustomEvent("canopy:open-project-settings"));
  };

  const handleRunRecipe = async (recipeId: string) => {
    if (!defaultCwd) return;
    try {
      await runRecipe(recipeId, defaultCwd, activeWorktreeId ?? undefined);
    } catch (error) {
      console.error("Failed to run recipe:", error);
    }
  };

  const defaultSelection = useToolbarPreferencesStore((state) => state.launcher.defaultSelection);
  const defaultAgent = useToolbarPreferencesStore((state) => state.launcher.defaultAgent);
  const emptyStateAgentSettings = useAgentSettingsStore((state) => state.settings);

  // undefined = no filter (settings not loaded or pre-migration); Set = loaded, filter to non-hidden
  const selectedAgentIds = useMemo((): Set<string> | undefined => {
    if (!emptyStateAgentSettings?.agents) return undefined;
    return new Set(
      Object.entries(emptyStateAgentSettings.agents)
        .filter(([, entry]) => entry.selected !== false)
        .map(([id]) => id)
    );
  }, [emptyStateAgentSettings]);

  const handleExplainProject = async () => {
    if (!defaultCwd) return;

    try {
      const availability = agentAvailability ?? (await cliAvailabilityClient.get());
      const agentId = getDefaultAgentId(
        defaultAgent,
        defaultSelection,
        availability,
        selectedAgentIds
      );

      if (!agentId) {
        console.error("No available agent to explain project");
        return;
      }

      void actionService.dispatch(
        "agent.launch",
        {
          agentId,
          location: "grid",
          cwd: defaultCwd,
          prompt: PROJECT_EXPLANATION_PROMPT,
          interactive: true,
        },
        { source: "user" }
      );
    } catch (error) {
      console.error("Failed to launch project explanation:", error);
    }
  };

  const [isLaunchingWhatsNext, setIsLaunchingWhatsNext] = React.useState(false);

  const handleWhatsNext = async () => {
    if (!defaultCwd || !activeWorktreeId || isLaunchingWhatsNext) return;

    setIsLaunchingWhatsNext(true);
    try {
      const availability = agentAvailability ?? (await cliAvailabilityClient.get());
      const agentId = getDefaultAgentId(
        defaultAgent,
        defaultSelection,
        availability,
        selectedAgentIds
      );

      if (!agentId) {
        console.error("No available agent for What's Next workflow");
        return;
      }

      const prompt = buildWhatsNextPrompt();

      void actionService.dispatch(
        "agent.launch",
        {
          agentId,
          location: "grid",
          cwd: defaultCwd,
          worktreeId: activeWorktreeId,
          prompt,
          interactive: true,
        },
        { source: "user" }
      );
    } catch (error) {
      console.error("Failed to launch What's Next workflow:", error);
    } finally {
      setTimeout(() => setIsLaunchingWhatsNext(false), 1000);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full w-full p-8 animate-in fade-in duration-500">
      <div className="max-w-3xl w-full flex flex-col items-center">
        <div className="mb-12 flex flex-col items-center text-center">
          <div className="relative group mb-8">
            {projectIconSvg ? (
              (() => {
                // Defense-in-depth: sanitize SVG at render time
                const sanitized = sanitizeSvg(projectIconSvg);
                if (!sanitized.ok) {
                  return <CanopyIcon className="h-28 w-28 text-white/80" />;
                }
                return (
                  <img
                    src={svgToDataUrl(sanitized.svg)}
                    alt="Project icon"
                    className="h-28 w-28 object-contain"
                  />
                );
              })()
            ) : (
              <CanopyIcon className="h-28 w-28 text-white/80" />
            )}
            {hasActiveWorktree && (
              <button
                type="button"
                onClick={handleOpenProjectSettings}
                className="absolute -bottom-1 -right-1 p-1.5 bg-canopy-sidebar border border-canopy-border rounded-full opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity hover:bg-canopy-bg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent"
                aria-label="Change project icon"
              >
                <Settings className="h-3 w-3 text-canopy-text/70" />
              </button>
            )}
          </div>
          <h3 className="text-2xl font-semibold text-canopy-text tracking-tight mb-3">
            {activeWorktreeName || "Canopy"}
          </h3>
          {!activeWorktreeName && (
            <p className="text-sm text-canopy-text/60 max-w-md leading-relaxed font-medium">
              A habitat for your AI agents.
            </p>
          )}
        </div>

        {!hasActiveWorktree && (
          <div
            className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2 mb-6 max-w-md text-center"
            role="status"
            aria-live="polite"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>Select a worktree in the sidebar to set the working directory for agents</span>
          </div>
        )}

        {hasActiveWorktree && displayRecipes.length > 0 && (
          <div className="mb-8 w-full max-w-2xl">
            <h4 className="text-xs font-semibold text-canopy-text/50 uppercase tracking-wider mb-3 text-center">
              Recipes
            </h4>
            <div className={getRecipeGridClasses(displayRecipes.length)}>
              {displayRecipes.map((recipe) => {
                const isPinned = recipe.showInEmptyState === true;
                return (
                  <button
                    key={recipe.id}
                    type="button"
                    onClick={() => handleRunRecipe(recipe.id)}
                    disabled={!defaultCwd}
                    className={cn(
                      "p-4 border rounded-[var(--radius-md)] transition-all text-left group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent disabled:opacity-50 disabled:cursor-not-allowed",
                      isPinned
                        ? "bg-canopy-accent/5 border-canopy-accent/30 hover:bg-canopy-accent/10 hover:border-canopy-accent/60"
                        : "bg-canopy-sidebar border-canopy-border hover:bg-canopy-bg hover:border-canopy-accent/50"
                    )}
                  >
                    <div className="flex items-center gap-2 mb-2 min-w-0">
                      <Play className="h-4 w-4 text-canopy-accent group-hover:text-canopy-accent/80 shrink-0" />
                      <h5 className="font-medium text-sm text-canopy-text truncate flex-1">
                        {recipe.name}
                      </h5>
                      {isPinned && (
                        <>
                          <span className="sr-only">Pinned</span>
                          <Pin
                            className="h-3.5 w-3.5 text-canopy-accent/60 shrink-0"
                            aria-hidden="true"
                          />
                        </>
                      )}
                    </div>
                    <p className="text-xs text-canopy-muted leading-relaxed">
                      {getRecipeTerminalSummary(recipe.terminals)}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {showProjectPulse && hasActiveWorktree && activeWorktreeId && (
          <div className="flex justify-center mb-8">
            <ProjectPulseCard worktreeId={activeWorktreeId} />
          </div>
        )}

        {hasActiveWorktree && shouldShowGettingStartedChecklist() && <GettingStartedChecklist />}

        <div className="flex flex-col items-center gap-4 mt-4">
          {hasActiveWorktree && (
            <>
              <p className="text-xs text-canopy-text/60 text-center">
                Tip: Press <Kbd>⌘P</Kbd> to open the command palette or <Kbd>⌘T</Kbd> for a new
                terminal
              </p>

              <div className="flex flex-wrap items-center justify-center gap-x-1 gap-y-2">
                <button
                  type="button"
                  onClick={handleExplainProject}
                  disabled={!defaultCwd}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-white/5 transition-colors group disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-canopy-accent/50"
                >
                  <BookOpen className="h-3.5 w-3.5 text-canopy-text/50 group-hover:text-canopy-text/70 transition-colors" />
                  <span className="text-xs text-canopy-text/50 group-hover:text-canopy-text/70 transition-colors">
                    What's This Project?
                  </span>
                </button>

                <span className="text-canopy-text/20" aria-hidden="true">
                  ·
                </span>

                <button
                  type="button"
                  onClick={handleWhatsNext}
                  disabled={!defaultCwd || isLaunchingWhatsNext}
                  aria-busy={isLaunchingWhatsNext}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-white/5 transition-colors group disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-canopy-accent/50"
                >
                  <Sparkles
                    className={cn(
                      "h-3.5 w-3.5 text-canopy-text/50 group-hover:text-canopy-text/70 transition-colors",
                      isLaunchingWhatsNext && "animate-pulse"
                    )}
                  />
                  <span className="text-xs text-canopy-text/50 group-hover:text-canopy-text/70 transition-colors">
                    What's Next?
                  </span>
                </button>

                <span className="text-canopy-text/20" aria-hidden="true">
                  ·
                </span>

                <button
                  type="button"
                  onClick={handleOpenHelp}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-white/5 transition-colors group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-canopy-accent/50"
                >
                  <div className="w-0 h-0 border-t-[2.5px] border-t-transparent border-l-[5px] border-l-canopy-text/50 border-b-[2.5px] border-b-transparent group-hover:border-l-canopy-text/70 transition-colors" />
                  <span className="text-xs text-canopy-text/50 group-hover:text-canopy-text/70 transition-colors">
                    Docs
                  </span>
                </button>
              </div>
            </>
          )}

          {!hasActiveWorktree && (
            <button
              type="button"
              onClick={handleOpenHelp}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md hover:bg-white/5 transition-colors group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-canopy-accent/50"
            >
              <div className="w-0 h-0 border-t-[2.5px] border-t-transparent border-l-[5px] border-l-canopy-text/50 border-b-[2.5px] border-b-transparent group-hover:border-l-canopy-text/70 transition-colors" />
              <span className="text-xs text-canopy-text/50 group-hover:text-canopy-text/70 transition-colors">
                View documentation
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function ContentGrid({ className, defaultCwd, agentAvailability }: ContentGridProps) {
  const { showMenu } = useNativeContextMenu();
  const {
    terminals,
    focusedId,
    maximizedId,
    maximizeTarget,
    preMaximizeLayout,
    clearPreMaximizeLayout,
    validateMaximizeTarget,
    getTerminal,
    setFocused,
  } = useTerminalStore(
    useShallow((state) => ({
      terminals: state.terminals,
      focusedId: state.focusedId,
      maximizedId: state.maximizedId,
      maximizeTarget: state.maximizeTarget,
      preMaximizeLayout: state.preMaximizeLayout,
      clearPreMaximizeLayout: state.clearPreMaximizeLayout,
      validateMaximizeTarget: state.validateMaximizeTarget,
      getTerminal: state.getTerminal,
      setFocused: state.setFocused,
    }))
  );

  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const showProjectPulse = usePreferencesStore((state) => state.showProjectPulse);
  const currentProject = useProjectStore((state) => state.currentProject);
  const gridAgentSettings = useAgentSettingsStore((state) => state.settings);

  // undefined = no filter (settings not loaded or pre-migration); Set = loaded, filter to non-hidden
  const gridSelectedAgentIds = useMemo((): Set<string> | undefined => {
    if (!gridAgentSettings?.agents) return undefined;
    return new Set(
      Object.entries(gridAgentSettings.agents)
        .filter(([, entry]) => entry.selected !== false)
        .map(([id]) => id)
    );
  }, [gridAgentSettings]);
  const isProjectSwitching = useProjectStore((state) => state.isSwitching);
  const { projectIconSvg } = useProjectBranding(currentProject?.id);
  const { worktreeMap } = useWorktrees();
  const activeWorktree = activeWorktreeId ? worktreeMap.get(activeWorktreeId) : null;
  const hasActiveWorktree = activeWorktreeId != null && activeWorktree != null;
  const activeWorktreeName = activeWorktree
    ? activeWorktree.branch?.trim() || activeWorktree.name?.trim() || "Unknown Worktree"
    : null;

  const isInTrash = useTerminalStore((state) => state.isInTrash);

  // Two-pane split mode settings
  const twoPaneSplitEnabled = useTwoPaneSplitStore((state) => state.config.enabled);

  // Sidecar state - used to trigger terminal re-fit when sidecar visibility changes
  const sidecarOpen = useSidecarStore((state) => state.isOpen);
  const sidecarLayoutMode = useSidecarStore((state) => state.layoutMode);

  // Grid terminals filtered by location and active worktree
  const gridTerminals = useMemo(
    () =>
      terminals.filter(
        (t) =>
          (t.location === "grid" || t.location === undefined) &&
          (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
      ),
    [terminals, activeWorktreeId]
  );

  // Get tab groups for the grid
  const getTabGroups = useTerminalStore((state) => state.getTabGroups);
  const getTabGroupPanels = useTerminalStore((state) => state.getTabGroupPanels);
  const getPanelGroup = useTerminalStore((state) => state.getPanelGroup);
  const createTabGroup = useTerminalStore((state) => state.createTabGroup);
  const addPanelToGroup = useTerminalStore((state) => state.addPanelToGroup);
  const deleteTabGroup = useTerminalStore((state) => state.deleteTabGroup);
  const addTerminal = useTerminalStore((state) => state.addTerminal);
  const setActiveTab = useTerminalStore((state) => state.setActiveTab);

  // Get tab groups for the active worktree
  const tabGroups = useMemo(() => {
    return getTabGroups("grid", activeWorktreeId ?? undefined);
  }, [getTabGroups, activeWorktreeId, terminals]);

  // Handler for adding a new tab to a single panel (creates a tab group)
  const handleAddTabForPanel = useCallback(
    async (panel: TerminalInstance) => {
      let groupId: string;
      let createdNewGroup = false;

      try {
        const existingGroup = getPanelGroup(panel.id);
        if (existingGroup) {
          groupId = existingGroup.id;
        } else {
          const location = panel.location === "dock" ? "dock" : "grid";
          groupId = createTabGroup(location, panel.worktreeId, [panel.id], panel.id);
          createdNewGroup = true;
        }

        const options = await buildPanelDuplicateOptions(panel, "grid");
        const newPanelId = await addTerminal(options);

        addPanelToGroup(groupId, newPanelId);
        setActiveTab(groupId, newPanelId);
        setFocused(newPanelId);
      } catch (error) {
        console.error("Failed to add tab:", error);
        if (createdNewGroup && groupId!) {
          deleteTabGroup(groupId);
        }
      }
    },
    [
      getPanelGroup,
      createTabGroup,
      addPanelToGroup,
      deleteTabGroup,
      addTerminal,
      setActiveTab,
      setFocused,
    ]
  );

  const layoutConfig = useLayoutConfigStore((state) => state.layoutConfig);
  const setGridDimensions = useLayoutConfigStore((state) => state.setGridDimensions);
  const getMaxGridCapacity = useLayoutConfigStore((state) => state.getMaxGridCapacity);

  // Dynamic grid capacity based on current dimensions
  const maxGridCapacity = getMaxGridCapacity();
  // Use group count for capacity check (each tab group = 1 slot)
  const isGridFull = tabGroups.length >= maxGridCapacity;

  // Make the grid a droppable area
  const { setNodeRef, isOver } = useDroppable({
    id: "grid-container",
    data: { container: "grid" },
  });

  // Track container dimensions for responsive layout and capacity calculation
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const [gridWidth, setGridWidth] = useState<number | null>(null);

  // Get placeholder state from DnD context
  const { placeholderIndex, sourceContainer } = useDndPlaceholder();
  const isDragging = useIsDragging();
  const isDraggingRef = useRef(isDragging);
  useEffect(() => {
    isDraggingRef.current = isDragging;
  }, [isDragging]);

  // placeholderIndex is now group-based (from DndProvider), so bound by tabGroups.length
  const placeholderInGrid =
    placeholderIndex !== null && placeholderIndex >= 0 && placeholderIndex <= tabGroups.length;

  // Show placeholder when dragging from dock to grid (only if grid not full)
  const showPlaceholder = placeholderInGrid && sourceContainer === "dock" && !isGridFull;
  // Use tab groups count for grid layout (each group takes one cell)
  const gridItemCount = tabGroups.length + (showPlaceholder ? 1 : 0);

  // Attach ResizeObserver to track container dimensions
  useEffect(() => {
    const container = gridContainerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        const { width, height } = entry.contentRect;
        setGridWidth((prev) => (prev === width ? prev : width));
        setGridDimensions({ width, height });
      }
    });

    observer.observe(container);
    setGridWidth(container.clientWidth);
    setGridDimensions({ width: container.clientWidth, height: container.clientHeight });

    return () => {
      observer.disconnect();
      setGridDimensions(null);
    };
  }, [setGridDimensions, gridTerminals.length, maximizedId, twoPaneSplitEnabled, showPlaceholder]);

  useEffect(() => {
    if (preMaximizeLayout && preMaximizeLayout.worktreeId !== activeWorktreeId) {
      clearPreMaximizeLayout();
    }
  }, [activeWorktreeId, preMaximizeLayout, clearPreMaximizeLayout]);

  useEffect(() => {
    if (preMaximizeLayout && preMaximizeLayout.gridItemCount !== gridItemCount) {
      clearPreMaximizeLayout();
    }
  }, [gridItemCount, preMaximizeLayout, clearPreMaximizeLayout]);

  useEffect(() => {
    if (preMaximizeLayout) {
      clearPreMaximizeLayout();
    }
  }, [layoutConfig, preMaximizeLayout, clearPreMaximizeLayout]);

  const gridCols = useMemo(() => {
    if (
      !maximizedId &&
      preMaximizeLayout &&
      preMaximizeLayout.worktreeId === activeWorktreeId &&
      preMaximizeLayout.gridItemCount === gridItemCount
    ) {
      if (gridItemCount === 2 && preMaximizeLayout.gridCols !== 2) {
        return 2;
      }
      return preMaximizeLayout.gridCols;
    }
    const { strategy, value } = layoutConfig;
    return computeGridColumns(gridItemCount, gridWidth, strategy, value);
  }, [gridItemCount, layoutConfig, gridWidth, maximizedId, preMaximizeLayout, activeWorktreeId]);

  const handleGridContextMenu = useCallback(
    async (event: React.MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".terminal-pane")) return;

      const canLaunch = (agentId: "claude" | "gemini" | "codex" | "opencode" | "terminal") => {
        if (agentId === "terminal") return true;
        if (!agentAvailability) return true;
        return agentAvailability[agentId] === true;
      };

      // When gridSelectedAgentIds is undefined (settings not loaded), show all registry agents.
      // When it's a Set, show only agents not explicitly deselected.
      const agentMenuItems: MenuItemOption[] = getEffectiveAgentIds()
        .filter((id) => !gridSelectedAgentIds || gridSelectedAgentIds.has(id))
        .map((id) => {
          const config = getEffectiveAgentConfig(id);
          return {
            id: `new:${id}`,
            label: `New ${config?.name ?? id}`,
            enabled: canLaunch(id as "claude" | "gemini" | "codex" | "opencode" | "terminal"),
          };
        });

      const template: MenuItemOption[] = [
        { id: "new:terminal", label: "New Terminal" },
        { id: "new:browser", label: "New Browser" },
        ...(agentMenuItems.length > 0 ? [{ type: "separator" as const }, ...agentMenuItems] : []),
        { type: "separator" },
        {
          id: "layout",
          label: "Grid Layout",
          submenu: [
            {
              id: "layout:automatic",
              label: "Automatic",
              type: "checkbox",
              checked: layoutConfig.strategy === "automatic",
            },
            {
              id: "layout:fixed-columns",
              label: "Fixed Columns",
              type: "checkbox",
              checked: layoutConfig.strategy === "fixed-columns",
            },
            {
              id: "layout:fixed-rows",
              label: "Fixed Rows",
              type: "checkbox",
              checked: layoutConfig.strategy === "fixed-rows",
            },
          ],
        },
        { type: "separator" },
        { id: "settings:terminal", label: "Terminal Settings..." },
      ];

      const actionId = await showMenu(event, template);
      if (!actionId) return;

      if (actionId.startsWith("new:")) {
        const agentId = actionId.slice("new:".length) as
          | "claude"
          | "gemini"
          | "codex"
          | "opencode"
          | "terminal"
          | "browser";
        void actionService.dispatch(
          "agent.launch",
          { agentId, location: "grid", cwd: defaultCwd || undefined },
          { source: "context-menu" }
        );
        return;
      }

      if (actionId.startsWith("layout:")) {
        const nextStrategy = actionId.slice("layout:".length) as
          | "automatic"
          | "fixed-columns"
          | "fixed-rows";
        void actionService.dispatch(
          "terminal.gridLayout.setStrategy",
          { strategy: nextStrategy },
          { source: "context-menu" }
        );
        return;
      }

      if (actionId === "settings:terminal") {
        void actionService.dispatch(
          "app.settings.openTab",
          { tab: "terminal" },
          { source: "context-menu" }
        );
      }
    },
    [agentAvailability, defaultCwd, gridSelectedAgentIds, layoutConfig, showMenu]
  );

  // Terminal IDs for SortableContext
  const terminalIds = useMemo(() => {
    const ids = tabGroups.map((g) => g.panelIds[0] ?? g.id);
    if (showPlaceholder && placeholderInGrid) {
      const insertIndex = Math.min(Math.max(0, placeholderIndex), ids.length);
      ids.splice(insertIndex, 0, GRID_PLACEHOLDER_ID);
    }
    return ids;
  }, [tabGroups, showPlaceholder, placeholderIndex, placeholderInGrid]);

  // Batch-fit grid terminals when layout (gridCols/count) changes
  useEffect(() => {
    const ids = gridTerminals.map((t) => t.id);
    let cancelled = false;

    const timeoutId = window.setTimeout(() => {
      if (isDraggingRef.current) return;

      let index = 0;
      const processNext = () => {
        if (cancelled || index >= ids.length) return;
        if (isDraggingRef.current) return;

        const id = ids[index++];
        const managed = terminalInstanceService.get(id);

        if (managed?.hostElement.isConnected) {
          terminalInstanceService.fit(id);
        }
        requestAnimationFrame(processNext);
      };
      processNext();
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gridTerminals intentionally excluded to prevent redundant fit cycles on worktree switch
  }, [gridCols, terminalIds, sidecarOpen, sidecarLayoutMode]);

  // Show "grid full" overlay when trying to drag from dock to a full grid
  const showGridFullOverlay = sourceContainer === "dock" && isGridFull;

  // Two-pane split mode detection (must be before conditional returns)
  const allGroupsAreSinglePanel = tabGroups.every((g) => g.panelIds.length === 1);
  const useTwoPaneSplitMode =
    twoPaneSplitEnabled &&
    tabGroups.length === 2 &&
    allGroupsAreSinglePanel &&
    !maximizedId &&
    !showPlaceholder;

  // Track mode transitions and stabilize terminals after switch
  const prevModeRef = useRef<boolean>(useTwoPaneSplitMode);
  const gridTerminalsRef = useRef(gridTerminals);
  gridTerminalsRef.current = gridTerminals;

  useEffect(() => {
    const prevMode = prevModeRef.current;
    const currentMode = useTwoPaneSplitMode;

    // Mode transition detected
    if (prevMode !== currentMode) {
      prevModeRef.current = currentMode;

      // Immediate stabilization fit after mode switch
      const timeoutId = window.setTimeout(() => {
        if (isDraggingRef.current) return;

        // Read latest terminal IDs from ref to avoid cancellation issues
        const ids = gridTerminalsRef.current.map((t) => t.id);
        for (const id of ids) {
          const managed = terminalInstanceService.get(id);
          if (managed?.hostElement.isConnected) {
            terminalInstanceService.fit(id);
          }
        }
      }, 50);

      return () => clearTimeout(timeoutId);
    }
    return undefined;
  }, [useTwoPaneSplitMode]);

  // Validate maximize target before rendering
  useEffect(() => {
    if (maximizedId && maximizeTarget) {
      validateMaximizeTarget(getPanelGroup, getTerminal);
    }
  }, [maximizedId, maximizeTarget, validateMaximizeTarget, getPanelGroup, getTerminal, terminals]);

  // Maximized terminal or group takes full screen
  if (maximizedId && maximizeTarget) {
    if (maximizeTarget.type === "group") {
      // Find the group and render it maximized with tab bar
      const group = tabGroups.find((g) => g.id === maximizeTarget.id);
      if (group) {
        const groupPanels = getTabGroupPanels(group.id, "grid");
        if (groupPanels.length > 0) {
          // Ensure focus is set on a panel in the maximized group
          if (!focusedId || !groupPanels.some((p) => p.id === focusedId)) {
            const activeTabId = useTerminalStore.getState().getActiveTabId(group.id);
            const panelToFocus = groupPanels.find((p) => p.id === activeTabId) || groupPanels[0];
            if (panelToFocus) {
              setFocused(panelToFocus.id);
            }
          }

          return (
            <div className={cn("h-full flex flex-col bg-canopy-bg", className)}>
              <GridNotificationBar className="mx-1 mt-1 shrink-0" />
              <div className="relative min-h-0 flex-1">
                <GridTabGroup
                  group={group}
                  panels={groupPanels}
                  focusedId={focusedId}
                  gridPanelCount={1}
                  gridCols={1}
                  isMaximized={true}
                />
              </div>
            </div>
          );
        }
      }
      return null;
    } else {
      // Single panel maximize
      const terminal = gridTerminals.find((t: TerminalInstance) => t.id === maximizedId);
      if (terminal) {
        return (
          <div className={cn("h-full flex flex-col bg-canopy-bg", className)}>
            <GridNotificationBar className="mx-1 mt-1 shrink-0" />
            <div className="relative min-h-0 flex-1">
              <GridPanel
                terminal={terminal}
                isFocused={true}
                isMaximized={true}
                gridPanelCount={gridItemCount}
              />
            </div>
          </div>
        );
      }
      return null;
    }
  }

  const isEmpty = gridTerminals.length === 0;

  if (useTwoPaneSplitMode) {
    const twoPaneTerminals = tabGroups
      .slice(0, 2)
      .map((g) => getTabGroupPanels(g.id, "grid")[0])
      .filter((t): t is TerminalInstance => t !== undefined);

    if (twoPaneTerminals.length === 2) {
      return (
        <div className={cn("h-full flex flex-col", className)}>
          <GridNotificationBar className="mx-1 mt-1 shrink-0" />
          <TerminalCountWarning className="mx-1 mt-1 shrink-0" />
          <div
            ref={(node) => {
              setNodeRef(node);
              gridContainerRef.current = node;
            }}
            onContextMenu={handleGridContextMenu}
            className={cn(
              "relative flex-1 min-h-0",
              isOver && "ring-2 ring-canopy-accent/30 ring-inset"
            )}
          >
            <TwoPaneSplitLayout
              terminals={twoPaneTerminals as [TerminalInstance, TerminalInstance]}
              focusedId={focusedId}
              activeWorktreeId={activeWorktreeId}
              isInTrash={isInTrash}
              onAddTabLeft={() => handleAddTabForPanel(twoPaneTerminals[0])}
              onAddTabRight={() => handleAddTabForPanel(twoPaneTerminals[1])}
            />
            <GridFullOverlay maxTerminals={maxGridCapacity} show={showGridFullOverlay} />
          </div>
        </div>
      );
    }
  }

  return (
    <div className={cn("h-full flex flex-col", className)}>
      <GridNotificationBar className="mx-1 mt-1 shrink-0" />
      <TerminalCountWarning className="mx-1 mt-1 shrink-0" />
      <div className="relative flex-1 min-h-0">
        <SortableContext id="grid-container" items={terminalIds} strategy={rectSortingStrategy}>
          <div
            ref={(node) => {
              setNodeRef(node);
              gridContainerRef.current = node;
            }}
            onContextMenu={handleGridContextMenu}
            className={cn(
              "h-full bg-noise p-1",
              isOver && "ring-2 ring-canopy-accent/30 ring-inset"
            )}
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
              gridAutoRows: `minmax(${MIN_TERMINAL_HEIGHT_PX}px, 1fr)`,
              gap: "4px",
              backgroundColor: "var(--color-grid-bg)",
              transition: isProjectSwitching ? "none" : "grid-template-columns 200ms ease-out",
              overflowY: "auto",
            }}
            role="grid"
            id="terminal-grid"
            aria-label="Panel grid"
            data-grid-container="true"
          >
            {isEmpty && !showPlaceholder ? (
              <div className="col-span-full row-span-full">
                <EmptyState
                  hasActiveWorktree={hasActiveWorktree}
                  activeWorktreeName={activeWorktreeName}
                  activeWorktreeId={activeWorktreeId}
                  showProjectPulse={showProjectPulse}
                  projectIconSvg={projectIconSvg}
                  defaultCwd={defaultCwd}
                  agentAvailability={agentAvailability}
                />
              </div>
            ) : (
              <>
                {tabGroups.map((group, index) => {
                  const groupPanels = getTabGroupPanels(group.id, "grid");
                  if (groupPanels.length === 0) return null;

                  const elements: React.ReactNode[] = [];

                  if (showPlaceholder && placeholderInGrid && placeholderIndex === index) {
                    elements.push(<SortableGridPlaceholder key={GRID_PLACEHOLDER_ID} />);
                  }

                  const isGroupDisabled = groupPanels.some((p) => isInTrash(p.id));

                  if (groupPanels.length === 1) {
                    const terminal = groupPanels[0];
                    elements.push(
                      <SortableTerminal
                        key={group.id}
                        terminal={terminal}
                        sourceLocation="grid"
                        sourceIndex={index}
                        disabled={isGroupDisabled}
                      >
                        <GridPanel
                          terminal={terminal}
                          isFocused={terminal.id === focusedId}
                          gridPanelCount={gridItemCount}
                          gridCols={gridCols}
                          onAddTab={() => handleAddTabForPanel(terminal)}
                        />
                      </SortableTerminal>
                    );
                  } else {
                    const firstPanel = groupPanels[0];
                    elements.push(
                      <SortableTerminal
                        key={group.id}
                        terminal={firstPanel}
                        sourceLocation="grid"
                        sourceIndex={index}
                        disabled={isGroupDisabled}
                        groupId={group.id}
                        groupPanelIds={group.panelIds}
                      >
                        <GridTabGroup
                          group={group}
                          panels={groupPanels}
                          focusedId={focusedId}
                          gridPanelCount={gridItemCount}
                          gridCols={gridCols}
                        />
                      </SortableTerminal>
                    );
                  }

                  return elements;
                })}
                {showPlaceholder && placeholderInGrid && placeholderIndex === tabGroups.length && (
                  <SortableGridPlaceholder key={GRID_PLACEHOLDER_ID} />
                )}
              </>
            )}
          </div>
        </SortableContext>

        <GridFullOverlay maxTerminals={maxGridCapacity} show={showGridFullOverlay} />
      </div>
    </div>
  );
}

export default ContentGrid;
