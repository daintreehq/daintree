/**
 * Task Queue Types
 *
 * Core types for DAG-based task management.
 * Tasks represent units of work with dependencies that form a directed acyclic graph.
 */

import type { TaskState } from "./domain.js";
import type { AgentDomainWeights } from "./agentSettings.js";

/**
 * Routing hints for intelligent agent assignment.
 * Used by the router to select the best agent for a task.
 */
export interface TaskRoutingHints {
  /** Capabilities the agent must have (e.g., ['javascript', 'react']) */
  requiredCapabilities?: string[];
  /** Domains where the agent should be strong (e.g., ['frontend', 'testing']) */
  preferredDomains?: (keyof AgentDomainWeights)[];
}

/**
 * Result of a completed task.
 */
export interface TaskResult {
  /** Summary of what was accomplished */
  summary?: string;
  /** List of artifact paths or identifiers produced */
  artifacts?: string[];
  /** Error message if task failed */
  error?: string;
}

/**
 * A task record in the queue.
 * Tasks can have dependencies on other tasks, forming a DAG.
 */
export interface TaskRecord {
  /** Unique identifier for this task */
  id: string;
  /** Human-readable title */
  title: string;
  /** Optional detailed description */
  description?: string;
  /** Current state: draft | queued | running | blocked | completed | failed | cancelled */
  status: TaskState;
  /** Priority level (higher wins; tie-break on createdAt) */
  priority: number;

  // Timestamps
  /** When the task was created (ms since epoch) */
  createdAt: number;
  /** When the task was last updated (ms since epoch) */
  updatedAt: number;
  /** When the task was moved to queued state */
  queuedAt?: number;
  /** When the task started running */
  startedAt?: number;
  /** When the task completed (success, failure, or cancellation) */
  completedAt?: number;

  // DAG structure
  /** Task IDs this task depends on (incoming edges) */
  dependencies: string[];
  /** Derived: only the unmet dependencies (computed, not stored) */
  blockedBy?: string[];
  /** Reverse index: tasks that depend on this one (for fast unblocking) */
  dependents?: string[];

  // Orchestration context
  /** Associated worktree ID for isolated execution */
  worktreeId?: string;
  /** Agent ID if assigned to an agent */
  assignedAgentId?: string;
  /** Correlation ID for the current run attempt */
  runId?: string;
  /** Arbitrary metadata for extensions */
  metadata?: Record<string, unknown>;
  /** Result of task execution */
  result?: TaskResult;
  /** Routing hints for agent assignment */
  routingHints?: TaskRoutingHints;
}

/**
 * Parameters for creating a new task.
 */
export interface CreateTaskParams {
  /** Human-readable title (required) */
  title: string;
  /** Optional detailed description */
  description?: string;
  /** Priority level (default: 0) */
  priority?: number;
  /** Task IDs this task depends on */
  dependencies?: string[];
  /** Associated worktree ID */
  worktreeId?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
  /** Routing hints for agent assignment */
  routingHints?: TaskRoutingHints;
}

/**
 * Filter options for listing tasks.
 */
export interface TaskFilter {
  /** Filter by status */
  status?: TaskState | TaskState[];
  /** Filter by worktree */
  worktreeId?: string;
  /** Filter by assigned agent */
  assignedAgentId?: string;
  /** Only include tasks with no unmet dependencies */
  ready?: boolean;
  /** Limit number of results */
  limit?: number;
  /** Sort order (default: priority desc, createdAt asc) */
  sortBy?: "priority" | "createdAt" | "updatedAt";
  /** Sort direction */
  sortOrder?: "asc" | "desc";
}

/**
 * Result of a DAG validation check.
 */
export interface DagValidationResult {
  /** Whether the DAG is valid (acyclic) */
  valid: boolean;
  /** If invalid, the cycle path */
  cycle?: string[];
  /** Error message if invalid */
  error?: string;
}

/**
 * Event payload for task state changes.
 * Used by the event system to notify listeners.
 */
export interface TaskStateChangePayload {
  taskId: string;
  previousState: TaskState;
  state: TaskState;
  timestamp: number;
}
