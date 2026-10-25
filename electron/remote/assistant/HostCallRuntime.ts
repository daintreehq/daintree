import { randomUUID } from "node:crypto";
import { isGlobalAssistantId } from "../../../shared/config/globalAssistant.js";
import { PROJECT_CHECK_DEFAULT_TIMEOUT_MS } from "../../../shared/types/projectCheck.js";
import { REPLY_WAIT_DEFAULT_SECONDS } from "../../../shared/types/replyWait.js";
import {
  HOST_LIST_PROJECTS_MAX,
  type HostCallArgs,
  type HostCallResult,
  type HostControlOutcome,
  type HostControlOutcomeCode,
  type HostEnsureAnswer,
  type HostEnsureProjectArgs,
  type HostEnsureProjectResult,
  type HostListArgs,
  type HostListEntry,
  type HostListResult,
  type HostSettingsArgs,
  type HostSettingsResult,
} from "../../../shared/types/hostControl.js";
import {
  HOST_THROWAWAY_TOOL_SIGNATURES,
  HostThrowawayCallSchema,
  type HostThrowawayFailure,
  type HostThrowawayRefusal,
} from "../../../shared/types/hostThrowaway.js";
import { HostSettingsRequests, type HostSettingsRequestDeps } from "./HostSettingsRequests.js";
import {
  AGENT_DIRECTORY_BYTES_MAX,
  fitAgentDirectory,
  unreadAgentDirectory,
  type AgentDirectory,
} from "../../../shared/types/agentDirectory.js";
import type { HostProjectSummary } from "../../../shared/types/ipc/remoteHosts.js";
import {
  LOCAL_HOST_ID,
  type HostConnectionState,
  type HostHandshakeInfo,
  type HostId,
  type HostMetricsSummary,
} from "../../../shared/types/remoteHosts.js";
import type { HostControlRuntimeHandle } from "../../services/mcp-server/hostControlTools.js";
import {
  NOTIFY_KEY_TOOLS,
  NOTIFY_PROMPT_TOOLS,
  TERMINAL_NOTIFY_WHEN_IDLE_TOOL,
  relayCallArmsNotice,
  type FiredNotice,
  type LaneWake,
  type LaneWakeCheck,
} from "../../services/mcp-server/terminalNotify.js";
import { sanitizeNotifyNote } from "../../../shared/types/terminalNotify.js";
import { projectHostLoad } from "./hostLoad.js";
import { projectHostAgentClis, projectHostBuild, projectHostLink } from "./hostObservations.js";
import type { HostControlLinkClient } from "./HostControlLinkClient.js";
import type { AssistantEnsureRequest } from "../projects/HostSwitchService.js";
import {
  MAX_RELAY_ARGS_BYTES,
  MAX_RELAY_RUN_MS,
  RELAY_NOTICE_WINDOW_MS,
  type McpCallAnswer,
  type McpCallPayload,
  type RelayApproveAnswer,
  type RelayApprovePayload,
  type RelayNotice,
  type RelayNoticeStatusAnswer,
  type RelayNoticeStatusPayload,
  type RelayNoticesPayload,
  type RelayRefusal,
  type ThrowawayCallAnswer,
  type ThrowawayCallPayload,
} from "./linkMethods.js";
import { canonicalArgsHash } from "../../services/mcp-server/sessionDedup.js";
import type { McpConfirmationDecision } from "../../../shared/types/ipc/mcpServer.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("main:HostCallRuntime");

/** One host as this Shell observes it: its registry entry, its link, its last summary. */
export interface ObservedHost {
  hostId: HostId;
  name: string;
  connection: HostConnectionState;
  lastSeenAt: number | null;
  summary: HostMetricsSummary | null;
  /** The build its last handshake named, kept after the link goes. */
  lastHandshake?: HostHandshakeInfo | null;
  /** The person disconnected it and nothing has dialled it since. */
  disconnectedByPerson?: boolean;
}

/**
 * This machine's own projects as its assistants reach them (#14024): through
 * `host.call` under this machine's own id, in process, through the same gates
 * a host's projects are reached through.
 */
export interface LocalHostReach {
  /** This machine's name, as its assistants' prompts and notices say it. */
  name(): string;
  /** Its projects, most used first. */
  projects(): Promise<readonly HostProjectSummary[]>;
  /**
   * The latest sample of this machine, or null where none is held or the
   * platform can't be measured. Reading it never starts sampling.
   */
  latestSummary?(): HostMetricsSummary | null;
  relayCall(payload: McpCallPayload): Promise<McpCallAnswer>;
  /** A throwaway tool on this machine (#14446); absent, it runs none. */
  throwawayCall?(payload: ThrowawayCallPayload): Promise<ThrowawayCallAnswer>;
  /** Its workers and assistants, as `host.list` shows them with `includeAgents` (#14160). */
  agents?(options: { projectId?: string }): Promise<AgentDirectory>;
}

/** The run a help session is answering in, as `host.call` pins what it arms to. */
export interface OpenRun {
  projectId: string;
  slot: number;
  sessionId: string;
  terminalId: string;
  launchGeneration: number;
}

export interface HostCallRuntimeDeps {
  /** The lane a live help session was provisioned for; null once it is revoked or ending. */
  getSessionLane(helpSessionId: string): { projectId: string; slot: number } | null;
  /**
   * The run a help session is answering in right now, when it is the running
   * assistant of its lane in one of this machine's own views; null for a
   * session its lane replaced, or an assistant a remote Shell's view runs here.
   */
  callerRun(helpSessionId: string): OpenRun | null;
  /** Read at each call: the client is installed with the database and may come later. */
  client():
    | (Pick<HostControlLinkClient, "relayCall" | "throwawayCall"> &
        Partial<Pick<HostControlLinkClient, "throwawayRelease">>)
    | null;
  /**
   * Whether a help session's assistant works through one of this machine's own
   * views, from its provisioning, before its run is confirmed; false for one a
   * remote Shell's view runs here. Listing the host tools goes by it.
   */
  inLocalView?(helpSessionId: string): boolean;
  /** The person's per-host "assistant control" switch, read at each call (#13493). */
  controlEnabled?(hostId: HostId): boolean;
  /**
   * Queues a wake on a run's own notice line, the one writer that types into
   * its prompt, under its gate (#13500). Absent, hosts' notices are dropped.
   */
  queueNotice?(
    lane: { helpSessionId: string; terminalId: string; projectId: string },
    wake: LaneWake
  ): void;
  hosts(): ObservedHost[];
  /**
   * This machine's own projects (#14024): `host.list` names them first, as
   * `local`, and `host.call` reaches them there. Absent, `local` is no host.
   */
  local?: LocalHostReach;
  /** A connected host's projects, most used first: the projectIds `host.call` takes. */
  listHostProjects?(hostId: HostId): Promise<readonly HostProjectSummary[]>;
  /**
   * Dials a host this Shell holds no link to, as `host.call` would, settling
   * once it is connected or `timeoutMs` pass, whichever is first; one the
   * person disconnected is left alone.
   */
  connect?(hostId: HostId, timeoutMs: number): Promise<unknown>;
  /**
   * Puts a host's question about one of this Shell's relayed calls to the
   * person, in the window of the assistant that made it (#13501), showing the
   * host's own preview. Null when it couldn't be asked there; absent, no host
   * is ever answered.
   */
  askApproval?(ask: RelayApprovalQuestion): Promise<McpConfirmationDecision | null>;
  /**
   * Makes sure one of this machine's projects is on a host, with no window
   * (#14140): the Shell's switch service. Absent, no project is ever brought.
   */
  ensureProject?(request: AssistantEnsureRequest): Promise<HostEnsureAnswer>;
  /** The Shell's client for a host's named settings (#14167). Absent, `host.settings` reaches none. */
  settingsClient?: HostSettingsRequestDeps["client"];
  /**
   * Puts a `host.settings` change to the person in the calling assistant's
   * window. Null when it couldn't be asked; absent, no change is ever applied.
   */
  askSettingsApproval?: HostSettingsRequestDeps["askApproval"];
  now?: () => number;
  newId?: () => string;
}

const ERROR_MESSAGE = "Hosts can't be reached right now.";
const NOT_ELIGIBLE_MESSAGE =
  "Only a Daintree Assistant running on this machine can reach its hosts.";

/**
 * Calls whose notices this Shell still waits for (#13500). Past this a call
 * asking for one is refused, never a watch already taken forgotten (#14459).
 */
const MAX_NOTICE_PINS = 256;
/**
 * Calls whose watch is over, the oldest forgotten first: a notice already on
 * its way still lands, and their callIds still name them.
 */
const MAX_SETTLED_PINS = 256;
/** What a call refused for want of room to follow its notices is told to wait. */
const NOTICE_ROOM_RETRY_MS = 60_000;
/**
 * How long a call's notices are taken, and keep its host's link open when
 * nothing else does: as long as its host holds what the call made.
 */
