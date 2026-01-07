import { useCallback, useEffect, useRef, useMemo } from "react";
import { X, Maximize2, FilterX } from "lucide-react";
import { cn } from "@/lib/utils";
import { useShallow } from "zustand/react/shallow";
import { WorktreeCard } from "./WorktreeCard";
import { WorktreeFilterPopover } from "./WorktreeFilterPopover";
import type { WorktreeState } from "@/types";
import type { UseAgentLauncherReturn } from "@/hooks/useAgentLauncher";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { useTerminalStore } from "@/store/terminalStore";
import { useErrorStore } from "@/store/errorStore";
import {
  matchesFilters,
  sortWorktrees,
  groupByType,
  type DerivedWorktreeMeta,
  type FilterState,
  type GroupedSection,
} from "@/lib/worktreeFilters";
import { Button } from "@/components/ui/button";

export interface WorktreeOverviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  worktrees: WorktreeState[];
  activeWorktreeId: string | null;
  focusedWorktreeId: string | null;
  onSelectWorktree: (worktreeId: string) => void;
  onCopyTree: (worktree: WorktreeState) => Promise<string | undefined> | void;
  onOpenEditor: (worktree: WorktreeState) => void;
  onSaveLayout?: (worktree: WorktreeState) => void;
  onLaunchAgent?: (worktreeId: string, agentId: string) => void;
  agentAvailability?: UseAgentLauncherReturn["availability"];
  agentSettings?: UseAgentLauncherReturn["agentSettings"];
  homeDir?: string;
}

