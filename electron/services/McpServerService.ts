import { ipcMain } from "electron";
import type { WindowRegistry } from "../window/WindowRegistry.js";
import { getProjectViewManager } from "../window/windowRef.js";
import http from "node:http";
import net from "node:net";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ActionManifestEntry, ActionDispatchResult } from "../../shared/types/actions.js";
import {
  type McpAuditRecord,
  type McpAuditResult,
  type McpConfirmationDecision,
  MCP_AUDIT_DEFAULT_MAX_RECORDS,
  MCP_AUDIT_MAX_RECORDS,
  MCP_AUDIT_MIN_RECORDS,
} from "../../shared/types/ipc/mcpServer.js";
import type { HelpAssistantTier } from "../../shared/types/ipc/maps.js";

export type McpAuthClass = "external" | HelpAssistantTier;
export type HelpTokenValidator = (token: string) => HelpAssistantTier | false;
import { store } from "../store.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { summarizeMcpArgs } from "../../shared/utils/mcpArgsSummary.js";
import { mcpPaneConfigService } from "./McpPaneConfigService.js";
import { events } from "./events.js";
import { getAgentAvailabilityStore } from "./AgentAvailabilityStore.js";

const MCP_SERVER_KEY = "daintree";

const DEFAULT_PORT = 45454;
const MAX_PORT_RETRIES = 10;
const MCP_SSE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

const AUDIT_FLUSH_DEBOUNCE_MS = 2000;
const CONFIRMATION_REQUIRED_CODE = "CONFIRMATION_REQUIRED";
const USER_REJECTED_CODE = "USER_REJECTED";
const CONFIRMATION_TIMEOUT_CODE = "CONFIRMATION_TIMEOUT";

const OPEN_WORLD_CATEGORIES: ReadonlySet<string> = new Set([
  "browser",
  "devServer",
  "github",
  "portal",
  "voice",
  "system",
]);

/**
 * Source-tier classification for an authenticated MCP connection. Each
 * connection is stamped with a tier at session-creation time and that tier
 * gates every `CallTool` and `ListTools` request for the session's
 * lifetime. Tiers are strictly nested: `workbench ⊂ action ⊂ system`, with
 * `external` carrying its own legacy curated allowlist for backward
 * compatibility with the pre-tier user-facing server.
 *
 * - `workbench` — read-only Daintree introspection (queries, file/diff
 *   reads, listings). The default for project agents that opt in.
 * - `action` — workbench plus non-destructive mutations (create worktree,
 *   run recipe, inject text into a terminal, panel manipulation). Default
 *   for the help assistant.
 * - `system` — action plus destructive operations (delete worktree, send
 *   raw terminal commands, git mutations, agent.launch). Reserved for
 *   "skip permissions" or explicitly-elevated external clients.
 * - `external` — today's curated allowlist, tied to the global apiKey.
 */
export type McpTier = "workbench" | "action" | "system" | "external";

/**
 * Workbench tier — read-only introspection and queries. No mutations, no
 * external network side effects. Walks of the action manifest filtered by
 * `kind: "query"` plus a small set of safe-to-read commands.
 */
const WORKBENCH_TOOLS: ReadonlySet<string> = new Set([
  "actions.list",
  "actions.getContext",

  "project.getAll",
  "project.getCurrent",
  "project.getSettings",
  "project.getStats",
  "project.detectRunners",

  "worktree.list",
  "worktree.getCurrent",
  "worktree.listBranches",
  "worktree.getDefaultPath",
  "worktree.getAvailableBranch",
  "worktree.resource.status",

  "files.search",
  "file.view",

  "copyTree.isAvailable",
  "copyTree.generate",

  "terminal.list",
  "terminal.getOutput",

  "slashCommands.list",

  "git.getProjectPulse",
  "git.getFileDiff",
  "git.listCommits",
  "git.getStagingStatus",
  "git.snapshotGet",
  "git.snapshotList",

  "github.checkCli",
  "github.getRepoStats",
  "github.listIssues",
  "github.listPullRequests",
  "github.getIssueByNumber",

  "workflow.prepBranchForReview",

  "system.checkCommand",
  "system.checkDirectory",
]);

/**
 * Action tier additions — non-destructive mutations layered on top of
 * workbench. Creates resources, spawns terminals/agents, drives those
 * terminals via injected context or sent commands, and trashes terminals
 * (which the user can restore from the dock). Does not permanently kill
 * terminals, delete worktrees, commit/push git state, or open external
 * GitHub URLs.
 */
const ACTION_TIER_ADDONS: ReadonlySet<string> = new Set([
  "worktree.create",
  "worktree.createWithRecipe",
  "worktree.setActive",
  "worktree.refresh",

  "terminal.inject",
  "terminal.new",
  "terminal.sendCommand",
  "terminal.bulkCommand",
  "terminal.close",
  "terminal.closeAll",

  "recipe.list",
  "recipe.run",

  "copyTree.injectToTerminal",
  "copyTree.generateAndCopyFile",

  "file.openInEditor",

  "agent.launch",
  "agent.terminal",
  "agent.focusNextWaiting",
  "agent.focusNextWorking",

  "workflow.startWorkOnIssue",
  "workflow.focusNextAttention",
]);

/**
 * System tier additions — destructive or externally-visible operations layered
 * on top of action. Includes permanently killing terminals (cannot be undone),
 * deleting worktrees, mutating git state, and opening external GitHub URLs.
 */
const SYSTEM_TIER_ADDONS: ReadonlySet<string> = new Set([
  "worktree.delete",

  "terminal.kill",
  "terminal.killAll",

  "git.stageFile",
  "git.unstageFile",
  "git.stageAll",
  "git.unstageAll",
  "git.commit",
  "git.push",
  "git.snapshotRevert",
  "git.snapshotDelete",

  "github.openIssue",
  "github.openPR",
]);

function unionSet(...sets: ReadonlySet<string>[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const set of sets) {
    for (const value of set) out.add(value);
  }
  return out;
}

// External tier — curated set of action IDs advertised over MCP for the
// legacy user-facing server. Keeps the tool surface small enough for
// `tool_choice: "auto"` reliability and bounded token cost while still
// covering the agent-facing introspection, query, and command actions.
// Power users opt into the full surface via `mcpServer.fullToolSurface =
// true`. Tier-gated dispatch enforces this list at CallTool time — a
// caller that knows an action ID outside this set will receive a
// `TIER_NOT_PERMITTED` rejection.
const MCP_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  "actions.list",
  "actions.getContext",

  "agent.launch",
  "agent.terminal",
  "agent.focusNextWaiting",
  "agent.focusNextWorking",

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

  "github.checkCli",
  "github.getRepoStats",
  "github.listIssues",
  "github.listPullRequests",
  "github.getIssueByNumber",
  "github.openIssue",
  "github.openPR",

  "terminal.list",
  "terminal.getOutput",
  "terminal.sendCommand",
  "terminal.bulkCommand",
  "terminal.inject",
  "terminal.new",

  "worktree.list",
  "worktree.getCurrent",
  "worktree.refresh",
  "worktree.create",
  "worktree.createWithRecipe",
  "worktree.listBranches",
  "worktree.getDefaultPath",
  "worktree.getAvailableBranch",
  "worktree.delete",
  "worktree.setActive",
  "worktree.resource.status",

  "workflow.startWorkOnIssue",
  "workflow.prepBranchForReview",
  "workflow.focusNextAttention",

  "files.search",
  "file.view",
  "file.openInEditor",

  "copyTree.isAvailable",
  "copyTree.generate",
  "copyTree.generateAndCopyFile",
  "copyTree.injectToTerminal",

  "slashCommands.list",

  "project.getAll",
  "project.getCurrent",
  "project.getSettings",
  "project.getStats",
  "project.detectRunners",

  "recipe.list",
  "recipe.run",

  "system.checkCommand",
  "system.checkDirectory",
]);

/**
 * Per-tier allowlist of action IDs. Tiers are additive: `action` is the
 * union of `workbench` plus its addons; `system` adds further on top of
 * `action`. Callers should treat these as the authoritative gate for both
 * `ListTools` filtering and `CallTool` dispatch. `external` is intentionally
 * NOT a superset of `system` — it tracks the legacy curated allowlist so
 * existing apiKey clients keep seeing the same tools they always have.
 */