const NOTICE_PIN_TTL_MS = RELAY_NOTICE_WINDOW_MS;
/** Notices already queued, remembered so a host's resend is typed once. */
const MAX_SEEN_NOTICES = 1024;
/** Host terminals whose recent prompts from here are remembered, for superseding. */
const MAX_PROMPTED_TERMINALS = 512;
/**
 * Prompts remembered per host terminal, newest kept: ones that ran apart from
 * ones still unanswered, so a burst of calls refused later never pushes out
 * the evidence that one ran.
 */
const MAX_RAN_PROMPTS_PER_TERMINAL = 4;
const MAX_PENDING_PROMPTS_PER_TERMINAL = 32;
/** How long `host.list` waits for a connected host to name its projects. */
const PROJECTS_READ_MS = 5_000;
/** How long `host.list` waits for a host it dials to connect. */
const LIST_CONNECT_MS = 8_000;

/** What the person at this Shell is asked about one of its relayed calls. */
export interface RelayApprovalQuestion {
  hostId: HostId;
  helpSessionId: string;
  actionId: string;
  args: Record<string, unknown>;
  subject?: string;
  lines: string[];
}

/** A relayed call out to a host right now, and the run here that made it. */
interface CallInFlight {
  hostId: HostId;
  helpSessionId: string;
  /** Null for a throwaway call (#14446), which no host ever asks about. */
  projectId: string | null;
  tool: string;
  args: Record<string, unknown>;
  run: OpenRun;
  /** A host asked about it once already: an approval is for the call, not each ask. */
  asked: boolean;
  /** Sends of it still out, a resend's included; the record goes with the last. */
  sends: number;
}

/**
 * The confirm-gated actions a host may ask this Shell to approve (#13501),
 * each with the owned tool that stands in for it, whose delegate the host
 * rebuilds from the id alone.
 */
const RELAY_APPROVABLE: Readonly<Record<string, { ownedTool: string; idArg: string }>> = {
  "worktree.delete": { ownedTool: "worktree.deleteOwned", idArg: "worktreeId" },
};

/** What a host's MCP server runs a call with: its arguments less the request's own keys. */
function relayedActionArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { _meta: _ignored, requestKey: _requestKey, ...actionArgs } = args;
  return actionArgs;
}

/**
 * Whether a host's ask is about exactly the call this Shell made: the same
 * action with the same arguments, or the plain action an owned tool stands
 * in for, on the same id and nothing else.
 */
function asksAboutCall(call: CallInFlight, payload: RelayApprovePayload): boolean {
  if (!Object.hasOwn(RELAY_APPROVABLE, payload.actionId)) return false;
  const asked = canonicalArgsHash(payload.actionId, payload.args);
  if (asked !== payload.argsHash) return false;
  if (call.tool === payload.actionId) {
    return canonicalArgsHash(call.tool, relayedActionArgs(call.args)) === asked;
  }
  const { ownedTool, idArg } = RELAY_APPROVABLE[payload.actionId]!;
  const id = call.args[idArg];
  return (
    call.tool === ownedTool &&
    typeof id === "string" &&
    canonicalArgsHash(payload.actionId, { [idArg]: id }) === asked
  );
}

/** A call that may arm notices on its host, and the run here that made it. */
interface NoticePin {
  hostId: HostId;
  run: OpenRun;
  armedAt: number;
  /** `terminal.notifyWhenIdle`'s note, kept here rather than read back from the host. */
  note?: string;
  /** The host terminals it asked about: named by its arguments, or a launch's result. */
  terminalIds: string[];
  /** Terminals with nothing more to follow: their notice came, or none was armed. */
  noticed: Set<string>;
  /** The host answered it, so it holds a record of the call (#13930). */
  answered?: boolean;
}

/**
 * The host answered a call: it holds a record of it. A launch names the
 * terminal it made only in its result, and a batch says which items ran:
 * one refused armed nothing.
 */
function noteAnswered(
  pin: NoticePin,
  result: Extract<McpCallAnswer, { status: "done" }>["result"]
): void {
  pin.answered = true;
  const learn = (terminalId: unknown): void => {
    if (typeof terminalId === "string" && !pin.terminalIds.includes(terminalId)) {
      pin.terminalIds.push(terminalId);
    }
  };
  learn(result.structured?.terminalId);
  // `terminal.notifyWhenIdle` on a terminal not working answers now and arms nothing.
  if (result.structured?.armed === false) {
    for (const terminalId of pin.terminalIds) pin.noticed.add(terminalId);
  }
  const items: unknown = result.structured?.results;
  if (!Array.isArray(items)) return;
  for (const item of items as unknown[]) {
    if (item === null || typeof item !== "object") continue;
    const { target, ok, result: value } = item as Record<string, unknown>;
    if (ok === false) {
      pin.terminalIds = pin.terminalIds.filter((terminalId) => terminalId !== target);
    } else if (ok === true && value !== null && typeof value === "object") {
      learn((value as Record<string, unknown>).terminalId);
    }
  }
}

/** The host terminals a call asking for notices names, as far as its arguments say. */
function noticeTargets(tool: string, args: Record<string, unknown>): string[] {
  if (tool === "terminal.sendCommandMany" && Array.isArray(args.sends)) {
    return args.sends
      .map((send) => (send as { terminalId?: unknown } | null)?.terminalId)
      .filter((id): id is string => typeof id === "string");
  }
  return typeof args.terminalId === "string" ? [args.terminalId] : [];
}

/** A prompt sent from here to a host terminal; until its call answers, it may not have run. */
interface PromptMark {
  at: number;
  callId: string;
  /** The help session whose call it was. */
  sessionId: string;
  ran: boolean;
}

/** What a call settles as, once its host has answered or not. */
interface NotedCall {
  /** The host ran it, or may have; `result` when it answered with one. */
  ran(result?: Extract<McpCallAnswer, { status: "done" }>["result"]): void;
  /** The host is known not to have run it. */
  notRun(): void;
}

const NOTHING_NOTED: NotedCall = { ran: () => {}, notRun: () => {} };

function trimMarks(marks: readonly PromptMark[]): PromptMark[] {
  const kept = new Set([
    ...marks.filter((mark) => mark.ran).slice(-MAX_RAN_PROMPTS_PER_TERMINAL),
    ...marks.filter((mark) => !mark.ran).slice(-MAX_PENDING_PROMPTS_PER_TERMINAL),
  ]);
  return marks.filter((mark) => kept.has(mark));
}

/**
 * The host terminals a prompt, or keys with `notify`, makes an undelivered
 * notice about stale: typed after it, the notice would read as its answer.
 */
function promptTargets(tool: string, args: Record<string, unknown>): string[] {
  if (tool === "terminal.sendCommandMany" && Array.isArray(args.sends)) {
    return args.sends
      .map((send) => (send as { terminalId?: unknown } | null)?.terminalId)
      .filter((id): id is string => typeof id === "string");
  }
  const single =
    NOTIFY_PROMPT_TOOLS.has(tool) || (NOTIFY_KEY_TOOLS.has(tool) && args.notify === true);
  return single && typeof args.terminalId === "string" ? [args.terminalId] : [];
}

/** Insert as newest, dropping the oldest once the map holds more than `max`. */
function remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value!);
}

const CONTROL_OFF_DETAIL =
  "Assistant control is turned off for this host in this Shell's host settings. Only the person can turn it on.";
const CALL_NO_HOST_DETAIL = "This Shell has no host with that id. List the hosts it knows.";
const CALL_OWN_PROJECT_DETAIL =
  "That is this assistant's own project, so nothing was run. Call its tools directly; local reaches this machine's other projects.";
const CALL_GLOBAL_WITHHELD_DETAIL =
  "The global assistant can't do that in a project: it acts only on what it launched there or the user handed it, so nothing was run. Ask the user to do it, or to hand you the terminal.";
/**
 * The tools the global assistant may run through `host.call` (#14161). An
 * allow-list, so a tool added to the relay surface later is refused until it
 * is placed here or in {@link GLOBAL_WITHHELD_TOOLS}: reads, launches of its
 * own, and the owned forms that reach only what it launched or was handed.
 * `worktree.resource.teardown` and `recipe.run` are here on purpose: both are
 * `danger: "confirm"`, so the person approves each run.
 */
