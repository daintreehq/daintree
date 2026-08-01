import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  ActionContext,
  ActionDispatchResult,
  BuiltInActionId,
} from "../../../shared/types/actions.js";
import type {
  McpAuditRecord,
  McpAuditResult,
  McpConfirmationDecision,
  McpRuntimeSnapshot,
  McpRuntimeState,
} from "../../../shared/types/ipc/mcpServer.js";
import type { HelpAssistantTier } from "../../../shared/types/ipc/maps.js";
import type { AgentState } from "../../../shared/types/agent.js";
import {
  type WaitUntilIdleResult,
  DEFAULT_WAIT_UNTIL_IDLE_TIMEOUT_MS,
  MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS,
  WAIT_UNTIL_IDLE_INPUT_SCHEMA,
  WAIT_UNTIL_IDLE_OUTPUT_SCHEMA,
  WAIT_UNTIL_IDLE_DESCRIPTION,
} from "../../../shared/types/terminalWaitUntilIdle.js";
import {
  ACTION_TIER_ADDONS as ACTION_TIER_ADDONS_LIST,
  ACTIONS_LIST_TOOL,
  SYSTEM_TIER_ADDONS as SYSTEM_TIER_ADDONS_LIST,
  WORKBENCH_TIER_TOOLS as WORKBENCH_TIER_TOOLS_LIST,
} from "../../../shared/config/helpAssistantTierAllowlists.js";
import { MCP_EXTERNAL_TIER_TOOLS } from "../../../shared/config/mcpExternalTierAllowlist.js";
import { safeSerializeToolResult } from "../../utils/safeSerializeToolResult.js";
import { buildToolCallTextResult } from "./toolCallResult.js";

// Re-exported for SDK-free consumers that historically imported from here.
// `readinessProbe.ts` and `pluginMcpHash.ts` import from the standalone homes
// directly — this module value-imports the MCP SDK's `types.js` above, so an
// eager import edge into it drags zod schema construction onto the boot path.
export { ACTIONS_LIST_TOOL, safeSerializeToolResult };

export {
  type WaitUntilIdleResult,
  DEFAULT_WAIT_UNTIL_IDLE_TIMEOUT_MS,
  MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS,
  WAIT_UNTIL_IDLE_INPUT_SCHEMA,
  WAIT_UNTIL_IDLE_OUTPUT_SCHEMA,
  WAIT_UNTIL_IDLE_DESCRIPTION,
};

export type McpAuthClass = "external" | HelpAssistantTier;
export type HelpTokenValidator = (token: string) => HelpAssistantTier | false;
/**
 * Resolver used at MCP transport handshake to pin a help-session bearer to
 * the renderer WebContents that minted it. Returning a non-null id causes
 * `httpLifecycle` to record the session in `sessionWebContentsMap` and route
 * all of that session's tool calls through the pinned view rather than the
 * "first live view" fallback. Returns null for non-help bearers (api-key /
 * pane tokens), which keep the existing focused-window semantics.
 */
export type HelpSessionWebContentsResolver = (token: string) => number | null;
/**
 * Resolver used at MCP transport handshake to bind a help-session bearer to
 * the `ActionContext` snapshot captured in the renderer at provision time
 * (#8317). Returning a non-null context causes `httpLifecycle` to record it
 * in `sessionContextMap` so every tool call from that session dispatches
 * against the worktree/terminal the user had focused when they launched the
 * assistant — not whatever they happen to be looking at when the model's
 * tool call lands. Returns null for non-help bearers (api-key / pane
 * tokens), which intentionally keep the live focused-window context.
 */
export type HelpSessionActionContextResolver = (token: string) => ActionContext | null;
/**
 * Resolver used at MCP transport handshake to map a help-session bearer to
 * the public help-session id (the one persisted in the renderer's
 * `helpPanelStore`). The MCP transport mints its own per-connection session
 * id, so without this join the audit log and turn-id lookups can't be
 * correlated back to the help session the user sees. Returns null for
 * non-help bearers (api-key / pane tokens).
 */
export type HelpSessionIdResolver = (token: string) => string | null;
/**
 * Resolver consulted at MCP handshake to pin a `daintree-assistant` pane
 * bearer to the WebContents that launched it (#10647). Same routing effect as
 * {@link HelpSessionWebContentsResolver} but sourced from
 * `McpPaneConfigService` rather than `HelpSessionService`, so the assistant
 * CLI's env-only pane token gets help-session-grade pinning without being
 * promoted to a full help session. Returns null for generic pane tokens.
 */
export type AssistantPaneWebContentsResolver = (token: string) => number | null;
/**
 * Resolver consulted at MCP handshake to replay the launch-time
 * `ActionContext` bound to a `daintree-assistant` pane bearer (#10647).
 * Returns null for generic pane tokens, which keep the live focused-window
 * context.
 */
export type AssistantPaneActionContextResolver = (token: string) => ActionContext | null;
export type { HelpAssistantTier };

export { MCP_SERVER_KEY } from "../../../shared/config/mcpClientConfigs.js";

