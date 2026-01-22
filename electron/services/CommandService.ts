/**
 * Command registry and execution service.
 * Manages registration, retrieval, and execution of Canopy commands.
 */

import type {
  CanopyCommand,
  CommandContext,
  CommandManifestEntry,
  CommandResult,
  CommandOverride,
} from "../../shared/types/commands.js";
import { projectStore } from "./ProjectStore.js";

class CommandServiceImpl {
  private commands = new Map<string, CanopyCommand>();

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
    command: CanopyCommand<TArgs, TResult>
  ): void {
    if (this.commands.has(command.id)) {
      throw new Error(`Command "${command.id}" is already registered`);
    }
    this.commands.set(command.id, command as CanopyCommand);
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
  get(id: string): CanopyCommand | undefined {
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
          continue; // Skip disabled commands
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

    // Build effective arguments with defaults (command defaults < override defaults < provided args)
    const effectiveArgs: Record<string, unknown> = { ...args };

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

    // Second, apply override defaults (if they exist)
    if (override?.defaults) {
      for (const [key, value] of Object.entries(override.defaults)) {
        // Only apply override default if not provided by caller
        const hasArg = Object.prototype.hasOwnProperty.call(args, key) && args[key] != null;
        if (!hasArg) {
          effectiveArgs[key] = value;
        }
      }
    }

    // Finally, check for missing required arguments
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
      return {
        success: false,
        error: {
          code: "EXECUTION_ERROR",
          message,
          details: err instanceof Error ? { stack: err.stack } : undefined,
        },
      };
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
  getBuilder(id: string): CanopyCommand["builder"] | undefined {
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
