import type {
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
  PlanInstallPayload,
  RemoteHostsEvent,
  UpdateHostPayload,
} from "@shared/types/ipc/remoteHosts";

/** This machine's host list and the Add host flow. Only called where Remote Hosts is supported. */
export const remoteHostsClient = {
  list: (): Promise<HostListEntry[]> => window.electron.remoteHosts.list(),
  add: (payload: AddHostPayload): Promise<HostDescriptor> =>
    window.electron.remoteHosts.add(payload),
  update: (payload: UpdateHostPayload): Promise<HostDescriptor> =>
    window.electron.remoteHosts.update(payload),
  forget: (hostId: string): Promise<void> => window.electron.remoteHosts.forget({ hostId }),
  connect: (hostId: string) => window.electron.remoteHosts.connect({ hostId }),
  discover: (): Promise<DiscoveredHost[]> => window.electron.remoteHosts.discover(),
  probe: (sshTarget: string): Promise<HostProbeResult> =>
    window.electron.remoteHosts.probe({ sshTarget }),
  planInstall: (payload: PlanInstallPayload): Promise<HostInstallPlan> =>
    window.electron.remoteHosts.planInstall(payload),
  install: (payload: InstallHostPayload): Promise<InstallHostResult> =>
    window.electron.remoteHosts.install(payload),
  getInstallStatus: (opId: OperationId): Promise<OperationOutcome> =>
    window.electron.remoteHosts.getInstallStatus({ opId }),
  cancelInstall: (opId: OperationId): Promise<boolean> =>
    window.electron.remoteHosts.cancelInstall({ opId }),
  startHostMode: (sshTarget: string): Promise<HostProbeResult> =>
    window.electron.remoteHosts.startHostMode({ sshTarget }),
  onEvent: (callback: (event: RemoteHostsEvent) => void): (() => void) =>
    window.electron.remoteHosts.onEvent(callback),
};
