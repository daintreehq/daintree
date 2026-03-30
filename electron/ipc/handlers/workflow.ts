import { CHANNELS } from "../channels.js";
import { typedHandle, typedBroadcast } from "../utils.js";
import type { HandlerDependencies } from "../types.js";
import { getWorkflowEngine } from "../../services/WorkflowEngine.js";
import { workflowLoader } from "../../services/WorkflowLoader.js";
import type { WorkflowRun } from "../../../shared/types/workflowRun.js";
import type { WorkflowRunIpc } from "../../../shared/types/ipc/api.js";

function serializeWorkflowRun(run: WorkflowRun): WorkflowRunIpc {
  return {
    ...run,
    scheduledNodes: Array.from(run.scheduledNodes),
  };
}

function requireEngine() {
  const engine = getWorkflowEngine();
  if (!engine) {
    throw new Error("WorkflowEngine not initialized");
  }
  return engine;
}

export function registerWorkflowHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  handlers.push(
    typedHandle(CHANNELS.WORKFLOW_LIST, async () => {
      return await workflowLoader.listWorkflows();
    })
  );

  handlers.push(
    typedHandle(CHANNELS.WORKFLOW_START, async (workflowId) => {
      const engine = requireEngine();
      return await engine.startWorkflow(workflowId);
    })
  );

  handlers.push(
    typedHandle(CHANNELS.WORKFLOW_CANCEL, async (runId) => {
      const engine = requireEngine();
      await engine.cancelWorkflow(runId);
    })
  );

  handlers.push(
    typedHandle(CHANNELS.WORKFLOW_GET_RUN, async (runId) => {
      const engine = requireEngine();
      const run = await engine.getWorkflowRun(runId);
      return run ? serializeWorkflowRun(run) : null;
    })
  );

  handlers.push(
    typedHandle(CHANNELS.WORKFLOW_LIST_RUNS, async () => {
      const engine = getWorkflowEngine();
      if (!engine) return [];
      const runs = await engine.listAllRuns();
      return runs.map(serializeWorkflowRun);
    })
  );

  handlers.push(
    typedHandle(CHANNELS.WORKFLOW_LIST_PENDING_APPROVALS, async () => {
      const engine = getWorkflowEngine();
      if (!engine) return [];
      return engine.listPendingApprovals();
    })
  );

  handlers.push(
    typedHandle(CHANNELS.WORKFLOW_RESOLVE_APPROVAL, async (payload) => {
      const engine = requireEngine();
      if (!payload || typeof payload !== "object") throw new Error("Invalid payload");
      if (!payload.runId || !payload.nodeId) throw new Error("Missing runId or nodeId");
      await engine.resolveApproval(
        payload.runId,
        payload.nodeId,
        payload.approved,
        payload.feedback
      );
    })
  );

  if (deps.events) {
    const unsubStarted = deps.events.on("workflow:started", (payload) => {
      typedBroadcast(CHANNELS.WORKFLOW_STARTED, payload);
    });
    handlers.push(unsubStarted);

    const unsubCompleted = deps.events.on("workflow:completed", (payload) => {
      typedBroadcast(CHANNELS.WORKFLOW_COMPLETED, payload);
    });
    handlers.push(unsubCompleted);

    const unsubFailed = deps.events.on("workflow:failed", (payload) => {
      typedBroadcast(CHANNELS.WORKFLOW_FAILED, payload);
    });
    handlers.push(unsubFailed);

    const unsubApprovalRequested = deps.events.on("workflow:approval-requested", (payload) => {
      typedBroadcast(CHANNELS.WORKFLOW_APPROVAL_REQUESTED, payload);
    });
    handlers.push(unsubApprovalRequested);

    const unsubApprovalCleared = deps.events.on("workflow:approval-cleared", (payload) => {
      typedBroadcast(CHANNELS.WORKFLOW_APPROVAL_CLEARED, payload);
    });
    handlers.push(unsubApprovalCleared);
  }

  return () => {
    handlers.forEach((dispose) => dispose());
  };
}
