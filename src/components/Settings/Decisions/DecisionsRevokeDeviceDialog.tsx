import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { RestoreFocusTarget } from "@/components/ui/AppDialog";
import type { DecisionsDevice } from "@shared/types/decisions";
import { deviceRoleLabel } from "./devicesCopy";

interface DecisionsRevokeDeviceDialogProps {
  /** The device to revoke; null while closed. */
  device: DecisionsDevice | null;
  revoking: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  restoreFocusTo?: RestoreFocusTarget;
}

/**
 * Confirms revoking a paired device (#16010). It names the device, says that
 * the relay gets a new key for the rest, and that what the device already
 * holds can't be recalled. A revocation that didn't finish stays open with
 * what was observed; confirming again sends the same new key.
 */
export function DecisionsRevokeDeviceDialog({
  device,
  revoking,
  error,
  onCancel,
  onConfirm,
  restoreFocusTo,
}: DecisionsRevokeDeviceDialogProps) {
  const label = device?.label ?? "this device";
  return (
    <ConfirmDialog
      isOpen={device !== null}
      onClose={onCancel}
      variant="destructive"
      title={`Revoke '${label}'?`}
      description={`${device ? `${deviceRoleLabel(device.role)} '${label}'` : `'${label}'`} can no longer reach your relay, and the relay gets a new key, sealed to each device that remains, for what's sent from now on. Questions, answers and screenshots already on '${label}' can't be recalled.`}
      confirmLabel="Revoke device"
      onConfirm={onConfirm}
      isConfirmLoading={revoking}
      restoreFocusTo={restoreFocusTo}
    >
      {error && (
        <p role="alert" className="text-xs text-status-error select-text">
          {error}
        </p>
      )}
    </ConfirmDialog>
  );
}
