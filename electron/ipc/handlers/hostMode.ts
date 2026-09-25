import { defineIpcNamespace, op } from "../define.js";
import { pendingRemoteHostsHandler } from "../../remote/pendingHandler.js";
import { HOST_MODE_METHOD_CHANNELS } from "./hostMode.preload.js";
import type { HostModeStatus, SetHostModePayload } from "../../../shared/types/ipc/hostMode.js";

export const hostModeNamespace = defineIpcNamespace({
  name: "hostMode",
  ops: {
    getStatus: op(HOST_MODE_METHOD_CHANNELS.getStatus, async (): Promise<HostModeStatus> =>
      pendingRemoteHostsHandler(HOST_MODE_METHOD_CHANNELS.getStatus)
    ),
    setEnabled: op(
      HOST_MODE_METHOD_CHANNELS.setEnabled,
      async (_payload: SetHostModePayload): Promise<HostModeStatus> =>
        pendingRemoteHostsHandler(HOST_MODE_METHOD_CHANNELS.setEnabled)
    ),
  },
});

export function registerHostModeHandlers(): () => void {
  return hostModeNamespace.register();
}
