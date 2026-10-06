import type {
  ClosedProcessKillResult,
  ClosedProcessKillTarget,
  ProcessInventorySnapshot,
} from "@shared/types/processes";

export const processesClient = {
  getSnapshot: (): Promise<ProcessInventorySnapshot> => {
    return window.electron.processes.getSnapshot();
  },
  killClosedTerminalProcesses: (
    targets: ClosedProcessKillTarget[]
  ): Promise<ClosedProcessKillResult> => {
    return window.electron.processes.killClosedTerminalProcesses(targets);
  },
};
