/**
 * WorkflowEngine - Compiles workflow definitions into task queue operations.
 *
 * Loads workflow templates from WorkflowLoader, translates nodes into TaskQueue tasks,
 * subscribes to task completion events, evaluates routing conditions, and tracks
 * workflow run state. Persists run state to disk for crash recovery.
 */

import { randomUUID } from "crypto";
import { events } from "./events.js";
import { workflowLoader, WorkflowLoader } from "./WorkflowLoader.js";
import { taskQueueService, TaskQueueService } from "./TaskQueueService.js";
import { workflowPersistence, WorkflowPersistence } from "./persistence/WorkflowPersistence.js";
import type {
  WorkflowRun,
  NodeState,
  PendingWorkflowApproval,
} from "../../shared/types/workflowRun.js";
import type { WorkflowNode, LoopNode } from "../../shared/types/workflow.js";
import type { TaskRecord } from "../../shared/types/task.js";

import { evaluateCondition } from "./workflow/ConditionEvaluator.js";
import { hasTemplateExpressions, resolveTemplateArgs } from "./workflow/TemplateResolver.js";
import { ApprovalManager } from "./workflow/ApprovalManager.js";
import {
  LoopCompiler,
  buildCompositeId,
  parseCompositeId,
  findLoopNode,
  COMPOSITE_SEP,
} from "./workflow/LoopCompiler.js";
import { PersistenceCoordinator } from "./workflow/PersistenceCoordinator.js";

const MAX_RESULT_DATA_BYTES = 1_048_576; // 1 MB

export class WorkflowEngine {
  /** Active workflow runs (runId -> WorkflowRun) */
  private runs: Map<string, WorkflowRun> = new Map();

  /** Reverse index for fast lookup (taskId -> { runId, nodeId }) */
  private taskToNode: Map<string, { runId: string; nodeId: string }> = new Map();

  /** Unsubscribe functions for event listeners */
  private unsubscribers: Array<() => void> = [];

  /** Flag to track if engine is disposed */
  private isDisposed = false;

  /** Current project ID for persistence */
  private currentProjectId: string | null = null;

  /** Whether persistence is enabled */
  private persistenceEnabled: boolean = true;

  private approvalManager: ApprovalManager;
  private loopCompiler: LoopCompiler;
  private persistenceCoordinator: PersistenceCoordinator;

  constructor(
    private loader: WorkflowLoader = workflowLoader,
    private queueService: TaskQueueService = taskQueueService,
    persistence: WorkflowPersistence = workflowPersistence
  ) {
    this.approvalManager = new ApprovalManager();
    this.loopCompiler = new LoopCompiler(queueService, this.taskToNode);
    this.persistenceCoordinator = new PersistenceCoordinator(
      persistence,
      this.runs,
      this.taskToNode
    );

    this.unsubscribers.push(
      events.on("task:completed", (payload) => {
        void this.handleTaskComplete(payload);
      })
    );

    this.unsubscribers.push(
      events.on("task:failed", (payload) => {
        void this.handleTaskFailed(payload);
      })
    );
  }

  async startWorkflow(workflowId: string): Promise<string> {
    if (this.isDisposed) {
      throw new Error("WorkflowEngine is disposed");
    }

    await this.loader.initialize();

    const loaded = await this.loader.getWorkflow(workflowId);
    if (!loaded) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    const definition = loaded.definition;
    const runId = randomUUID();
    const now = Date.now();

    const run: WorkflowRun = {
      runId,
      workflowId: definition.id,
      workflowVersion: definition.version,
      status: "running",
      startedAt: now,
      definition,
      nodeStates: {},
      taskMapping: {},
      scheduledNodes: new Set(),
      evaluatedConditions: [],
    };

    this.runs.set(runId, run);

    try {
      const rootNodes = definition.nodes.filter(
        (node) => !node.dependencies || node.dependencies.length === 0
      );

      for (const node of rootNodes) {
        await this.compileNodeToTask(node, run);
      }

      events.emit("workflow:started", {
        runId,
        workflowId: definition.id,
        workflowVersion: definition.version,
        timestamp: now,
      });

      await this.schedulePersist();

      return runId;
    } catch (error) {
      run.status = "failed";
      run.completedAt = Date.now();

      for (const [, nodeState] of Object.entries(run.nodeStates)) {
        if (nodeState.taskId && nodeState.status !== "completed" && nodeState.status !== "failed") {
          try {
            await this.queueService.cancelTask(nodeState.taskId);
          } catch (_e) {
            // Best effort cancellation
          }
        }
      }

      await this.schedulePersist();

      throw error;
    }
  }

