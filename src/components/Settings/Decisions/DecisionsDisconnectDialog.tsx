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
      title={host ? `Disconnect from '${host}'?` : "Remove the Decisions keys on this computer?"}
      description={
        host
          ? `This removes this computer's Decisions keys for ${host}. To connect it again, this computer needs a recovery kit for the relay; if no kit or other computer holds this identity, the relay's past questions and answers can't be read again and nobody can reconnect to it as its owner. The relay and everything on it stay as they are, and paired phones stay paired.`
          : "No relay is recorded for these keys. If they're the only copy of a relay's owner keys (a claim that wasn't confirmed, or a setup whose settings didn't save), that relay can't be reconnected to as its owner without a recovery kit, or claimed again until it's deployed afresh. Nothing on any relay changes."
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
