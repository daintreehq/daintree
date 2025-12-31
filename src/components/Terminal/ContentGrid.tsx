import { useMemo, useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import {
  useTerminalStore,
  useLayoutConfigStore,
  useWorktreeSelectionStore,
  usePreferencesStore,
  type TerminalInstance,
} from "@/store";
import { useProjectStore } from "@/store/projectStore";
import { useRecipeStore } from "@/store/recipeStore";
import { GridPanel } from "./GridPanel";
import { TerminalCountWarning } from "./TerminalCountWarning";
import { GridFullOverlay } from "./GridFullOverlay";
import {
  SortableTerminal,
  useDndPlaceholder,
  useIsDragging,
  GRID_PLACEHOLDER_ID,
  SortableGridPlaceholder,
} from "@/components/DragDrop";
import { AlertTriangle, Settings, Play } from "lucide-react";
import { CanopyIcon } from "@/components/icons";
import { ProjectPulseCard } from "@/components/Pulse";
import { Kbd } from "@/components/ui/Kbd";
import { svgToDataUrl } from "@/lib/svg";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { computeGridColumns, MIN_TERMINAL_HEIGHT_PX } from "@/lib/terminalLayout";
import { useWorktrees } from "@/hooks/useWorktrees";
import { useNativeContextMenu, useProjectBranding } from "@/hooks";
import { actionService } from "@/services/ActionService";
import type { CliAvailability } from "@shared/types";
import type { MenuItemOption } from "@/types";

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
}: {
  hasActiveWorktree: boolean;
  activeWorktreeName?: string | null;
  activeWorktreeId?: string | null;
  showProjectPulse: boolean;
  projectIconSvg?: string;
  defaultCwd?: string;
}) {
  const allRecipes = useRecipeStore((state) => state.recipes);
  const runRecipe = useRecipeStore((state) => state.runRecipe);
  const recipes = useMemo(() => {
    return allRecipes.filter(
      (r) => r.worktreeId === activeWorktreeId || r.worktreeId === undefined
    );
  }, [allRecipes, activeWorktreeId]);
  const dockedTerminals = useTerminalStore(
    useShallow((state) =>
      state.terminals.filter((t) => t.location === "dock" && t.worktreeId === activeWorktreeId)
    )
  );

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

  const handleResumeSession = async () => {
    await actionService.dispatch("worktree.sessions.maximizeAll", {}, { source: "user" });
  };

  return (
    <div className="flex flex-col items-center justify-center h-full w-full p-8 animate-in fade-in duration-500">
      <div className="max-w-3xl w-full flex flex-col items-center">
        <div className="mb-12 flex flex-col items-center text-center">
          <div className="relative group mb-8">
            {projectIconSvg ? (
              <img
                src={svgToDataUrl(projectIconSvg)}
                alt="Project icon"
                className="h-28 w-28 object-contain"
              />
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

        {hasActiveWorktree && dockedTerminals.length > 0 && (
          <button
            type="button"
            onClick={handleResumeSession}
            className="mb-6 px-6 py-3 bg-canopy-accent hover:bg-canopy-accent/90 text-white rounded-[var(--radius-md)] font-medium text-sm transition-all flex items-center gap-2 shadow-lg hover:shadow-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-canopy-bg"
          >
            <Play className="h-4 w-4" />
            Resume Last Session
          </button>
        )}

        {hasActiveWorktree && displayRecipes.length > 0 && (
          <div className="mb-8 w-full max-w-2xl">
            <h4 className="text-xs font-semibold text-canopy-text/50 uppercase tracking-wider mb-3 text-center">
              Recipes
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {displayRecipes.map((recipe) => (
                <button
                  key={recipe.id}
                  type="button"
                  onClick={() => handleRunRecipe(recipe.id)}
                  className="p-4 bg-canopy-sidebar hover:bg-canopy-bg border border-canopy-border hover:border-canopy-accent/50 rounded-[var(--radius-md)] transition-all text-left group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent"
                >
                  <div className="flex items-center gap-2 mb-1 min-w-0">
                    <Play className="h-4 w-4 text-canopy-accent group-hover:text-canopy-accent/80 shrink-0" />
                    <h5 className="font-medium text-sm text-canopy-text truncate">{recipe.name}</h5>
                  </div>
                  <p className="text-xs text-canopy-muted">
                    {recipe.terminals.length} terminal{recipe.terminals.length !== 1 ? "s" : ""}
                  </p>
                </button>
              ))}
            </div>
          </div>
        )}

        {showProjectPulse && hasActiveWorktree && activeWorktreeId && (
          <div className="flex justify-center mb-8">
            <ProjectPulseCard worktreeId={activeWorktreeId} />
          </div>
        )}

        <div className="flex flex-col items-center gap-4 mt-4">
          {hasActiveWorktree && (
            <p className="text-xs text-canopy-text/60 text-center">
              Tip: Press <Kbd>⌘P</Kbd> to open the command palette or <Kbd>⌘T</Kbd> for a new
              terminal
            </p>
          )}

          <button
            type="button"
            onClick={handleOpenHelp}
            className="flex items-center gap-3 p-2 pr-4 rounded-full hover:bg-white/5 transition-all group text-left border border-transparent hover:border-white/5"
          >
            <div className="w-8 h-8 bg-white/10 rounded-full flex items-center justify-center group-hover:bg-canopy-accent/20 transition-colors">
              <div className="w-0 h-0 border-t-[3px] border-t-transparent border-l-[6px] border-l-white/70 border-b-[3px] border-b-transparent ml-0.5 group-hover:border-l-canopy-accent transition-colors" />
            </div>
            <div className="flex flex-col">
              <span className="text-xs font-medium text-canopy-text/60 group-hover:text-canopy-text transition-colors">
                View documentation
              </span>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

export function ContentGrid({ className, defaultCwd, agentAvailability }: ContentGridProps) {
  const { showMenu } = useNativeContextMenu();
  const { terminals, focusedId, maximizedId, preMaximizeLayout, clearPreMaximizeLayout } =
    useTerminalStore(
      useShallow((state) => ({
        terminals: state.terminals,
        focusedId: state.focusedId,
        maximizedId: state.maximizedId,
        preMaximizeLayout: state.preMaximizeLayout,
        clearPreMaximizeLayout: state.clearPreMaximizeLayout,
      }))
    );

  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const showProjectPulse = usePreferencesStore((state) => state.showProjectPulse);
  const currentProject = useProjectStore((state) => state.currentProject);
  const { projectIconSvg } = useProjectBranding(currentProject?.id);
  const { worktreeMap } = useWorktrees();
  const activeWorktree = activeWorktreeId ? worktreeMap.get(activeWorktreeId) : null;
  const hasActiveWorktree = activeWorktreeId != null && activeWorktree != null;
  const activeWorktreeName = activeWorktree
    ? activeWorktree.branch?.trim() || activeWorktree.name?.trim() || "Unknown Worktree"
    : null;

  const isInTrash = useTerminalStore((state) => state.isInTrash);

  const gridTerminals = useMemo(
    () =>
      terminals.filter(
        (t) =>
          (t.location === "grid" || t.location === undefined) &&
          (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
      ),
    [terminals, activeWorktreeId]
  );

  const layoutConfig = useLayoutConfigStore((state) => state.layoutConfig);
  const setGridDimensions = useLayoutConfigStore((state) => state.setGridDimensions);
  const getMaxGridCapacity = useLayoutConfigStore((state) => state.getMaxGridCapacity);

  // Dynamic grid capacity based on current dimensions
  const maxGridCapacity = getMaxGridCapacity();
  const isGridFull = gridTerminals.length >= maxGridCapacity;

  // Make the grid a droppable area
  const { setNodeRef, isOver } = useDroppable({
    id: "grid-container",
    data: { container: "grid" },
  });

  // Track container dimensions for responsive layout and capacity calculation
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const [gridWidth, setGridWidth] = useState<number | null>(null);

  useEffect(() => {
    const container = gridContainerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        const { width, height } = entry.contentRect;
        setGridWidth((prev) => (prev === width ? prev : width));
        // Report dimensions to store for capacity calculation
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
  }, [setGridDimensions]);

  // Get placeholder state from DnD context
  const { placeholderIndex, sourceContainer } = useDndPlaceholder();
  const isDragging = useIsDragging();
  const isDraggingRef = useRef(isDragging);
  useEffect(() => {
    isDraggingRef.current = isDragging;
  }, [isDragging]);

  const placeholderInGrid =
    placeholderIndex !== null && placeholderIndex >= 0 && placeholderIndex <= gridTerminals.length;

  // Show placeholder when dragging from dock to grid (only if grid not full)
  const showPlaceholder = placeholderInGrid && sourceContainer === "dock" && !isGridFull;
  const gridItemCount = gridTerminals.length + (showPlaceholder ? 1 : 0);

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

      const canLaunch = (agentId: "claude" | "gemini" | "codex" | "terminal") => {
        if (agentId === "terminal") return true;
        if (!agentAvailability) return true;
        return agentAvailability[agentId] === true;
      };

      const template: MenuItemOption[] = [
        { id: "new:terminal", label: "New Terminal" },
        { id: "new:browser", label: "New Browser" },
        { type: "separator" },
        { id: "new:claude", label: "New Claude", enabled: canLaunch("claude") },
        { id: "new:gemini", label: "New Gemini", enabled: canLaunch("gemini") },
        { id: "new:codex", label: "New Codex", enabled: canLaunch("codex") },
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
    [agentAvailability, defaultCwd, layoutConfig, showMenu]
  );

  // Terminal IDs for SortableContext - Include placeholder if visible
  const terminalIds = useMemo(() => {
    const ids = gridTerminals.map((t) => t.id);
    if (showPlaceholder && placeholderInGrid) {
      const insertIndex = Math.min(Math.max(0, placeholderIndex), ids.length);
      ids.splice(insertIndex, 0, GRID_PLACEHOLDER_ID);
    }
    return ids;
  }, [gridTerminals, showPlaceholder, placeholderIndex, placeholderInGrid]);

  // Batch-fit grid terminals when layout (gridCols/count) changes
  // Skip during drag to avoid tier churn from CSS transforms
  useEffect(() => {
    const ids = gridTerminals.map((t) => t.id);
    let cancelled = false;

    const timeoutId = window.setTimeout(() => {
      // Skip batch fit during drag - transforms make dimensions unreliable
      if (isDraggingRef.current) return;

      let index = 0;
      const processNext = () => {
        if (cancelled || index >= ids.length) return;
        // Re-check drag state in case drag started during batch
        if (isDraggingRef.current) return;

        const id = ids[index++];
        const managed = terminalInstanceService.get(id);

        if (managed?.hostElement.isConnected) {
          terminalInstanceService.fit(id);
          // Only do fit, don't force tier - let the tier provider handle it
          // Forcing VISIBLE tier here can cause churn during reorders
        }
        requestAnimationFrame(processNext);
      };
      processNext();
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [gridCols, terminalIds, gridTerminals]);

  // Show "grid full" overlay when trying to drag from dock to a full grid
  const showGridFullOverlay = sourceContainer === "dock" && isGridFull;

  // Maximized terminal takes full screen
  if (maximizedId) {
    const terminal = gridTerminals.find((t: TerminalInstance) => t.id === maximizedId);
    if (terminal) {
      return (
        <div className={cn("h-full relative bg-canopy-bg", className)}>
          <GridPanel
            terminal={terminal}
            isFocused={true}
            isMaximized={true}
            gridPanelCount={gridItemCount}
          />
        </div>
      );
    }
  }

  const isEmpty = gridTerminals.length === 0;

  return (
    <div className={cn("h-full flex flex-col", className)}>
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
              // Use minmax to prevent pancake terminals while still filling space
              // Terminals stretch to fill available space but never shrink below minimum
              gridAutoRows: `minmax(${MIN_TERMINAL_HEIGHT_PX}px, 1fr)`,
              gap: "4px",
              backgroundColor: "var(--color-grid-bg)",
              // Smooth transition for column count changes
              transition: "grid-template-columns 200ms ease-out",
              // Allow scrolling if terminals exceed viewport (rather than crushing them)
              overflowY: "auto",
            }}
            role="grid"
            id="terminal-grid"
            aria-label="Terminal grid"
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
                />
              </div>
            ) : (
              <>
                {gridTerminals.map((terminal, index) => {
                  const isTerminalInTrash = isInTrash(terminal.id);
                  const elements: React.ReactNode[] = [];

                  if (showPlaceholder && placeholderInGrid && placeholderIndex === index) {
                    elements.push(<SortableGridPlaceholder key={GRID_PLACEHOLDER_ID} />);
                  }

                  elements.push(
                    <SortableTerminal
                      key={terminal.id}
                      terminal={terminal}
                      sourceLocation="grid"
                      sourceIndex={index}
                      disabled={isTerminalInTrash}
                    >
                      <GridPanel
                        terminal={terminal}
                        isFocused={terminal.id === focusedId}
                        gridPanelCount={gridItemCount}
                        gridCols={gridCols}
                      />
                    </SortableTerminal>
                  );

                  return elements;
                })}
                {showPlaceholder &&
                  placeholderInGrid &&
                  placeholderIndex === gridTerminals.length && (
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
