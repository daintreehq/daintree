import type { WorktreeState } from "@/types";
import type { GitHubIssue } from "@shared/types/github";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { WorktreeDeleteDialog } from "../WorktreeDeleteDialog";
import { IssuePickerDialog } from "../IssuePickerDialog";
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
}: WorktreeDialogsProps) {
  return (
    <>
      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
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
    </>
  );
}