export const GLOBAL_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "actions.getContext",
  "actions.search",
  "actions.getSchema",
  "actions.list",
  "mcp.surface",
  "workspace.list",
  "worktree.list",
  "worktree.getCurrent",
  "worktree.reviewReadiness",
  "worktree.createWithRecipe",
  "worktree.waitUntilReady",
  "worktree.waitForPullRequest",
  "worktree.deleteOwned",
  "worktree.resource.status",
  "worktree.resource.teardown",
  "recipe.list",
  "recipe.run",
  "agent.launch",
  "agent.launchMany",
  "agent.listAvailable",
  "agent.listPresets",
  "agent.listModels",
  "agent.readQuota",
  "agentSessionHistory.list",
  "assistant.list",
  "assistant.start",
  "terminal.list",
  "terminal.getStatus",
  "terminal.getOutput",
  "terminal.readLastMessageOwned",
  "terminal.new",
  "terminal.sendCommandOwned",
  "terminal.sendCommandMany",
  "terminal.sendKeysOwned",
  "terminal.injectOwned",
  "terminal.interruptOwned",
  "terminal.closeOwned",
  "terminal.closeMany",
  "terminal.restartOnPresetOwned",
  "terminal.revealOwned",
  "terminal.placeOwned",
  "terminal.waitUntilIdle",
  "terminal.waitUntilIdleBatch",
  "terminal.notifyWhenIdle",
  "slashCommands.list",
  "workflow.startWorkOnIssue",
  "workflow.prepBranchForReview",
  "project.detectRunners",
  "git.getProjectPulse",
  "forge.getPR",
  "forge.listPRs",
  "forge.getIssue",
  "forge.listIssues",
  "forge.getCIStatus",
  "copyTree.generate",
  "skills.search",
  "skills.load",
  "fleet.getRunStatus",
  "browser.getConsoleMessages",
  "errors.recent",
  "notifications.recent",
  "plugin.validate",
  "plugin.diagnostics",
  "plugin.capturePanel",
]);
/**
 * Tools a project's assistant may reach that the global assistant may not:
 * each acts on something it neither launched nor was handed (a project's
 * commands, dev server, plugins, worktree state and view, a pane named by id,
 * the user's own agent sessions, the clipboard), or is an unscoped form a relay
 * never holds. Listed so the
 * guard test can tell a deliberate refusal from a tool nobody placed.
 */
export const GLOBAL_WITHHELD_TOOLS: ReadonlySet<string> = new Set([
  "project.runCommand",
  "project.runCheck",
  "project.openOnHost",
  "worktree.setActive",
  "worktree.setLabelColor",
  "worktree.setCustomTitle",
  "worktree.resource.provision",
  "worktree.resource.pause",
  "worktree.resource.resume",
  "terminal.moveToWorktree",
  "terminal.rename",
  "terminal.setClientMetadata",
  "devPreview.restart",
  "devPreview.reloadPreview",
  "plugin.reloadProject",
  "plugin.reloadPanel",
  "copyTree.generateAndCopyFile",
  "terminal.sendCommand",
  "terminal.sendKeys",
  "terminal.inject",
  "terminal.close",
  "terminal.kill",
  "terminal.restart",
  "terminal.closeAll",
  "worktree.delete",
  "copyTree.injectToTerminal",
  "diagnostics.openReview",
  // Brings the user's backgrounded pane forward or relaunches their conversation,
  // and the pane it opens is never recorded as the assistant's.
  "agentSessionHistory.resume",
]);
const CALL_AMBIGUOUS_DETAIL =
  "No answer came back, so the call may have reached the host and run. Resend it under this callId, which never runs it twice.";
const CALL_NOT_SENT_DETAIL =
  "The host can't be reached right now, so nothing was sent. Try again once it is back.";
const CALL_RESEND_DISCONNECTED_DETAIL =
  "The host can't be reached right now. Resend under the same callId once it is back; it never runs twice.";
const CALL_UNKNOWN_DETAIL =
  "The host no longer holds a record of this callId, so it may or may not have run. Check what it would have changed before running it again as a new call.";
const CALL_CONFLICT_DETAIL =
  "That callId was already used for a different call. Resend only the exact call it named, or make a new call.";
const CALL_ID_TAKEN_DETAIL =
  "That newCallId already names another call here. Nothing was sent; pick a fresh one.";
const CALL_TOO_LARGE_DETAIL = "The call's arguments are too large to send. Nothing was sent.";
const THROWAWAY_TOOLS_DETAIL = `A throwaway target takes only these tools, with these args: ${HOST_THROWAWAY_TOOL_SIGNATURES}. Nothing was sent; project tools need a projectId.`;
const THROWAWAY_REFUSAL_DETAILS: Record<
  Exclude<HostThrowawayRefusal, "control-off">,
  { code: Exclude<HostControlOutcomeCode, "ok">; detail: string }
> = {
  "throwaway-off": {
    code: "unsupported",
    detail:
      "That machine doesn't run throwaway agents: it has them off or can't run them yet. Nothing was run.",
  },
  "expiry-unsupported": {
    code: "unsupported",
    detail:
      "That machine runs an older Daintree that can't end a run on a time limit. Nothing was run.",
  },
};
/** A throwaway tool that ran and failed, as the tool error it reads like. */
const THROWAWAY_FAILURE_MESSAGES: Record<HostThrowawayFailure, string> = {
  "not-found":
    "No run of this assistant's has that runId. It may have been closed, or passed its time limit.",
  exited: "The run's process has ended, so nothing was typed.",
  "launch-failed": "The agent couldn't be launched.",
  "input-failed": "The input couldn't be typed into the run.",
  "close-failed": "The run couldn't be closed. Its process may still be running.",
  "output-unavailable":
    "The run's screen couldn't be read, so its output wasn't checked; this is not an empty screen. Nothing was typed or relaunched. Read it again, or check its status.",
};
const CALL_SENDER_REFUSED_DETAIL =
  "The host refused this Shell's identity on the current connection. Try again shortly.";
const CALL_RATE_LIMITED_DETAIL = "Too many calls in a short time. Retry after retryAfterMs.";
const CALL_NOTICES_FULL_DETAIL =
  "This Shell already waits on notices from as many calls as it can follow. Nothing was sent. Retry after retryAfterMs, once some have come, or make the call without asking for a notice.";
const ENSURE_LOCAL_DETAIL =
  "The project is already on this machine. Name a host from the host list to bring it to.";
const ENSURE_UNAVAILABLE_DETAIL = "This Shell can't bring projects to its hosts right now.";
const ENSURE_HOST_REFUSED_DETAIL =
  "The host refuses work for other machines' assistants: its own setting is off. Nothing was changed there.";
const ENSURE_DISCONNECTED_DETAIL =
  "The host can't be reached right now. Call again once it is back; what was already made is found, not made twice.";
const ENSURE_AMBIGUOUS_DETAIL =
  "No clear answer came back. Call again with the same arguments: what was made is found, never made twice.";
const ENSURE_REFUSED_DETAIL =
  "A step was refused: worktreePath must be one of this project's worktrees, and the host's folder must still be free. Nothing more was done.";
const RELAY_REFUSAL_DETAILS: Record<
  RelayRefusal,
  { code: Exclude<HostControlOutcomeCode, "ok">; detail: string }
> = {
  "control-off": {
    code: "policy_rejected",
    detail:
      "The host refuses tools run for other machines' assistants: its own setting is off. Nothing was run.",
  },
  "no-project": {
    code: "not_found",
    detail:
      "The host has no project with that id. Nothing was run. The host list names its projects.",
  },
  "server-off": {
    code: "unsupported",
    detail: "The host's Daintree MCP server is off, so it can't run tools. Nothing was run.",
  },
};

/** The same refusals for one of this machine's own projects (#14024), which needs no consent here. */
const LOCAL_REFUSAL_DETAILS: Partial<
  Record<RelayRefusal, { code: Exclude<HostControlOutcomeCode, "ok">; detail: string }>
> = {
  "no-project": {
    code: "not_found",
    detail:
      "This machine has no project with that id. Nothing was run. The host list names its projects.",
  },
  "server-off": {
    code: "unsupported",
    detail: "This machine's Daintree MCP server is off, so it can't run tools. Nothing was run.",
  },
};

/** Least a relayed call is given: a dispatch, a confirmation the person may take, and the trip. */
const RELAY_MIN_RUN_MS = 90_000;
/** Room past what a tool asks for, for its own dispatch and its answer to come back. */
const RELAY_RUN_MARGIN_MS = 30_000;
/** How much longer than the host's own deadline the Shell waits for the answer. */
const RELAY_ANSWER_GRACE_MS = 15_000;

/**
 * How long a relayed call may run on its host: above the longest wait the
 * call's own arguments ask for, so a long check or a held reply isn't cut off
 * and reported as lost.
 */
export function relayRunMs(tool: string, args: Record<string, unknown>): number {
  let wanted = 0;
  const timeoutMs = args.timeoutMs;
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    wanted = timeoutMs;
  } else if (tool === "project.runCheck") {
    wanted = PROJECT_CHECK_DEFAULT_TIMEOUT_MS;
  }
  if (args.waitForReply === true) {
    const seconds =
      typeof args.waitSeconds === "number" && Number.isFinite(args.waitSeconds)
        ? args.waitSeconds
        : REPLY_WAIT_DEFAULT_SECONDS;
    wanted = Math.max(wanted, seconds * 1000);
  }
  return Math.min(MAX_RELAY_RUN_MS, Math.max(RELAY_MIN_RUN_MS, wanted + RELAY_RUN_MARGIN_MS));
}

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

