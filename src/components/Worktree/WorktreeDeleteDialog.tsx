import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { AlertTriangle, Trash2 } from "lucide-react";
import { useWorktreeTerminals } from "@/hooks/useWorktreeTerminals";
import { useTerminalStore } from "@/store";
import { actionService } from "@/services/ActionService";
import type { WorktreeState } from "@/types";

interface WorktreeDeleteDialogProps {
  isOpen: boolean;
  onClose: () => void;
  worktree: WorktreeState;
}

export function WorktreeDeleteDialog({ isOpen, onClose, worktree }: WorktreeDeleteDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [force, setForce] = useState(false);
  const [closeTerminals, setCloseTerminals] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { counts: terminalCounts } = useWorktreeTerminals(worktree.id);
  const bulkCloseByWorktree = useTerminalStore((state) => state.bulkCloseByWorktree);

  const hasChanges = (worktree.worktreeChanges?.changedFileCount ?? 0) > 0;
  const hasTerminals = terminalCounts.total > 0;

  useEffect(() => {
    if (isOpen) {
      setForce(false);
      setError(null);
    }
  }, [isOpen, worktree.id]);

  const handleDelete = async () => {
    setIsDeleting(true);
    setError(null);
    try {
      if (closeTerminals && hasTerminals) {
        bulkCloseByWorktree(worktree.id);
      }
      const result = await actionService.dispatch(
        "worktree.delete",
        { worktreeId: worktree.id, force },
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
        </div>
      </AppDialog.Body>

      <AppDialog.Footer>
        <Button variant="ghost" onClick={onClose} disabled={isDeleting}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
          {isDeleting ? "Deleting..." : "Delete Worktree"}
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}
