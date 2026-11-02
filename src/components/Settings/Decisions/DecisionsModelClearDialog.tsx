import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { pluralize } from "@/lib/pluralize";

interface DecisionsModelClearDialogProps {
  isOpen: boolean;
  /** The answers the history holds; null when it isn't open to count. */
  count: number | null;
  learning: boolean;
  clearing: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Confirms clearing what the decision model learned (#16027): its history
 * and its latest evaluation, so it stops answering automatically until it is
 * evaluated again. Decisions' own data and the relay are untouched.
 */
export function DecisionsModelClearDialog({
  isOpen,
  count,
  learning,
  clearing,
  error,
  onCancel,
  onConfirm,
}: DecisionsModelClearDialogProps) {
  const what =
    count === null
      ? "the answers the decision model learned"
      : `the ${pluralize(count, "answer")} the decision model learned`;
  const after = learning
    ? "Learning stays on, and answers you give from now on start a new history."
    : "Learning stays off.";
  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onCancel}
      variant="destructive"
      title="Clear the decision model's history?"
      description={`This deletes ${what} and its latest evaluation from this computer, so it answers nothing automatically until it's evaluated again. ${after} Decisions' own history and the relay don't change.`}
      confirmLabel="Clear history"
      onConfirm={onConfirm}
      isConfirmLoading={clearing}
    >
      {error && (
        <p role="alert" className="text-xs text-status-error select-text">
          {error}
        </p>
      )}
    </ConfirmDialog>
  );
}
