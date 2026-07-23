import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { TypedNameConfirmInput } from "@/components/ui/TypedNameConfirmInput";
import { AlertTriangle, Trash2 } from "lucide-react";
import { FolderGit2 } from "@/components/icons";
import { useWorktreeTerminals } from "@/hooks/useWorktreeTerminals";
import { deriveEffectiveTier } from "@/services/actions/deriveEffectiveTier";
import {
  buildWorktreeDeletePreview,
  summarizeWorktreeChanges,
  type WorktreeDeletePreview,
} from "@/components/Worktree/worktreeDeletePreview";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import type { WorktreeState } from "@/types";
import { cn } from "@/lib/utils";
import { isProtectedBranch as isProtectedBranchName } from "@shared/utils/gitConstants";

interface WorktreeDeleteDialogProps {
  isOpen: boolean;
  onClose: () => void;
  worktree: WorktreeState;
}

export function WorktreeDeleteDialog({ isOpen, onClose, worktree }: WorktreeDeleteDialogProps) {
  const [force, setForce] = useState(false);
  const [closeTerminals, setCloseTerminals] = useState(true);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");
  const [hasDevPreview, setHasDevPreview] = useState(false);
  // Fresh git-status snapshot fetched when the dialog opens and re-checked on
  // submit (#11343). The prop `worktree.worktreeChanges` can be ~30s stale for
  // a backgrounded worktree, which would let a force-delete skip the D3 gate
  // and silently discard uncommitted work. `null` = not yet fetched / monitor
  // gone (fall back to the prop snapshot); `verifyFailed` = the fresh fetch
  // errored, so we FAIL CLOSED (treat the tree as dirty, escalate the tier).
  const [freshPreview, setFreshPreview] = useState<WorktreeDeletePreview | null>(null);
  const [verifyFailed, setVerifyFailed] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  // Tracks the live `isOpen` so an in-flight submit revalidation can abort if
  // the user cancels the dialog mid-fetch instead of dispatching after close.
  const openRef = useRef(isOpen);
  openRef.current = isOpen;

  const { counts: terminalCounts } = useWorktreeTerminals(worktree.id);

  // Preview + tier derive from the FRESH fetch when available, else the prop
  // snapshot as an initial seed. A failed fetch fails closed via
  // `hasTrackedChanges` so the D3 typed-name gate is never skipped on stale
  // (or unverifiable) state.
  const seedSummary = summarizeWorktreeChanges(worktree.worktreeChanges?.changes);
  const effectiveSummary = freshPreview ?? seedSummary;
  const trackedChangeCount = effectiveSummary.trackedChangeCount;
  const untrackedFileCount = effectiveSummary.untrackedFileCount;
  const hasTrackedChanges = verifyFailed || effectiveSummary.hasTrackedChanges;
  const hasUntrackedFiles = effectiveSummary.hasUntrackedFiles;
  const hasChanges = hasTrackedChanges || hasUntrackedFiles;
  const hasTerminals = terminalCounts.total > 0;

  const isProtectedBranch = isProtectedBranchName(worktree.branch?.toLowerCase());
  const isDetachedHead = !worktree.branch;
  const canDeleteBranch =
    !isProtectedBranch && !isDetachedHead && worktree.isMainWorktree === false;

  const confirmTarget = worktree.branch || worktree.name;
  const highTierPreamble =
    isProtectedBranch || worktree.isMainWorktree === true
      ? "Force-deleting this protected worktree is irreversible."
      : "Force-deleting this worktree discards uncommitted tracked changes — this is irreversible.";
  const isHighTier =
    deriveEffectiveTier("worktree.delete", {
      force,
      isProtectedBranch,
      isMainWorktree: worktree.isMainWorktree === true,
      hasTrackedChanges,
    }) === "D3";
  const isConfirmMatched = confirmInput === confirmTarget;
  const canSubmit = (!isHighTier || isConfirmMatched) && !isDeleting;

  useEffect(() => {
    if (isOpen) {
      setForce(false);
      setCloseTerminals(true);
      setDeleteBranch(false);
      setConfirmInput("");
      setHasDevPreview(false);
      setIsDeleting(false);
    }
  }, [isOpen, worktree.id]);

  // Fetch a FRESH git-status snapshot when the dialog opens so the tier + the
  // changed-file preview reflect live changes, not a possibly-stale cache
  // (#11343). Guarded against stale-closure on unmount/worktree change. A
  // failed fetch fails closed (`verifyFailed`) — we never silently fall back to
  // the stale snapshot and offer the lower tier.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setFreshPreview(null);
    setVerifyFailed(false);
    buildWorktreeDeletePreview(worktree.id)
      .then((preview) => {
        if (!cancelled) setFreshPreview(preview);
      })
      .catch(() => {
        if (!cancelled) setVerifyFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, worktree.id]);

  // Disclose a running dev server in the "What will happen" list so the user
  // isn't surprised when the cascade runs (Tier D2 destructive action rule).
  // Guard against stale-closure on unmount/worktree change (lesson #4754).
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    window.electron.devPreview
      .getByWorktree({ worktreeId: worktree.id })
      .then((state) => {
        if (cancelled) return;
        setHasDevPreview(state !== null && state.status !== "stopped");
      })
      .catch(() => {
        // Disclosure is informational; failing to fetch should not block
        // the dialog. The actual stop attempt happens in runDeleteAsync.
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, worktree.id]);

  useEffect(() => {
    if (!force) {
      setConfirmInput("");
    }
  }, [force]);

  useEffect(() => {
    if (!canDeleteBranch && deleteBranch) {
      setDeleteBranch(false);
    }
  }, [canDeleteBranch, deleteBranch]);

  const dispatchDelete = () => {
    const effectiveDeleteBranch = deleteBranch && canDeleteBranch;
    const options = {
      force,
      deleteBranch: effectiveDeleteBranch,
      ...(closeTerminals && hasTerminals ? { closeTerminals: true } : {}),
    };

    // Fire-and-forget — progress and any failure surface on the card, not the
    // modal (#8417). The dialog closes immediately so the user keeps flow.
    getCurrentViewStore().getState().startDelete(worktree.id, options);
    useAnnouncerStore.getState().announce("Deleting worktree");
    onClose();
  };

  // Re-check LIVE changes immediately before a force-delete dispatch (#11343).
  // An agent can write files between open and submit; without this, a delete
  // that looked D2 at open could discard tracked work the typed-name gate was
  // meant to guard. If the fresh check now escalates to D3 and the name isn't
  // matched, we surface the gate instead of dispatching. Fails closed on fetch
  // error. Only the force path needs this — a non-force delete can never
  // discard tracked changes (the backend guard rejects a dirty non-force
  // delete), so it dispatches synchronously and keeps its immediate dismiss.
  const revalidateThenDelete = async () => {
    setIsDeleting(true);
    let preview: WorktreeDeletePreview | null = null;
    let failed = false;
    try {
      preview = await buildWorktreeDeletePreview(worktree.id);
    } catch {
      failed = true;
    }
    if (!openRef.current) return;
    setFreshPreview(preview);
    setVerifyFailed(failed);
    const freshHasTracked = failed ? true : (preview ?? seedSummary).hasTrackedChanges;
    const freshTier = deriveEffectiveTier("worktree.delete", {
      force: true,
      isProtectedBranch,
      isMainWorktree: worktree.isMainWorktree === true,
      hasTrackedChanges: freshHasTracked,
    });
    if (freshTier === "D3" && confirmInput !== confirmTarget) {
      // Escalated on fresh data — show the typed-name gate, do not dispatch.
      setIsDeleting(false);
      return;
    }
    dispatchDelete();
  };

  const handleDelete = () => {
    if (isHighTier && !isConfirmMatched) return;
    if (isDeleting) return;
    if (!force) {
      dispatchDelete();
      return;
    }
    void revalidateThenDelete();
  };

  const deleteButtonLabel = !force
    ? "Delete worktree"
    : isHighTier
      ? `Force delete '${confirmTarget}'`
      : "Force delete worktree";

  let advisoryBanner: React.ReactNode = null;
  if (verifyFailed) {
    // Fresh-status fetch failed: we can't confirm what's in the tree, so we
    // fail closed (the tier is already escalated via `hasTrackedChanges`) and
    // say so plainly rather than implying a clean/known state.
    advisoryBanner = (
      <div
        role="alert"
        className="flex items-start gap-2 p-3 bg-status-error/10 border border-status-error/20 rounded text-status-error text-xs"
      >
        <AlertTriangle className="w-4 h-4 shrink-0" />
        <p>
          Couldn't verify this worktree's current changes. Force delete may discard uncommitted work
          — proceed only if you're sure. This is irreversible.
        </p>
      </div>
    );
  } else if (hasChanges) {
    if (!force) {
      advisoryBanner = (
        <div
          role="alert"
          className="flex items-start gap-2 p-3 bg-status-warning/10 border border-status-warning/20 rounded text-status-warning text-xs"
        >
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <p>
            This worktree has{" "}
            {hasTrackedChanges && hasUntrackedFiles
              ? `${trackedChangeCount} uncommitted file${trackedChangeCount === 1 ? "" : "s"} and ${untrackedFileCount} untracked file${untrackedFileCount === 1 ? "" : "s"}`
              : hasTrackedChanges
                ? `${trackedChangeCount} uncommitted file${trackedChangeCount === 1 ? "" : "s"}`
                : `${untrackedFileCount} untracked file${untrackedFileCount === 1 ? "" : "s"}`}
            . Standard deletion will fail.
          </p>
        </div>
      );
    } else if (hasTrackedChanges) {
      advisoryBanner = (
        <div
          role="alert"
          className="flex items-start gap-2 p-3 bg-status-error/10 border border-status-error/20 rounded text-status-error text-xs"
        >
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <p>
            Force delete will discard {trackedChangeCount} uncommitted tracked file
            {trackedChangeCount === 1 ? "" : "s"}
            {hasUntrackedFiles
              ? ` and ${untrackedFileCount} untracked file${untrackedFileCount === 1 ? "" : "s"}`
              : ""}
            . This is irreversible.
          </p>
        </div>
      );
    } else {
      advisoryBanner = (
        <div
          role="alert"
          className="flex items-start gap-2 p-3 bg-status-error/10 border border-status-error/20 rounded text-status-error text-xs"
        >
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <p>
            Force delete will permanently remove {untrackedFileCount} untracked file
            {untrackedFileCount === 1 ? "" : "s"}.
          </p>
        </div>
      );
    }
  }

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      variant="destructive"
      data-testid="delete-worktree-dialog"
    >
      <AppDialog.Body>
        <div className="flex items-center gap-3 mb-4 text-status-error">
          <div className="p-2 bg-status-error/10 rounded-full">
            <Trash2 className="w-6 h-6" />
          </div>
          <AppDialog.Title>Delete '{confirmTarget}'?</AppDialog.Title>
        </div>

        <div className="space-y-4">
          <div>
            <span
              role="heading"
              aria-level={3}
              className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60"
            >
              What will happen
            </span>
            <ul className="mt-2 space-y-1">
              <li className="text-sm text-daintree-text">Worktree directory will be deleted</li>
              <li
                className={cn(
                  "text-sm",
                  closeTerminals && hasTerminals
                    ? "text-daintree-text"
                    : "text-daintree-text/40 line-through"
                )}
              >
                {terminalCounts.total} terminal{terminalCounts.total === 1 ? "" : "s"} will be
                closed
              </li>
              <li
                className={cn(
                  "text-sm",
                  hasDevPreview ? "text-daintree-text" : "text-daintree-text/40 line-through"
                )}
              >
                Dev server will be stopped
              </li>
              <li
                className={cn(
                  "text-sm",
                  force && hasChanges ? "text-status-error" : "text-daintree-text/40 line-through"
                )}
              >
                Uncommitted changes will be lost
              </li>
              <li
                className={cn(
                  "text-sm",
                  deleteBranch && canDeleteBranch && force
                    ? "text-status-warning"
                    : deleteBranch && canDeleteBranch
                      ? "text-daintree-text"
                      : "text-daintree-text/40 line-through"
                )}
              >
                {worktree.branch ? (
                  <>
                    Branch <span className="font-mono break-all">{worktree.branch}</span> will be
                    deleted
                  </>
                ) : (
                  "Branch will be deleted"
                )}
              </li>
            </ul>
          </div>
          <p className="text-xs text-daintree-text/50">This cannot be undone.</p>

          <div className="text-xs text-daintree-text/60 bg-daintree-bg p-3 rounded border border-border-strong font-mono break-all">
            {worktree.path}
          </div>

          {advisoryBanner}

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
              className="rounded border-border-strong bg-daintree-bg text-status-error focus:ring-status-error"
            />
            <span className="text-sm text-daintree-text">
              {hasTrackedChanges && hasUntrackedFiles
                ? "Force delete (lose uncommitted changes and untracked files)"
                : hasUntrackedFiles
                  ? "Force delete (remove untracked files)"
                  : "Force delete (lose uncommitted changes)"}
            </span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={closeTerminals}
              onChange={(e) => setCloseTerminals(e.target.checked)}
              className="rounded border-border-strong bg-daintree-bg text-daintree-accent focus:ring-daintree-accent"
            />
            <span className="text-sm text-daintree-text">
              Close all terminals{hasTerminals ? ` (${terminalCounts.total})` : ""}
            </span>
          </label>

          {canDeleteBranch && (
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={deleteBranch}
                onChange={(e) => setDeleteBranch(e.target.checked)}
                className="mt-0.5 rounded border-border-strong bg-daintree-bg text-status-error focus:ring-status-error"
              />
              <span className="text-sm text-daintree-text">
                <span className="flex items-center gap-1.5">
                  <FolderGit2 className="w-3.5 h-3.5" />
                  Delete branch{" "}
                  <code className="text-xs bg-daintree-bg px-1.5 py-0.5 rounded border border-border-strong">
                    {worktree.branch}
                  </code>
                </span>
                {deleteBranch && (
                  <span className="block text-xs text-daintree-text/60 mt-1">
                    Safe delete — fails if branch has unmerged changes
                  </span>
                )}
              </span>
            </label>
          )}

          {isHighTier && (
            <TypedNameConfirmInput
              target={confirmTarget}
              value={confirmInput}
              onChange={setConfirmInput}
              onMatchSubmit={handleDelete}
              preamble={highTierPreamble}
              data-testid="delete-worktree-confirm-input"
            />
          )}
        </div>
      </AppDialog.Body>

      <AppDialog.Footer>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          onClick={handleDelete}
          disabled={!canSubmit}
          aria-live="polite"
          data-testid="delete-worktree-confirm"
        >
          {deleteButtonLabel}
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}
