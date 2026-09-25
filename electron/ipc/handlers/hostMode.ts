import { z } from "zod";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import { getRemoteService, requireRemoteService } from "../../remote/runtime.js";
import { HOST_MODE_METHOD_CHANNELS } from "./hostMode.preload.js";
import type { HostModeStatus, SetHostModePayload } from "../../../shared/types/ipc/hostMode.js";

/** What a machine whose remote runtime never started reports: nothing is listening. */
function notRunningStatus(): HostModeStatus {
  return {
    supported: false,
    enabled: false,
    startAtLogin: false,
    socketPath: null,
    listening: false,
    attachedClients: [],
    rows: [],
  };
}

// Start at login is consent: only an explicit boolean from the renderer counts.
const setEnabledSchema = z
  .object({ enabled: z.boolean(), startAtLogin: z.boolean().optional() })
  .strict();

export const hostModeNamespace = defineIpcNamespace({
  name: "hostMode",
  ops: {
    getStatus: op(
      HOST_MODE_METHOD_CHANNELS.getStatus,
      async (): Promise<HostModeStatus> =>
        (await getRemoteService("hostMode")?.getStatus()) ?? notRunningStatus()
    ),
    setEnabled: opValidated(
      HOST_MODE_METHOD_CHANNELS.setEnabled,
      setEnabledSchema,
      async (payload: SetHostModePayload): Promise<HostModeStatus> =>
        requireRemoteService("hostMode").setEnabled(payload)
    ),
    runKeychainPreflight: op(
      HOST_MODE_METHOD_CHANNELS.runKeychainPreflight,
      async (): Promise<HostModeStatus> => requireRemoteService("hostMode").runKeychainPreflight()
    ),
  },
});

export function registerHostModeHandlers(): () => void {
  return hostModeNamespace.register();
}