export const DEFAULT_PORT = 45454;
export const MAX_PORT_RETRIES = 10;
export const MCP_SSE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Lifetime of a renderer-approved session-tier elevation ("Always allow"
 * via {@link minimumPermittingTier}). After this window the session silently
 * decays back to the `workbench` baseline so a stale "Always allow" can't
 * outlive the user's intent across hibernate/wake and project switches
 * (#8462). The next out-of-baseline tool call re-triggers the tier-mismatch
 * banner — there is no separate decay notification. The window is awake-time
 * corrected via {@link SystemSleepService.getAwakeTimeSince} so suspend time
 * doesn't count against it, exactly like the idle reaper. Intentionally
 * equal to {@link MCP_SSE_IDLE_TIMEOUT_MS}: a tier can never silently apply
 * to a session the idle reaper has already collected.
 */
export const MCP_TIER_ELEVATION_TTL_MS = 30 * 60 * 1000;

/**
 * Sliding-TTL window for per-tool grants minted via "Approve once". A grant
 * issued for `(sessionId, toolId)` permits that exact tool for this session
 * for the duration, and any successful dispatch through the grant refreshes
 * the window. Sized comfortably below `MCP_SSE_IDLE_TIMEOUT_MS` so the
 * 30-minute idle reaper can never silently cut a grant short — see #8442.
 */
export const MCP_GRANT_TTL_MS = 15 * 60 * 1000;

/**
 * Hard wall-clock ceiling on a grant's total lifetime, measured from its
 * immutable `issuedAt`. The sliding {@link MCP_GRANT_TTL_MS} window means a
 * model that calls a granted tool more often than once per TTL could
 * otherwise hold the grant indefinitely; this caps the total refreshable
 * lifetime so `refresh()` is blocked and the grant is forcibly revoked once
 * the ceiling elapses, mirroring `sudo`'s max-lifetime enforcement — the
 * next out-of-baseline call then re-triggers the tier-mismatch banner and
 * the user must re-approve (#9161). Intentionally equal to
 * {@link MCP_SSE_IDLE_TIMEOUT_MS} and {@link MCP_TIER_ELEVATION_TTL_MS} so a
 * grant can never outlive its SSE session.
 */
export const MCP_GRANT_MAX_LIFETIME_MS = 30 * 60 * 1000;

/**
 * Periodic sweep cadence for the grant cache's lazy-expiry map. Lazy
 * eviction on read is the source of truth; the sweep is a memory-hygiene
 * pass that keeps idle sessions' expired entries from accumulating between
 * reads.
 */
export const MCP_GRANT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Default use ceiling for a native session-scoped automation grant (#10648)
 * when the renderer issues one without specifying `maxUses`. A native grant
 * authorizes its allowed tools for at most this many dispatches before it
 * exhausts and the user must re-approve.
 */
export const MCP_NATIVE_GRANT_DEFAULT_MAX_USES = 10;

/**
 * Hard bounds on the use ceiling a renderer may request when issuing a native
 * grant. Keeps a single approval from authorizing an unbounded run of
 * automated tool calls — past the ceiling the grant must be re-approved.
 */
export const MCP_NATIVE_GRANT_MIN_MAX_USES = 1;
export const MCP_NATIVE_GRANT_MAX_MAX_USES = 100;

/**
 * Maximum number of tools a single native grant may authorize. A grant is a
 * deliberate, inspectable scope — an unbounded allowlist would defeat the
 * point. Issuance rejects an allowlist larger than this.
 */
export const MCP_NATIVE_GRANT_MAX_ALLOWED_TOOLS = 20;

/**
 * Lower bound on a native grant's requested TTL. Below a minute a grant would
 * expire before the assistant could meaningfully use it; the upper bound is
 * {@link MCP_GRANT_MAX_LIFETIME_MS} so a native grant can never outlive its
 * SSE session, matching the per-tool grant ceiling.
 */
export const MCP_NATIVE_GRANT_MIN_TTL_MS = 60 * 1000;

/**
 * Number of consecutive `(sessionId, toolId)` denials before the renderer
 * banner is silenced. The audit record is always written. The counter
 * resets when a grant is issued for the pair or when the session ends.
 */
export const MCP_DENIAL_SILENCE_THRESHOLD = 2;

export const MCP_MANIFEST_REQUEST_TIMEOUT_MS = 5_000;
export const MCP_DISPATCH_TIMEOUT_MS = 30_000;

export const MAX_RESTART_ATTEMPTS = 5;
export const RESTART_BASE_DELAY_MS = 500;
export const RESTART_MAX_DELAY_MS = 15_000;
export const RESTART_JITTER_MS = 250;
export const RESTART_STABLE_RESET_MS = 30_000;

/**
 * Deadline for the graceful stop drain (#8779). `server.close()` lets
 * in-flight requests finish; if they don't complete within this window the
 * remaining sockets are force-closed so the listening port is released for
 * the next start. Short by design — a settings toggle shouldn't hang on a
 * stuck external client, and well-behaved tool calls finish well inside 3s.
 */
export const MCP_STOP_DRAIN_TIMEOUT_MS = 3_000;

export function mapAgentStateToBusyState(state: AgentState | undefined): "working" | "idle" {
  return state === "working" ? "working" : "idle";
}

export function mapAgentStateToIdleReason(
  state: AgentState | undefined
): WaitUntilIdleResult["idleReason"] {
  switch (state) {
    case "idle":
      return "idle";
    case "waiting":
      return "waiting_for_user";
    case "completed":
      return "completed";
    case "exited":
      return "exited";
    default:
      return "unknown";
  }
}

export const AUDIT_FLUSH_DEBOUNCE_MS = 2000;
export const CONFIRMATION_REQUIRED_CODE = "CONFIRMATION_REQUIRED";
export const USER_REJECTED_CODE = "USER_REJECTED";
export const CONFIRMATION_TIMEOUT_CODE = "CONFIRMATION_TIMEOUT";
export const EXECUTION_ERROR_CODE = "EXECUTION_ERROR";
export const BINDING_STALE = "BINDING_STALE";
export const SESSION_BINDING_GONE = "SESSION_BINDING_GONE";
export const MCP_DEDUP_KEY_COLLISION_CODE = "MCP_DEDUP_KEY_COLLISION";
export const PRE_AUTH_FAILED_CODE = "PRE_AUTH_FAILED";
export const INVALID_URL_CODE = "INVALID_URL";

/**
 * Application-level convention: codes here flag transient failures that a
 * model could reasonably retry without changing arguments. Other codes are
 * structural (validation, permission, missing entity) and a retry would just
 * fail the same way. Not part of the MCP spec — surfaced in the tool-error
 * JSON payload and McpError.data on resource errors.
 */
export const RETRIABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  EXECUTION_ERROR_CODE,
  CONFIRMATION_TIMEOUT_CODE,
]);

