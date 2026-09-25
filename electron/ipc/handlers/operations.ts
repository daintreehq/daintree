import { defineIpcNamespace, op } from "../define.js";
import { pendingRemoteHostsHandler } from "../../remote/pendingHandler.js";
import { OPERATIONS_METHOD_CHANNELS } from "./operations.preload.js";
import type { OperationOutcome, OperationRecord } from "../../../shared/types/remoteHosts.js";
import type {
  ListOperationsPayload,
  OperationIdPayload,
} from "../../../shared/types/ipc/operations.js";

export const operationsNamespace = defineIpcNamespace({
  name: "operations",
  ops: {
    getStatus: op(
      OPERATIONS_METHOD_CHANNELS.getStatus,
      async (_payload: OperationIdPayload): Promise<OperationOutcome> =>
        pendingRemoteHostsHandler(OPERATIONS_METHOD_CHANNELS.getStatus)
    ),
    list: op(
      OPERATIONS_METHOD_CHANNELS.list,
      async (_payload: ListOperationsPayload): Promise<OperationRecord[]> =>
        pendingRemoteHostsHandler(OPERATIONS_METHOD_CHANNELS.list)
    ),
    cancel: op(
      OPERATIONS_METHOD_CHANNELS.cancel,
      async (_payload: OperationIdPayload): Promise<boolean> =>
        pendingRemoteHostsHandler(OPERATIONS_METHOD_CHANNELS.cancel)
    ),
  },
});

export function registerOperationsHandlers(): () => void {
  return operationsNamespace.register();
}
