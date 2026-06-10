import { Suspense, lazy } from "react";
import type { WorktreeState } from "@/types";
import type { Issue } from "@shared/types/forge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { WorktreeDeleteDialog } from "../WorktreeDeleteDialog";
import { IssuePickerDialog } from "../IssuePickerDialog";
import { PlanFileViewer } from "@/components/FileViewer/PlanFileViewer";
import { useKeepMounted } from "@/hooks/useKeepMounted";
import type { ConfirmDialogState } from "./hooks/useWorktreeActions";

// Lazy boundary keeps ReviewHubContent/DiffViewer (~50KB gz) out of App's
// first-paint eval closure — the hub only renders when a card opens it. The
// chunk stays modulepreloaded via the ReviewPane seed, so the null fallback
// covers eval-only time on first open.
const LazyReviewHub = lazy(() =>
  import("../ReviewHub/ReviewHub").then((m) => ({ default: m.ReviewHub }))
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

      <WorktreeDeleteDialog
        isOpen={showDeleteDialog}
        onClose={onCloseDeleteDialog}
        worktree={worktree}
      />

      <IssuePickerDialog
        isOpen={showIssuePicker}
        onClose={onCloseIssuePicker}
        worktree={worktree}
        currentIssueNumber={worktree.issueNumber}
        onAttach={onAttachIssue}
        onDetach={onDetachIssue}
      />

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

      <PlanFileViewer
        isOpen={showPlanViewer}
        filePath={worktree.planFilePath}
        rootPath={worktree.path}
        onClose={onClosePlanViewer}
      />
    </>
  );
}