export interface McpErrorPayload {
  code: string;
  message: string;
  details?: unknown;
  retriable: boolean;
  errorCategory?: "transient" | "validation" | "business" | "permission";
}

/**
 * Build the structured envelope shared by both surfaces:
 * - Tool path: serialised as JSON in `content[0].text` alongside `isError: true`
 * - Resource path: passed as `data` on the thrown `McpError`
 *
 * `details` is run through `JSON.stringify` once as a safety check — the SDK's
 * transport will stringify the payload again when serialising `McpError.data`
 * or the tool response, and an unserialisable `details` (BigInt, Symbol,
 * circular ref) would crash that downstream serialisation. On failure the
 * field is replaced with `{ serializationError: true }`. `details` is omitted
 * entirely when the caller passes `undefined`, but a caller-supplied `null`
 * is preserved.
 */
export function buildMcpErrorPayload(input: {
  code: string;
  message: string;
  details?: unknown;
}): McpErrorPayload {
  const payload: McpErrorPayload = {
    code: input.code,
    message: input.message,
    retriable: RETRIABLE_ERROR_CODES.has(input.code),
  };
  if (input.code === BINDING_STALE || input.code === SESSION_BINDING_GONE) {
    payload.errorCategory = "business";
  }
  if (input.details !== undefined) {
    let safeDetails: unknown = input.details;
    try {
      JSON.stringify(input.details);
    } catch {
      safeDetails = { serializationError: true };
    }
    payload.details = safeDetails;
  }
  return payload;
}

/**
 * Tool-path error envelope. The text is plain JSON so existing
 * `.toContain("CODE")` assertions remain green and models can `JSON.parse` it
 * for self-correction. Typed as `CallToolResult` so the SDK union (which
 * includes a separate task-result variant requiring `task`) accepts it at
 * the `setRequestHandler` call site.
 */
export function buildToolError(input: {
  code: string;
  message: string;
  details?: unknown;
}): CallToolResult {
  const payload = buildMcpErrorPayload(input);
  // Budgeted like a success body: `details` is renderer-supplied and unbounded,
  // so without the cap the same oversized-result bug stays reachable through
  // failures (#11526). `isError` survives — the call really did fail.
  return buildToolCallTextResult(JSON.stringify(payload), { isError: true });
}

/**
 * `_meta` key carrying the workspace a tool call actually ran against (#11536).
 * Namespaced per the MCP `_meta` convention so it can't collide with keys from
 * other servers in an aggregating client. This string is an external contract:
 * MCP clients read it by name, so changing it is a breaking change.
 */
export const RESOLVED_WORKSPACE_META_KEY = "org.daintree/resolved-workspace";

/**
 * Stamp the resolved workspace onto a tool result (#11536).
 *
 * Top-level `_meta` rather than `structuredContent`, so it never has to satisfy
 * (or violate) an action's declared output schema. Returns the result untouched
 * when identity couldn't be resolved — the key's absence means "unknown", and
 * failing to resolve it must never alter the action's own outcome. Other
 * `_meta` keys are preserved; only Daintree's own key is overwritten, so a
 * value already sitting there can't spoof the authoritative stamp.
 */
