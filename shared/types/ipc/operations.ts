import type { OperationId, OperationProgress, OperationRecord } from "../remoteHosts.js";

export interface OperationIdPayload {
  opId: OperationId;
}

export interface ListOperationsPayload {
  projectId?: string;
}

export type OperationsEvent =
  { type: "progress"; progress: OperationProgress } | { type: "settled"; record: OperationRecord };
