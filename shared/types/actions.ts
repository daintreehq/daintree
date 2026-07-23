import type { BuiltInKeyAction } from "./keymap.js";
import type { BuiltInRuntimeActionId } from "../config/actionIds.js";
import type { z } from "zod";

export type ActionSource = "user" | "keybinding" | "menu" | "agent" | "context-menu" | "plugin";

export type ActionKind = "command" | "query";

export type ActionDanger = "safe" | "confirm" | "restricted";

export type RiskBand =
  "reversible" | "external-effect" | "destructive-local" | "destructive-network";

export type McpVisibility = "core" | "discoverable" | "hidden";

export type ActionScope = "renderer";

/**
 * Declares how an action behaves when surfaced in the command/action palette,
 * independent of its headless/MCP schema. The palette dispatches the chosen
 * action with empty args `{}`, so an action whose real requirements live in
 * `run()` (rather than its `argsSchema`) leaks into the palette and fails when
 * picked. `requiresArgs` only answers "does the schema reject zero args" — this
 * field answers "what should happen when a user picks this from the palette."
 *
 * Palette-only: `ActionService.list()` projects this onto the manifest, but
 * `dispatch()`/`get()` ignore it, so keybindings, context menus, and the MCP
 * tool surface are unaffected. Unset behaves as `"run"` (today's behavior:
 * dispatch the action with `{}`).
 *
 * - `hidden` — never list the action in the palette. Still dispatchable via
 *   keybinding / direct id and still visible to MCP (use `isVisible` instead to
 *   also drop it from the MCP manifest and context menus). For commands that
 *   are keybinding/context-menu/MCP-only or are no-ops without live UI state.
 * - `redirect` — list the action (with its own title/keywords for searchability)
 *   but dispatch `to` instead when picked. The companion UI action — typically a
 *   dialog-opener — is what actually runs. For headless arg-taking actions that
 *   have an interactive sibling (e.g. `worktree.createWithRecipe` →
 *   `worktree.createDialog.open`).
 * - `requireContext` — list the action, but render it disabled-with-reason in
 *   the palette when `isReady(ctx)` is false (the palette no-ops a disabled row
 *   and shows `reason` inline). When ready, dispatch normally with `{}`. For
 *   actions whose `run()` resolves a focus/selection target from current UI
 *   state and throws when none is present (e.g. `devPreview.restart`,
 *   `copyTree.generateAndCopyFile`). `isReady` is evaluated only by the palette
 *   layer — never by `dispatch()` — so context-menu/MCP calls that pass an
 *   explicit target are not gated.
 */
export type PaletteBehavior =
  | { mode: "hidden" }
  | { mode: "redirect"; to: ActionId }
  | { mode: "requireContext"; isReady: (ctx: ActionContext) => boolean; reason: string };

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
   * invoking the definition — it is written from the canonical `source`
   * (overwriting any `contextOverride.dispatchSource`), so a definition can
   * trust it within an ActionService dispatch and callers cannot spoof it.
   * Two read patterns: plugin synthetic actions skip their own confirm dialog
   * when `"agent"` (the MCP bridge already confirmed, avoiding a double-prompt);
   * and an action whose danger is conditional on its args (e.g. a safe worktree
   * action that only spawns recipe terminals when given a `recipeId`) may reject
   * the `"plugin"` source for that conditional effect, mirroring the static gate
   * `recipe.run` carries. It is not a general authorization mechanism — don't
   * use it to grant capabilities one source otherwise lacks.
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
  /**
   * When true, dispatches with `source: "plugin"` are rejected by
   * `ActionService` with a `RESTRICTED` error, regardless of `danger`. Use this
   * to keep an action available to user / agent (MCP) dispatch while closing it
   * to the plugin `host.dispatch(...)` path — e.g. `terminal.sendCommand`, whose
   * text-injection effect belongs behind the `agent:input` capability and the
   * first-class `host.sendToActiveAgent(...)` API rather than the ungated `safe`
   * built-in side door (#10558). `danger`-based gating is the wrong tool here:
   * `confirm` would force a host confirmation prompt on every agent/MCP call,
   * and `restricted` would block agents too.
   */
  denyPluginDispatch?: boolean;
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
  /**
   * Command/action-palette behavior. See {@link PaletteBehavior}. Unset behaves
   * as `"run"` — the palette dispatches the action with empty args, gated only
   * by `requiresArgs`. Set this when the action needs an interactive sibling
   * (`redirect`), a focus/selection precondition (`requireContext`), or simply
   * doesn't belong in the palette (`hidden`).
   */
  palette?: PaletteBehavior;
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
  /**
   * When true, dispatching this action never fires the automatic
   * keyboard-shortcut discovery hint (the `ShortcutHint` nudge emitted from
   * `ActionService` on user-source dispatch). Use for actions whose toolbar
   * affordance already carries a meaning-bearing tooltip the hint would
   * duplicate or compete with — e.g. the notification bell, whose tooltip
   * shows the unread count. Buttons that opt out should also skip
   * `useShortcutHintHover`, since the hover path teaches the same hint.
   */
  suppressShortcutHint?: boolean;
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
   * Surfaces in the MCP host confirmation dialog so the user sees the same
   * reasoning the model would. Required when `danger !== "safe"`.
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
  /**
   * Projected from {@link ActionDefinition.palette}. Palette-only — these are
   * read by the action-palette layer and ignored by `dispatch()`/MCP. See
   * {@link PaletteBehavior}.
   */
  /** `palette.mode === "hidden"` — exclude from the palette listing. */
  paletteHidden?: boolean;
  /** `palette.mode === "redirect"` — dispatch this id instead when picked. */
  paletteRedirectTo?: ActionId;
  /** `palette.mode === "requireContext"` and `isReady(ctx)` was false at list() time. */
  paletteDisabled?: boolean;
  /** Reason shown on a `requireContext`-disabled palette row. */
  paletteDisabledReason?: string;
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
  ActionDispatchSuccess<Result> | ActionDispatchError;

