import { z } from "zod";
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
import type { AnyActionDefinition } from "./actions/actionTypes";
import { logWarn } from "@/utils/logger";
import { notify } from "@/lib/notify";
import { keybindingService } from "./KeybindingService";
import { shortcutHintStore } from "../store/shortcutHintStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";

/** Fields that should be redacted from event payloads to prevent secret leakage */
const SENSITIVE_ARG_FIELDS = new Set(["token", "password", "secret", "key", "auth", "credential"]);

/** Max size for args in event payloads (prevents explosion) */
const MAX_ARG_PAYLOAD_SIZE = 1024;

/**
 * Validate a definition against invariants that should hold for every action.
 * Returns an array of violation messages (empty = valid). Pure function with
 * no side effects — safe to call from vitest, ActionService.register(), or CI.
 */
export function validateDefinitionInvariants(definition: AnyActionDefinition): string[] {
  const violations: string[] = [];

  if (definition.isEnabled && !definition.disabledReason) {
    violations.push(
      `Action "${definition.id}" defines isEnabled but no disabledReason callback. ` +
        `Users may see a disabled command with no explanation.`
    );
  }

  return violations;
}

/**
 * Validate an action definition for common anti-patterns.
 * Emits console warnings in dev mode only.
 */
function validateActionDefinition(definition: AnyActionDefinition): void {
  if (!import.meta.env.DEV) return;

  for (const violation of validateDefinitionInvariants(definition)) {
    console.warn(`[ActionRegistry] ${violation}`);
  }
}

function isElectronApiAvailable(): boolean {
  return typeof window !== "undefined" && !!window.electron;
}

/**
 * Converts a zod schema to JSON Schema format using Zod v4's native toJSONSchema.
 */
function zodSchemaToJsonSchema(schema: z.ZodType): Record<string, unknown> | undefined {
  try {
    return z.toJSONSchema(schema, {
      io: "input",
      unrepresentable: "any",
      reused: "inline",
      cycles: "ref",
    }) as Record<string, unknown>;
  } catch (err) {
    logWarn("Failed to convert zod schema to JSON Schema", { error: err });
    return undefined;
  }
}

/**
 * Heuristic for plugin-contributed actions that declare a raw JSON Schema.
 * Treat the action as requiring args if the schema has a non-empty
 * `required` array. Anything else (no schema, schema without required) is
 * treated as taking no required args — matches how argsSchema=undefined
 * behaves for built-ins.
 */
function rawSchemaRequiresArgs(schema: Record<string, unknown> | undefined): boolean {
  if (!schema || typeof schema !== "object") return false;
  const required = (schema as { required?: unknown }).required;
  return Array.isArray(required) && required.length > 0;
}

/** Sources whose successful dispatches are eligible to be recorded as the "last action". */
const REPEATABLE_SOURCES: ReadonlySet<ActionSource> = new Set<ActionSource>([
  "user",
  "keybinding",
  "menu",
  "context-menu",
]);

/**
 * Snapshot args for replay. Structured clone isolates the captured copy from
 * later mutation by the action's run body or the caller — non-cloneable values
 * fall through unchanged.
 */
function cloneArgsForReplay(args: unknown): unknown {
  if (args === undefined || args === null) return args;
  if (typeof args !== "object") return args;
  try {
    return structuredClone(args);
  } catch {
    return args;
  }
}

export interface LastDispatchedAction {
  actionId: ActionId;
  args: unknown;
}

export class ActionService {
  private registry = new Map<ActionId, AnyActionDefinition>();
  private contextProvider: (() => ActionContext) | null = null;
  /**
   * Last eligible {actionId, args} captured after a successful dispatch from a
   * user-facing source. Lives in renderer memory only — intentionally does not
   * survive reloads. Consumed by `action.repeatLast`.
   */
  private lastAction: LastDispatchedAction | null = null;