const REFUSAL_MESSAGES = {
  NOT_ELIGIBLE: NOT_ELIGIBLE_MESSAGE,
  UNAVAILABLE: ERROR_MESSAGE,
} as const;

class RefusalError extends Error {
  constructor(readonly code: keyof typeof REFUSAL_MESSAGES) {
    super(REFUSAL_MESSAGES[code]);
  }
}

/** Settles with `work`, or with `fallback` once `ms` pass; the timer never outlives it. */
/**
 * Cuts a directory so the whole `host.list` answer, not the directory alone,
 * stays within the agent budget the MCP result is capped to.
 */
function fitToResponse(
  agents: AgentDirectory,
  entry: HostListEntry,
  others: readonly HostListEntry[]
): AgentDirectory {
  const { agents: _agents, ...rest } = entry;
  const encoder = new TextEncoder();
  const restBytes = encoder.encode(
    JSON.stringify({ hosts: [rest, ...others], agents: null })
  ).length;
  return fitAgentDirectory(agents, Math.max(0, AGENT_DIRECTORY_BYTES_MAX - restBytes));
}

function withinMs<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** A project as `host.list` names it, with whether a frontend is attached as its host said. */
function listedProject(
  project: HostProjectSummary
): NonNullable<HostListEntry["projects"]>[number] {
  return {
    projectId: project.id,
    name: project.name,
    frontendAttached: project.frontendAttached ?? null,
  };
}

function observedConnection(state: HostConnectionState): HostListEntry["connection"] {
  return state.status === "connected" || state.status === "connecting"
    ? state.status
    : "disconnected";
}

/**
 * What this Shell's assistants reach its hosts through (#13493): `host.list`
 * to see them, `host.call` to run a host's own tools there. The caller is
 * always a help session id the MCP transport bound to its bearer, and any
 * live assistant on this machine qualifies, with nothing to enroll; a revoked
 * session, a pane or an external key gets nothing, whatever its tier. Each
 * host also needs the person's control switch on. Delegating to a host's
 * assistant is agent messaging run through `host.call` (#13496), so the
 * notices and approvals those calls arm come back here too.
 */
export class HostCallRuntime implements HostControlRuntimeHandle {
  private readonly now: () => number;
  private readonly newId: () => string;
  /** Relayed calls out to each host right now, for the host's dialogs to be believed by. */
  private readonly callsOut = new Map<HostId, number>();
  /** Calls whose notices this Shell still waits for, by callId (#13500). */
  private readonly noticePins = new Map<string, NoticePin>();
  /** Calls whose watch is over, by callId, kept apart so they never crowd out one still waited for (#14459). */
  private readonly settledPins = new Map<string, NoticePin>();
  /** Relayed calls out right now, by callId, for a host's ask about one to be checked against (#13501). */
  private readonly callsInFlight = new Map<string, CallInFlight>();
  /** Notices already queued, by host and noticeId. */
  private readonly seenNotices = new Map<string, true>();
  /** Recent prompts sent from here to each host terminal, by host and terminal. */
  private readonly prompted = new Map<string, PromptMark[]>();
  /** The hosts each help session sent a throwaway launch to, to release them when it ends (#14447). */
  private readonly throwawayHosts = new Map<string, Set<HostId>>();
  private disposed = false;
  private readonly settingsRequests: HostSettingsRequests;

  constructor(private readonly deps: HostCallRuntimeDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
    this.settingsRequests = new HostSettingsRequests({
      client: () => deps.settingsClient?.() ?? null,
      hostName: (hostId) => deps.hosts().find((host) => host.hostId === hostId)?.name ?? null,
      controlOn: (hostId) => this.controlOn(hostId),
      ...(deps.askSettingsApproval ? { askApproval: deps.askSettingsApproval } : {}),
      now: () => this.now(),
      newId: () => this.newId(),
    });
  }

  /** The run a calling session answers in, when it may reach hosts at all. */
  private caller(helpSessionId: string): OpenRun | null {
    if (this.disposed) return null;
    return this.deps.callerRun(helpSessionId);
  }

  /**
   * Whether this session is offered the host tools (#13493): any live
   * assistant session working through one of this machine's own views, from
   * its start and whether or not a host exists yet, since a client that reads
   * its tool list once never learns of a host added later. One a remote
   * Shell's view runs here is never offered them: a host relaying through
   * this machine could reach every other. The calls still ask of the running run.
   */
  isCallReachable(helpSessionId: string): boolean {
    return (
      !this.disposed &&
      this.deps.getSessionLane(helpSessionId) !== null &&
      this.deps.inLocalView?.(helpSessionId) === true
    );
  }

  /** Whether one of this Shell's assistants has a call out to `hostId` right now. */
  hasCallInFlight(hostId: HostId): boolean {
    return (this.callsOut.get(hostId) ?? 0) > 0;
  }

  /**
   * Whether a call to `hostId` from an assistant still running here may yet
   * send a notice (#13500). The host can't dial this Shell, so its link stays
   * open for as long as the call's notices are taken, unless the host said it
   * has nothing more for it (#13930).
   */
  awaitsNotices(hostId: HostId): boolean {
    return this.followedPins(hostId).length > 0;
  }

  /** The calls to `hostId` whose notices this Shell still waits for, to ask the host after. */
  noticeCalls(hostId: HostId): RelayNoticeStatusPayload["calls"] {
    return this.followedPins(hostId)
      .filter(([callId]) => !this.callsInFlight.has(callId))
      .map(([callId, pin]) => ({ helpSessionId: pin.run.sessionId, callId }));
  }

  private followedPins(hostId: HostId): Array<[string, NoticePin]> {
    const from = this.now() - NOTICE_PIN_TTL_MS;
    return [...this.noticePins].filter(
      ([, pin]) => pin.hostId === hostId && pin.armedAt >= from && this.stillRunning(pin.run)
    );
  }

  private pinOf(callId: string): NoticePin | undefined {
    return this.noticePins.get(callId) ?? this.settledPins.get(callId);
  }

  /** Its watch is over: its notices are still taken for a while, but it holds nothing open. */
  private settlePin(callId: string, pin: NoticePin): void {
    this.noticePins.delete(callId);
    remember(this.settledPins, callId, pin, MAX_SETTLED_PINS);
  }

  /**
   * Whether another call's notices can be followed. When the watches are
   * full, the ones over in all but name are settled first: past their time,
   * from a run no longer running, or answered with nothing more to follow
   * for any terminal (a call on this machine is never told settled by a
   * host). A batch naming a terminal twice may owe it a second notice.
   */
  private roomForPin(): boolean {
    if (this.noticePins.size < MAX_NOTICE_PINS) return true;
    const from = this.now() - NOTICE_PIN_TTL_MS;
    for (const [callId, pin] of [...this.noticePins]) {
      const done =
        pin.answered === true &&
        !this.callsInFlight.has(callId) &&
        pin.terminalIds.length > 0 &&
        new Set(pin.terminalIds).size === pin.terminalIds.length &&
        pin.terminalIds.every((terminalId) => pin.noticed.has(terminalId));
      if (done || pin.armedAt < from || !this.stillRunning(pin.run)) this.settlePin(callId, pin);
    }
    return this.noticePins.size < MAX_NOTICE_PINS;
  }

