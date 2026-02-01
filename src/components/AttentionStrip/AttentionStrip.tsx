import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { AlertCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useAttentionTerminals } from "@/hooks/useAttentionTerminals";

export function AttentionStrip() {
  const { terminals, waitingCount, failedCount, totalCount } = useAttentionTerminals();

  const { activateTerminal, pingTerminal } = useTerminalStore(
    useShallow((state) => ({
      activateTerminal: state.activateTerminal,
      pingTerminal: state.pingTerminal,
    }))
  );

  const { activeWorktreeId, selectWorktree, trackTerminalFocus } = useWorktreeSelectionStore(
    useShallow((state) => ({
      activeWorktreeId: state.activeWorktreeId,
      selectWorktree: state.selectWorktree,
      trackTerminalFocus: state.trackTerminalFocus,
    }))
  );

  const handleView = useCallback(() => {
    const firstTerminal = terminals[0];
    if (!firstTerminal) return;

    if (firstTerminal.worktreeId && firstTerminal.worktreeId !== activeWorktreeId) {
      trackTerminalFocus(firstTerminal.worktreeId, firstTerminal.id);
      selectWorktree(firstTerminal.worktreeId);
    }

    activateTerminal(firstTerminal.id);
    pingTerminal(firstTerminal.id);
  }, [
    terminals,
    activeWorktreeId,
    trackTerminalFocus,
    selectWorktree,
    activateTerminal,
    pingTerminal,
  ]);

  if (totalCount === 0) return null;

  const hasWaiting = waitingCount > 0;
  const hasFailed = failedCount > 0;

  let message: string;
  if (hasWaiting && hasFailed) {
    message = `${totalCount} agent${totalCount === 1 ? "" : "s"} need attention`;
  } else if (hasWaiting) {
    message = `${waitingCount} agent${waitingCount === 1 ? "" : "s"} waiting for input`;
  } else {
    message = `${failedCount} agent${failedCount === 1 ? "" : "s"} failed`;
  }

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-3 py-1.5",
        "border-b transition-colors relative z-10",
        hasFailed
          ? "bg-[color-mix(in_oklab,var(--color-status-error)_8%,transparent)] border-[var(--color-status-error)]/20"
          : "bg-[color-mix(in_oklab,var(--color-status-warning)_8%,transparent)] border-[var(--color-status-warning)]/20"
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        {hasFailed ? (
          <XCircle
            className="w-4 h-4 shrink-0 text-[var(--color-status-error)]"
            aria-hidden="true"
          />
        ) : (
          <AlertCircle
            className="w-4 h-4 shrink-0 text-[var(--color-status-warning)]"
            aria-hidden="true"
          />
        )}
        <span
          className={cn(
            "text-xs font-medium truncate",
            hasFailed ? "text-[var(--color-status-error)]" : "text-[var(--color-status-warning)]"
          )}
          role={hasFailed ? "alert" : "status"}
          aria-live="polite"
          aria-atomic="true"
        >
          {message}
        </span>
      </div>

      <Button
        variant="outline"
        size="xs"
        onClick={handleView}
        className={cn(
          "shrink-0",
          hasFailed
            ? "border-[var(--color-status-error)]/30 text-[var(--color-status-error)] hover:bg-[var(--color-status-error)]/10 hover:text-[var(--color-status-error)]"
            : "border-[var(--color-status-warning)]/30 text-[var(--color-status-warning)] hover:bg-[var(--color-status-warning)]/10 hover:text-[var(--color-status-warning)]"
        )}
      >
        View
      </Button>
    </div>
  );
}
