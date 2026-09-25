import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext } from "../types.js";
import { pendingRemoteHostsHandler } from "../../remote/pendingHandler.js";
import { REMOTE_HOSTS_METHOD_CHANNELS } from "./remoteHosts.preload.js";
import { getLocalHandshakeInfo } from "../../remote/handshakeInfo.js";
import type {
  HostConnectionState,
  HostDescriptor,
  HostHandshakeInfo,
  HostListEntry,
} from "../../../shared/types/remoteHosts.js";
import type {
  AddHostPayload,
  DiscoveredHost,
  HostProbeResult,
  SwitchWindowHostPayload,
  UpdateHostPayload,
  WindowHostInfo,
} from "../../../shared/types/ipc/remoteHosts.js";

export const remoteHostsNamespace = defineIpcNamespace({
  name: "remoteHosts",
  ops: {
    list: op(REMOTE_HOSTS_METHOD_CHANNELS.list, async (): Promise<HostListEntry[]> =>
      pendingRemoteHostsHandler(REMOTE_HOSTS_METHOD_CHANNELS.list)
    ),
    add: op(
      REMOTE_HOSTS_METHOD_CHANNELS.add,
      async (_payload: AddHostPayload): Promise<HostDescriptor> =>
        pendingRemoteHostsHandler(REMOTE_HOSTS_METHOD_CHANNELS.add)
    ),
    update: op(
      REMOTE_HOSTS_METHOD_CHANNELS.update,
      async (_payload: UpdateHostPayload): Promise<HostDescriptor> =>
        pendingRemoteHostsHandler(REMOTE_HOSTS_METHOD_CHANNELS.update)
    ),
    forget: op(
      REMOTE_HOSTS_METHOD_CHANNELS.forget,
      async (_payload: { hostId: string }): Promise<void> =>
        pendingRemoteHostsHandler(REMOTE_HOSTS_METHOD_CHANNELS.forget)
    ),
    connect: op(
      REMOTE_HOSTS_METHOD_CHANNELS.connect,
      async (_payload: { hostId: string }): Promise<HostConnectionState> =>
        pendingRemoteHostsHandler(REMOTE_HOSTS_METHOD_CHANNELS.connect)
    ),
    disconnect: op(
      REMOTE_HOSTS_METHOD_CHANNELS.disconnect,
      async (_payload: { hostId: string }): Promise<void> =>
        pendingRemoteHostsHandler(REMOTE_HOSTS_METHOD_CHANNELS.disconnect)
    ),
    getWindowHost: op(
      REMOTE_HOSTS_METHOD_CHANNELS.getWindowHost,
      async (_ctx: IpcContext): Promise<WindowHostInfo> =>
        pendingRemoteHostsHandler(REMOTE_HOSTS_METHOD_CHANNELS.getWindowHost),
      { withContext: true }
    ),
    switchWindowHost: op(
      REMOTE_HOSTS_METHOD_CHANNELS.switchWindowHost,
      async (_ctx: IpcContext, _payload: SwitchWindowHostPayload): Promise<void> =>
        pendingRemoteHostsHandler(REMOTE_HOSTS_METHOD_CHANNELS.switchWindowHost),
      { withContext: true }
    ),
    discover: op(REMOTE_HOSTS_METHOD_CHANNELS.discover, async (): Promise<DiscoveredHost[]> =>
      pendingRemoteHostsHandler(REMOTE_HOSTS_METHOD_CHANNELS.discover)
    ),
    probe: op(
      REMOTE_HOSTS_METHOD_CHANNELS.probe,
      async (_payload: { sshTarget: string }): Promise<HostProbeResult> =>
        pendingRemoteHostsHandler(REMOTE_HOSTS_METHOD_CHANNELS.probe)
    ),
    getLocalHandshake: op(REMOTE_HOSTS_METHOD_CHANNELS.getLocalHandshake, (): HostHandshakeInfo =>
      getLocalHandshakeInfo()
    ),
  },
});

export function registerRemoteHostsHandlers(): () => void {
  return remoteHostsNamespace.register();
}