export function withResolvedWorkspace<T extends CallToolResult>(
  result: T,
  workspace: DispatchedWorkspaceRef | undefined
): T {
  if (!workspace) return result;
  return {
    ...result,
    _meta: {
      ...(result._meta ?? {}),
      [RESOLVED_WORKSPACE_META_KEY]: { ...workspace },
    },
  };
}

export type McpTier = "workbench" | "action" | "system" | "external";

// Tier tool lists live in `shared/config/helpAssistantTierAllowlists.ts`
// so the renderer's blast-radius preview can read them without an IPC
// round-trip. The arrays remain the single source of truth; this module
// just lifts them into Sets for O(1) membership checks at dispatch time.
// `terminal.waitUntilIdle` is included in `ACTION_TIER_ADDONS_LIST`.
const WORKBENCH_TOOLS: ReadonlySet<string> = new Set(WORKBENCH_TIER_TOOLS_LIST);
const ACTION_TIER_ADDONS: ReadonlySet<string> = new Set(ACTION_TIER_ADDONS_LIST);
const SYSTEM_TIER_ADDONS: ReadonlySet<string> = new Set(SYSTEM_TIER_ADDONS_LIST);

export function unionSet(...sets: ReadonlySet<string>[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const set of sets) {
    for (const value of set) out.add(value);
  }
  return out;
}

// The external tier surface lives in `shared/config/mcpExternalTierAllowlist.ts`
// alongside the three help-assistant tier lists, so all four are curated in one
// place and the renderer can budget-test the surface without an IPC round-trip.
// See that file for the selection rule and why the size is a hard constraint.
const MCP_TOOL_ALLOWLIST: ReadonlySet<string> = new Set(MCP_EXTERNAL_TIER_TOOLS);

export const TIER_ALLOWLISTS: Readonly<Record<McpTier, ReadonlySet<string>>> = {
  workbench: WORKBENCH_TOOLS,
  action: unionSet(WORKBENCH_TOOLS, ACTION_TIER_ADDONS),
  system: unionSet(WORKBENCH_TOOLS, ACTION_TIER_ADDONS, SYSTEM_TIER_ADDONS),
  external: MCP_TOOL_ALLOWLIST,
};

export const TIER_NOT_PERMITTED_CODE = "TIER_NOT_PERMITTED";

/**
 * Creation-tool allowlist for per-session idempotency dedup. LLMs replay
 * tool calls during multi-step planning, especially across reconnects.
 * Inside the TTL window a duplicate call returns the original result
 * instead of redispatching, with an args-hash guard rejecting same-key
 * different-args replays as a collision (#8429).
 *
 * A tool belongs here only when all three hold: (a) an LLM retrying after a
 * transient error or reconnect is realistic, (b) the repeat leaves a durable
 * or immediately user-visible artifact — an orphaned terminal, a redundant
 * agent, a duplicate issue/PR/comment/review — and (c) an intentional
 * same-argument repeat inside the TTL is not a normal use case.
 *
 * (c) is what bounds the list. Navigation (`forge.open*`, portal/browser
 * opens) is out: reopening a URL the user closed must dispatch again, and a
 * silent 120s no-op reads as a broken tool. Repeatable commands
 * (`terminal.sendCommand`, `git.stage*`) are out for the same reason. So are
 * idempotent state-sets (close/reopen/draft/edit, label and assignee
 * add/remove, resource pause/resume/teardown): they create no duplicate to
 * suppress, so caching buys nothing and costs correctness — in a set → unset
 * → set sequence the third call matches the first, the cached success
 * returns, and the state stays unset (#11534 dropped `forge.assignIssue` for
 * exactly this).
 *
 * An entry that *does* have an inverse is kept only when the replay it
 * absorbs outweighs the suppression it risks, on one of two grounds.
 * `forge.approvePR`/`forge.requestChanges` POST a genuinely new record each
 * call, so a replay leaves a visible second artifact — unlike assignment,
 * which leaves none, so that trade lands the other way. `worktree.delete`,
 * `forge.createPR` and `forge.mergePR` create nothing on a replay; they are
 * here to return the original success instead of the error a redundant
 * redispatch would raise, which is a different justification from the
 * duplicate-artifact one and should not be confused with it.
 *
 * `git.commit` and `git.push` are the tempting case that still fails (c), so
 * #11534 dropped them. Neither takes an argument a legitimate repeat varies:
 * `git.push` gets only `{cwd, setUpstream}`, and `git.commit` commits
 * whatever the index holds, so a second push after a new commit — or a
 * repeated `wip` message — is same-argument and would be swallowed as a
 * cached success for work that never happened. The replay they would absorb
 * is cheap by comparison: a redundant push prints "Everything up-to-date"
 * and a redundant commit errors visibly on an empty index. The trade only
 * flips with state-aware keying (HEAD for push, index identity for commit).
 *
 * History: seeded by #7554, made safe to widen by the args-hash collision
 * guard (#8429), widened again in #9156, then corrected against the criterion
 * above in #11534 — which added the creation tools that were missing and
 * dropped the navigation, idempotent and git-write entries that never met it.
 */
