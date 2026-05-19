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
  SYSTEM_TIER_ADDONS as SYSTEM_TIER_ADDONS_LIST,
  WORKBENCH_TIER_TOOLS as WORKBENCH_TIER_TOOLS_LIST,
} from "../../../shared/config/helpAssistantTierAllowlists.js";
import { RISK_BAND_OPEN_WORLD_CATEGORIES } from "../../../shared/utils/actionRiskBand.js";

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
export type { HelpAssistantTier };

export const MCP_SERVER_KEY = "daintree";

export const DEFAULT_PORT = 45454;
export const MAX_PORT_RETRIES = 10;
export const MCP_SSE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Sliding-TTL window for per-tool grants minted via "Approve once". A grant
 * issued for `(sessionId, toolId)` permits that exact tool for this session
 * for the duration, and any successful dispatch through the grant refreshes
 * the window. Sized comfortably below `MCP_SSE_IDLE_TIMEOUT_MS` so the
 * 30-minute idle reaper can never silently cut a grant short — see #8442.
 */
export const MCP_GRANT_TTL_MS = 15 * 60 * 1000;

/**
 * Periodic sweep cadence for the grant cache's lazy-expiry map. Lazy
 * eviction on read is the source of truth; the sweep is a memory-hygiene
 * pass that keeps idle sessions' expired entries from accumulating between
 * reads.
 */
export const MCP_GRANT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Number of consecutive `(sessionId, toolId)` denials before the renderer
 * banner is silenced. The audit record is always written. The counter
 * resets when a grant is issued for the pair or when the session ends.
 */
export const MCP_DENIAL_SILENCE_THRESHOLD = 2;

export const MCP_MANIFEST_REQUEST_TIMEOUT_MS = 5_000;
export const MCP_DISPATCH_TIMEOUT_MS = 30_000;

export const ACTIONS_LIST_TOOL = "actions.list";

export const MAX_RESTART_ATTEMPTS = 5;
export const RESTART_BASE_DELAY_MS = 500;
export const RESTART_MAX_DELAY_MS = 15_000;
export const RESTART_JITTER_MS = 250;
export const RESTART_STABLE_RESET_MS = 30_000;

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
export const ELICITATION_FAILED_CODE = "ELICITATION_FAILED";
export const EXECUTION_ERROR_CODE = "EXECUTION_ERROR";
export const BINDING_STALE = "BINDING_STALE";
export const SESSION_BINDING_GONE = "SESSION_BINDING_GONE";

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
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: true,
  };
}

export { RISK_BAND_OPEN_WORLD_CATEGORIES as OPEN_WORLD_CATEGORIES };

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

const MCP_TOOL_ALLOWLIST_ENTRIES = [
  ACTIONS_LIST_TOOL,
  "actions.getContext",

  "agent.launch",
  "agent.terminal",
  "agent.getState",

  "git.getProjectPulse",
  "git.getFileDiff",
  "git.listCommits",
  "git.getStagingStatus",
  "git.stageFile",
  "git.unstageFile",
  "git.stageAll",
  "git.unstageAll",
  "git.commit",
  "git.push",
  "git.snapshotGet",
  "git.snapshotList",
  "git.snapshotRevert",
  "git.snapshotDelete",

  "github.checkCli",
  "github.getRepoStats",
  "github.listIssues",
  "github.listPullRequests",
  "github.getIssueByNumber",
  "forge.openIssues",
  "forge.openPRs",
  "forge.openCommits",
  "forge.openIssue",
  "forge.assignIssue",
  "forge.validateToken",
  "github.openPR",

  "terminal.list",
  "terminal.getOutput",
  "terminal.getStatus",
  "terminal.sendCommand",
  "terminal.inject",
  "terminal.new",
  "terminal.waitUntilIdle",

  "worktree.list",
  "worktree.getCurrent",
  "worktree.refresh",
  "worktree.createWithRecipe",
  "worktree.listBranches",
  "worktree.getDefaultPath",
  "worktree.getAvailableBranch",
  "worktree.delete",
  "worktree.setActive",
  "worktree.resource.status",

  "workflow.startWorkOnIssue",
  "workflow.prepBranchForReview",

  "files.search",
  "file.view",
  "file.openInEditor",

  "copyTree.generate",
  "copyTree.generateAndCopyFile",
  "copyTree.injectToTerminal",

  "slashCommands.list",

  "project.getAll",
  "project.getCurrent",
  "project.getSettings",
  "project.getStats",
  "project.detectRunners",
  "project.update",
  "project.saveSettings",
  "project.muteNotifications",

  "recipe.list",
  "recipe.run",

  "system.checkCommand",
  "system.checkDirectory",
] as const satisfies readonly BuiltInActionId[];

const MCP_TOOL_ALLOWLIST: ReadonlySet<string> = new Set(MCP_TOOL_ALLOWLIST_ENTRIES);

export const TIER_ALLOWLISTS: Readonly<Record<McpTier, ReadonlySet<string>>> = {
  workbench: WORKBENCH_TOOLS,
  action: unionSet(WORKBENCH_TOOLS, ACTION_TIER_ADDONS),
  system: unionSet(WORKBENCH_TOOLS, ACTION_TIER_ADDONS, SYSTEM_TIER_ADDONS),
  external: MCP_TOOL_ALLOWLIST,
};