  async cancelWorkflow(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Workflow run not found: ${runId}`);
    }

    if (run.status !== "running") {
      return;
    }

    const now = Date.now();
    run.status = "cancelled";
    run.completedAt = now;

    this.approvalManager.clearPendingApprovals(runId, "cancelled");

    for (const [nodeId, nodeState] of Object.entries(run.nodeStates)) {
      if (nodeState.status === "awaiting-approval") {
        nodeState.status = "cancelled";
        nodeState.completedAt = now;
        continue;
      }
      if (nodeState.taskId && nodeState.status !== "completed" && nodeState.status !== "failed") {
        try {
          await this.queueService.cancelTask(nodeState.taskId);
        } catch (error) {
          console.warn(
            `[WorkflowEngine] Failed to cancel task ${nodeState.taskId} for node ${nodeId}:`,
            error
          );
        }
      }
    }

    events.emit("workflow:failed", {
      runId,
      workflowId: run.workflowId,
      workflowVersion: run.workflowVersion,
      error: "Workflow was cancelled",
      timestamp: now,
    });

    await this.schedulePersist();
  }

  async getWorkflowRun(runId: string): Promise<WorkflowRun | null> {
    const run = this.runs.get(runId);
    return run ? { ...run } : null;
  }

  async listActiveRuns(): Promise<WorkflowRun[]> {
    return Array.from(this.runs.values())
      .filter((run) => run.status === "running")
      .map((run) => ({ ...run }));
  }

  private async compileNodeToTask(
    node: WorkflowNode,
    run: WorkflowRun
  ): Promise<TaskRecord | null> {
    if (node.type === "loop") {
      await this.loopCompiler.compileLoopNode(node as LoopNode, run);
      return null;
    }

    if (run.scheduledNodes.has(node.id)) {
      if (node.type === "approval") return null;
      const existing = await this.queueService.getTask(run.taskMapping[node.id]);
      if (existing) {
        return existing;
      }
    }

    run.scheduledNodes.add(node.id);

    const now = Date.now();

    if (node.type === "approval") {
      const config = node.config as { prompt: string; timeoutMs?: number };
      const nodeState: NodeState = {
        status: "awaiting-approval",
        startedAt: now,
      };
      run.nodeStates[node.id] = nodeState;

      const timeoutAt = config.timeoutMs ? now + config.timeoutMs : undefined;

      this.approvalManager.setupApprovalWait(run.runId, node.id, config.timeoutMs, () => {
        void this.handleApprovalResolution(run.runId, node.id, false, "Approval timed out", true);
      });

      events.emit("workflow:approval-requested", {
        runId: run.runId,
        nodeId: node.id,
        workflowId: run.workflowId,
        workflowName: run.definition.name,
        prompt: config.prompt,
        requestedAt: now,
        timeoutMs: config.timeoutMs,
        timeoutAt,
        timestamp: now,
      });

      await this.schedulePersist();
      return null;
    }

    const nodeState: NodeState = {
      status: "draft",
      startedAt: now,
    };

    run.nodeStates[node.id] = nodeState;

    const dependencies = node.dependencies || [];
    const resolvedDeps: string[] = [];

    for (const depId of dependencies) {
      const depNode = run.definition.nodes.find((n) => n.id === depId);
      if (depNode?.type === "loop" || depNode?.type === "approval") continue;

      const taskId = run.taskMapping[depId];
      if (!taskId) {
        throw new Error(
          `Cannot compile node ${node.id}: dependency ${depId} has not been scheduled yet`
        );
      }
      resolvedDeps.push(taskId);
    }

    const actionConfig = node.config as { actionId: string; args?: Record<string, unknown> };

    let resolvedArgs = actionConfig.args;
    if (resolvedArgs && hasTemplateExpressions(resolvedArgs)) {
      for (const depId of dependencies) {
        const depState = run.nodeStates[depId];
        if (!depState || depState.status !== "completed") {
          throw new Error(
            `Cannot compile node ${node.id}: dependency ${depId} has not completed yet (status: ${depState?.status ?? "unknown"})`
          );
        }
      }
      try {
        resolvedArgs = resolveTemplateArgs(resolvedArgs, run.nodeStates);
      } catch (error) {
        await this.failNode(node.id, run, (error as Error).message);
        throw error;
      }
    }

    const task = await this.queueService.createTask({
      title: `Workflow ${run.workflowId} - Node ${node.id}`,
      description: `Execute action: ${actionConfig.actionId}`,
      priority: 0,
      dependencies: resolvedDeps,
      metadata: {
        workflowRunId: run.runId,
        workflowId: run.workflowId,
        nodeId: node.id,
        actionId: actionConfig.actionId,
        actionArgs: resolvedArgs,
      },
    });

    nodeState.taskId = task.id;
    nodeState.status = task.status;
    run.taskMapping[node.id] = task.id;

    this.taskToNode.set(task.id, { runId: run.runId, nodeId: node.id });

    await this.queueService.enqueueTask(task.id);

    return task;
  }

  private async handleApprovalResolution(
    runId: string,
    nodeId: string,
    approved: boolean,
    feedback?: string,
    timedOut?: boolean
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") return;

    const nodeState = run.nodeStates[nodeId];
    if (!nodeState || nodeState.status !== "awaiting-approval") return;

    this.approvalManager.deletePendingApproval(runId, nodeId);

    const now = Date.now();
    nodeState.status = approved ? "completed" : "failed";
    nodeState.completedAt = now;
    nodeState.approvalDecision = {
      approved,
      feedback,
      resolvedAt: now,
      timedOut,
    };

    events.emit("workflow:approval-cleared", {
      runId,
      nodeId,
      reason: timedOut ? "timeout" : "resolved",
      timestamp: now,
    });

    const node = run.definition.nodes.find((n) => n.id === nodeId);
    if (node) {
      const routingKey = approved ? "onSuccess" : "onFailure";
      const nextNodeIds = await this.evaluateRouting(node, nodeState, run, routingKey);

      if (!approved && nextNodeIds.length === 0) {
        run.status = "failed";
        run.completedAt = now;
        events.emit("workflow:failed", {
          runId,
          workflowId: run.workflowId,
          workflowVersion: run.workflowVersion,
          error: `Approval rejected for node ${nodeId}${feedback ? `: ${feedback}` : ""}`,
          timestamp: now,
        });
      } else {
        for (const nextId of nextNodeIds) {
          const nextNode = run.definition.nodes.find((n) => n.id === nextId);
          if (nextNode && !run.scheduledNodes.has(nextId)) {
            await this.compileNodeToTask(nextNode, run);
          }
        }
      }
    }

    await this.schedulePersist();
    await this.checkWorkflowCompletion(run);
  }

  async resolveApproval(
    runId: string,
    nodeId: string,
    approved: boolean,
    feedback?: string
  ): Promise<void> {
    if (!this.approvalManager.hasPendingApproval(runId, nodeId)) {
      throw new Error(`No pending approval found for run ${runId}, node ${nodeId}`);
    }
    this.approvalManager.deletePendingApproval(runId, nodeId);
    await this.handleApprovalResolution(runId, nodeId, approved, feedback);
  }

  listPendingApprovals(): PendingWorkflowApproval[] {
    const approvals: PendingWorkflowApproval[] = [];

    for (const key of this.approvalManager.pendingApprovalKeys()) {
      const [runId, nodeId] = key.split("::");
      const run = this.runs.get(runId);
      if (!run || run.status !== "running") continue;

      const nodeState = run.nodeStates[nodeId];
      if (!nodeState || nodeState.status !== "awaiting-approval") continue;

      const node = run.definition.nodes.find((n) => n.id === nodeId);
      if (!node || node.type !== "approval") continue;

      const config = node.config as { prompt: string; timeoutMs?: number };
      approvals.push({
        runId,
        nodeId,
        workflowId: run.workflowId,
        workflowName: run.definition.name,
        prompt: config.prompt,
        requestedAt: nodeState.startedAt ?? run.startedAt,
        timeoutMs: config.timeoutMs,
        timeoutAt:
          config.timeoutMs && nodeState.startedAt
            ? nodeState.startedAt + config.timeoutMs
            : undefined,
      });
    }

    return approvals;
  }

  private async handleTaskComplete(payload: {
    taskId: string;
    result: string;
    artifacts?: string[];
    data?: Record<string, unknown>;
    timestamp: number;
  }): Promise<void> {
    const mapping = this.taskToNode.get(payload.taskId);
    if (!mapping) {
      return;
    }

    const run = this.runs.get(mapping.runId);
    if (!run || run.status !== "running") {
      return;
    }

    const nodeState = run.nodeStates[mapping.nodeId];
    if (!nodeState) {
      return;
    }

    if (payload.data) {
      try {
        const dataJson = JSON.stringify(payload.data);
        if (Buffer.byteLength(dataJson, "utf8") > MAX_RESULT_DATA_BYTES) {
          const sizeMB = (Buffer.byteLength(dataJson, "utf8") / 1_048_576).toFixed(2);
          await this.failNode(
            mapping.nodeId,
            run,
            `Node result data exceeds 1 MB limit (${sizeMB} MB)`
          );
          return;
        }
      } catch (e) {
        await this.failNode(
          mapping.nodeId,
          run,
          `Node result data could not be serialized: ${(e as Error).message}`
        );
        return;
      }
    }

    nodeState.status = "completed";
    nodeState.completedAt = payload.timestamp;
    nodeState.result = {
      summary: payload.result,
      artifacts: payload.artifacts,
      data: payload.data,
    };

    const composite = parseCompositeId(mapping.nodeId);
    if (composite) {
      await this.loopCompiler.handleBodyNodeComplete(composite, run);
      await this.handleLoopPostCompletion(composite, run);
      await this.schedulePersist();
      await this.checkWorkflowCompletion(run);
      return;
    }

    const definition = run.definition;
    const node = definition.nodes.find((n) => n.id === mapping.nodeId);
    if (!node) {
      console.error(`[WorkflowEngine] Node ${mapping.nodeId} not found in workflow`);
      return;
    }

    try {
      const nextNodeIds = await this.evaluateRouting(node, nodeState, run, "onSuccess");

      for (const nextId of nextNodeIds) {
        const nextNode = definition.nodes.find((n) => n.id === nextId);
        if (nextNode && !run.scheduledNodes.has(nextId)) {
          await this.compileNodeToTask(nextNode, run);
        }
      }
    } catch (error) {
      console.error(
        `[WorkflowEngine] Error during routing after node ${mapping.nodeId} completion:`,
        error
      );
    }

    await this.schedulePersist();
    await this.checkWorkflowCompletion(run);
  }

  private async handleTaskFailed(payload: {
    taskId: string;
    error: string;
    timestamp: number;
  }): Promise<void> {
    const mapping = this.taskToNode.get(payload.taskId);
    if (!mapping) {
      return;
    }

    const run = this.runs.get(mapping.runId);
    if (!run || run.status !== "running") {
      return;
    }

    const nodeState = run.nodeStates[mapping.nodeId];
    if (!nodeState) {
      return;
    }

    nodeState.status = "failed";
    nodeState.completedAt = payload.timestamp;
    nodeState.result = {
      error: payload.error,
    };

    const composite = parseCompositeId(mapping.nodeId);
    if (composite) {
      await this.loopCompiler.handleBodyNodeFailed(composite, run);
      await this.handleLoopPostCompletion(composite, run);
      await this.schedulePersist();
      await this.checkWorkflowCompletion(run);
      return;
    }

    const definition = run.definition;
    const node = definition.nodes.find((n) => n.id === mapping.nodeId);
    if (!node) {
      console.error(`[WorkflowEngine] Node ${mapping.nodeId} not found in workflow`);
      return;
    }

    const nextNodeIds = await this.evaluateRouting(node, nodeState, run, "onFailure");

    if (nextNodeIds.length > 0) {
      for (const nextId of nextNodeIds) {
        const nextNode = definition.nodes.find((n) => n.id === nextId);
        if (nextNode && !run.scheduledNodes.has(nextId)) {
          await this.compileNodeToTask(nextNode, run);
        }
      }
    } else {
      run.status = "failed";
      run.completedAt = payload.timestamp;

      events.emit("workflow:failed", {
        runId: run.runId,
        workflowId: run.workflowId,
        workflowVersion: run.workflowVersion,
        error: `Node ${mapping.nodeId} failed: ${payload.error}`,
        timestamp: payload.timestamp,
      });
    }

    await this.schedulePersist();
    await this.checkWorkflowCompletion(run);
  }

  private async handleLoopPostCompletion(
    composite: { loopNodeId: string; iterIndex: number; bodyNodeId: string },
    run: WorkflowRun
  ): Promise<void> {
    const loopNode = findLoopNode(run.definition, composite.loopNodeId);
    if (!loopNode) return;

    const loopState = run.nodeStates[loopNode.id];
    if (!loopState) return;

    if (loopState.status === "completed") {
      await this.routeLoopCompletion(loopNode, loopState, run, "onSuccess");
    } else if (loopState.status === "failed") {
      await this.routeLoopCompletion(loopNode, loopState, run, "onFailure");
    }
  }

  private async evaluateRouting(
    node: WorkflowNode,
    nodeState: NodeState,
    run: WorkflowRun,
    routingKey: "onSuccess" | "onFailure"
  ): Promise<string[]> {
    const targets = node[routingKey] || [];
    if (targets.length === 0) {
      return [];
    }

    if (!node.conditions || node.conditions.length === 0) {
      return targets;
    }

    const allConditionsPass = node.conditions.every((condition) => {
      const result = evaluateCondition(condition, nodeState, run);

      run.evaluatedConditions.push({
        nodeId: node.id,
        condition,
        result,
        timestamp: Date.now(),
      });

      return result;
    });

    return allConditionsPass ? targets : [];
  }

  private async routeLoopCompletion(
    loopNode: LoopNode,
    loopState: NodeState,
    run: WorkflowRun,
    routingKey: "onSuccess" | "onFailure"
  ): Promise<void> {
    const nextNodeIds = await this.evaluateRouting(loopNode, loopState, run, routingKey);

    if (nextNodeIds.length > 0) {
      for (const nextId of nextNodeIds) {
        const nextNode = run.definition.nodes.find((n) => n.id === nextId);
        if (nextNode && !run.scheduledNodes.has(nextId)) {
          await this.compileNodeToTask(nextNode, run);
        }
      }
    } else if (routingKey === "onFailure") {
      const now = Date.now();
      run.status = "failed";
      run.completedAt = now;
      events.emit("workflow:failed", {
        runId: run.runId,
        workflowId: run.workflowId,
        workflowVersion: run.workflowVersion,
        error: `Loop node ${loopNode.id} failed`,
        timestamp: now,
      });
    }
  }

  private async failNode(nodeId: string, run: WorkflowRun, error: string): Promise<void> {
    const nodeState = run.nodeStates[nodeId];
    if (!nodeState) return;

    const now = Date.now();
    nodeState.status = "failed";
    nodeState.completedAt = now;
    nodeState.result = { error };

    const node = run.definition.nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const nextNodeIds = await this.evaluateRouting(node, nodeState, run, "onFailure");

    if (nextNodeIds.length > 0) {
      for (const nextId of nextNodeIds) {
        const nextNode = run.definition.nodes.find((n) => n.id === nextId);
        if (nextNode && !run.scheduledNodes.has(nextId)) {
          await this.compileNodeToTask(nextNode, run);
        }
      }
    } else {
      run.status = "failed";
      run.completedAt = now;

      events.emit("workflow:failed", {
        runId: run.runId,
        workflowId: run.workflowId,
        workflowVersion: run.workflowVersion,
        error: `Node ${nodeId} failed: ${error}`,
        timestamp: now,
      });
    }

    await this.schedulePersist();
    await this.checkWorkflowCompletion(run);
  }

  private async checkWorkflowCompletion(run: WorkflowRun): Promise<void> {
    if (run.status !== "running") {
      return;
    }

    const outerNodeIds = Array.from(run.scheduledNodes).filter(
      (nodeId) => parseCompositeId(nodeId) === null
    );
    const allScheduledNodesTerminal = outerNodeIds.every((nodeId) => {
      const nodeState = run.nodeStates[nodeId];
      if (!nodeState) {
        return false;
      }
      return (
        nodeState.status === "completed" ||
        nodeState.status === "failed" ||
        nodeState.status === "cancelled"
      );
    });

    if (!allScheduledNodesTerminal) {
      return;
    }

    const anyScheduledNodeFailed = outerNodeIds.some((nodeId) => {
      const nodeState = run.nodeStates[nodeId];
      return nodeState?.status === "failed";
    });

    const now = Date.now();
    run.completedAt = now;

    if (anyScheduledNodeFailed) {
      run.status = "failed";
      events.emit("workflow:failed", {
        runId: run.runId,
        workflowId: run.workflowId,
        workflowVersion: run.workflowVersion,
        error: "One or more nodes failed",
        timestamp: now,
      });
    } else {
      run.status = "completed";
      const duration = now - run.startedAt;
      events.emit("workflow:completed", {
        runId: run.runId,
        workflowId: run.workflowId,
        workflowVersion: run.workflowVersion,
        duration,
        timestamp: now,
      });
    }

    await this.schedulePersist();
  }

  async initialize(projectId: string): Promise<void> {
    this.currentProjectId = projectId;
    await this.loadFromDisk(projectId);
  }

  async onProjectSwitch(newProjectId?: string): Promise<void> {
    if (this.currentProjectId) {
      await this.persistenceCoordinator.flush(this.currentProjectId);
    }

    this.runs.clear();
    this.taskToNode.clear();

    if (newProjectId) {
      this.currentProjectId = newProjectId;
      await this.loadFromDisk(newProjectId);
    } else {
      this.currentProjectId = null;
    }
  }

  private async loadFromDisk(projectId: string): Promise<void> {
    if (!this.persistenceEnabled) return;

    await this.persistenceCoordinator.loadFromDisk(projectId);

    for (const run of this.runs.values()) {
      if (run.status === "running") {
        await this.handleRunningWorkflowRecovery(run);
      }
    }
  }

  private async handleRunningWorkflowRecovery(run: WorkflowRun): Promise<void> {
    let hasOrphanedTasks = false;
    let hasActiveTasks = false;
    let hasRecoveryChanges = false;

    const nodesToProcess: Array<{ nodeId: string; nodeState: NodeState }> = [];

    for (const [nodeId, nodeState] of Object.entries(run.nodeStates)) {
      if (
        nodeState.status === "completed" ||
        nodeState.status === "failed" ||
        nodeState.status === "cancelled"
      ) {
        continue;
      }

      if (nodeState.status === "awaiting-approval") {
        const node = run.definition.nodes.find((n) => n.id === nodeId);
        if (!node || node.type !== "approval") continue;

        const config = node.config as { prompt: string; timeoutMs?: number };
        const timeoutAt =
          config.timeoutMs && nodeState.startedAt
            ? nodeState.startedAt + config.timeoutMs
            : undefined;

        if (timeoutAt && Date.now() >= timeoutAt) {
          nodeState.status = "failed";
          nodeState.completedAt = Date.now();
          nodeState.approvalDecision = {
            approved: false,
            feedback: "Approval timed out during restart",
            resolvedAt: Date.now(),
            timedOut: true,
          };
          hasRecoveryChanges = true;
          nodesToProcess.push({ nodeId, nodeState });
        } else {
          const remainingTimeout = timeoutAt ? timeoutAt - Date.now() : config.timeoutMs;
          this.approvalManager.setupApprovalWait(run.runId, nodeId, remainingTimeout, () => {
            void this.handleApprovalResolution(
              run.runId,
              nodeId,
              false,
              "Approval timed out",
              true
            );
          });

          events.emit("workflow:approval-requested", {
            runId: run.runId,
            nodeId,
            workflowId: run.workflowId,
            workflowName: run.definition.name,
            prompt: config.prompt,
            requestedAt: nodeState.startedAt ?? run.startedAt,
            timeoutMs: config.timeoutMs,
            timeoutAt,
            timestamp: Date.now(),
          });
          hasActiveTasks = true;
        }
        continue;
      }

      if (!nodeState.taskId) {
        continue;
      }

      const task = await this.queueService.getTask(nodeState.taskId);

      if (!task) {
        console.warn(
          `[WorkflowEngine] Crash recovery: task ${nodeState.taskId} for node ${nodeId} is missing from queue`
        );
        nodeState.status = "failed";
        nodeState.completedAt = Date.now();
        nodeState.result = { error: "Task missing after restart" };
        hasOrphanedTasks = true;
        hasRecoveryChanges = true;
        nodesToProcess.push({ nodeId, nodeState });
      } else if (task.status === "completed") {
        nodeState.status = "completed";
        nodeState.completedAt = task.completedAt ?? Date.now();
        nodeState.result = task.result;
        hasRecoveryChanges = true;
        nodesToProcess.push({ nodeId, nodeState });
      } else if (task.status === "failed" || task.status === "cancelled") {
        nodeState.status = task.status;
        nodeState.completedAt = task.completedAt ?? Date.now();
        nodeState.result = task.result;
        hasOrphanedTasks = true;
        hasRecoveryChanges = true;
        nodesToProcess.push({ nodeId, nodeState });
      } else {
        hasActiveTasks = true;
      }
    }

    const loopItersToCheck = new Set<string>();

    for (const { nodeId, nodeState } of nodesToProcess) {
      const composite = parseCompositeId(nodeId);
      if (composite) {
        loopItersToCheck.add(`${composite.loopNodeId}${COMPOSITE_SEP}${composite.iterIndex}`);
        continue;
      }

      const node = run.definition.nodes.find((n) => n.id === nodeId);
      if (!node) {
        console.error(`[WorkflowEngine] Recovery: node ${nodeId} not found in workflow definition`);
        continue;
      }

      if (nodeState.status === "completed") {
        const nextNodeIds = await this.evaluateRouting(node, nodeState, run, "onSuccess");
        for (const nextId of nextNodeIds) {
          const nextNode = run.definition.nodes.find((n) => n.id === nextId);
          if (nextNode && !run.scheduledNodes.has(nextId)) {
            try {
              await this.compileNodeToTask(nextNode, run);
              hasRecoveryChanges = true;
            } catch (error) {
              console.error(`[WorkflowEngine] Recovery: failed to schedule node ${nextId}:`, error);
            }
          }
        }
      } else if (nodeState.status === "failed") {
        const nextNodeIds = await this.evaluateRouting(node, nodeState, run, "onFailure");
        for (const nextId of nextNodeIds) {
          const nextNode = run.definition.nodes.find((n) => n.id === nextId);
          if (nextNode && !run.scheduledNodes.has(nextId)) {
            try {
              await this.compileNodeToTask(nextNode, run);
              hasRecoveryChanges = true;
            } catch (error) {
              console.error(`[WorkflowEngine] Recovery: failed to schedule node ${nextId}:`, error);
            }
          }
        }
      }
    }

    for (const key of loopItersToCheck) {
      const sepIdx = key.indexOf(COMPOSITE_SEP);
      const loopNodeId = key.substring(0, sepIdx);
      const iterStr = key.substring(sepIdx + 1);
      const loopNode = findLoopNode(run.definition, loopNodeId);
      if (loopNode) {
        await this.loopCompiler.checkLoopIterationComplete(
          loopNode,
          run,
          parseInt(iterStr, 10)
        );
        hasRecoveryChanges = true;
      }
    }

    await this.checkWorkflowCompletion(run);

    if (hasRecoveryChanges && this.currentProjectId) {
      try {
        await this.persistenceCoordinator.saveImmediate(this.currentProjectId);
      } catch (error) {
        console.error(
          `[WorkflowEngine] Failed to persist recovery changes for workflow ${run.runId}:`,
          error
        );
      }
    }

    if (hasOrphanedTasks && !hasActiveTasks && run.status === "failed") {
      console.warn(
        `[WorkflowEngine] Crash recovery: marked workflow ${run.runId} as failed due to orphaned tasks`
      );
    } else if (hasActiveTasks || nodesToProcess.length > 0) {
      console.log(
        `[WorkflowEngine] Crash recovery: workflow ${run.runId} recovered (${nodesToProcess.length} nodes processed, ${hasActiveTasks ? "active tasks remain" : "no active tasks"})`
      );
    }
  }

  private async schedulePersist(): Promise<void> {
    await this.persistenceCoordinator.schedulePersist(
      this.currentProjectId,
      this.persistenceEnabled
    );
  }

  setPersistenceEnabled(enabled: boolean): void {
    this.persistenceEnabled = enabled;
  }

  async flushPersistence(): Promise<void> {
    await this.persistenceCoordinator.flush(this.currentProjectId);
  }

  async listAllRuns(): Promise<WorkflowRun[]> {
    return Array.from(this.runs.values()).map((run) => ({ ...run }));
  }

  dispose(): void {
    this.isDisposed = true;

    this.approvalManager.dispose();

    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    this.runs.clear();
    this.taskToNode.clear();
  }
}

let workflowEngine: WorkflowEngine | null = null;

export function initializeWorkflowEngine(): WorkflowEngine {
  if (!workflowEngine) {
    workflowEngine = new WorkflowEngine();
  }
  return workflowEngine;
}

export function getWorkflowEngine(): WorkflowEngine | null {
  return workflowEngine;
}

export function disposeWorkflowEngine(): void {
  if (workflowEngine) {
    workflowEngine.dispose();
    workflowEngine = null;
  }
}