const MCP_DEDUP_ALLOWLIST_ENTRIES = [
  // Panel/agent spawns — a replay leaves an orphaned terminal or a second
  // agent. `agent.terminal` spawns exactly like `terminal.new` (#11534).
  "terminal.new",
  "agent.terminal",
  "agent.launch",
  "recipe.run",

  // Worktree/workflow creation. `workflow.startWorkOnIssue` is a creation
  // superset of the two below it — a replay duplicates the entire work setup
  // (worktree + branch + agent + injected context) (#11534). Provisioning
  // spins up a remote/cloud resource a retry could double.
  "worktree.createWithRecipe",
  "workflow.startWorkOnIssue",
  "worktree.resource.provision",
  "worktree.delete",

  // Forge writes worth absorbing a replay for. `createIssue`,
  // `addIssueComment`, `commentOnPR`, `approvePR` and `requestChanges` each
  // POST a new record every call — a duplicate issue, a duplicate comment
  // (lesson #7554), or a second review entry, since both verdicts POST to
  // `/pulls/{n}/reviews` (#11534). `createPR` and `mergePR` create nothing on
  // a replay (GitHub 422s a duplicate PR; merge is a PUT) — they are here to
  // replay the original success rather than surface that error to a caller
  // that is only retrying.
  "forge.createPR",
  "forge.mergePR",
  "forge.commentOnPR",
  "forge.createIssue",
  "forge.addIssueComment",
  "forge.approvePR",
  "forge.requestChanges",
] as const satisfies readonly BuiltInActionId[];

export const MCP_DEDUP_ALLOWLIST: ReadonlySet<string> = new Set(MCP_DEDUP_ALLOWLIST_ENTRIES);

/**
 * Dedup window for the creation-tool allowlist. Sized to cover the MCP
 * dispatch timeout (30s) plus a generous LLM retry window without growing
 * unbounded inside a long-running Electron process.
 */
export const MCP_DEDUP_TTL_MS = 120_000;

/**
 * Maximum number of cached results per session in the dedup result cache.
 * Entries are lazy-evicted on read once expired, but a session that issues
 * many unique creation calls (e.g. each with a fresh `requestKey`) would
 * otherwise accumulate entries up to the idle timeout. FIFO-evict on
 * insertion above this cap so memory stays bounded at session lifetime.
 */
export const MCP_DEDUP_MAX_ENTRIES_PER_SESSION = 256;

/**
 * Compute the minimum non-external tier that permits the given tool. Used to
 * tell the renderer how to elevate the session in response to a
 * TIER_NOT_PERMITTED denial: "Approve once" / "Always allow" both target this
 * tier rather than blanket-elevating to `system`. Returns `null` if the tool
 * isn't permitted at any tier (unknown tool).
 *
 * The `external` tier is intentionally excluded because it's a peer of the
 * help-session tiers (api-key sessions only) and is never the right target
 * for renderer-driven elevation.
 */
export function minimumPermittingTier(toolId: string): "workbench" | "action" | "system" | null {
  if (TIER_ALLOWLISTS.workbench.has(toolId)) return "workbench";
  if (TIER_ALLOWLISTS.action.has(toolId)) return "action";
  if (TIER_ALLOWLISTS.system.has(toolId)) return "system";
  return null;
}

export type ResourceKind = "pulse" | "scrollback" | "agentState" | "issues";

export interface ParsedResourceUri {
  kind: ResourceKind;
  id: string;
}

export const RESOURCE_BACKING_ACTIONS: Readonly<Record<ResourceKind, string>> = {
  pulse: "git.getProjectPulse",
  scrollback: "terminal.getOutput",
  agentState: "terminal.list",
  issues: "forge.listIssues",
};

export const RESOURCE_TEXT_MAX_BYTES = 50 * 1024;

export const RESOURCE_SCROLLBACK_TAIL_LINES = 200;

export interface PromptRenderContext {
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeIssueNumber?: number;
  terminalOutput?: string;
}

