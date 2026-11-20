import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { DecisionsDevice } from "@shared/types/decisions";
import { deviceRoleLabel } from "./devicesCopy";
import { hostOf } from "./relayCheckCopy";
import { KITS_AFTER_NEW_KEY } from "./recoveryKitCopy";
import type { UseDecisionsDevicesResult } from "./useDecisionsDevices";

interface DecisionsRotateKeysDialogProps {
  isOpen: boolean;
  relayOrigin: string;
  /** The relay's last list of devices, shared with the Devices and Remote Hosts sections. */
  devicesRead: Pick<UseDecisionsDevicesResult, "devices" | "failure" | "loading">;
  /** Nothing may start now: the switch is changing or another key change runs. */
  unavailable?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Confirms rotating the shared key (#18064). It changes what the relay and
 * every device hold, so the dialog lists the devices the relay last named as
 * getting the new key, and says that recovery kits saved before it don't hold
 * it. The relay's own list at the moment of rotating decides who gets it.
 */
export function DecisionsRotateKeysDialog({
  isOpen,
  relayOrigin,
  devicesRead,
  unavailable = false,
  onCancel,
  onConfirm,
}: DecisionsRotateKeysDialogProps) {
  const host = hostOf(relayOrigin);
  const recipients =
    devicesRead.devices?.filter((device) => device.role !== "owner-desktop") ?? null;
  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onCancel}
      variant="destructive"
      title={`Rotate keys for '${host}'?`}
      description={`Daintree seals a new key to each device the relay lists, and new questions and answers use it; what a device already holds stays readable on it. ${KITS_AFTER_NEW_KEY}`}
      confirmLabel="Rotate keys"
      confirmDisabled={unavailable}
      onConfirm={onConfirm}
    >
      <RecipientPreview recipients={recipients} devicesRead={devicesRead} />
    </ConfirmDialog>
  );
}

function RecipientPreview({
  recipients,
  devicesRead,
}: {
  recipients: DecisionsDevice[] | null;
  devicesRead: DecisionsRotateKeysDialogProps["devicesRead"];
}) {
  // An empty list from a read that has since failed, or is being redone, can't promise no devices.
  const settled = devicesRead.failure === null && !devicesRead.loading;
  if (recipients === null || (recipients.length === 0 && !settled)) {
    return (
      <p className="text-xs text-text-secondary">
        {devicesRead.failure !== null
          ? "The relay's devices couldn't be read, so they aren't listed here. Each device the relay lists as you rotate gets the new key."
          : "Reading the relay's devices…"}
      </p>
    );
  }
  if (recipients.length === 0) {
    return (
      <p className="text-xs text-text-secondary">
        The relay lists no phone, tablet or Remote Host, so only this computer gets the new key.
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <p className="text-xs text-text-secondary">The relay last listed these devices:</p>
      <ul className="space-y-0.5 text-xs text-text-primary">
        {recipients.map((device) => (
          <li key={device.deviceId}>
            {device.label}{" "}
            <span className="text-text-secondary">· {deviceRoleLabel(device.role)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
