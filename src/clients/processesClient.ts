import type { HostProcessInventoryResult } from "@shared/types/ipc/hostMetrics";
import type { HostId } from "@shared/types/remoteHosts";
import type {
  ClosedProcessKillResult,
  ClosedProcessKillTarget,
  ProcessInventorySnapshot,
} from "@shared/types/processes";

export const processesClient = {
  getSnapshot: (): Promise<ProcessInventorySnapshot> => {
    return window.electron.processes.getSnapshot();
  },
  getHostInventory: (hostId: HostId): Promise<HostProcessInventoryResult> => {
    return window.electron.hostMetrics.processInventory({ hostId });
  },
  killClosedTerminalProcesses: (
    targets: ClosedProcessKillTarget[]
  ): Promise<ClosedProcessKillResult> => {
    return window.electron.processes.killClosedTerminalProcesses(targets);
  },
};
