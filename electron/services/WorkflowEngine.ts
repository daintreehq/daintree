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
import type { WorkflowNode, WorkflowCondition } from "../../shared/types/workflow.js";
import type { TaskRecord } from "../../shared/types/task.js";

const TEMPLATE_REGEX = /\{\{\s*([^}]+?)\s*\}\}/g;
const MAX_RESULT_DATA_BYTES = 1_048_576; // 1 MB

export class WorkflowEngine {
  /** Active workflow runs (runId -> WorkflowRun) */
  private runs: Map<string, WorkflowRun> = new Map();

  /** Reverse index for fast lookup (taskId -> { runId, nodeId }) */
  private taskToNode: Map<string, { runId: string; nodeId: string }> = new Map();

  /** Pending approval resolvers keyed by "runId::nodeId" */
  private pendingApprovals: Map<
    string,
    { resolve: (approved: boolean, feedback?: string) => void }
  > = new Map();

  /** Timeout handles for approval nodes with timeoutMs */
  private approvalTimeouts: Map<string, NodeJS.Timeout> = new Map();

  /** Unsubscribe functions for event listeners */
  private unsubscribers: Array<() => void> = [];

  /** Flag to track if engine is disposed */
  private isDisposed = false;

  /** Current project ID for persistence */
  private currentProjectId: string | null = null;

  /** Whether persistence is enabled */
  private persistenceEnabled: boolean = true;

