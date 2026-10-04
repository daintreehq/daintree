import type { ProcessInventorySnapshot } from "@shared/types/processes";

export const processesClient = {
  getSnapshot: (): Promise<ProcessInventorySnapshot> => {
    return window.electron.processes.getSnapshot();
  },
};
