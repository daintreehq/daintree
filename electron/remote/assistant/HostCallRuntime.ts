import { randomUUID } from "node:crypto";
import { PROJECT_CHECK_DEFAULT_TIMEOUT_MS } from "../../../shared/types/projectCheck.js";
import { REPLY_WAIT_DEFAULT_SECONDS } from "../../../shared/types/replyWait.js";
import {
  HOST_LIST_PROJECTS_MAX,
  type HostCallArgs,
  type HostCallResult,
  type HostControlOutcome,
  type HostControlOutcomeCode,
  type HostListEntry,
  type HostListResult,
} from "../../../shared/types/hostControl.js";
import type { HostProjectSummary } from "../../../shared/types/ipc/remoteHosts.js";
import type {
  HostConnectionState,
  HostId,
  HostMetricsSummary,
} from "../../../shared/types/remoteHosts.js";
import type { HostControlRuntimeHandle } from "../../services/mcp-server/hostControlTools.js";
import {
  NOTIFY_KEY_TOOLS,
  NOTIFY_PROMPT_TOOLS,
  TERMINAL_NOTIFY_WHEN_IDLE_TOOL,
  type FiredNotice,
  type LaneWake,
  type LaneWakeCheck,
} from "../../services/mcp-server/terminalNotify.js";
import { sanitizeNotifyNote } from "../../../shared/types/terminalNotify.js";
import type { HostControlLinkClient } from "./HostControlLinkClient.js";
import {
  MAX_RELAY_ARGS_BYTES,
  MAX_RELAY_RUN_MS,
  type McpCallAnswer,
  type McpCallPayload,
  type RelayApproveAnswer,
  type RelayApprovePayload,
  type RelayNotice,
  type RelayNoticesPayload,
  type RelayRefusal,
} from "./linkMethods.js";
import { canonicalArgsHash } from "../../services/mcp-server/sessionDedup.js";
import type { McpConfirmationDecision } from "../../../shared/types/ipc/mcpServer.js";

/** One host as this Shell observes it: its registry entry, its link, its last summary. */
export interface ObservedHost {
  hostId: HostId;
  name: string;
  connection: HostConnectionState;
  lastSeenAt: number | null;
  summary: HostMetricsSummary | null;
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
  client(): Pick<HostControlLinkClient, "relayCall"> | null;
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
  now?: () => number;
  newId?: () => string;
}

const ERROR_MESSAGE = "Hosts can't be reached right now.";
const NOT_ELIGIBLE_MESSAGE =
  "Only a Daintree Assistant running on this machine can reach its hosts.";

/** Calls whose notices this Shell still takes, the oldest forgotten first (#13500). */
const MAX_NOTICE_PINS = 256;
/** How long a call's notices are taken: as long as its host holds what the call made. */
const NOTICE_PIN_TTL_MS = 24 * 60 * 60_000;
/** How long a call's notices keep its host's link open when nothing else does. */
const NOTICE_LINK_HOLD_MS = 2 * 60 * 60_000;
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
  projectId: string;
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
}

function armsNotice(tool: string, args: Record<string, unknown>): boolean {
  return tool === TERMINAL_NOTIFY_WHEN_IDLE_TOOL || args.notify === true;
}

/** A prompt sent from here to a host terminal; until its call answers, it may not have run. */
interface PromptMark {
  at: number;
  callId: string;
  ran: boolean;
}

/** What a call settles as, once its host has answered or not. */
interface NotedCall {
  /** The host ran it, or may have. */
  ran(): void;
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
const CALL_TOO_LARGE_DETAIL = "The call's arguments are too large to send. Nothing was sent.";
const CALL_SENDER_REFUSED_DETAIL =
  "The host refused this Shell's identity on the current connection. Try again shortly.";
const CALL_RATE_LIMITED_DETAIL = "Too many calls in a short time. Retry after retryAfterMs.";
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
  private readonly newId: () => string;
  /** Relayed calls out to each host right now, for the host's dialogs to be believed by. */
  private readonly callsOut = new Map<HostId, number>();
  /** Calls that may arm notices on their host, by callId (#13500). */
  private readonly noticePins = new Map<string, NoticePin>();
  /** Relayed calls out right now, by callId, for a host's ask about one to be checked against (#13501). */
  private readonly callsInFlight = new Map<string, CallInFlight>();
  /** Notices already queued, by host and noticeId. */
  private readonly seenNotices = new Map<string, true>();
  /** Recent prompts sent from here to each host terminal, by host and terminal. */
  private readonly prompted = new Map<string, PromptMark[]>();
  private disposed = false;

