import { InlineError } from "@/components/ui/field";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { RestoreFocusTarget } from "@/components/ui/AppDialog";
import { deviceRoleLabel } from "./devicesCopy";
import type { DecisionsRevokeTarget } from "./useDecisionsKeyActions";

interface DecisionsRevokeDeviceDialogProps {
  /** The device to revoke, a phone or a Remote Host; null while closed. */
  device: DecisionsRevokeTarget | null;
  revoking: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  restoreFocusTo?: RestoreFocusTarget;
  /** The revocation finished, so its row is going: focus goes to `restoreFocusTo` rather than back to it. */
  revoked?: boolean;
}

/**
 * Confirms revoking a paired device (#16010). It names the device, says that
 * the relay gets a new key for the rest, and that what the device already
 * holds can't be recalled. A Host this computer recorded enrolling also
 * hears that it isn't enrolled automatically again (#16021); one only the
 * relay lists has no record here to keep that. A revocation that didn't
 * finish stays open with what was observed; confirming again sends the same
 * new key.
 */
export function DecisionsRevokeDeviceDialog({
  device,
  revoking,
  error,
  onCancel,
  onConfirm,
  restoreFocusTo,
  revoked = false,
}: DecisionsRevokeDeviceDialogProps) {
  const label = device?.label ?? "this device";
  return (
    <ConfirmDialog
      isOpen={device !== null}
      onClose={onCancel}
      variant="destructive"
      title={`Revoke '${label}'?`}
      description={`${device ? `${deviceRoleLabel(device.role)} '${label}'` : `'${label}'`} can no longer reach your relay, and Daintree seals a new key to each device that remains. Questions, answers and screenshots already on '${label}' can't be recalled.${device?.recordedHost ? " It isn't enrolled automatically again; Enroll does that while this computer is connected to it." : ""}`}
      confirmLabel="Revoke device"
      onConfirm={onConfirm}
      isConfirmLoading={revoking}
      restoreFocusTo={restoreFocusTo}
      preferRestoreFocusTo={revoked}
    >
      {error && <InlineError role="alert">{error}</InlineError>}
    </ConfirmDialog>
  );
}
