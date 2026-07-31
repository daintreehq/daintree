import { z } from "zod";
import type {
  ActionId,
  ActionDefinition,
  ActionContext,
  ActionManifestEntry,
  ActionDispatchResult,
  ActionDispatchOptions,
  ActionSource,
  ActionDanger,
  ActionError,
} from "../../shared/types/actions.js";
import type { AnyActionDefinition } from "./actions/actionTypes";
import { logWarn } from "@/utils/logger";
import { keybindingService } from "./KeybindingService";
import { shortcutHintStore } from "../store/shortcutHintStore";
import { useUIStore } from "@/store/uiStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { WORKBENCH_TIER_TOOLS } from "@shared/config/helpAssistantTierAllowlists";
import { deriveBand } from "../../shared/utils/actionRiskBand.js";

/**
 * Fields that should be redacted from event payloads to prevent secret leakage.
 * Substring match (no word boundaries) so `apiKey`, `authHeader`, `refreshToken`
 * are caught at any depth. Module-level so we don't allocate a fresh matcher
 * per recursive frame in `redactSensitiveArgs`.
 */
const SENSITIVE_ARG_FIELD_PATTERN = /token|password|secret|key|auth|credential/i;

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

  if ((definition.description?.length ?? 0) < 80) {
    violations.push(
      `Action "${definition.id}" description is ${definition.description?.length ?? 0} chars ` +
        `(minimum 80). Descriptions are the primary MCP tool docs — short descriptions ` +
        `degrade model routing accuracy.`
    );
  }

  if (definition.danger !== "safe" && !definition.dangerRationale?.trim()) {
    violations.push(
      `Action "${definition.id}" has danger="${definition.danger}" but no dangerRationale. ` +
        `Rationale surfaces in the host confirmation dialog so users see why the action is gated.`
    );
  }

  const requiresArgs = definition.argsSchema
    ? !definition.argsSchema.safeParse(undefined).success &&
      !definition.argsSchema.safeParse({}).success
    : rawSchemaRequiresArgs(definition.rawInputSchema);

  if (
    requiresArgs &&
    (WORKBENCH_TIER_TOOLS as readonly string[]).includes(definition.id) &&
    (!definition.examples || definition.examples.length === 0)
  ) {
    violations.push(
      `Action "${definition.id}" is a workbench-tier arg-requiring action with no examples. ` +
        `Examples improve MCP model accuracy by showing concrete arg shapes.`
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
function zodSchemaToJsonSchema(
  schema: z.ZodType,
  io: "input" | "output" = "input"
): Record<string, unknown> | undefined {
  try {
    return z.toJSONSchema(schema, {
      io,
      unrepresentable: "any",
      reused: "inline",
      cycles: "ref",
      target: "draft-2020-12",
    }) as Record<string, unknown>;
  } catch (err) {
    logWarn("Failed to convert zod schema to JSON Schema", { error: err });
    return undefined;
  }
}

/**
 * Cap on reported issues. A deeply wrong result can produce an issue per row;
 * the first few identify the mismatch and the rest only inflate a payload that
 * crosses IPC.
 */
const MAX_REPORTED_RESULT_ISSUES = 10;

/**
 * Summarize a result-validation failure as issue CODES and structural depth.
 *
 * Deliberately drops the rejected value, zod's rendered message, AND the issue
 * path. Dropping the path is not over-caution: under `z.record(...)` the path
 * segment IS a key from the data, so a result shaped
 * `{ "sk-live-abc": 42 }` reports that key verbatim. This summary reaches two
 * surfaces an agent can read — `ActionError.details`, which crosses IPC to the
 * MCP client, and the renderer log buffer, which `logs.getAll` serves as a tool
 * — so a leaked key would re-open the hole this validation exists to close.
 *
 * The action id plus code and depth locate the mismatch against a schema the
 * developer already has. The full prettified error is available in DEV only.
 */
function summarizeResultIssues(error: z.ZodError): string[] {
  const seen = new Set<string>();
  for (const issue of error.issues) {
    seen.add(`${issue.code} at depth ${issue.path.length}`);
    if (seen.size >= MAX_REPORTED_RESULT_ISSUES) break;
  }
  return [...seen];
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
 * later mutation. Falls back to JSON round-trip when args contain class
 * instances or other non-cloneable shapes that JSON can still represent;
 * returns `undefined` if both fail rather than aliasing the live reference,
 * which would silently defeat the isolation guarantee.
 */
function cloneArgsForReplay(args: unknown): unknown {
  if (args === undefined || args === null) return args;
  if (typeof args !== "object") return args;
  try {
    return structuredClone(args);
  } catch {
    try {
      return JSON.parse(JSON.stringify(args));
    } catch {
      return undefined;
    }
  }
}

export interface LastDispatchedAction {
  actionId: ActionId;
  args: unknown;
}

/**
 * Cached JSON Schemas derived from an action definition. Computed lazily on the
 * first {@link ActionService.toManifestEntry} call that needs them, because
 * `z.toJSONSchema()` is sync-CPU and ~308 built-in actions otherwise compile
 * during cold start before any consumer needs the manifest (issue #8614).
 */
type CachedSchemas = {
  inputSchema: Record<string, unknown> | undefined;
  outputSchema: Record<string, unknown> | undefined;
};

function computeRequiresArgs(definition: AnyActionDefinition): boolean {
  return definition.argsSchema
    ? !definition.argsSchema.safeParse(undefined).success &&
        !definition.argsSchema.safeParse({}).success
    : rawSchemaRequiresArgs(definition.rawInputSchema);
}

/**
 * Recursively freezes a value in DEV so any consumer that mutates a cached
 * schema — including nested `properties`/`items`/`$defs` that a shallow
 * `Object.freeze` leaves writable — fails loudly in tests rather than silently
 * poisoning the shared cache (issue #9569). No-op in production. The `seen`
 * guard keeps it safe against a cyclic `rawInputSchema` (an unconstrained
 * plugin-supplied object), which would otherwise overflow the stack.
 */
function deepFreeze(val: unknown, seen: WeakSet<object> = new WeakSet()): void {
  if (!import.meta.env.DEV || val === null || typeof val !== "object") return;
  if (seen.has(val)) return;
  seen.add(val);
  Object.freeze(val);
  for (const child of Object.values(val as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
}

function computeSchemas(definition: AnyActionDefinition): CachedSchemas {
  // Zod-derived schemas are fresh objects per call, but raw plugin-supplied
  // schemas are the definition's live reference — clone them so the cache (and
  // the DEV freeze below) never aliases or mutates the plugin's own object.
  const inputSchema = definition.argsSchema
    ? zodSchemaToJsonSchema(definition.argsSchema)
    : definition.rawInputSchema
      ? structuredClone(definition.rawInputSchema)
      : undefined;
  const outputSchema =
    definition.mcpOutputSchema && definition.resultSchema
      ? zodSchemaToJsonSchema(definition.resultSchema, "output")
      : definition.mcpOutputSchema && definition.rawOutputSchema
        ? structuredClone(definition.rawOutputSchema)
        : undefined;
  // Freeze the cached copies only (DEV). toManifestEntry hands consumers a
  // fresh structuredClone, so this never restricts callers that legitimately
  // mutate their own manifest entry — it only catches writes back into the cache.
  deepFreeze(inputSchema);
  deepFreeze(outputSchema);
  return { inputSchema, outputSchema };
}

export class ActionService {
  private registry = new Map<ActionId, AnyActionDefinition>();
  private requiresArgsCache = new Map<ActionId, boolean>();
  /**
   * Lazily-filled JSON schema cache. Populated on first `toManifestEntry()` for
   * a given id; `.has(id)` distinguishes "not computed yet" from "computed but
   * the schema is intentionally undefined" (the input/output fields can both
   * be undefined for actions without schemas).
   */
  private schemaCache = new Map<ActionId, CachedSchemas>();
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
    const typed = definition as AnyActionDefinition;
    // Compute requiresArgs before mutating the registry: if argsSchema.safeParse
    // throws, we don't want has() to start returning true for a half-registered
    // action. JSON-schema compilation is intentionally deferred to first
    // toManifestEntry() call (issue #8614) — bulk-compiling 308 schemas at
    // startup would block ~150-300ms of frame budget for data no consumer
    // needs until the action palette or MCP manifest is first opened.
    const requiresArgs = computeRequiresArgs(typed);
    this.registry.set(definition.id, typed);
    this.requiresArgsCache.set(definition.id, requiresArgs);
  }

  /** Whether an action id is present in the registry. */
  has(id: ActionId): boolean {
    return this.registry.has(id);
  }

  /**
   * Resolve an action's human-readable title via a single O(1) registry lookup.
   * Bypasses toManifestEntry() (isEnabled callbacks, schema cloning) — use this
   * when only the title is needed (e.g. labelling a transient hint). Returns ""
   * for unknown/plugin actions registered without a title.
   */
  getTitle(id: ActionId): string {
    return this.registry.get(id)?.title ?? "";
  }

  /**
   * Whether the action guarantees it has already shown its own error toast for
   * any failure escaping `run()`. Single O(1) registry lookup — the flag is
   * renderer-local and deliberately absent from `ActionManifestEntry`, so the
   * palette reads it here rather than off the manifest row.
   *
   * Fails closed: unknown ids return false, so a caller that can't confirm
   * ownership keeps showing its own fallback toast rather than silencing one.
   */
  selfNotifiesOnExecutionError(id: ActionId): boolean {
    return this.registry.get(id)?.selfNotifiesOnExecutionError === true;
  }

  /**
   * Lightweight dispatch-gating metadata via a single O(1) registry lookup.
   * Bypasses toManifestEntry() (isEnabled/palette predicates, schema
   * compilation and cloning) — use when only danger/title/description are
   * needed, e.g. the MCP bridge's confirmation gate.
   */
  getDispatchMeta(id: ActionId): {
    danger: ActionDanger;
    title: string;
    description: string;
    dangerRationale?: string;
  } | null {
    const definition = this.registry.get(id);
    if (!definition) return null;
    return {
      danger: definition.danger,
      title: definition.title ?? "",
      description: definition.description ?? "",
      // Surfaces in the MCP host confirmation dialog so the human sees the same
      // "why this is gated" reasoning the model does (#11342). Omitted when
      // absent so callers/tests observe exactly the populated fields.
      ...(definition.dangerRationale ? { dangerRationale: definition.dangerRationale } : {}),
    };
  }

  /** Remove an action from the registry. Silent no-op if unknown — safe for unload cleanup. */
  unregister(id: ActionId): void {
    this.registry.delete(id);
    this.requiresArgsCache.delete(id);
    this.schemaCache.delete(id);
  }

  /**
   * Iterate registered action ids without materializing manifest entries. Avoids
   * the JSON-schema compilation that `list()` triggers — use this when only
   * ids are needed (e.g. plugin id validation at startup).
   */
  listIds(): IterableIterator<ActionId> {
    return this.registry.keys();
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

    if (options?.contextOverride) {
      const liveContext = this.getActionContext();
      if (
        liveContext.projectId &&
        options.contextOverride.projectId &&
        liveContext.projectId !== options.contextOverride.projectId
      ) {
        const error: ActionError = {
          code: "BINDING_STALE",
          message:
            "The session context no longer matches live state — this session was bound to a project that is no longer active. Do not retry.",
        };
        return { ok: false, error };
      }
    }

    let validatedArgs = args;
    if (definition.argsSchema) {
      // Rescue `undefined` args ONLY for an all-optional object schema — one that
      // rejects `undefined` but accepts `{}` (e.g. terminal.kill resolves the
      // focused terminal when no id is passed). Keybinding/HUD dispatch sites pass
      // `undefined`, which would otherwise fail with "Invalid arguments". A truly
      // required field still fails (that's `requiresArgs`), and a schema that
      // meaningfully accepts `undefined` (z.void/z.undefined) is left untouched.
      let toValidate = args;
      if (
        args === undefined &&
        !definition.argsSchema.safeParse(undefined).success &&
        definition.argsSchema.safeParse({}).success
      ) {
        toValidate = {};
      }
      const validation = definition.argsSchema.safeParse(toValidate);
      if (!validation.success) {
        const error: ActionError = {
          code: "VALIDATION_ERROR",
          message: `Invalid arguments for action "${actionId}"`,
          details: z.prettifyError(validation.error),
        };
        return { ok: false, error };
      }
      validatedArgs = validation.data;
    }

    // Fail closed if isEnabled throws: a single broken predicate must not
    // crash dispatch. Mirrors the guard in toManifestEntry().
    let isEnabled = true;
    try {
      isEnabled = definition.isEnabled?.(context) ?? true;
    } catch (err) {
      logWarn("Action isEnabled threw during dispatch", { actionId, error: err });
      isEnabled = false;
    }
    if (!isEnabled) {
      let reasonText: string | undefined;
      try {
        reasonText = definition.disabledReason?.(context);
      } catch (err) {
        logWarn("Action disabledReason threw during dispatch", { actionId, error: err });
      }
      const disabledReason = reasonText ?? "Action is currently disabled";
      // No toast: disabled state is already visible on the originating surface
      // (palette row, menu item, button). Callers receive the DISABLED error
      // and may decide to surface it themselves (issue #8814).
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

    // Close the plugin `host.dispatch(...)` side door for actions whose effect
    // belongs behind a plugin capability rather than the ungated `safe` built-in
    // path (#10558). Agent (MCP) and user dispatch are unaffected — only the
    // "plugin" source is rejected. `danger` stays "safe" so this carries no
    // collateral host-confirmation cost for legitimate callers.
    if (definition.denyPluginDispatch && source === "plugin") {
      const error: ActionError = {
        code: "RESTRICTED",
        message: `Action "${actionId}" is not available to plugin dispatch; use the corresponding capability-gated host API instead.`,
      };
      return { ok: false, error };
    }

    // Enforce confirmation for destructive actions from agent and plugin
    // sources. `{ confirmed: true }` is a host attestation — set only by the MCP
    // renderer bridge after the user approves the native ConfirmDialog, or by a
    // host-issued grant; it is never taken from client input (#11342). Plugins
    // have NO confirm bypass — the `confirmed` flag is ignored for plugin
    // sources, so danger:"confirm" actions always return CONFIRMATION_REQUIRED
    // for them even if a caller spoofs `confirmed: true` on a "plugin" dispatch.
    if (
      definition.danger === "confirm" &&
      (source === "plugin" || (source === "agent" && !options?.confirmed))
    ) {
      const error: ActionError = {
        code: "CONFIRMATION_REQUIRED",
        message: `Action "${actionId}" requires explicit confirmation from ${source} sources.`,
      };
      return { ok: false, error };
    }

    const wallClockStartMs = Date.now();
    const monotonicStartMs = typeof performance !== "undefined" ? performance.now() : Date.now();

    // Snapshot the overlay epoch before run() so the post-run hint can tell
    // "an overlay opened while this ran" from "one was already open". Only the
    // former must suppress — see emitShortcutHint. Skipped entirely when no
    // hint can be emitted anyway.
    const overlayEpochBeforeRun =
      source === "user" && !definition.suppressShortcutHint
        ? useUIStore.getState().overlayClaimEpoch
        : null;

    try {
      // Derive (don't mutate — `context` may be a shared object from the
      // context provider) a run-scoped context carrying the dispatch source
      // so source-aware definitions (plugin synthetic actions) can avoid
      // double-confirming an agent dispatch the MCP bridge already gated.
      const runContext: ActionContext = { ...context, dispatchSource: source };
      const result = await definition.run(validatedArgs, runContext);
      // Enforce the action's own result contract. Zod objects strip unknown
      // keys, so this is what makes the published projection the delivered one
      // rather than a claim nothing checks (#11539). Keyed on `resultSchema`
      // alone: `mcpOutputSchema` only gates the advertised JSON Schema, while
      // the MCP *text* response serializes this value either way.
      //
      // Fails closed, mirroring the argsSchema gate above. A result that
      // violates its own schema means the action is wrong; passing the raw
      // value through would preserve the leak in exactly the case this exists
      // to catch.
      //
      // Returns BEFORE the success-only bookkeeping below. `run()` did execute
      // and its side effects stand, but `action:dispatched` is contractually a
      // completion event and `lastAction` feeds `action.repeatLast` — recording
      // a dispatch whose result was rejected would let a keybinding replay it
      // and would log a success breadcrumb for a call that returned an error.
      const validatedResult = definition.resultSchema
        ? definition.resultSchema.safeParse(result)
        : undefined;
      if (validatedResult && !validatedResult.success) {
        const issues = summarizeResultIssues(validatedResult.error);
        logWarn("Action result failed its own resultSchema", { actionId, issues });
        if (import.meta.env.DEV) {
          // Paths and values are safe on a developer's own machine, and the
          // path is what actually locates the mismatch.
          console.warn(
            `[ActionService] ${actionId} result failed resultSchema:\n${z.prettifyError(validatedResult.error)}`
          );
        }
        const error: ActionError = {
          code: "RESULT_VALIDATION_ERROR",
          message: `Action "${actionId}" returned a result that does not match its declared schema`,
          details: issues,
        };
        return { ok: false, error };
      }
      const durationMs =
        (typeof performance !== "undefined" ? performance.now() : Date.now()) - monotonicStartMs;
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
        timestamp: wallClockStartMs,
        category: definition.category,
        durationMs,
        danger: definition.danger,
        safeArgs: this.extractSafeBreadcrumbArgs(args, definition),
        confirmed: options?.confirmed,
        pluginId: definition.pluginId,
      });
      if (!definition.suppressShortcutHint)
        this.emitShortcutHint(actionId, source, overlayEpochBeforeRun);
      return { ok: true, result: (validatedResult ? validatedResult.data : result) as Result };
    } catch (err) {
      const error: ActionError = {
        code: "EXECUTION_ERROR",
        message: formatErrorMessage(err, `Action "${actionId}" failed`),
        details: err,
      };
      return { ok: false, error };
    }
  }

  /**
   * Pass `{ includeSchemas: false }` to skip JSON-schema compilation and
   * cloning — entries come back with inputSchema/outputSchema undefined. Use
   * for consumers that never read the schemas (palette, actions.search); the
   * default keeps the full manifest for MCP.
   */
  list(ctx?: ActionContext, options?: { includeSchemas?: boolean }): ActionManifestEntry[] {
    const context = ctx ?? this.getActionContext();
    const includeSchemas = options?.includeSchemas !== false;
    return Array.from(this.registry.values())
      .filter((def) => def.danger !== "restricted")
      .filter((def) => {
        try {
          return def.isVisible?.(context) ?? true;
        } catch (err) {
          logWarn("Action isVisible threw", { actionId: def.id, error: err });
          return true;
        }
      })
      .map((def) => this.toManifestEntry(def, context, includeSchemas));
  }

  get(actionId: ActionId, ctx?: ActionContext): ActionManifestEntry | null {
    const definition = this.registry.get(actionId);
    if (!definition) return null;

    const context = ctx ?? this.getActionContext();
    return this.toManifestEntry(definition, context);
  }

  private toManifestEntry(
    definition: AnyActionDefinition,
    context: ActionContext,
    includeSchemas = true
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

    // requiresArgs is populated by register(); the defensive fallback covers
    // tests that bypass register() and write to the registry directly,
    // matching getActionContext()'s graceful-degradation pattern.
    let requiresArgs = this.requiresArgsCache.get(definition.id);
    if (requiresArgs === undefined) {
      requiresArgs = computeRequiresArgs(definition);
      this.requiresArgsCache.set(definition.id, requiresArgs);
    }

    // Project the palette behavior onto the manifest. Palette-only — these
    // fields are read by useActionPalette and ignored by dispatch()/MCP, so
    // keybindings, context menus, and the MCP tool surface are unaffected. The
    // `requireContext` predicate fails CLOSED (disabled-with-reason) since
    // that's purely a palette-row state, not a dispatch gate.
    let paletteHidden: true | undefined;
    let paletteRedirectTo: ActionId | undefined;
    let paletteDisabled: true | undefined;
    let paletteDisabledReason: string | undefined;
    const palette = definition.palette;
    if (palette) {
      if (palette.mode === "hidden") {
        paletteHidden = true;
      } else if (palette.mode === "redirect") {
        paletteRedirectTo = palette.to;
      } else if (palette.mode === "requireContext") {
        let ready = false;
        try {
          ready = palette.isReady(context);
        } catch (err) {
          logWarn("Action palette.requireContext predicate threw", {
            actionId: definition.id,
            error: err,
          });
          ready = false;
        }
        if (!ready) {
          paletteDisabled = true;
          paletteDisabledReason = palette.reason;
        }
      }
    }

    // JSON schemas are deferred from register-time to first-use (issue #8614).
    // Use .has() rather than truthy-check so an action whose schemas are both
    // intentionally undefined isn't recomputed on every call. Skipped entirely
    // when the caller opted out of schemas.
    let schemas: CachedSchemas | undefined;
    if (includeSchemas) {
      schemas = this.schemaCache.get(definition.id);
      if (!this.schemaCache.has(definition.id)) {
        schemas = computeSchemas(definition);
        this.schemaCache.set(definition.id, schemas);
      }
    }

    // Deep-clone the cached schemas so a downstream consumer (e.g. an MCP
    // adapter normalizing in place) that mutates entry.inputSchema — including
    // nested `properties`/`items`/`$defs`, which Zod v4's `reused: "inline"`
    // physically shares — can't poison subsequent list()/get() reads. A shallow
    // spread only isolated the top level (issue #9569). structuredClone is safe
    // here: z.toJSONSchema finalizes through a JSON round-trip, so the cached
    // value has no cycles or non-cloneable shapes.
    return {
      id: definition.id,
      name: definition.id,
      title: definition.title ?? "",
      description: definition.description ?? "",
      category: definition.category,
      kind: definition.kind,
      danger: definition.danger,
      band: deriveBand({
        id: definition.id,
        danger: definition.danger,
        category: definition.category,
      }),
      inputSchema: schemas?.inputSchema ? structuredClone(schemas.inputSchema) : undefined,
      outputSchema: schemas?.outputSchema ? structuredClone(schemas.outputSchema) : undefined,
      enabled,
      disabledReason,
      requiresArgs,
      keywords: definition.keywords?.slice(),
      ...(definition.mcpAnnotations ? { mcpAnnotations: { ...definition.mcpAnnotations } } : {}),
      ...(definition.mcpVisibility ? { mcpVisibility: definition.mcpVisibility } : {}),
      ...(definition.pluginId ? { pluginId: definition.pluginId } : {}),
      ...(definition.examples ? { examples: structuredClone(definition.examples) } : {}),
      ...(definition.dangerRationale ? { dangerRationale: definition.dangerRationale } : {}),
      ...(paletteHidden ? { paletteHidden } : {}),
      ...(paletteRedirectTo ? { paletteRedirectTo } : {}),
      ...(paletteDisabled ? { paletteDisabled } : {}),
      ...(paletteDisabledReason ? { paletteDisabledReason } : {}),
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
      if (SENSITIVE_ARG_FIELD_PATTERN.test(key)) {
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

  /**
   * Suppresses the hint when an overlay is on screen that opened while run()
   * was in flight. Such a hint would render above it (z-toast sits over
   * z-modal) and the dialog's own `clearDialogOverlays()` already fired
   * *before* this emit, so nothing would take the hint down for the full
   * auto-dismiss window — issue #11507.
   *
   * Both halves are load-bearing. The epoch alone would suppress after a
   * dialog that opened and closed again, where there is nothing left to strand
   * on; a non-empty stack alone would suppress hints for actions invoked
   * inside a dialog that was already open and stays open.
   *
   * The epoch rather than the stack contents because claim ids are reused: a
   * dialog reopening at the same tree position keeps its `useId()`, so an
   * open→close→reopen across one dispatch is invisible to a contents diff.
   *
   * The test is temporal, not attributive: claims carry no owning action, so a
   * dialog opened by a *concurrent* dispatch suppresses this one's hint too.
   * That is the conservative direction — the hint would have landed over that
   * dialog either way.
   */
  private emitShortcutHint(
    actionId: ActionId,
    source: ActionSource,
    overlayEpochBeforeRun: number | null
  ): void {
    if (source !== "user") return;
    try {
      // Bail before incrementCount so a suppressed hint doesn't silently
      // consume one of the teaching milestones.
      if (overlayEpochBeforeRun !== null) {
        const { overlayStack, overlayClaimEpoch } = useUIStore.getState();
        if (overlayStack.length > 0 && overlayClaimEpoch !== overlayEpochBeforeRun) return;
      }

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
    danger: ActionDanger;
    safeArgs?: Record<string, unknown>;
    confirmed?: boolean;
    pluginId?: string;
  }): Promise<void> {
    if (!isElectronApiAvailable()) return;

    // Plugin actions feed the plugin-action audit log: compute the SHA-256
    // digest of the (already redacted) args in the renderer so raw args need
    // never cross IPC for fingerprinting. Built-in actions skip this entirely.
    const argsHash = payload.pluginId !== undefined ? await sha256Hex(payload.args) : undefined;

    try {
      await window.electron.events.emit("action:dispatched", {
        actionId: payload.actionId,
        args: payload.args,
        source: payload.source,
        context: payload.context,
        timestamp: payload.timestamp,
        category: payload.category,
        durationMs: payload.durationMs,
        danger: payload.danger,
        ...(payload.safeArgs ? { safeArgs: payload.safeArgs } : {}),
        ...(payload.confirmed !== undefined ? { confirmed: payload.confirmed } : {}),
        ...(payload.pluginId !== undefined ? { pluginId: payload.pluginId } : {}),
        ...(argsHash !== undefined ? { argsHash } : {}),
      });
    } catch (err) {
      logWarn("Failed to emit action:dispatched event", {
        actionId: payload.actionId,
        error: err,
      });
    }
  }
}

/**
 * SHA-256 hex digest of the JSON-serialized value, computed via SubtleCrypto.
 * Returns an empty string when the value is absent, unserializable, or when
 * the Web Crypto API is unavailable — the audit record stores `""` rather
 * than failing the dispatch flow.
 */
async function sha256Hex(value: unknown): Promise<string> {
  if (value === undefined || value === null) return "";
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = "[unserializable]";
  }
  if (serialized === undefined) serialized = "[unserializable]";
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return "";
    const buf = await subtle.digest("SHA-256", new TextEncoder().encode(serialized));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return "";
  }
}

export const actionService = new ActionService();

export function installE2EActionDispatchBridge(): void {
  // Expose dispatch function for E2E tests (WebGL renderer has no DOM-level action API).
  // Gated on the preload-injected __DAINTREE_E2E_MODE__ flag so the global is never
  // attached in production sessions — the flag is only exposed when the Electron
  // process was launched with DAINTREE_E2E_MODE=1 (set exclusively by e2e/helpers/launch.ts).
  if (typeof window === "undefined" || window.__DAINTREE_E2E_MODE__ !== true) return;

  window.__daintreeDispatchAction = (
    actionId: string,
    args?: unknown,
    options?: { source?: string; confirmed?: boolean }
  ) => actionService.dispatch(actionId as ActionId, args, options as ActionDispatchOptions);
}

installE2EActionDispatchBridge();

export function getActionContext(): ActionContext {
  return actionService.getContext();
}
