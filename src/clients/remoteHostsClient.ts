import type {
  HostConnection,
  HostConnectionState,
  HostDescriptor,
  HostListEntry,
  OperationId,
  OperationOutcome,
} from "@shared/types/remoteHosts";
import type {
  AddHostPayload,
  DiscoveredHost,
  HostInstallPlan,
  HostProbeResult,
  InstallHostPayload,
  InstallHostResult,
  HostPluginClipboardGrant,
  PluginViewConsentEntry,
  PlanInstallPayload,
  RemoteHostsEvent,
  StartHostModeResult,
  UpdateHostPayload,
} from "@shared/types/ipc/remoteHosts";

/**
 * How long a connect waits to report what happened. A host whose Daintree is
 * being started gets longer in main; past this the caller says it is still
 * connecting, which is what the link reports.
 */
const CONNECT_SETTLE_MS = 30_000;

/**
 * Dial a host and resolve with the first state the link reports that isn't
 * still connecting: connected, unreachable (with Host mode off or ssh's own
 * detail), a mismatched build, or driven from elsewhere. `connect` itself only
 * starts the dial and answers at once, so its failures never reject.
 */
function connectAndSettle(
  hostId: string,
  timeoutMs = CONNECT_SETTLE_MS
): Promise<HostConnectionState> {
  const api = window.electron.remoteHosts;
  return new Promise<HostConnectionState>((resolve, reject) => {
    let latest: HostConnectionState = { status: "connecting", attempt: 1 };
    let off: () => void = () => {};
    const timer = setTimeout(() => finish(latest), timeoutMs);
    const finish = (state: HostConnectionState) => {
      clearTimeout(timer);
      off();
      resolve(state);
    };
    const observe = (state: HostConnectionState) => {
      latest = state;
      if (state.status !== "connecting") finish(state);
    };
    // Listening before dialling: a refusal can arrive before `connect` answers.
    off = api.onEvent((event) => {
      if (event.type === "connection-changed" && event.hostId === hostId) observe(event.connection);
    });
    api.connect({ hostId }).then(
      (state) => {
        if (latest.status === "connecting") observe(state);
      },
      (error: unknown) => {
        clearTimeout(timer);
        off();
        reject(error);
      }
    );
  });
}

/** This machine's host list and the Add host flow. Only called where Remote Hosts is supported. */
export const remoteHostsClient = {
  list: (): Promise<HostListEntry[]> => window.electron.remoteHosts.list(),
  add: (payload: AddHostPayload): Promise<HostDescriptor> =>
    window.electron.remoteHosts.add(payload),
  update: (payload: UpdateHostPayload): Promise<HostDescriptor> =>
    window.electron.remoteHosts.update(payload),
  forget: (hostId: string): Promise<void> => window.electron.remoteHosts.forget({ hostId }),
  connect: (hostId: string) => window.electron.remoteHosts.connect({ hostId }),
  connectAndSettle,
  disconnect: (hostId: string): Promise<void> => window.electron.remoteHosts.disconnect({ hostId }),
  discover: (): Promise<DiscoveredHost[]> => window.electron.remoteHosts.discover(),
  probe: (connection: HostConnection): Promise<HostProbeResult> =>
    window.electron.remoteHosts.probe({ connection }),
  planInstall: (payload: PlanInstallPayload): Promise<HostInstallPlan> =>
    window.electron.remoteHosts.planInstall(payload),
  install: (payload: InstallHostPayload): Promise<InstallHostResult> =>
    window.electron.remoteHosts.install(payload),
  getInstallStatus: (opId: OperationId): Promise<OperationOutcome> =>
    window.electron.remoteHosts.getInstallStatus({ opId }),
  cancelInstall: (opId: OperationId): Promise<boolean> =>
    window.electron.remoteHosts.cancelInstall({ opId }),
  startHostMode: (connection: HostConnection): Promise<StartHostModeResult> =>
    window.electron.remoteHosts.startHostMode({ connection }),
  listClipboardGrants: (hostId: string): Promise<HostPluginClipboardGrant[]> =>
    window.electron.remoteHosts.listClipboardGrants({ hostId }),
  resetClipboardGrants: (hostId: string, pluginId?: string): Promise<void> =>
    window.electron.remoteHosts.resetClipboardGrants(
      pluginId === undefined ? { hostId } : { hostId, pluginId }
    ),
  listPluginViewConsents: (hostId: string): Promise<PluginViewConsentEntry[]> =>
    window.electron.remoteHosts.listPluginViewConsents({ hostId }),
  preparePluginView: (url: string): Promise<boolean> =>
    window.electron.remoteHosts.preparePluginView({ url }),
  resetPluginViewConsent: (hostId: string, pluginId?: string): Promise<void> =>
    window.electron.remoteHosts.resetPluginViewConsent(
      pluginId === undefined ? { hostId } : { hostId, pluginId }
    ),
  onEvent: (callback: (event: RemoteHostsEvent) => void): (() => void) =>
    window.electron.remoteHosts.onEvent(callback),
};
