import { useEffect } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useFileMutationConfirmStore } from "@/store/fileMutationConfirmStore";

function baseName(relativePath: string): string {
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? relativePath;
}

/**
 * D1 confirm for `git.discardFileChanges` and `file.trash` (#13424). Names the
 * file in the title and its worktree-relative path in the body, so two files
 * called `index.ts` can't be confused for each other.
 */
function FileMutationConfirmDialogInner() {
  const pendingConfirm = useFileMutationConfirmStore((s) => s.pendingConfirm);
  const resolveConfirmation = useFileMutationConfirmStore((s) => s.resolveConfirmation);

  // Resolve false on unmount so the awaiting action never hangs.
  useEffect(() => {
    return () => {
      if (useFileMutationConfirmStore.getState().pendingConfirm) {
        useFileMutationConfirmStore.getState().resolveConfirmation(false);
      }
    };
  }, []);

  if (!pendingConfirm) return null;

  const { kind, relativePath } = pendingConfirm;
  const name = baseName(relativePath);
  const isDiscard = kind === "discard";

  return (
    <ConfirmDialog
      isOpen={true}
      variant="destructive"
      // The menu that asks can sit inside a dialog of its own — the Review
      // Hub's diff is nested — and a confirm behind it can't be answered.
      zIndex="nested"
      onClose={() => resolveConfirmation(false)}
      onConfirm={() => resolveConfirmation(true)}
      title={isDiscard ? `Discard changes to '${name}'?` : `Delete '${name}'?`}
      description={
        isDiscard ? (
          <span>
            <span className="font-mono text-text-primary break-all">{relativePath}</span> goes back
            to its last commit. Its staged and unstaged changes are both lost and can&rsquo;t be
            recovered. If the file is new since that commit, or was renamed, the new copy moves to
            the Trash instead.
          </span>
        ) : (
          <span>
            <span className="font-mono text-text-primary break-all">{relativePath}</span> moves to
            the Trash, where you can restore it.
          </span>
        )
      }
      confirmLabel={isDiscard ? "Discard changes" : "Delete file"}
    />
  );
}

export function FileMutationConfirmDialog() {
  const requestSeq = useFileMutationConfirmStore((s) => s.requestSeq);
  return (
    <ErrorBoundary
      variant="component"
      componentName="FileMutationConfirmDialog"
      resetKeys={[requestSeq]}
    >
      <FileMutationConfirmDialogInner />
    </ErrorBoundary>
  );
}
