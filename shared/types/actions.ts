import type { BuiltInKeyAction } from "./keymap.js";
import type { BuiltInRuntimeActionId } from "../config/actionIds.js";
import type { z } from "zod";

export type ActionSource = "user" | "keybinding" | "menu" | "agent" | "context-menu" | "plugin";

export type ActionKind = "command" | "query";

export type ActionDanger = "safe" | "confirm" | "restricted";

export type RiskBand =
  | "reversible"
  | "external-effect"
  | "destructive-local"
  | "destructive-network";

export type McpVisibility = "core" | "discoverable" | "hidden";

export type ActionScope = "renderer";

/**
 * Explicit MCP tool annotation overrides. The spec defaults to a conservative
 * posture (destructive, open-world) — override only when the action's true
 * semantics differ from that default. `title` is always sourced from the action
 * title. Defined inline (no `@modelcontextprotocol/sdk` import) so this type
 * stays usable from the renderer.
 */
export interface ActionMcpAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type BuiltInActionId = BuiltInKeyAction | BuiltInRuntimeActionId;

export type ActionId = BuiltInActionId | (string & {});

export interface ActionExample {
  args: Record<string, unknown>;
  description: string;
}

export interface ActionContext {
  projectId?: string;
  projectName?: string;
  projectPath?: string;
  activeWorktreeId?: string;
  activeWorktreeName?: string;
  activeWorktreePath?: string;
  activeWorktreeBranch?: string;
  activeWorktreeIsMain?: boolean;
  focusedWorktreeId?: string;
  focusedTerminalId?: string;
  focusedTerminalKind?: string;
  focusedTerminalType?: string;
  focusedTerminalTitle?: string;
  isSettingsOpen?: boolean;
  /**
   * The dispatch source for the in-flight `run()` call. Set by
   * `ActionService.dispatch` from the resolved {@link ActionSource} before
   * invoking the definition. A read-only contextual signal (never a security
   * gate): plugin synthetic actions read it to skip their own confirm dialog
   * when `"agent"`, since the MCP bridge has already confirmed and would
   * otherwise double-prompt.
   */
  dispatchSource?: ActionSource;
}

export type InferActionArgs<S extends z.ZodTypeAny | undefined> = [S] extends [z.ZodTypeAny]
  ? z.infer<S>
  : void;

export interface ActionDefinition<
  S extends z.ZodTypeAny | undefined = undefined,
  Result = unknown,
> {
  id: ActionId;
  title: string;
  description: string;
  category: string;
  kind: ActionKind;
  danger: ActionDanger;
  scope: ActionScope;
  argsSchema?: S;
  resultSchema?: z.ZodType<Result>;
  isEnabled?: (ctx: ActionContext) => boolean;
  disabledReason?: (ctx: ActionContext) => string | undefined;
  /**
   * Structural visibility predicate evaluated when `ActionService.list()`
   * enumerates actions. Returning `false` removes the action from the listing
   * entirely (palette, context menus, MCP manifest), distinct from `isEnabled`
   * which only dims it. Default when unset is `() => true`.
   *
   * Fails OPEN — if the predicate throws, the action remains visible. This is
   * the explicit inverse of `isEnabled` (which fails closed) because hiding a
   * command silently on a bug is more surprising than briefly showing one.
   *
   * Note: visibility is a discovery-layer concern, not an authorization gate.
   * `get(id)` and `dispatch(id)` deliberately ignore `isVisible` so direct
   * lookups and keybindings continue to work.
   */
  isVisible?: (ctx: ActionContext) => boolean;
  run: (args: InferActionArgs<S>, ctx: ActionContext) => Promise<Result>;
  /**
   * Opt-in allowlist of top-level arg keys that are safe to include in Sentry
   * action breadcrumbs. Args are omitted by default — populate this only with
   * keys whose values never carry secrets, file paths, or PII. Listed keys are
   * copied verbatim (no further sanitization), so the allowlist is the policy.
   */
  safeBreadcrumbArgs?: readonly string[];
  /**
   * When true, `action.repeatLast` will not record this action as the last
   * dispatched action. Use for palette-openers, pure navigation, modal control,
   * and settings-open actions whose intent is transient/UI rather than a
   * repeatable operation.
   */
  nonRepeatable?: boolean;
  /** Synonyms and alternative mental-model terms for palette search. */
  keywords?: string[];
  /**
   * Per-action MCP tool annotation overrides. Use sparingly — only when the
   * spec-conservative defaults (destructive, open-world) would mislead an MCP
   * client.
   */
  mcpAnnotations?: ActionMcpAnnotations;
  /**
   * Concrete usage examples surfaced to MCP clients via `_meta.examples`.
   * Each entry pairs args (matching `argsSchema` shape) with a short
   * description of what the invocation accomplishes.
   */
  examples?: readonly ActionExample[];
  /**
   * Human-readable rationale for why this action carries its `danger` rating.
   * Surfaces in the MCP elicitation confirmation message so the user sees the
   * same reasoning the model would. Required when `danger !== "safe"`.
   */
  dangerRationale?: string;
  /**
   * Opt-in flag to expose `outputSchema` on the MCP tool manifest. When true
   * and `resultSchema` is set, the Zod schema is converted to JSON Schema and
   * surfaced as `outputSchema`, enabling structured `structuredContent` on
   * `tools/call` responses. Use sparingly — only for naturally-structured
   * results where the schema adds real value for programmatic consumers.
   */
  mcpOutputSchema?: boolean;
  /**
   * MCP progressive-disclosure visibility. `core` tools always appear on
   * `tools/list`; `discoverable` tools are reachable via `actions.search` +
   * `actions.getSchema` but omitted from the default list; `hidden` tools
   * never surface in discovery. Unset (undefined) preserves pre-existing
   * behavior (tool appears on `tools/list` when tier-permitted).
   */
  mcpVisibility?: McpVisibility;
}