  constructor(private readonly deps: HostCallRuntimeDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
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
   * Whether a recent call to `hostId` from an assistant still running here
   * may yet send a notice (#13500). A link closed as idle can't be resumed,
   * and what its calls armed would go with it.
   */
  awaitsNotices(hostId: HostId): boolean {
    const holdFrom = this.now() - NOTICE_LINK_HOLD_MS;
    for (const pin of this.noticePins.values()) {
      if (pin.hostId === hostId && pin.armedAt >= holdFrom && this.stillRunning(pin.run)) {
        return true;
      }
    }
    return false;
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
      this.deps.controlEnabled?.(hostId) !== true
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
      console.warn("[HostCall] Asking about a host's call failed:", error);
      decision = null;
    }
    // The call can end, or its run be replaced, while the person decides.
    if (
      decision === "approved" &&
      (this.callsInFlight.get(payload.callId) !== call ||
        !this.stillRunning(call.run) ||
        this.deps.controlEnabled?.(hostId) !== true)
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
    const hostName =
      this.deps.hosts().find((host) => host.hostId === hostId)?.name ?? "remote host";
    const receivedAt = this.now();
    for (const notice of payload.notices) {
      const seenKey = `${hostId}\u0000${notice.noticeId}`;
      if (this.seenNotices.has(seenKey)) continue;
      const pin = this.noticePins.get(notice.callId);
      if (
        pin === undefined ||
        pin.hostId !== hostId ||
        pin.run.sessionId !== notice.helpSessionId ||
        receivedAt - pin.armedAt > NOTICE_PIN_TTL_MS
      ) {
        continue;
      }
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
    if (this.deps.controlEnabled?.(pin.hostId) !== true) {
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
      const mark: PromptMark = { at: this.now(), callId, ran: false };
      remember(
        this.prompted,
        key,
        trimMarks([...(this.prompted.get(key) ?? []), mark]),
        MAX_PROMPTED_TERMINALS
      );
      marks.push(mark);
      keys.push(key);
    }
    const pinned = armsNotice(tool, args);
    if (pinned) {
      const note =
        tool === TERMINAL_NOTIFY_WHEN_IDLE_TOOL && typeof args.note === "string"
          ? sanitizeNotifyNote(args.note)
          : undefined;
      remember(
        this.noticePins,
        callId,
        { hostId, run: { ...run }, armedAt: this.now(), ...(note !== undefined ? { note } : {}) },
        MAX_NOTICE_PINS
      );
    }
    let settled = false;
    return {
      ran: () => {
        if (settled) return;
        settled = true;
        for (const mark of marks) mark.ran = true;
      },
      notRun: () => {
        if (settled) return;
        settled = true;
        if (pinned) this.noticePins.delete(callId);
        for (const key of keys) {
          const left = (this.prompted.get(key) ?? []).filter((mark) => mark.callId !== callId);
          if (left.length > 0) this.prompted.set(key, left);
          else this.prompted.delete(key);
        }
      },
    };
  }

  /** Forgets every call and notice; calls on hosts are left as they are. */
  dispose(): void {
    this.disposed = true;
    this.callsOut.clear();
    this.callsInFlight.clear();
    this.noticePins.clear();
    this.seenNotices.clear();
    this.prompted.clear();
  }

  /**
   * Runs one of a host's own Daintree tools for the calling assistant
   * (#13493). The host admits it through its own MCP gates as this Shell's
   * sender and the caller's help session, at the caller's tier, so it can do
   * no more there than the assistant could here, and less where the host says
   * so. Needs only the person's "assistant control" switch for the host, not
   * messaging. A first send mints its callId; a callId given back is always a
   * resend, which the host never runs twice and never starts if it holds no
   * record of it.
   */
  call(
    helpSessionId: string,
    args: HostCallArgs,
    context: { tier: "core" | "full" }
  ): Promise<HostControlOutcome<HostCallResult>> {
    return this.settle(helpSessionId, async (caller) => {
      const resend = args.callId !== undefined;
      const callId = args.callId ?? this.newId();
      const sent = { callId, result: null };
      // A first send refused here sent nothing, so there is no call to follow.
      const unsent = { callId: resend ? callId : null, result: null };
      const host = this.deps.hosts().find((candidate) => candidate.hostId === args.hostId);
      if (!host) return { ...this.outcomeWith("not_found", CALL_NO_HOST_DETAIL), ...unsent };
      if (this.deps.controlEnabled?.(args.hostId) !== true) {
        return { ...this.outcomeWith("opted_out", CONTROL_OFF_DETAIL), ...unsent };
      }
      const toolArgs = args.args ?? {};
      if (Buffer.byteLength(JSON.stringify(toolArgs), "utf8") > MAX_RELAY_ARGS_BYTES) {
        return { ...this.outcomeWith("too_large", CALL_TOO_LARGE_DETAIL), ...unsent };
      }
      const runMs = relayRunMs(args.tool, toolArgs);
      const payload: McpCallPayload = {
        helpSessionId,
        projectId: args.projectId,
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
      this.callsOut.set(args.hostId, (this.callsOut.get(args.hostId) ?? 0) + 1);
      // A resend while its first send is still out is the same call: it shares
      // that record, so an approval the host is asking for still counts.
      const sharing = this.callsInFlight.get(callId);
      const inFlight: CallInFlight =
        sharing !== undefined &&
        sharing.hostId === args.hostId &&
        sharing.helpSessionId === helpSessionId
          ? sharing
          : {
              hostId: args.hostId,
              helpSessionId,
              projectId: args.projectId,
              tool: args.tool,
              args: toolArgs,
              run: caller,
              asked: false,
              sends: 0,
            };
      inFlight.sends += 1;
      if (inFlight !== sharing) this.callsInFlight.set(callId, inFlight);
      let answer: McpCallAnswer;
      try {
        answer = await this.requireClient().relayCall(
          args.hostId,
          payload,
          runMs + RELAY_ANSWER_GRACE_MS
        );
      } catch (error) {
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
          case "UNSUPPORTED":
            noted.notRun();
            return { ...this.outcomeWith("unsupported", unsupportedCallDetail(host)), ...unsent };
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
            console.warn("[HostCall] A relayed call ended without a known outcome:", error);
            return { ...this.outcomeWith("ambiguous", CALL_AMBIGUOUS_DETAIL), ...sent };
        }
      } finally {
        const left = (this.callsOut.get(args.hostId) ?? 1) - 1;
        if (left > 0) this.callsOut.set(args.hostId, left);
        else this.callsOut.delete(args.hostId);
        inFlight.sends -= 1;
        if (inFlight.sends === 0 && this.callsInFlight.get(callId) === inFlight) {
          this.callsInFlight.delete(callId);
        }
      }
      switch (answer.status) {
        // A tool error may still have run some of a batch before it failed.
        case "done":
          noted.ran();
          return { ...this.ok(), callId, result: answer.result };
        case "unknown":
          noted.ran();
          return { ...this.outcomeWith("expired", CALL_UNKNOWN_DETAIL), ...sent };
        case "conflict":
          noted.ran();
          return { ...this.outcomeWith("conflict", CALL_CONFLICT_DETAIL), ...sent };
        case "refused": {
          noted.notRun();
          const { code, detail } = RELAY_REFUSAL_DETAILS[answer.reason];
          return { ...this.outcomeWith(code, detail), ...sent };
        }
      }
    });
  }

  list(helpSessionId: string): Promise<HostControlOutcome<HostListResult>> {
    return this.settle(helpSessionId, async () => {
      const hosts = await Promise.all(
        this.deps.hosts().map(async (seen): Promise<HostListEntry> => {
          const host = await this.dialed(seen);
          const summary = host.summary;
          const connected = host.connection.status === "connected";
          const control = this.deps.controlEnabled?.(host.hostId) === true;
          return {
            hostId: host.hostId,
            name: host.name,
            connection: observedConnection(host.connection),
            rttMs: host.connection.status === "connected" ? host.connection.rttMs : null,
            lastSeenAt: host.lastSeenAt,
            load: summary
              ? {
                  sampledAt: summary.sampledAt,
                  cpuPercent: summary.cpuPercent,
                  memoryPressure: summary.memoryPressure,
                  thermal: summary.thermal,
                }
              : null,
            // A tally from before the link dropped is history, not what is running now.
            agentsObserved:
              connected && summary?.agentsObserved ? { ...summary.agentsObserved } : null,
            projects: connected && control ? await this.hostProjects(host.hostId) : null,
            control,
          };
        })
      );
      return { hosts };
    });
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
    return projects === null
      ? null
      : projects
          .slice(0, HOST_LIST_PROJECTS_MAX)
          .map((project) => ({ projectId: project.id, name: project.name }));
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