export function WorktreeOverviewModal({
  isOpen,
  onClose,
  worktrees,
  activeWorktreeId,
  focusedWorktreeId,
  onSelectWorktree,
  onCopyTree,
  onOpenEditor,
  onSaveLayout,
  onLaunchAgent,
  agentAvailability,
  agentSettings,
  homeDir,
}: WorktreeOverviewModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Filter store state
  const {
    query,
    orderBy,
    groupByType: isGroupedByType,
    statusFilters,
    typeFilters,
    githubFilters,
    sessionFilters,
    activityFilters,
    alwaysShowActive,
    pinnedWorktrees,
  } = useWorktreeFilterStore(
    useShallow((state) => ({
      query: state.query,
      orderBy: state.orderBy,
      groupByType: state.groupByType,
      statusFilters: state.statusFilters,
      typeFilters: state.typeFilters,
      githubFilters: state.githubFilters,
      sessionFilters: state.sessionFilters,
      activityFilters: state.activityFilters,
      alwaysShowActive: state.alwaysShowActive,
      pinnedWorktrees: state.pinnedWorktrees,
    }))
  );
  const clearAllFilters = useWorktreeFilterStore((state) => state.clearAll);
  const hasActiveFilters = useWorktreeFilterStore((state) => state.hasActiveFilters);

  // Terminal store for derived metadata
  const terminals = useTerminalStore(useShallow((state) => state.terminals));

  // Error store for derived metadata
  const getWorktreeErrors = useErrorStore((state) => state.getWorktreeErrors);

  // Compute derived metadata for each worktree
  const derivedMetaMap = useMemo(() => {
    const map = new Map<string, DerivedWorktreeMeta>();
    for (const worktree of worktrees) {
      const worktreeTerminals = terminals.filter(
        (t) => t.worktreeId === worktree.id && t.location !== "trash"
      );
      const errors = getWorktreeErrors(worktree.id);
      map.set(worktree.id, {
        hasErrors: errors.length > 0,
        terminalCount: worktreeTerminals.length,
        hasWorkingAgent: worktreeTerminals.some((t) => t.agentState === "working"),
        hasRunningAgent: worktreeTerminals.some((t) => t.agentState === "running"),
        hasWaitingAgent: worktreeTerminals.some((t) => t.agentState === "waiting"),
        hasFailedAgent: worktreeTerminals.some((t) => t.agentState === "failed"),
        hasCompletedAgent: worktreeTerminals.some((t) => t.agentState === "completed"),
      });
    }
    return map;
  }, [worktrees, terminals, getWorktreeErrors]);

  // Apply filters and sorting
  const { filteredWorktrees, groupedSections } = useMemo(() => {
    const filters: FilterState = {
      query,
      statusFilters,
      typeFilters,
      githubFilters,
      sessionFilters,
      activityFilters,
    };

    // Filter worktrees
    const filtered = worktrees.filter((worktree) => {
      const derived = derivedMetaMap.get(worktree.id) ?? {
        hasErrors: false,
        terminalCount: 0,
        hasWorkingAgent: false,
        hasRunningAgent: false,
        hasWaitingAgent: false,
        hasFailedAgent: false,
        hasCompletedAgent: false,
      };
      const isActive = worktree.id === activeWorktreeId;

      // Always show active worktree if setting is enabled
      if (alwaysShowActive && isActive) {
        return true;
      }

      return matchesFilters(worktree, filters, derived, isActive);
    });

    // Filter out pinned worktrees that no longer exist
    const existingWorktreeIds = new Set(worktrees.map((w) => w.id));
    const validPinnedWorktrees = pinnedWorktrees.filter((id) => existingWorktreeIds.has(id));

    // Sort worktrees
    const sorted = sortWorktrees(filtered, orderBy, validPinnedWorktrees);

    // Group if enabled
    if (isGroupedByType) {
      return {
        filteredWorktrees: sorted,
        groupedSections: groupByType(sorted, orderBy, validPinnedWorktrees),
      };
    }

    return { filteredWorktrees: sorted, groupedSections: null };
  }, [
    worktrees,
    query,
    orderBy,
    isGroupedByType,
    statusFilters,
    typeFilters,
    githubFilters,
    sessionFilters,
    activityFilters,
    alwaysShowActive,
    pinnedWorktrees,
    derivedMetaMap,
    activeWorktreeId,
  ]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    },
    [onClose]
  );

  useEffect(() => {
    if (!isOpen) return;

    document.addEventListener("keydown", handleKeyDown, { capture: true });
    const timeoutId = setTimeout(() => closeButtonRef.current?.focus(), 50);

    return () => {
      document.removeEventListener("keydown", handleKeyDown, { capture: true });
      clearTimeout(timeoutId);
    };
  }, [isOpen, handleKeyDown]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  const handleWorktreeSelect = useCallback(
    (worktreeId: string) => {
      onSelectWorktree(worktreeId);
      onClose();
    },
    [onSelectWorktree, onClose]
  );

  if (!isOpen) return null;

  return (
    <div
      ref={modalRef}
      className={cn(
        "fixed inset-0 z-[100] flex items-center justify-center",
        "bg-black/60 backdrop-blur-sm",
        "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
      )}
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="worktree-overview-title"
    >
      <div
        className={cn(
          "relative flex flex-col",
          "w-[calc(100vw-80px)] h-[calc(100vh-80px)]",
          "max-w-[1800px] max-h-[1200px]",
          "bg-canopy-bg rounded-xl",
          "border border-divider",
          "shadow-2xl shadow-black/40",
          "motion-safe:animate-in motion-safe:zoom-in-95 motion-safe:duration-200"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-divider shrink-0">
          <div className="flex items-center gap-3">
            <Maximize2 className="w-5 h-5 text-canopy-text/60" />
            <h2
              id="worktree-overview-title"
              className="text-canopy-text font-semibold text-base tracking-wide"
            >
              Worktrees Overview
            </h2>
            <span className="text-canopy-text/50 text-sm">
              ({filteredWorktrees.length}
              {filteredWorktrees.length !== worktrees.length && ` of ${worktrees.length}`})
            </span>
          </div>
          <div className="flex items-center gap-2">
            {/* Filter Popover */}
            <WorktreeFilterPopover />
            {/* Clear Filters Button - only shown when filters are active */}
            {hasActiveFilters() && (
              <button
                onClick={clearAllFilters}
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1.5 rounded text-xs",
                  "text-canopy-text/60 hover:text-canopy-text",
                  "hover:bg-white/[0.06]",
                  "transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent"
                )}
                aria-label="Clear all filters"
                title="Clear all filters"
              >
                <FilterX className="w-3.5 h-3.5" />
                <span>Clear</span>
              </button>
            )}
            {/* Close Button */}
            <button
              ref={closeButtonRef}
              onClick={onClose}
              className={cn(
                "p-2 rounded-lg transition-colors",
                "text-canopy-text/60 hover:text-canopy-text",
                "hover:bg-white/[0.06]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent"
              )}
              aria-label="Close overview"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {worktrees.length === 0 ? (
            <div className="flex items-center justify-center h-full text-canopy-text/50">
              No worktrees available
            </div>
          ) : filteredWorktrees.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-canopy-text/50">
              <FilterX className="w-12 h-12 text-canopy-text/30" />
              <div className="text-center">
                <p className="text-sm font-medium text-canopy-text/70">
                  No worktrees match filters
                </p>
                <p className="text-xs mt-1">
                  {worktrees.length} worktree{worktrees.length !== 1 ? "s" : ""} hidden by active
                  filters
                </p>
              </div>
              <Button variant="subtle" size="sm" onClick={clearAllFilters} className="mt-2">
                Clear all filters
              </Button>
            </div>
          ) : groupedSections ? (
            <div className="space-y-6">
              {groupedSections.map((section: GroupedSection<WorktreeState>) => (
                <div key={section.type}>
                  <div className="flex items-center gap-2 mb-3">
                    <h3 className="text-xs font-medium text-canopy-text/60 uppercase tracking-wider">
                      {section.displayName}
                    </h3>
                    <span className="text-xs text-canopy-text/40">
                      ({section.worktrees.length})
                    </span>
                  </div>
                  <div
                    className={cn(
                      "grid gap-4",
                      "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
                      "auto-rows-min"
                    )}
                  >
                    {section.worktrees.map((worktree: WorktreeState) => (
                      <div
                        key={worktree.id}
                        className={cn(
                          "rounded-lg overflow-hidden",
                          "border border-divider",
                          "bg-canopy-sidebar/50",
                          "transition-all duration-200",
                          "hover:border-canopy-accent/50 hover:shadow-lg hover:shadow-canopy-accent/5",
                          worktree.id === activeWorktreeId && "border-canopy-accent/70 shadow-md"
                        )}
                      >
                        <WorktreeCard
                          worktree={worktree}
                          isActive={worktree.id === activeWorktreeId}
                          isFocused={worktree.id === focusedWorktreeId}
                          isSingleWorktree={worktrees.length === 1}
                          onSelect={() => handleWorktreeSelect(worktree.id)}
                          onCopyTree={() => onCopyTree(worktree)}
                          onOpenEditor={() => onOpenEditor(worktree)}
                          onSaveLayout={onSaveLayout ? () => onSaveLayout(worktree) : undefined}
                          onLaunchAgent={
                            onLaunchAgent
                              ? (agentId) => onLaunchAgent(worktree.id, agentId)
                              : undefined
                          }
                          agentAvailability={agentAvailability}
                          agentSettings={agentSettings}
                          homeDir={homeDir}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div
              className={cn(
                "grid gap-4",
                "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
                "items-start"
              )}
            >
              {filteredWorktrees.map((worktree) => (
                <div
                  key={worktree.id}
                  className={cn(
                    "rounded-lg overflow-hidden",
                    "border border-divider",
                    "bg-canopy-sidebar/50",
                    "transition-all duration-200",
                    "hover:border-canopy-accent/50 hover:shadow-lg hover:shadow-canopy-accent/5",
                    worktree.id === activeWorktreeId && "border-canopy-accent/70 shadow-md"
                  )}
                >
                  <WorktreeCard
                    variant="grid"
                    worktree={worktree}
                    isActive={worktree.id === activeWorktreeId}
                    isFocused={worktree.id === focusedWorktreeId}
                    isSingleWorktree={worktrees.length === 1}
                    onSelect={() => handleWorktreeSelect(worktree.id)}
                    onCopyTree={() => onCopyTree(worktree)}
                    onOpenEditor={() => onOpenEditor(worktree)}
                    onSaveLayout={onSaveLayout ? () => onSaveLayout(worktree) : undefined}
                    onLaunchAgent={
                      onLaunchAgent ? (agentId) => onLaunchAgent(worktree.id, agentId) : undefined
                    }
                    agentAvailability={agentAvailability}
                    agentSettings={agentSettings}
                    homeDir={homeDir}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="px-6 py-3 border-t border-divider shrink-0">
          <div className="flex items-center justify-center gap-4 text-xs text-canopy-text/40">
            <span>
              <kbd className="px-1.5 py-0.5 bg-white/[0.06] rounded text-[10px]">Esc</kbd> to close
            </span>
            <span>Click a worktree to switch</span>
          </div>
        </div>
      </div>
    </div>
  );
}
