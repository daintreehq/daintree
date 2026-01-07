import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { AlertTriangle, Trash2, GitBranch } from "lucide-react";
import { useWorktreeTerminals } from "@/hooks/useWorktreeTerminals";
import { useTerminalStore } from "@/store";
import { actionService } from "@/services/ActionService";
import type { WorktreeState } from "@/types";

interface WorktreeDeleteDialogProps {
  isOpen: boolean;
  onClose: () => void;
  worktree: WorktreeState;
}

const ARMED_TIMEOUT_MS = 4000;
const PROTECTED_BRANCHES = ["main", "master", "develop", "development"];

export function WorktreeDeleteDialog({ isOpen, onClose, worktree }: WorktreeDeleteDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [force, setForce] = useState(false);
  const [closeTerminals, setCloseTerminals] = useState(true);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [isArmed, setIsArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { counts: terminalCounts } = useWorktreeTerminals(worktree.id);
  const bulkCloseByWorktree = useTerminalStore((state) => state.bulkCloseByWorktree);

  const hasChanges = (worktree.worktreeChanges?.changedFileCount ?? 0) > 0;
  const hasTerminals = terminalCounts.total > 0;

  const isProtectedBranch =
    worktree.branch && PROTECTED_BRANCHES.includes(worktree.branch.toLowerCase());
  const isDetachedHead = !worktree.branch;
  const canDeleteBranch =
    !isProtectedBranch && !isDetachedHead && worktree.isMainWorktree === false;

  const clearArmedTimer = useCallback(() => {
    if (armedTimerRef.current) {
      clearTimeout(armedTimerRef.current);
      armedTimerRef.current = null;
    }
  }, []);

  const disarm = useCallback(() => {
    clearArmedTimer();
    setIsArmed(false);
  }, [clearArmedTimer]);

  useEffect(() => {
    if (isOpen) {
      setForce(false);
      setDeleteBranch(false);
      setError(null);
      disarm();
    }
    return () => clearArmedTimer();
  }, [isOpen, worktree.id, disarm, clearArmedTimer]);

  useEffect(() => {
    if (!deleteBranch && isArmed) {
      disarm();
    }
  }, [deleteBranch, isArmed, disarm]);

  useEffect(() => {
    if (!canDeleteBranch && (deleteBranch || isArmed)) {
      setDeleteBranch(false);
      disarm();
    }
  }, [canDeleteBranch, deleteBranch, isArmed, disarm]);

  const handleDelete = async () => {
    const effectiveDeleteBranch = deleteBranch && canDeleteBranch;

    if (effectiveDeleteBranch && !isArmed) {
      setIsArmed(true);
      clearArmedTimer();
      armedTimerRef.current = setTimeout(() => {
        setIsArmed(false);
      }, ARMED_TIMEOUT_MS);
      return;
    }

    setIsDeleting(true);
    setError(null);
    disarm();

    try {
      if (closeTerminals && hasTerminals) {
        bulkCloseByWorktree(worktree.id);
      }
      const result = await actionService.dispatch(
        "worktree.delete",
        { worktreeId: worktree.id, force, deleteBranch: effectiveDeleteBranch },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setIsDeleting(false);
    }
  };

  const getDeleteButtonText = () => {
    if (isDeleting) return "Deleting...";
    if (deleteBranch && canDeleteBranch && isArmed) return "Click again to confirm";
    return "Delete Worktree";
  };

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      variant="destructive"
      dismissible={!isDeleting}
    >
      <AppDialog.Body>
        <div className="flex items-center gap-3 mb-4 text-[var(--color-status-error)]">
          <div className="p-2 bg-[var(--color-status-error)]/10 rounded-full">
            <Trash2 className="w-6 h-6" />
          </div>
          <AppDialog.Title>Delete Worktree?</AppDialog.Title>
        </div>

        <div className="space-y-4">
          <p className="text-sm text-canopy-text/80">
            Are you sure you want to delete{" "}
            <span className="font-mono font-medium text-canopy-text">
              {worktree.branch || worktree.name}
            </span>
            ?
          </p>

          <div className="text-xs text-canopy-text/60 bg-canopy-bg/50 p-3 rounded border border-canopy-border font-mono break-all">
            {worktree.path}
          </div>

          {hasChanges && !force && (
            <div className="flex items-start gap-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded text-amber-500 text-xs">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <p>This worktree has uncommitted changes. Standard deletion will fail.</p>
            </div>
          )}

          {error && (
            <div
              role="alert"
              aria-live="assertive"
              className="p-3 bg-red-500/10 border border-red-500/20 rounded text-[var(--color-status-error)] text-xs"
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
              className="rounded border-canopy-border bg-canopy-bg text-[var(--color-status-error)] focus:ring-[var(--color-status-error)]"
            />
            <span className="text-sm text-canopy-text">
              Force delete (lose uncommitted changes)
            </span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={closeTerminals}
              onChange={(e) => setCloseTerminals(e.target.checked)}
              className="rounded border-canopy-border bg-canopy-bg text-canopy-accent focus:ring-canopy-accent"
            />
            <span className="text-sm text-canopy-text">
              Close all terminals{hasTerminals ? ` (${terminalCounts.total})` : ""}
            </span>
          </label>

          {canDeleteBranch && (
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={deleteBranch}
                onChange={(e) => {
                  setDeleteBranch(e.target.checked);
                  if (!e.target.checked) {
                    disarm();
                  }
                }}
                className="mt-0.5 rounded border-canopy-border bg-canopy-bg text-[var(--color-status-error)] focus:ring-[var(--color-status-error)]"
              />
              <span className="text-sm text-canopy-text">
                <span className="flex items-center gap-1.5">
                  <GitBranch className="w-3.5 h-3.5" />
                  Delete branch{" "}
                  <code className="text-xs bg-canopy-bg/50 px-1.5 py-0.5 rounded border border-canopy-border">
                    {worktree.branch}
                  </code>
                </span>
                {deleteBranch && (
                  <span className="block text-xs text-canopy-text/60 mt-1">
                    {force
                      ? "Branch will be force-deleted (git branch -D)"
                      : "Safe delete - fails if branch has unmerged changes"}
                  </span>
                )}
              </span>
            </label>
          )}
        </div>
      </AppDialog.Body>

      <AppDialog.Footer>
        <Button variant="ghost" onClick={onClose} disabled={isDeleting}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          onClick={handleDelete}
          disabled={isDeleting}
          className={isArmed ? "animate-pulse ring-2 ring-[var(--color-status-error)]" : ""}
        >
          {getDeleteButtonText()}
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}
