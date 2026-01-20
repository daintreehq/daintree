/**
 * Command registry and execution service.
 * Manages registration, retrieval, and execution of Canopy commands.
 */

import type {
  CanopyCommand,
  CommandContext,
  CommandManifestEntry,
  CommandResult,
} from "../../shared/types/commands.js";

class CommandServiceImpl {
  private commands = new Map<string, CanopyCommand>();

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
  list(context?: CommandContext): CommandManifestEntry[] {
    const entries: CommandManifestEntry[] = [];
    const safeContext = context ?? {};

    for (const command of Array.from(this.commands.values())) {
      try {
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
  listByCategory(
    category: string,
    context?: CommandContext
  ): CommandManifestEntry[] {
    return this.list(context).filter((cmd) => cmd.category === category);
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

    // Validate args is a plain object
    if (args !== null && (typeof args !== "object" || Array.isArray(args))) {
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
            message: reason,
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

    // Build effective arguments with defaults (without mutating input)
    const effectiveArgs: Record<string, unknown> = { ...args };
    if (command.args) {
      for (const argDef of command.args) {
        const hasArg =
          Object.prototype.hasOwnProperty.call(effectiveArgs, argDef.name) &&
          effectiveArgs[argDef.name] != null;

        if (argDef.required && !hasArg) {
          if (argDef.default !== undefined) {
            effectiveArgs[argDef.name] = argDef.default;
          } else {
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
  getManifest(id: string, context?: CommandContext): CommandManifestEntry | undefined {
    const command = this.commands.get(id);
    if (!command) return undefined;

    const safeContext = context ?? {};
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
