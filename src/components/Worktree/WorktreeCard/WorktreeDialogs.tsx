import type { WorktreeState } from "@/types";
import type { GitHubIssue } from "@shared/types/github";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { WorktreeDeleteDialog } from "../WorktreeDeleteDialog";
import { IssuePickerDialog } from "../IssuePickerDialog";
import { ReviewHub } from "../ReviewHub/ReviewHub";
import { PlanFileViewer } from "@/components/FileViewer/PlanFileViewer";
import type { ConfirmDialogState } from "./hooks/useWorktreeActions";

export interface WorktreeDialogsProps {
  worktree: WorktreeState;
  confirmDialog: ConfirmDialogState;
  onCloseConfirm: () => void;
  showDeleteDialog: boolean;
  onCloseDeleteDialog: () => void;
  showIssuePicker: boolean;
  onCloseIssuePicker: () => void;
  onAttachIssue: (issue: GitHubIssue) => void;
  onDetachIssue: () => void;
  showReviewHub: boolean;
  onCloseReviewHub: () => void;
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
  showPlanViewer,
  onClosePlanViewer,
}: WorktreeDialogsProps) {
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
      />

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

      <ReviewHub isOpen={showReviewHub} worktreePath={worktree.path} onClose={onCloseReviewHub} />

      <PlanFileViewer
        isOpen={showPlanViewer}
        filePath={worktree.planFilePath}
        rootPath={worktree.path}
        onClose={onClosePlanViewer}
      />
    </>
  );
}
