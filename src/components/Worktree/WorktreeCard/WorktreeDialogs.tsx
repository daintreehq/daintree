import { Suspense, lazy } from "react";
import type { WorktreeState } from "@/types";
import type { Issue } from "@shared/types/forge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useKeepMounted } from "@/hooks/useKeepMounted";
import type { ConfirmDialogState } from "./hooks/useWorktreeActions";
import type { RestoreFocusTarget } from "@/components/ui/AppDialog";
import { EditWorktreeTitleDialog } from "./EditWorktreeTitleDialog";

const LazyWorktreeDeleteDialog = lazy(() =>
  import("../WorktreeDeleteDialog").then((m) => ({ default: m.WorktreeDeleteDialog }))
);

const LazyIssuePickerDialog = lazy(() =>
  import("../IssuePickerDialog").then((m) => ({ default: m.IssuePickerDialog }))
);

export interface WorktreeDialogsProps {
  worktree: WorktreeState;
  confirmDialog: ConfirmDialogState;
  onCloseConfirm: () => void;
  showDeleteDialog: boolean;
  onCloseDeleteDialog: () => void;
  showIssuePicker: boolean;
  onCloseIssuePicker: () => void;
  onAttachIssue: (issue: Issue) => void;
  onDetachIssue: () => void;
  showTitleDialog: boolean;
  onCloseTitleDialog: () => void;
  customTitle: string | undefined;
  restoreTitleDialogFocusTo?: RestoreFocusTarget;
}

export function WorktreeDialogs({
  worktree,
  confirmDialog,
  onCloseConfirm,
  showDeleteDialog,
  onCloseDeleteDialog,
  showIssuePicker,
  onCloseIssuePicker,
  onAttachIssue,
  onDetachIssue,
  showTitleDialog,
  onCloseTitleDialog,
  customTitle,
  restoreTitleDialogFocusTo,
}: WorktreeDialogsProps) {
  // Keep-mounted is NOT for a close animation — it avoids re-suspending on
  // reopen of a lazily-loaded dialog.
  const deleteDialogMounted = useKeepMounted(showDeleteDialog);
  const issuePickerMounted = useKeepMounted(showIssuePicker);
  return (
    <>
      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        title={confirmDialog.isOpen ? confirmDialog.title : ""}
        description={confirmDialog.isOpen ? confirmDialog.description : undefined}
        confirmLabel={confirmDialog.isOpen ? confirmDialog.confirmLabel : ""}
        variant={confirmDialog.isOpen ? confirmDialog.variant : "default"}
        onConfirm={confirmDialog.isOpen ? confirmDialog.onConfirm : () => {}}
        onClose={onCloseConfirm}
      >
        {confirmDialog.isOpen ? confirmDialog.children : undefined}
      </ConfirmDialog>

      <EditWorktreeTitleDialog
        isOpen={showTitleDialog}
        onClose={onCloseTitleDialog}
        worktreeId={worktree.id}
        currentTitle={customTitle}
        restoreFocusTo={restoreTitleDialogFocusTo}
      />

      {deleteDialogMounted && (
        <Suspense fallback={null}>
          <LazyWorktreeDeleteDialog
            isOpen={showDeleteDialog}
            onClose={onCloseDeleteDialog}
            worktree={worktree}
          />
        </Suspense>
      )}

      {issuePickerMounted && (
        <Suspense fallback={null}>
          <LazyIssuePickerDialog
            isOpen={showIssuePicker}
            onClose={onCloseIssuePicker}
            worktree={worktree}
            currentIssueNumber={worktree.issueNumber}
            onAttach={onAttachIssue}
            onDetach={onDetachIssue}
          />
        </Suspense>
      )}
    </>
  );
}
