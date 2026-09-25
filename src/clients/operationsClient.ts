import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";
import type { OperationId, OperationOutcome, OperationRecord } from "@shared/types/remoteHosts";
import type { OperationsEvent } from "@shared/types/ipc/operations";

/**
 * A fresh id for a mutation the Host should treat as one operation. Minted on
 * the client so a retry after a dropped link names the same work.
 */
export function mintOperationId(): OperationId {
  return crypto.randomUUID();
}

/** True when this view's backend is another machine rather than this one. */
export function isRemoteBoundView(): boolean {
  const hostId = typeof window === "undefined" ? undefined : window.__DAINTREE_HOST_ID__?.id;
  return typeof hostId === "string" && hostId !== LOCAL_HOST_ID;
}

/**
 * An opId for a mutation, minted only in a remote-bound view: there a dropped
 * link can leave the outcome unknown, and the id is how it is recovered. A
 * local view names no operation, so the Host runs the call exactly as it did
 * before operations existed.
 */
export function mintRemoteOperationId(): OperationId | undefined {
  return isRemoteBoundView() ? mintOperationId() : undefined;
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
