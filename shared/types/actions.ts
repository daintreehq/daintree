import type { BuiltInKeyAction } from "./keymap.js";
import type { BuiltInRuntimeActionId } from "../config/actionIds.js";
import type { z } from "zod";
import type { CopyTreeRunSource } from "./ipc/copyTreeHistory.js";

export type ActionSource = "user" | "keybinding" | "menu" | "agent" | "context-menu" | "plugin";

export type ActionKind = "command" | "query";

export type ActionDanger = "safe" | "confirm" | "restricted";

export type RiskBand =
  "reversible" | "external-effect" | "destructive-local" | "destructive-network";

export type McpVisibility = "core" | "hidden";

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

/**
 * Marks an action as on its way out, so a client can migrate before the removal
 * rather than after it (#11549). Surfaced through the `mcp.surface` manifest —
 * deliberately not through the tool description, which is model-facing prose an
 * automated compatibility check cannot read.
 *
 * Presence is the whole signal: an action carrying this is deprecated, and one
 * without it is not. `reason` is required because a deprecation nobody can act
 * on is just a warning, and `replacedBy` names the successor when there is one.
 */
export interface ActionDeprecation {
  reason: string;
  replacedBy?: ActionId;
}

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
  /**
   * The active workspace is a project OR a scratch — switching to one clears
   * the other's pointer (#11076). Without these an action dispatched in a
   * scratch sees no workspace at all, which is what left the file browser
   * silently no-opping there (#11482). Project fields still win where both are
   * briefly set, mirroring `resolveWorkspaceCwd`'s precedence.
   */
  scratchId?: string;
  scratchName?: string;
  scratchPath?: string;
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
  /**
   * Which UI surface triggered a copy-tree run, for the project's copy-tree
   * history (#11732). Set by `ActionService.dispatch` from the matching
   * {@link ActionDispatchOptions} field.
   *
   * Deliberately here and not in any action's `argsSchema`: it exists because
   * `dispatchSource` cannot separate the worktree card from the file browser
   * (both `"context-menu"`), and putting it in args would publish it on the MCP
   * tool surface where an agent could label its own runs as a user's click.
   * Purely descriptive — it grants nothing and gates nothing.
   */
  copyTreeRunSource?: CopyTreeRunSource;
  /**
   * Whether the host already attested this dispatch as approved. Set by
   * `ActionService.dispatch` from {@link ActionDispatchOptions.confirmed}
   * unconditionally, so — like `dispatchSource` — a caller cannot spoof it by
   * planting a value on `contextOverride`, and a definition cannot read a stale
   * one left on a shared context object.
   *
   * This is the trusted half of a deliberate pair. An action's own `argsSchema`
   * may also carry a `confirmed` field; that one is client-settable and only
   * skips the action's inner gate. This one carries the approval the host
   * actually obtained — the native ConfirmDialog the MCP bridge raised, or a
   * host-issued grant — which is why `run()` can trust it to mean the user has
   * already answered. Without it a `danger:"confirm"` action re-asked after the
   * host modal was approved, staged a second dialog and changed nothing (#12120).
   *
   * Deliberately absent for user-source dispatch, where `options.confirmed` is
   * unset: the in-app dialog is that surface's own confirmation, and its call
   * sites re-dispatch with `confirmed: true` in args once the user approves.
   *
   * Narrow by design — it attests to THIS dispatch's approval and nothing else.
   * It is not a capability grant: an action still decides for itself what an
   * approval permits.
   */
  hostConfirmed?: boolean;
  /**
   * The per-target approvals a selectable host confirmation came back with, for
   * an action whose dialog let the approver deselect individual targets before
   * approving (#12123). Set by `ActionService.dispatch` from
   * {@link ActionDispatchOptions.hostApprovedTargets}, so — like
   * {@link hostConfirmed} — a caller cannot plant one on `contextOverride`, and
   * it never appears on the MCP tool surface where a model could name its own
   * approvals.
   *
   * Deliberately here and not in any action's `argsSchema`, for the same reason
   * {@link copyTreeRunSource} is: publishing it as an argument would let an
   * agent claim a human unchecked rows they never saw.
   *
   * Three states, all distinct. Absent means no selectable confirmation ran, so
   * an action that needs one must refuse rather than assume every target was
   * approved. A populated array names exactly the targets kept, and only those.
   * An empty array means an approval that kept nothing — which the MCP confirm
   * dialog deliberately does not offer, since unchecking every row is Cancel
   * with an extra click, so it reaches an action only from a host that chose to
   * send one. Handled rather than rejected: the honest result is that every
   * target was excluded, and an action must not read "approved" plus an empty
   * list as permission to act on the full request.
   */
  hostApprovedTargets?: readonly HostApprovedTarget[];
  /**
   * The recipe run a human approved in the host confirm dialog, for a dispatch
   * that spawns a recipe's terminals (#12263). Set by `ActionService.dispatch`
   * from {@link ActionDispatchOptions.hostApprovedRecipeRun} on the same terms
   * as {@link hostApprovedTargets}: host-only, never on any `argsSchema`, and
   * stamped over whatever a `contextOverride` claimed.
   *
   * Absent is the default and the fail-safe. It means no dialog listed this
   * recipe's terminals — an unconfirmed call, or one pre-authorized by a
   * standing automation grant, which names a tool in Settings and shows nobody
   * a preview. Those keep the smaller unapproved ceiling
   * (`MAX_AGENT_RECIPE_TERMINALS`). Present means a human read the terminals
   * the dialog listed and approved starting them, so the run may start that
   * many rather than the first three.
   */
  hostApprovedRecipeRun?: HostApprovedRecipeRun;
}

