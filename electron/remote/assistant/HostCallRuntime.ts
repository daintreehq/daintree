import { randomUUID } from "node:crypto";
import {
  globalAssistantMayRelay,
  isGlobalAssistantId,
} from "../../../shared/config/globalAssistant.js";
import { PROJECT_CHECK_DEFAULT_TIMEOUT_MS } from "../../../shared/types/projectCheck.js";
import { REPLY_WAIT_DEFAULT_SECONDS } from "../../../shared/types/replyWait.js";
import { LAUNCH_SETUP_WAIT_DEFAULT_MS } from "../../../shared/utils/launchInNewWorktree.js";
import { DEFAULT_TERMINAL_EXIT_WAIT_MS } from "../../../shared/types/terminalExitWait.js";
import { WORKTREE_RETIRE_OWNED_TOOL } from "../../services/mcp-server/sessionToolIds.js";
import {
  MCP_DISPATCH_TIMEOUT_MS,
  MCP_REMOTE_DISPATCH_TIMEOUT_MS,
  remoteHoldUntil,
} from "../../../shared/config/mcpConfirmWindow.js";
import {
  HOST_LIST_PROJECT_BYTES_MAX,
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
  type HostWatchArgs,
  type HostWatchResult,
} from "../../../shared/types/hostControl.js";
import {
  DEFAULT_THROWAWAY_TIME_LIMIT_MS,
  HOST_THROWAWAY_TOOL_SIGNATURES,
  HostThrowawayCallSchema,
  THROWAWAY_LAUNCH_TOOL,
  type HostThrowawayCall,
  type HostThrowawayFailure,
  type HostThrowawayRefusal,
} from "../../../shared/types/hostThrowaway.js";
import { HostSettingsRequests, type HostSettingsRequestDeps } from "./HostSettingsRequests.js";
import { HostWatches, type HostWatchListener } from "./HostWatches.js";
import { ThrowawaySession } from "./throwawaySession.js";
import {
  AGENT_DIRECTORY_BYTES_MAX,
  AGENT_DIRECTORY_ENTRIES_MAX,
  agentDirectoryAs,
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
import type {
  HostCallContext,
  HostControlRuntimeHandle,
} from "../../services/mcp-server/hostControlTools.js";
import type {
  HostInventoryHost,
  HostInventorySnapshot,
} from "../../services/globalAssistantInventory.js";
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
import type { ElapsedStamp } from "../link/elapsed.js";
import { sampleFreshness, type SummaryReceipt } from "../metrics/summaryReceipt.js";
import { projectHostAgentClis, projectHostBuild, projectHostLink } from "./hostObservations.js";
import {
  decodeProjectCursor,
  fitProjectPages,
  inventoryOf,
  pageProjects,
  type ProjectCursor,
  type ProjectPage,
} from "./hostProjectInventory.js";
import { MAX_LISTED_PROJECTS } from "../host/linkMethods.js";
import type { HostControlLinkClient } from "./HostControlLinkClient.js";
import type { AssistantEnsureRequest } from "../projects/HostSwitchService.js";
import {
  MAX_RELAY_ARGS_BYTES,
  MAX_RELAY_RUN_MS,
  RELAY_NOTICE_WINDOW_MS,
  type McpCallAnswer,
  type RelayApproveAnswer,
  type RelayApprovePayload,
  type RelayApproveTimedPayload,
  type RelayCallRequest,
  type RelayNotice,
  type RelayNoticeStatusAnswer,
  type RelayNoticeStatusPayload,
  type RelayNoticesPayload,
  type RelayRefusal,
  type ThrowawayCallAnswer,
  type ThrowawayCallPayload,
} from "./linkMethods.js";
import { canonicalArgsHash } from "../../services/mcp-server/sessionDedup.js";
import { OWNED_RESOURCE_TOOLS } from "../../services/mcp-server/sessionCallOwnership.js";
import { HOST_ALWAYS_ASKS_ACTION_IDS } from "../client/hostDispatchableActions.js";
import type { McpConfirmationDecision } from "../../../shared/types/ipc/mcpServer.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("main:HostCallRuntime");

/** A summary as `host.list` holds it until every read settles. */
interface Sampled {
  summary: HostMetricsSummary;
  receipt: SummaryReceipt | null;
  /** It came on a link that has since closed, however recent it is (#15736). */
  earlier?: boolean;
}

/** One host as this Shell observes it: its registry entry, its link, its last summary. */
export interface ObservedHost {
  hostId: HostId;
  name: string;
  connection: HostConnectionState;
  lastSeenAt: number | null;
  summary: HostMetricsSummary | null;
  /** When `summary` arrived and what its frame proved about its age; absent, only its timestamp says. */
  summaryReceipt?: SummaryReceipt | null;
  /**
   * Whether `summary` came on the link open now (#15736): false for one an
   * earlier link brought, kept across the reconnect; absent when unknown.
   */
  summaryFromCurrentLink?: boolean;
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
  /** When this machine took that sample, on its own clocks. */
  summaryReceipt?(summary: HostMetricsSummary): SummaryReceipt | null;
  relayCall(request: RelayCallRequest): Promise<McpCallAnswer>;
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
        Partial<Pick<HostControlLinkClient, "throwawayRelease" | "agents">>)
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
   * Whether a help session's assistant runs with Daintree's confirmations
   * skipped here (#15698): the person's own preference on this machine, read
   * at each ask, never anything a host says. Absent, or throwing, every
   * relayed call that would ask still asks.
   */
  confirmationsSkipped?(helpSessionId: string): boolean;
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
  /**
   * Hears hosts' links, the host list and summaries as they already arrive,
   * for `host.watch` (#14463); subscribed only while a watch is armed, or
   * while `host.list` waits for a host it dialed to send its first summary.
   * It never dials, holds or wakes a host. Absent, no watch is armed.
   */
  watchHosts?(listener: HostWatchListener): () => void;
  now?: () => number;
  /** This machine's clocks, for how old a sample is; `now` and the monotonic clock by default. */
  clock?: () => ElapsedStamp;
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
/** How long the global assistant's launch waits for any one host's projects (#14547). */
const INVENTORY_READ_MS = 1_500;
/** How long `host.list` waits for a host it dials to connect. */
const LIST_CONNECT_MS = 8_000;
/** How long `host.list` then waits for the new link's first summary (#15736). */
const FIRST_SAMPLE_MS = 1_500;
/** Hosts' directories kept by host and project filter, for a read that fails (#14455). */
const LAST_AGENTS_MAX = 64;

/** What the person at this Shell is asked about one of its relayed calls. */
export interface RelayApprovalQuestion {
  hostId: HostId;
  helpSessionId: string;
  actionId: string;
  args: Record<string, unknown>;
  subject?: string;
  lines: string[];
  /**
   * The latest the dialog may hold, on this machine's clock (#15699): inside
   * the host's own wait for the answer. Absent from a host too old to say.
   */
  holdUntil?: number;
}

/** A relayed call out to a host right now, and the run here that made it. */
interface CallInFlight {
  hostId: HostId;
  helpSessionId: string;
  /** Null for a throwaway call (#14446), which no host ever asks about. */
  projectId: string | null;
  tool: string;
  args: Record<string, unknown>;
  /** The tier it was sent at, which the host holds a resend of it to. */
  tier: "core" | "full";
  run: OpenRun;
  /**
   * A host asked about it, or ran it under the skip preference, once already:
   * an approval or a skip is for the call, not each ask or dispatch.
   */
  asked: boolean;
  /** It runs under the skip preference (#15698), so a resend that joins it later does too. */
  skipped: boolean;
  /**
   * Tells each `host.call` send still out for it that it ran under the skip
   * preference, for that send's audit record (#15698).
   */
  skipNotes: Set<() => void>;
  /** Sends of it still out, a resend's included; the record goes with the last. */
  sends: number;
}

/**
 * The confirm-gated actions a host may ask this Shell to approve (#13501):
 * the ones its own form of the action can preview with no view there.
 */
const RELAY_APPROVABLE: ReadonlySet<string> = new Set(["worktree.delete"]);

/** What a host's MCP server runs a call with: its arguments less the request's own keys. */
function relayedActionArgs(args: Record<string, unknown>): Record<string, unknown> {
  const { _meta: _ignored, requestKey: _requestKey, ...actionArgs } = args;
  return actionArgs;
}

/**
 * The action a call runs on the host, with exactly its arguments: its own
 * tool as sent, or the action an `*Owned` tool stands in for, rebuilt from
 * the id and the fields it forwards just as the host's server rebuilds it.
 */
function actionHashesOf(call: CallInFlight, actionId: string): string | null {
  const owned = Object.hasOwn(OWNED_RESOURCE_TOOLS, call.tool)
    ? OWNED_RESOURCE_TOOLS[call.tool]
    : undefined;
  // An owned tool's arguments are always rebuilt, even one that delegates to itself.
  if (owned === undefined) {
    return call.tool === actionId
      ? canonicalArgsHash(actionId, relayedActionArgs(call.args))
      : null;
  }
  if (owned.executor !== "renderer" || owned.delegateTo !== actionId || owned.reveals === true) {
    return null;
  }
  const id = call.args[owned.idArg];
  if (typeof id !== "string") return null;
  const delegateArgs: Record<string, unknown> = {};
  for (const key of owned.forwardArgs ?? []) {
    if (Object.hasOwn(call.args, key)) delegateArgs[key] = call.args[key];
  }
  delegateArgs[owned.delegateIdArg ?? owned.idArg] = id;
  return canonicalArgsHash(actionId, delegateArgs);
}

/**
 * Whether two sends under one callId are the same call, which the host runs
 * once for both: its ledger's own identity, the arguments whole.
 */
function sameCall(
  a: Pick<CallInFlight, "tool" | "projectId" | "tier" | "args">,
  b: Pick<CallInFlight, "tool" | "projectId" | "tier" | "args">
): boolean {
  return (
    a.tool === b.tool &&
    a.projectId === b.projectId &&
    a.tier === b.tier &&
    canonicalArgsHash(a.tool, a.args) === canonicalArgsHash(b.tool, b.args)
  );
}

/** Whether a host is running exactly this call: the same action with the same arguments. */
function runsAsCall(call: CallInFlight, actionId: string, args: unknown): boolean {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return false;
  const expected = actionHashesOf(call, actionId);
  return expected !== null && canonicalArgsHash(actionId, args) === expected;
}

/**
 * Whether a host's ask is about exactly the call this Shell made: the same
 * action with the same arguments, or the plain action an owned tool stands
 * in for, on the same id and nothing else.
 */
function asksAboutCall(call: CallInFlight, payload: RelayApprovePayload): boolean {
  if (!RELAY_APPROVABLE.has(payload.actionId)) return false;
  if (canonicalArgsHash(payload.actionId, payload.args) !== payload.argsHash) return false;
  return runsAsCall(call, payload.actionId, payload.args);
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

/**
 * What a throwaway answer shows about the session's runs on a host (#15878).
 * An `unknown` or `conflict` answer, a failed close or send, and a refusal of
 * a resend show nothing: what may still be going stays held until its time is up.
 */
function noteThrowawayAnswer(
  session: ThrowawaySession,
  hostId: HostId,
  call: HostThrowawayCall,
  callId: string,
  answer: ThrowawayCallAnswer,
  holdsLaunch: boolean
): void {
  if (call.tool === THROWAWAY_LAUNCH_TOOL) {
    if (answer.status === "done") session.observe(hostId, answer.result.run, callId);
    else if (answer.status === "failed" || (answer.status === "refused" && holdsLaunch)) {
      session.launchFailed(callId);
    }
    return;
  }
  if (answer.status === "done") session.observe(hostId, answer.result.run);
  else if (
    answer.status === "failed" &&
    (answer.reason === "not-found" || answer.reason === "exited")
  ) {
    session.runOver(hostId, call.args.runId);
  }
}

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
  "The global assistant can't do that in a project, so nothing was run. Beyond reads, it prompts, presses keys in and interrupts agents with the owned tools, and closes, restarts or deletes only what it launched there or the user handed it. Ask the user to do it.";
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

/** Room past what a tool asks for, for its own dispatch and its answer to come back. */
const RELAY_RUN_MARGIN_MS = 30_000;
/**
 * Least a relayed project call is given (#15699): the host's wait on a whole
 * confirmation here, from queueing to a full decision window once it is on
 * screen, then the room past it. The host's own waits end inside it.
 */
const RELAY_MIN_RUN_MS = MCP_REMOTE_DISPATCH_TIMEOUT_MS + RELAY_RUN_MARGIN_MS;
/** Least a throwaway call is given: it never asks anyone, so a dispatch and the trip. */
const THROWAWAY_MIN_RUN_MS = 90_000;
/** Runs a create, a setup wait and a launch in sequence on its host (#15738). */
const LAUNCH_IN_NEW_WORKTREE_TOOL = "agent.launchInNewWorktree";
/** How much longer than the host's own deadline the Shell waits for the answer. */
const RELAY_ANSWER_GRACE_MS = 15_000;

/**
 * How long a relayed call may run on its host: above the longest wait the
 * call's own arguments ask for, so a long check or a held reply isn't cut off
 * and reported as lost.
 */
export function relayRunMs(
  tool: string,
  args: Record<string, unknown>,
  minMs: number = RELAY_MIN_RUN_MS
): number {
  let wanted = 0;
  const timeoutMs = args.timeoutMs;
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    wanted = timeoutMs;
  } else if (tool === "project.runCheck") {
    wanted = PROJECT_CHECK_DEFAULT_TIMEOUT_MS;
  }
  const replyMs =
    args.waitForReply === true
      ? (typeof args.waitSeconds === "number" && Number.isFinite(args.waitSeconds)
          ? args.waitSeconds
          : REPLY_WAIT_DEFAULT_SECONDS) * 1000
      : 0;
  if (tool === LAUNCH_IN_NEW_WORKTREE_TOOL) {
    // Its steps run one after another: the create's dispatch, the setup wait,
    // the launch's dispatch, then the reply wait.
    const setupMs =
      typeof args.setupTimeoutMs === "number" && Number.isFinite(args.setupTimeoutMs)
        ? Math.max(0, args.setupTimeoutMs)
        : LAUNCH_SETUP_WAIT_DEFAULT_MS;
    wanted = 2 * MCP_DISPATCH_TIMEOUT_MS + setupMs + replyMs;
  } else {
    // A retirement waits for its panes' processes and then on the delete's
    // confirmation, one after the other (#15737), so it is owed both.
    if (tool === WORKTREE_RETIRE_OWNED_TOOL) {
      wanted =
        (wanted > 0 ? wanted : DEFAULT_TERMINAL_EXIT_WAIT_MS) + MCP_REMOTE_DISPATCH_TIMEOUT_MS;
    }
    wanted = Math.max(wanted, replyMs);
  }
  return Math.min(MAX_RELAY_RUN_MS, Math.max(minMs, wanted + RELAY_RUN_MARGIN_MS));
}

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

const REFUSAL_MESSAGES = {
  NOT_ELIGIBLE: NOT_ELIGIBLE_MESSAGE,
  UNAVAILABLE: ERROR_MESSAGE,
  INVALID_ARGS:
    "That projectCursor isn't one host.list gave, or names another host or query than the call does.",
} as const;

class RefusalError extends Error {
  constructor(readonly code: keyof typeof REFUSAL_MESSAGES) {
    super(REFUSAL_MESSAGES[code]);
  }
}

/**
 * Cuts the hosts' directories so the whole `host.list` answer, not each
 * directory alone, stays within the agent budget the MCP result is capped to.
 * The room left by everything else is shared evenly, a directory that needs
 * less giving the rest to the others, and what each loses is counted in its
 * own `omitted`.
 */
function fitToResponse(hosts: HostListEntry[]): HostListEntry[] {
  const encoder = new TextEncoder();
  const bytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;
  const envelopes = hosts.map((host) => (host.agents ? bytes({ ...host.agents, entries: [] }) : 0));
  // Each entry with a separator: a byte more than the entries take, never less.
  const needs = hosts.map((host) =>
    (host.agents?.entries ?? []).reduce((sum, entry) => sum + bytes(entry) + 1, 0)
  );
  const empty = hosts.map((host) =>
    host.agents ? { ...host, agents: { ...host.agents, entries: [] } } : host
  );
  const fitting = hosts.flatMap((host, index) => (host.agents ? [index] : []));
  let spare = AGENT_DIRECTORY_BYTES_MAX - bytes({ hosts: empty });
  if (fitting.reduce((sum, index) => sum + needs[index]!, 0) <= spare) return hosts;
  const given = new Map<number, number>();
  const byNeed = [...fitting].sort((a, b) => needs[a]! - needs[b]!);
  byNeed.forEach((index, position) => {
    const share = Math.max(0, Math.floor(spare / (byNeed.length - position)));
    const give = Math.min(needs[index]!, share);
    given.set(index, give);
    spare -= give;
  });
  return hosts.map((host, index) =>
    host.agents
      ? {
          ...host,
          agents: fitAgentDirectory(host.agents, envelopes[index]! + (given.get(index) ?? 0)),
        }
      : host
  );
}

/** A host's directory held to the entry cap its own reads keep, whatever it sent. */
function capEntries(directory: AgentDirectory): AgentDirectory {
  const over = directory.entries.length - AGENT_DIRECTORY_ENTRIES_MAX;
  return over <= 0
    ? directory
    : {
        ...directory,
        omitted: directory.omitted + over,
        entries: directory.entries.slice(0, AGENT_DIRECTORY_ENTRIES_MAX),
      };
}

function agentsKey(hostId: HostId, projectId: string | undefined): string {
  return `${hostId}\u0000${projectId ?? ""}`;
}

/**
 * What the project pages may take: their own budget, or less when the rest of
 * the answer (every host's own fields, inventory and agents) leaves less under its cap.
 */
function projectBudget(
  entries: readonly HostListEntry[],
  paged: ReadonlyMap<HostListEntry, ProjectPage>
): number {
  const rest = entries.map((entry) => {
    // Every host's directory is cut to fit after the pages (fitToResponse),
    // so each counts here as its empty envelope.
    const fields = entry.agents ? { ...entry, agents: { ...entry.agents, entries: [] } } : entry;
    const page = paged.get(entry);
    return page
      ? { ...fields, projects: [], projectInventory: inventoryOf({ ...page, projects: [] }) }
      : fields;
  });
  const restBytes = new TextEncoder().encode(JSON.stringify({ hosts: rest })).length;
  // A cut page's cursor names a different offset: a few more bytes each.
  const slack = 64 * paged.size;
  return Math.max(
    0,
    Math.min(HOST_LIST_PROJECT_BYTES_MAX, AGENT_DIRECTORY_BYTES_MAX - restBytes - slack)
  );
}

interface ProjectScope {
  /** The one host listed, from the call or its cursor; null lists every host. */
  hostId: string | null;
  pageOptions(
    hostId: string,
    capped: boolean
  ): { hostId: string; query: string | null; cursor: ProjectCursor | null; capped: boolean };
}

/**
 * The host, query and page a `host.list` call asks for. A cursor keeps the
 * host and query it was cut for; a call naming others alongside it is refused
 * rather than read one way or the other.
 */
function projectScope(args: HostListArgs): ProjectScope {
  const cursor = args.projectCursor === undefined ? null : decodeProjectCursor(args.projectCursor);
  if (args.projectCursor !== undefined) {
    if (
      cursor === null ||
      (args.hostId !== undefined && args.hostId !== cursor.hostId) ||
      (args.projectQuery !== undefined && args.projectQuery !== cursor.query)
    ) {
      throw new RefusalError("INVALID_ARGS");
    }
  }
  const query = cursor ? cursor.query : (args.projectQuery ?? null);
  return {
    hostId: cursor ? cursor.hostId : (args.hostId ?? null),
    pageOptions: (hostId, capped) => ({
      hostId,
      query,
      cursor: cursor?.hostId === hostId ? cursor : null,
      capped,
    }),
  };
}

/** Settles with `work`, or with `fallback` once `ms` pass; the timer never outlives it. */
function withinMs<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
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
  private readonly clock: () => ElapsedStamp;
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
  /** Each help session's throwaway runs on hosts, to hold their links and release them when it ends. */
  private readonly throwawaySessions = new Map<string, ThrowawaySession>();
  private disposed = false;
  /** `host.list`'s waits for a dialed host's first summary, each ended at once by dispose. */
  private readonly sampleWaits = new Set<() => void>();
  private readonly settingsRequests: HostSettingsRequests;
  private readonly hostWatches: HostWatches;
  /** Each host's last directory read, by project filter, oldest first. */
  private readonly lastAgents = new Map<string, AgentDirectory>();
  /** Bumped each time a host's directories are forgotten, so a read begun before isn't kept. */
  private readonly agentsEpochs = new Map<HostId, number>();

  constructor(private readonly deps: HostCallRuntimeDeps) {
    this.now = deps.now ?? Date.now;
    this.clock = deps.clock ?? (() => ({ wall: this.now(), mono: performance.now() }));
    this.newId = deps.newId ?? randomUUID;
    this.settingsRequests = new HostSettingsRequests({
      client: () => deps.settingsClient?.() ?? null,
      hostName: (hostId) => deps.hosts().find((host) => host.hostId === hostId)?.name ?? null,
      controlOn: (hostId) => this.controlOn(hostId),
      ...(deps.askSettingsApproval ? { askApproval: deps.askSettingsApproval } : {}),
      now: () => this.now(),
      newId: () => this.newId(),
    });
    this.hostWatches = new HostWatches({
      hosts: () => deps.hosts(),
      controlOn: (hostId) => this.controlOn(hostId),
      stillRunning: (run) => this.stillRunning(run),
      ...(deps.watchHosts ? { observe: deps.watchHosts } : {}),
      ...(deps.queueNotice ? { queueNotice: deps.queueNotice } : {}),
      now: () => this.now(),
      clock: () => this.clock(),
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
   * Whether a throwaway run one of this Shell's assistants launched may still
   * be going on `hostId` (#15878). The host ends a Shell's runs once its link
   * says goodbye, so the link stays until each run is seen over, its session
   * ends, or its time limit passes. Holding the link never keeps the host awake.
   */
  holdsThrowawayRuns(hostId: HostId): boolean {
    for (const session of this.throwawaySessions.values()) {
      if (session.holds(hostId)) return true;
    }
    return false;
  }

  /**
   * Whether a host's dispatch into this Shell's view of its project is one
   * of this Shell's own assistants' calls to that host, running with that
   * assistant's Daintree confirmations skipped here (#15698). True only for
   * the call still out from the run that made it, in that view's project,
   * about exactly that call's action and arguments, while the person's
   * control switch for the host is on. The skip is this Shell's own
   * preference, read now: nothing the host sends turns it on. The host is
   * the connection's, never the payload's.
   */
  skipsRelayedDispatch(
    hostId: HostId,
    dispatch: {
      callId: string;
      helpSessionId: string;
      projectId: string;
      actionId: string;
      args: unknown;
    }
  ): boolean {
    const call = this.callsInFlight.get(dispatch.callId);
    if (
      this.disposed ||
      call === undefined ||
      call.asked ||
      call.hostId !== hostId ||
      call.helpSessionId !== dispatch.helpSessionId ||
      call.projectId !== dispatch.projectId ||
      !runsAsCall(call, dispatch.actionId, dispatch.args) ||
      !this.stillRunning(call.run) ||
      !this.controlOn(hostId) ||
      !this.skipsConfirmations(call, dispatch.actionId)
    ) {
      return false;
    }
    this.grantSkip(call);
    return true;
  }

  /** Spends a call's one ask on the skip, and tells every send of it still out. */
  private grantSkip(call: CallInFlight): void {
    call.asked = true;
    call.skipped = true;
    for (const note of call.skipNotes) note();
  }

  /**
   * Whether the assistant that made a call runs with Daintree's
   * confirmations skipped, for an action that may skip at all: one that would
   * move this window always asks. A failed read keeps the dialog.
   */
  private skipsConfirmations(call: CallInFlight, actionId: string): boolean {
    if (HOST_ALWAYS_ASKS_ACTION_IDS.has(actionId)) return false;
    try {
      return this.deps.confirmationsSkipped?.(call.helpSessionId) === true;
    } catch (error) {
      logger.warn("Couldn't read the assistant's confirmations preference", { error });
      return false;
    }
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
   * assistant's own window, unless that assistant runs with Daintree's
   * confirmations skipped here (#15698), when nobody is asked and the answer
   * says so. Anything else is `refused`, which approves nothing. The host is
   * the connection's, never the payload's.
   */
  async receiveApproval(
    hostId: HostId,
    payload: RelayApprovePayload | RelayApproveTimedPayload
  ): Promise<RelayApproveAnswer> {
    // Before anything awaits: the host's wait started when it asked.
    const receivedAt = this.now();
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
    // The person's own "Never ask" covers their assistant's call on a host as
    // it does one here (#15698): nobody is asked, and the host is told so.
    if (this.skipsConfirmations(call, payload.actionId)) {
      this.grantSkip(call);
      return answer("skip-preference");
    }
    let decision: McpConfirmationDecision | null;
    try {
      decision = await ask({
        hostId,
        helpSessionId: payload.helpSessionId,
        actionId: payload.actionId,
        args: payload.args,
        ...(payload.subject !== undefined ? { subject: payload.subject } : {}),
        lines: payload.lines,
        ...("holdBudgetMs" in payload
          ? { holdUntil: remoteHoldUntil(receivedAt, payload.holdBudgetMs) }
          : {}),
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
        ...(notice.lastTransitionAt !== undefined
          ? { lastTransitionAt: notice.lastTransitionAt }
          : {}),
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
    this.hostWatches.endSession(helpSessionId);
    const session = this.throwawaySessions.get(helpSessionId);
    this.throwawaySessions.delete(helpSessionId);
    const client = this.deps.client();
    if (session === undefined || !client?.throwawayRelease) return;
    for (const hostId of session.hosts) {
      void client.throwawayRelease(hostId, { helpSessionId }).catch((error: unknown) => {
        logger.debug("Couldn't release a host's throwaway runs", { hostId, error });
      });
    }
  }

  /**
   * A help session relaunched onto a new PTY: the same assistant, which keeps
   * what it made, but its earlier run's watches don't pass to the new one.
   */
  retireWatches(helpSessionId: string): void {
    this.hostWatches.endSession(helpSessionId);
  }

  /** Forgets every call and notice; calls on hosts are left as they are. */
  dispose(): void {
    this.disposed = true;
    for (const end of [...this.sampleWaits]) end();
    this.hostWatches.dispose();
    this.throwawaySessions.clear();
    this.callsOut.clear();
    this.callsInFlight.clear();
    this.noticePins.clear();
    this.settledPins.clear();
    this.seenNotices.clear();
    this.prompted.clear();
    this.lastAgents.clear();
    this.agentsEpochs.clear();
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
    context: HostCallContext
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
      if (isGlobalAssistantId(caller.projectId) && !globalAssistantMayRelay(args.tool)) {
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
      const payload: RelayCallRequest = {
        helpSessionId,
        projectId,
        tier: context.tier,
        callId,
        resend,
        tool: args.tool,
        args: toolArgs,
        runMs,
        // From the runtime's own lane, so no argument the model passes can set or clear it.
        ...(isGlobalAssistantId(caller.projectId) ? { global: true as const } : {}),
      };
      const noted = resend
        ? NOTHING_NOTED
        : this.noteCall(callId, args.hostId, caller, args.tool, toolArgs);
      const sendDone = this.trackSend(
        callId,
        {
          hostId: args.hostId,
          helpSessionId,
          projectId,
          tool: args.tool,
          args: toolArgs,
          tier: context.tier,
          run: caller,
        },
        context.noteSkipPreference
      );
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
  private trackSend(
    callId: string,
    record: Omit<CallInFlight, "asked" | "sends" | "skipped" | "skipNotes">,
    noteSkip?: () => void
  ): () => void {
    const { hostId, helpSessionId } = record;
    this.callsOut.set(hostId, (this.callsOut.get(hostId) ?? 0) + 1);
    const sharing = this.callsInFlight.get(callId);
    const inFlight: CallInFlight =
      sharing !== undefined && sharing.hostId === hostId && sharing.helpSessionId === helpSessionId
        ? sharing
        : { ...record, asked: false, sends: 0, skipped: false, skipNotes: new Set() };
    inFlight.sends += 1;
    if (inFlight !== sharing) this.callsInFlight.set(callId, inFlight);
    // Each send's own, so a send that settled, having written its record, is
    // told nothing; and only a send of the same call, since the host refuses a
    // different one under that callId as a conflict, which ran nothing.
    const note =
      noteSkip !== undefined && (inFlight === sharing ? sameCall(inFlight, record) : true)
        ? () => noteSkip()
        : undefined;
    if (note !== undefined) {
      if (inFlight.skipped) note();
      else inFlight.skipNotes.add(note);
    }
    return () => {
      if (note !== undefined) inFlight.skipNotes.delete(note);
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
    const runMs = relayRunMs(args.tool, parsed.data.args, THROWAWAY_MIN_RUN_MS);
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
      tier: context.tier,
      run: caller,
    });
    // Taken now: an answer that lands after the session ended changes a record nothing keeps.
    const session = local ? null : this.throwawaySession(helpSessionId);
    let holdsLaunch = false;
    let answer: ThrowawayCallAnswer;
    try {
      if (local) {
        answer = local.throwawayCall
          ? await local.throwawayCall(payload)
          : { status: "refused", reason: "throwaway-off" };
      } else {
        // Before it is sent: a launch whose answer is lost may still have launched,
        // and its run may last its whole limit from when the host got to it.
        if (parsed.data.tool === THROWAWAY_LAUNCH_TOOL) {
          const limitMs = parsed.data.args.timeLimitMs ?? DEFAULT_THROWAWAY_TIME_LIMIT_MS;
          holdsLaunch = session!.launching(
            args.hostId,
            callId,
            limitMs + runMs + RELAY_ANSWER_GRACE_MS
          );
        }
        answer = await this.requireClient().throwawayCall(
          args.hostId,
          payload,
          runMs + RELAY_ANSWER_GRACE_MS
        );
      }
    } catch (error) {
      const noted: NotedCall = holdsLaunch
        ? { ran: () => {}, notRun: () => session!.launchFailed(callId) }
        : NOTHING_NOTED;
      return this.sendFailure(error, host, callId, resend, noted);
    } finally {
      sendDone();
    }
    if (session)
      noteThrowawayAnswer(session, args.hostId, parsed.data, callId, answer, holdsLaunch);
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

  private throwawaySession(helpSessionId: string): ThrowawaySession {
    let session = this.throwawaySessions.get(helpSessionId);
    if (session === undefined) {
      session = new ThrowawaySession(() => this.clock().mono);
      this.throwawaySessions.set(helpSessionId, session);
    }
    return session;
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
            logger.warn("A step of bringing a project to a host was refused", {
              code: codeOf(error),
            });
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

  /** Arms, cancels or lists the calling run's own host watches (#14463). */
  watch(helpSessionId: string, args: HostWatchArgs): Promise<HostControlOutcome<HostWatchResult>> {
    return this.settle(helpSessionId, async (caller) => this.hostWatches.run(caller, args));
  }

  list(
    helpSessionId: string,
    args: HostListArgs = {}
  ): Promise<HostControlOutcome<HostListResult>> {
    const agentsOf = args.includeAgents === true ? { projectId: args.projectId } : null;
    return this.settle(helpSessionId, async (caller) => {
      const scope = projectScope(args);
      const wanted = (hostId: string) => scope.hostId === null || scope.hostId === hostId;
      const local = wanted(LOCAL_HOST_ID) ? this.deps.local : undefined;
      // Each load is projected after every read below settles, against one clock
      // reading: a slow project read must not leave a sample looking fresher
      // than it is when the answer goes out.
      const sampled = new Map<HostListEntry, Sampled>();
      // Pages are cut to fit once every host has answered, so one host's long
      // names can't take the whole answer's room.
      const paged = new Map<HostListEntry, ProjectPage>();
      const here = local ? this.localEntry(local, caller, agentsOf, sampled, scope, paged) : null;
      const observed = this.deps.hosts();
      this.forgetUnreadableHosts(observed);
      // Cached reads are pruned against every host, not only the one listed.
      const seenHosts = observed.filter((seen) => wanted(seen.hostId));
      const hosts = await Promise.all(
        seenHosts.map(async (seen): Promise<HostListEntry> => {
          const { host, dialed } = await this.dialed(seen);
          const connected = host.connection.status === "connected";
          const control = this.deps.controlEnabled?.(host.hostId) === true;
          const [page, agents, sample] = await Promise.all([
            connected && control ? this.hostProjects(host.hostId, scope) : null,
            agentsOf ? this.hostAgents(host, control, agentsOf) : null,
            dialed ? this.firstSample(host) : host,
          ]);
          const summary = sample.summary;
          // The history outlives a reconnect: what an earlier link brought is
          // not what the host says now, however recently it came.
          const earlier = connected && sample.summaryFromCurrentLink === false;
          const entry: HostListEntry = {
            hostId: host.hostId,
            name: host.name,
            connection: observedConnection(host.connection),
            link: projectHostLink(host.connection, host.disconnectedByPerson === true),
            build: projectHostBuild(host.connection, host.lastHandshake ?? null),
            agentClis: projectHostAgentClis(null, false, false),
            rttMs: host.connection.status === "connected" ? host.connection.rttMs : null,
            lastSeenAt: host.lastSeenAt,
            load: null,
            // A tally from before the link dropped is history, not what is running now.
            agentsObserved:
              connected && !earlier && summary?.agentsObserved
                ? { ...summary.agentsObserved }
                : null,
            projects: null,
            projectInventory: null,
            control,
            ...(agents ? { agents } : {}),
          };
          if (summary) {
            sampled.set(entry, { summary, receipt: sample.summaryReceipt ?? null, earlier });
          }
          if (page) paged.set(entry, page);
          return entry;
        })
      );
      const settled = here ? await here : null;
      const entries = settled ? [settled, ...hosts] : hosts;
      const now = this.clock();
      for (const entry of entries) {
        const held = sampled.get(entry);
        if (!held) continue;
        const live = entry.link.status === "connected" || entry.link.status === "local";
        const measured = sampleFreshness(held.summary, held.receipt, now);
        const freshness = held.earlier
          ? { ...measured, stale: true, staleReason: "earlier-link" as const }
          : measured;
        entry.load = projectHostLoad(held.summary, freshness);
        entry.agentClis = projectHostAgentClis(held.summary, live, !freshness.stale);
      }
      fitProjectPages([...paged.values()], projectBudget(entries, paged));
      for (const [entry, page] of paged) {
        entry.projects = page.projects;
        entry.projectInventory = inventoryOf(page);
      }
      return { hosts: agentsOf ? fitToResponse(entries) : entries };
    });
  }

  /**
   * The snapshot the global assistant starts with (#14547): every host as this
   * Shell observes it, this machine first, and the projects of each it can see
   * now. No caller, so it is no answer to one: it never dials a host, reads no
   * agents or load, and arms nothing. A host whose projects don't come back in
   * time is still named, with its projects unknown.
   */
  async inventory(): Promise<HostInventorySnapshot> {
    const toListed = (projects: readonly HostProjectSummary[]) =>
      projects.map((project) => ({
        projectId: project.id,
        name: project.name,
        frontendAttached: project.frontendAttached ?? null,
      }));
    const local = this.deps.local;
    const localHost = local
      ? withinMs(
          Promise.resolve()
            .then(() => local.projects())
            .catch(() => null),
          INVENTORY_READ_MS,
          null
        ).then((projects): HostInventoryHost => ({
          hostId: LOCAL_HOST_ID,
          name: local.name(),
          connection: "connected",
          local: true,
          control: true,
          projects: projects ? toListed(projects) : null,
          projectTotal: projects ? projects.length : null,
        }))
      : null;
    const read = this.deps.listHostProjects;
    const lists = new Map(
      await Promise.all(
        this.deps.hosts().map(async (seen) => {
          const readable =
            seen.connection.status === "connected" &&
            this.deps.controlEnabled?.(seen.hostId) === true &&
            read !== undefined;
          const projects = readable
            ? await withinMs(
                read(seen.hostId).catch(() => null),
                INVENTORY_READ_MS,
                null
              )
            : null;
          return [seen.hostId, projects] as const;
        })
      )
    );
    const here = localHost ? await localHost : null;
    // Observed again once every read is in: a host removed meanwhile is gone,
    // and one that dropped or was switched off meanwhile claims no projects.
    const remote = this.deps.hosts().map((host): HostInventoryHost => {
      const control = this.deps.controlEnabled?.(host.hostId) === true;
      const listed = host.connection.status === "connected" && control;
      const projects = listed ? (lists.get(host.hostId) ?? null) : null;
      return {
        hostId: host.hostId,
        name: host.name,
        connection: observedConnection(host.connection),
        local: false,
        control,
        projects: projects ? toListed(projects) : null,
        // A host sends at most this many and says nothing of the rest.
        projectTotal: projects && projects.length < MAX_LISTED_PROJECTS ? projects.length : null,
      };
    });
    const hosts = here ? [here, ...remote] : remote;
    return { takenAt: this.now(), hosts };
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
    sampled: Map<HostListEntry, Sampled>,
    scope: ProjectScope,
    paged: Map<HostListEntry, ProjectPage>
  ): Promise<HostListEntry> {
    const summary = local.latestSummary?.() ?? null;
    const receipt = summary ? (local.summaryReceipt?.(summary) ?? null) : null;
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
      agentClis: projectHostAgentClis(null, true, false),
      rttMs: null,
      lastSeenAt: null,
      load: null,
      agentsObserved: null,
      projects: null,
      projectInventory: null,
      control: true,
      ...(agentsOf ? { agents: await this.localAgents(local, agentsOf) } : {}),
    };
    if (summary) sampled.set(entry, { summary, receipt });
    if (projects !== null) {
      // The caller's own project is left out before paging, so its cursor's
      // revision is of the list this caller sees.
      const reachable = projects.filter((project) => project.id !== caller.projectId);
      paged.set(entry, pageProjects(reachable, scope.pageOptions(LOCAL_HOST_ID, false)));
    }
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
   * A host's workers and assistants as the host itself reads them (#14455),
   * under both its control switch here and its own consent, addressed by this
   * Shell's id for it. A read that fails answers with the last one of the same
   * filter, marked stale and dated when it was seen; one that is refused, or
   * that control here no longer allows, answers with nothing and forgets it.
   */
  private async hostAgents(
    host: ObservedHost,
    control: boolean,
    options: { projectId?: string }
  ): Promise<AgentDirectory> {
    if (!control) {
      this.forgetAgents(host.hostId);
      return unreadAgentDirectory("unreachable");
    }
    const key = agentsKey(host.hostId, options.projectId);
    const client = this.deps.client();
    const read = client?.agents;
    if (!client || !read || host.connection.status !== "connected") return this.lastAgentsOf(key);
    const payload = options.projectId === undefined ? {} : { projectId: options.projectId };
    const epoch = this.agentsEpochs.get(host.hostId) ?? 0;
    // Known from the start, so removing the host while this read runs is a forget it sees.
    this.agentsEpochs.set(host.hostId, epoch);
    const answer = await withinMs(
      Promise.resolve()
        .then(() => read.call(client, host.hostId, payload, PROJECTS_READ_MS))
        .catch((error: unknown) => (codeOf(error) === "UNSUPPORTED" ? "unsupported" : null)),
      PROJECTS_READ_MS,
      null
    );
    // Control may have gone off while it was read: nothing read now or before is shown or kept.
    if (this.deps.controlEnabled?.(host.hostId) !== true) {
      this.forgetAgents(host.hostId);
      return unreadAgentDirectory("unreachable");
    }
    // Forgotten while it was read, as by control going off and on again: it isn't kept.
    const current = (this.agentsEpochs.get(host.hostId) ?? 0) === epoch;
    if (answer === null)
      return current ? this.lastAgentsOf(key) : unreadAgentDirectory("unreachable");
    if (answer === "unsupported" || answer.status === "refused") {
      this.forgetAgents(host.hostId);
      return unreadAgentDirectory(answer === "unsupported" ? "unsupported" : "unreachable");
    }
    const directory = agentDirectoryAs(
      host.hostId,
      fitAgentDirectory(capEntries(answer.directory))
    );
    if (directory.coverage === "unsupported") {
      this.forgetAgents(host.hostId);
      return directory;
    }
    // The host couldn't read itself and knew nothing: what was seen here before still holds.
    if (directory.coverage === "unreachable") {
      return current ? this.lastAgentsOf(key) : directory;
    }
    if (!current) return directory;
    this.lastAgents.delete(key);
    this.lastAgents.set(key, directory);
    if (this.lastAgents.size > LAST_AGENTS_MAX) {
      this.lastAgents.delete(this.lastAgents.keys().next().value as string);
    }
    return directory;
  }

  private lastAgentsOf(key: string): AgentDirectory {
    const previous = this.lastAgents.get(key);
    return previous
      ? { ...previous, coverage: "stale", complete: false }
      : unreadAgentDirectory("unreachable");
  }

  private forgetAgents(hostId: HostId): void {
    this.agentsEpochs.set(hostId, (this.agentsEpochs.get(hostId) ?? 0) + 1);
    const prefix = agentsKey(hostId, undefined);
    for (const key of [...this.lastAgents.keys()]) {
      if (key.startsWith(prefix)) this.lastAgents.delete(key);
    }
  }

  /**
   * A host the person removed, or whose control is off here, takes what was
   * read of it along, on any listing: turning control back on reads it afresh.
   */
  private forgetUnreadableHosts(observed: readonly ObservedHost[]): void {
    const readable = new Set(
      observed
        .filter((host) => this.deps.controlEnabled?.(host.hostId) === true)
        .map((host) => agentsKey(host.hostId, undefined))
    );
    const gone = [...this.agentsEpochs.keys()].filter(
      (hostId) => !observed.some((host) => host.hostId === hostId)
    );
    for (const hostId of [...observed.map((host) => host.hostId), ...gone]) {
      if (!readable.has(agentsKey(hostId, undefined))) this.forgetAgents(hostId);
    }
    for (const key of [...this.lastAgents.keys()]) {
      if (!readable.has(key.slice(0, key.indexOf("\u0000") + 1))) this.lastAgents.delete(key);
    }
  }

  /**
   * A host with control on that this Shell holds no link to, dialed first:
   * the Shell lets an unused link go after a few minutes, and `host.call`
   * dials it again on demand, so to the assistant it is a host it can reach,
   * not one that is down. One the person disconnected stays as it is. Observed
   * again afterwards, whatever came of it, and said whether it was dialed.
   */
  private async dialed(host: ObservedHost): Promise<{ host: ObservedHost; dialed: boolean }> {
    const connect = this.deps.connect;
    const status = host.connection.status;
    if (!connect || (status !== "disconnected" && status !== "connecting")) {
      return { host, dialed: false };
    }
    if (this.deps.controlEnabled?.(host.hostId) !== true) return { host, dialed: false };
    // A dial that throws before it is under way fails this host's entry, never the listing.
    const dial = Promise.resolve()
      .then(() => connect(host.hostId, LIST_CONNECT_MS))
      .catch(() => undefined);
    await withinMs(dial, LIST_CONNECT_MS, undefined);
    const observed = this.deps.hosts().find((candidate) => candidate.hostId === host.hostId);
    return { host: observed ?? host, dialed: true };
  }

  /**
   * A host just dialed whose summary an earlier link brought, observed again
   * once the new link's first one arrives (#15736): the host sends what it
   * holds as a link opens, but the dial is done before that lands. Waits at
   * most {@link FIRST_SAMPLE_MS}, and no longer once the host drops, goes or
   * has its control switched off; the observation returned is this one or a
   * later one whose summary came on the link open now.
   */
  private firstSample(host: ObservedHost): Promise<ObservedHost> {
    const watch = this.deps.watchHosts;
    if (
      !watch ||
      this.disposed ||
      host.connection.status !== "connected" ||
      host.summaryFromCurrentLink !== false
    ) {
      return Promise.resolve(host);
    }
    return new Promise((resolve) => {
      let off: (() => void) | null = null;
      let done = false;
      const finish = (observed: ObservedHost) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.sampleWaits.delete(end);
        off?.();
        resolve(observed);
      };
      const end = () => finish(host);
      const check = () => {
        const now = this.deps.hosts().find((candidate) => candidate.hostId === host.hostId);
        if (
          !now ||
          now.connection.status !== "connected" ||
          this.deps.controlEnabled?.(host.hostId) !== true
        ) {
          finish(host);
        } else if (now.summaryFromCurrentLink === true) {
          finish(now);
        }
      };
      const timer = setTimeout(end, FIRST_SAMPLE_MS);
      timer.unref?.();
      this.sampleWaits.add(end);
      try {
        off = watch({
          changed: check,
          summary: (hostId) => {
            if (hostId === host.hostId) check();
          },
        });
      } catch {
        finish(host);
        return;
      }
      // Told synchronously as it subscribed: finished before there was anything to let go.
      if (done) off();
      else check();
    });
  }

  /** A page of a connected host's projects, or null when it didn't say in time. */
  private async hostProjects(hostId: HostId, scope: ProjectScope): Promise<ProjectPage | null> {
    const read = this.deps.listHostProjects;
    if (!read) return null;
    const projects = await withinMs(
      read(hostId).catch(() => null),
      PROJECTS_READ_MS,
      null
    );
    if (projects === null) return null;
    // A host sends at most this many and says nothing of the rest.
    const capped = projects.length >= MAX_LISTED_PROJECTS;
    return pageProjects(projects, scope.pageOptions(hostId, capped));
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
