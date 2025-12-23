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
import { isElectronAvailable } from "@/hooks/useElectron";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useTerminalStore } from "@/store/terminalStore";

export class ActionService {
  private registry = new Map<ActionId, ActionDefinition<unknown, unknown>>();

  register<Args = unknown, Result = unknown>(definition: ActionDefinition<Args, Result>): void {
    if (this.registry.has(definition.id)) {
      console.warn(`[ActionService] Action "${definition.id}" already registered. Overwriting.`);
    }
    this.registry.set(definition.id, definition as ActionDefinition<unknown, unknown>);
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

    await this.emitActionDispatchedEvent({
      actionId,
      args,
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
    return getActionContext();
  }

  private async emitActionDispatchedEvent(payload: {
    actionId: ActionId;
    args?: unknown;
    context: ActionContext;
    source: ActionSource;
    timestamp: number;
  }): Promise<void> {
    if (!isElectronAvailable()) return;

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
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const projectState = useProjectStore.getState();
    const worktreeState = useWorktreeSelectionStore.getState();
    const terminalState = useTerminalStore.getState();

    return {
      projectId: projectState.currentProject?.id,
      activeWorktreeId: worktreeState.activeWorktreeId ?? undefined,
      focusedTerminalId: terminalState.focusedId ?? undefined,
    };
  } catch (err) {
    console.warn("[ActionService] Failed to get action context from stores:", err);
    return {};
  }
}