  /**
   * What a host said of the calls this Shell waits for notices from (#13930).
   * `settled`: it has nothing more for the call, so the link need not stay
   * open for it. `unknown` for a call it answered: it no longer holds what the
   * call asked for, as after a restart, so nothing will come; the run that
   * made it is told once, naming the terminals, while it is the one running.
   * The host is the connection's, never the payload's.
   */
  receiveNoticeStatus(hostId: HostId, answer: RelayNoticeStatusAnswer): void {
    const queue = this.deps.queueNotice;
    if (this.disposed) return;
    const lost = new Map<string, { run: OpenRun; terminalIds: Set<string> }>();
    for (const { helpSessionId, callId, status } of answer.calls) {
      const pin = this.noticePins.get(callId);
      if (pin === undefined || pin.hostId !== hostId || pin.run.sessionId !== helpSessionId) {
        continue;
      }
      // A resend out now may change what the host holds: the next ask hears it.
      if (status === "watching" || this.callsInFlight.has(callId)) continue;
      // One the host never answered may never have reached it: nothing was lost.
      // Nor was a notice that already came, with nothing to follow it. With
      // no terminals known, what came can't say nothing else was asked for.
      const missing = pin.terminalIds.filter((terminalId) => !pin.noticed.has(terminalId));
      if (
        status !== "unknown" ||
        pin.answered !== true ||
        (pin.terminalIds.length > 0 && missing.length === 0)
      ) {
        this.settlePin(callId, pin);
        continue;
      }
      this.noticePins.delete(callId);
      if (!this.stillRunning(pin.run)) continue;
      const key = `${pin.run.sessionId}\u0000${pin.run.terminalId}\u0000${pin.run.launchGeneration}`;
      const entry = lost.get(key) ?? { run: pin.run, terminalIds: new Set<string>() };
      for (const terminalId of missing) entry.terminalIds.add(terminalId);
      lost.set(key, entry);
    }
    if (queue === undefined || lost.size === 0) return;
    const hostName = this.hostName(hostId);
    for (const { run, terminalIds } of lost.values()) {
      const check = (): LaneWakeCheck => {
        if (!this.stillRunning(run)) return { kind: "unavailable", reason: "relaunched" };
        return this.controlOn(hostId)
          ? { kind: "ready" }
          : { kind: "unavailable", reason: "control-off" };
      };
      if (check().kind !== "ready") continue;
      queue(
        { helpSessionId: run.sessionId, terminalId: run.terminalId, projectId: run.projectId },
        {
          id: this.newId(),
          kind: "lost",
          lostNotices: { hostName, terminalIds: [...terminalIds] },
          recheck: check,
          beforeType: () => true,
          report: () => {},
        }
      );
    }
  }

  /**
   * A host asking the person here about one of this Shell's relayed calls it
   * would run itself, with no view of its own to ask in (#13501). Answered
   * only for a call still out to that host from the run that made it, about
   * exactly that call's action and arguments, once per call, and only while
   * the person's control switch for the host is on; asked in that
   * assistant's own window. Anything else is `refused`, which approves
   * nothing. The host is the connection's, never the payload's.
   */
  async receiveApproval(hostId: HostId, payload: RelayApprovePayload): Promise<RelayApproveAnswer> {
    const answer = (decision: RelayApproveAnswer["decision"]): RelayApproveAnswer => ({
      approvalId: payload.approvalId,
      argsHash: payload.argsHash,
      decision,
    });
    const call = this.callsInFlight.get(payload.callId);
    const ask = this.deps.askApproval;
    if (
      this.disposed ||
      ask === undefined ||
      call === undefined ||
      call.asked ||
      call.hostId !== hostId ||
      call.helpSessionId !== payload.helpSessionId ||
      call.projectId !== payload.projectId ||
      !asksAboutCall(call, payload) ||
      !this.stillRunning(call.run) ||
      !this.controlOn(hostId)
    ) {
      return answer("refused");
    }
    call.asked = true;
    let decision: McpConfirmationDecision | null;
    try {
      decision = await ask({
        hostId,
        helpSessionId: payload.helpSessionId,
        actionId: payload.actionId,
        args: payload.args,
        ...(payload.subject !== undefined ? { subject: payload.subject } : {}),
        lines: payload.lines,
      });
    } catch (error) {
      logger.warn("Asking about a host's call failed", { error });
      decision = null;
    }
    // The call can end, or its run be replaced, while the person decides.
    if (
      decision === "approved" &&
      (this.callsInFlight.get(payload.callId) !== call ||
        !this.stillRunning(call.run) ||
        !this.controlOn(hostId))
    ) {
      return answer("refused");
    }
    return answer(decision ?? "refused");
  }

  /**
   * What a host saw of terminals this Shell's assistants asked it about
   * (#13500). The host is the connection's, never the payload's, and each
   * notice goes only to the run whose call armed it, while that run is the
   * one running: a run that replaced it never hears it.
   */
  receiveNotices(hostId: HostId, payload: RelayNoticesPayload): null {
    const queue = this.deps.queueNotice;
    if (this.disposed || queue === undefined) return null;
    const hostName = this.hostName(hostId);
    const receivedAt = this.now();
    for (const notice of payload.notices) {
      const seenKey = `${hostId}\u0000${notice.noticeId}`;
      if (this.seenNotices.has(seenKey)) continue;
      const pin = this.pinOf(notice.callId);
      if (
        pin === undefined ||
        pin.hostId !== hostId ||
        pin.run.sessionId !== notice.helpSessionId ||
        receivedAt - pin.armedAt > NOTICE_PIN_TTL_MS
      ) {
        continue;
      }
      // It came, whether or not it is still worth typing.
      if (notice.awaitingHandback !== true) pin.noticed.add(notice.terminalId);
      const check = this.checkNotice(pin, notice, receivedAt);
      if (check.kind !== "ready") continue;
      remember(this.seenNotices, seenKey, true, MAX_SEEN_NOTICES);
      const fired: FiredNotice = {
        terminalId: notice.terminalId,
        observation: notice.observation,
        ...(pin.note !== undefined ? { note: pin.note } : {}),
        ...(notice.awaitingHandback === true ? { awaitingHandback: true } : {}),
      };
      queue(
        {
          helpSessionId: pin.run.sessionId,
          terminalId: pin.run.terminalId,
          projectId: pin.run.projectId,
        },
        {
          id: notice.noticeId,
          kind: "notice",
          hostNotice: { hostName, notice: fired },
          recheck: () => this.checkNotice(pin, notice, receivedAt),
          beforeType: () => true,
          report: () => {},
        }
      );
    }
    return null;
  }

  /** Whether a received notice may still be typed: its run, the switch, and no newer prompt. */
  private checkNotice(
    pin: NoticePin,
    notice: Pick<RelayNotice, "terminalId" | "callId">,
    receivedAt: number
  ): LaneWakeCheck {
    if (!this.stillRunning(pin.run)) return { kind: "unavailable", reason: "relaunched" };
    if (!this.controlOn(pin.hostId)) {
      return { kind: "unavailable", reason: "control-off" };
    }
    // Typed after a later prompt to the same terminal, it would read as that
    // one's answer; it waits while that prompt's call is unanswered. A notice
    // for the prompt itself is never stale by it.
    let pending = false;
    for (const mark of this.prompted.get(`${pin.hostId}\u0000${notice.terminalId}`) ?? []) {
      if (mark.callId === notice.callId || mark.at <= receivedAt) continue;
      if (mark.ran) return { kind: "unavailable", reason: "superseded" };
      pending = true;
    }
    return pending ? { kind: "held", reason: "prompt-pending" } : { kind: "ready" };
  }

  /**
   * Whether this Shell's assistants may reach a host now: this machine's own
   * projects whenever they are reachable at all (#14024), any other host only
   * while the person's control switch for it is on.
   */
  private controlOn(hostId: HostId): boolean {
    if (hostId === LOCAL_HOST_ID) return this.deps.local !== undefined;
    return this.deps.controlEnabled?.(hostId) === true;
  }

  private hostName(hostId: HostId): string {
    if (hostId === LOCAL_HOST_ID && this.deps.local) return this.deps.local.name();
    return this.deps.hosts().find((host) => host.hostId === hostId)?.name ?? "remote host";
  }

  private stillRunning(run: OpenRun): boolean {
    const now = this.caller(run.sessionId);
    return (
      now !== null &&
      now.projectId === run.projectId &&
      now.terminalId === run.terminalId &&
      now.launchGeneration === run.launchGeneration
    );
  }

  /**
   * A first send, noted before it goes out so a notice it arms can't arrive
   * ahead of its pin. A resend notes nothing: its first send was pinned to the
   * run that made it, and a run that replaced that one must not take it over.
   * A call the host is known not to have run is taken back: it armed
   * nothing, and its prompt made nothing stale.
   */
  private noteCall(
    callId: string,
    hostId: HostId,
    run: OpenRun,
    tool: string,
    args: Record<string, unknown>
  ): NotedCall {
    const marks: PromptMark[] = [];
    const keys: string[] = [];
    for (const terminalId of new Set(promptTargets(tool, args))) {
      const key = `${hostId}\u0000${terminalId}`;
      const mark: PromptMark = { at: this.now(), callId, sessionId: run.sessionId, ran: false };
      remember(
        this.prompted,
        key,
        trimMarks([...(this.prompted.get(key) ?? []), mark]),
        MAX_PROMPTED_TERMINALS
      );
      marks.push(mark);
      keys.push(key);
    }
    const pinned = relayCallArmsNotice(tool, args);
    let pin: NoticePin | undefined;
    if (pinned) {
      const note =
        tool === TERMINAL_NOTIFY_WHEN_IDLE_TOOL && typeof args.note === "string"
          ? sanitizeNotifyNote(args.note)
          : undefined;
      pin = {
        hostId,
        run: { ...run },
        armedAt: this.now(),
        ...(note !== undefined ? { note } : {}),
        terminalIds: noticeTargets(tool, args),
        noticed: new Set(),
      };
      this.noticePins.set(callId, pin);
    }
    let settled = false;
    return {
      ran: (result) => {
        if (settled) return;
        settled = true;
        for (const mark of marks) mark.ran = true;
        if (pin !== undefined && result !== undefined) noteAnswered(pin, result);
      },
      notRun: () => {
        if (settled) return;
        settled = true;
        if (pin !== undefined) {
          if (this.noticePins.get(callId) === pin) this.noticePins.delete(callId);
          if (this.settledPins.get(callId) === pin) this.settledPins.delete(callId);
        }
        for (const key of keys) {
          const left = (this.prompted.get(key) ?? []).filter((mark) => mark.callId !== callId);
          if (left.length > 0) this.prompted.set(key, left);
          else this.prompted.delete(key);
        }
      },
    };
  }

