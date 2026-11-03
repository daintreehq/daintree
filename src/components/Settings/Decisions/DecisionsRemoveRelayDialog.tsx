import { useId } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Checkbox } from "@/components/ui/checkbox";
import { hostOf } from "./relayCheckCopy";

interface DecisionsRemoveRelayDialogProps {
  isOpen: boolean;
  relayOrigin: string;
  /** It's the relay recorded on this computer, so finishing forgets it here too. */
  recorded: boolean;
  deleteLocalHistory: boolean;
  onDeleteLocalHistoryChange: (value: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Confirms a guided removal of the relay from Cloudflare (#16202). Nothing is
 * deleted here: continuing opens a terminal running the CLI's removal, which
 * lists what it found and asks for the Worker's name and a yes before it
 * deletes anything. The body says what goes, and what becomes of this
 * computer's record once it has.
 */
export function DecisionsRemoveRelayDialog({
  isOpen,
  relayOrigin,
  recorded,
  deleteLocalHistory,
  onDeleteLocalHistoryChange,
  onCancel,
  onConfirm,
}: DecisionsRemoveRelayDialogProps) {
  const host = hostOf(relayOrigin);
  const checkboxId = useId();
  const detailId = useId();
  const here = recorded
    ? " When it finishes, Daintree forgets the relay and removes its keys on this computer, so a new relay can be set up straight away."
    : " Nothing on this computer changes.";
  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onCancel}
      variant="destructive"
      title={`Remove '${host}' from Cloudflare?`}
      description={`This deletes the relay's Worker, the questions, answers and attachments it stores, and its R2 bucket from your Cloudflare account. Every phone paired with it stops working, and this can't be undone. Continuing opens a terminal running the guided removal, which lists what it found and asks you to type the Worker's name before it deletes anything.${here}`}
      confirmLabel="Open guided removal"
      onConfirm={onConfirm}
    >
      {recorded && (
        <div className="flex items-start gap-2">
          <Checkbox
            id={checkboxId}
            size="sm"
            checked={deleteLocalHistory}
            onCheckedChange={(value) => onDeleteLocalHistoryChange(value === true)}
            aria-describedby={detailId}
            className="mt-0.5"
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <label htmlFor={checkboxId} className="w-fit text-xs text-text-primary">
              Also delete this computer's decision history
            </label>
            <span id={detailId} className="text-2xs text-text-secondary">
              Its questions, answers, audit log, anything waiting to be delivered and what the
              decision model learned. History you keep stays tied to this relay, so a new relay
              won't connect until it's deleted: export it first to keep a copy.
            </span>
          </span>
        </div>
      )}
    </ConfirmDialog>
  );
}
