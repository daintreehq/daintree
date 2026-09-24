import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { PendingCreation } from "@/store/worktreeStore";
import { BranchLabel } from "@/components/Worktree/BranchLabel";
import { Button } from "@/components/ui/button";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { SKELETON_HINT_FIRST_THRESHOLD_MS } from "@/components/ui/Skeleton";

interface WorktreeCardPlaceholderProps {
  pendingCreation: PendingCreation;
  onRetry: (pendingCreation: PendingCreation) => void;
  onDismiss: (path: string) => void;
}

const CREATING_COPY = "Creating…";
const STILL_CREATING_COPY = "Still creating…";

/**
 * True once the creation has been running past the skeleton hint's first
 * threshold. Measured from `startedAt`, not from mount, so a list re-render
 * that remounts the row does not restart the clock.
 */
function useIsSlow(startedAt: number, active: boolean): boolean {
  const slowAt = startedAt + SKELETON_HINT_FIRST_THRESHOLD_MS;
  const [slow, setSlow] = useState(() => Date.now() >= slowAt);
  useEffect(() => {
    if (!active || slow) return;
    const id = setTimeout(() => setSlow(true), Math.max(0, slowAt - Date.now()));
    return () => clearTimeout(id);
  }, [active, slow, slowAt]);
  return slow;
}

export function WorktreeCardPlaceholder({
  pendingCreation,
  onRetry,
  onDismiss,
}: WorktreeCardPlaceholderProps) {
  const isError = pendingCreation.status === "error";
  const slow = useIsSlow(pendingCreation.startedAt, !isError);

  if (isError) {
    const title = `Couldn't create ${pendingCreation.branch}`;
    // The sidebar's failed-row vocabulary (`WorktreeCardErrorFallback`): neutral
    // surface, one red glyph, compact recovery buttons — so one failure doesn't
    // paint a red block into the list. Retry reopens the create dialog with the
    // branch filled in, which is where a conflict like "already exists" gets fixed.
    return (
      <div
        role="alert"
        data-pending-creation-path={pendingCreation.path}
        className="flex items-start gap-2 border-b border-divider px-4 py-3"
      >
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-status-error" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1">
          <TruncatedTooltip content={title}>
            <span className="block truncate text-xs text-text-primary">{title}</span>
          </TruncatedTooltip>
          {pendingCreation.error && (
            <p
              className="line-clamp-3 break-words text-xs text-text-secondary"
              title={pendingCreation.error}
            >
              {pendingCreation.error}
            </p>
          )}
          <div className="flex items-center gap-1.5 pt-1">
            <Button
              type="button"
              variant="subtle"
              size="xs"
              onClick={() => onRetry(pendingCreation)}
            >
              Retry
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => onDismiss(pendingCreation.path)}
            >
              Dismiss
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Shaped like the collapsed card it turns into — same card chrome, gutter,
  // `py-1` band and 22px header line — so the list keeps its rhythm and the real
  // row lands in place. The branch is already known, so it is shown rather than
  // stood in for; the status sits where the row's controls will appear.
  return (
    <div
      role="status"
      aria-label={`Creating worktree ${pendingCreation.branch}`}
      data-pending-creation-path={pendingCreation.path}
      data-variant="sidebar"
      className="sidebar-worktree-card relative flex"
    >
      <div className="w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 pe-4">
        <div className="py-1">
          <div className="flex min-h-[22px] items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center">
              <BranchLabel label={pendingCreation.branch} isActive={false} />
            </div>
            <span className="shrink-0 text-xs text-text-secondary">
              {slow ? STILL_CREATING_COPY : CREATING_COPY}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