export interface PromptArgumentDefinition {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptDefinition {
  name: string;
  description: string;
  arguments: PromptArgumentDefinition[];
  render(args: Record<string, string>, context: PromptRenderContext): string;
}

export const PROMPT_TERMINAL_OUTPUT_MAX_CHARS = 16_000;

export function pickFenceMarker(content: string): string {
  let length = 3;
  while (length < 12) {
    const candidate = "`".repeat(length);
    if (!content.includes(candidate)) {
      return candidate;
    }
    length += 1;
  }
  return "`".repeat(length);
}

export const PROMPT_DEFINITIONS: readonly PromptDefinition[] = [
  {
    name: "start_issue",
    description: "Start work on a GitHub issue with worktree and project context primed.",
    arguments: [
      {
        name: "issue_number",
        description: "GitHub issue number to start work on (e.g. '6610').",
        required: true,
      },
    ],
    render(args, context) {
      const issueNumber = args.issue_number.trim();
      const worktree = context.worktreePath ?? "(no active worktree detected)";
      const branch = context.worktreeBranch ?? "(unknown branch)";
      return [
        `Help me start work on GitHub issue #${issueNumber}.`,
        "",
        "Active workspace:",
        `- Worktree: ${worktree}`,
        `- Branch: ${branch}`,
        "",
        `Please:`,
        `1. Read issue #${issueNumber} (use the GitHub tools or \`gh issue view ${issueNumber}\`) and summarise the goal in one sentence.`,
        "2. Confirm the worktree above is the right place to do the work, or suggest creating a new one.",
        "3. Outline the first 2–3 concrete steps so I can sign off before you begin editing.",
      ].join("\n");
    },
  },
  {
    name: "triage_failed_agent",
    description: "Diagnose a stuck or failed agent terminal and propose next steps.",
    arguments: [
      {
        name: "terminal_id",
        description:
          "Terminal ID of the failed agent (from `terminal.list`). Optional — omit to triage the current worktree without specific terminal output.",
        required: false,
      },
    ],
    render(args, context) {
      const terminalId = args.terminal_id?.trim();
      const worktree = context.worktreePath ?? "(no active worktree detected)";
      const branch = context.worktreeBranch ?? "(unknown branch)";

      const lines: string[] = [
        "An agent appears to be stuck or failed. Help me diagnose what went wrong and decide what to do next.",
        "",
        "Active workspace:",
        `- Worktree: ${worktree}`,
        `- Branch: ${branch}`,
      ];

      if (terminalId) {
        lines.push(`- Failed terminal: ${terminalId}`);
        lines.push("");
        if (context.terminalOutput !== undefined) {
          if (context.terminalOutput.length === 0) {
            lines.push(
              `Terminal output for ${terminalId} was fetched but is empty — the terminal may have just started or been cleared.`
            );
          } else {
            const fence = pickFenceMarker(context.terminalOutput);
            lines.push("Recent terminal output (most recent lines):");
            lines.push(fence);
            lines.push(context.terminalOutput);
            lines.push(fence);
          }
        } else {
          lines.push(
            `Terminal output for ${terminalId} could not be fetched — call \`terminal.getOutput\` directly to retrieve it.`
          );
        }
      } else {
        lines.push("");
        lines.push(
          "No terminal_id was provided. Use `terminal.list` to find the stuck agent's terminal, then `terminal.getOutput` to inspect its recent activity."
        );
      }

      lines.push("");
      lines.push("Please:");
      // Tier-agnostic on purpose: `git.getStagingStatus` is a workbench/system
      // tool, so naming it unconditionally would tell an external session to
      // call something it will be refused for (#11585). Same shape as the
      // `start_issue` prompt's "GitHub tools or `gh`" phrasing.
      lines.push(
        "1. Read the current git status (`git.getStagingStatus` if available, otherwise `git status`) to see what changed."
      );
      lines.push(
        "2. Identify the root cause (error message, missing prerequisite, infinite loop, etc.)."
      );
      lines.push(
        "3. Recommend a concrete next step: retry, kill and restart, hand back to me, or escalate."
      );

      return lines.join("\n");
    },
  },
  {
    name: "triage_terminals",
    description:
      "Agent-watching recipe: how to watch one or many agent terminals without blocking the session — terminal.getStatus polling, skip working agents, cross-check stuck state with includeOutput, and pace with ScheduleWakeup.",
    arguments: [],
    render() {
      return [
        "Use `terminal.getStatus` for fleet polling. It returns the full agent state (`idle | working | waiting | directing | completed | exited`), `waitingReason`, and `lastTransitionAt` for many terminals in a single call, with optional recent-output tails for cross-checking the state cache. Don't fan `terminal.waitUntilIdle({ timeoutMs: 0 })` out across N terminals — that pattern is N IPC round-trips per round and gives no cheap way to verify state against actual scrollback.",
        "",
        "**Recipe:**",
        "",
        "1. **Snapshot the fleet in one call.** Pass `terminalIds` (when you know what you spawned) or a `worktreeId`/`location` filter. Each entry returns `agentState`, `waitingReason` (when waiting), `lastTransitionAt`, an optional `lastCheckResult` (parsed test/lint/build pass/fail — see step 5b), and an optional `recentOutput` tail.",
        '2. **Skip working terminals.** When `agentState === "working"` (or `"directing"`) the agent is mid-task — nothing to act on this round.',
        '3. **Skip already-handled transitions.** Track the last `lastTransitionAt` you acted on per terminal and skip when it hasn\'t advanced. `lastTransitionAt` is `undefined` for terminals that have never transitioned — treat that as "no transition yet," not as "changed."',
        "4. **Act on `agentState`** for non-working terminals:",
        "   - `completed` — agent finished its task; record the result and dispatch the next step.",
        "   - `exited` — agent process exited; surface to the user, the terminal won't recover on its own.",
        '   - `waiting` — agent paused, likely needing input. `waitingReason` distinguishes `"prompt"` (empty input prompt, safe to auto-drive), `"question"` (agent is asking the user something — verify before auto-replying), `"approval"` (a permission/approval selector needs a specific choice — send the selection keys, not free text), and `"error"` (agent stopped after a blocking error such as auth/rate limit/network — input alone may not unblock it; surface to the user when unsure).',
        "   - `idle` — agent is settling between subtasks; skip and re-poll.",
        "   - `null` — no agent attached or unknown state; treat as still busy.",
        "5. **Cross-check stuck state with `includeOutput`.** The state cache is a heuristic, not ground truth — `ActivityMonitor` can pin a finished agent at `working`. **If `agentState` for a given terminal hasn't transitioned across roughly 3 polling rounds, set `includeOutput` on the next round to verify against actual terminal text.** A short scrollback tail is usually enough to tell a stuck FSM from a genuinely working agent.",
        "5b. **Route on `lastCheckResult` instead of scraping tails.** When present it carries `{ command, passed, ranAt, failureSummary, truncated }` parsed from the agent's last recognized tsc/ESLint/Vitest/Jest summary — use `passed` to branch (e.g. proceed vs. tell the agent to fix), and `failureSummary` to see what broke without an `includeOutput` round-trip. It is PARSED, not an authoritative exit code: trust it for routing but confirm with `recentOutput` before anything destructive. Absence means no recognized check summary was seen — NOT that a check passed or that none ran. Check `ranAt` against `lastTransitionAt` to confirm the result is from the current run.",
        "6. **Pace the next round with `ScheduleWakeup`.** Don't busy-loop. `ScheduleWakeup` resumes the orchestrator after a delay without holding a blocking call open, so it stays responsive to user interrupts.",
        "",
        "Sketch:",
        "",
        "```ts",
        "const stuckCount: Record<string, number> = {};",
        "const lastSeen: Record<string, number | undefined> = {};",
        "",
        "// Plain status round.",
        "const { terminals } = await getStatus({ terminalIds });",
        "",
        '// Identify terminals pinned at "working" for ~3 rounds and pull their output.',
        "// The state cache is a heuristic — recentOutput is ground truth.",
        "const stuckIds = terminals",
        "  .filter(",
        "    (t) =>",
        '      (t.agentState === "working" || t.agentState === "directing") &&',
        "      (stuckCount[t.terminalId] ?? 0) >= 3",
        "  )",
        "  .map((t) => t.terminalId);",
        "const stuck = stuckIds.length",
        "  ? (await getStatus({ terminalIds: stuckIds, includeOutput: { lines: 30 } })).terminals",
        "  : [];",
        "const stuckById = new Map(stuck.map((s) => [s.terminalId, s]));",
        "",
        "for (const t of terminals) {",
        "  if (t.error) continue; // log and move on (e.g. unknown terminalId)",
        "",
        "  // Cross-check: if scrollback shows a settled prompt or a clear completion",
        '  // signature, treat the terminal as idle even though the FSM says "working".',
        '  // What "settled" looks like is project-specific (shell prompt at EOL,',
        '  // "press any key", agent\'s own done banner, etc.).',
        "  const stuckEntry = stuckById.get(t.terminalId);",
        "  const looksSettled = stuckEntry?.recentOutput",
        "    ? scrollbackLooksSettled(stuckEntry.recentOutput)",
        "    : false;",
        "",
        '  if ((t.agentState === "working" || t.agentState === "directing") && !looksSettled) {',
        "    stuckCount[t.terminalId] = (stuckCount[t.terminalId] ?? 0) + 1;",
        "    continue;",
        "  }",
        "  if (t.lastTransitionAt !== undefined && t.lastTransitionAt === lastSeen[t.terminalId]) continue;",
        "",
        '  const effectiveState = looksSettled ? "completed" : t.agentState;',
        "  switch (effectiveState) {",
        '    case "completed":',
        "      /* dispatch next step */ break;",
        '    case "exited":',
        "      /* surface to user */ break;",
        '    case "waiting":',
        '      /* t.waitingReason: "prompt" → safe to auto-drive; "question" → verify against scrollback, then act or ask; */',
        '      /* "approval" → answer the selector (keys, not prose); "error" → check scrollback, often needs the user */',
        "      break;",
        "  }",
        "  stuckCount[t.terminalId] = 0;",
        "  if (t.lastTransitionAt !== undefined) lastSeen[t.terminalId] = t.lastTransitionAt;",
        "}",
        "// then: ScheduleWakeup({ delaySeconds: 30, ... });",
        "```",
        "",
        "**Single terminals pace the same way.** Don't hold a blocking `terminal.waitUntilIdle` open to wait out a task — while the call is in flight the user can't talk to you, so an interactive session looks frozen until they cancel it (the server caps interactive waits at 60s for this reason). Kick off the task, then `ScheduleWakeup` → non-blocking check (`terminal.getStatus` or `waitUntilIdle({ timeoutMs: 0 })`) → repeat. A short bounded `waitUntilIdle` long-poll is fine when completion is expected within the minute; on `timedOut: true`, fall back to wakeup pacing instead of re-blocking back-to-back.",
        "",
        '**Fleet broadcast runs are supervised.** When the user fans a prompt out with the in-app fleet broadcast, `fleet.getRunStatus` returns the supervised run in one call: per-target submission outcome (`sent` / `failed` with `permanent`-vs-`transient` classification / `skipped` on cancel), a live `agentState` snapshot, `settled` flags, and aggregate counts. Use it to answer "how is the fleet run going" instead of reconstructing the picture from raw `terminal.getStatus` — but keep using `terminal.getStatus` (with `includeOutput`) as ground truth before acting on any single terminal. `fleet.getRunStatus` never dispatches anything, and there is deliberately no MCP tool that broadcasts to the whole fleet: to orchestrate your own fan-out, send one `terminal.sendCommand` per terminal and watch with batched `terminal.getStatus` / a bounded `terminal.waitUntilIdleBatch`.',
      ].join("\n");
    },
  },
];

export interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  webContentsId: number;
  destroyedCleanup?: () => void;
}