/**
 * The recipe run one human approval in the host confirm dialog covers (#12263).
 *
 * Names WHAT was offered, not merely that something was, in three parts that
 * together pin the offer to one recipe, one size and one set of commands.
 *
 * `recipeId` is the RESOLVED winner: `getRecipeById` follows shadowing, so the
 * id a caller asked for and the recipe that actually runs can differ (#8725).
 * `terminalCount` is the blast radius the approver read, so a recipe that grew
 * between the preview and the run cannot start terminals nobody was offered.
 * `terminalsDigest` covers the contents, because the first two are satisfied by
 * a recipe whose commands were rewritten under the same id while the dialog
 * waited — which is a live window, not a theoretical one, since the composites
 * await a worktree creation before their recipe runs.
 *
 * An approval that fails ANY of the three authorizes nothing at all — not the
 * unapproved ceiling. The two cases are genuinely different: an absent approval
 * means nobody was shown anything and the conservative default applies, while a
 * failed one is positive evidence that what will run is not what was approved.
 * Falling back there would start terminals off the back of an approval for
 * something else, so the run reports every index as a failure and the caller
 * asks again (#8331).
 */
export interface HostApprovedRecipeRun {
  /** The recipe the dialog previewed, after shadow resolution (#8725). */
  recipeId: string;
  /** How many terminals the dialog said would start. */
  terminalCount: number;
  /** Fingerprint of the terminals it listed — see `recipeApprovalDigest`. */
  terminalsDigest: string;
}

/**
 * One target a human kept selected in a host confirmation that offered
 * per-target deselection (#12123).
 *
 * Carries the state the row was SHOWING when the list froze, not the state at
 * the moment Approve was clicked. That is the whole point: an approval covers
 * the consequence the approver was actually shown, so the action re-reads live
 * state immediately before it commits and skips any target that has since
 * escalated past what the row said. Without the frozen bit the action could
 * only skip everything currently running an agent — including the rows whose
 * "agent running" badge the human read and approved anyway.
 */
