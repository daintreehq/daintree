import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext } from "../types.js";
import os from "node:os";
import { store } from "../../store.js";
import { pendingRemoteHostsHandler } from "../../remote/pendingHandler.js";
import { getRemoteService, requireRemoteService } from "../../remote/runtime.js";
import { REMOTE_HOSTS_METHOD_CHANNELS } from "./remoteHosts.preload.js";
import { getLocalHandshakeInfo } from "../../remote/handshakeInfo.js";
import {
  LOCAL_HOST_ID,
  type HostConnectionState,
  type HostDescriptor,
  type HostHandshakeInfo,
  type HostListEntry,
} from "../../../shared/types/remoteHosts.js";
import type {
  AddHostPayload,
  DiscoveredHost,
  HostProbeResult,
  SwitchWindowHostPayload,
  UpdateHostPayload,
  WindowHostInfo,
} from "../../../shared/types/ipc/remoteHosts.js";

/** This machine as a window's host: what a window that never attached anywhere reports. */
function localWindowHost(): WindowHostInfo {
  return {
    hostId: LOCAL_HOST_ID,
    descriptor: null,
    connection: { status: "local" },
    hostPlatform: process.platform as WindowHostInfo["hostPlatform"],
    hostHomeDir: os.homedir(),
    hostTmpDir: os.tmpdir(),
  };
}

/**
 * Whether anything here could make a view on this machine be driven from
 * elsewhere: a configured host, Host mode switched on, or a Host server
 * running for this launch (`--host-mode`). Reads settings and the service
 * table only, so it is safe to ask from every view as it opens.
 */
function remoteHostsInUse(): boolean {
  const hosts = store.get("remoteHosts")?.hosts;
  if (Array.isArray(hosts) && hosts.length > 0) return true;
  if (store.get("hostMode")?.enabled === true) return true;
  return getRemoteService("hostServer") !== undefined;
}

export const remoteHostsNamespace = defineIpcNamespace({
  name: "remoteHosts",
  ops: {
    list: op(
      REMOTE_HOSTS_METHOD_CHANNELS.list,
      async (): Promise<HostListEntry[]> =>
        // Empty until the remote runtime has started.
        getRemoteService("remoteHostsClient")?.list() ?? []
    ),
    add: op(
      REMOTE_HOSTS_METHOD_CHANNELS.add,
      async (payload: AddHostPayload): Promise<HostDescriptor> =>
        requireRemoteService("remoteHostsClient").add(payload)
    ),
    update: op(
      REMOTE_HOSTS_METHOD_CHANNELS.update,
      async (payload: UpdateHostPayload): Promise<HostDescriptor> =>
        requireRemoteService("remoteHostsClient").update(payload)
    ),
    forget: op(
      REMOTE_HOSTS_METHOD_CHANNELS.forget,
      async (payload: { hostId: string }): Promise<void> =>
        requireRemoteService("remoteHostsClient").forget(payload)
    ),
    connect: op(
      REMOTE_HOSTS_METHOD_CHANNELS.connect,
      async (payload: { hostId: string }): Promise<HostConnectionState> =>
        requireRemoteService("remoteHostsClient").connect(payload)
    ),
    disconnect: op(
      REMOTE_HOSTS_METHOD_CHANNELS.disconnect,
      async (payload: { hostId: string }): Promise<void> =>
        requireRemoteService("remoteHostsClient").disconnect(payload)
    ),
    getWindowHost: op(
      REMOTE_HOSTS_METHOD_CHANNELS.getWindowHost,
      async (ctx: IpcContext): Promise<WindowHostInfo> =>
        getRemoteService("remoteHostsClient")?.getWindowHost(ctx) ?? localWindowHost(),
      { withContext: true }
    ),
    switchWindowHost: op(
      REMOTE_HOSTS_METHOD_CHANNELS.switchWindowHost,
      async (ctx: IpcContext, payload: SwitchWindowHostPayload): Promise<void> =>
        requireRemoteService("remoteHostsClient").switchWindowHost(ctx, payload),
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
    isInUse: op(REMOTE_HOSTS_METHOD_CHANNELS.isInUse, (): boolean => remoteHostsInUse()),
    getLocalHandshake: op(REMOTE_HOSTS_METHOD_CHANNELS.getLocalHandshake, (): HostHandshakeInfo =>
      getLocalHandshakeInfo()
    ),
  },
});

export function registerRemoteHostsHandlers(): () => void {
  return remoteHostsNamespace.register();
}
