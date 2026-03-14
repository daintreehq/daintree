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
 * Extended node status — TaskState plus approval-specific state.
 * Kept separate from TaskState to avoid breaking task queue type checks.
 */
export type NodeStatus = TaskState | "awaiting-approval";

/**
 * Decision recorded when a human resolves an approval node.
 */
export interface ApprovalDecision {
  approved: boolean;
  feedback?: string;
  resolvedAt: number;
  timedOut?: boolean;
}

/**
 * DTO for pending approval requests — used in IPC/UI payloads.
 */
export interface PendingWorkflowApproval {
  runId: string;
  nodeId: string;
  workflowId: string;
  workflowName: string;
  prompt: string;
  requestedAt: number;
  timeoutMs?: number;
  timeoutAt?: number;
}

/**
 * State of an individual node execution within a workflow run.
 */
export interface NodeState {
  /** Current node status */
  status: NodeStatus;
  /** Task ID if the node has been compiled to a task */
  taskId?: string;
  /** When node execution started (ms since epoch) */
  startedAt?: number;
  /** When node execution completed (ms since epoch) */
  completedAt?: number;
  /** Result of the task execution */
  result?: TaskResult;
  /** Approval decision if this is an approval node that has been resolved */
  approvalDecision?: ApprovalDecision;
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
