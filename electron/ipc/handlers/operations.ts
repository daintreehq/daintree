import { defineIpcNamespace, op } from "../define.js";
import { OPERATIONS_METHOD_CHANNELS } from "./operations.preload.js";
import { getOperationRegistry, normalizeOperationId } from "../../services/operations/index.js";
import type { IpcContext } from "../types.js";
import type { ClientEndpoint } from "../endpoint.js";
import type { OperationOutcome, OperationRecord } from "../../../shared/types/remoteHosts.js";
import type {
  ListOperationsPayload,
  OperationIdPayload,
} from "../../../shared/types/ipc/operations.js";

function readOperationId(payload: OperationIdPayload | undefined): string | null {
  return normalizeOperationId(payload?.opId);
}

/**
 * A remote client is bound to one project and sees only that project's
 * operations. Local views are this machine's own UI and see them all.
 */
function scopeOf(ctx: IpcContext): { projectId: string | null } | null {
  return (ctx.endpoint as ClientEndpoint | undefined)?.kind === "remote-view"
    ? { projectId: ctx.projectId }
    : null;
}

function visibleTo(ctx: IpcContext, record: OperationRecord | null): record is OperationRecord {
  if (!record) return false;
  const scope = scopeOf(ctx);
  return scope === null || record.projectId === scope.projectId;
}

export const operationsNamespace = defineIpcNamespace({
  name: "operations",
  ops: {
    getStatus: op(
      OPERATIONS_METHOD_CHANNELS.getStatus,
      async (ctx: IpcContext, payload: OperationIdPayload): Promise<OperationOutcome> => {
        const opId = readOperationId(payload);
        const record = opId ? getOperationRegistry().get(opId) : null;
        return visibleTo(ctx, record) ? record.outcome : { status: "unknown" };
      },
      { withContext: true }
    ),
    list: op(
      OPERATIONS_METHOD_CHANNELS.list,
      async (ctx: IpcContext, payload: ListOperationsPayload): Promise<OperationRecord[]> => {
        const projectId = typeof payload?.projectId === "string" ? payload.projectId : undefined;
        return getOperationRegistry()
          .list(projectId)
          .filter((record) => visibleTo(ctx, record));
      },
      { withContext: true }
    ),
    cancel: op(
      OPERATIONS_METHOD_CHANNELS.cancel,
      async (ctx: IpcContext, payload: OperationIdPayload): Promise<boolean> => {
        const opId = readOperationId(payload);
        const registry = getOperationRegistry();
        if (!opId || !visibleTo(ctx, registry.get(opId))) return false;
        return registry.cancel(opId);
      },
      { withContext: true }
    ),
  },
});

export function registerOperationsHandlers(): () => void {
  return operationsNamespace.register();
}