  /** Who a call id already names here, from what is still held of it. */
  private knownCall(callId: string): { hostId: HostId; helpSessionId: string } | null {
    const out = this.callsInFlight.get(callId);
    if (out !== undefined) return { hostId: out.hostId, helpSessionId: out.helpSessionId };
    const pin = this.pinOf(callId);
    if (pin !== undefined) return { hostId: pin.hostId, helpSessionId: pin.run.sessionId };
    for (const [key, marks] of this.prompted) {
      const mark = marks.find((candidate) => candidate.callId === callId);
      if (mark !== undefined) {
        return { hostId: key.slice(0, key.indexOf("\u0000")), helpSessionId: mark.sessionId };
      }
    }
    return null;
  }

  /**
   * One of this machine's help sessions ended: each host it launched a
   * throwaway run on closes them now, not at their time limits. A host this
   * can't reach still ends them on its own, when this Shell's link goes or the
   * limits pass.
   */
  endHelpSession(helpSessionId: string): void {
    const hosts = this.throwawayHosts.get(helpSessionId);
    this.throwawayHosts.delete(helpSessionId);
    const client = this.deps.client();
    if (hosts === undefined || !client?.throwawayRelease) return;
    for (const hostId of hosts) {
      void client.throwawayRelease(hostId, { helpSessionId }).catch((error: unknown) => {
        logger.debug("Couldn't release a host's throwaway runs", { hostId, error });
      });
    }
  }

  /** Forgets every call and notice; calls on hosts are left as they are. */
  dispose(): void {
    this.disposed = true;
    this.throwawayHosts.clear();
    this.callsOut.clear();
    this.callsInFlight.clear();
    this.noticePins.clear();
    this.settledPins.clear();
    this.seenNotices.clear();
    this.prompted.clear();
    this.settingsRequests.dispose();
  }

  /**
   * Runs one of a host's own Daintree tools for the calling assistant
   * (#13493). The host admits it through its own MCP gates as this Shell's
   * sender and the caller's help session, at the caller's tier, so it can do
   * no more there than the assistant could here, and less where the host says
   * so. Needs only the person's "assistant control" switch for the host, not
   * messaging. A first send mints its callId, or takes the caller's own
   * `newCallId` (#14240) so a call whose whole answer was lost can still be
   * resent; a callId given back is always a resend, which the host never runs
   * twice and never starts if it holds no record of it.
   *
   * This machine's own id reaches its other projects (#14024), in process
   * and through those same gates, needing no switch: it is the person's own
   * machine. The caller's own project is refused, since its tools reach it
   * already and a second identity there would own what the first can't.
   */
  call(
    helpSessionId: string,
    args: HostCallArgs,
    context: { tier: "core" | "full" }
  ): Promise<HostControlOutcome<HostCallResult>> {
    return this.settle(helpSessionId, async (caller) => {
      const projectId = args.projectId;
      if (args.throwaway === true || projectId === undefined) {
        return this.callThrowaway(helpSessionId, caller, args, context);
      }
      const callId = args.callId ?? args.newCallId ?? this.newId();
      // The caller's own id for a first send (#14240) may already name a call
      // here: another session's or host's is never taken over, and one of its
      // own is only ever resent, since the host may have forgotten it by now.
      const known = args.newCallId !== undefined ? this.knownCall(callId) : null;
      if (
        known !== null &&
        (known.hostId !== args.hostId || known.helpSessionId !== helpSessionId)
      ) {
        return {
          ...this.outcomeWith("conflict", CALL_ID_TAKEN_DETAIL),
          callId: null,
          result: null,
        };
      }
      const resend = args.callId !== undefined || known !== null;
      const sent = { callId, result: null };
      // A first send refused here sent nothing, so there is no call to follow.
      const unsent = { callId: resend ? callId : null, result: null };
      const local = args.hostId === LOCAL_HOST_ID ? this.deps.local : undefined;
      const host = local
        ? undefined
        : this.deps.hosts().find((candidate) => candidate.hostId === args.hostId);
      if (local) {
        if (projectId === caller.projectId) {
          return { ...this.outcomeWith("policy_rejected", CALL_OWN_PROJECT_DETAIL), ...unsent };
        }
      } else if (!host) {
        return { ...this.outcomeWith("not_found", CALL_NO_HOST_DETAIL), ...unsent };
      } else if (this.deps.controlEnabled?.(args.hostId) !== true) {
        return { ...this.outcomeWith("opted_out", CONTROL_OFF_DETAIL), ...unsent };
      }
      // The global assistant acts only on what it launched or was handed
      // (#14161), on any host: anything not allowed is refused.
      if (isGlobalAssistantId(caller.projectId) && !GLOBAL_ALLOWED_TOOLS.has(args.tool)) {
        return { ...this.outcomeWith("policy_rejected", CALL_GLOBAL_WITHHELD_DETAIL), ...unsent };
      }
      const toolArgs = args.args ?? {};
      if (Buffer.byteLength(JSON.stringify(toolArgs), "utf8") > MAX_RELAY_ARGS_BYTES) {
        return { ...this.outcomeWith("too_large", CALL_TOO_LARGE_DETAIL), ...unsent };
      }
      // Decided in the same turn as the pin is taken, so calls at once can't overfill it.
      if (!resend && relayCallArmsNotice(args.tool, toolArgs) && !this.roomForPin()) {
        return {
          ...this.outcomeWith("rate_limited", CALL_NOTICES_FULL_DETAIL, NOTICE_ROOM_RETRY_MS),
          ...unsent,
        };
      }
      const runMs = relayRunMs(args.tool, toolArgs);
      const payload: McpCallPayload = {
        helpSessionId,
        projectId,
        tier: context.tier,
        callId,
        resend,
        tool: args.tool,
        args: toolArgs,
        runMs,
      };
      const noted = resend
        ? NOTHING_NOTED
        : this.noteCall(callId, args.hostId, caller, args.tool, toolArgs);
      const sendDone = this.trackSend(callId, {
        hostId: args.hostId,
        helpSessionId,
        projectId,
        tool: args.tool,
        args: toolArgs,
        run: caller,
      });
      let answer: McpCallAnswer;
      try {
        answer = local
          ? await local.relayCall(payload)
          : await this.requireClient().relayCall(
              args.hostId,
              payload,
              runMs + RELAY_ANSWER_GRACE_MS
            );
      } catch (error) {
        return this.sendFailure(error, host, callId, resend, noted);
      } finally {
        sendDone();
      }
      switch (answer.status) {
        // A tool error may still have run some of a batch before it failed.
        case "done": {
          noted.ran(answer.result);
          // A resend that got the answer its first send lost: the host has the call.
          const pin = resend ? this.pinOf(callId) : undefined;
          if (pin?.hostId === args.hostId && pin.run.sessionId === helpSessionId) {
            noteAnswered(pin, answer.result);
          }
          return { ...this.ok(), callId, result: answer.result };
        }
        case "unknown":
          noted.ran();
          return { ...this.outcomeWith("expired", CALL_UNKNOWN_DETAIL), ...sent };
        case "conflict":
          noted.ran();
          return { ...this.outcomeWith("conflict", CALL_CONFLICT_DETAIL), ...sent };
        case "refused": {
          noted.notRun();
          const { code, detail } =
            (local ? LOCAL_REFUSAL_DETAILS[answer.reason] : undefined) ??
            RELAY_REFUSAL_DETAILS[answer.reason];
          return { ...this.outcomeWith(code, detail), ...sent };
        }
      }
    });
  }

