import { Suspense, lazy } from "react";
import type { WorktreeState } from "@/types";
import type { Issue } from "@shared/types/forge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useKeepMounted } from "@/hooks/useKeepMounted";
import type { ConfirmDialogState } from "./hooks/useWorktreeActions";

const LazyWorktreeDeleteDialog = lazy(() =>
  import("../WorktreeDeleteDialog").then((m) => ({ default: m.WorktreeDeleteDialog }))
);

const LazyIssuePickerDialog = lazy(() =>
  import("../IssuePickerDialog").then((m) => ({ default: m.IssuePickerDialog }))
);

// Lazy boundary keeps ReviewHubContent/DiffViewer (~50KB gz) out of App's
// first-paint eval closure — the hub only renders when a card opens it. The
// chunk stays modulepreloaded via the ReviewPane seed, so the null fallback
// covers eval-only time on first open.
const LazyReviewHub = lazy(() =>
  import("../ReviewHub/ReviewHub").then((m) => ({ default: m.ReviewHub }))
);

// This was the last static path to CodeViewer's CodeMirror closure
// (vendor-editor, ~443KB raw) — lazy keeps it out of the eager entry chunk.
const LazyPlanFileViewer = lazy(() =>
  import("@/components/FileViewer/PlanFileViewer").then((m) => ({ default: m.PlanFileViewer }))
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
  showReviewHub: boolean;
  onCloseReviewHub: () => void;
  reviewHubInitialCommitMessage?: string;
  reviewHubAutoStageOnOpen?: boolean;
  showPlanViewer: boolean;
  onClosePlanViewer: () => void;
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
  showReviewHub,
  onCloseReviewHub,
  reviewHubInitialCommitMessage,
  reviewHubAutoStageOnOpen,
  showPlanViewer,
  onClosePlanViewer,
}: WorktreeDialogsProps) {
  // Keep-mounted is NOT for a close animation (ReviewHub returns null when
  // !isOpen) — it avoids re-suspending on reopen and keeps focus-restore
  // cleanup semantics identical to the previously-static mount.
  const reviewHubMounted = useKeepMounted(showReviewHub);
  const planViewerMounted = useKeepMounted(showPlanViewer);
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

      {reviewHubMounted && (
        <Suspense fallback={null}>
          <LazyReviewHub
            isOpen={showReviewHub}
            worktreePath={worktree.path}
            onClose={onCloseReviewHub}
            initialCommitMessage={reviewHubInitialCommitMessage}
            autoStageOnOpen={reviewHubAutoStageOnOpen}
          />
        </Suspense>
      )}

      {planViewerMounted && (
        <Suspense fallback={null}>
          <LazyPlanFileViewer
            isOpen={showPlanViewer}
            filePath={worktree.planFilePath}
            rootPath={worktree.path}
            onClose={onClosePlanViewer}
          />
        </Suspense>
      )}
    </>
  );
}
