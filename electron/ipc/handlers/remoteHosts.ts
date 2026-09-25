import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext } from "../types.js";
import os from "node:os";
import { store } from "../../store.js";
import { AppError } from "../../utils/errorTypes.js";
import { getRemoteService, requireRemoteService } from "../../remote/runtime.js";
import { REMOTE_HOSTS_METHOD_CHANNELS } from "./remoteHosts.preload.js";
import { getLocalHandshakeInfo } from "../../remote/handshakeInfo.js";
import {
  LOCAL_HOST_ID,
  type HostConnectionState,
  type HostDescriptor,
  type HostHandshakeInfo,
  type HostListEntry,
  isLocalHostId,
  type OperationId,
  type OperationOutcome,
} from "../../../shared/types/remoteHosts.js";
import type {
  AddHostPayload,
  DiscoveredHost,
  HostInstallPlan,
  HostProbeResult,
  HostProjectSummary,
  InstallHostPayload,
  ListHostProjectsPayload,
  InstallHostResult,
  HostPluginClipboardGrant,
  PlanInstallPayload,
  ResetClipboardGrantsPayload,
  SwitchWindowHostPayload,
  UpdateHostPayload,
  WindowHostInfo,
} from "../../../shared/types/ipc/remoteHosts.js";

function requireHostId(payload: unknown): string {
  const hostId = (payload as { hostId?: unknown } | null)?.hostId;
  if (typeof hostId !== "string" || hostId.length === 0) {
    throw new AppError({ code: "VALIDATION", message: "hostId is required" });
  }
  return hostId;
}

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

/**
 * This machine's projects as another window lists them. The store is loaded
 * on first use: its constructor reads app paths at module load.
 */
async function listLocalProjects(): Promise<HostProjectSummary[]> {
  const { projectStore } = await import("../../services/ProjectStore.js");
  return projectStore
    .getAllProjects()
    .map(({ id, name, path, emoji }) => ({ id, name, path, ...(emoji ? { emoji } : {}) }));
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
      requireRemoteService("hostSetup").discover()
    ),
    probe: op(
      REMOTE_HOSTS_METHOD_CHANNELS.probe,
      async (payload: { sshTarget: string }): Promise<HostProbeResult> =>
        requireRemoteService("hostSetup").probe(payload)
    ),
    planInstall: op(
      REMOTE_HOSTS_METHOD_CHANNELS.planInstall,
      async (payload: PlanInstallPayload): Promise<HostInstallPlan> =>
        requireRemoteService("hostSetup").planInstall(payload)
    ),
    install: op(
      REMOTE_HOSTS_METHOD_CHANNELS.install,
      async (payload: InstallHostPayload): Promise<InstallHostResult> =>
        requireRemoteService("hostSetup").install(payload)
    ),
    getInstallStatus: op(
      REMOTE_HOSTS_METHOD_CHANNELS.getInstallStatus,
      async (payload: { opId: OperationId }): Promise<OperationOutcome> =>
        getRemoteService("hostSetup")?.installStatus(payload) ?? { status: "unknown" }
    ),
    cancelInstall: op(
      REMOTE_HOSTS_METHOD_CHANNELS.cancelInstall,
      async (payload: { opId: OperationId }): Promise<boolean> =>
        getRemoteService("hostSetup")?.cancelInstall(payload) ?? false
    ),
    startHostMode: op(
      REMOTE_HOSTS_METHOD_CHANNELS.startHostMode,
      async (payload: { sshTarget: string }): Promise<HostProbeResult> =>
        requireRemoteService("hostSetup").startHostMode(payload)
    ),
    listHostProjects: op(
      REMOTE_HOSTS_METHOD_CHANNELS.listHostProjects,
      async (payload: ListHostProjectsPayload): Promise<HostProjectSummary[]> => {
        const hostId = (payload as Partial<ListHostProjectsPayload> | null)?.hostId;
        if (typeof hostId === "string" && isLocalHostId(hostId)) return listLocalProjects();
        return requireRemoteService("remoteHostsClient").listHostProjects(payload);
      }
    ),
    // This machine's own answers about a host's plugins and its clipboard.
    listClipboardGrants: op(
      REMOTE_HOSTS_METHOD_CHANNELS.listClipboardGrants,
      async (payload: ListHostProjectsPayload): Promise<HostPluginClipboardGrant[]> => {
        const hostId = requireHostId(payload);
        // Loaded lazily behind the raw define so a Windows build drops the module.
        if (__DAINTREE_REMOTE_HOSTS__) {
          const { persistedClipboardGrants } =
            await import("../../remote/plugins/clipboardGrants.js");
          return persistedClipboardGrants.list(hostId);
        }
        return [];
      }
    ),
    resetClipboardGrants: op(
      REMOTE_HOSTS_METHOD_CHANNELS.resetClipboardGrants,
      async (payload: ResetClipboardGrantsPayload): Promise<void> => {
        const pluginId = (payload as Partial<ResetClipboardGrantsPayload> | null)?.pluginId;
        if (pluginId !== undefined && typeof pluginId !== "string") {
          throw new AppError({ code: "VALIDATION", message: "pluginId must be a string" });
        }
        const hostId = requireHostId(payload);
        if (__DAINTREE_REMOTE_HOSTS__) {
          const { persistedClipboardGrants } =
            await import("../../remote/plugins/clipboardGrants.js");
          persistedClipboardGrants.reset(hostId, pluginId);
        }
      }
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