  register<S extends z.ZodTypeAny | undefined = undefined, Result = unknown>(
    definition: ActionDefinition<S, Result>
  ): void {
    if (this.registry.has(definition.id)) {
      throw new Error(`Action "${definition.id}" is already registered.`);
    }
    // Validate after the duplicate-ID guard: on HMR / plugin reload a
    // re-registering action was already validated on first pass — emitting
    // a warning before the throw would be spurious noise.
    validateActionDefinition(definition);
    this.registry.set(definition.id, definition as AnyActionDefinition);
  }

  /** Whether an action id is present in the registry. */
  has(id: ActionId): boolean {
    return this.registry.has(id);
  }

  /** Remove an action from the registry. Silent no-op if unknown — safe for unload cleanup. */
  unregister(id: ActionId): void {
    this.registry.delete(id);
  }

  setContextProvider(provider: (() => ActionContext) | null): void {
    this.contextProvider = provider;
  }

  getContext(): ActionContext {
    return this.getActionContext();
  }

  getLastAction(): LastDispatchedAction | null {
    return this.lastAction;
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

    const context = options?.contextOverride ?? this.getActionContext();

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
      const reasonText = definition.disabledReason?.(context);
      const disabledReason = reasonText ?? "Action is currently disabled";
      // Suppress the toast for agent-sourced dispatches — MCP introspection
      // probes shouldn't surface as user-visible warnings. The DISABLED error
      // is still returned to the caller.
      if (reasonText && source !== "agent") {
        notify({
          type: "warning",
          title: `'${definition.title}' disabled`,
          message: reasonText,
        });
      }
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

    const startMs = Date.now();

    try {
      const result = await definition.run(validatedArgs, context);
      const durationMs = Date.now() - startMs;
      if (
        REPEATABLE_SOURCES.has(source) &&
        !definition.nonRepeatable &&
        definition.danger === "safe"
      ) {
        // Only danger:"safe" actions are eligible for repeat. Confirm-gated actions
        // rely on originating UI dialogs for consent — replaying them from a keybinding
        // would silently bypass that UI and repeat a destructive op.
        this.lastAction = { actionId, args: cloneArgsForReplay(validatedArgs) };
      }
      void this.emitActionDispatchedEvent({
        actionId,
        args: this.redactSensitiveArgs(args),
        context,
        source,
        timestamp: startMs,
        category: definition.category,
        durationMs,
        safeArgs: this.extractSafeBreadcrumbArgs(args, definition),
      });
      this.emitShortcutHint(actionId, source);
      return { ok: true, result: result as Result };
    } catch (err) {
      const error: ActionError = {
        code: "EXECUTION_ERROR",
        message: formatErrorMessage(err, `Action "${actionId}" failed`),
        details: err,
      };
      return { ok: false, error };
    }
  }

  list(ctx?: ActionContext): ActionManifestEntry[] {
    const context = ctx ?? this.getActionContext();
    return Array.from(this.registry.values())
      .filter((def) => def.danger !== "restricted")
      .map((def) => this.toManifestEntry(def, context));
  }

  get(actionId: ActionId, ctx?: ActionContext): ActionManifestEntry | null {
    const definition = this.registry.get(actionId);
    if (!definition) return null;

    const context = ctx ?? this.getActionContext();
    return this.toManifestEntry(definition, context);
  }