  /**
   * Counts one send out to its host until `done`: a resend while its first
   * send is still out is the same call and shares that record, so an approval
   * the host is asking for still counts.
   */
  private trackSend(callId: string, record: Omit<CallInFlight, "asked" | "sends">): () => void {
    const { hostId, helpSessionId } = record;
    this.callsOut.set(hostId, (this.callsOut.get(hostId) ?? 0) + 1);
    const sharing = this.callsInFlight.get(callId);
    const inFlight: CallInFlight =
      sharing !== undefined && sharing.hostId === hostId && sharing.helpSessionId === helpSessionId
        ? sharing
        : { ...record, asked: false, sends: 0 };
    inFlight.sends += 1;
    if (inFlight !== sharing) this.callsInFlight.set(callId, inFlight);
    return () => {
      const left = (this.callsOut.get(hostId) ?? 1) - 1;
      if (left > 0) this.callsOut.set(hostId, left);
      else this.callsOut.delete(hostId);
      inFlight.sends -= 1;
      if (inFlight.sends === 0 && this.callsInFlight.get(callId) === inFlight) {
        this.callsInFlight.delete(callId);
      }
    };
  }

  /** What a send that threw settles as: never sent, refused by the link, or maybe run. */
  private sendFailure(
    error: unknown,
    host: ObservedHost | undefined,
    callId: string,
    resend: boolean,
    noted: NotedCall
  ): HostCallResult {
    const sent = { callId, result: null };
    const unsent = { callId: resend ? callId : null, result: null };
    switch (codeOf(error)) {
      case "OUTCOME_UNKNOWN":
        noted.ran();
        return { ...this.outcomeWith("ambiguous", CALL_AMBIGUOUS_DETAIL), ...sent };
      // Never written to the link: a first send is simply not sent.
      case "HOST_DISCONNECTED":
        noted.notRun();
        return resend
          ? { ...this.outcomeWith("disconnected", CALL_RESEND_DISCONNECTED_DETAIL), ...sent }
          : { ...this.outcomeWith("disconnected", CALL_NOT_SENT_DETAIL), ...unsent };
      case "RATE_LIMITED":
        noted.notRun();
        return {
          ...this.outcomeWith("rate_limited", CALL_RATE_LIMITED_DETAIL, 1_000),
          ...unsent,
        };
      // Only a link answers it, so only for a host this Shell knows.
      case "UNSUPPORTED":
        noted.notRun();
        return { ...this.outcomeWith("unsupported", unsupportedCallDetail(host!)), ...unsent };
      case "PERMISSION":
        noted.notRun();
        return {
          ...this.outcomeWith("policy_rejected", CALL_SENDER_REFUSED_DETAIL),
          ...unsent,
        };
      default:
        // No client to send it with: nothing went out.
        if (error instanceof RefusalError) {
          noted.notRun();
          throw error;
        }
        // Sent, then something unreadable came back: it may have run.
        noted.ran();
        logger.warn("A relayed call ended without a known outcome", { error });
        return { ...this.outcomeWith("ambiguous", CALL_AMBIGUOUS_DETAIL), ...sent };
    }
  }

  /**
   * A throwaway call (#14446): a short-lived agent of this session's own on a
   * host, or on this machine, with no project. It goes to the host's own
   * runs, never to a view or a project's MCP session, so a window that is
   * stuck, switching or holding a lease there changes nothing. The same
   * switches, callIds and outcomes as a project call; a resend never runs
   * twice, so a launch never launches twice.
   */
  private async callThrowaway(
    helpSessionId: string,
    caller: OpenRun,
    args: HostCallArgs,
    context: { tier: "core" | "full" }
  ): Promise<HostCallResult> {
    const parsed = HostThrowawayCallSchema.safeParse({ tool: args.tool, args: args.args ?? {} });
    if (!parsed.success) {
      return {
        ...this.outcomeWith("policy_rejected", THROWAWAY_TOOLS_DETAIL),
        callId: null,
        result: null,
      };
    }
    const callId = args.callId ?? args.newCallId ?? this.newId();
    const known = args.newCallId !== undefined ? this.knownCall(callId) : null;
    if (known !== null && (known.hostId !== args.hostId || known.helpSessionId !== helpSessionId)) {
      return { ...this.outcomeWith("conflict", CALL_ID_TAKEN_DETAIL), callId: null, result: null };
    }
    const resend = args.callId !== undefined || known !== null;
    const sent = { callId, result: null };
    const unsent = { callId: resend ? callId : null, result: null };
    const local = args.hostId === LOCAL_HOST_ID ? this.deps.local : undefined;
    const host = local
      ? undefined
      : this.deps.hosts().find((candidate) => candidate.hostId === args.hostId);
    if (!local) {
      if (!host) return { ...this.outcomeWith("not_found", CALL_NO_HOST_DETAIL), ...unsent };
      if (this.deps.controlEnabled?.(args.hostId) !== true) {
        return { ...this.outcomeWith("opted_out", CONTROL_OFF_DETAIL), ...unsent };
      }
    }
    const runMs = relayRunMs(args.tool, parsed.data.args);
    const payload: ThrowawayCallPayload = {
      helpSessionId,
      tier: context.tier,
      callId,
      resend,
      call: parsed.data,
      runMs,
    };
    const sendDone = this.trackSend(callId, {
      hostId: args.hostId,
      helpSessionId,
      projectId: null,
      tool: args.tool,
      args: parsed.data.args,
      run: caller,
    });
    let answer: ThrowawayCallAnswer;
    try {
      if (local) {
        answer = local.throwawayCall
          ? await local.throwawayCall(payload)
          : { status: "refused", reason: "throwaway-off" };
      } else {
        // Before it is sent: a launch whose answer is lost may still have launched.
        if (parsed.data.tool === "throwaway.launch") {
          const hosts = this.throwawayHosts.get(helpSessionId) ?? new Set<HostId>();
          hosts.add(args.hostId);
          this.throwawayHosts.set(helpSessionId, hosts);
        }
        answer = await this.requireClient().throwawayCall(
          args.hostId,
          payload,
          runMs + RELAY_ANSWER_GRACE_MS
        );
      }
    } catch (error) {
      return this.sendFailure(error, host, callId, resend, NOTHING_NOTED);
    } finally {
      sendDone();
    }
    switch (answer.status) {
      case "done":
        return {
          ...this.ok(),
          callId,
          result: { isError: false, structured: answer.result, text: null },
        };
      case "failed":
        return {
          ...this.ok(),
          callId,
          result: {
            isError: true,
            structured: { code: answer.reason, message: THROWAWAY_FAILURE_MESSAGES[answer.reason] },
            text: null,
          },
        };
      case "unknown":
        return { ...this.outcomeWith("expired", CALL_UNKNOWN_DETAIL), ...sent };
      case "conflict":
        return { ...this.outcomeWith("conflict", CALL_CONFLICT_DETAIL), ...sent };
      case "refused": {
        const { code, detail } =
          answer.reason === "control-off"
            ? RELAY_REFUSAL_DETAILS["control-off"]
            : THROWAWAY_REFUSAL_DETAILS[answer.reason];
        return { ...this.outcomeWith(code, detail), ...sent };
      }
    }
  }

  /**
   * Makes sure the calling assistant's own project is on a host (#14140),
   * with nobody clicking: found there, or cloned there by the host, with the
   * branch's worktree when asked. Needs the person's control switch for the
   * host here, and the host's own consent there. Questions for the person
   * come back in the answer; nothing is pushed, sent or opened.
   */
  ensureProject(
    helpSessionId: string,
    args: HostEnsureProjectArgs
  ): Promise<HostControlOutcome<HostEnsureProjectResult>> {
    return this.settle(helpSessionId, async (caller) => {
      const none = { hostId: args.hostId, answer: null };
      if (args.hostId === LOCAL_HOST_ID) {
        return { ...this.outcomeWith("policy_rejected", ENSURE_LOCAL_DETAIL), ...none };
      }
      const host = this.deps.hosts().find((candidate) => candidate.hostId === args.hostId);
      if (!host) return { ...this.outcomeWith("not_found", CALL_NO_HOST_DETAIL), ...none };
      if (this.deps.controlEnabled?.(args.hostId) !== true) {
        return { ...this.outcomeWith("opted_out", CONTROL_OFF_DETAIL), ...none };
      }
      const ensure = this.deps.ensureProject;
      if (!ensure)
        return { ...this.outcomeWith("unsupported", ENSURE_UNAVAILABLE_DETAIL), ...none };
      try {
        const answer = await ensure({
          toHostId: args.hostId,
          projectId: caller.projectId,
          worktreePath: args.worktreePath ?? null,
          worktree: args.worktree === true,
          copy: args.copy ?? null,
          accept: args.accept ?? [],
        });
        return { ...this.ok(), hostId: args.hostId, answer };
      } catch (error) {
        switch (codeOf(error)) {
          case "UNSUPPORTED":
            return { ...this.outcomeWith("unsupported", unsupportedCallDetail(host)), ...none };
          case "PERMISSION":
            return { ...this.outcomeWith("policy_rejected", ENSURE_HOST_REFUSED_DETAIL), ...none };
          case "HOST_DISCONNECTED":
          case "HOST_VERSION_MISMATCH":
          case "HOST_MODE_OFF":
          case "HOST_SSH_ACCESS_DENIED":
            return { ...this.outcomeWith("disconnected", ENSURE_DISCONNECTED_DETAIL), ...none };
          case "VALIDATION":
          case "NOT_FOUND":
            return { ...this.outcomeWith("conflict", ENSURE_REFUSED_DETAIL), ...none };
          default:
            // Its code only: an error's message can name a folder on either machine.
            logger.warn("Bringing a project to a host ended without a known outcome", {
              code: codeOf(error),
            });
            return { ...this.outcomeWith("ambiguous", ENSURE_AMBIGUOUS_DETAIL), ...none };
        }
      }
    });
  }