export const TIER_NOT_PERMITTED_CODE = "TIER_NOT_PERMITTED";

/**
 * Creation-tool allowlist for per-session idempotency dedup. LLMs replay
 * tool calls during multi-step planning, especially across reconnects. For
 * these four actions a duplicate call would silently produce a duplicate
 * resource — orphaned terminal, redundant agent, etc. Inside the TTL
 * window the duplicate returns the original result instead of redispatching.
 *
 * Deliberately narrow: blanket-applying dedup to all mutations would mask
 * legitimate "do it again" cases (re-running the same git command, etc.).
 */
export const MCP_DEDUP_ALLOWLIST: ReadonlySet<string> = new Set([
  "terminal.new",
  "worktree.createWithRecipe",
  "agent.launch",
  "recipe.run",
]);

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
  issues: "github.listIssues",
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
      lines.push("1. Read the current git status (`git.getStagingStatus`) to see what changed.");
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
      "Fleet-polling recipe: how to watch multiple agent terminals efficiently using terminal.getStatus, skip working agents, cross-check stuck state with includeOutput, and pace with ScheduleWakeup.",
    arguments: [],
    render() {
      return [
        "Use `terminal.getStatus` for fleet polling. It returns the full agent state (`idle | working | waiting | directing | completed | exited`), `waitingReason`, and `lastTransitionAt` for many terminals in a single call, with optional recent-output tails for cross-checking the state cache. Don't fan `terminal.waitUntilIdle({ timeoutMs: 0 })` out across N terminals — that pattern is N IPC round-trips per round and gives no cheap way to verify state against actual scrollback.",
        "",
        "**Recipe:**",
        "",
        "1. **Snapshot the fleet in one call.** Pass `terminalIds` (when you know what you spawned) or a `worktreeId`/`location` filter. Each entry returns `agentState`, `waitingReason` (when waiting), `lastTransitionAt`, and an optional `recentOutput` tail.",
        '2. **Skip working terminals.** When `agentState === "working"` (or `"directing"`) the agent is mid-task — nothing to act on this round.',
        '3. **Skip already-handled transitions.** Track the last `lastTransitionAt` you acted on per terminal and skip when it hasn\'t advanced. `lastTransitionAt` is `undefined` for terminals that have never transitioned — treat that as "no transition yet," not as "changed."',
        "4. **Act on `agentState`** for non-working terminals:",
        "   - `completed` — agent finished its task; record the result and dispatch the next step.",
        "   - `exited` — agent process exited; surface to the user, the terminal won't recover on its own.",
        '   - `waiting` — agent paused, likely needing input. `waitingReason` distinguishes `"prompt"` (empty input prompt, safe to auto-drive) from `"question"` (agent is asking the user something — verify before auto-replying).',
        "   - `idle` — agent is settling between subtasks; skip and re-poll.",
        "   - `null` — no agent attached or unknown state; treat as still busy.",
        "5. **Cross-check stuck state with `includeOutput`.** The state cache is a heuristic, not ground truth — `ActivityMonitor` can pin a finished agent at `working`. **If `agentState` for a given terminal hasn't transitioned across roughly 3 polling rounds, set `includeOutput` on the next round to verify against actual terminal text.** A short scrollback tail is usually enough to tell a stuck FSM from a genuinely working agent.",
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
        '      /* t.waitingReason: "prompt" → safe to auto-drive; "question" → verify against scrollback, then act or ask */',
        "      break;",
        "  }",
        "  stuckCount[t.terminalId] = 0;",
        "  if (t.lastTransitionAt !== undefined) lastSeen[t.terminalId] = t.lastTransitionAt;",
        "}",
        "// then: ScheduleWakeup({ delaySeconds: 30, ... });",
        "```",
        "",
        "For a single terminal a normal blocking `terminal.waitUntilIdle` call is still the right tool — kick off one task, wait for it to finish.",
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

export interface DispatchEnvelope {
  result: ActionDispatchResult;
  confirmationDecision?: McpConfirmationDecision;
}

export interface McpSseSession {
  transport: import("@modelcontextprotocol/sdk/server/sse.js").SSEServerTransport;
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

export function safeSerializeToolResult(value: unknown): string {
  const seen = new WeakSet<object>();

  try {
    const serialized = JSON.stringify(
      value,
      (_key, currentValue) => {
        if (typeof currentValue === "bigint") {
          return currentValue.toString();
        }
        if (typeof currentValue === "symbol") {
          return currentValue.toString();
        }
        if (typeof currentValue === "function") {
          return `[Function: ${currentValue.name || "anonymous"}]`;
        }
        if (currentValue instanceof Error) {
          return {
            name: currentValue.name,
            message: currentValue.message,
            stack: currentValue.stack,
          };
        }
        if (currentValue !== null && typeof currentValue === "object") {
          if (seen.has(currentValue)) {
            return "[Circular]";
          }
          seen.add(currentValue);
        }
        return currentValue;
      },
      2
    );

    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Fall through to string coercion.
  }

  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

export type {
  McpAuditRecord,
  McpAuditResult,
  McpConfirmationDecision,
  McpRuntimeSnapshot,
  McpRuntimeState,
};
