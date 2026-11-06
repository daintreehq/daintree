import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DecisionsDisclosure } from "./DecisionsDisclosure";

interface DecisionsConsentDialogProps {
  isOpen: boolean;
  onCancel: () => void;
  onAccept: () => void;
}

/**
 * Shown the first time Decisions is turned on. The switch stays off behind
 * it: only "Turn on Decisions" turns it on, and Cancel, Escape or the close
 * button leave everything as it was.
 */
export function DecisionsConsentDialog({
  isOpen,
  onCancel,
  onAccept,
}: DecisionsConsentDialogProps) {
  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onCancel}
      variant="default"
      size="md"
      title="Turn on Decisions?"
      description="Nothing is sent until you connect a relay. From then on, this is what Decisions sends and where it goes. Daintree runs no server for it."
      confirmLabel="Turn on Decisions"
      cancelLabel="Cancel"
      onConfirm={onAccept}
    >
      <DecisionsDisclosure />
    </ConfirmDialog>
  );
}
