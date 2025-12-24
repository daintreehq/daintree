import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  ActionId,
  ActionDefinition,
  ActionContext,
  ActionManifestEntry,
  ActionDispatchResult,
  ActionDispatchOptions,
  ActionSource,
  ActionError,
} from "../../shared/types/actions.js";

/** Fields that should be redacted from event payloads to prevent secret leakage */
const SENSITIVE_ARG_FIELDS = new Set(["token", "password", "secret", "key", "auth", "credential"]);

/** Max size for args in event payloads (prevents explosion) */
const MAX_ARG_PAYLOAD_SIZE = 1024;

function isElectronApiAvailable(): boolean {
  return typeof window !== "undefined" && !!(window as any).electron;
}

export class ActionService {
  private registry = new Map<ActionId, ActionDefinition<unknown, unknown>>();
  private contextProvider: (() => ActionContext) | null = null;

  register<Args = unknown, Result = unknown>(definition: ActionDefinition<Args, Result>): void {
    if (this.registry.has(definition.id)) {
      console.warn(`[ActionService] Action "${definition.id}" already registered. Overwriting.`);
    }
    this.registry.set(definition.id, definition as ActionDefinition<unknown, unknown>);
  }

  setContextProvider(provider: (() => ActionContext) | null): void {
    this.contextProvider = provider;
  }

  getContext(): ActionContext {
    return this.getActionContext();
  }

  async dispatch<Result = unknown>(
    actionId: ActionId,
    args?: unknown,
    options?: ActionDispatchOptions
  ): Promise<ActionDispatchResult<Result>> {
    const definition = this.registry.get(actionId);
    const source: ActionSource = options?.source ?? "user";

    if (!definition) {
      const error: ActionError = {
        code: "NOT_FOUND",
        message: `Action "${actionId}" not found in registry`,
      };
      return { ok: false, error };
    }

    const context = this.getActionContext();

    let validatedArgs = args;
    if (definition.argsSchema) {
      const validation = definition.argsSchema.safeParse(args);
      if (!validation.success) {
        const error: ActionError = {
          code: "VALIDATION_ERROR",
          message: `Invalid arguments for action "${actionId}"`,
          details: validation.error.format(),
        };
        return { ok: false, error };
      }
      validatedArgs = validation.data;
    }

    const isEnabled = definition.isEnabled?.(context) ?? true;
    if (!isEnabled) {
      const disabledReason = definition.disabledReason?.(context) ?? "Action is currently disabled";
      const error: ActionError = {
        code: "DISABLED",
        message: disabledReason,
      };
      return { ok: false, error };
    }

    if (definition.danger === "restricted") {
      const error: ActionError = {
        code: "RESTRICTED",
        message: `Action "${actionId}" is restricted and cannot be executed`,
      };
      return { ok: false, error };
    }

    // Enforce confirmation for destructive actions from agent sources
    // Agents must explicitly confirm before executing dangerous operations
    if (definition.danger === "confirm" && source === "agent" && !options?.confirmed) {
      const error: ActionError = {
        code: "CONFIRMATION_REQUIRED",
        message: `Action "${actionId}" requires explicit confirmation from agent sources. Set { confirmed: true } to proceed.`,
      };
      return { ok: false, error };
    }

    await this.emitActionDispatchedEvent({
      actionId,
      args: this.redactSensitiveArgs(args),
      context,
      source,
      timestamp: Date.now(),
    });

    try {
      const result = await definition.run(validatedArgs, context);
      return { ok: true, result: result as Result };
    } catch (err) {
      const error: ActionError = {
        code: "EXECUTION_ERROR",
        message: err instanceof Error ? err.message : String(err),
        details: err,
      };
      return { ok: false, error };
    }
  }

  list(ctx?: ActionContext): ActionManifestEntry[] {
    const context = ctx ?? this.getActionContext();
    return Array.from(this.registry.values()).map((def) => this.toManifestEntry(def, context));
  }

  get(actionId: ActionId, ctx?: ActionContext): ActionManifestEntry | null {
    const definition = this.registry.get(actionId);
    if (!definition) return null;

    const context = ctx ?? this.getActionContext();
    return this.toManifestEntry(definition, context);
  }

  private toManifestEntry(
    definition: ActionDefinition<unknown, unknown>,
    context: ActionContext
  ): ActionManifestEntry {
    const enabled = definition.isEnabled?.(context) ?? true;
    const disabledReason = enabled ? undefined : definition.disabledReason?.(context);

    return {
      id: definition.id,
      title: definition.title,
      description: definition.description,
      category: definition.category,
      kind: definition.kind,
      danger: definition.danger,
      inputSchema: definition.argsSchema
        ? (zodToJsonSchema(definition.argsSchema as any) as Record<string, unknown>)
        : undefined,
      outputSchema: definition.resultSchema
        ? (zodToJsonSchema(definition.resultSchema as any) as Record<string, unknown>)
        : undefined,
      enabled,
      disabledReason,
    };
  }

  private getActionContext(): ActionContext {
    if (this.contextProvider) {
      try {
        return this.contextProvider();
      } catch (err) {
        console.warn("[ActionService] Context provider threw an error:", err);
        return {};
      }
    }
    return {};
  }

  /**
   * Redact sensitive fields and truncate large payloads to prevent secret leakage
   * and payload explosion in event logs.
   */
  private redactSensitiveArgs(args: unknown): unknown {
    if (args === undefined || args === null) return args;

    // Check size first
    const serialized = JSON.stringify(args);
    if (serialized.length > MAX_ARG_PAYLOAD_SIZE) {
      return { _redacted: "payload_too_large", size: serialized.length };
    }

    if (typeof args !== "object") return args;

    if (Array.isArray(args)) {
      return args.map((item) => this.redactSensitiveArgs(item));
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      const isSensitive = Array.from(SENSITIVE_ARG_FIELDS).some((field) =>
        lowerKey.includes(field)
      );

      if (isSensitive) {
        result[key] = "[REDACTED]";
      } else if (typeof value === "object" && value !== null) {
        result[key] = this.redactSensitiveArgs(value);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  private async emitActionDispatchedEvent(payload: {
    actionId: ActionId;
    args?: unknown;
    context: ActionContext;
    source: ActionSource;
    timestamp: number;
  }): Promise<void> {
    if (!isElectronApiAvailable()) return;

    try {
      const electron = window.electron as typeof window.electron & {
        events?: { emit: (eventType: string, payload: unknown) => Promise<void> };
      };
      await electron.events?.emit("action:dispatched", {
        actionId: payload.actionId,
        args: payload.args,
        source: payload.source,
        context: payload.context,
        timestamp: payload.timestamp,
      });
    } catch (err) {
      console.warn("[ActionService] Failed to emit action:dispatched event:", err);
    }
  }
}

export const actionService = new ActionService();

export function getActionContext(): ActionContext {
  return actionService.getContext();
}
