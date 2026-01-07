import { useCallback, useEffect, useRef, useMemo } from "react";
import { X, Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { WorktreeCard } from "./WorktreeCard";
import type { WorktreeState } from "@/types";
import type { UseAgentLauncherReturn } from "@/hooks/useAgentLauncher";

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

  const sortedWorktrees = useMemo(() => {
    return [...worktrees].sort((a, b) => {
      // Active worktree first
      if (a.id === activeWorktreeId) return -1;
      if (b.id === activeWorktreeId) return 1;
      // Main worktree second
      if (a.isMainWorktree && !b.isMainWorktree) return -1;
      if (!a.isMainWorktree && b.isMainWorktree) return 1;
      // Then alphabetical by name
      return a.name.localeCompare(b.name);
    });
  }, [worktrees, activeWorktreeId]);

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
      aria-label="Worktrees overview"
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
            <h2 className="text-canopy-text font-semibold text-base tracking-wide">
              Worktrees Overview
            </h2>
            <span className="text-canopy-text/50 text-sm">({worktrees.length})</span>
          </div>
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

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {worktrees.length === 0 ? (
            <div className="flex items-center justify-center h-full text-canopy-text/50">
              No worktrees available
            </div>
          ) : (
            <div
              className={cn(
                "grid gap-4",
                "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
                "auto-rows-min"
              )}
            >
              {sortedWorktrees.map((worktree) => (
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
