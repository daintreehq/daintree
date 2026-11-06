import { useState } from "react";
import type { DecisionsStatus } from "@shared/types/decisions";
import { DecisionsDevicesSection } from "./DecisionsDevicesSection";
import { currentRotateButton, DecisionsEncryptionSection } from "./DecisionsEncryptionSection";
import { DecisionsHostsSection } from "./DecisionsHostsSection";
import { DecisionsRevokeDeviceDialog } from "./DecisionsRevokeDeviceDialog";
import { useDecisionsDevices } from "./useDecisionsDevices";
import { type DecisionsRevokeTarget, useDecisionsKeyActions } from "./useDecisionsKeyActions";

/**
 * Devices, Remote Hosts and Encryption (#16222): what a person answers from,
 * the machines whose agents ask, and the key both hold. They share one read
 * of the relay's devices, one key change at a time and one revoke
 * confirmation, since revoking a phone or a Host is the same key rotation
 * (#16010, #16021). The list is read again on Refresh, after a pairing or a
 * key change, when main says the devices changed, when the window regains
 * focus, and when the set of enrolled Hosts changes.
 */
export function DecisionsDevicesAndHosts({
  status,
  locked = false,
  pairFocusRequest = 0,
  onPairFocused,
}: {
  status: DecisionsStatus;
  /** The switch is changing, so nothing here should start. */
  locked?: boolean;
  /** Above zero, and bumped, to land on Pair a phone once it shows (#16200). */
  pairFocusRequest?: number;
  /** The request was met, so a later mount doesn't take focus again. */
  onPairFocused?: () => void;
}) {
  const relaySetUp = status.relayOrigin !== undefined;
  const devicesRead = useDecisionsDevices(relaySetUp);
  const keyActions = useDecisionsKeyActions(devicesRead.reload);
  const [revokeTarget, setRevokeTarget] = useState<DecisionsRevokeTarget | null>(null);
  const [revokeFinished, setRevokeFinished] = useState(false);
  const actionsLocked = locked || keyActions.pending !== null;

  const askToRevoke = (target: DecisionsRevokeTarget) => {
    keyActions.clearRevokeError();
    setRevokeFinished(false);
    setRevokeTarget(target);
  };

  const confirmRevoke = () => {
    if (!revokeTarget) return;
    void keyActions.revoke(revokeTarget).then((finished) => {
      if (!finished) return;
      setRevokeFinished(true);
      setRevokeTarget(null);
    });
  };

  return (
    <>
      <DecisionsDevicesSection
        relaySetUp={relaySetUp}
        read={devicesRead}
        locked={locked}
        actionsLocked={actionsLocked}
        onRevoke={askToRevoke}
        pairFocusRequest={pairFocusRequest}
        onPairFocused={onPairFocused}
      />
      <DecisionsHostsSection
        enabled={relaySetUp}
        revision={status.revision ?? 0}
        devicesRead={devicesRead}
        locked={locked}
        actionsLocked={actionsLocked}
        onRevoke={askToRevoke}
        onEnrolledChange={devicesRead.reload}
      />
      {relaySetUp && <DecisionsEncryptionSection keyActions={keyActions} locked={locked} />}
      <DecisionsRevokeDeviceDialog
        device={revokeTarget}
        revoking={keyActions.pending === "revoke"}
        error={keyActions.revokeError}
        onCancel={() => {
          if (keyActions.pending !== "revoke") setRevokeTarget(null);
        }}
        onConfirm={confirmRevoke}
        restoreFocusTo={currentRotateButton}
        revoked={revokeFinished}
      />
    </>
  );
}
