import type { WorktreeState } from "@/types";
import { ConfirmDialog } from "@/components/Terminal/ConfirmDialog";
import { WorktreeDeleteDialog } from "../WorktreeDeleteDialog";
import type { ConfirmDialogState } from "./hooks/useWorktreeActions";

export interface WorktreeDialogsProps {
  worktree: WorktreeState;
  confirmDialog: ConfirmDialogState;
  onCloseConfirm: () => void;
  showDeleteDialog: boolean;
  onCloseDeleteDialog: () => void;
}

export function WorktreeDialogs({
  worktree,
  confirmDialog,
  onCloseConfirm,
  showDeleteDialog,
  onCloseDeleteDialog,
}: WorktreeDialogsProps) {
  return (
    <>
      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        onCancel={onCloseConfirm}
      />

      <WorktreeDeleteDialog
        isOpen={showDeleteDialog}
        onClose={onCloseDeleteDialog}
        worktree={worktree}
      />
    </>
  );
}
