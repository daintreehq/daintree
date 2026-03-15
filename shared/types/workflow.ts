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
 * Node type - 'action' for task execution, 'loop' for bounded retry sub-graphs.
 */
export const WorkflowNodeTypeSchema = z.enum(["action", "approval", "loop"]);
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
 * Configuration for an approval node.
 */
export const WorkflowApprovalConfigSchema = z.object({
  /** Prompt to display to the user when requesting approval */
  prompt: z.string().min(1),
  /** Optional timeout in milliseconds — auto-rejects if exceeded */
  timeoutMs: z.number().positive().optional(),
});
export type WorkflowApprovalConfig = z.infer<typeof WorkflowApprovalConfigSchema>;

/**
 * Configuration for a loop node.
 */
export const WorkflowLoopConfigSchema = z.object({
  /** Maximum number of iterations (1-20) */
  maxIterations: z.number().int().min(1).max(20),
  /** Optional exit condition — loop exits early when this evaluates to true */
  exitCondition: WorkflowConditionSchema.optional(),
});
export type WorkflowLoopConfig = z.infer<typeof WorkflowLoopConfigSchema>;

/** Shared fields for all node types */
const WorkflowNodeBaseFields = {
  id: z.string().min(1),
  label: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  onSuccess: z.array(z.string()).optional(),
  onFailure: z.array(z.string()).optional(),
  conditions: z.array(WorkflowConditionSchema).optional(),
};

/**
 * Action node schema.
 */
export const WorkflowActionNodeSchema = z.object({
  ...WorkflowNodeBaseFields,
  type: z.literal("action"),
  config: WorkflowActionConfigSchema,
});

/**
 * Approval node schema.
 */
export const WorkflowApprovalNodeSchema = z.object({
  ...WorkflowNodeBaseFields,
  type: z.literal("approval"),
  config: WorkflowApprovalConfigSchema,
});

/**
 * Manual TypeScript types — z.infer<> cannot handle recursive schemas.
 */
export interface ActionNode {
  id: string;
  label?: string;
  type: "action";
  config: WorkflowActionConfig;
  dependencies?: string[];
  onSuccess?: string[];
  onFailure?: string[];
  conditions?: WorkflowCondition[];
}

export interface ApprovalNode {
  id: string;
  label?: string;
  type: "approval";
  config: WorkflowApprovalConfig;
  dependencies?: string[];
  onSuccess?: string[];
  onFailure?: string[];
  conditions?: WorkflowCondition[];
}

export interface LoopNode {
  id: string;
  label?: string;
  type: "loop";
  config: WorkflowLoopConfig;
  body: WorkflowNode[];
  dependencies?: string[];
  onSuccess?: string[];
  onFailure?: string[];
  conditions?: WorkflowCondition[];
}

export type WorkflowNode = ActionNode | ApprovalNode | LoopNode;

/**
 * Loop node schema — uses z.lazy() for recursive body reference.
 */
export const WorkflowLoopNodeSchema = z.object({
  ...WorkflowNodeBaseFields,
  type: z.literal("loop"),
  config: WorkflowLoopConfigSchema,
  body: z.lazy(() => z.array(WorkflowNodeSchema).min(1, "Loop body must have at least one node")),
});

/**
 * Recursive workflow node schema (discriminated union of action + approval + loop).
 * Typed as z.ZodType<WorkflowNode> to break TypeScript's infinite instantiation on recursive schemas.
 */
export const WorkflowNodeSchema: z.ZodType<WorkflowNode> = z.lazy(() =>
  z.union([WorkflowActionNodeSchema, WorkflowApprovalNodeSchema, WorkflowLoopNodeSchema])
);

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
  type: "schema" | "cycle" | "reference" | "duplicate" | "loop";
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