  /**
   * Reads, previews and applies a host's named settings for the calling
   * assistant (#14167), under the person's control switch for each host. A
   * change is applied only once the person approves the exact preview, asked
   * in this assistant's own window, and only while this run is still the one
   * running.
   */
  settings(
    helpSessionId: string,
    args: HostSettingsArgs
  ): Promise<HostControlOutcome<HostSettingsResult>> {
    return this.settle(helpSessionId, (caller) =>
      this.settingsRequests.run(helpSessionId, () => this.stillRunning(caller), args)
    );
  }

  list(
    helpSessionId: string,
    args: HostListArgs = {}
  ): Promise<HostControlOutcome<HostListResult>> {
    const agentsOf = args.includeAgents === true ? { projectId: args.projectId } : null;
    return this.settle(helpSessionId, async (caller) => {
      const local = this.deps.local;
      // Each load is projected after every read below settles, against one clock
      // reading: a slow project read must not leave a sample looking fresher
      // than it is when the answer goes out.
      const sampled = new Map<HostListEntry, HostMetricsSummary>();
      const here = local ? this.localEntry(local, caller, agentsOf, sampled) : null;
      const hosts = await Promise.all(
        this.deps.hosts().map(async (seen): Promise<HostListEntry> => {
          const host = await this.dialed(seen);
          const summary = host.summary;
          const connected = host.connection.status === "connected";
          const control = this.deps.controlEnabled?.(host.hostId) === true;
          const entry: HostListEntry = {
            hostId: host.hostId,
            name: host.name,
            connection: observedConnection(host.connection),
            link: projectHostLink(host.connection, host.disconnectedByPerson === true),
            build: projectHostBuild(host.connection, host.lastHandshake ?? null),
            agentClis: projectHostAgentClis(null, false, 0),
            rttMs: host.connection.status === "connected" ? host.connection.rttMs : null,
            lastSeenAt: host.lastSeenAt,
            load: null,
            // A tally from before the link dropped is history, not what is running now.
            agentsObserved:
              connected && summary?.agentsObserved ? { ...summary.agentsObserved } : null,
            projects: connected && control ? await this.hostProjects(host.hostId) : null,
            control,
            // No link reads a host's agents yet: said so, never an empty inventory.
            ...(agentsOf ? { agents: unreadAgentDirectory("unsupported") } : {}),
          };
          if (summary) sampled.set(entry, summary);
          return entry;
        })
      );
      const settled = here ? await here : null;
      const now = this.now();
      const aged = (entry: HostListEntry): HostListEntry => {
        const summary = sampled.get(entry);
        if (!summary) return entry;
        const live = entry.link.status === "connected" || entry.link.status === "local";
        return {
          ...entry,
          load: projectHostLoad(summary, now),
          agentClis: projectHostAgentClis(summary, live, now),
        };
      };
      const others = hosts.map(aged);
      const first = settled ? aged(settled) : null;
      if (first?.agents) first.agents = fitToResponse(first.agents, first, others);
      return { hosts: first ? [first, ...others] : others };
    });
  }

  /**
   * This machine, first (#14024): the projects of its own a call under
   * `local` reaches, which are all but the caller's own, or null when they
   * couldn't be read in time. Nothing about it is sampled or tallied here; its load is the sample already held.
   */
  private async localEntry(
    local: LocalHostReach,
    caller: OpenRun,
    agentsOf: { projectId?: string } | null,
    sampled: Map<HostListEntry, HostMetricsSummary>
  ): Promise<HostListEntry> {
    const summary = local.latestSummary?.() ?? null;
    const projects = await withinMs(
      Promise.resolve()
        .then(() => local.projects())
        .catch(() => null),
      PROJECTS_READ_MS,
      null
    );
    const entry: HostListEntry = {
      hostId: LOCAL_HOST_ID,
      name: local.name(),
      connection: "connected",
      link: projectHostLink({ status: "local" }, false),
      // No handshake: this machine's own build isn't one it was told.
      build: { source: "unknown", handshake: null },
      agentClis: projectHostAgentClis(null, true, 0),
      rttMs: null,
      lastSeenAt: null,
      load: null,
      agentsObserved: null,
      projects:
        projects === null
          ? null
          : projects
              .filter((project) => project.id !== caller.projectId)
              .slice(0, HOST_LIST_PROJECTS_MAX)
              .map(listedProject),
      control: true,
      ...(agentsOf ? { agents: await this.localAgents(local, agentsOf) } : {}),
    };
    if (summary) sampled.set(entry, summary);
    return entry;
  }

  private async localAgents(
    local: LocalHostReach,
    options: { projectId?: string }
  ): Promise<AgentDirectory> {
    const read = local.agents;
    if (!read) return unreadAgentDirectory("unsupported");
    const directory = await withinMs(
      Promise.resolve()
        .then(() => read.call(local, options))
        .catch(() => null),
      PROJECTS_READ_MS,
      null
    );
    return directory === null ? unreadAgentDirectory("unreachable") : directory;
  }

  /**
   * A host with control on that this Shell holds no link to, dialed first:
   * the Shell lets an unused link go after a few minutes, and `host.call`
   * dials it again on demand, so to the assistant it is a host it can reach,
   * not one that is down. One the person disconnected stays as it is. Observed
   * again afterwards, whatever came of it.
   */
  private async dialed(host: ObservedHost): Promise<ObservedHost> {
    const connect = this.deps.connect;
    const status = host.connection.status;
    if (!connect || (status !== "disconnected" && status !== "connecting")) return host;
    if (this.deps.controlEnabled?.(host.hostId) !== true) return host;
    // A dial that throws before it is under way fails this host's entry, never the listing.
    const dial = Promise.resolve()
      .then(() => connect(host.hostId, LIST_CONNECT_MS))
      .catch(() => undefined);
    await withinMs(dial, LIST_CONNECT_MS, undefined);
    return this.deps.hosts().find((candidate) => candidate.hostId === host.hostId) ?? host;
  }

  /** A connected host's projects, or null when it didn't say in time. */
  private async hostProjects(hostId: HostId): Promise<HostListEntry["projects"]> {
    const read = this.deps.listHostProjects;
    if (!read) return null;
    const projects = await withinMs(
      read(hostId).catch(() => null),
      PROJECTS_READ_MS,
      null
    );
    return projects === null ? null : projects.slice(0, HOST_LIST_PROJECTS_MAX).map(listedProject);
  }

  private ok(): { outcome: "ok"; detail: null; retryAfterMs: null } {
    return { outcome: "ok", detail: null, retryAfterMs: null };
  }

  /** An outcome and the fixed words that say what it means here. */
  private outcomeWith(
    code: Exclude<HostControlOutcomeCode, "ok">,
    detail: string,
    retryAfterMs: number | null = null
  ): { outcome: HostControlOutcomeCode; detail: string | null; retryAfterMs: number | null } {
    return { outcome: code, detail, retryAfterMs };
  }

  private requireClient(): NonNullable<ReturnType<HostCallRuntimeDeps["client"]>> {
    const client = this.deps.client();
    if (!client) throw new RefusalError("UNAVAILABLE");
    return client;
  }

  private async settle<T>(
    helpSessionId: string,
    work: (caller: OpenRun) => Promise<T>
  ): Promise<HostControlOutcome<T>> {
    const caller = this.caller(helpSessionId);
    if (caller === null) {
      return { ok: false, code: "NOT_ELIGIBLE", message: NOT_ELIGIBLE_MESSAGE };
    }
    try {
      return { ok: true, value: await work(caller) };
    } catch (error) {
      if (error instanceof RefusalError) {
        return { ok: false, code: error.code, message: error.message };
      }
      console.error("[HostCall] Unexpected failure:", error);
      return { ok: false, code: "UNAVAILABLE", message: ERROR_MESSAGE };
    }
  }
}

/** A host that can't run relayed calls, named with the version it said it runs. */
function unsupportedCallDetail(host: ObservedHost): string {
  const version = host.connection.status === "connected" ? host.connection.handshake.version : null;
  return version !== null
    ? `${host.name} runs Daintree ${version}, which can't run tools for other machines' assistants. It needs a newer Daintree.`
    : `${host.name} can't run tools for other machines' assistants. It may need a newer Daintree.`;
}