const TIER_ALLOWLISTS: Readonly<Record<McpTier, ReadonlySet<string>>> = {
  workbench: WORKBENCH_TOOLS,
  action: unionSet(WORKBENCH_TOOLS, ACTION_TIER_ADDONS),
  system: unionSet(WORKBENCH_TOOLS, ACTION_TIER_ADDONS, SYSTEM_TIER_ADDONS),
  external: MCP_TOOL_ALLOWLIST,
};

const TIER_NOT_PERMITTED_CODE = "TIER_NOT_PERMITTED";

type ResourceKind = "pulse" | "scrollback" | "agentState" | "issues";

interface ParsedResourceUri {
  kind: ResourceKind;
  id: string;
}

/**
 * Each resource read is gated by the same tier allowlist that gates its
 * canonical backing tool. A resource that maps to `terminal.getOutput` is
 * permitted for any session whose tier permits that action; this keeps
 * the resource and tool surfaces aligned without a parallel allowlist.
 */
const RESOURCE_BACKING_ACTIONS: Readonly<Record<ResourceKind, string>> = {
  pulse: "git.getProjectPulse",
  scrollback: "terminal.getOutput",
  agentState: "terminal.list",
  issues: "github.listIssues",
};

const RESOURCE_TEXT_MAX_BYTES = 50 * 1024;

const RESOURCE_SCROLLBACK_TAIL_LINES = 200;

/**
 * Live state stitched into prompt bodies at `prompts/get` time. Each field
 * is best-effort: if the renderer is unavailable or the underlying query
 * action fails, the field is absent and the prompt template falls back to a
 * placeholder string. This keeps prompt expansion non-blocking — a degraded
 * prompt is preferable to a hard failure that strands the user mid-flow.
 */
interface PromptRenderContext {
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeIssueNumber?: number;
  terminalOutput?: string;
}

interface PromptArgumentDefinition {
  name: string;
  description: string;
  required: boolean;
}

interface PromptDefinition {
  name: string;
  description: string;
  arguments: PromptArgumentDefinition[];
  render(args: Record<string, string>, context: PromptRenderContext): string;
}

const PROMPT_TERMINAL_OUTPUT_MAX_CHARS = 16_000;

/**
 * Pick a backtick run that does not appear inside the supplied content so a
 * fenced code block embedding `content` cannot be terminated early by a
 * matching backtick run inside the content itself. Starts at 3 backticks
 * (the markdown minimum) and grows until a non-colliding marker is found.
 */
function pickFenceMarker(content: string): string {
  let length = 3;
  // Reasonable cap — content with 12+ consecutive backticks is pathological.
  while (length < 12) {
    const candidate = "`".repeat(length);
    if (!content.includes(candidate)) {
      return candidate;
    }
    length += 1;
  }
  return "`".repeat(length);
}

/**
 * Static set of slash commands surfaced by Claude Code as
 * `/mcp__daintree__<name>`. Bodies are plain markdown so the assistant
 * receives a single user-role message with the interpolated state. Keep
 * each prompt focused on a workflow entry point — they are user-triggered
 * macros, not behavioural guidance (which belongs in `help/CLAUDE.md`).
 */
const PROMPT_DEFINITIONS: readonly PromptDefinition[] = [
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
            // Use a fence marker that cannot collide with any backtick run in
            // the terminal output. Picks the smallest backtick run not present.
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
];

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  webContentsId: number;
  destroyedCleanup?: () => void;
}

/**
 * Renderer-supplied envelope for dispatch responses. Wraps the canonical
 * `ActionDispatchResult` and carries an optional `confirmationDecision`
 * when the renderer surfaced a `danger: "confirm"` modal — this lets the
 * audit log capture per-decision outcomes without main having to inspect
 * action metadata it does not own.
 */
interface DispatchEnvelope {
  result: ActionDispatchResult;
  confirmationDecision?: McpConfirmationDecision;
}

interface McpSseSession {
  transport: SSEServerTransport;
  idleTimer: ReturnType<typeof setTimeout>;
}

interface McpHttpSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  idleTimer: ReturnType<typeof setTimeout>;
}

const RESOURCE_URI_PATTERN =
  /^daintree:\/\/(worktree|terminal|agent|project)\/([^/]+)\/(pulse|scrollback|state|issues)$/;

function parseResourceUri(uri: string): ParsedResourceUri | null {
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

function unwrapDispatchResult(envelope: DispatchEnvelope): unknown {
  const result = envelope.result;
  if (result.ok) return result.result;
  throw new Error(`Action failed [${result.error.code}]: ${result.error.message}`);
}

function serializeResourcePayload(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "string") return value;
  return safeSerializeToolResult(value);
}

function truncateText(text: string, maxBytes: number = RESOURCE_TEXT_MAX_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const sliced = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  return `${sliced}\n\n[truncated]`;
}

