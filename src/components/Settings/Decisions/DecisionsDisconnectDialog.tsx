import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { hostOf } from "./relayCheckCopy";

interface DecisionsDisconnectDialogProps {
  isOpen: boolean;
  /** The relay set up here; null when the keys are an unfinished setup's. */
  relayOrigin: string | null;
  disconnecting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Confirms removing this computer's Decisions identity (#16006). The keys
 * can't be got back from this computer afterwards, so the dialog says what
 * goes with them, and that the relay and its data stay as they are.
 */
export function DecisionsDisconnectDialog({
  isOpen,
  relayOrigin,
  disconnecting,
  error,
  onCancel,
  onConfirm,
}: DecisionsDisconnectDialogProps) {
  const host = relayOrigin ? hostOf(relayOrigin) : null;
  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onCancel}
      variant="destructive"
      title={host ? `Disconnect from '${host}'?` : "Remove the unfinished setup's keys?"}
      description={
        host
          ? `This removes this computer's Decisions keys for ${host}. Without a recovery kit for this relay, its past questions and answers can't be read again, and no computer can reconnect to it as its owner. The relay and everything on it stay as they are, and paired phones stay paired.`
          : "This removes the keys of a claim the relay never confirmed. If the relay did receive that claim, only these keys can finish it, and without them it can't be claimed again until it's deployed afresh. Nothing on any relay changes."
      }
      confirmLabel={host ? "Disconnect relay" : "Remove keys"}
      onConfirm={onConfirm}
      isConfirmLoading={disconnecting}
    >
      {error && (
        <p role="alert" className="text-xs text-status-error select-text">
          {error}
        </p>
      )}
    </ConfirmDialog>
  );
}
