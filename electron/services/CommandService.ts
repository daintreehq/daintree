/**
 * Command registry and execution service.
 * Manages registration, retrieval, and execution of Daintree commands.
 */

import type {
  DaintreeCommand,
  CommandContext,
  CommandManifestEntry,
  CommandResult,
  CommandOverride,
  CommandArgument,
} from "../../shared/types/commands.js";
import { projectStore } from "./ProjectStore.js";
import { substituteTemplateVariables } from "../../shared/utils/promptTemplate.js";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

class CommandServiceImpl {
  private commands = new Map<string, DaintreeCommand>();

  /**
   * Load command overrides for a project.
   * @param projectId Project ID to load overrides for
   * @returns Map of command ID to override
   */
  private async loadProjectOverrides(projectId: string): Promise<Map<string, CommandOverride>> {
    const overrideMap = new Map<string, CommandOverride>();
    try {
      const settings = await projectStore.getProjectSettings(projectId);
      if (settings.commandOverrides) {
        for (const override of settings.commandOverrides) {
          overrideMap.set(override.commandId, override);
        }
      }
    } catch (error) {
      console.error(`[CommandService] Failed to load overrides for project ${projectId}:`, error);
    }
    return overrideMap;
  }

  /**
   * Register a command with the service.
   * @throws Error if command with same ID is already registered
   */
  register<TArgs = Record<string, unknown>, TResult = unknown>(
    command: DaintreeCommand<TArgs, TResult>
  ): void {
    if (this.commands.has(command.id)) {
      throw new Error(`Command "${command.id}" is already registered`);
    }
    this.commands.set(command.id, command as DaintreeCommand);
  }

  /**
   * Unregister a command by ID.
   * @returns true if command was removed, false if not found
   */
  unregister(id: string): boolean {
    return this.commands.delete(id);
  }

  /**
   * Get a command by ID.
   * @returns The command or undefined if not found
   */
  get(id: string): DaintreeCommand | undefined {
    return this.commands.get(id);
  }

  /**
   * Check if a command is registered.
   */
  has(id: string): boolean {
    return this.commands.has(id);
  }

  /**
   * List all registered commands as manifest entries.
   * @param context Optional context for checking enabled state
   */
  async list(context?: CommandContext): Promise<CommandManifestEntry[]> {
    const entries: CommandManifestEntry[] = [];
    const safeContext = context ?? {};

    // Load project overrides if projectId is provided
    let overrideMap: Map<string, CommandOverride> | null = null;
    if (safeContext.projectId) {
      overrideMap = await this.loadProjectOverrides(safeContext.projectId);
    }

    for (const command of Array.from(this.commands.values())) {
      try {
        // Check if command is disabled by project override
        const override = overrideMap?.get(command.id);
        if (override?.disabled) {
          // Include disabled commands with enabled: false for discoverability
          entries.push({
            id: command.id,
            label: command.label,
            description: command.description,
            category: command.category,
            args: command.args,
            keywords: command.keywords,
            hasBuilder: !!command.builder,
            enabled: false,
            disabledReason: "Disabled for this project",
          });
          continue;
        }

        const enabled = command.isEnabled ? command.isEnabled(safeContext) : true;
        const disabledReason =
          !enabled && command.disabledReason ? command.disabledReason(safeContext) : undefined;

        entries.push({
          id: command.id,
          label: command.label,
          description: command.description,
          category: command.category,
          args: command.args,
          keywords: command.keywords,
          hasBuilder: !!command.builder,
          enabled,
          disabledReason,
        });
      } catch {
        entries.push({
          id: command.id,
          label: command.label,
          description: command.description,
          category: command.category,
          args: command.args,
          keywords: command.keywords,
          hasBuilder: !!command.builder,
          enabled: false,
          disabledReason: "Error evaluating command state",
        });
      }
    }

    return entries.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * List commands filtered by category.
   */
  async listByCategory(
    category: string,
    context?: CommandContext
  ): Promise<CommandManifestEntry[]> {
    const commands = await this.list(context);
    return commands.filter((cmd) => cmd.category === category);
  }

  /**
   * Execute a command by ID.
   * @param id Command ID
   * @param context Execution context
   * @param args Command arguments
   * @returns Command result
   */
  async execute<TResult = unknown>(
    id: string,
    context: CommandContext,
    args: Record<string, unknown> = {}
  ): Promise<CommandResult<TResult>> {
    const command = this.commands.get(id);

    if (!command) {
      return {
        success: false,
        error: {
          code: "COMMAND_NOT_FOUND",
          message: `Command "${id}" not found`,
        },
      };
    }

    // Load project overrides if projectId is provided
    let override: CommandOverride | undefined;
    if (context.projectId) {
      const overrideMap = await this.loadProjectOverrides(context.projectId);
      override = overrideMap.get(id);
    }

    // Check if command is disabled by project override
    if (override?.disabled) {
      return {
        success: false,
        error: {
          code: "COMMAND_DISABLED",
          message: `Command "${id}" is disabled for this project`,
        },
      };
    }

    // Validate args is a plain object (treat null as empty object)
    if (args === null) {
      args = {};
    }
    if (typeof args !== "object" || Array.isArray(args)) {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENTS",
          message: "Arguments must be a plain object",
        },
      };
    }

