import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { TerminalSnapshotsDisclosure } from "./DecisionsDisclosure";

interface DecisionsTerminalSnapshotsConsentDialogProps {
  isOpen: boolean;
  /** The agreed turn on is being saved: the dialog stays, locked, until main answers. */
  saving?: boolean;
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
  saving = false,
  onCancel,
  onAccept,
}: DecisionsTerminalSnapshotsConsentDialogProps) {
  const showSpinner = useDeferredLoading(saving, UI_DOHERTY_THRESHOLD);
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
      isConfirmLoading={showSpinner}
      isBusy={saving}
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
