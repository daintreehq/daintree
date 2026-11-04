import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TerminalSnapshotsDisclosure } from "./DecisionsDisclosure";

interface DecisionsTerminalSnapshotsConsentDialogProps {
  isOpen: boolean;
  onCancel: () => void;
  onAccept: () => void;
}

/**
 * Shown each time terminal snapshots are turned on (#16228): they send what
 * is on a screen, which Decisions' own agreement never covered. The switch
 * stays off behind it: only "Turn on snapshots" turns it on.
 */
export function DecisionsTerminalSnapshotsConsentDialog({
  isOpen,
  onCancel,
  onAccept,
}: DecisionsTerminalSnapshotsConsentDialogProps) {
  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onCancel}
      variant="default"
      size="md"
      title="Show terminal snapshots on your phone?"
      description="Your phone can then show what the agent that asked a question was doing. This is what's sent, and when."
      confirmLabel="Turn on snapshots"
      cancelLabel="Cancel"
      onConfirm={onAccept}
    >
      <ul className="space-y-2 text-xs text-text-secondary select-text">
        <li>
          <span className="font-medium text-text-primary">What&apos;s sent, and when.</span>{" "}
          <TerminalSnapshotsDisclosure />
        </li>
        <li>Turning snapshots off stops them at once.</li>
      </ul>
    </ConfirmDialog>
  );
}
