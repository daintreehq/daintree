import { AlertCircle } from "lucide-react";
import type { PendingCreation } from "@/store/worktreeStore";

interface WorktreeCardPlaceholderProps {
  pendingCreation: PendingCreation;
  onRetry: (pendingCreation: PendingCreation) => void;
  onDismiss: (path: string) => void;
}

export function WorktreeCardPlaceholder({
  pendingCreation,
  onRetry,
  onDismiss,
}: WorktreeCardPlaceholderProps) {
  if (pendingCreation.status === "error") {
    return (
      <div
        role="alert"
        data-pending-creation-path={pendingCreation.path}
        className="border-b border-border-default px-4 py-3 bg-status-error/[0.06]"
      >
        <div className="flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-status-error mt-0.5 shrink-0" aria-hidden="true" />
          <div className="flex-1 min-w-0 space-y-1">
            <div className="text-sm font-medium text-daintree-text">Couldn't create worktree</div>
            <div className="text-xs text-daintree-text/70 truncate" title={pendingCreation.branch}>
              {pendingCreation.branch}
            </div>
            {pendingCreation.error && (
              <div className="text-xs text-status-error/90 break-words">
                {pendingCreation.error}
              </div>
            )}
            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                onClick={() => onRetry(pendingCreation)}
                className="text-xs font-medium text-daintree-text underline underline-offset-2 hover:text-daintree-text/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent rounded-sm"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={() => onDismiss(pendingCreation.path)}
                className="text-xs text-daintree-text/60 hover:text-daintree-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent rounded-sm"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={`Creating worktree ${pendingCreation.branch}`}
      data-pending-creation-path={pendingCreation.path}
      className="border-b border-border-default px-4 py-3 flex flex-col gap-1.5"
    >
      <span className="sr-only">Creating worktree {pendingCreation.branch}</span>
      <div className="h-3.5 w-2/3 bg-muted rounded animate-pulse-delayed" aria-hidden="true" />
      <div className="h-3 w-1/3 bg-muted rounded animate-pulse-delayed" aria-hidden="true" />
    </div>
  );
}
