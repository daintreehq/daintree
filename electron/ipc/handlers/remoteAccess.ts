import { z } from "zod";
import { app } from "electron";
import {
  RemoteCapabilitiesSchema,
  type RemoteAccessConfigPatch,
  type RemoteAccessSnapshot,
  type RemotePairingWindow,
} from "../../../shared/types/remote/index.js";
import { store } from "../../store.js";
import { getRemoteRuntime, initializeRemoteGateway } from "../../services/remote/index.js";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import { REMOTE_ACCESS_METHOD_CHANNELS } from "./remoteAccess.preload.js";

const CONFIG_PATCH_SCHEMA = z.strictObject({
  enabled: z.boolean().optional(),
  bindAddress: z.string().min(1).max(255).optional(),
  discoveryEnabled: z.boolean().optional(),
  displayName: z.string().trim().min(1).max(63).optional(),
});
const PAIRING_ID_SCHEMA = z.strictObject({ pairingId: z.string().min(1).max(128) });
const PAIRING_APPROVAL_SCHEMA = PAIRING_ID_SCHEMA.extend({
  capabilities: RemoteCapabilitiesSchema,
});
const DEVICE_ID_SCHEMA = z.strictObject({ deviceId: z.string().min(1).max(128) });
const DEVICE_CAPABILITIES_SCHEMA = DEVICE_ID_SCHEMA.extend({
  capabilities: RemoteCapabilitiesSchema,
});
const REVOKE_DEVICE_SCHEMA = DEVICE_ID_SCHEMA.extend({
  reason: z.string().trim().min(1).max(256),
});

async function management() {
  const runtime =
    getRemoteRuntime() ??
    (await initializeRemoteGateway(store.get("remoteAccess"), app.getVersion()));
  return runtime.management;
}

export const remoteAccessNamespace = defineIpcNamespace({
  name: "remoteAccess",
  ops: {
    getState: op(REMOTE_ACCESS_METHOD_CHANNELS.getState, async (): Promise<RemoteAccessSnapshot> =>
      (await management()).snapshot()
    ),
    updateConfig: opValidated(
      REMOTE_ACCESS_METHOD_CHANNELS.updateConfig,
      CONFIG_PATCH_SCHEMA,
      async (patch: RemoteAccessConfigPatch): Promise<RemoteAccessSnapshot> =>
        (await management()).updateConfig(patch)
    ),
    openPairingWindow: op(
      REMOTE_ACCESS_METHOD_CHANNELS.openPairingWindow,
      async (): Promise<RemotePairingWindow> => (await management()).openPairingWindow()
    ),
    approvePairing: opValidated(
      REMOTE_ACCESS_METHOD_CHANNELS.approvePairing,
      PAIRING_APPROVAL_SCHEMA,
      async ({ pairingId, capabilities }): Promise<RemoteAccessSnapshot> =>
        (await management()).approvePairing(pairingId, capabilities)
    ),
    rejectPairing: opValidated(
      REMOTE_ACCESS_METHOD_CHANNELS.rejectPairing,
      PAIRING_ID_SCHEMA,
      async ({ pairingId }): Promise<RemoteAccessSnapshot> =>
        (await management()).rejectPairing(pairingId)
    ),
    setDeviceCapabilities: opValidated(
      REMOTE_ACCESS_METHOD_CHANNELS.setDeviceCapabilities,
      DEVICE_CAPABILITIES_SCHEMA,
      async ({ deviceId, capabilities }): Promise<RemoteAccessSnapshot> =>
        (await management()).setDeviceCapabilities(deviceId, capabilities)
    ),
    disconnectDevice: opValidated(
      REMOTE_ACCESS_METHOD_CHANNELS.disconnectDevice,
      DEVICE_ID_SCHEMA,
      async ({ deviceId }): Promise<RemoteAccessSnapshot> =>
        (await management()).disconnectDevice(deviceId)
    ),
    disconnectAllDevices: op(
      REMOTE_ACCESS_METHOD_CHANNELS.disconnectAllDevices,
      async (): Promise<RemoteAccessSnapshot> => (await management()).disconnectAllDevices()
    ),
    revokeDevice: opValidated(
      REMOTE_ACCESS_METHOD_CHANNELS.revokeDevice,
      REVOKE_DEVICE_SCHEMA,
      async ({ deviceId, reason }): Promise<RemoteAccessSnapshot> =>
        (await management()).revokeDevice(deviceId, reason)
    ),
  },
});

export function registerRemoteAccessHandlers(): () => void {
  return remoteAccessNamespace.register();
}
