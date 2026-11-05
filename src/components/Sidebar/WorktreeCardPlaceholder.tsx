import { useEffect, useId, useState } from "react";
import { ChevronRight, XCircle } from "lucide-react";
import type { PendingCreation } from "@/store/worktreeStore";
import { BranchLabel } from "@/components/Worktree/BranchLabel";
import { mapCreationError } from "@/components/Worktree/worktreeCreationErrors";
import { Button } from "@/components/ui/button";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { SKELETON_HINT_FIRST_THRESHOLD_MS, useLiveRegionReady } from "@/components/ui/Skeleton";
import { Spinner } from "@/components/ui/Spinner";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { cn } from "@/lib/utils";

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
  const liveReady = useLiveRegionReady();
  // Setup hooks routinely take tens of seconds; a static "Creating…" that long
  // reads as stuck. A spinner past the Doherty gate, stilled by reduced motion
  // like every other.
  const showSpinner = useDohertyGate(!isError);
  const [showDetails, setShowDetails] = useState(false);
  const detailsId = useId();

  if (isError) {
    const title = `Couldn't create ${pendingCreation.branch}`;
    // Opening the worktree that already holds the branch is the fix, so the row
    // it would leave behind goes with it.
    const error = pendingCreation.error
      ? mapCreationError(pendingCreation.error, () => onDismiss(pendingCreation.path))
      : null;
    const hasDetails = error !== null && error.raw !== error.friendly;
    // The sidebar's failed-row vocabulary (`WorktreeCardErrorFallback`): neutral
    // surface, one red glyph, compact recovery buttons — so one failure doesn't
    // paint a red block into the list. Retry reopens the create dialog with the
    // request as it was submitted, which is where a conflict like "already
    // exists" gets fixed.
    return (
      <div
        role="alert"
        data-pending-creation-path={pendingCreation.path}
        data-variant="sidebar"
        className="sidebar-worktree-card flex items-start gap-2 px-4 py-3"
      >
        <XCircle className="mt-0.5 size-3.5 shrink-0 text-status-error" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1">
          <TruncatedTooltip content={title}>
            <span className="block truncate text-xs text-text-primary">{title}</span>
          </TruncatedTooltip>
          {error && (
            <TruncatedTooltip content={error.friendly}>
              <p className="line-clamp-3 break-words text-xs text-text-secondary">
                {error.friendly}
              </p>
            </TruncatedTooltip>
          )}
          {hasDetails && (
            <div>
              <button
                type="button"
                onClick={() => setShowDetails((shown) => !shown)}
                aria-expanded={showDetails}
                aria-controls={detailsId}
                className={cn(
                  "-ml-1 inline-flex h-6 items-center gap-1 rounded-[var(--radius-sm)] px-1",
                  "text-xs text-text-secondary hover:text-text-primary",
                  "transition-colors duration-150 ease-out",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
                )}
              >
                <ChevronRight
                  data-animated-chevron
                  className={cn(
                    "size-3 shrink-0 transition-transform duration-150 ease-out",
                    showDetails && "rotate-90"
                  )}
                  aria-hidden="true"
                />
                Git output
              </button>
              {showDetails && (
                <pre
                  id={detailsId}
                  tabIndex={0}
                  aria-label="Git output"
                  className={cn(
                    "mt-1 max-h-32 overflow-auto rounded-[var(--radius-sm)] px-2 py-1.5",
                    "border border-divider bg-overlay-subtle",
                    "select-text whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed text-text-secondary",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
                  )}
                >
                  {error.raw}
                </pre>
              )}
            </div>
          )}
          <div className="flex items-center gap-1.5 pt-1">
            {error?.recovery && (
              <Button type="button" variant="subtle" size="xs" onClick={error.recovery.onAction}>
                {error.recovery.label}
              </Button>
            )}
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

  // Shaped like the collapsed card it turns into — same card chrome, gutter and
  // `py-1` band — so the list keeps its rhythm and the real row lands in place.
  // The line's height comes from the card's own action button, carried as an
  // invisible zero-width strut: that button sets a real row's height, and it
  // measures differently when forced colors gives it a border, so a fixed
  // min-height would match in one mode and not the other. The branch is already
  // known, so it is shown rather than stood in for; the status sits where the
  // row's controls will appear. The visible row is not the live region: the
  // sr-only status beside it is registered empty and filled a commit later, so
  // "Creating worktree …" is actually announced.
  const status = slow ? STILL_CREATING_COPY : CREATING_COPY;
  return (
    <div
      data-pending-creation-path={pendingCreation.path}
      data-variant="sidebar"
      className="sidebar-worktree-card relative flex"
    >
      <span role="status" aria-live="polite" className="sr-only">
        {liveReady
          ? `${slow ? "Still creating" : "Creating"} worktree ${pendingCreation.branch}`
          : ""}
      </span>
      <div className="w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 pe-4" aria-hidden="true">
        <div className="py-1">
          <div className="flex min-h-[22px] items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center">
              <BranchLabel label={pendingCreation.branch} isActive={false} />
            </div>
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-text-secondary">
              {showSpinner && <Spinner size="xs" className="shrink-0" />}
              {status}
            </span>
            {/* Holds the row at a live card's height: its toolbar buttons are 24px. */}
            <span className="block h-6 w-0 shrink-0" />
          </div>
        </div>
      </div>
    </div>
  );
}
