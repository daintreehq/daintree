import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { AlertTriangle, Trash2 } from "lucide-react";
import { FolderGit2 } from "@/components/icons";
import { useWorktreeTerminals } from "@/hooks/useWorktreeTerminals";
import { usePanelStore } from "@/store";
import { actionService } from "@/services/ActionService";
import type { WorktreeState } from "@/types";
import { formatErrorMessage } from "@shared/utils/errorMessage";

interface WorktreeDeleteDialogProps {
  isOpen: boolean;
  onClose: () => void;
  worktree: WorktreeState;
}

const PROTECTED_BRANCHES = ["main", "master", "develop", "development"];

export function WorktreeDeleteDialog({ isOpen, onClose, worktree }: WorktreeDeleteDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [force, setForce] = useState(false);
  const [closeTerminals, setCloseTerminals] = useState(true);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const deleteInFlightRef = useRef(false);

  const { counts: terminalCounts } = useWorktreeTerminals(worktree.id);
  const bulkCloseByWorktree = usePanelStore((state) => state.bulkCloseByWorktree);

  const changes = worktree.worktreeChanges?.changes ?? [];
  const hasTrackedChanges = changes.some((c) => c.status !== "untracked" && c.status !== "ignored");
  const hasUntrackedFiles = changes.some((c) => c.status === "untracked");
  const hasChanges = hasTrackedChanges || hasUntrackedFiles;
  const hasTerminals = terminalCounts.total > 0;

  const isProtectedBranch =
    !!worktree.branch && PROTECTED_BRANCHES.includes(worktree.branch.toLowerCase());
  const isDetachedHead = !worktree.branch;
  const canDeleteBranch =
    !isProtectedBranch && !isDetachedHead && worktree.isMainWorktree === false;

  const confirmTarget = worktree.branch ?? worktree.name;
  const isHighTier = force && (isProtectedBranch || worktree.isMainWorktree === true);
  const isConfirmMatched = confirmInput === confirmTarget;
  const canSubmit = !isDeleting && (!isHighTier || isConfirmMatched);

  useEffect(() => {
    if (isOpen) {
      setForce(false);
      setCloseTerminals(true);
      setDeleteBranch(false);
      setConfirmInput("");
      setError(null);
    }
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

  const handleDelete = async () => {
    if (deleteInFlightRef.current) return;
    if (isHighTier && !isConfirmMatched) return;

    deleteInFlightRef.current = true;
    setIsDeleting(true);
    setError(null);

    const effectiveDeleteBranch = deleteBranch && canDeleteBranch;

    try {
      const result = await actionService.dispatch(
        "worktree.delete",
        { worktreeId: worktree.id, force, deleteBranch: effectiveDeleteBranch },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      if (closeTerminals && hasTerminals) {
        bulkCloseByWorktree(worktree.id);
      }
      onClose();
    } catch (err) {
      const msg = formatErrorMessage(err, "Failed to delete worktree");
      setError(msg);
    } finally {
      setIsDeleting(false);
      deleteInFlightRef.current = false;
    }
  };

  const deleteButtonLabel = isHighTier ? `Delete '${confirmTarget}'` : "Delete worktree";

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      variant="destructive"
      dismissible={!isDeleting}
      data-testid="delete-worktree-dialog"
    >
      <AppDialog.Body>
        <div className="flex items-center gap-3 mb-4 text-status-error">
          <div className="p-2 bg-status-error/10 rounded-full">
            <Trash2 className="w-6 h-6" />
          </div>
          <AppDialog.Title>Delete '{confirmTarget}'?</AppDialog.Title>
        </div>

        {isDeleting ? (
          <div
            role="status"
            aria-busy="true"
            aria-live="polite"
            className="space-y-4"
            data-testid="delete-worktree-skeleton"
          >
            <span className="sr-only">Deleting worktree…</span>
            <div className="animate-pulse-delayed h-4 w-3/4 bg-muted rounded" />
            <div className="animate-pulse-delayed h-4 w-full bg-muted rounded" />
            <div className="animate-pulse-delayed h-8 w-full bg-muted rounded" />
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-daintree-text/80">
              This will permanently delete the worktree directory
              {deleteBranch && worktree.branch && (
                <>
                  {" "}
                  and branch{" "}
                  <span className="font-mono font-medium text-daintree-text">
                    {worktree.branch}
                  </span>
                </>
              )}
              .{closeTerminals && hasTerminals && " All associated terminals will be closed."}
              {hasChanges &&
                " Uncommitted changes will be lost unless the worktree is first restored from git."}
              {" This cannot be undone."}
            </p>

            <div className="text-xs text-daintree-text/60 bg-daintree-bg/50 p-3 rounded border border-daintree-border font-mono break-all">
              {worktree.path}
            </div>

            {hasChanges && !force && (
              <div className="flex items-start gap-2 p-3 bg-status-warning/10 border border-status-warning/20 rounded text-status-warning text-xs">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <p>
                  This worktree has{" "}
                  {hasTrackedChanges && hasUntrackedFiles
                    ? "uncommitted changes and untracked files"
                    : hasTrackedChanges
                      ? "uncommitted changes"
                      : "untracked files"}
                  . Standard deletion will fail.
                </p>
              </div>
            )}

            {error && (
              <div
                role="alert"
                aria-live="assertive"
                className="p-3 bg-status-error/10 border border-status-error/20 rounded text-status-error text-xs"
              >
                {error}
              </div>
            )}

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => {
                  setForce(e.target.checked);
                  setError(null);
                }}
                className="rounded border-daintree-border bg-daintree-bg text-status-error focus:ring-status-error"
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
                className="rounded border-daintree-border bg-daintree-bg text-daintree-accent focus:ring-daintree-accent"
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
                  className="mt-0.5 rounded border-daintree-border bg-daintree-bg text-status-error focus:ring-status-error"
                />
                <span className="text-sm text-daintree-text">
                  <span className="flex items-center gap-1.5">
                    <FolderGit2 className="w-3.5 h-3.5" />
                    Delete branch{" "}
                    <code className="text-xs bg-daintree-bg/50 px-1.5 py-0.5 rounded border border-daintree-border">
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
              <div className="space-y-2 p-3 bg-status-error/5 border border-status-error/20 rounded">
                <p id="worktree-delete-confirm-instructions" className="text-sm text-daintree-text">
                  Force-deleting this protected worktree is irreversible. Type{" "}
                  <code className="font-mono text-xs bg-daintree-bg/50 px-1.5 py-0.5 rounded border border-daintree-border">
                    {confirmTarget}
                  </code>{" "}
                  to confirm.
                </p>
                <input
                  type="text"
                  value={confirmInput}
                  onChange={(e) => setConfirmInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && isConfirmMatched) {
                      e.preventDefault();
                      void handleDelete();
                    }
                  }}
                  aria-describedby="worktree-delete-confirm-instructions"
                  aria-label={`Type ${confirmTarget} to confirm deletion`}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full px-3 py-2 text-sm font-mono bg-daintree-bg border border-daintree-border rounded focus:outline-hidden focus:ring-2 focus:ring-status-error"
                  data-testid="delete-worktree-confirm-input"
                />
                <span className="sr-only" aria-live="polite">
                  {isConfirmMatched ? "Name confirmed. You may now delete." : ""}
                </span>
              </div>
            )}
          </div>
        )}
      </AppDialog.Body>

      <AppDialog.Footer>
        <Button variant="ghost" onClick={onClose} disabled={isDeleting}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          onClick={handleDelete}
          disabled={!canSubmit}
          data-testid="delete-worktree-confirm"
        >
          {isDeleting ? "Deleting…" : deleteButtonLabel}
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}