  constructor(
    private loader: WorkflowLoader = workflowLoader,
    private queueService: TaskQueueService = taskQueueService,
    private persistence: WorkflowPersistence = workflowPersistence
  ) {
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

  /**
   * Start a workflow execution.
   * Loads the workflow definition, creates run state, compiles root nodes to tasks,
   * and emits workflow:started event.
   */
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

  /**
   * Cancel a running workflow.
   * Cancels all non-terminal tasks and emits workflow:failed event.
   */
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

    // Clear pending approvals for this run
    this.clearPendingApprovals(runId, "cancelled");

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

  /**
   * Get workflow run state.
   */
  async getWorkflowRun(runId: string): Promise<WorkflowRun | null> {
    const run = this.runs.get(runId);
    return run ? { ...run } : null;
  }

  /**
   * List active workflow runs.
   */
  async listActiveRuns(): Promise<WorkflowRun[]> {
    return Array.from(this.runs.values())
      .filter((run) => run.status === "running")
      .map((run) => ({ ...run }));
  }

  /**
   * Compile a workflow node to a task and enqueue it.
   */
  private async compileNodeToTask(
    node: WorkflowNode,
    run: WorkflowRun
  ): Promise<TaskRecord | null> {
    if (run.scheduledNodes.has(node.id)) {
      if (node.type === "approval") return null;
      const existing = await this.queueService.getTask(run.taskMapping[node.id]);
      if (existing) {
        return existing;
      }
    }

    run.scheduledNodes.add(node.id);

    const now = Date.now();

    // Approval nodes don't create tasks — they suspend the workflow
    if (node.type === "approval") {
      const config = node.config as { prompt: string; timeoutMs?: number };
      const nodeState: NodeState = {
        status: "awaiting-approval",
        startedAt: now,
      };
      run.nodeStates[node.id] = nodeState;

      const timeoutAt = config.timeoutMs ? now + config.timeoutMs : undefined;

      this.setupApprovalWait(run, node.id, config.prompt, config.timeoutMs, timeoutAt);

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
      // Approval nodes don't create tasks — skip them as task dependencies
      const depNode = run.definition.nodes.find((n) => n.id === depId);
      if (depNode?.type === "approval") continue;

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
    if (resolvedArgs && this.hasTemplateExpressions(resolvedArgs)) {
      for (const depId of dependencies) {
        const depState = run.nodeStates[depId];
        if (!depState || depState.status !== "completed") {
          throw new Error(
            `Cannot compile node ${node.id}: dependency ${depId} has not completed yet (status: ${depState?.status ?? "unknown"})`
          );
        }
      }
      try {
        resolvedArgs = this.resolveTemplateArgs(resolvedArgs, run.nodeStates);
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

  /**
   * Set up the internal approval wait: store resolver, start timeout if configured.
   */
  private setupApprovalWait(
    run: WorkflowRun,
    nodeId: string,
    _prompt: string,
    timeoutMs?: number,
    _timeoutAt?: number
  ): void {
    const key = `${run.runId}::${nodeId}`;

    const resolver = (approved: boolean, feedback?: string) => {
      void this.handleApprovalResolution(run.runId, nodeId, approved, feedback);
    };

    this.pendingApprovals.set(key, { resolve: resolver });

    if (timeoutMs) {
      const handle = setTimeout(() => {
        resolver(false, "Approval timed out");
      }, timeoutMs);
      this.approvalTimeouts.set(key, handle);
    }
  }

  /**
   * Internal handler for approval resolution — marks node, emits events, routes downstream.
   */
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

    const key = `${runId}::${nodeId}`;
    this.pendingApprovals.delete(key);

    const timeoutHandle = this.approvalTimeouts.get(key);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      this.approvalTimeouts.delete(key);
    }

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

  /**
   * Resolve a pending approval node.
   * Called via IPC when the user approves or rejects.
   */
  async resolveApproval(
    runId: string,
    nodeId: string,
    approved: boolean,
    feedback?: string
  ): Promise<void> {
    const key = `${runId}::${nodeId}`;
    const pending = this.pendingApprovals.get(key);
    if (!pending) {
      throw new Error(`No pending approval found for run ${runId}, node ${nodeId}`);
    }
    pending.resolve(approved, feedback);
  }

  /**
   * List all currently pending approval requests.
   */
  listPendingApprovals(): PendingWorkflowApproval[] {
    const approvals: PendingWorkflowApproval[] = [];

    for (const [key] of this.pendingApprovals) {
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
        timeoutAt: config.timeoutMs && nodeState.startedAt
          ? nodeState.startedAt + config.timeoutMs
          : undefined,
      });
    }

    return approvals;
  }

  /**
   * Handle task completion event.
   * Updates node state, evaluates conditions, and schedules next nodes.
   */
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

  /**
   * Handle task failure event.
   * Updates node state, evaluates onFailure routing, and may fail the workflow.
   */
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

  /**
   * Evaluate routing logic (onSuccess or onFailure) and conditions.
   * Returns the list of node IDs to schedule next.
   */
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
      const result = this.evaluateCondition(condition, nodeState, run);

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

  /**
   * Evaluate a single condition.
   */
  private evaluateCondition(
    condition: WorkflowCondition,
    nodeState: NodeState,
    run: WorkflowRun
  ): boolean {
    if (condition.type === "status") {
      const targetNodeId = condition.taskId || "";
      const targetState = targetNodeId ? run.nodeStates[targetNodeId] : nodeState;

      if (!targetState) {
        return false;
      }

      const actualValue = targetState.status;
      return this.compareValues(actualValue, condition.op, condition.value);
    }

    if (condition.type === "result") {
      const targetNodeId = condition.taskId || "";
      const targetState = targetNodeId ? run.nodeStates[targetNodeId] : nodeState;

      if (!targetState || !targetState.result) {
        return false;
      }

      const resolvedValue = this.resolveJsonPath(targetState.result, condition.path);
      return this.compareValues(resolvedValue, condition.op, condition.value);
    }

    return false;
  }

  /**
   * Compare two values using an operator.
   */
  private compareValues(actual: unknown, op: string, expected: unknown): boolean {
    switch (op) {
      case "==":
        return actual === expected;
      case "!=":
        return actual !== expected;
      case ">":
        return typeof actual === "number" && typeof expected === "number" && actual > expected;
      case "<":
        return typeof actual === "number" && typeof expected === "number" && actual < expected;
      case ">=":
        return typeof actual === "number" && typeof expected === "number" && actual >= expected;
      case "<=":
        return typeof actual === "number" && typeof expected === "number" && actual <= expected;
      default:
        return false;
    }
  }

  /**
   * Resolve a simple JSONPath expression.
   * Supports basic dot notation (e.g., "summary", "artifacts.0").
   */
  private resolveJsonPath(obj: unknown, path: string): unknown {
    if (!path || !obj || typeof obj !== "object") {
      return undefined;
    }

    const parts = path.split(".");
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || typeof current !== "object") {
        return undefined;
      }

      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }

  /**
   * Resolve template expressions in workflow node args.
   * Supports {{nodeId.path.to.value}} syntax resolved against completed upstream node results.
   * Pure placeholders (entire value is a single {{...}}) return the raw typed value.
   * Embedded placeholders (mixed with text) stringify non-string resolved values.
   */
  private resolveTemplateArgs(
    args: Record<string, unknown>,
    nodeStates: Record<string, NodeState>
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(args)) {
      resolved[key] = this.resolveTemplateValue(value, nodeStates);
    }

    return resolved;
  }

