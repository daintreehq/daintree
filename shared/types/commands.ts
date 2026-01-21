/**
 * Core command types for Canopy's global command system.
 * Commands are executable operations that can be invoked from terminals,
 * UI, or AI agents.
 */

/** Command categories for grouping and discovery */
export type CommandCategory = "github" | "git" | "workflow" | "project" | "system";

/** Supported argument value types */
export type CommandArgumentType = "string" | "number" | "boolean" | "select";

/** Definition for a single command argument */
export interface CommandArgument {
  /** Unique name for this argument (e.g., "issueNumber", "branchName") */
  name: string;
  /** Argument value type */
  type: CommandArgumentType;
  /** Human-readable description */
  description: string;
  /** Whether this argument is required */
  required: boolean;
  /** Default value if not provided */
  default?: string | number | boolean;
  /** Available choices for select type */
  choices?: Array<{ value: string; label: string }>;
}

/** Execution context passed to commands */
export interface CommandContext {
  /** ID of the terminal executing this command (if applicable) */
  terminalId?: string;
  /** ID of the worktree this command is executed in */
  worktreeId?: string;
  /** ID of the current project */
  projectId?: string;
  /** Current working directory */
  cwd?: string;
  /** ID of the agent executing this command (if applicable) */
  agentId?: string;
}

/** Result returned from command execution */
export interface CommandResult<T = unknown> {
  /** Whether execution succeeded */
  success: boolean;
  /** Human-readable message about the result */
  message?: string;
  /** Optional data payload */
  data?: T;
  /** Error details if success is false */
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** Field types for command builder UI */
export type BuilderFieldType = "text" | "number" | "select" | "checkbox" | "textarea";

/** Validation rules for builder fields */
export interface BuilderFieldValidation {
  /** Minimum value (for number fields) or minimum length (for text) */
  min?: number;
  /** Maximum value (for number fields) or maximum length (for text) */
  max?: number;
  /** Regex pattern to match (for text fields) */
  pattern?: string;
  /** Error message when validation fails */
  message?: string;
}

/** Field definition for command builder UI */
export interface BuilderField {
  /** Unique field identifier (maps to argument name) */
  name: string;
  /** Display label */
  label: string;
  /** Field input type */
  type: BuilderFieldType;
  /** Placeholder text */
  placeholder?: string;
  /** Whether field is required (deprecated - all fields are now optional) */
  required?: boolean;
  /** Validation rules */
  validation?: BuilderFieldValidation;
  /** Options for select fields */
  options?: Array<{ value: string; label: string }>;
  /** Help text shown below field */
  helpText?: string;
}

/** Step in a multi-step command builder */
export interface BuilderStep {
  /** Unique step identifier */
  id: string;
  /** Step title */
  title: string;
  /** Step description */
  description?: string;
  /** Fields to collect in this step */
  fields: BuilderField[];
}

/** Command definition */
export interface CanopyCommand<TArgs = Record<string, unknown>, TResult = unknown> {
  /** Unique command identifier using colon namespace (e.g., "github:create-issue") */
  id: string;
  /** Human-readable label */
  label: string;
  /** Brief description of what the command does */
  description: string;
  /** Category for grouping */
  category: CommandCategory;
  /** Command arguments definition */
  args?: CommandArgument[];
  /** Execute the command */
  execute: (context: CommandContext, args: TArgs) => Promise<CommandResult<TResult>>;
  /** Optional builder configuration for interactive UI */
  builder?: {
    /** Builder steps (single step if only one) */
    steps: BuilderStep[];
  };
  /** Keywords for search/discovery */
  keywords?: string[];
  /** Whether command is currently available */
  isEnabled?: (context: CommandContext) => boolean;
  /** Reason why command is disabled */
  disabledReason?: (context: CommandContext) => string | undefined;
}

/** Command manifest entry for introspection (without execute function) */
export interface CommandManifestEntry {
  /** Unique command identifier */
  id: string;
  /** Human-readable label */
  label: string;
  /** Brief description */
  description: string;
  /** Category */
  category: CommandCategory;
  /** Argument definitions */
  args?: CommandArgument[];
  /** Keywords for search */
  keywords?: string[];
  /** Whether command has a builder UI */
  hasBuilder: boolean;
  /** Whether command is currently enabled */
  enabled: boolean;
  /** Reason if disabled */
  disabledReason?: string;
}

/** Payload for executing a command via IPC */
export interface CommandExecutePayload {
  /** Command ID to execute */
  commandId: string;
  /** Execution context */
  context: CommandContext;
  /** Command arguments */
  args?: Record<string, unknown>;
}

/** Payload for getting a single command */
export interface CommandGetPayload {
  /** Command ID to retrieve */
  commandId: string;
  /** Context for checking enabled state */
  context?: CommandContext;
}