/**
 * The workspace a dispatch actually landed on, resolved from the responding
 * renderer at response time (#11536). Unpinned external sessions follow window
 * focus on every call, so a long-running agent's calls can retarget mid-session
 * when the user switches workspace. Reporting the resolved workspace makes that
 * drift observable to the caller instead of silent.
 *
 * "Workspace" because a renderer view can be backed by a project or by a
 * scratch, which has no Project row; `kind` tells the caller which, so it never
 * has to guess whether the id is resolvable through project APIs. Structurally
 * mirrors `WorkspaceRef` in `electron/window/ProjectViewManager.ts` — the wire
 * contract is declared here so this module stays free of window-layer imports,
 * and rendererBridge assigning one to the other keeps the two in lockstep.
 */
export interface DispatchedWorkspaceRef {
  kind: "project" | "scratch";
  workspaceId: string;
  workspacePath: string;
}

export interface DispatchEnvelope {
  result: ActionDispatchResult;
  confirmationDecision?: McpConfirmationDecision;
  /**
   * Absent when identity could not be resolved (view torn down between
   * dispatch and response, or a webContents with no registered workspace).
   * Deliberately optional rather than nullable: "unknown" must not be
   * confusable with "no workspace", and a failed lookup never downgrades an
   * otherwise successful action result.
   */
  dispatchedWorkspace?: DispatchedWorkspaceRef;
}