  private hasTemplateExpressions(value: unknown): boolean {
    if (typeof value === "string") {
      TEMPLATE_REGEX.lastIndex = 0;
      return TEMPLATE_REGEX.test(value);
    }
    if (Array.isArray(value)) {
      return value.some((item) => this.hasTemplateExpressions(item));
    }
    if (value !== null && typeof value === "object") {
      return Object.values(value as Record<string, unknown>).some((v) =>
        this.hasTemplateExpressions(v)
      );
    }
    return false;
  }

  private resolveTemplateValue(value: unknown, nodeStates: Record<string, NodeState>): unknown {
    if (typeof value === "string") {
      return this.resolveTemplateString(value, nodeStates);
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.resolveTemplateValue(item, nodeStates));
    }

    if (value !== null && typeof value === "object") {
      const resolved: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        resolved[k] = this.resolveTemplateValue(v, nodeStates);
      }
      return resolved;
    }

    return value;
  }

  private resolveTemplateString(value: string, nodeStates: Record<string, NodeState>): unknown {
    const pureMatch = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
    if (pureMatch) {
      return this.resolveExpression(pureMatch[1], nodeStates);
    }

    TEMPLATE_REGEX.lastIndex = 0;
    if (!TEMPLATE_REGEX.test(value)) {
      return value;
    }

    TEMPLATE_REGEX.lastIndex = 0;
    return value.replace(TEMPLATE_REGEX, (_match, expression: string) => {
      const resolved = this.resolveExpression(expression, nodeStates);
      if (typeof resolved === "string") {
        return resolved;
      }
      return JSON.stringify(resolved);
    });
  }

  private resolveExpression(expression: string, nodeStates: Record<string, NodeState>): unknown {
    const dotIndex = expression.indexOf(".");
    if (dotIndex === -1) {
      throw new Error(
        `Invalid template expression "{{${expression}}}": must be in format {{nodeId.path}}`
      );
    }

    const nodeId = expression.substring(0, dotIndex);
    const path = expression.substring(dotIndex + 1);

    const nodeState = nodeStates[nodeId];
    if (!nodeState) {
      throw new Error(
        `Template expression "{{${expression}}}": node "${nodeId}" not found in workflow`
      );
    }

    if (nodeState.status !== "completed" || !nodeState.result) {
      throw new Error(
        `Template expression "{{${expression}}}": node "${nodeId}" has not completed (status: ${nodeState.status})`
      );
    }

    return this.resolveJsonPath(nodeState.result, path);
  }

  /**
   * Mark a node as failed and evaluate onFailure routing.
   */
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

  /**
   * Check if the workflow is complete (all scheduled nodes are in terminal states).
   * If complete, emit workflow:completed or workflow:failed event.
   */
  private async checkWorkflowCompletion(run: WorkflowRun): Promise<void> {
    if (run.status !== "running") {
      return;
    }

    const scheduledNodeIds = Array.from(run.scheduledNodes);
    const allScheduledNodesTerminal = scheduledNodeIds.every((nodeId) => {
      const nodeState = run.nodeStates[nodeId];
      if (!nodeState) {
        return false;
      }
      return (
        nodeState.status === "completed" ||
        nodeState.status === "failed" ||
        nodeState.status === "cancelled"
      );
      // Note: "awaiting-approval" is NOT terminal — workflow stays running
    });

    if (!allScheduledNodesTerminal) {
      return;
    }

    const anyScheduledNodeFailed = scheduledNodeIds.some((nodeId) => {
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

  /**
   * Initialize the engine for a project.
   * Loads persisted workflow runs and rebuilds taskToNode index.
   * For runs in "running" status, checks task queue state and handles orphaned workflows.
   */
  async initialize(projectId: string): Promise<void> {
    this.currentProjectId = projectId;
    await this.loadFromDisk(projectId);
  }

  /**
   * Handle project switch: flush pending saves, clear memory, load new project's workflow runs.
   */
  async onProjectSwitch(newProjectId?: string): Promise<void> {
    if (this.currentProjectId) {
      await this.persistence.flush(this.currentProjectId);
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

  /**
   * Load workflow runs from disk for a project.
   * Rebuilds the taskToNode reverse index.
   * Handles crash recovery for running workflows.
   */
  private async loadFromDisk(projectId: string): Promise<void> {
    if (!this.persistenceEnabled) return;

    const loadedRuns = await this.persistence.load(projectId);
    this.runs.clear();
    this.taskToNode.clear();

    for (const run of loadedRuns) {
      this.runs.set(run.runId, run);

      // Rebuild taskToNode reverse index
      for (const [nodeId, taskId] of Object.entries(run.taskMapping)) {
        this.taskToNode.set(taskId, { runId: run.runId, nodeId });
      }
    }

    // Crash recovery: handle workflows that were running when the app restarted
    for (const run of this.runs.values()) {
      if (run.status === "running") {
        await this.handleRunningWorkflowRecovery(run);
      }
    }

    console.log(`[WorkflowEngine] Loaded ${this.runs.size} workflow runs for project ${projectId}`);
  }

  /**
   * Handle recovery for a workflow that was running when the app restarted.
   * Checks if tasks are still active in the task queue and marks orphaned workflows as failed.
   * For tasks that completed/failed while down, re-runs routing logic to schedule downstream nodes.
   */
  private async handleRunningWorkflowRecovery(run: WorkflowRun): Promise<void> {
    let hasOrphanedTasks = false;
    let hasActiveTasks = false;
    let hasRecoveryChanges = false;

    // Track nodes that completed/failed while we were down (need routing)
    const nodesToProcess: Array<{ nodeId: string; nodeState: NodeState }> = [];

    for (const [nodeId, nodeState] of Object.entries(run.nodeStates)) {
      if (
        nodeState.status === "completed" ||
        nodeState.status === "failed" ||
        nodeState.status === "cancelled"
      ) {
        continue;
      }

      // Handle approval nodes that were awaiting approval when app restarted
      if (nodeState.status === "awaiting-approval") {
        const node = run.definition.nodes.find((n) => n.id === nodeId);
        if (!node || node.type !== "approval") continue;

        const config = node.config as { prompt: string; timeoutMs?: number };
        const timeoutAt =
          config.timeoutMs && nodeState.startedAt
            ? nodeState.startedAt + config.timeoutMs
            : undefined;

        // If timeout has expired, auto-reject
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
          // Re-emit the approval request to re-surface in UI
          const remainingTimeout = timeoutAt ? timeoutAt - Date.now() : config.timeoutMs;
          this.setupApprovalWait(run, nodeId, config.prompt, remainingTimeout, timeoutAt);

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

      // Check if the task still exists in the queue
      const task = await this.queueService.getTask(nodeState.taskId);

      if (!task) {
        // Task is missing from queue - mark node as failed
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
        // Task completed while we were down
        nodeState.status = "completed";
        nodeState.completedAt = task.completedAt ?? Date.now();
        nodeState.result = task.result;
        hasRecoveryChanges = true;
        nodesToProcess.push({ nodeId, nodeState });
      } else if (task.status === "failed" || task.status === "cancelled") {
        // Task failed/cancelled while we were down
        nodeState.status = task.status;
        nodeState.completedAt = task.completedAt ?? Date.now();
        nodeState.result = task.result;
        hasOrphanedTasks = true;
        hasRecoveryChanges = true;
        nodesToProcess.push({ nodeId, nodeState });
      } else {
        // Task is still active (queued, blocked, running)
        hasActiveTasks = true;
      }
    }

    // Process routing for nodes that reached terminal states while down
    for (const { nodeId, nodeState } of nodesToProcess) {
      const node = run.definition.nodes.find((n) => n.id === nodeId);
      if (!node) {
        console.error(`[WorkflowEngine] Recovery: node ${nodeId} not found in workflow definition`);
        continue;
      }

      // Re-run routing logic based on the node's terminal state
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

    // Check workflow completion after processing recovered nodes
    await this.checkWorkflowCompletion(run);

    // Persist recovery changes immediately (bypass debounce since this is initialization)
    if (hasRecoveryChanges && this.currentProjectId) {
      try {
        const runsArray = Array.from(this.runs.values());
        await this.persistence.flush(this.currentProjectId);
        await this.persistence.save(this.currentProjectId, runsArray);
        await this.persistence.flush(this.currentProjectId);
      } catch (error) {
        console.error(
          `[WorkflowEngine] Failed to persist recovery changes for workflow ${run.runId}:`,
          error
        );
      }
    }

    // Log recovery summary
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

  /**
   * Schedule a debounced persistence save.
   * Swallows errors to prevent unhandled rejections in event handlers.
   */
  private async schedulePersist(): Promise<void> {
    if (!this.persistenceEnabled || !this.currentProjectId) return;

    try {
      const runsArray = Array.from(this.runs.values());
      await this.persistence.save(this.currentProjectId, runsArray);
    } catch (error) {
      console.error("[WorkflowEngine] Failed to persist workflow state:", error);
    }
  }

  /**
   * Enable or disable persistence (useful for testing).
   */
  setPersistenceEnabled(enabled: boolean): void {
    this.persistenceEnabled = enabled;
  }

  /**
   * Force an immediate save to disk.
   */
  async flushPersistence(): Promise<void> {
    if (!this.currentProjectId) return;
    await this.persistence.flush(this.currentProjectId);
  }

  /**
   * List all workflow runs (for debugging/UI).
   */
  async listAllRuns(): Promise<WorkflowRun[]> {
    return Array.from(this.runs.values()).map((run) => ({ ...run }));
  }

  /**
   * Clear all pending approval resolvers and timeouts for a given run (or all runs).
   */
  private clearPendingApprovals(
    runId?: string,
    reason: "resolved" | "cancelled" | "timeout" = "cancelled"
  ): void {
    const now = Date.now();
    const keysToRemove: string[] = [];

    for (const [key] of this.pendingApprovals) {
      if (!runId || key.startsWith(`${runId}::`)) {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      this.pendingApprovals.delete(key);
      const timeoutHandle = this.approvalTimeouts.get(key);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        this.approvalTimeouts.delete(key);
      }
      const [rId, nId] = key.split("::");
      events.emit("workflow:approval-cleared", {
        runId: rId,
        nodeId: nId,
        reason,
        timestamp: now,
      });
    }
  }

  /**
   * Dispose the workflow engine.
   * Unsubscribes from events and clears run state.
   */
  dispose(): void {
    this.isDisposed = true;

    this.clearPendingApprovals(undefined, "cancelled");

    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    this.runs.clear();
    this.taskToNode.clear();
  }
}

let workflowEngine: WorkflowEngine | null = null;

/**
 * Initialize the workflow engine singleton.
 */
export function initializeWorkflowEngine(): WorkflowEngine {
  if (!workflowEngine) {
    workflowEngine = new WorkflowEngine();
  }
  return workflowEngine;
}

/**
 * Get the workflow engine instance.
 */
export function getWorkflowEngine(): WorkflowEngine | null {
  return workflowEngine;
}

/**
 * Dispose the workflow engine singleton.
 */
export function disposeWorkflowEngine(): void {
  if (workflowEngine) {
    workflowEngine.dispose();
    workflowEngine = null;
  }
}
