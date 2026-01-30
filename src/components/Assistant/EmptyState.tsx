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
  onSubmit?: (prompt: string) => void;
}

const suggestedActions = [
  {
    text: "Explain this codebase",
    prompt: "Give me an overview of this codebase. What does it do and how is it structured?",
  },
  {
    text: "Find TODO comments",
    prompt: "Search for TODO comments in the codebase and summarize what needs to be done.",
  },
  {
    text: "Review recent changes",
    prompt: "Show me the recent git changes and summarize what was modified.",
  },
];

export function EmptyState({ className, onSubmit }: EmptyStateProps) {
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
    <div className={cn("flex h-full flex-col items-center justify-center p-8", className)}>
      {/* Watermark - Ultra-low contrast branding */}
      <div
        className="mb-8 flex flex-col items-center gap-4 opacity-5 select-none"
        aria-hidden="true"
      >
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

      {/* Context Info */}
      <div className="w-full max-w-[260px] space-y-4" role="status" aria-label="Assistant context">
        {/* Context chips - less dashboard-like styling */}
        <div className="flex flex-wrap gap-2 justify-center">
          {currentProject && (
            <span
              className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-canopy-sidebar/30 border border-canopy-border/30 rounded text-xs text-canopy-text/60 max-w-[200px]"
              title={currentProject.name}
            >
              <span className="text-canopy-accent/70 truncate">{currentProject.name}</span>
            </span>
          )}
          {activeWorktree?.branch && (
            <span
              className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-canopy-sidebar/30 border border-canopy-border/30 rounded text-xs text-canopy-text/60 max-w-[200px]"
              title={activeWorktree.branch}
            >
              <GitBranch className="h-3 w-3 shrink-0" />
              <span className="truncate">{activeWorktree.branch}</span>
            </span>
          )}
          {!currentProject && !activeWorktreeId && (
            <span className="inline-flex items-center px-2.5 py-1 bg-canopy-sidebar/30 border border-canopy-border/30 rounded text-xs text-canopy-text/40">
              Global scope
            </span>
          )}
        </div>

        {/* Suggested actions when API key is configured */}
        {hasApiKey && onSubmit && (
          <div className="flex flex-col gap-2 items-center">
            <div className="text-[10px] uppercase tracking-wider text-canopy-text/30 font-semibold">
              Suggested actions
            </div>
            <div className="flex flex-wrap gap-2 justify-center">
              {suggestedActions.map((action) => (
                <button
                  key={action.text}
                  type="button"
                  onClick={() => onSubmit(action.prompt)}
                  className={cn(
                    "px-3 py-1.5 bg-canopy-accent/10 border border-canopy-accent/20 rounded text-xs",
                    "text-canopy-accent hover:bg-canopy-accent/15 hover:border-canopy-accent/30",
                    "transition-colors font-medium"
                  )}
                >
                  {action.text}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Configuration prompt if no API key */}
        {!hasApiKey && (
          <div className="pt-2">
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