  private toManifestEntry(
    definition: AnyActionDefinition,
    context: ActionContext
  ): ActionManifestEntry {
    // Fail closed if isEnabled throws: a single broken action must not crash
    // ActionService.list(), which runs during initial render and would take
    // the whole React tree down.
    let enabled = true;
    try {
      enabled = definition.isEnabled?.(context) ?? true;
    } catch (err) {
      logWarn("Action isEnabled threw", { actionId: definition.id, error: err });
      enabled = false;
    }
    let disabledReason: string | undefined;
    if (!enabled) {
      try {
        disabledReason = definition.disabledReason?.(context);
      } catch (err) {
        logWarn("Action disabledReason threw", { actionId: definition.id, error: err });
      }
    }

    return {
      id: definition.id,
      name: definition.id,
      title: definition.title ?? "",
      description: definition.description ?? "",
      category: definition.category,
      kind: definition.kind,
      danger: definition.danger,
      inputSchema: definition.argsSchema
        ? zodSchemaToJsonSchema(definition.argsSchema)
        : definition.rawInputSchema,
      outputSchema: definition.resultSchema
        ? zodSchemaToJsonSchema(definition.resultSchema)
        : undefined,
      enabled,
      disabledReason,
      requiresArgs: definition.argsSchema
        ? !definition.argsSchema.safeParse(undefined).success &&
          !definition.argsSchema.safeParse({}).success
        : rawSchemaRequiresArgs(definition.rawInputSchema),
      keywords: definition.keywords?.slice(),
      ...(definition.pluginId ? { pluginId: definition.pluginId } : {}),
    };
  }

  private getActionContext(): ActionContext {
    if (this.contextProvider) {
      try {
        return this.contextProvider();
      } catch (err) {
        logWarn("Context provider threw an error", { error: err });
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
    let serialized: string;
    try {
      serialized = JSON.stringify(args);
    } catch {
      return { _redacted: "unserializable" };
    }
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

  /**
   * Extract the subset of top-level arg keys the action opts in to exposing
   * in Sentry breadcrumbs. Returns undefined when no allowlist is declared
   * or when args aren't a plain object. Listed keys are passed through
   * verbatim — the allowlist is the policy.
   */
  private extractSafeBreadcrumbArgs(
    args: unknown,
    definition: AnyActionDefinition
  ): Record<string, unknown> | undefined {
    const allowlist = definition.safeBreadcrumbArgs;
    if (!allowlist || allowlist.length === 0) return undefined;
    if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;

    const source = args as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    let hasAny = false;
    for (const key of allowlist) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        picked[key] = source[key];
        hasAny = true;
      }
    }
    return hasAny ? picked : undefined;
  }

  private emitShortcutHint(actionId: ActionId, source: ActionSource): void {
    if (source !== "user") return;
    try {
      const combo = keybindingService.getEffectiveCombo(actionId);
      if (!combo) return;

      const state = shortcutHintStore.getState();
      if (!state.hydrated) return;

      state.incrementCount(actionId);
      const displayCombo = keybindingService.getDisplayCombo(actionId);
      state.show(actionId, displayCombo);
    } catch {
      // never break dispatch flow
    }
  }

  private async emitActionDispatchedEvent(payload: {
    actionId: ActionId;
    args?: unknown;
    context: ActionContext;
    source: ActionSource;
    timestamp: number;
    category: string;
    durationMs: number;
    safeArgs?: Record<string, unknown>;
  }): Promise<void> {
    if (!isElectronApiAvailable()) return;

    try {
      await window.electron.events.emit("action:dispatched", {
        actionId: payload.actionId,
        args: payload.args,
        source: payload.source,
        context: payload.context,
        timestamp: payload.timestamp,
        category: payload.category,
        durationMs: payload.durationMs,
        ...(payload.safeArgs ? { safeArgs: payload.safeArgs } : {}),
      });
    } catch (err) {
      logWarn("Failed to emit action:dispatched event", { error: err });
    }
  }
}

export const actionService = new ActionService();

// Expose dispatch function for E2E tests (WebGL renderer has no DOM-level action API).
// Gated on the preload-injected __DAINTREE_E2E_MODE__ flag so the global is never
// attached in production sessions — the flag is only exposed when the Electron
// process was launched with DAINTREE_E2E_MODE=1 (set exclusively by e2e/helpers/launch.ts).
if (typeof window !== "undefined" && window.__DAINTREE_E2E_MODE__ === true) {
  window.__daintreeDispatchAction = (
    actionId: string,
    args?: unknown,
    options?: { source?: string; confirmed?: boolean }
  ) => actionService.dispatch(actionId as ActionId, args, options as ActionDispatchOptions);
}

export function getActionContext(): ActionContext {
  return actionService.getContext();
}
