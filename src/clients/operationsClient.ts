import type { OperationId, OperationOutcome, OperationRecord } from "@shared/types/remoteHosts";
import type { OperationsEvent } from "@shared/types/ipc/operations";

/**
 * A fresh id for a mutation the Host should treat as one operation. Minted on
 * the client so a retry after a dropped link names the same work.
 */
export function mintOperationId(): OperationId {
  return crypto.randomUUID();
}

export const operationsClient = {
  getStatus: (opId: OperationId): Promise<OperationOutcome> => {
    return window.electron.operations.getStatus({ opId });
  },

  list: (projectId?: string): Promise<OperationRecord[]> => {
    return window.electron.operations.list(projectId === undefined ? {} : { projectId });
  },

  cancel: (opId: OperationId): Promise<boolean> => {
    return window.electron.operations.cancel({ opId });
  },

  onEvent: (callback: (event: OperationsEvent) => void): (() => void) => {
    return window.electron.operations.onEvent(callback);
  },
} as const;
