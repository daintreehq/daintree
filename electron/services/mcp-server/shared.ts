import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import type {
  McpAuditRecord,
  McpAuditResult,
  McpConfirmationDecision,
  McpRuntimeSnapshot,
  McpRuntimeState,
} from "../../../shared/types/ipc/mcpServer.js";
import type { HelpAssistantTier } from "../../../shared/types/ipc/maps.js";
import type { AgentState } from "../../../shared/types/agent.js";

export type McpAuthClass = "external" | HelpAssistantTier;
export type HelpTokenValidator = (token: string) => HelpAssistantTier | false;
export type { HelpAssistantTier };

export const MCP_SERVER_KEY = "daintree";

export const DEFAULT_PORT = 45454;
export const MAX_PORT_RETRIES = 10;
export const MCP_SSE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export const MAX_RESTART_ATTEMPTS = 5;
export const RESTART_BASE_DELAY_MS = 500;
export const RESTART_MAX_DELAY_MS = 15_000;
export const RESTART_JITTER_MS = 250;
export const RESTART_STABLE_RESET_MS = 30_000;

export const TERMINAL_WAIT_UNTIL_IDLE_TOOL = "terminal.waitUntilIdle";

export const DEFAULT_WAIT_UNTIL_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export type WaitUntilIdleResult = {
  terminalId: string;
  agentId?: string;
  busyState: "working" | "idle";
  idleReason?: "idle" | "waiting_for_user" | "completed" | "exited" | "unknown";
  previousBusyState?: "working" | "idle";
  lastTransitionAt?: number;
  timedOut: boolean;
};

export const WAIT_UNTIL_IDLE_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    terminalId: {
      type: "string",
      description: "Panel UUID returned by `terminal.list` (the `id` field).",
    },
    timeoutMs: {
      type: "integer",
      minimum: 0,
      maximum: MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS,
      description: `Maximum time to block in milliseconds. Defaults to ${DEFAULT_WAIT_UNTIL_IDLE_TIMEOUT_MS} ms (${DEFAULT_WAIT_UNTIL_IDLE_TIMEOUT_MS / 60_000} minutes); clamped to ${MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS} ms (${MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS / 60_000 / 60} hours). Use 0 for an immediate snapshot.`,
    },
  },
  required: ["terminalId"],
  additionalProperties: false,
};

export const WAIT_UNTIL_IDLE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    terminalId: { type: "string" },
    agentId: { type: "string" },
    busyState: { type: "string", enum: ["working", "idle"] },
    idleReason: {
      type: "string",
      enum: ["idle", "waiting_for_user", "completed", "exited", "unknown"],
    },
    previousBusyState: { type: "string", enum: ["working", "idle"] },
    lastTransitionAt: { type: "number" },
    timedOut: { type: "boolean" },
  },
  required: ["terminalId", "busyState", "timedOut"],
};

export const WAIT_UNTIL_IDLE_DESCRIPTION =
  "[terminal] Wait until idle: blocks until the agent in the given terminal transitions out of the `working` state, or until the timeout elapses. Resolves immediately if the agent is already non-working or no agent is attached. Honours client cancellation.";

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

export const OPEN_WORLD_CATEGORIES: ReadonlySet<string> = new Set([
  "browser",
  "devServer",
  "github",
  "portal",
  "voice",
  "system",
]);

export type McpTier = "workbench" | "action" | "system" | "external";

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

  "agent.getState",

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

const ACTION_TIER_ADDONS: ReadonlySet<string> = new Set([
  "worktree.createWithRecipe",
  "worktree.setActive",
  "worktree.refresh",

  "terminal.inject",
  "terminal.new",
  "terminal.sendCommand",
  "terminal.close",
  "terminal.closeAll",
  TERMINAL_WAIT_UNTIL_IDLE_TOOL,

  "recipe.list",
  "recipe.run",

  "copyTree.injectToTerminal",
  "copyTree.generateAndCopyFile",

  "file.openInEditor",

  "agent.launch",
  "agent.terminal",

  "workflow.startWorkOnIssue",

  "project.update",
  "project.saveSettings",
  "project.muteNotifications",
]);

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

export function unionSet(...sets: ReadonlySet<string>[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const set of sets) {
    for (const value of set) out.add(value);
  }
  return out;
}

const MCP_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  "actions.list",
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
  "terminal.inject",
  "terminal.new",
  TERMINAL_WAIT_UNTIL_IDLE_TOOL,

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
  "project.update",
  "project.saveSettings",
  "project.muteNotifications",

  "recipe.list",
  "recipe.run",

  "system.checkCommand",
  "system.checkDirectory",
]);

export const TIER_ALLOWLISTS: Readonly<Record<McpTier, ReadonlySet<string>>> = {
  workbench: WORKBENCH_TOOLS,
  action: unionSet(WORKBENCH_TOOLS, ACTION_TIER_ADDONS),
  system: unionSet(WORKBENCH_TOOLS, ACTION_TIER_ADDONS, SYSTEM_TIER_ADDONS),
  external: MCP_TOOL_ALLOWLIST,
};

export const TIER_NOT_PERMITTED_CODE = "TIER_NOT_PERMITTED";

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

export function unwrapDispatchResult(envelope: DispatchEnvelope): unknown {
  const result = envelope.result;
  if (result.ok) return result.result;
  throw new Error(`Action failed [${result.error.code}]: ${result.error.message}`);
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
