/**
 * Workflow Execution Run State Types
 *
 * Tracks the runtime state of workflow executions including node states,
 * task mappings, and routing decisions.
 */

import type { TaskState } from "./domain.js";
import type { TaskResult } from "./task.js";
import type { WorkflowCondition } from "./workflow.js";

/**
 * Workflow run status.
 */
export type WorkflowRunStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * State of an individual node execution within a workflow run.
 */
export interface NodeState {
  /** Current task state */
  status: TaskState;
  /** Task ID if the node has been compiled to a task */
  taskId?: string;
  /** When node execution started (ms since epoch) */
  startedAt?: number;
  /** When node execution completed (ms since epoch) */
  completedAt?: number;
  /** Result of the task execution */
  result?: TaskResult;
}

/**
 * State of a loop node execution within a workflow run.
 * Loop body task entries use composite IDs: "loopNodeId|iterIndex|bodyNodeId".
 */
export interface LoopNodeState extends NodeState {
  currentIteration: number;
  maxIterations: number;
  exitedEarly: boolean;
}

/**
 * Record of a condition evaluation for workflow routing.
 */
export interface EvaluatedCondition {
  /** Node ID where this condition was evaluated */
  nodeId: string;
  /** The condition that was evaluated */
  condition: WorkflowCondition;
  /** Result of the evaluation */
  result: boolean;
  /** When the condition was evaluated (ms since epoch) */
  timestamp: number;
}

/**
 * Runtime state of a workflow execution.
 * Tracks all node states, task mappings, and routing decisions.
 */
export interface WorkflowRun {
  /** Unique identifier for this workflow run */
  runId: string;
  /** ID of the workflow being executed */
  workflowId: string;
  /** Version of the workflow definition */
  workflowVersion: string;
  /** Current status of the workflow run */
  status: WorkflowRunStatus;
  /** When the workflow run started (ms since epoch) */
  startedAt: number;
  /** When the workflow run completed (ms since epoch) */
  completedAt?: number;

  /** Snapshot of the workflow definition (to prevent mid-run edits) */
  definition: import("./workflow.js").WorkflowDefinition;

  /** Node execution states (nodeId -> NodeState) */
  nodeStates: Record<string, NodeState>;
  /** Task mapping (nodeId -> taskId) */
  taskMapping: Record<string, string>;

  /** Set of node IDs that have been scheduled (to prevent duplicates) */
  scheduledNodes: Set<string>;

  /** History of evaluated conditions for routing decisions */
  evaluatedConditions: EvaluatedCondition[];
}
