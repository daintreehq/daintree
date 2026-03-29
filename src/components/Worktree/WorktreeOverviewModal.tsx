import React, { useCallback, useEffect, useEffectEvent, useRef, useMemo } from "react";
import { X, FilterX } from "lucide-react";
import { WorktreeOverviewIcon, CanopyAgentIcon } from "@/components/icons";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";
import { cn } from "@/lib/utils";
import { useShallow } from "zustand/react/shallow";
import { WorktreeCard } from "./WorktreeCard";
import { WorktreeFilterPopover } from "./WorktreeFilterPopover";
import type { WorktreeState } from "@/types";
import type { UseAgentLauncherReturn } from "@/hooks/useAgentLauncher";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import {
  matchesFilters,
  sortWorktrees,
  groupByType,
  type DerivedWorktreeMeta,
  type FilterState,
  type GroupedSection,
} from "@/lib/worktreeFilters";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

interface OverviewWorktreeCardProps {
  worktreeId: string;
  activeWorktreeId: string | null;
  focusedWorktreeId: string | null;
  totalWorktreeCount: number;
  variant?: "sidebar" | "grid";
  onSelectWorktree: (worktreeId: string) => void;
  onCopyTree: (worktree: WorktreeState) => Promise<string | undefined> | void;
  onOpenEditor: (worktree: WorktreeState) => void;
  onSaveLayout?: (worktree: WorktreeState) => void;
  onLaunchAgent?: (worktreeId: string, agentId: string) => void;
  agentAvailability?: UseAgentLauncherReturn["availability"];
  agentSettings?: UseAgentLauncherReturn["agentSettings"];
  homeDir?: string;
  onClose: () => void;
}

const OverviewWorktreeCard = React.memo(function OverviewWorktreeCard({
  worktreeId,
  activeWorktreeId,
  focusedWorktreeId,
  totalWorktreeCount,
  variant,
  onSelectWorktree,
  onCopyTree,
  onOpenEditor,
  onSaveLayout,
  onLaunchAgent,
  agentAvailability,
  agentSettings,
  homeDir,
  onClose,
}: OverviewWorktreeCardProps) {
  const worktree = useWorktreeDataStore((state) => state.worktrees.get(worktreeId));

  const handleSelect = useCallback(() => {
    onSelectWorktree(worktreeId);
    onClose();
  }, [onSelectWorktree, onClose, worktreeId]);

  const handleCopyTree = useCallback(
    () => worktree && onCopyTree(worktree),
    [worktree, onCopyTree]
  );
  const handleOpenEditor = useCallback(
    () => worktree && onOpenEditor(worktree),
    [worktree, onOpenEditor]
  );
  const handleSaveLayout = useCallback(
    () => worktree && onSaveLayout?.(worktree),
    [worktree, onSaveLayout]
  );
  const handleLaunchAgent = useCallback(
    (agentId: string) => onLaunchAgent?.(worktreeId, agentId),
    [onLaunchAgent, worktreeId]
  );

  if (!worktree) return null;

  return (
    <WorktreeCard
      variant={variant}
      worktree={worktree}
      isActive={worktreeId === activeWorktreeId}
      isFocused={worktreeId === focusedWorktreeId}
      isSingleWorktree={totalWorktreeCount === 1}
      onSelect={handleSelect}
      onCopyTree={handleCopyTree}
      onOpenEditor={handleOpenEditor}
      onSaveLayout={onSaveLayout ? handleSaveLayout : undefined}
      onLaunchAgent={onLaunchAgent ? handleLaunchAgent : undefined}
      agentAvailability={agentAvailability}
      agentSettings={agentSettings}
      homeDir={homeDir}
      onAfterTerminalSelect={onClose}
    />
  );
});

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

