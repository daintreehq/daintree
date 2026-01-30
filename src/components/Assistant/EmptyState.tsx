import { useCallback } from "react";
import { Settings, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { useProjectStore } from "@/store/projectStore";
import { useAppAgentStore } from "@/store/appAgentStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";

interface EmptyStateProps {
  className?: string;
}

export function EmptyState({ className }: EmptyStateProps) {
  const currentProject = useProjectStore((s) => s.currentProject);
  const hasApiKey = useAppAgentStore((s) => s.hasApiKey);
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const activeWorktree = useWorktreeDataStore((state) =>
    activeWorktreeId ? state.worktrees.get(activeWorktreeId) : null
  );

  const handleOpenSettings = useCallback(async () => {
    try {
      await actionService.dispatch("app.settings.openTab", { tab: "assistant" });
    } catch (error) {
      console.error("Failed to open settings:", error);
    }
  }, []);

  return (
    <div
      className={cn(
        "flex h-full flex-col items-center justify-center p-8 select-none",
        className
      )}
    >
      {/* Watermark - Ultra-low contrast branding */}
      <div className="mb-8 flex flex-col items-center gap-4 opacity-5" aria-hidden="true">
        <svg
          className="h-16 w-16"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      {/* System Status Monitor */}
      <div className="w-full max-w-[240px] space-y-3" role="status" aria-label="Assistant status">
        {/* Status Header */}
        <div className="flex items-center gap-2 text-[10px] font-bold tracking-[0.15em] text-canopy-text/30 uppercase">
          <div
            className={cn(
              "h-1 w-1 rounded-full",
              hasApiKey ? "bg-green-500/50" : "bg-amber-500/50"
            )}
            aria-hidden="true"
          />
          {hasApiKey ? "System Ready" : "Configuration Required"}
        </div>

        {/* Context Grid */}
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-l border-divider/30 pl-3 font-mono text-[11px] text-canopy-text/60">
          <span className="text-canopy-text/30">SCOPE</span>
          <span className="truncate">{currentProject ? "Project" : "Global"}</span>

          {currentProject && (
            <>
              <span className="text-canopy-text/30">PROJECT</span>
              <span className="truncate text-canopy-accent/80">{currentProject.name}</span>
            </>
          )}

          {activeWorktree?.branch && (
            <>
              <span className="text-canopy-text/30">BRANCH</span>
              <div className="flex items-center gap-1.5 truncate">
                <GitBranch className="h-3 w-3" />
                <span>{activeWorktree.branch}</span>
              </div>
            </>
          )}
        </div>

        {/* Configuration prompt if no API key */}
        {!hasApiKey && (
          <div className="mt-4 pt-4 border-t border-divider/20">
            <button
              type="button"
              onClick={handleOpenSettings}
              className={cn(
                "w-full flex items-center justify-center gap-2 px-3 py-2",
                "bg-canopy-sidebar/30 border border-canopy-border/50 rounded text-xs",
                "text-canopy-text/70 hover:text-canopy-text hover:border-canopy-accent/30",
                "transition-colors"
              )}
            >
              <Settings className="w-3 h-3" />
              Configure API Key
            </button>
          </div>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Keyboard Shortcuts Footer */}
      <div className="flex gap-6 pb-4 text-[11px] text-canopy-text/40 font-medium">
        <div className="flex items-center gap-2">
          <span className="flex items-center justify-center min-w-[20px] h-5 rounded border border-divider/50 bg-white/[0.03] px-1 font-mono text-[10px]">
            /
          </span>
          <span>Commands</span>
        </div>

        <div className="flex items-center gap-2">
          <span className="flex items-center justify-center min-w-[20px] h-5 rounded border border-divider/50 bg-white/[0.03] px-1 font-mono text-[10px]">
            @
          </span>
          <span>Context</span>
        </div>

        <div className="flex items-center gap-2">
          <kbd className="flex items-center justify-center h-5 rounded border border-divider/50 bg-white/[0.03] px-1.5 font-mono text-[10px]">
            ⌘⇧K
          </kbd>
          <span>Focus</span>
        </div>
      </div>
    </div>
  );
}