    // Check if command is enabled (with error handling)
    try {
      if (command.isEnabled && !command.isEnabled(context)) {
        const reason = command.disabledReason
          ? command.disabledReason(context)
          : "Command is currently disabled";
        return {
          success: false,
          error: {
            code: "COMMAND_DISABLED",
            message: reason ?? "Command is currently disabled",
          },
        };
      }
    } catch {
      return {
        success: false,
        error: {
          code: "COMMAND_DISABLED",
          message: "Error evaluating command state",
        },
      };
    }

    // Validate provided arguments against command definition
    if (command.args) {
      const validArgNames = new Set(command.args.map((a) => a.name));
      const providedKeys = Object.keys(args).filter((key) => !DANGEROUS_KEYS.has(key));
      const unknownKeys = providedKeys.filter((k) => !validArgNames.has(k));
      if (unknownKeys.length > 0) {
        return {
          success: false,
          error: {
            code: "UNKNOWN_ARGUMENTS",
            message: `Unknown argument(s): ${unknownKeys.join(", ")}`,
            details: { unknownArguments: unknownKeys },
          },
        };
      }

      // Validate argument types
      for (const argDef of command.args) {
        const value = args[argDef.name];
        if (value != null) {
          const typeError = this.validateArgumentType(argDef, value);
          if (typeError) {
            return {
              success: false,
              error: {
                code: "INVALID_ARGUMENT_TYPE",
                message: typeError,
                details: { argument: argDef.name },
              },
            };
          }
        }
      }
    }

