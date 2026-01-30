/**
 * WorkflowEngine - Compiles workflow definitions into task queue operations.
 *
 * Loads workflow templates from WorkflowLoader, translates nodes into TaskQueue tasks,
 * subscribes to task completion events, evaluates routing conditions, and tracks
 * workflow run state.
 */

import { randomUUID } from "crypto";
import { events } from "./events.js";
import { workflowLoader, WorkflowLoader } from "./WorkflowLoader.js";
import { taskQueueService, TaskQueueService } from "./TaskQueueService.js";
import type { WorkflowRun, NodeState } from "../../shared/types/workflowRun.js";
import type { WorkflowNode, WorkflowCondition } from "../../shared/types/workflow.js";
import type { TaskRecord } from "../../shared/types/task.js";

export class WorkflowEngine {
  /** Active workflow runs (runId -> WorkflowRun) */
  private runs: Map<string, WorkflowRun> = new Map();

  /** Reverse index for fast lookup (taskId -> { runId, nodeId }) */
  private taskToNode: Map<string, { runId: string; nodeId: string }> = new Map();

  /** Unsubscribe functions for event listeners */
  private unsubscribers: Array<() => void> = [];

  /** Flag to track if engine is disposed */
  private isDisposed = false;

  constructor(
    private loader: WorkflowLoader = workflowLoader,
    private queueService: TaskQueueService = taskQueueService
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

    for (const [nodeId, nodeState] of Object.entries(run.nodeStates)) {
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
  private async compileNodeToTask(node: WorkflowNode, run: WorkflowRun): Promise<TaskRecord> {
    if (run.scheduledNodes.has(node.id)) {
      const existing = await this.queueService.getTask(run.taskMapping[node.id]);
      if (existing) {
        return existing;
      }
    }

    run.scheduledNodes.add(node.id);

    const now = Date.now();

    const nodeState: NodeState = {
      status: "draft",
      startedAt: now,
    };

    run.nodeStates[node.id] = nodeState;

    const dependencies = node.dependencies || [];
    const resolvedDeps: string[] = [];

    for (const depId of dependencies) {
      const taskId = run.taskMapping[depId];
      if (!taskId) {
        throw new Error(
          `Cannot compile node ${node.id}: dependency ${depId} has not been scheduled yet`
        );
      }
      resolvedDeps.push(taskId);
    }

    const task = await this.queueService.createTask({
      title: `Workflow ${run.workflowId} - Node ${node.id}`,
      description: `Execute action: ${node.config.actionId}`,
      priority: 0,
      dependencies: resolvedDeps,
      metadata: {
        workflowRunId: run.runId,
        workflowId: run.workflowId,
        nodeId: node.id,
        actionId: node.config.actionId,
        actionArgs: node.config.args,
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
   * Handle task completion event.
   * Updates node state, evaluates conditions, and schedules next nodes.
   */
  private async handleTaskComplete(payload: {
    taskId: string;
    result: string;
    artifacts?: string[];
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

    nodeState.status = "completed";
    nodeState.completedAt = payload.timestamp;
    nodeState.result = {
      summary: payload.result,
      artifacts: payload.artifacts,
    };

    const definition = run.definition;
    const node = definition.nodes.find((n) => n.id === mapping.nodeId);
    if (!node) {
      console.error(`[WorkflowEngine] Node ${mapping.nodeId} not found in workflow`);
      return;
    }

    const nextNodeIds = await this.evaluateRouting(node, nodeState, run, "onSuccess");

    for (const nextId of nextNodeIds) {
      const nextNode = definition.nodes.find((n) => n.id === nextId);
      if (nextNode && !run.scheduledNodes.has(nextId)) {
        await this.compileNodeToTask(nextNode, run);
      }
    }

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
  }

  /**
   * Dispose the workflow engine.
   * Unsubscribes from events and clears run state.
   */
  dispose(): void {
    this.isDisposed = true;

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