export interface HostApprovedTarget {
  /** The target's id, exactly as the confirmation listed it. */
  id: string;
  /** Whether the frozen confirmation row showed an agent as running. */
  observedAgentRunning: boolean;
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
  /**
   * Runtime contract for what `run()` returns — enforced, not documentation.
   * `ActionService.dispatch` parses every result through this schema before
   * returning it, so unknown keys are stripped (zod objects default to
   * `"strip"`) and the delivered payload matches the published projection.
   * A result that fails to parse yields `RESULT_VALIDATION_ERROR`.
   *
   * Enforcement keys off this field's presence, NOT off `mcpOutputSchema` —
   * the MCP text response serializes the same value whether or not the schema
   * is advertised, so gating on the advertising flag would leave that path
   * unfiltered.
   *
   * Constructs that opt out of stripping (`z.unknown()`, `z.any()`,
   * `.catchall()`, `z.record(k, z.unknown())`, `z.union([X, z.unknown()])`)
   * make the parse a no-op for the nodes they cover. `resultSchemaHygiene`
   * fails on any new one that is not explicitly allowlisted with a reason.
   */
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
  /**
   * Declares that *every* exception escaping `run()` has already produced a
   * user-visible error notification. The action palette reads this (via
   * `ActionService.selfNotifiesOnExecutionError`) to suppress its generic
   * "Couldn't run '<title>'" toast for `EXECUTION_ERROR`, so the action's own
   * specific toast isn't stacked underneath a vaguer duplicate.
   *
   * Renderer-local by design — deliberately *not* on `ActionManifestEntry`,
   * since it describes renderer toast ownership and means nothing to MCP
   * clients or plugin hosts.
   *
   * Only set this when the catch genuinely covers the whole run surface —
   * including argument/precondition throws, which are easy to leave outside
   * the `try`. A partial catch makes the claim false and silently swallows the
   * uncovered failures at the palette. Errors raised *before* `run()` (arg
   * validation, `NOT_FOUND`) carry a different code and still toast normally.
   */
  selfNotifiesOnExecutionError?: boolean;
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
   * MCP listing visibility, applied on top of the tier allowlist — never
   * instead of it. `hidden` withholds the tool from `tools/list` *and* from
   * introspection results; `core` is an advisory marker for the bootstrap
   * cohort and does not itself grant or widen anything. Unset (the norm) means
   * the tool is listed whenever its tier permits it.
   *
   * There is no lazy-loading tier here. `discoverable` used to promise that a
   * tool omitted from `tools/list` stayed reachable through `actions.search` +
   * `actions.getSchema`; #11585 established that no shipped client can act on
   * that, so the value meant deletion while reading as deferral. To take a tool
   * away from a caller class, remove it from that tier's allowlist — which
   * revokes it at both the listing and dispatch gates, visibly.
   */
  mcpVisibility?: McpVisibility;
  /**
   * Marks the action as deprecated. Projected onto {@link ActionManifestEntry}
   * and reported by `mcp.surface` so an MCP client can migrate ahead of the
   * removal. See {@link ActionDeprecation}.
   */
  deprecated?: ActionDeprecation;
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
  /** MCP listing visibility. Layered on the tier allowlist, never a substitute. */
  mcpVisibility?: McpVisibility;
  /** Set when the action is deprecated. Reported by `mcp.surface` (#11549). */
  deprecated?: ActionDeprecation;
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
  /**
   * `run()` completed but its return value did not satisfy the action's own
   * `resultSchema`. Distinct from `EXECUTION_ERROR` (which means `run()` threw)
   * because the action's side effects DID happen — only the payload is
   * unusable. Signals a bug in the action itself, not in the caller's request.
   */
  | "RESULT_VALIDATION_ERROR"
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
  /**
   * An `*Owned` MCP cleanup tool was called with a resource the calling session
   * did not create (#11909). Distinct from `NOT_FOUND`, which would answer a
   * question the caller is not entitled to ask: whether the id exists at all.
   * See `RESOURCE_NOT_OWNED_CODE` in the MCP server's `shared.ts`.
   */
  | "RESOURCE_NOT_OWNED"
  /**
   * `run()` threw a `PartialSuccessError`: a composite created something real
   * — a worktree — and then failed on a later step, so the failure carries what
   * already exists in its `PARTIAL_SUCCESS:` payload.
   *
   * Distinct from `EXECUTION_ERROR` because it is a provenance claim, not just
   * a classification: only in-repo code can construct that error class, so this
   * code is what lets the MCP ownership ledger trust the payload. An upstream
   * forge or git failure that merely *looks* like one arrives as
   * `EXECUTION_ERROR` and is refused (#11909).
   */
  | "PARTIAL_SUCCESS"
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
   * was the #11342 self-approval vulnerability. Absent/false ⇒ ActionService
   * refuses a `danger:"confirm"` dispatch with `CONFIRMATION_REQUIRED`; the MCP
   * renderer bridge is what surfaces the native ConfirmDialog and re-dispatches
   * (with this flag set) only after the user approves.
   */
  confirmed?: boolean;
  /**
   * Override the action context instead of using current UI state.
   * Used by agent dispatch to bind context at dispatch time and prevent confused-deputy attacks.
   */
  contextOverride?: ActionContext;
  /** See {@link ActionContext.copyTreeRunSource}. */
  copyTreeRunSource?: CopyTreeRunSource;
  /**
   * Trusted per-target approvals from a selectable host confirmation — NOT a
   * client-supplied value. See {@link ActionContext.hostApprovedTargets}. Set
   * only by the MCP renderer bridge, from the rows the approver left checked.
   */
  hostApprovedTargets?: readonly HostApprovedTarget[];
  /**
   * Trusted record of the recipe a host confirmation offered and a human
   * approved — NOT a client-supplied value. See
   * {@link ActionContext.hostApprovedRecipeRun}. Set only by the MCP renderer
   * bridge, from the preview the approver actually read.
   */
  hostApprovedRecipeRun?: HostApprovedRecipeRun;
}

export interface ActionDispatchPayload {
  actionId: ActionId;
  args?: unknown;
  context: ActionContext;
  source: ActionSource;
  timestamp: number;
  /** Host attestation that a danger:"confirm" action was approved (native ConfirmDialog or host grant) — never set from client input. Absent for user-source and safe actions. */
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