export interface McpSseSession {
  transport: import("@modelcontextprotocol/sdk/server/sse.js").SSEServerTransport;
  // The per-session `Server` instance. Stored so the tier-decay path can
  // call `sendToolListChanged()` on this exact session when its elevation
  // window expires (#8462) — `McpHttpSession` already carries it for the
  // same reason; the SSE path previously let the reference go out of scope
  // after `server.connect(transport)`.
  server: import("@modelcontextprotocol/sdk/server/index.js").Server;
  idleTimer: ReturnType<typeof setTimeout>;
}

export interface McpHttpSession {
  transport: import("@modelcontextprotocol/sdk/server/streamableHttp.js").StreamableHTTPServerTransport;
  server: import("@modelcontextprotocol/sdk/server/index.js").Server;
  idleTimer: ReturnType<typeof setTimeout>;
}

const RESOURCE_URI_PATTERN =
  /^daintree:\/\/(worktree|terminal|agent|project)\/([^/]+)\/(pulse|scrollback|state|issues)$/;

export function parseResourceUri(uri: string): ParsedResourceUri | null {
  const match = RESOURCE_URI_PATTERN.exec(uri);
  if (!match) return null;
  const host = match[1];
  let id: string;
  try {
    id = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  const verb = match[3];
  if (host === "worktree" && verb === "pulse") return { kind: "pulse", id };
  if (host === "terminal" && verb === "scrollback") return { kind: "scrollback", id };
  if (host === "agent" && verb === "state") return { kind: "agentState", id };
  if (host === "project" && id === "current" && verb === "issues") return { kind: "issues", id };
  return null;
}

/**
 * Unwrap a successful dispatch result, or throw a structured `McpError` for the
 * failure case. Used inside resource handlers where the SDK serialises thrown
 * errors as JSON-RPC error responses — embedding the action's `code`, `details`
 * and `retriable` flag in `McpError.data` keeps the resource error wire shape
 * aligned with the tool-path JSON envelope.
 */
export function unwrapDispatchResult(envelope: DispatchEnvelope): unknown {
  const result = envelope.result;
  if (result.ok) return result.result;
  const message = `Action failed [${result.error.code}]: ${result.error.message}`;
  throw new McpError(
    ErrorCode.InternalError,
    message,
    buildMcpErrorPayload({
      code: result.error.code,
      message: result.error.message,
      details: result.error.details,
    })
  );
}

export function serializeResourcePayload(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "string") return value;
  return safeSerializeToolResult(value);
}

export function truncateText(text: string, maxBytes: number = RESOURCE_TEXT_MAX_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const sliced = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  return `${sliced}\n\n[truncated]`;
}

export function readStringField(value: unknown, keys: readonly string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const v = record[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

export type {
  McpAuditRecord,
  McpAuditResult,
  McpConfirmationDecision,
  McpRuntimeSnapshot,
  McpRuntimeState,
};
