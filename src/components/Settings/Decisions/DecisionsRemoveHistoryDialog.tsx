import { InlineError } from "@/components/ui/field";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

interface DecisionsRemoveHistoryDialogProps {
  isOpen: boolean;
  removing: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Confirms removing this computer's settled questions (#18033): what goes,
 * what a later export holds of them, and everything that stays. Main decides
 * which questions are ready as it removes them, so the outcome gives the count.
 */
export function DecisionsRemoveHistoryDialog({
  isOpen,
  removing,
  error,
  onCancel,
  onConfirm,
}: DecisionsRemoveHistoryDialogProps) {
  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onCancel}
      variant="destructive"
      title="Remove settled questions from this computer?"
      description="This permanently removes the answered, declined, withdrawn, expired and never-sent questions this computer asked from History, with their answers and follow-ups. A later export of the decision history won't include them, though its audit log can still name them. Open questions, stopped deliveries and anything still being sent or typed in stay, and so do the Decisions keys, the relay, enrolled Hosts and their questions, and what the decision model learned. Nothing is sent to the relay or your phones."
      confirmLabel="Remove settled questions"
      onConfirm={onConfirm}
      isConfirmLoading={removing}
    >
      {error && <InlineError role="alert">{error}</InlineError>}
    </ConfirmDialog>
  );
}
