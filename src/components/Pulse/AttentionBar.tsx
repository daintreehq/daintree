import { useMemo } from "react";
import { AlertTriangle, GitMerge } from "lucide-react";
import { useWaitingTerminals, useConflictedWorktrees } from "@/hooks/useTerminalSelectors";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { cn } from "@/lib/utils";

const MAX_VISIBLE = 3;

interface AttentionItem {
  kind: "agent" | "conflict";
  id: string;
  label: string;
  onClick: () => void;
}

export function AttentionBar() {
  const waitingTerminals = useWaitingTerminals();
  const conflictedWorktrees = useConflictedWorktrees();

  const items = useMemo<AttentionItem[]>(() => {
    const result: AttentionItem[] = [];

    for (const terminal of waitingTerminals) {
      result.push({
        kind: "agent",
        id: `agent-${terminal.id}`,
        label: terminal.title || "Agent",
        onClick: () => {
          const worktreeId = terminal.worktreeId?.trim();
          const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
          if (worktreeId && worktreeId !== activeWorktreeId) {
            useWorktreeSelectionStore.getState().trackTerminalFocus(worktreeId, terminal.id);
            useWorktreeSelectionStore.getState().selectWorktree(worktreeId);
          }
          useTerminalStore.getState().activateTerminal(terminal.id);
        },
      });
    }

    for (const worktree of conflictedWorktrees) {
      const wtId = worktree.worktreeId ?? worktree.id;
      result.push({
        kind: "conflict",
        id: `conflict-${wtId}`,
        label: worktree.branch ?? worktree.name ?? "Worktree",
        onClick: () => {
          useWorktreeSelectionStore.getState().selectWorktree(wtId);
        },
      });
    }

    return result;
  }, [waitingTerminals, conflictedWorktrees]);

  if (items.length === 0) return null;

  const visibleItems = items.slice(0, MAX_VISIBLE);
  const overflowCount = items.length - MAX_VISIBLE;

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 min-w-0"
      role="list"
      aria-label="Items requiring attention"
    >
      {visibleItems.map((item) => (
        <button
          key={item.id}
          role="listitem"
          type="button"
          onClick={item.onClick}
          className={cn(
            "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap min-w-0 max-w-48 transition-colors",
            item.kind === "agent" &&
              "bg-status-warning/10 text-status-warning hover:bg-status-warning/20",
            item.kind === "conflict" &&
              "bg-status-error/10 text-status-error hover:bg-status-error/20"
          )}
        >
          {item.kind === "agent" ? (
            <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
          ) : (
            <GitMerge className="size-3 shrink-0" aria-hidden="true" />
          )}
          <span className="truncate">{item.label}</span>
        </button>
      ))}
      {overflowCount > 0 && (
        <span className="text-xs text-canopy-text/55 whitespace-nowrap" role="listitem">
          +{overflowCount} more
        </span>
      )}
    </div>
  );
}