    // Build effective arguments with defaults (command defaults < override defaults < provided args)
    const effectiveArgs: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(args)) {
      if (DANGEROUS_KEYS.has(key)) continue;
      effectiveArgs[key] = value;
    }

    // First, apply command-level defaults
    if (command.args) {
      for (const argDef of command.args) {
        const hasArg =
          Object.prototype.hasOwnProperty.call(effectiveArgs, argDef.name) &&
          effectiveArgs[argDef.name] != null;

        if (!hasArg && argDef.default !== undefined) {
          effectiveArgs[argDef.name] = argDef.default;
        }
      }
    }

    // Second, apply override defaults (if they exist), filtering dangerous keys
    if (override?.defaults) {
      for (const [key, value] of Object.entries(override.defaults)) {
        // Skip dangerous prototype pollution keys
        if (DANGEROUS_KEYS.has(key)) continue;

        // Only apply override default if not provided by caller
        const hasArg = Object.prototype.hasOwnProperty.call(args, key) && args[key] != null;
        if (!hasArg) {
          // Coerce string values to appropriate types based on arg definition
          const argDef = command.args?.find((a) => a.name === key);
          if (argDef && typeof value === "string") {
            effectiveArgs[key] = this.coerceValue(value, argDef.type);
          } else {
            effectiveArgs[key] = value;
          }
        }
      }
    }

    if (command.args) {
      for (const argDef of command.args) {
        const value = effectiveArgs[argDef.name];
        if (value != null) {
          const typeError = this.validateArgumentType(argDef, value);
          if (typeError) {
            return {
              success: false,
              error: {
                code: "INVALID_ARGUMENT_TYPE",
                message: typeError,
                details: { argument: argDef.name },
              },
            };
          }
        }
      }
    }

    // Check for custom prompt override - if present, return the prompt instead of executing
    // Treat empty/whitespace-only prompts as if no override exists
    if (override?.prompt && override.prompt.trim() !== "") {
      const substitutionResult = substituteTemplateVariables(override.prompt, effectiveArgs);

      if (!substitutionResult.success) {
        return {
          success: false,
          error: {
            code: "PROMPT_SUBSTITUTION_ERROR",
            message: substitutionResult.error || "Failed to substitute template variables",
            details: { missingVariables: substitutionResult.missingVariables },
          },
        };
      }

      return {
        success: true,
        message: `Custom prompt for "${id}"`,
        prompt: substitutionResult.prompt,
      };
    }

    // Finally, check for missing required arguments (only for normal execution)
    if (command.args) {
      for (const argDef of command.args) {
        const hasArg =
          Object.prototype.hasOwnProperty.call(effectiveArgs, argDef.name) &&
          effectiveArgs[argDef.name] != null;

        if (argDef.required && !hasArg) {
          return {
            success: false,
            error: {
              code: "MISSING_ARGUMENT",
              message: `Required argument "${argDef.name}" is missing`,
              details: { argument: argDef.name },
            },
          };
        }
      }
    }

    try {
      const result = await command.execute(context, effectiveArgs);
      return result as CommandResult<TResult>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Only include stack traces in development mode
      const isDev = process.env.NODE_ENV === "development";
      return {
        success: false,
        error: {
          code: "EXECUTION_ERROR",
          message,
          details: isDev && err instanceof Error ? { stack: err.stack } : undefined,
        },
      };
    }
  }

  /**
   * Validate argument value against its type definition.
   */
  private validateArgumentType(argDef: CommandArgument, value: unknown): string | null {
    switch (argDef.type) {
      case "string":
        if (typeof value !== "string") {
          return `Argument "${argDef.name}" must be a string`;
        }
        break;
      case "number":
        if (typeof value !== "number" || isNaN(value)) {
          return `Argument "${argDef.name}" must be a number`;
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          return `Argument "${argDef.name}" must be a boolean`;
        }
        break;
      case "select":
        if (typeof value !== "string") {
          return `Argument "${argDef.name}" must be a string`;
        }
        if (argDef.choices && !argDef.choices.some((c) => c.value === value)) {
          return `Argument "${argDef.name}" must be one of: ${argDef.choices.map((c) => c.value).join(", ")}`;
        }
        break;
    }
    return null;
  }

  /**
   * Coerce a string value to the appropriate type.
   */
  private coerceValue(value: string, type: CommandArgument["type"]): string | number | boolean {
    switch (type) {
      case "number": {
        const num = Number(value);
        return isNaN(num) ? value : num;
      }
      case "boolean":
        return value === "true" || value === "1";
      default:
        return value;
    }
  }

  /**
   * Get manifest entry for a single command.
   */
  async getManifest(
    id: string,
    context?: CommandContext
  ): Promise<CommandManifestEntry | undefined> {
    const command = this.commands.get(id);
    if (!command) return undefined;

    const safeContext = context ?? {};

    // Load project overrides if projectId is provided
    let override: CommandOverride | undefined;
    if (safeContext.projectId) {
      const overrideMap = await this.loadProjectOverrides(safeContext.projectId);
      override = overrideMap.get(id);
    }

    // If disabled by project override, return null or disabled entry
    if (override?.disabled) {
      return {
        id: command.id,
        label: command.label,
        description: command.description,
        category: command.category,
        args: command.args,
        keywords: command.keywords,
        hasBuilder: !!command.builder,
        enabled: false,
        disabledReason: "Disabled for this project",
      };
    }

    try {
      const enabled = command.isEnabled ? command.isEnabled(safeContext) : true;
      const disabledReason =
        !enabled && command.disabledReason ? command.disabledReason(safeContext) : undefined;

      return {
        id: command.id,
        label: command.label,
        description: command.description,
        category: command.category,
        args: command.args,
        keywords: command.keywords,
        hasBuilder: !!command.builder,
        enabled,
        disabledReason,
      };
    } catch {
      return {
        id: command.id,
        label: command.label,
        description: command.description,
        category: command.category,
        args: command.args,
        keywords: command.keywords,
        hasBuilder: !!command.builder,
        enabled: false,
        disabledReason: "Error evaluating command state",
      };
    }
  }

  /**
   * Get the builder configuration for a command.
   */
  getBuilder(id: string): DaintreeCommand["builder"] | undefined {
    const command = this.commands.get(id);
    return command?.builder;
  }

  /**
   * Get all registered command IDs.
   */
  getIds(): string[] {
    return Array.from(this.commands.keys()).sort();
  }

  /**
   * Get count of registered commands.
   */
  get count(): number {
    return this.commands.size;
  }

  /**
   * Clear all registered commands.
   * Primarily for testing.
   */
  clear(): void {
    this.commands.clear();
  }
}

/** Singleton instance of the CommandService */
export const commandService = new CommandServiceImpl();

export type { CommandServiceImpl };