function EmptyWorktreeState() {
  const createWorktreeShortcut = useKeybindingDisplay("worktree.createDialog.open");

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-canopy-text/50">
      <WorktreeOverviewIcon className="w-8 h-8 text-canopy-text/30" />
      <p className="text-sm font-medium text-canopy-text/70">No worktrees yet</p>
      <p className="text-xs text-canopy-text/40">
        {createWorktreeShortcut ? (
          <>
            Press{" "}
            <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
              {createWorktreeShortcut}
            </kbd>{" "}
            to create a worktree.
          </>
        ) : (
          "Create a worktree to get started."
        )}
      </p>
    </div>
  );
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
    alwaysShowWaiting,
    pinnedWorktrees,
    manualOrder,
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
      alwaysShowWaiting: state.alwaysShowWaiting,
      pinnedWorktrees: state.pinnedWorktrees,
      manualOrder: state.manualOrder,
    }))
  );
  const clearAllFilters = useWorktreeFilterStore((state) => state.clearAll);
  const hasActiveFilters = useWorktreeFilterStore((state) => state.hasActiveFilters);

  // Terminal store for derived metadata
  const terminals = useTerminalStore(useShallow((state) => state.terminals));

  // Error store for derived metadata
  // Filter store: hide main worktree preference
  const hideMainWorktree = useWorktreeFilterStore((state) => state.hideMainWorktree);
  const setHideMainWorktree = useWorktreeFilterStore((state) => state.setHideMainWorktree);

  // Compute derived metadata for each worktree
  const derivedMetaMap = useMemo(() => {
    const map = new Map<string, DerivedWorktreeMeta>();
    for (const worktree of worktrees) {
      const worktreeTerminals = terminals.filter(
        (t) => t.worktreeId === worktree.id && t.location !== "trash"
      );
      map.set(worktree.id, {
        terminalCount: worktreeTerminals.length,
        hasWorkingAgent: worktreeTerminals.some((t) => t.agentState === "working"),
        hasRunningAgent: worktreeTerminals.some((t) => t.agentState === "running"),
        hasWaitingAgent: worktreeTerminals.some((t) => t.agentState === "waiting"),
        hasCompletedAgent: worktreeTerminals.some((t) => t.agentState === "completed"),
        hasMergeConflict:
          worktree.worktreeChanges?.changes.some((c) => c.status === "conflicted") ?? false,
        chipState: null,
      });
    }
    return map;
  }, [worktrees, terminals]);

  // Compute aggregate statistics from derivedMetaMap
  const aggregateStats = useMemo(() => {
    let workingCount = 0;
    let waitingCount = 0;

    // Count worktrees (not terminals) with specific agent states
    // Use same visibility logic as filtered list to keep stats in sync
    for (const worktree of worktrees) {
      const derived = derivedMetaMap.get(worktree.id);
      if (!derived) continue;

      // hideMainWorktree always takes precedence for the main worktree (user's explicit intent)
      if (hideMainWorktree && worktree.isMainWorktree) {
        continue;
      }

      if (derived.hasWorkingAgent || derived.hasRunningAgent) workingCount++;
      if (derived.hasWaitingAgent) waitingCount++;
    }

    return { workingCount, waitingCount };
  }, [worktrees, derivedMetaMap, hideMainWorktree]);

  // Check if only main worktree exists (to hide the filter toggle)
  const hasOnlyMainWorktree = useMemo(() => {
    return worktrees.length === 1 && worktrees[0]?.isMainWorktree === true;
  }, [worktrees]);

  // Check if there are any non-main worktrees
  const hasNonMainWorktrees = useMemo(() => {
    return worktrees.some((w) => !w.isMainWorktree);
  }, [worktrees]);

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
        terminalCount: 0,
        hasWorkingAgent: false,
        hasRunningAgent: false,
        hasWaitingAgent: false,
        hasCompletedAgent: false,
        hasMergeConflict: false,
        chipState: null,
      };
      const isActive = worktree.id === activeWorktreeId;
      const hasActiveQuery = query.trim().length > 0;

      // hideMainWorktree always takes precedence for the main worktree (user's explicit intent)
      if (hideMainWorktree && worktree.isMainWorktree) {
        return false;
      }

      if (alwaysShowActive && isActive && !hasActiveQuery) {
        return true;
      }

      if (alwaysShowWaiting && derived.hasWaitingAgent && !hasActiveQuery) {
        return true;
      }

      return matchesFilters(worktree, filters, derived, isActive);
    });

    // Filter out pinned worktrees that no longer exist
    const existingWorktreeIds = new Set(worktrees.map((w) => w.id));
    const validPinnedWorktrees = pinnedWorktrees.filter((id) => existingWorktreeIds.has(id));

    // Sort worktrees
    const sorted = sortWorktrees(filtered, orderBy, validPinnedWorktrees, manualOrder);

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
    alwaysShowWaiting,
    pinnedWorktrees,
    manualOrder,
    derivedMetaMap,
    activeWorktreeId,
    hideMainWorktree,
  ]);

  const handleKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  });

  useEffect(() => {
    if (!isOpen) return;
    const timeoutId = setTimeout(() => closeButtonRef.current?.focus(), 50);
    return () => clearTimeout(timeoutId);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => document.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [isOpen]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  if (!isOpen) return null;

  return (
    <div
      ref={modalRef}
      className={cn(
        "fixed inset-0 z-[var(--z-modal)] flex items-center justify-center",
        "bg-scrim-medium backdrop-blur-sm",
        "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
      )}
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="worktree-overview-title"
    >
      <TooltipProvider delayDuration={400} skipDelayDuration={300}>
        <div
          className={cn(
            "relative flex flex-col",
            "w-[calc(100vw-80px)] h-[calc(100vh-80px)]",
            "max-w-[1800px] max-h-[1200px]",
            "bg-canopy-bg rounded-xl",
            "border border-divider",
            "shadow-[var(--theme-shadow-dialog)]",
            "motion-safe:animate-in motion-safe:zoom-in-95 motion-safe:duration-200"
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-divider shrink-0">
            <div className="flex items-center gap-3">
              <WorktreeOverviewIcon className="w-5 h-5 text-canopy-text/60" />
              <h2
                id="worktree-overview-title"
                className="text-canopy-text font-semibold text-base tracking-wide"
              >
                Worktrees Overview
              </h2>
              <span className="text-canopy-text/50 text-sm tabular-nums">
                ({filteredWorktrees.length}
                {filteredWorktrees.length !== worktrees.length && ` of ${worktrees.length}`})
              </span>
              {/* Aggregate activity statistics */}
              {(aggregateStats.workingCount > 0 || aggregateStats.waitingCount > 0) && (
                <div
                  className="flex items-center gap-2 ml-2 pl-3 border-l border-divider"
                  role="status"
                  aria-label="Agent activity statistics"
                >
                  {aggregateStats.workingCount > 0 && (
                    <span className="flex items-center gap-1 text-xs tabular-nums text-[var(--color-state-working)]">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-state-working)] motion-safe:animate-pulse" />
                      {aggregateStats.workingCount} working
                    </span>
                  )}
                  {aggregateStats.waitingCount > 0 && (
                    <span className="flex items-center gap-1 text-xs tabular-nums text-status-warning">
                      <span className="w-1.5 h-1.5 rounded-full bg-status-warning" />
                      {aggregateStats.waitingCount} waiting
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* Hide main worktree toggle - show if there are non-main worktrees OR if filter is active (to allow recovery) */}
              {(hasNonMainWorktrees || hideMainWorktree) && !hasOnlyMainWorktree && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!hideMainWorktree}
                      aria-label={hideMainWorktree ? "Show main worktree" : "Hide main worktree"}
                      onClick={() => setHideMainWorktree(!hideMainWorktree)}
                      className={cn(
                        "flex items-center gap-1.5 px-2 py-1 rounded-full text-xs transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent",
                        hideMainWorktree
                          ? "bg-tint/[0.06] text-canopy-text/40 hover:text-canopy-text/60"
                          : "bg-tint/[0.10] text-canopy-text/70 hover:text-canopy-text/90"
                      )}
                    >
                      <CanopyAgentIcon
                        className={cn(
                          "w-3 h-3 transition-colors",
                          hideMainWorktree ? "text-canopy-text/30" : "text-canopy-text/50"
                        )}
                      />
                      <span
                        className={cn(
                          "transition-all",
                          hideMainWorktree && "line-through decoration-canopy-text/30"
                        )}
                      >
                        main
                      </span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {hideMainWorktree ? "Show main worktree" : "Hide main worktree"}
                  </TooltipContent>
                </Tooltip>
              )}
              {/* Filter Popover */}
              <WorktreeFilterPopover />
              {/* Clear Filters Button - only shown when filters are active */}
              {hasActiveFilters() && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={clearAllFilters}
                      className={cn(
                        "flex items-center gap-1.5 px-2 py-1.5 rounded text-xs",
                        "text-canopy-text/60 hover:text-canopy-text",
                        "hover:bg-tint/[0.06]",
                        "transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent"
                      )}
                      aria-label="Clear all filters"
                    >
                      <FilterX className="w-3.5 h-3.5" />
                      <span>Clear</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Clear all filters</TooltipContent>
                </Tooltip>
              )}
              {/* Close Button */}
              <button
                ref={closeButtonRef}
                onClick={onClose}
                className={cn(
                  "p-2 rounded-lg transition-colors",
                  "text-canopy-text/60 hover:text-canopy-text",
                  "hover:bg-tint/[0.06]",
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
              <EmptyWorktreeState />
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
                        "grid gap-3",
                        "grid-cols-[repeat(auto-fit,minmax(min(320px,100%),480px))]",
                        "justify-center",
                        "auto-rows-min"
                      )}
                    >
                      {section.worktrees.map((worktree: WorktreeState) => (
                        <div
                          key={worktree.id}
                          style={{
                            contentVisibility: "auto",
                            containIntrinsicSize: "auto 240px",
                          }}
                          className={cn(
                            "rounded-lg overflow-hidden",
                            "border border-divider",
                            "bg-canopy-sidebar/50",
                            "transition-all duration-200",
                            "hover:border-canopy-accent/50 hover:shadow-lg hover:shadow-canopy-accent/5",
                            worktree.id === activeWorktreeId &&
                              "border-[var(--color-state-active)]/70 shadow-md"
                          )}
                        >
                          <OverviewWorktreeCard
                            worktreeId={worktree.id}
                            activeWorktreeId={activeWorktreeId}
                            focusedWorktreeId={focusedWorktreeId}
                            totalWorktreeCount={worktrees.length}
                            onSelectWorktree={onSelectWorktree}
                            onCopyTree={onCopyTree}
                            onOpenEditor={onOpenEditor}
                            onSaveLayout={onSaveLayout}
                            onLaunchAgent={onLaunchAgent}
                            agentAvailability={agentAvailability}
                            agentSettings={agentSettings}
                            homeDir={homeDir}
                            onClose={onClose}
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
                  "grid gap-3",
                  "grid-cols-[repeat(auto-fit,minmax(min(320px,100%),480px))]",
                  "justify-center",
                  "items-start"
                )}
              >
                {filteredWorktrees.map((worktree) => (
                  <div
                    key={worktree.id}
                    style={{
                      contentVisibility: "auto",
                      containIntrinsicSize: "auto 240px",
                    }}
                    className={cn(
                      "rounded-lg overflow-hidden",
                      "border border-divider",
                      "bg-canopy-sidebar/50",
                      "transition-all duration-200",
                      "hover:border-canopy-accent/50 hover:shadow-lg hover:shadow-canopy-accent/5",
                      worktree.id === activeWorktreeId &&
                        "border-[var(--color-state-active)]/70 shadow-md"
                    )}
                  >
                    <OverviewWorktreeCard
                      variant="grid"
                      worktreeId={worktree.id}
                      activeWorktreeId={activeWorktreeId}
                      focusedWorktreeId={focusedWorktreeId}
                      totalWorktreeCount={worktrees.length}
                      onSelectWorktree={onSelectWorktree}
                      onCopyTree={onCopyTree}
                      onOpenEditor={onOpenEditor}
                      onSaveLayout={onSaveLayout}
                      onLaunchAgent={onLaunchAgent}
                      agentAvailability={agentAvailability}
                      agentSettings={agentSettings}
                      homeDir={homeDir}
                      onClose={onClose}
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
                <kbd className="px-1.5 py-0.5 bg-tint/[0.06] rounded text-[10px]">Esc</kbd> to close
              </span>
              <span>Click a worktree to switch</span>
            </div>
          </div>
        </div>
      </TooltipProvider>
    </div>
  );
}
