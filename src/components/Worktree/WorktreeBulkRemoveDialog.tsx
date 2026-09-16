import { AlertTriangle, GitBranch, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";
import {
  buildSubmoduleCommitRows,
  buildSubmoduleFileRows,
  buildWorktreeChangeRows,
  submoduleCommitsAreCapped,
  type WorktreeChangeRow,
} from "./worktreeDeletePreview";
import {
  bulkRemoveExclusion,
  describeBulkRemoveRisks,
  type BulkRemoveTarget,
  type UseWorktreeBulkRemoveReturn,
} from "./useWorktreeBulkRemove";

/**
 * Per-target file cap, deliberately below the single-delete dialog's
 * {@link PREVIEW_FILE_LIMIT} of 12.
 *
 * The D2 duty is to show actual content rather than a count, and five rows
 * plus an "…and N more" tail discharges it. Twelve does not survive contact
 * with a twenty-worktree selection: the row the user needs to read scrolls
 * out of a fixed-height list, which is the same "warning nobody saw" failure
 * the count-only preview had.
 */
const BULK_PREVIEW_FILE_LIMIT = 5;

/** Max at-risk commit rows on a blocked target. */
const BULK_COMMIT_LIMIT = 3;

function FileRows({ rows, label }: { rows: WorktreeChangeRow[]; label: string }) {
  if (rows.length === 0) return null;
  return (
    <ul
      aria-label={label}
      className="mt-1 space-y-0.5 font-mono text-2xs text-text-secondary"
      data-testid="bulk-remove-file-list"
    >
      {rows.map((row) => (
        <li
          key={row.isOverflow ? "__overflow" : `${row.glyph}:${row.label}`}
          className={cn("flex gap-2", row.isOverflow && "italic")}
        >
          {!row.isOverflow && (
            <>
              <span aria-hidden="true" className="w-3 shrink-0">
                {row.glyph}
              </span>
              {/* The glyph column is right for scanning and useless to a
                  screen reader, which would otherwise hear a list of paths
                  with no way to tell a deletion from an addition. */}
              <span className="sr-only">{row.statusLabel}: </span>
            </>
          )}
          <span className="[overflow-wrap:anywhere]">{row.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** The evidence body for one snapshotted target, keyed on its preview state. */
function TargetBody({ target }: { target: BulkRemoveTarget }) {
  const status = target.status;

  if (status.state === "pending") {
    return (
      <Skeleton label="Checking for uncommitted work" className="mt-1">
        <SkeletonBone className="h-3 w-40" />
      </Skeleton>
    );
  }

  const exclusion = bulkRemoveExclusion(target);
  if (exclusion) {
    const text =
      exclusion.kind === "gone"
        ? "Already removed — excluded"
        : exclusion.kind === "verify-failed"
          ? "Couldn't read this worktree's changes — excluded"
          : exclusion.block === "at-risk-commits"
            ? "Holds submodule commits that are not on any remote — excluded until they are pushed"
            : "The submodule check didn't finish — excluded";

    // A failed parent fetch still carries whatever the submodule arm settled
    // to, and half an inventory is real evidence — naming the commits is what
    // tells the user why a retry will not clear this one.
    const submodules =
      status.state === "verified"
        ? status.preview.submodules
        : status.state === "failed"
          ? status.submodules
          : null;
    const commitRows = buildSubmoduleCommitRows(submodules?.risk ?? null, BULK_COMMIT_LIMIT);
    const capped = submodules ? submoduleCommitsAreCapped(submodules) : false;

    return (
      <div className="mt-1 text-xs text-text-secondary" data-testid="bulk-remove-excluded">
        <span>{text}</span>
        {commitRows.length > 0 && (
          <ul
            aria-label={
              capped ? "At least these submodule commits are at risk" : "Submodule commits at risk"
            }
            className="mt-1 space-y-0.5 font-mono text-2xs"
          >
            {commitRows.map((row) => (
              <li key={row.isOverflow ? "__overflow" : row.oid} className="flex gap-2">
                {!row.isOverflow && <span className="shrink-0">{row.shortOid}</span>}
                <span className="[overflow-wrap:anywhere]">{row.subject}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // Eligible. `status.state` is "verified" here — `bulkRemoveExclusion`
  // returns non-null for every other settled state.
  if (status.state !== "verified") return null;
  const risks = describeBulkRemoveRisks(target);
  const changeRows = buildWorktreeChangeRows(
    status.preview.changes,
    BULK_PREVIEW_FILE_LIMIT,
    status.preview.rootPath
  );
  const nestedRows = buildSubmoduleFileRows(
    status.preview.submodules.risk,
    BULK_PREVIEW_FILE_LIMIT
  );

  if (risks.length === 0) return null;

  return (
    <div className="mt-1">
      <div className="flex items-start gap-1.5 text-xs text-status-warning">
        <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
        <span>{risks.join(" · ")}</span>
      </div>
      {/* A D2 confirm owes a preview of real content; a count alone is
          insufficient, and the aggregate counts above are exactly what this
          surface used to stop at. */}
      <FileRows rows={changeRows} label="Uncommitted work" />
      {/* The parent's own status collapses a submodule holding two hundred
          dirty files into one ` M vendor/lib` row, so these cannot be derived
          from the list above. */}
      <FileRows rows={nestedRows} label="Files inside submodules" />
    </div>
  );
}

export interface WorktreeBulkRemoveDialogProps {
  bulkRemove: UseWorktreeBulkRemoveReturn;
}

/**
 * The D3 confirmation for the overview's bulk remove.
 *
 * Extracted from `WorktreeOverviewModal` when the confirm grew a real preview
 * (#12416): the evidence body branches on three settled preview states per
 * target, which is a DOM suite's worth of behaviour and does not belong inside
 * a 1,500-line modal.
 */
export function WorktreeBulkRemoveDialog({ bulkRemove }: WorktreeBulkRemoveDialogProps) {
  const {
    targets,
    excludedMainCount,
    eligibleCount,
    isPreviewPending,
    hasFailedPreviews,
    consentKey,
  } = bulkRemove;

  const settledExcluded = targets.filter(
    (t) => t.status.state !== "pending" && bulkRemoveExclusion(t) !== null
  ).length;

  const title =
    eligibleCount === 1 && targets.length === 1
      ? `Remove '${targets[0]?.branch ?? targets[0]?.name ?? "worktree"}'?`
      : `Remove ${targets.length === 1 ? "1 worktree" : `${targets.length} worktrees`}?`;

  // States the consequence, not generic irreversibility copy: what leaves the
  // disk is the working tree, and the branch is explicitly what does not.
  const baseDescription =
    "Each worktree directory is deleted from disk and the branch worktree association is removed. Uncommitted and untracked files are discarded, including files inside submodules. Branches are kept.";
  const description =
    excludedMainCount > 0
      ? `${baseDescription} ${excludedMainCount} main worktree${excludedMainCount === 1 ? " is" : "s are"} excluded — only non-main worktrees can be removed here.`
      : baseDescription;

  const confirmLabel =
    eligibleCount === 1 ? "Remove worktree" : `Remove ${eligibleCount} worktrees`;

  // Says what the primary is waiting on, in the place the user is looking when
  // they ask — a body-level note is not that place.
  const hint = isPreviewPending
    ? "Checking each worktree for uncommitted work"
    : eligibleCount === 0
      ? targets.length === 0
        ? null
        : "Nothing left to remove — every selected worktree was excluded"
      : settledExcluded > 0
        ? `${settledExcluded} excluded — ${eligibleCount} will be removed`
        : null;

  return (
    <ConfirmDialog
      isOpen={bulkRemove.isConfirmOpen}
      onClose={bulkRemove.handleCancel}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      cancelLabel="Cancel"
      variant="destructive"
      // Scrollable per-worktree table of what is about to be deleted — a
      // dialog, not an alertdialog.
      hasPreview={targets.length > 0}
      zIndex="nested"
      typedNameTarget={bulkRemove.typedNameTarget}
      // Clears a count typed against the skeletons once the evidence that
      // replaced them is on screen. No cooldown timer is set, so this is purely
      // the consent reset.
      cooldownKey={consentKey}
      confirmDisabled={!bulkRemove.canConfirm}
      hint={hint}
      onConfirm={bulkRemove.handleConfirm}
      isConfirmLoading={bulkRemove.isExecuting}
    >
      {targets.length > 0 && (
        <div
          className="border border-divider rounded-[var(--radius-md)] max-h-64 overflow-y-auto divide-y divide-divider"
          data-testid="bulk-remove-target-list"
        >
          {targets.map((target) => {
            const excluded = target.status.state !== "pending" && bulkRemoveExclusion(target);
            return (
              <div
                key={target.id}
                data-testid="bulk-remove-target"
                className={cn(
                  "flex flex-col gap-1 px-3 py-2 bg-surface-canvas/40",
                  excluded && "opacity-60"
                )}
              >
                <div className="flex items-center gap-2 text-sm text-text-primary">
                  <GitBranch className="w-3.5 h-3.5 shrink-0 text-text-secondary" />
                  {/* The branch is what truncates, so the branch is what the
                      tooltip has to reveal — it used to show the path, which
                      is not the string being clipped. */}
                  <span
                    className="font-mono truncate"
                    title={`${target.branch ?? target.name}\n${target.path}`}
                  >
                    {target.branch ?? target.name}
                  </span>
                </div>
                <TargetBody target={target} />
              </div>
            );
          })}
        </div>
      )}
      {hasFailedPreviews && (
        <div className="flex items-center justify-between gap-2 text-xs text-text-secondary">
          <span>Some worktrees couldn&apos;t be checked and were excluded.</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={bulkRemove.handleRetryPreviews}
            data-testid="bulk-remove-retry-previews"
          >
            Retry
          </Button>
        </div>
      )}
      <div className="flex items-start gap-2 p-3 bg-status-error/10 border border-status-error/20 rounded-[var(--radius-md)] text-status-error text-xs">
        <Trash2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>This is irreversible. Type the count to confirm.</span>
      </div>
    </ConfirmDialog>
  );
}
