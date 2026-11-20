import { InlineError } from "@/components/ui/field";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { RestoreFocusTarget } from "@/components/ui/AppDialog";
import { hostOf } from "./relayCheckCopy";
import { KEYS_GATE_TARGET, NO_CURRENT_KIT, SAVE_KIT_FIRST, onlyCopyPreamble } from "./recoveryKitCopy";

interface DecisionsDisconnectDialogProps {
  isOpen: boolean;
  /** The relay set up here; null when the keys are an unfinished setup's. */
  relayOrigin: string | null;
  /** A verified recovery kit holds every key this computer has now (#18064). */
  kitCurrent: boolean;
  disconnecting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  /** Where focus goes once a disconnect has taken its own button away. */
  restoreFocusTo?: RestoreFocusTarget;
}

/**
 * Confirms removing this computer's Decisions identity (#16006). The keys
 * can't be got back from this computer afterwards, so the dialog says what
 * goes with them, and that the relay and its data stay as they are. With no
 * current recovery kit they may be the only copy, so typing the relay's
 * address (or, for an unfinished setup's keys, their name) is the gate
 * (#18064); with one, a click is enough.
 */
export function DecisionsDisconnectDialog({
  isOpen,
  relayOrigin,
  kitCurrent,
  disconnecting,
  error,
  onCancel,
  onConfirm,
  restoreFocusTo,
}: DecisionsDisconnectDialogProps) {
  const host = relayOrigin ? hostOf(relayOrigin) : null;
  // A kit can only be verified for a recorded relay, so unfinished setup's keys are never covered.
  const gated = host === null || !kitCurrent;
  const stays = "The relay and everything on it stay as they are, and paired phones stay paired.";
  const description = host
    ? gated
      ? `${NO_CURRENT_KIT} Unless another computer holds this identity, disconnecting leaves ${host}'s past questions and answers unreadable, and nobody can reconnect to it as its owner. ${stays} ${SAVE_KIT_FIRST}`
      : `This removes this computer's Decisions keys for ${host}. To connect it again, this computer needs a recovery kit for the relay; if no kit or other computer holds this identity, the relay's past questions and answers can't be read again and nobody can reconnect to it as its owner. ${stays}`
    : "No relay is recorded for these keys. If they're the only copy of a relay's owner keys (a claim that wasn't confirmed, or a setup whose settings didn't save), that relay can't be reconnected to as its owner without a recovery kit, or claimed again until it's deployed afresh. Nothing on any relay changes.";
  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onCancel}
      variant="destructive"
      title={host ? `Disconnect from '${host}'?` : "Remove the Decisions keys on this computer?"}
      description={description}
      typedNameTarget={gated ? (host ?? KEYS_GATE_TARGET) : undefined}
      typedNamePreamble={gated ? onlyCopyPreamble(host) : undefined}
      confirmLabel={host ? "Disconnect relay" : "Remove keys"}
      onConfirm={onConfirm}
      isConfirmLoading={disconnecting}
      restoreFocusTo={restoreFocusTo}
    >
      {error && <InlineError role="alert">{error}</InlineError>}
    </ConfirmDialog>
  );
}