function readStringField(value: unknown, keys: readonly string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const v = record[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function safeSerializeToolResult(value: unknown): string {
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

export class McpServerService {
  private httpServer: http.Server | null = null;
  private port: number | null = null;
  private registry: WindowRegistry | null = null;
  private startPromise: Promise<void> | null = null;
  private sessions = new Map<string, McpSseSession>();
  private httpSessions = new Map<string, McpHttpSession>();
  /**
   * Authoritative session-id → tier map used by both transports. Written
   * when a new SSE or HTTP session is created (after the request has
   * already passed `isAuthorized`) and read inside the `CallTool` /
   * `ListTools` handlers via `getSessionTier`. Cleared in the matching
   * `transport.onclose` and idle-eviction paths.
   */
  private sessionTierMap = new Map<string, McpTier>();
  /**
   * Per-session resource subscriptions: outer key is sessionId, inner key
   * is the subscribed URI. Each entry holds the unsubscribe function for
   * the underlying event-bus listener so we can tear it down on unsubscribe,
   * transport close, or idle eviction without leaking listeners.
   */
  private resourceSubscriptions = new Map<string, Map<string, () => void>>();
  private pendingManifests = new Map<string, PendingRequest<ActionManifestEntry[]>>();
  private pendingDispatches = new Map<string, PendingRequest<DispatchEnvelope>>();
  private cachedManifest: ActionManifestEntry[] | null = null;
  private cleanupListeners: Array<() => void> = [];
  private statusListeners = new Set<(running: boolean) => void>();
  private auditRecords: McpAuditRecord[] = [];
  private auditFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private auditHydrated = false;
  /**
   * Bearer token for the global MCP server. Persisted in electron-store under
   * `mcpServer.apiKey`. Initialized in `start()` (hydrate-from-store or
   * generate-fresh-and-persist) and replaced by `rotateApiKey()`. Always
   * non-empty once the server is running.
   */
  private apiKey: string | null = null;
  /**
   * Single-flight guard for `rotateApiKey()`. Without it, two parallel calls
   * could each capture the same `previousKey`, both overwrite `this.apiKey`,
   * and the first caller would receive a key that has already been
   * superseded — so the UI would show a key that doesn't authenticate.
   */
  private rotateInFlight: Promise<string> | null = null;
  private helpTokenValidator: HelpTokenValidator | null = null;

  get isRunning(): boolean {
    return this.httpServer !== null && this.port !== null;
  }

  /**
   * Register a subscriber that fires whenever the server transitions between
   * running and stopped. Used by `ServiceConnectivityRegistry` to surface MCP
   * reachability without polling.
   */
  onStatusChange(listener: (running: boolean) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /**
   * Register a callback that resolves help-session bearer tokens to a tier.
   * Wired by `HelpSessionService` so requests carrying a Daintree-issued
   * per-session token authenticate alongside the long-lived external API key.
   */
  setHelpTokenValidator(validator: HelpTokenValidator | null): void {
    this.helpTokenValidator = validator;
  }

  private emitStatusChange(): void {
    const running = this.isRunning;
    for (const listener of this.statusListeners) {
      try {
        listener(running);
      } catch (err) {
        console.error("[MCP] Status change listener threw:", err);
      }
    }
  }

  get currentPort(): number | null {
    return this.port;
  }

  private getConfig() {
    return store.get("mcpServer");
  }

  /**
   * Persist a config patch without dropping the in-memory audit log. Every
   * config-mutation method must route through here so `setEnabled`,
   * `setPort`, etc. don't clobber `auditLog` on disk by writing back a
   * spread of the live config minus the in-memory ring buffer.
   */
  private persistConfig(patch: Partial<ReturnType<typeof this.getConfig>>): void {
    const current = this.getConfig();
    store.set("mcpServer", {
      ...current,
      ...patch,
      auditLog: this.auditHydrated ? this.auditRecords : current.auditLog,
    });
  }

  isEnabled(): boolean {
    return this.getConfig().enabled;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.persistConfig({ enabled });
    if (enabled && this.registry && !this.isRunning) {
      await this.start(this.registry);
    } else if (!enabled && this.isRunning) {
      await this.stop();
    }
  }

  async setPort(port: number | null): Promise<void> {
    const wasEnabled = this.getConfig().enabled;
    this.persistConfig({ port });
    if (wasEnabled && this.isRunning) {
      await this.stop();
      if (this.registry) await this.start(this.registry);
    }
  }

  /**
   * Mint a fresh bearer token and persist it to electron-store. On store-write
   * failure the in-memory key is rolled back so the previous bearer remains
   * authoritative for in-flight requests. Local-loopback only — clients use
   * the new key on their next request; no server restart needed. External
   * clients holding the old key in their own config break and must re-paste
   * the new bearer from Settings. Single-flight: parallel callers share the
   * same in-flight promise and receive the same returned key.
   */
  async rotateApiKey(): Promise<string> {
    if (this.rotateInFlight) return this.rotateInFlight;
    const promise = (async (): Promise<string> => {
      const newKey = `daintree_${randomUUID().replace(/-/g, "")}`;
      const previousKey = this.apiKey;
      this.apiKey = newKey;
      try {
        this.persistConfig({ apiKey: newKey });
      } catch (err) {
        this.apiKey = previousKey;
        throw err;
      }
      return newKey;
    })();
    this.rotateInFlight = promise;
    try {
      return await promise;
    } finally {
      this.rotateInFlight = null;
    }
  }

  /**
   * Hydrate the in-memory ring buffer from the persisted store. Idempotent —
   * subsequent calls are no-ops so tests and callers can invoke it freely.
   * Trims to the current `auditMaxRecords` cap on load so a shrunk cap takes
   * effect immediately.
   */
  private hydrateAuditLog(): void {
    if (this.auditHydrated) return;
    const config = this.getConfig();
    const persisted = Array.isArray(config.auditLog) ? config.auditLog : [];
    const cap = this.normalizeAuditMaxRecords(config.auditMaxRecords);
    this.auditRecords =
      persisted.length > cap ? persisted.slice(persisted.length - cap) : [...persisted];
    this.auditHydrated = true;
  }

  private normalizeAuditMaxRecords(value: unknown): number {
    const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : NaN;
    if (!Number.isFinite(n)) return MCP_AUDIT_DEFAULT_MAX_RECORDS;
    if (n < MCP_AUDIT_MIN_RECORDS) return MCP_AUDIT_MIN_RECORDS;
    if (n > MCP_AUDIT_MAX_RECORDS) return MCP_AUDIT_MAX_RECORDS;
    return n;
  }

  private classifyDispatchResult(
    outcome:
      | { kind: "result"; value: ActionDispatchResult }
      | { kind: "throw"; error: unknown }
      | { kind: "unauthorized" }
  ): { result: McpAuditResult; errorCode?: string } {
    if (outcome.kind === "throw") {
      return { result: "error", errorCode: "DISPATCH_THREW" };
    }
    if (outcome.kind === "unauthorized") {
      return { result: "unauthorized", errorCode: TIER_NOT_PERMITTED_CODE };
    }
    const value = outcome.value;
    if (value.ok) return { result: "success" };
    if (value.error.code === CONFIRMATION_REQUIRED_CODE) {
      return { result: "confirmation-pending", errorCode: value.error.code };
    }
    return { result: "error", errorCode: value.error.code };
  }

  /**
   * Resolve the confirmation decision stored alongside an audit record.
   * Trusts the renderer-supplied hint for `"approved"` (the only case main
   * cannot infer — a successful dispatch may be a directly-authorized agent
   * call or a modal-approved one), but always derives `"rejected"` and
   * `"timeout"` from the canonical error codes so a renderer that forgets
   * to set the hint still gets the right outcome recorded.
   */
  private deriveConfirmationDecision(
    outcome:
      | { kind: "result"; value: ActionDispatchResult }
      | { kind: "throw"; error: unknown }
      | { kind: "unauthorized" },
    hint: McpConfirmationDecision | undefined
  ): McpConfirmationDecision | undefined {
    if (outcome.kind === "result" && !outcome.value.ok) {
      if (outcome.value.error.code === USER_REJECTED_CODE) return "rejected";
      if (outcome.value.error.code === CONFIRMATION_TIMEOUT_CODE) return "timeout";
    }
    if (hint === "approved" && outcome.kind === "result" && outcome.value.ok) {
      return "approved";
    }
    return undefined;
  }

  private appendAuditRecord(input: {
    toolId: string;
    sessionId: string;
    tier: McpTier;
    args: unknown;
    durationMs: number;
    outcome:
      | { kind: "result"; value: ActionDispatchResult }
      | { kind: "throw"; error: unknown }
      | { kind: "unauthorized" };
    confirmationDecision?: McpConfirmationDecision;
  }): void {
    // `=== false` so legacy persisted configs (undefined) default to enabled,
    // matching `getAuditConfig()`. A bare `!auditEnabled` would silently drop
    // every record for any user whose store predates this feature.
    if (this.getConfig().auditEnabled === false) return;
    this.hydrateAuditLog();

    const classification = this.classifyDispatchResult(input.outcome);
    const decision = this.deriveConfirmationDecision(input.outcome, input.confirmationDecision);
    const record: McpAuditRecord = {
      id: randomUUID(),
      timestamp: Date.now(),
      toolId: input.toolId,
      sessionId: input.sessionId,
      tier: input.tier,
      argsSummary: summarizeMcpArgs(input.args),
      result: classification.result,
      durationMs: Math.max(0, Math.round(input.durationMs)),
    };
    if (classification.errorCode !== undefined) {
      record.errorCode = classification.errorCode;
    }
    if (decision !== undefined) {
      record.confirmationDecision = decision;
    }

    this.auditRecords.push(record);
    const cap = this.normalizeAuditMaxRecords(this.getConfig().auditMaxRecords);
    if (this.auditRecords.length > cap) {
      this.auditRecords.splice(0, this.auditRecords.length - cap);
    }
    this.scheduleAuditFlush();
  }

  private scheduleAuditFlush(): void {
    if (this.auditFlushTimer) return;
    this.auditFlushTimer = setTimeout(() => {
      this.auditFlushTimer = null;
      this.flushAuditLog();
    }, AUDIT_FLUSH_DEBOUNCE_MS);
    this.auditFlushTimer.unref?.();
  }

  private flushAuditLog(): void {
    if (!this.auditHydrated) return;
    try {
      this.persistConfig({});
    } catch (err) {
      console.error("[MCP] Failed to flush audit log:", err);
    }
  }

  /** Cancel any pending debounce and persist the buffer immediately. */
  private flushAuditLogNow(): void {
    if (this.auditFlushTimer) {
      clearTimeout(this.auditFlushTimer);
      this.auditFlushTimer = null;
    }
    this.flushAuditLog();
  }

  /** Read the persisted ring buffer (newest first). */
  getAuditRecords(): McpAuditRecord[] {
    this.hydrateAuditLog();
    return [...this.auditRecords].reverse();
  }

  /** Read the persisted audit-log configuration as the renderer sees it. */
  getAuditConfig(): { enabled: boolean; maxRecords: number } {
    const config = this.getConfig();
    return {
      enabled: config.auditEnabled !== false,
      maxRecords: this.normalizeAuditMaxRecords(config.auditMaxRecords),
    };
  }

  /** Empty the buffer and persist the change synchronously. */
  clearAuditLog(): void {
    this.hydrateAuditLog();
    this.auditRecords = [];
    this.flushAuditLogNow();
  }

  /** Toggle capture without dropping existing records. */
  setAuditEnabled(enabled: boolean): { enabled: boolean; maxRecords: number } {
    this.hydrateAuditLog();
    this.persistConfig({ auditEnabled: enabled });
    return this.getAuditConfig();
  }

  /** Update the ring-buffer cap; trims and flushes immediately if it shrunk. */
  setAuditMaxRecords(max: number): { enabled: boolean; maxRecords: number } {
    this.hydrateAuditLog();
    const normalized = this.normalizeAuditMaxRecords(max);
    if (this.auditRecords.length > normalized) {
      this.auditRecords.splice(0, this.auditRecords.length - normalized);
    }
    this.persistConfig({ auditMaxRecords: normalized });
    this.flushAuditLogNow();
    return this.getAuditConfig();
  }

  async start(registry: WindowRegistry): Promise<void> {
    this.registry = registry;

    if (this.httpServer) {
      return;
    }

    // Single-flight: concurrent `start()` callers (e.g., the deferred startup
    // task and a help-session provision that races it) must await the same
    // bind so subsequent reads of `currentPort` see the bound value rather
    // than the pre-bind `null`. Without this, a second provision called while
    // the first is mid-bind would early-return and bake `port: null` into its
    // .mcp.json, silently dropping the daintree MCP server from that session.
    if (this.startPromise) {
      return this.startPromise;
    }

    if (!this.isEnabled()) {
      console.log("[MCP] Server disabled — skipping start");
      return;
    }

    this.startPromise = (async () => {
      try {
        if (!this.apiKey) {
          const persisted = this.getConfig().apiKey;
          if (persisted && persisted.length > 0) {
            this.apiKey = persisted;
          } else {
            this.apiKey = `daintree_${randomUUID().replace(/-/g, "")}`;
            this.persistConfig({ apiKey: this.apiKey });
          }
        }

        this.hydrateAuditLog();
        this.setupIpcListeners();

        const server = http.createServer((req, res) => {
          this.handleRequest(req, res).catch((err) => {
            console.error("[MCP] Request handler error:", err);
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "text/plain" });
              res.end("Internal server error");
            }
          });
        });

        const configuredPort = this.getConfig().port ?? DEFAULT_PORT;
        const boundPort = await this.listenWithRetry(server, configuredPort);

        if (boundPort === null) {
          for (const cleanup of this.cleanupListeners) {
            cleanup();
          }
          this.cleanupListeners = [];
          throw new Error(
            `Failed to bind MCP server: ports ${configuredPort}–${configuredPort + MAX_PORT_RETRIES} all in use`
          );
        }

        this.port = boundPort;
        this.httpServer = server;
        console.log(
          `[MCP] Server started on http://127.0.0.1:${this.port}/mcp (Streamable HTTP) and /sse (legacy SSE)`
        );
        this.emitStatusChange();
      } finally {
        this.startPromise = null;
      }
    })();

    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.flushAuditLogNow();

    for (const session of this.sessions.values()) {
      clearTimeout(session.idleTimer);
      try {
        await session.transport.close();
      } catch {
        // ignore close errors during shutdown
      }
    }
    this.sessions.clear();

    for (const session of this.httpSessions.values()) {
      clearTimeout(session.idleTimer);
      try {
        await session.transport.close();
      } catch {
        // ignore close errors during shutdown
      }
    }
    this.httpSessions.clear();
    this.sessionTierMap.clear();

    // Drain any remaining resource-subscription listeners. Normal teardown
    // happens via transport.onclose, but a transport.close() that throws
    // before the SDK fires onclose would leak listeners otherwise.
    for (const bucket of this.resourceSubscriptions.values()) {
      for (const unsub of bucket.values()) {
        try {
          unsub();
        } catch {
          // ignore; best-effort during shutdown
        }
      }
    }
    this.resourceSubscriptions.clear();

    for (const cleanup of this.cleanupListeners) {
      cleanup();
    }
    this.cleanupListeners = [];

    for (const [id, pending] of this.pendingManifests) {
      clearTimeout(pending.timer);
      pending.destroyedCleanup?.();
      pending.reject(new Error("MCP server stopped"));
      this.pendingManifests.delete(id);
    }
    for (const [id, pending] of this.pendingDispatches) {
      clearTimeout(pending.timer);
      pending.destroyedCleanup?.();
      pending.reject(new Error("MCP server stopped"));
      this.pendingDispatches.delete(id);
    }
    this.cachedManifest = null;

    let wasRunning = false;
    if (this.httpServer) {
      wasRunning = true;
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
      this.port = null;
    }

    console.log("[MCP] Server stopped");
    if (wasRunning) {
      this.emitStatusChange();
    }
  }

  getStatus(): {
    enabled: boolean;
    port: number | null;
    configuredPort: number | null;
    apiKey: string;
  } {
    const config = this.getConfig();
    return {
      enabled: config.enabled,
      port: this.port,
      configuredPort: config.port,
      apiKey: this.apiKey ?? "",
    };
  }

  getConfigSnippet(): string {
    const url = this.port ? `http://127.0.0.1:${this.port}/mcp` : "http://127.0.0.1:<port>/mcp";
    const entry: Record<string, unknown> = { type: "http", url };
    if (this.apiKey) {
      entry.headers = { Authorization: `Bearer ${this.apiKey}` };
    }
    return JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: entry } }, null, 2);
  }

  private async listenWithRetry(server: http.Server, startPort: number): Promise<number | null> {
    for (let attempt = 0; attempt <= MAX_PORT_RETRIES; attempt++) {
      const port = startPort + attempt;
      if (port > 65535) break;

      const available = await this.isPortAvailable(port);
      if (!available) {
        console.log(`[MCP] Port ${port} in use, trying next…`);
        continue;
      }

      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error) => {
            server.removeListener("error", onError);
            reject(err);
          };
          server.on("error", onError);
          server.listen(port, "127.0.0.1", () => {
            server.removeListener("error", onError);
            resolve();
          });
        });
        const addr = server.address() as AddressInfo | null;
        return addr?.port ?? null;
      } catch {
        console.log(`[MCP] Port ${port} bind failed, trying next…`);
        continue;
      }
    }
    return null;
  }

  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const tester = net.createServer();
      tester.once("error", () => resolve(false));
      tester.listen(port, "127.0.0.1", () => {
        tester.close(() => resolve(true));
      });
    });
  }

  private setupIpcListeners(): void {
    const manifestHandler = (
      event: Electron.IpcMainEvent,
      payload: { requestId: string; manifest: unknown }
    ) => {
      if (!payload || typeof payload.requestId !== "string") return;
      const pending = this.pendingManifests.get(payload.requestId);
      if (!pending) return;
      if (event.sender.id !== pending.webContentsId) {
        console.warn(
          `[MCP] Ignoring manifest response from unexpected sender ${event.sender.id} (expected ${pending.webContentsId}, requestId=${payload.requestId})`
        );
        return;
      }
      clearTimeout(pending.timer);
      pending.destroyedCleanup?.();
      this.pendingManifests.delete(payload.requestId);
      const manifest = Array.isArray(payload.manifest)
        ? (payload.manifest as ActionManifestEntry[])
        : [];
      this.cachedManifest = manifest;
      pending.resolve(manifest);
    };

    const dispatchHandler = (
      event: Electron.IpcMainEvent,
      payload: {
        requestId: string;
        result: ActionDispatchResult;
        confirmationDecision?: McpConfirmationDecision;
      }
    ) => {
      if (!payload || typeof payload.requestId !== "string") return;
      const pending = this.pendingDispatches.get(payload.requestId);
      if (!pending) return;
      if (event.sender.id !== pending.webContentsId) {
        console.warn(
          `[MCP] Ignoring dispatch response from unexpected sender ${event.sender.id} (expected ${pending.webContentsId}, requestId=${payload.requestId})`
        );
        return;
      }
      clearTimeout(pending.timer);
      pending.destroyedCleanup?.();
      this.pendingDispatches.delete(payload.requestId);
      pending.resolve({
        result: payload.result,
        confirmationDecision: payload.confirmationDecision,
      });
    };

    ipcMain.on("mcp:get-manifest-response", manifestHandler);
    ipcMain.on("mcp:dispatch-action-response", dispatchHandler);

    this.cleanupListeners.push(
      () => ipcMain.removeListener("mcp:get-manifest-response", manifestHandler),
      () => ipcMain.removeListener("mcp:dispatch-action-response", dispatchHandler)
    );
  }

  private requestManifest(): Promise<ActionManifestEntry[]> {
    return new Promise((resolve, reject) => {
      let webContents: Electron.WebContents;
      try {
        webContents = this.getActiveProjectWebContents();
      } catch (err) {
        reject(this.normalizeError(err, "MCP renderer bridge unavailable"));
        return;
      }

      const requestId = randomUUID();
      const webContentsId = webContents.id;
      const timer = setTimeout(() => {
        const pending = this.pendingManifests.get(requestId);
        pending?.destroyedCleanup?.();
        this.pendingManifests.delete(requestId);
        reject(new Error("Manifest request timed out"));
      }, 5000);

      const onDestroyed = () => {
        const pending = this.pendingManifests.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingManifests.delete(requestId);
        pending.reject(new Error("MCP renderer bridge destroyed"));
      };
      webContents.once("destroyed", onDestroyed);
      const destroyedCleanup = () => {
        try {
          webContents.removeListener("destroyed", onDestroyed);
        } catch {
          // best-effort cleanup; webContents may already be gone
        }
      };

      this.pendingManifests.set(requestId, {
        resolve,
        reject,
        timer,
        webContentsId,
        destroyedCleanup,
      });

      try {
        webContents.send("mcp:get-manifest-request", { requestId });
      } catch (err) {
        clearTimeout(timer);
        destroyedCleanup();
        this.pendingManifests.delete(requestId);
        reject(this.normalizeError(err, "Failed to request action manifest"));
      }
    });
  }

  private dispatchAction(
    actionId: string,
    args: unknown,
    confirmed = false
  ): Promise<DispatchEnvelope> {
    return new Promise((resolve, reject) => {
      let webContents: Electron.WebContents;
      try {
        webContents = this.getActiveProjectWebContents();
      } catch (err) {
        reject(this.normalizeError(err, "MCP renderer bridge unavailable"));
        return;
      }

      const requestId = randomUUID();
      const webContentsId = webContents.id;
      const timer = setTimeout(() => {
        const pending = this.pendingDispatches.get(requestId);
        pending?.destroyedCleanup?.();
        this.pendingDispatches.delete(requestId);
        reject(new Error(`Action dispatch timed out: ${actionId}`));
      }, 30000);

      const onDestroyed = () => {
        const pending = this.pendingDispatches.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingDispatches.delete(requestId);
        pending.reject(new Error("MCP renderer bridge destroyed"));
      };
      webContents.once("destroyed", onDestroyed);
      const destroyedCleanup = () => {
        try {
          webContents.removeListener("destroyed", onDestroyed);
        } catch {
          // best-effort cleanup; webContents may already be gone
        }
      };

      this.pendingDispatches.set(requestId, {
        resolve,
        reject,
        timer,
        webContentsId,
        destroyedCleanup,
      });

      try {
        webContents.send("mcp:dispatch-action-request", {
          requestId,
          actionId,
          args,
          confirmed,
        });
      } catch (err) {
        clearTimeout(timer);
        destroyedCleanup();
        this.pendingDispatches.delete(requestId);
        reject(this.normalizeError(err, `Failed to dispatch action: ${actionId}`));
      }
    });
  }

  private createSessionServer(sessionId: string): Server {
    const server = new Server(
      { name: "Daintree", version: "1.0.0" },
      {
        capabilities: {
          tools: {},
          resources: { subscribe: true, listChanged: false },
          prompts: {},
        },
      }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const manifest = await this.requestManifest();
      const tier = this.getSessionTier(sessionId);
      return {
        tools: manifest
          .filter((entry) => this.shouldExposeTool(entry, tier))
          .map((entry) => {
            const outputSchema = this.buildToolOutputSchema(entry);
            return {
              name: entry.id,
              description: this.buildToolDescription(entry),
              inputSchema: this.buildToolInputSchema(entry),
              annotations: this.buildAnnotations(entry),
              ...(outputSchema ? { outputSchema } : {}),
            };
          }),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const actionId = request.params.name;
      const { args, confirmed } = this.parseToolArguments(request.params.arguments);
      const startedAt = Date.now();
      const tier = this.getSessionTier(sessionId);

      if (!this.isTierPermitted(tier, actionId)) {
        try {
          this.appendAuditRecord({
            toolId: actionId,
            sessionId,
            tier,
            args,
            durationMs: Date.now() - startedAt,
            outcome: { kind: "unauthorized" },
          });
        } catch (err) {
          console.error("[MCP] Failed to append audit record:", err);
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Error [${TIER_NOT_PERMITTED_CODE}]: action '${actionId}' is not permitted for the '${tier}' tier.`,
            },
          ],
          isError: true,
        };
      }

      let outcome:
        | { kind: "result"; value: ActionDispatchResult }
        | { kind: "throw"; error: unknown };
      let confirmationDecision: McpConfirmationDecision | undefined;

      try {
        try {
          const envelope = await this.dispatchAction(actionId, args, confirmed);
          outcome = { kind: "result", value: envelope.result };
          confirmationDecision = envelope.confirmationDecision;
        } catch (err) {
          outcome = { kind: "throw", error: err };
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: ${formatErrorMessage(err, "Action dispatch failed")}`,
              },
            ],
            isError: true,
          };
        }

        if (outcome.value.ok) {
          const entry = this.cachedManifest?.find((e) => e.id === actionId);
          const structuredContent = this.buildStructuredContent(entry, outcome.value.result);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  outcome.value.result !== undefined && outcome.value.result !== null
                    ? safeSerializeToolResult(outcome.value.result)
                    : "OK",
              },
            ],
            ...(structuredContent ? { structuredContent } : {}),
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Error [${outcome.value.error.code}]: ${outcome.value.error.message}`,
            },
          ],
          isError: true,
        };
      } finally {
        try {
          this.appendAuditRecord({
            toolId: actionId,
            sessionId,
            tier,
            args,
            durationMs: Date.now() - startedAt,
            outcome: outcome!,
            confirmationDecision,
          });
        } catch (err) {
          console.error("[MCP] Failed to append audit record:", err);
        }
      }
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return { resources: await this.listConcreteResources(sessionId) };
    });

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      return { resourceTemplates: this.listResourceTemplates(sessionId) };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      const parsed = parseResourceUri(uri);
      if (!parsed) {
        throw new McpError(ErrorCode.InvalidRequest, `Unknown resource URI: ${uri}`);
      }
      if (!this.isResourcePermitted(sessionId, parsed.kind)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Resource '${uri}' is not permitted for the '${this.getSessionTier(sessionId)}' tier.`
        );
      }
      const contents = await this.readResourceContents(uri, parsed);
      return { contents: [contents] };
    });

    server.setRequestHandler(SubscribeRequestSchema, async (request) => {
      const uri = request.params.uri;
      const parsed = parseResourceUri(uri);
      if (!parsed) {
        throw new McpError(ErrorCode.InvalidRequest, `Unknown resource URI: ${uri}`);
      }
      if (!this.isResourcePermitted(sessionId, parsed.kind)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Resource '${uri}' is not permitted for the '${this.getSessionTier(sessionId)}' tier.`
        );
      }
      this.subscribeResource(sessionId, server, uri, parsed);
      return {};
    });

    server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
      this.unsubscribeResource(sessionId, request.params.uri);
      return {};
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      return {
        prompts: PROMPT_DEFINITIONS.map((def) => ({
          name: def.name,
          description: def.description,
          arguments: def.arguments,
        })),
      };
    });

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const name = request.params.name;
      const definition = PROMPT_DEFINITIONS.find((def) => def.name === name);
      if (!definition) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
      }

      // The SDK's GetPromptRequestSchema already validates `arguments` as
      // Record<string, string>, so any non-string value is rejected before
      // reaching this handler.
      const args: Record<string, string> = (request.params.arguments ?? {}) as Record<
        string,
        string
      >;

      for (const arg of definition.arguments) {
        if (arg.required && !args[arg.name]?.trim()) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Missing required argument for prompt '${name}': ${arg.name}`
          );
        }
      }

      const context = await this.collectPromptContext(definition, args);
      const text = definition.render(args, context);

      return {
        description: definition.description,
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text },
          },
        ],
      };
    });

    return server;
  }

  private async listConcreteResources(
    sessionId: string
  ): Promise<Array<{ uri: string; name: string; mimeType: string; description?: string }>> {
    const resources: Array<{ uri: string; name: string; mimeType: string; description?: string }> =
      [];
    if (this.isResourcePermitted(sessionId, "issues")) {
      resources.push({
        uri: "daintree://project/current/issues",
        name: "Current project — open issues",
        mimeType: "application/json",
        description: "Open GitHub issues for the active project.",
      });
    }
    if (this.isResourcePermitted(sessionId, "pulse")) {
      const worktrees = await this.tryDispatchList("worktree.list");
      for (const wt of worktrees) {
        const id = readStringField(wt, ["id", "worktreeId"]);
        const label = readStringField(wt, ["branch", "name", "path"]) ?? id;
        if (!id) continue;
        resources.push({
          uri: `daintree://worktree/${encodeURIComponent(id)}/pulse`,
          name: `Worktree pulse — ${label ?? id}`,
          mimeType: "application/json",
          description: "Git status summary, recent commits, and pull-request signal.",
        });
      }
    }
    if (
      this.isResourcePermitted(sessionId, "scrollback") ||
      this.isResourcePermitted(sessionId, "agentState")
    ) {
      const terminals = await this.tryDispatchList("terminal.list");
      for (const term of terminals) {
        const id = readStringField(term, ["id", "terminalId"]);
        const label = readStringField(term, ["title", "name"]) ?? id;
        if (id && this.isResourcePermitted(sessionId, "scrollback")) {
          resources.push({
            uri: `daintree://terminal/${encodeURIComponent(id)}/scrollback`,
            name: `Terminal scrollback — ${label ?? id}`,
            mimeType: "text/plain",
            description: `Last ${RESOURCE_SCROLLBACK_TAIL_LINES} lines of terminal output.`,
          });
        }
        // `terminal.list` returns the panel `id` (UUID) and the launch `agentId`
        // separately; AgentAvailabilityStore is keyed by agentId, so a terminal
        // without one (plain shell) has no addressable agent state.
        const agentId = readStringField(term, ["agentId"]);
        if (agentId && this.isResourcePermitted(sessionId, "agentState")) {
          resources.push({
            uri: `daintree://agent/${encodeURIComponent(agentId)}/state`,
            name: `Agent state — ${label ?? agentId}`,
            mimeType: "application/json",
            description: "Current agent state-machine value (idle, working, waiting, etc.).",
          });
        }
      }
    }
    return resources;
  }

  private listResourceTemplates(
    sessionId: string
  ): Array<{ uriTemplate: string; name: string; mimeType: string; description?: string }> {
    const templates: Array<{
      uriTemplate: string;
      name: string;
      mimeType: string;
      description?: string;
    }> = [];
    if (this.isResourcePermitted(sessionId, "pulse")) {
      templates.push({
        uriTemplate: "daintree://worktree/{id}/pulse",
        name: "Worktree pulse",
        mimeType: "application/json",
        description: "Git status summary, recent commits, and pull-request signal.",
      });
    }
    if (this.isResourcePermitted(sessionId, "scrollback")) {
      templates.push({
        uriTemplate: "daintree://terminal/{id}/scrollback",
        name: "Terminal scrollback",
        mimeType: "text/plain",
        description: `Last ${RESOURCE_SCROLLBACK_TAIL_LINES} lines of terminal output.`,
      });
    }
    if (this.isResourcePermitted(sessionId, "agentState")) {
      templates.push({
        uriTemplate: "daintree://agent/{id}/state",
        name: "Agent state",
        mimeType: "application/json",
        description: "Current agent state-machine value (idle, working, waiting, etc.).",
      });
    }
    return templates;
  }

  private async readResourceContents(
    uri: string,
    parsed: ParsedResourceUri
  ): Promise<{ uri: string; mimeType: string; text: string }> {
    if (parsed.kind === "pulse") {
      const envelope = await this.dispatchAction("git.getProjectPulse", {
        worktreeId: parsed.id,
        rangeDays: 60,
      });
      const text = serializeResourcePayload(unwrapDispatchResult(envelope));
      return { uri, mimeType: "application/json", text: truncateText(text) };
    }
    if (parsed.kind === "scrollback") {
      const envelope = await this.dispatchAction("terminal.getOutput", {
        terminalId: parsed.id,
        maxLines: RESOURCE_SCROLLBACK_TAIL_LINES,
        stripAnsi: true,
      });
      const value = unwrapDispatchResult(envelope);
      const text = typeof value === "string" ? value : serializeResourcePayload(value);
      return { uri, mimeType: "text/plain", text: truncateText(text) };
    }
    if (parsed.kind === "agentState") {
      const state = getAgentAvailabilityStore().getState(parsed.id);
      const text = JSON.stringify({ agentId: parsed.id, state: state ?? null });
      return { uri, mimeType: "application/json", text };
    }
    if (parsed.kind === "issues") {
      const envelope = await this.dispatchAction("github.listIssues", {});
      const text = serializeResourcePayload(unwrapDispatchResult(envelope));
      return { uri, mimeType: "application/json", text: truncateText(text) };
    }
    throw new McpError(ErrorCode.InvalidRequest, `Unknown resource URI: ${uri}`);
  }

  private async tryDispatchList(actionId: string): Promise<unknown[]> {
    try {
      const envelope = await this.dispatchAction(actionId, {});
      const value = unwrapDispatchResult(envelope);
      if (Array.isArray(value)) return value;
      if (value && typeof value === "object") {
        for (const key of ["items", "results", "list", "terminals", "worktrees"]) {
          const inner = (value as Record<string, unknown>)[key];
          if (Array.isArray(inner)) return inner;
        }
      }
      return [];
    } catch (err) {
      console.error(`[MCP] Failed to enumerate resources via ${actionId}:`, err);
      return [];
    }
  }

  private isResourcePermitted(sessionId: string, kind: ResourceKind): boolean {
    const tier = this.getSessionTier(sessionId);
    return this.isTierPermitted(tier, RESOURCE_BACKING_ACTIONS[kind]);
  }

  private subscribeResource(
    sessionId: string,
    server: Server,
    uri: string,
    parsed: ParsedResourceUri
  ): void {
    if (parsed.kind !== "pulse" && parsed.kind !== "agentState") {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Subscriptions are not supported for resource '${uri}'.`
      );
    }
    let bucket = this.resourceSubscriptions.get(sessionId);
    if (!bucket) {
      bucket = new Map();
      this.resourceSubscriptions.set(sessionId, bucket);
    }
    if (bucket.has(uri)) return;

    const fire = () => {
      if (!this.sessions.has(sessionId) && !this.httpSessions.has(sessionId)) return;
      server.sendResourceUpdated({ uri }).catch((err) => {
        console.error(`[MCP] sendResourceUpdated failed for ${uri}:`, err);
      });
    };

    let unsub: () => void;
    if (parsed.kind === "agentState") {
      unsub = events.on("agent:state-changed", (payload) => {
        if (payload.agentId === parsed.id) fire();
      });
    } else {
      unsub = events.on("sys:worktree:update", (payload) => {
        if (payload.worktreeId === parsed.id) fire();
      });
    }
    bucket.set(uri, unsub);
  }

  private unsubscribeResource(sessionId: string, uri: string): void {
    const bucket = this.resourceSubscriptions.get(sessionId);
    if (!bucket) return;
    const unsub = bucket.get(uri);
    if (!unsub) return;
    try {
      unsub();
    } catch (err) {
      console.error(`[MCP] Failed to unsubscribe ${uri}:`, err);
    }
    bucket.delete(uri);
    if (bucket.size === 0) {
      this.resourceSubscriptions.delete(sessionId);
    }
  }

  private cleanupResourceSubscriptions(sessionId: string): void {
    const bucket = this.resourceSubscriptions.get(sessionId);
    if (!bucket) return;
    for (const unsub of bucket.values()) {
      try {
        unsub();
      } catch (err) {
        console.error("[MCP] Resource subscription teardown failed:", err);
      }
    }
    this.resourceSubscriptions.delete(sessionId);
  }

  /**
   * Best-effort fetch of the live state a prompt template wants to
   * interpolate. Each query is wrapped in `safeDispatch` so a renderer that
   * is unavailable, slow, or rejects produces a `null` rather than aborting
   * the entire `prompts/get` call. Templates handle missing fields with
   * placeholder copy — degraded prompts beat hard failures mid-flow.
   */
  private async collectPromptContext(
    definition: PromptDefinition,
    args: Record<string, string>
  ): Promise<PromptRenderContext> {
    const context: PromptRenderContext = {};

    const worktree = await this.safeDispatch("worktree.getCurrent", undefined);
    if (worktree && typeof worktree === "object") {
      const w = worktree as Record<string, unknown>;
      if (typeof w.path === "string") context.worktreePath = w.path;
      if (typeof w.branch === "string") context.worktreeBranch = w.branch;
      if (typeof w.issueNumber === "number") context.worktreeIssueNumber = w.issueNumber;
    }

    if (definition.name === "triage_failed_agent") {
      const terminalId = args.terminal_id?.trim();
      if (terminalId) {
        const result = await this.safeDispatch("terminal.getOutput", {
          terminalId,
          maxLines: 100,
          stripAnsi: true,
        });
        if (result && typeof result === "object") {
          const r = result as Record<string, unknown>;
          if (typeof r.content === "string") {
            // Cap the embedded slice so a single very long line cannot blow
            // up the prompt response; keep the tail since recency matters
            // most when triaging a failed agent.
            const content = r.content;
            if (content.length > PROMPT_TERMINAL_OUTPUT_MAX_CHARS) {
              const tail = content.slice(-PROMPT_TERMINAL_OUTPUT_MAX_CHARS);
              context.terminalOutput = `… [truncated to last ${PROMPT_TERMINAL_OUTPUT_MAX_CHARS} chars]\n${tail}`;
            } else {
              context.terminalOutput = content;
            }
          }
        }
      }
    }

    return context;
  }

  /**
   * Wraps `dispatchAction` for the prompt-rendering path. Returns the
   * unwrapped result on success and `null` on any failure (renderer
   * unavailable, action errored, dispatch rejected). Never throws — prompt
   * expansion must remain non-blocking.
   */
  private async safeDispatch(actionId: string, args: unknown): Promise<unknown> {
    try {
      const envelope = await this.dispatchAction(actionId, args);
      if (envelope.result.ok) {
        return envelope.result.result;
      }
      return null;
    } catch {
      return null;
    }
  }

  private isValidHost(req: http.IncomingMessage): boolean {
    const host = req.headers.host ?? "";
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const apiKey = this.apiKey;
    const auth = req.headers.authorization ?? "";

    if (apiKey) {
      const expected = `Bearer ${apiKey}`;
      const actualHash = createHash("sha256").update(auth).digest();
      const expectedHash = createHash("sha256").update(expected).digest();
      if (timingSafeEqual(actualHash, expectedHash)) return true;
    } else if (auth.length === 0) {
      // No global key configured and no Authorization header sent — legacy permissive path.
      return true;
    }

    // Per-pane bearer token (minted at PTY spawn, revoked on exit).
    if (auth.startsWith("Bearer ")) {
      const token = auth.slice("Bearer ".length);
      if (mcpPaneConfigService.isValidPaneToken(token)) return true;
    }

    // Help-session bearer token (minted at provisioning, revoked on panel close / app shutdown).
    if (this.helpTokenValidator) {
      const match = /^Bearer\s+(.+)$/.exec(auth);
      const token = match?.[1]?.trim();
      if (token) {
        const tier = this.helpTokenValidator(token);
        if (tier) return true;
      }
    }

    return false;
  }

  private isValidOrigin(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    return origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}`;
  }

  /**
   * Returns true if the entry should be advertised to a session at the
   * given tier. `restricted` actions are never advertised regardless of
   * tier. `fullToolSurface` widens the surface only for the `external`
   * tier — tier allowlists are security boundaries for the other tiers,
   * not convenience filters that can be opted out of.
   */
  private shouldExposeTool(entry: ActionManifestEntry, tier: McpTier): boolean {
    if (entry.danger === "restricted") {
      return false;
    }
    if (tier === "external" && this.getConfig().fullToolSurface === true) {
      return true;
    }
    return TIER_ALLOWLISTS[tier].has(entry.id);
  }

  /**
   * Hard gate consulted before every CallTool dispatch. Mirrors
   * `shouldExposeTool` so a tool that appears in `ListTools` is always
   * callable — `fullToolSurface=true` widens the external tier for both
   * listing and dispatch in lockstep. The non-external tiers ignore the
   * flag because their allowlists are security boundaries.
   */
  private isTierPermitted(tier: McpTier, actionId: string): boolean {
    if (tier === "external" && this.getConfig().fullToolSurface === true) {
      return true;
    }
    return TIER_ALLOWLISTS[tier].has(actionId);
  }

  /**
   * Read the tier stamped on the session by the connection-time auth
   * resolver. Falls back to `"workbench"` — the most restrictive tier — so
   * a session that somehow escaped tier stamping cannot elevate access by
   * default.
   */
  private getSessionTier(sessionId: string): McpTier {
    return this.sessionTierMap.get(sessionId) ?? "workbench";
  }

  /**
   * Resolve the source-tier classification for an authenticated request.
   * Mirrors the branches of `isAuthorized`:
   *   1. Bearer matches the global apiKey → `"external"` (legacy server).
   *   2. Bearer matches a per-pane token → the per-pane configured tier
   *      (`"workbench"`, `"action"`, or `"system"` from the project's
   *      `daintreeMcpTier` setting). Pane configs with tier `"off"` are
   *      never written, so this branch returns one of the active tiers.
   *   3. Bearer matches a help-session token → the tier bound at provisioning.
   *   4. No `Authorization` header and no apiKey configured → `"external"`
   *      (legacy permissive path; preserves pre-auth behavior).
   * Falls back to `"workbench"` for anything that slipped through but
   * isn't recognized.
   */
  private resolveTokenTier(req: http.IncomingMessage): McpTier {
    const apiKey = this.apiKey;
    const auth = req.headers.authorization ?? "";

    if (apiKey) {
      const expected = `Bearer ${apiKey}`;
      const actualHash = createHash("sha256").update(auth).digest();
      const expectedHash = createHash("sha256").update(expected).digest();
      if (timingSafeEqual(actualHash, expectedHash)) return "external";
    } else if (auth.length === 0) {
      return "external";
    }

    if (auth.startsWith("Bearer ")) {
      const token = auth.slice("Bearer ".length);
      const paneTier = mcpPaneConfigService.getTierForToken(token);
      if (paneTier === "workbench" || paneTier === "action" || paneTier === "system") {
        return paneTier;
      }
      if (this.helpTokenValidator) {
        const helpTier = this.helpTokenValidator(token);
        if (helpTier) return helpTier;
      }
    }

    return "workbench";
  }

  private buildToolDescription(entry: ActionManifestEntry): string {
    let description = `[${entry.category}] ${entry.title}: ${entry.description}`;
    if (entry.danger === "confirm") {
      description += " Requires explicit confirmation via _meta.confirmed=true.";
    }
    return description;
  }

  private buildToolInputSchema(entry: ActionManifestEntry): Record<string, unknown> {
    const baseSchema =
      entry.inputSchema &&
      typeof entry.inputSchema === "object" &&
      !Array.isArray(entry.inputSchema) &&
      entry.inputSchema["type"] === "object"
        ? ({ ...entry.inputSchema } as Record<string, unknown>)
        : {
            type: "object",
            properties: {},
          };

    if (entry.danger !== "confirm") {
      return baseSchema;
    }

    const properties =
      baseSchema["properties"] &&
      typeof baseSchema["properties"] === "object" &&
      !Array.isArray(baseSchema["properties"])
        ? { ...(baseSchema["properties"] as Record<string, unknown>) }
        : {};

    properties["_meta"] = {
      type: "object",
      description: "Reserved Daintree MCP metadata.",
      properties: {
        confirmed: {
          type: "boolean",
          description: "Must be true to execute this destructive action.",
        },
      },
      additionalProperties: false,
    };

    return {
      ...baseSchema,
      properties,
    };
  }

  private buildAnnotations(entry: ActionManifestEntry): ToolAnnotations {
    return {
      title: entry.title,
      readOnlyHint: entry.kind === "query",
      idempotentHint: entry.kind === "query",
      destructiveHint: entry.danger === "confirm",
      openWorldHint: OPEN_WORLD_CATEGORIES.has(entry.category),
    };
  }

  private buildToolOutputSchema(entry: ActionManifestEntry): Record<string, unknown> | undefined {
    const schema = entry.outputSchema;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
    if (schema["type"] !== "object") return undefined;
    return schema;
  }

  private buildStructuredContent(
    entry: ActionManifestEntry | undefined,
    result: unknown
  ): Record<string, unknown> | undefined {
    if (!entry || !this.buildToolOutputSchema(entry)) return undefined;
    if (
      result === null ||
      result === undefined ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      result instanceof Error
    ) {
      return undefined;
    }
    return result as Record<string, unknown>;
  }

  private parseToolArguments(rawArgs: unknown): { args: unknown; confirmed: boolean } {
    if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
      return {
        args: rawArgs ?? {},
        confirmed: false,
      };
    }

    const argsRecord = rawArgs as Record<string, unknown>;
    const meta = argsRecord["_meta"];
    const metaRecord =
      meta !== null && typeof meta === "object" && !Array.isArray(meta)
        ? (meta as Record<string, unknown>)
        : null;
    const confirmed = metaRecord?.["confirmed"] === true;

    if (!("_meta" in argsRecord)) {
      return {
        args: rawArgs,
        confirmed,
      };
    }

    const { _meta: _ignored, ...actionArgs } = argsRecord;
    return {
      args: Object.keys(actionArgs).length > 0 ? actionArgs : {},
      confirmed,
    };
  }

  private getActiveProjectWebContents(): Electron.WebContents {
    if (this.registry) {
      for (const ctx of this.registry.all()) {
        if (ctx.browserWindow.isDestroyed()) continue;
        const view = ctx.services.projectViewManager?.getActiveView();
        const webContents = view?.webContents;
        if (webContents && !webContents.isDestroyed()) {
          return webContents;
        }
      }
    }

    const fallback = getProjectViewManager()?.getActiveView()?.webContents;
    if (fallback && !fallback.isDestroyed()) {
      return fallback;
    }

    throw new Error("MCP renderer bridge unavailable");
  }

  private normalizeError(err: unknown, fallback: string): Error {
    return err instanceof Error ? err : new Error(fallback);
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.isValidHost(req)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    if (!this.isValidOrigin(req)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    const authClass = this.isAuthorized(req);
    if (!authClass) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
      return;
    }
    // The tier classification (external vs help-session workbench/action/system)
    // will gate the exposed tool surface once #6517 lands. Authenticated for now.
    void authClass;

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);

    if (req.method === "GET" && url.pathname === "/sse") {
      const allowedHosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
      const allowedOrigins = [`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`];
      const transport = new SSEServerTransport("/messages", res, {
        enableDnsRebindingProtection: true,
        allowedHosts,
        allowedOrigins,
      });
      const sessionId = transport.sessionId;
      const tier = this.resolveTokenTier(req);
      this.sessionTierMap.set(sessionId, tier);
      const server = this.createSessionServer(sessionId);

      const idleTimer = this.createIdleTimer(sessionId);
      this.sessions.set(sessionId, { transport, idleTimer });
      transport.onclose = () => {
        const session = this.sessions.get(sessionId);
        if (session) {
          clearTimeout(session.idleTimer);
          this.sessions.delete(sessionId);
        }
        this.sessionTierMap.delete(sessionId);
        this.cleanupResourceSubscriptions(sessionId);
      };

      await server.connect(transport);
    } else if (req.method === "POST" && url.pathname === "/messages") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const session = this.sessions.get(sessionId);

      if (session) {
        this.resetIdleTimer(sessionId);
        await session.transport.handlePostMessage(req, res);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Session not found");
      }
    } else if (url.pathname === "/mcp") {
      if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
        res.writeHead(405, {
          Allow: "GET, POST, DELETE",
          "Content-Type": "text/plain",
        });
        res.end("Method not allowed");
        return;
      }
      await this.handleStreamableHttpRequest(req, res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  }

  private async handleStreamableHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const headerValue = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    if (sessionId !== undefined && sessionId !== "") {
      const session = this.httpSessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          })
        );
        return;
      }
      this.resetHttpIdleTimer(sessionId);
      await session.transport.handleRequest(req, res);
      return;
    }

    // Pre-generate the sessionId so `createSessionServer` can stamp it onto
    // every audit record for this transport. The transport reuses the same
    // id via `sessionIdGenerator`, keeping the audit log keyed consistently
    // with the entry in `httpSessions`.
    const newSessionId = randomUUID();
    // Resolve the tier from the initialize request's Authorization header
    // and stamp it eagerly. The token is stable for the lifetime of the
    // transport, so resolving once at connection time avoids re-hashing
    // on every CallTool.
    const tier = this.resolveTokenTier(req);
    this.sessionTierMap.set(newSessionId, tier);
    const server = this.createSessionServer(newSessionId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      onsessioninitialized: (initializedSessionId) => {
        const idleTimer = this.createHttpIdleTimer(initializedSessionId);
        this.httpSessions.set(initializedSessionId, { transport, server, idleTimer });
      },
    });

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id === undefined) return;
      const session = this.httpSessions.get(id);
      if (session) {
        clearTimeout(session.idleTimer);
        this.httpSessions.delete(id);
      }
      this.sessionTierMap.delete(id);
      this.cleanupResourceSubscriptions(id);
    };

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[MCP] Streamable HTTP request failed:", err);
      const id = transport.sessionId;
      if (id !== undefined) {
        const session = this.httpSessions.get(id);
        if (session) {
          clearTimeout(session.idleTimer);
          this.httpSessions.delete(id);
        }
        this.sessionTierMap.delete(id);
        this.cleanupResourceSubscriptions(id);
      } else {
        this.sessionTierMap.delete(newSessionId);
        this.cleanupResourceSubscriptions(newSessionId);
      }
      await transport.close().catch(() => {});
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal server error");
      }
    }
  }

  private createHttpIdleTimer(sessionId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const session = this.httpSessions.get(sessionId);
      if (!session) return;
      this.httpSessions.delete(sessionId);
      this.sessionTierMap.delete(sessionId);
      this.cleanupResourceSubscriptions(sessionId);
      session.transport.close().catch(() => {
        // ignore close errors during idle timeout cleanup
      });
    }, MCP_SSE_IDLE_TIMEOUT_MS);
    timer.unref?.();
    return timer;
  }

  private resetHttpIdleTimer(sessionId: string): void {
    const session = this.httpSessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = this.createHttpIdleTimer(sessionId);
  }

  private createIdleTimer(sessionId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      this.sessions.delete(sessionId);
      this.sessionTierMap.delete(sessionId);
      this.cleanupResourceSubscriptions(sessionId);
      session.transport.close().catch(() => {
        // ignore close errors during idle timeout cleanup
      });
    }, MCP_SSE_IDLE_TIMEOUT_MS);
    timer.unref?.();
    return timer;
  }

  private resetIdleTimer(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = this.createIdleTimer(sessionId);
  }
}

export const mcpServerService = new McpServerService();
