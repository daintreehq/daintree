/**
 * Workflow Definition Types
 *
 * Declarative workflow templates that compile to task queue operations.
 * Workflows are JSON templates defining multi-step processes like "Standard PR Review".
 */

import { z } from "zod";

/**
 * Condition operators for workflow routing decisions.
 */
export const WorkflowConditionOpSchema = z.enum(["==", "!=", ">", "<", ">=", "<="]);
export type WorkflowConditionOp = z.infer<typeof WorkflowConditionOpSchema>;

/**
 * Declarative condition for workflow routing.
 * Simple predicate objects that avoid arbitrary JS expressions.
 */
export const WorkflowConditionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("status"),
    /** Task ID to check (defaults to current task if not specified) */
    taskId: z.string().optional(),
    /** Comparison operator */
    op: WorkflowConditionOpSchema,
    /** Value to compare against */
    value: z.unknown(),
  }),
  z.object({
    type: z.literal("result"),
    /** Task ID to check (defaults to current task if not specified) */
    taskId: z.string().optional(),
    /** JSONPath for result inspection (required for result type) */
    path: z.string().min(1),
    /** Comparison operator */
    op: WorkflowConditionOpSchema,
    /** Value to compare against */
    value: z.unknown(),
  }),
]);
export type WorkflowCondition = z.infer<typeof WorkflowConditionSchema>;

/**
 * Node type - currently only 'action' is supported.
 * Future types could include 'command' for shell commands or 'recipe' for terminal recipes.
 */
export const WorkflowNodeTypeSchema = z.enum(["action"]);
export type WorkflowNodeType = z.infer<typeof WorkflowNodeTypeSchema>;

/**
 * Configuration for an action node.
 */
export const WorkflowActionConfigSchema = z.object({
  /** Action ID from ActionService (e.g., "terminal.executeCommand") */
  actionId: z.string().min(1),
  /** Arguments to pass to the action */
  args: z.record(z.string(), z.unknown()).optional(),
});
export type WorkflowActionConfig = z.infer<typeof WorkflowActionConfigSchema>;

/**
 * A node in the workflow graph.
 * Nodes represent individual steps with dependencies and routing.
 */
export const WorkflowNodeSchema = z.object({
  /** Unique identifier within the workflow */
  id: z.string().min(1),
  /** Node type - determines what config is expected */
  type: WorkflowNodeTypeSchema,
  /** Configuration for this node (varies by type) */
  config: WorkflowActionConfigSchema,
  /** Node IDs this node depends on (must complete before this runs) */
  dependencies: z.array(z.string()).optional(),
  /** Node IDs to run on successful completion */
  onSuccess: z.array(z.string()).optional(),
  /** Node IDs to run on failure */
  onFailure: z.array(z.string()).optional(),
  /** Declarative conditions for advanced routing */
  conditions: z.array(WorkflowConditionSchema).optional(),
});
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

/**
 * Complete workflow definition.
 * Contains metadata and the node graph.
 */
export const WorkflowDefinitionSchema = z.object({
  /** Unique identifier for this workflow */
  id: z.string().min(1),
  /** Semantic version for schema migrations */
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "Version must be semver format (e.g., 1.0.0)"),
  /** Human-readable name */
  name: z.string().min(1),
  /** Optional description of what the workflow does */
  description: z.string().optional(),
  /** The workflow graph nodes */
  nodes: z.array(WorkflowNodeSchema).min(1, "Workflow must have at least one node"),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

/**
 * Result of workflow validation.
 */
export interface WorkflowValidationResult {
  /** Whether the workflow is valid */
  valid: boolean;
  /** Validation errors if invalid */
  errors?: WorkflowValidationError[];
  /** Warning messages (workflow is valid but has issues) */
  warnings?: string[];
}

/**
 * A single validation error.
 */
export interface WorkflowValidationError {
  /** Error type */
  type: "schema" | "cycle" | "reference" | "duplicate";
  /** Human-readable error message */
  message: string;
  /** Path to the error (e.g., "nodes[0].id") */
  path?: string;
  /** Additional error details */
  details?: unknown;
}

/**
 * Loaded workflow with source information.
 */
export interface LoadedWorkflow {
  /** The validated workflow definition */
  definition: WorkflowDefinition;
  /** Source of the workflow (built-in, project, user) */
  source: WorkflowSource;
  /** File path if loaded from disk */
  filePath?: string;
  /** Load timestamp */
  loadedAt: number;
}

/**
 * Where a workflow was loaded from.
 */
export type WorkflowSource = "built-in" | "project" | "user";

/**
 * Summary information about a workflow (for listing).
 */
export interface WorkflowSummary {
  /** Workflow ID */
  id: string;
  /** Workflow name */
  name: string;
  /** Optional description */
  description?: string;
  /** Version string */
  version: string;
  /** Number of nodes in the workflow */
  nodeCount: number;
  /** Source of the workflow */
  source: WorkflowSource;
}