export interface ActionManifestEntry {
  id: ActionId;
  /**
   * MCP-friendly alias for `id`.
   * Prefer `name` when presenting tools to LLMs.
   */
  name: string;
  title: string;
  description: string;
  category: string;
  kind: ActionKind;
  danger: ActionDanger;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  enabled: boolean;
  disabledReason?: string;
  requiresArgs: boolean;
  keywords?: string[];
  /** Per-action MCP tool annotation overrides. */
  mcpAnnotations?: ActionMcpAnnotations;
  /** Set when this action was registered by a plugin (not a built-in). */
  pluginId?: string;
  /** Concrete usage examples surfaced to MCP clients via `_meta.examples`. */
  examples?: readonly ActionExample[];
  /** Human-readable rationale for the action's `danger` rating. */
  dangerRationale?: string;
  /** Risk band derived from danger + open-world category. Read by consent dialogs. */
  band?: RiskBand;
  /** MCP progressive-disclosure visibility classification. */
  mcpVisibility?: McpVisibility;
}

export interface ActionDispatchSuccess<Result = unknown> {
  ok: true;
  result: Result;
}

export interface ActionDispatchError {
  ok: false;
  error: ActionError;
}

export type ActionDispatchResult<Result = unknown> =
  | ActionDispatchSuccess<Result>
  | ActionDispatchError;

export type ActionErrorCode =
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "DISABLED"
  | "RESTRICTED"
  | "CONFIRMATION_REQUIRED"
  | "EXECUTION_ERROR"
  | "USER_REJECTED"
  | "CONFIRMATION_TIMEOUT"
  | "ELICITATION_FAILED"
  | "BINDING_STALE";

export interface ActionError {
  code: ActionErrorCode;
  message: string;
  details?: unknown;
}

export interface ActionDispatchOptions {
  source?: ActionSource;
  /**
   * For actions with danger: "confirm", this must be true to execute.
   * Agent sources MUST explicitly set this flag to confirm destructive actions.
   */
  confirmed?: boolean;
  /**
   * Override the action context instead of using current UI state.
   * Used by agent dispatch to bind context at dispatch time and prevent confused-deputy attacks.
   */
  contextOverride?: ActionContext;
}

export interface ActionDispatchPayload {
  actionId: ActionId;
  args?: unknown;
  context: ActionContext;
  source: ActionSource;
  timestamp: number;
  /** True when an agent explicitly confirmed a danger:"confirm" action. Absent for user-source and safe actions. */
  confirmed?: boolean;
}

export interface ActionFrecencyEntry {
  id: string;
  score: number;
  lastAccessedAt: number;
}
