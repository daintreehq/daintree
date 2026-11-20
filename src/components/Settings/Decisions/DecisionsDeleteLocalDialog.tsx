import { InlineError } from "@/components/ui/field";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { hostOf } from "./relayCheckCopy";
import { KEYS_GATE_TARGET, NO_CURRENT_KIT, SAVE_KIT_FIRST, onlyCopyPreamble } from "./recoveryKitCopy";

interface DecisionsDeleteLocalDialogProps {
  isOpen: boolean;
  /** The relay set up here; null when none is. */
  relayOrigin: string | null;
  /** This computer holds Decisions keys. */
  keysStored: boolean;
  /** A verified recovery kit holds every key this computer has now (#18064). */
  kitCurrent: boolean;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Confirms deleting this computer's Decisions data (#16025): its stored
 * history, the decision model's (#16026), its keys and its record of the
 * relay. The relay isn't touched, so the body says so, and says what going
 * without the keys means. Keys no current recovery kit holds may be the only
 * copy, so typing the relay's address (or the keys' name, with no relay
 * recorded) is the gate then (#18064).
 */
export function DecisionsDeleteLocalDialog({
  isOpen,
  relayOrigin,
  keysStored,
  kitCurrent,
  deleting,
  error,
  onCancel,
  onConfirm,
}: DecisionsDeleteLocalDialogProps) {
  const host = relayOrigin ? hostOf(relayOrigin) : null;
  const what = keysStored
    ? "This deletes the decision history stored on this computer (questions, answers, the audit log, anything waiting to be delivered and what the decision model learned), its Decisions keys and its record of the relay."
    : "This deletes the decision history stored on this computer (questions, answers, the audit log, anything waiting to be delivered and what the decision model learned) and its record of the relay.";
  const gated = keysStored && !kitCurrent;
  const keys = !keysStored
    ? ""
    : gated
      ? ` ${NO_CURRENT_KIT} Unless another computer holds them, this computer can't reconnect to ${host ?? "the relay"} as its owner afterwards, and the relay's past questions and answers can't be read again.${host ? ` ${SAVE_KIT_FIRST}` : ""}`
      : ` Unless a recovery kit or another computer holds these keys, this computer can't reconnect to ${host ?? "the relay"} as its owner, and the relay's past questions and answers can't be read again.`;
  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onCancel}
      variant="destructive"
      title="Delete this computer's Decisions data?"
      description={`${what} Nothing on ${host ?? "any relay"} changes, and paired devices stay paired.${keys}`}
      typedNameTarget={gated ? (host ?? KEYS_GATE_TARGET) : undefined}
      typedNamePreamble={gated ? onlyCopyPreamble(host) : undefined}
      confirmLabel="Delete local data"
      onConfirm={onConfirm}
      isConfirmLoading={deleting}
    >
      {error && <InlineError role="alert">{error}</InlineError>}
    </ConfirmDialog>
  );
}
