import { InlineError } from "@/components/ui/field";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { hostOf } from "./relayCheckCopy";

interface DecisionsDeleteRelayDialogProps {
  isOpen: boolean;
  relayOrigin: string;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Confirms deleting the relay's stored content (#16025). Typing the relay's
 * host is the gate, since nothing brings the content back. The body says
 * what goes and, as plainly, what stays.
 */
export function DecisionsDeleteRelayDialog({
  isOpen,
  relayOrigin,
  deleting,
  error,
  onCancel,
  onConfirm,
}: DecisionsDeleteRelayDialogProps) {
  const host = hostOf(relayOrigin);
  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onCancel}
      variant="destructive"
      title={`Delete the data stored on '${host}'?`}
      description={`This permanently deletes every question, answer and attachment ${host} stores, and questions still waiting there can no longer be answered. What stays: the Worker itself in your Cloudflare account, its owner and paired devices, anything already on those devices, and the history stored on this computer.`}
      typedNameTarget={host}
      typedNamePreamble="Type the relay's address to confirm"
      confirmLabel="Delete relay data"
      onConfirm={onConfirm}
      isConfirmLoading={deleting}
    >
      {error && <InlineError role="alert">{error}</InlineError>}
    </ConfirmDialog>
  );
}