export type ActionErrorCode =
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "DISABLED"
  | "RESTRICTED"
  | "CONFIRMATION_REQUIRED"
  | "EXECUTION_ERROR"
  | "USER_REJECTED"
  | "CONFIRMATION_TIMEOUT"
  // Legacy: no longer produced since the elicitation-confirm path was removed
  // (#11342). Retained for compatibility so old persisted audit records still
  // type-check and render; do not reuse for new outcomes.
  | "ELICITATION_FAILED"
  | "BINDING_STALE"
  | "PLUGIN_UNLOADED"
  | "TIER_NOT_PERMITTED"
  | "INVALID_URL";

export interface ActionError {
  code: ActionErrorCode;
  message: string;
  details?: unknown;
}

export interface ActionDispatchOptions {
  source?: ActionSource;
  /**
   * Trusted host attestation that a `danger: "confirm"` action was approved —
   * NOT a client/agent-supplied value. For MCP dispatch it is set true only by
   * the renderer AFTER the user approves the native ConfirmDialog, or by a
   * host-issued native automation grant. An external client's request always
   * arrives unconfirmed; never forward a client field into this flag — doing so
   * was the #11342 self-approval vulnerability. Absent/false ⇒ the action is
   * routed through host confirmation before it can execute.
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

/**
 * Ranking projection consumed by the palette search ranker and the agent tray.
 * `score` is the action's usage count within the rolling window (see
 * {@link ActionUsageEntry}); `lastAccessedAt` is its most-recent use. Produced
 * by `getSortedActionMruList()` — not the persisted shape.
 */
export interface ActionFrecencyEntry {
  id: string;
  score: number;
  lastAccessedAt: number;
}

/**
 * Persisted / IPC shape for action usage. Stores the raw use timestamps (within
 * the rolling window) so a genuine 7-day count can be recomputed on load rather
 * than a decaying scalar. See `shared/utils/actionUsage.ts`.
 */
export interface ActionUsageEntry {
  id: string;
  /** Sorted-ascending epoch-ms use timestamps within the rolling window. */
  uses: number[];
}

/**
 * Slim, IPC-safe projection of {@link ActionManifestEntry} exposed to plugins
 * via `host.actions.list()` / `host.actions.get()` (#10561). Deliberately drops
 * the fields that have no meaning across the plugin boundary: palette state
 * (`paletteHidden`/`paletteRedirectTo`/…), live renderer-context state
 * (`enabled`/`disabledReason`), the MCP-internal classification (`name`,
 * `mcpVisibility`, `mcpAnnotations`, `band`), and `pluginId`. Every field is a
 * plain JSON value so the entry survives Electron's structured-clone IPC
 * boundary unchanged.
 */
export interface PluginActionManifestEntry {
  /** The action id to pass to `host.dispatch()`. */
  id: ActionId;
  title: string;
  description: string;
  category: string;
  kind: ActionKind;
  /**
   * Base danger classification. `host.dispatch()` rejects `"confirm"` actions
   * with `CONFIRMATION_REQUIRED` (plugins cannot bypass the prompt) and never
   * exposes `"restricted"` actions in the catalog — so a listed entry is always
   * `"safe"` or `"confirm"`. Use `host.actions.canDispatch(id)` for a pre-flight
   * check before triggering.
   */
  danger: ActionDanger;
  /** JSON Schema for the action's args, or undefined when it takes none. */
  inputSchema?: Record<string, unknown>;
  /** True when the action's schema rejects an empty args object. */
  requiresArgs: boolean;
  /** Synonyms / alternative mental-model terms, when the action declares them. */
  keywords?: string[];
  /** Concrete usage examples pairing args with a short description. */
  examples?: readonly ActionExample[];
  /** Human-readable rationale for a non-`safe` danger rating. */
  dangerRationale?: string;
}

/**
 * Pre-flight verdict from `host.actions.canDispatch(id)` (#10561), letting a
 * plugin detect a confirm-gated or unavailable action before calling
 * `host.dispatch()`:
 * - `"ok"` — a `danger:"safe"` action; `dispatch()` proceeds without a prompt.
 * - `"confirm"` — a `danger:"confirm"` action; `dispatch()` returns
 *   `CONFIRMATION_REQUIRED` (plugins cannot pre-confirm). The plugin should warn
 *   the user or route through an interactive sibling action.
 * - `"restricted"` — the action is `danger:"restricted"`, unknown, or otherwise
 *   not exposed to plugins; `dispatch()` would return `RESTRICTED` / `NOT_FOUND`.
 */
export type PluginCanDispatchResult = "ok" | "confirm" | "restricted";
