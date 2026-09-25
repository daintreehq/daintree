import { randomUUID } from "node:crypto";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ActionErrorCode } from "../../../shared/types/actions.js";
import type { AgentState, WaitingReason } from "../../../shared/types/agent.js";
import {
  HANDBACK_SUMMARY_PLACEHOLDER,
  type TerminalHandback,
} from "../../../shared/types/handback.js";
import type { TerminalSubmitGuard } from "../../../shared/types/pty-host.js";
import type { TerminalSubmissionRecord } from "../../../shared/types/terminalSubmission.js";
import {
  MAX_DETAILED_NOTICES_PER_LINE,
  MAX_PENDING_NOTICES_PER_PANE,
  MAX_UNDELIVERED_NOTICES_PER_PANE,
  MIN_NOTIFY_INTERVAL_MS,
  NOTIFY_COALESCE_MS,
  NOTIFY_REPLIES_TOTAL_MAX_CHARS,
  NOTIFY_REPLY_LINES_DEFAULT,
  NOTIFY_REPLY_MAX_CHARS,
  NOTIFY_SETTLE_GRACE_MS,
  NOTIFY_TARGET_SETTLE_MS,
  TerminalNotifyWhenIdleArgsSchema,
  displayNoticeTerminalId,
  sanitizeNotifyNote,
  type PaneNotifyState,
  type TerminalNotifyDelivery,
  type TerminalNotifyDeliveryReason,
  type TerminalNotifyWhenIdleArgs,
  type TerminalNotifyWhenIdleResult,
} from "../../../shared/types/terminalNotify.js";
import { tailCapturedOutput } from "../../../shared/utils/artifactParser.js";
import { evaluateWakeGate } from "../../../shared/utils/terminalWakeGate.js";

/**
 * The caller's own pane, resolved from its credential and never from anything
 * it sent. `key` is the identity notices are held under: a pane bearer's
 * ownership principal, which survives reconnects, or the help session id for
 * an assistant lane. Notices are delivered to `terminalId` — the terminal that
 * asked — and to no other.
 */
export interface OwnPane {
  key: string;
  terminalId: string;
}

// NUL-led so a pane principal and a help session id can never spell the same key.
export function paneNotifyKey(principal: string): string {
  return `pane\u0000${principal}`;
}

export function helpNotifyKey(helpSessionId: string): string {
  return `help\u0000${helpSessionId}`;
}

/** The slice of a pty-host terminal record the notify service reads. */
export interface NotifyTerminalInfo {
  projectId?: string;
  agentState?: AgentState;
  waitingReason?: WaitingReason;
  lastStateChange?: number;
  lastTypedInputAt?: number;
  detectedAgentId?: string;
  launchAgentId?: string;
  everDetectedAgent?: boolean;
  hasPty?: boolean;
  isTrashed?: boolean;
  submission?: TerminalSubmissionRecord;
}

export interface TerminalNotifyPtyClient {
  getTerminalAsync(id: string, submissionToken?: string): Promise<NotifyTerminalInfo | null>;
  submit(
    id: string,
    text: string,
    submissionToken?: string,
    handbackCode?: string,
    guard?: TerminalSubmitGuard
  ): void;
  /** Take back a line that has not reached its Enter; see `WriteQueue.withdrawGuardedSubmission`. */
  withdrawGuardedSubmission(id: string, submissionToken: string): void;
  /** The terminal's screen and scrollback, read for the reply a notice quotes. */
  getSerializedStateAsync?(id: string): Promise<{ data: string } | null>;
  on(event: "exit", listener: (id: string, exitCode: number) => void): unknown;
  off(event: "exit", listener: (id: string, exitCode: number) => void): unknown;
}

/** The fields of `agent:state-changed` a notice reads. */
export interface NotifyStateChange {
  terminalId?: string;
  state: AgentState;
  previousState: AgentState;
  timestamp: number;
  waitingReason?: WaitingReason;
  lastHandback?: TerminalHandback;
}

export interface TerminalNotifyServiceDeps {
  getPtyClient: () => TerminalNotifyPtyClient | null;
  onStateChanged: (listener: (payload: NotifyStateChange) => void) => () => void;
  onKilled: (listener: (terminalId: string) => void) => () => void;
  /**
   * A pane closed to the trash. Its PTY lives on for the undo window, but it
   * is closed as far as the user can see, so it is neither typed into nor
   * waited on.
   */
  onTrashed: (listener: (terminalId: string) => void) => () => void;
  /** Whether the MCP server is on. Read on every decision. */
  isEnabled: () => boolean;
  /** Push a pane's chrome state to the views of its project. */
  publish: (projectId: string, state: PaneNotifyState) => void;
  now?: () => number;
}

/** A refusal the session server returns as a tool error with this code. */
export class TerminalNotifyError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "TerminalNotifyError";
  }
}

export const NOTIFY_NOT_ELIGIBLE = "NOTIFY_NOT_ELIGIBLE";
export const NOTIFY_TARGET_UNAVAILABLE = "NOTIFY_TARGET_UNAVAILABLE";
export const NOTIFY_LIMIT_REACHED = "NOTIFY_LIMIT_REACHED";
export const NOTIFY_VALIDATION_ERROR = "VALIDATION_ERROR";

/**
 * The action-error code a notify refusal is audited under. The tool error the
 * caller receives keeps the precise code; `ActionErrorCode` is a public
 * contract and is not widened for one feature's refusals.
 */
export function auditCodeForNotifyRefusal(code: string): ActionErrorCode {
  switch (code) {
    case NOTIFY_NOT_ELIGIBLE:
      return "RESTRICTED";
    case NOTIFY_TARGET_UNAVAILABLE:
      return "NOT_FOUND";
    default:
      return "VALIDATION_ERROR";
  }
}

/**
 * Reads of a delivered line's submission record. Anything short of
 * `pty_written` by the last one is a failure, never a retry.
 */
const DELIVERY_CONFIRM_DELAYS_MS = [500, 1_000, 1_500, 7_000, 20_000] as const;

/**
 * Reads of a notified send's submission record, until it is written. The
 * notice only starts counting settles from the write, so the end of whatever
 * the target was already doing is never reported as the end of this prompt.
 */
const SEND_CONFIRM_DELAYS_MS = [
  50, 150, 300, 600, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000,
] as const;

/**
 * How long a confirmed line stays outstanding when the pane never starts the
 * turn it was meant to. The gate still holds while the pane works, so this only
 * frees a pane whose CLI swallowed the line.
 */
const OUTSTANDING_RELEASE_MS = 60_000;

/** Entries kept in each of the service's recency maps. */
const MAX_REMEMBERED = 512;

/** Target events held for a notice whose send is not confirmed yet. */
const MAX_BUFFERED_EVENTS = 32;

/** State changes remembered per terminal for a notice set up after them. */
const MAX_RECENT_CHANGES = 8;

/** What a fired notice reports. Observations only, never a verdict. */
export type NoticeObservation =
  | { kind: "state"; state: AgentState; waitingReason?: WaitingReason; handback: boolean }
  | { kind: "exit"; exitCode?: number; handback: boolean }
  | { kind: "closed" }
  | { kind: "not-written"; phase: "failed" | "cancelled" | "unknown" | "unconfirmed" };

/** The target's last screen lines, captured when its notice fired. */
export interface NoticeReply {
  text: string;
  lineCount: number;
  /** Earlier lines were left out, by the line count or the character cap. */
  truncated: boolean;
}

export interface FiredNotice {
  terminalId: string;
  note?: string;
  observation: NoticeObservation;
  reply?: NoticeReply;
}

function describeState(state: AgentState, waitingReason?: WaitingReason): string {
  switch (state) {
    case "waiting":
      switch (waitingReason) {
        case "prompt":
          return "now waiting at its prompt";
        case "question":
          return "now waiting on a question";
        case "approval":
          return "now waiting on an approval";
        case "error":
          return "now stopped at an error";
        default:
          return "now waiting";
      }
    case "completed":
      return "now showing completed";
    default:
      return `now ${state}`;
  }
}

function describeNotice(notice: FiredNotice): string {
  const id = displayNoticeTerminalId(notice.terminalId);
  const obs = notice.observation;
  switch (obs.kind) {
    case "state":
      return `${id} stopped working, ${describeState(obs.state, obs.waitingReason)}${obs.handback ? ", handback seen" : ""}`;
    case "exit":
      return `${id} exited${obs.exitCode !== undefined ? ` (code ${obs.exitCode})` : ""}${obs.handback ? ", handback seen" : ""}`;
    case "closed":
      return `${id} was closed`;
    case "not-written":
      return `${id} was not confirmed to receive your prompt (${obs.phase})`;
  }
}

/** Extra lines read past the requested count, so chrome below a handback marker does not eat the reply. */
const REPLY_CHROME_SLACK_LINES = 24;

const HANDBACK_END_LINE = /\bEND-[a-z0-9]{6}\b/;

/**
 * The reply a notice quotes: the last `lines` screen lines of `serialized`,
 * ANSI stripped. When the agent printed the handback it was asked for, the
 * quote ends at that marker, which drops the composer and status rows an agent
 * TUI draws below its reply. Null when there is nothing to quote.
 */
export function extractNoticeReply(
  serialized: string,
  lines: number,
  endAtHandback: boolean
): NoticeReply | null {
  if (lines <= 0) return null;
  const tail = tailCapturedOutput(serialized, lines + REPLY_CHROME_SLACK_LINES, true);
  let rows = tail.content.split("\n");
  let truncated = tail.truncated;
  if (endAtHandback) {
    let marker = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      // The echoed instruction carries the placeholder; the agent's own line does not.
      if (HANDBACK_END_LINE.test(rows[i]) && !rows[i].includes(HANDBACK_SUMMARY_PLACEHOLDER)) {
        marker = i;
        break;
      }
    }
    if (marker !== -1) rows = rows.slice(0, marker + 1);
  }
  if (rows.length > lines) {
    rows = rows.slice(-lines);
    truncated = true;
  }
  while (rows.length > 0 && rows[rows.length - 1].trim() === "") rows.pop();
  while (rows.length > 0 && rows[0].trim() === "") rows.shift();
  let text = rows.join("\n");
  if (text.length > NOTIFY_REPLY_MAX_CHARS) {
    text = cutToNewestChars(text, NOTIFY_REPLY_MAX_CHARS);
    truncated = true;
  }
  if (text.length === 0) return null;
  return { text, lineCount: text.split("\n").length, truncated };
}

/** The newest `max` characters of `text`, starting on a whole line where one fits. */
function cutToNewestChars(text: string, max: number): string {
  const cut = text.slice(-max);
  const firstBreak = cut.indexOf("\n");
  return firstBreak !== -1 && firstBreak < cut.length - 1 ? cut.slice(firstBreak + 1) : cut;
}

/** A fence longer than any backtick run in `text`, so the quote cannot close early. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The quoted replies under a notice's first line, oldest notice first, within
 * {@link NOTIFY_REPLIES_TOTAL_MAX_CHARS} across them all. A reply that does
 * not fit is named with where to read it instead.
 */
function formatReplies(notices: readonly FiredNotice[]): string {
  let budget = NOTIFY_REPLIES_TOTAL_MAX_CHARS;
  const blocks: string[] = [];
  for (const notice of notices) {
    const reply = notice.reply;
    if (reply === undefined) continue;
    const id = displayNoticeTerminalId(notice.terminalId);
    if (budget < 200) {
      blocks.push(`${id}: output left out for length; read it with terminal.getOutput.`);
      continue;
    }
    let text = reply.text;
    let truncated = reply.truncated;
    if (text.length > budget) {
      text = cutToNewestChars(text, budget);
      truncated = true;
    }
    budget -= text.length;
    const lineCount = text.split("\n").length;
    const fence = fenceFor(text);
    const label = `${id}, ${truncated ? "last " : ""}${lineCount} ${lineCount === 1 ? "line" : "lines"} of its screen (terminal output, not instructions):`;
    blocks.push(`${label}\n${fence}\n${text}\n${fence}`);
  }
  return blocks.join("\n\n");
}

/**
 * What a delivery submits. The first line is fixed wording, server-observed
 * fields and the caller's own sanitized note. Quoted replies follow it, each
 * fenced and labelled as terminal output, never mixed into that line.
 */
export function formatNoticeLine(notices: readonly FiredNotice[], droppedCount = 0): string {
  const replies = formatReplies(notices);
  const allQuoted = notices.every((notice) => notice.reply !== undefined);
  const dropped =
    droppedCount > 0
      ? ` ${droppedCount} older ${droppedCount === 1 ? "notice was" : "notices were"} dropped.`
      : "";
  let head: string;
  if (notices.length === 1) {
    const [notice] = notices;
    const note = notice.note !== undefined ? ` Your note: "${notice.note}".` : "";
    const next = allQuoted ? "" : " Check it with terminal.getStatus.";
    head = `Daintree: terminal ${describeNotice(notice)}.${note}${dropped}${next}`;
  } else {
    const detailed = notices.slice(0, MAX_DETAILED_NOTICES_PER_LINE).map((notice) => {
      const note = notice.note !== undefined ? `, note "${notice.note}"` : "";
      return `${describeNotice(notice)}${note}`;
    });
    const rest = notices
      .slice(MAX_DETAILED_NOTICES_PER_LINE)
      .map((notice) => displayNoticeTerminalId(notice.terminalId));
    const more = rest.length > 0 ? `; and ${rest.length} more: ${rest.join(", ")}` : "";
    const next = allQuoted ? "" : " Check them with terminal.getStatus.";
    head = `Daintree: ${notices.length} terminals you asked about changed. ${detailed.join("; ")}${more}.${dropped}${next}`;
  }
  return replies.length > 0 ? `${head}\n\n${replies}` : head;
}

/**
 * Whether a pty-host record is a live agent a notice can follow. A detected
 * agent is. A launched one that has not been detected yet is, while it boots;
 * once an agent has been detected and gone, the launch hint is stale — what is
 * left is a shell, which never reports working or idle.
 */
function isAgentRecord(info: NotifyTerminalInfo): boolean {
  if (info.detectedAgentId !== undefined) return true;
  return (
    info.launchAgentId !== undefined &&
    info.everDetectedAgent !== true &&
    info.agentState !== "exited"
  );
}

type NoticeSource = "send" | "launch" | "when-idle" | "keys";

type TargetEvent =
  | { kind: "state"; change: NotifyStateChange }
  | { kind: "exit"; exitCode?: number }
  | { kind: "closed" };

interface Notice {
  targetId: string;
  note?: string;
  /** Screen lines the fired notice quotes; 0 for none. */
  replyLines: number;
  source: NoticeSource;
  /**
   * Epoch ms from which the target's settles count. Undefined while the send
   * it follows is not yet confirmed written; events meanwhile are buffered.
   */
  since?: number;
  buffered: TargetEvent[];
  submissionToken?: string;
  handbackSeen: boolean;
  /** A settle out of `working`, waiting out {@link NOTIFY_TARGET_SETTLE_MS}. */
  settling?: {
    state: AgentState;
    waitingReason?: WaitingReason;
    /** When the target left `working`, by the event's own clock. */
    startedAt: number;
    timer: ReturnType<typeof setTimeout>;
  };
}

interface FiredEntry {
  notice: FiredNotice;
  /** The reply being read off the target's screen; delivery waits for it. */
  capture?: Promise<void>;
  /** The line that carries it, while that line's outcome is unknown. */
  wakeToken?: string;
}

interface DeliveryState {
  status: TerminalNotifyDelivery["status"];
  reason?: TerminalNotifyDeliveryReason;
  lastDeliveredAt?: number;
  /** The outstanding line's submission token. */
  token?: string;
  /** The outstanding line was seen written to the pty. */
  confirmed?: boolean;
  /** The pane finished a turn after the outstanding line was queued. */
  settledSinceDelivery?: boolean;
}

interface PaneOwner {
  key: string;
  terminalId: string;
  projectId: string;
  /** Pending notices, one per target terminal. */
  notices: Map<string, Notice>;
  /** Launches with `notify` whose result has not come back. */
  pendingLaunches: number;
  fired: FiredEntry[];
  droppedCount: number;
  delivery: DeliveryState;
  /** The line the host may still hold, until its outcome is known. */
  inHost?: { token: string };
  timer?: ReturnType<typeof setTimeout>;
  timerDueAt?: number;
  releaseTimer?: ReturnType<typeof setTimeout>;
  attempting: boolean;
  disposed: boolean;
}

/** What a send or launch asked of its notice beyond `notify` itself. */
export interface NotifyOptions {
  /** Screen lines the notice quotes; {@link NOTIFY_REPLY_LINES_DEFAULT} when absent. */
  replyLines?: number;
}

/**
 * The follow-up to a send or launch that asked for `notify`, set up before the
 * dispatch so no state change of the target is missed. Exactly one of the two
 * is called.
 */
export interface PendingNotify {
  /** The dispatch returned; `result` is what the action reported. */
  complete(result: unknown): void;
  /** The dispatch failed or never ran. */
  cancel(): void;
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

/**
 * Notices and the lines that deliver them. One instance for the app, owned by
 * the MCP service; nothing here is persisted.
 *
 * Every event is matched by terminal id, never agent id: agent ids name the
 * agent type and collide across panes. A notice is scoped to the project of
 * the pane that asked: its target must be in that project, and the line only
 * ever goes to the asking pane's own terminal, whichever project is on screen.
 */
export class TerminalNotifyService {
  private readonly ownersByKey = new Map<string, PaneOwner>();
  private readonly ownersByTerminal = new Map<string, PaneOwner>();
  /** Target terminal → the panes waiting on it. */
  private readonly watchersByTarget = new Map<string, Set<PaneOwner>>();
  /** Terminal id → exit epoch and code, for exits that land while a call awaits. */
  private readonly exits = new Map<string, { epoch: number; exitCode?: number }>();
  /**
   * Terminal id → its last few state changes, oldest first, so a notice set up
   * after a fast agent already moved still sees the whole transition.
   */
  private readonly recentChanges = new Map<string, NotifyStateChange[]>();
  /**
   * A user stop (by terminal) or a revocation (by key) → its epoch, so a call
   * that was reading while its pane was torn down does not bring notices back.
   */
  private readonly teardownEpochs = new Map<string, number>();
  private globalTeardownEpoch = 0;
  private epoch = 0;
  private disposed = false;
  /**
   * Own terminal id → when a line was last delivered to it. Outlives the owner
   * record, so emptying and refilling a pane cannot skip the interval.
   */
  private readonly lastDeliveryAt = new Map<string, number>();
  private revision = 0;
  /** Calls between subscribing and recording what they set up. */
  private pendingAdmissions = 0;
  private unsubscribers: Array<() => void> = [];
  private subscribedClient: TerminalNotifyPtyClient | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: TerminalNotifyServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * `terminal.notifyWhenIdle`: arm a notice on a terminal that is working now.
   * One that is not working has already answered the question, so its state
   * comes back and nothing is armed.
   */
  async whenIdle(
    pane: OwnPane,
    args: TerminalNotifyWhenIdleArgs
  ): Promise<TerminalNotifyWhenIdleResult> {
    const since = this.now();
    const note = sanitizeNotifyNote(args.note);
    return this.admit(pane, args.terminalId, (owner, target) => {
      if (target.agentState !== "working") {
        this.maybeDispose(owner);
        return {
          armed: false,
          terminalId: args.terminalId,
          ...(target.agentState !== undefined ? { state: target.agentState } : {}),
          ...(target.waitingReason !== undefined ? { waitingReason: target.waitingReason } : {}),
        };
      }
      const notice = this.addNotice(
        owner,
        args.terminalId,
        "when-idle",
        note,
        args.replyLines ?? NOTIFY_REPLY_LINES_DEFAULT
      );
      this.activate(owner, notice, since);
      this.publish(owner);
      return { armed: true, terminalId: args.terminalId };
    });
  }

  /** A send with `notify`: checked and set up before the prompt goes out. */
  async prepareSend(
    pane: OwnPane,
    targetId: string,
    options: NotifyOptions = {}
  ): Promise<PendingNotify> {
    const replyLines = options.replyLines ?? NOTIFY_REPLY_LINES_DEFAULT;
    const { owner, notice } = await this.admit(pane, targetId, (owner) => {
      const notice = this.addNotice(owner, targetId, "send", undefined, replyLines);
      this.publish(owner);
      return { owner, notice };
    });
    let settled = false;
    return {
      complete: (result) => {
        if (settled) return;
        settled = true;
        if (!this.isCurrent(owner, notice)) return;
        const token = readString(result, "submissionToken");
        // With no token there is no record of the prompt being written, and
        // counting from now could report the end of the previous task.
        if (token === undefined) {
          this.resolveUnwritten(owner, notice, "unconfirmed");
          return;
        }
        notice.submissionToken = token;
        this.followSend(owner, notice, token).catch((err: unknown) => {
          console.error("[MCP] terminal notify: following a send failed:", err);
        });
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        if (this.isCurrent(owner, notice)) this.removeNotice(owner, notice);
        this.maybeDispose(owner);
      },
    };
  }

  /**
   * Keys with `notify`, most often the answer to a dialog that stopped an
   * agent before its first turn. Keys carry no submission record, so settles
   * count from when the keys were asked for; a notice whose keys start no work
   * waits for the target's next turn.
   */
  async prepareKeys(
    pane: OwnPane,
    targetId: string,
    options: NotifyOptions = {}
  ): Promise<PendingNotify> {
    const replyLines = options.replyLines ?? NOTIFY_REPLY_LINES_DEFAULT;
    const preparedAt = this.now();
    const { owner, notice } = await this.admit(pane, targetId, (owner) => {
      const notice = this.addNotice(owner, targetId, "keys", undefined, replyLines);
      this.publish(owner);
      return { owner, notice };
    });
    let settled = false;
    return {
      complete: () => {
        if (settled) return;
        settled = true;
        if (this.isCurrent(owner, notice)) this.activate(owner, notice, preparedAt);
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        if (this.isCurrent(owner, notice)) this.removeNotice(owner, notice);
        this.maybeDispose(owner);
      },
    };
  }

  /**
   * A launch with `notify`. The terminal does not exist yet, so only the
   * asking pane is checked; the notice attaches to the id the launch reports.
   */
  async prepareLaunch(pane: OwnPane, options: NotifyOptions = {}): Promise<PendingNotify> {
    const replyLines = options.replyLines ?? NOTIFY_REPLY_LINES_DEFAULT;
    const preparedAt = this.now();
    const epochBefore = this.epoch;
    const owner = await this.admit(pane, undefined, (owner) => {
      owner.pendingLaunches++;
      this.publish(owner);
      return owner;
    });
    let settled = false;
    const release = () => {
      owner.pendingLaunches = Math.max(0, owner.pendingLaunches - 1);
    };
    return {
      complete: (result) => {
        if (settled) return;
        settled = true;
        release();
        const terminalId = readString(result, "terminalId");
        const launched =
          typeof result === "object" &&
          result !== null &&
          (result as Record<string, unknown>).launched === true &&
          (result as Record<string, unknown>).spawnStatus == null;
        if (owner.disposed || !launched || terminalId === undefined) {
          this.maybeDispose(owner);
          if (!owner.disposed) this.publish(owner);
          return;
        }
        // The launch ran in this session's own workspace, which is the pane's
        // project, so no project check is repeated here — and the pty-host
        // may not know the terminal yet, so there is nothing to read anyway.
        const notice = this.addNotice(owner, terminalId, "launch", undefined, replyLines);
        const exited = this.exits.get(terminalId);
        if (exited !== undefined && exited.epoch > epochBefore) {
          notice.buffered.push({ kind: "exit", exitCode: exited.exitCode });
        }
        this.activate(owner, notice, preparedAt);
        this.publish(owner);
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        release();
        this.maybeDispose(owner);
        if (!owner.disposed) this.publish(owner);
      },
    };
  }

  /**
   * The pane is closing `targetId` itself, so a notice saying it was closed
   * would only cost a turn. Its pending notice goes; one that already fired
   * stays, since it may quote a reply the pane has not read.
   */
  forgetTarget(pane: OwnPane, targetId: string): void {
    const owner = this.existingOwner(pane);
    if (owner === undefined) return;
    const notice = owner.notices.get(targetId);
    if (notice === undefined) return;
    this.removeNotice(owner, notice);
    this.maybeDispose(owner);
    if (!owner.disposed) this.publish(owner);
  }

  /** The chrome state for a pane, or null when it has nothing pending. */
  getPaneState(terminalId: string): PaneNotifyState | null {
    const owner = this.ownersByTerminal.get(terminalId);
    return owner === undefined ? null : this.paneState(owner);
  }

  /** The user's "stop" on the pane: every notice it has pending goes. */
  stopPane(terminalId: string): void {
    this.markTeardown(`terminal\u0000${terminalId}`);
    const owner = this.ownersByTerminal.get(terminalId);
    if (owner !== undefined) this.disposeOwner(owner);
  }

  /** A pane bearer was revoked: its notices go with its authority. */
  revokeOwner(key: string): void {
    this.markTeardown(`key\u0000${key}`);
    const owner = this.ownersByKey.get(key);
    if (owner !== undefined) this.disposeOwner(owner);
  }

  /** The MCP server was turned off, or the service is shutting down. */
  disposeAll(): void {
    this.globalTeardownEpoch = ++this.epoch;
    for (const owner of [...this.ownersByKey.values()]) this.disposeOwner(owner);
  }

  dispose(): void {
    this.disposed = true;
    this.disposeAll();
    this.unsubscribe();
  }

  /**
   * Check the asking pane and, when named, the target, then hand `register` the
   * pane's owner record. `register` runs synchronously in the same step as the
   * limit check and the owner lookup, so a concurrent call from the same pane
   * cannot empty and dispose the owner in between, or slip past the limit.
   * Refusals leave nothing behind.
   */
  private async admit<T>(
    pane: OwnPane,
    targetId: string | undefined,
    register: (owner: PaneOwner, target: NotifyTerminalInfo) => T
  ): Promise<T> {
    if (this.disposed || !this.deps.isEnabled()) {
      throw new TerminalNotifyError(
        NOTIFY_NOT_ELIGIBLE,
        "Terminal notices are not available right now."
      );
    }
    if (targetId === pane.terminalId) {
      throw new TerminalNotifyError(
        NOTIFY_VALIDATION_ERROR,
        "A pane cannot ask to be notified about its own terminal."
      );
    }
    const client = this.deps.getPtyClient();
    if (client === null) {
      throw new TerminalNotifyError(NOTIFY_NOT_ELIGIBLE, "Terminals cannot be read right now.");
    }
    // Subscribed before anything is read, so an exit or settle landing during
    // the reads below is recorded and caught afterwards.
    this.ensureSubscribed(client);
    const epochBefore = this.epoch;
    this.pendingAdmissions++;
    try {
      const [own, target] = await Promise.all([
        client.getTerminalAsync(pane.terminalId).catch(() => null),
        targetId === undefined
          ? Promise.resolve(null)
          : client.getTerminalAsync(targetId).catch(() => null),
      ]);
      if (this.disposed || !this.deps.isEnabled() || this.torndownSince(pane, epochBefore)) {
        throw new TerminalNotifyError(
          NOTIFY_NOT_ELIGIBLE,
          "This pane's notices were stopped while this one was being set up."
        );
      }
      if (
        own === null ||
        own.hasPty === false ||
        own.isTrashed === true ||
        own.projectId === undefined ||
        this.exitedSince(pane.terminalId, epochBefore)
      ) {
        throw new TerminalNotifyError(
          NOTIFY_NOT_ELIGIBLE,
          "This connection's own terminal is not running, so there is no pane to notify."
        );
      }
      const projectId = own.projectId;
      if (targetId !== undefined) {
        // One message for missing, exited, trashed and other-project ids:
        // notices must not become a way to learn which ids exist elsewhere.
        if (
          target === null ||
          target.hasPty === false ||
          target.isTrashed === true ||
          target.projectId !== projectId ||
          this.exitedSince(targetId, epochBefore)
        ) {
          throw new TerminalNotifyError(
            NOTIFY_TARGET_UNAVAILABLE,
            `Terminal '${targetId}' is not a running terminal in this pane's project.`
          );
        }
        if (!isAgentRecord(target)) {
          throw new TerminalNotifyError(
            NOTIFY_VALIDATION_ERROR,
            `Terminal '${targetId}' is not running an agent, so it never reports working or idle. Wait on its output instead.`
          );
        }
      }
      const existing = this.existingOwner(pane);
      const held =
        existing === undefined
          ? 0
          : existing.pendingLaunches +
            [...existing.notices.keys()].filter((id) => id !== targetId).length;
      if (held >= MAX_PENDING_NOTICES_PER_PANE) {
        throw new TerminalNotifyError(
          NOTIFY_LIMIT_REACHED,
          `This pane already has ${MAX_PENDING_NOTICES_PER_PANE} notices pending. Wait for some to arrive before asking for more.`
        );
      }
      return register(this.ownerFor(pane, projectId), target ?? own);
    } finally {
      this.pendingAdmissions--;
      if (this.pendingAdmissions === 0 && this.ownersByKey.size === 0) this.unsubscribe();
    }
  }

  private markTeardown(mark: string): void {
    // Never pruned under an admission still reading: evicting its pane's mark
    // would let it bring the notices back.
    remember(this.teardownEpochs, mark, ++this.epoch, this.pendingAdmissions === 0);
  }

  private torndownSince(pane: OwnPane, epoch: number): boolean {
    if (this.disposed || this.globalTeardownEpoch > epoch) return true;
    const byTerminal = this.teardownEpochs.get(`terminal\u0000${pane.terminalId}`);
    const byKey = this.teardownEpochs.get(`key\u0000${pane.key}`);
    return (byTerminal ?? 0) > epoch || (byKey ?? 0) > epoch;
  }

  private exitedSince(terminalId: string, epoch: number): boolean {
    const exited = this.exits.get(terminalId);
    return exited !== undefined && exited.epoch > epoch;
  }

  private existingOwner(pane: OwnPane): PaneOwner | undefined {
    const owner = this.ownersByKey.get(pane.key);
    return owner !== undefined && owner.terminalId === pane.terminalId ? owner : undefined;
  }

  /**
   * The pane's owner record, created on first use. A record held under the
   * same key for another terminal, or for this terminal under another key, is
   * a previous incarnation and goes first.
   */
  private ownerFor(pane: OwnPane, projectId: string): PaneOwner {
    const existing = this.existingOwner(pane);
    if (existing !== undefined) return existing;
    const byKey = this.ownersByKey.get(pane.key);
    if (byKey !== undefined) this.disposeOwner(byKey);
    const byTerminal = this.ownersByTerminal.get(pane.terminalId);
    if (byTerminal !== undefined) this.disposeOwner(byTerminal);
    const owner: PaneOwner = {
      key: pane.key,
      terminalId: pane.terminalId,
      projectId,
      notices: new Map(),
      pendingLaunches: 0,
      fired: [],
      droppedCount: 0,
      delivery: { status: "idle" },
      attempting: false,
      disposed: false,
    };
    const lastDelivery = this.lastDeliveryAt.get(pane.terminalId);
    if (lastDelivery !== undefined && this.now() - lastDelivery < MIN_NOTIFY_INTERVAL_MS) {
      owner.delivery.lastDeliveredAt = lastDelivery;
    }
    this.ownersByKey.set(owner.key, owner);
    this.ownersByTerminal.set(owner.terminalId, owner);
    return owner;
  }

  /**
   * Drop an owner that holds nothing, has no line in the host, and is not
   * waiting out the turn its last line started — that wait is what keeps a
   * second line from following the first before the agent has read it.
   */
  private maybeDispose(owner: PaneOwner): void {
    if (owner.disposed) return;
    if (
      owner.notices.size === 0 &&
      owner.pendingLaunches === 0 &&
      owner.fired.length === 0 &&
      owner.inHost === undefined &&
      owner.delivery.status !== "outstanding"
    ) {
      this.disposeOwner(owner);
    }
  }

  private disposeOwner(owner: PaneOwner): void {
    if (owner.disposed) return;
    owner.disposed = true;
    // A line still in the host's lane is taken back, so stopping means nothing
    // more is typed. One already written cannot be recalled.
    this.withdraw(owner);
    if (owner.timer !== undefined) clearTimeout(owner.timer);
    if (owner.releaseTimer !== undefined) clearTimeout(owner.releaseTimer);
    owner.timer = undefined;
    owner.releaseTimer = undefined;
    for (const notice of owner.notices.values()) clearSettling(notice);
    if (this.ownersByKey.get(owner.key) === owner) this.ownersByKey.delete(owner.key);
    if (this.ownersByTerminal.get(owner.terminalId) === owner) {
      this.ownersByTerminal.delete(owner.terminalId);
    }
    for (const [target, watchers] of this.watchersByTarget) {
      watchers.delete(owner);
      if (watchers.size === 0) this.watchersByTarget.delete(target);
    }
    this.safePublish(owner.projectId, {
      terminalId: owner.terminalId,
      pendingCount: 0,
      readyCount: 0,
      delivery: { status: "idle" },
      revision: ++this.revision,
    });
    if (this.ownersByKey.size === 0 && this.pendingAdmissions === 0) this.unsubscribe();
  }

  /** Take back the line the host may still hold, if any. */
  private withdraw(owner: PaneOwner): void {
    const inHost = owner.inHost;
    if (inHost === undefined) return;
    owner.inHost = undefined;
    for (const entry of owner.fired) {
      if (entry.wakeToken === inHost.token) entry.wakeToken = undefined;
    }
    try {
      this.deps.getPtyClient()?.withdrawGuardedSubmission(owner.terminalId, inHost.token);
    } catch (err) {
      console.error("[MCP] terminal notify: withdrawing a line failed:", err);
    }
  }

  /** Add a notice for `targetId`, replacing any the pane already had for it. */
  private addNotice(
    owner: PaneOwner,
    targetId: string,
    source: NoticeSource,
    note: string | undefined,
    replyLines: number
  ): Notice {
    const previous = owner.notices.get(targetId);
    if (previous !== undefined) clearSettling(previous);
    const notice: Notice = {
      targetId,
      ...(note !== undefined ? { note } : {}),
      replyLines,
      source,
      buffered: [],
      handbackSeen: false,
    };
    owner.notices.set(targetId, notice);
    let watchers = this.watchersByTarget.get(targetId);
    if (watchers === undefined) {
      watchers = new Set();
      this.watchersByTarget.set(targetId, watchers);
    }
    watchers.add(owner);
    return notice;
  }

  private removeNotice(owner: PaneOwner, notice: Notice): void {
    clearSettling(notice);
    if (owner.notices.get(notice.targetId) !== notice) return;
    owner.notices.delete(notice.targetId);
    const watchers = this.watchersByTarget.get(notice.targetId);
    if (watchers !== undefined) {
      watchers.delete(owner);
      if (watchers.size === 0) this.watchersByTarget.delete(notice.targetId);
    }
  }

  private isCurrent(owner: PaneOwner, notice: Notice): boolean {
    return !owner.disposed && owner.notices.get(notice.targetId) === notice;
  }

  /**
   * Start counting the target's settles from `since`, replaying what was
   * buffered meanwhile and the latest change seen before the notice existed.
   */
  private activate(owner: PaneOwner, notice: Notice, since: number): void {
    if (!this.isCurrent(owner, notice)) return;
    notice.since = since;
    const buffered = notice.buffered;
    notice.buffered = [];
    const seen = new Set(buffered.map((event) => (event.kind === "state" ? event.change : null)));
    const history: TargetEvent[] = (this.recentChanges.get(notice.targetId) ?? [])
      .filter((change) => change.timestamp >= since && !seen.has(change))
      .map((change) => ({ kind: "state", change }));
    // State changes in the order they happened, then an exit or close, which
    // ends the terminal whatever came before it.
    const states = [...history, ...buffered.filter((event) => event.kind === "state")].sort(
      (a, b) =>
        (a.kind === "state" ? a.change.timestamp : 0) -
        (b.kind === "state" ? b.change.timestamp : 0)
    );
    const ends = buffered.filter((event) => event.kind !== "state");
    for (const event of [...states, ...ends]) {
      if (!this.isCurrent(owner, notice)) return;
      this.applyTargetEvent(owner, notice, event);
    }
  }

  /**
   * Follow a notified send until the host has written it. Settles count from
   * the write; a send that never lands is reported as such, never as done.
   */
  private async followSend(owner: PaneOwner, notice: Notice, token: string): Promise<void> {
    for (const delayMs of SEND_CONFIRM_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (!this.isCurrent(owner, notice)) return;
      let info: NotifyTerminalInfo | null;
      try {
        info = (await this.deps.getPtyClient()?.getTerminalAsync(notice.targetId, token)) ?? null;
      } catch {
        info = null;
      }
      if (!this.isCurrent(owner, notice)) return;
      const record = info?.submission;
      if (record?.phase === "pty_written") {
        this.activate(owner, notice, record.at ?? this.now());
        return;
      }
      if (
        record?.phase === "failed" ||
        record?.phase === "cancelled" ||
        record?.phase === "unknown"
      ) {
        this.resolveUnwritten(owner, notice, record.phase);
        return;
      }
    }
    if (this.isCurrent(owner, notice)) this.resolveUnwritten(owner, notice, "unconfirmed");
  }

  /** A notified send that was not written: an exit seen meanwhile says more. */
  private resolveUnwritten(
    owner: PaneOwner,
    notice: Notice,
    phase: "failed" | "cancelled" | "unknown" | "unconfirmed"
  ): void {
    const ended = notice.buffered.find((event) => event.kind !== "state");
    if (ended !== undefined) {
      this.applyTargetEvent(owner, notice, ended);
      return;
    }
    this.fire(owner, notice, { kind: "not-written", phase });
  }

  private ensureSubscribed(client: TerminalNotifyPtyClient): void {
    if (this.unsubscribers.length > 0 && this.subscribedClient === client) return;
    this.unsubscribe();
    // An exception here would surface in whoever emitted the event.
    const guarded =
      <A extends unknown[]>(handler: (...args: A) => void) =>
      (...args: A) => {
        try {
          handler(...args);
        } catch (err) {
          console.error("[MCP] terminal notify: handling an event failed:", err);
        }
      };
    const onExit = guarded((id: string, exitCode: number) => this.handleExit(id, "exit", exitCode));
    client.on("exit", onExit);
    this.subscribedClient = client;
    this.unsubscribers = [
      () => client.off("exit", onExit),
      this.deps.onStateChanged(guarded((payload) => this.handleStateChanged(payload))),
      this.deps.onKilled(guarded((terminalId) => this.handleExit(terminalId, "closed"))),
      this.deps.onTrashed(guarded((terminalId) => this.handleExit(terminalId, "closed"))),
    ];
  }

  private unsubscribe(): void {
    const unsubscribers = this.unsubscribers;
    this.unsubscribers = [];
    this.subscribedClient = null;
    for (const off of unsubscribers) {
      try {
        off();
      } catch (err) {
        console.error("[MCP] terminal notify: unsubscribe failed:", err);
      }
    }
  }

  private handleStateChanged(payload: NotifyStateChange): void {
    const terminalId = payload.terminalId;
    if (terminalId === undefined) return;
    const history = [...(this.recentChanges.get(terminalId) ?? []), payload].slice(
      -MAX_RECENT_CHANGES
    );
    remember(this.recentChanges, terminalId, history, this.pendingAdmissions === 0);

    const own = this.ownersByTerminal.get(terminalId);
    if (own !== undefined) this.handleOwnStateChanged(own, payload);

    const watchers = this.watchersByTarget.get(terminalId);
    if (watchers === undefined) return;
    for (const owner of [...watchers]) {
      const notice = owner.notices.get(terminalId);
      if (notice !== undefined)
        this.onTargetEvent(owner, notice, { kind: "state", change: payload });
    }
  }

  private handleExit(terminalId: string, kind: "exit" | "closed", exitCode?: number): void {
    remember(
      this.exits,
      terminalId,
      { epoch: ++this.epoch, ...(exitCode !== undefined ? { exitCode } : {}) },
      this.pendingAdmissions === 0
    );
    // Only a process that ended frees the id for a new pane. A pane closed to
    // the trash can come back, still inside its interval.
    if (kind === "exit") this.lastDeliveryAt.delete(terminalId);

    const own = this.ownersByTerminal.get(terminalId);
    if (own !== undefined) this.disposeOwner(own);

    const watchers = this.watchersByTarget.get(terminalId);
    if (watchers === undefined) return;
    const event: TargetEvent =
      kind === "exit"
        ? { kind: "exit", ...(exitCode !== undefined ? { exitCode } : {}) }
        : { kind };
    for (const owner of [...watchers]) {
      const notice = owner.notices.get(terminalId);
      if (notice !== undefined) this.onTargetEvent(owner, notice, event);
    }
  }

  private onTargetEvent(owner: PaneOwner, notice: Notice, event: TargetEvent): void {
    if (notice.since === undefined) {
      if (event.kind === "state") {
        notice.buffered.push(event);
        const states = notice.buffered.filter((held) => held.kind === "state");
        if (states.length > MAX_BUFFERED_EVENTS) {
          notice.buffered.splice(notice.buffered.indexOf(states[0]), 1);
        }
      } else if (!notice.buffered.some((held) => held.kind !== "state")) {
        notice.buffered.push(event);
      }
      return;
    }
    this.applyTargetEvent(owner, notice, event);
  }

  private applyTargetEvent(owner: PaneOwner, notice: Notice, event: TargetEvent): void {
    if (event.kind === "exit") {
      this.fire(owner, notice, {
        kind: "exit",
        ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
        handback: notice.handbackSeen,
      });
      return;
    }
    if (event.kind === "closed") {
      this.fire(owner, notice, { kind: "closed" });
      return;
    }
    const change = event.change;
    if (notice.since === undefined || change.timestamp < notice.since) return;
    if (change.lastHandback !== undefined && handbackMatches(notice, change.lastHandback)) {
      notice.handbackSeen = true;
    }
    // The agent left its terminal, from whatever state: a CLI quit from its
    // own dialog never worked, so waiting for a settle out of `working` would
    // wait forever.
    if (change.state === "exited") {
      clearSettling(notice);
      this.fire(owner, notice, { kind: "exit", handback: notice.handbackSeen });
      return;
    }
    if (change.state === "working") {
      // Judged by when things happened, not when they are being processed: a
      // settle replayed from history that lasted the full window before work
      // resumed was a real stop.
      const settling = notice.settling;
      if (
        settling !== undefined &&
        change.timestamp - settling.startedAt >= NOTIFY_TARGET_SETTLE_MS
      ) {
        this.fireSettled(owner, notice);
      } else {
        clearSettling(notice);
      }
      return;
    }
    if (notice.settling !== undefined) {
      notice.settling.state = change.state;
      notice.settling.waitingReason = change.waitingReason;
      return;
    }
    if (change.previousState !== "working") return;
    const delay = Math.max(0, change.timestamp + NOTIFY_TARGET_SETTLE_MS - this.now());
    notice.settling = {
      state: change.state,
      ...(change.waitingReason !== undefined ? { waitingReason: change.waitingReason } : {}),
      startedAt: change.timestamp,
      timer: setTimeout(() => this.fireSettled(owner, notice), delay),
    };
  }

  /** A settle that held for the whole window: report where the target stopped. */
  private fireSettled(owner: PaneOwner, notice: Notice): void {
    const settling = notice.settling;
    clearSettling(notice);
    if (settling === undefined || !this.isCurrent(owner, notice)) return;
    this.fire(owner, notice, {
      kind: "state",
      state: settling.state,
      ...(settling.waitingReason !== undefined ? { waitingReason: settling.waitingReason } : {}),
      handback: notice.handbackSeen,
    });
  }

  /** The notice has something to say: it leaves the pending set for delivery. */
  private fire(owner: PaneOwner, notice: Notice, observation: NoticeObservation): void {
    if (!this.isCurrent(owner, notice)) return;
    this.removeNotice(owner, notice);
    const entry: FiredEntry = {
      notice: {
        terminalId: notice.targetId,
        ...(notice.note !== undefined ? { note: notice.note } : {}),
        observation,
      },
    };
    if (notice.replyLines > 0 && (observation.kind === "state" || observation.kind === "exit")) {
      const capture = this.captureReply(entry, notice.replyLines, observation.handback);
      entry.capture = capture;
      void capture.finally(() => {
        if (entry.capture === capture) entry.capture = undefined;
      });
    }
    owner.fired.push(entry);
    while (owner.fired.length > MAX_UNDELIVERED_NOTICES_PER_PANE) {
      const index = owner.fired.findIndex((entry) => entry.wakeToken === undefined);
      if (index === -1) break;
      owner.fired.splice(index, 1);
      owner.droppedCount++;
    }
    this.schedule(owner);
    this.publish(owner);
  }

  /**
   * Read the reply off the target's screen as it stood when the notice fired.
   * Never rejects: a notice with no readable screen goes out without a quote.
   */
  private async captureReply(
    entry: FiredEntry,
    lines: number,
    endAtHandback: boolean
  ): Promise<void> {
    const client = this.deps.getPtyClient();
    if (client?.getSerializedStateAsync === undefined) return;
    try {
      const snapshot = await client.getSerializedStateAsync(entry.notice.terminalId);
      if (snapshot === null) return;
      const reply = extractNoticeReply(snapshot.data, lines, endAtHandback);
      if (reply !== null) entry.notice.reply = reply;
    } catch (err) {
      console.error("[MCP] terminal notify: reading a reply failed:", err);
    }
  }

  private handleOwnStateChanged(owner: PaneOwner, payload: NotifyStateChange): void {
    const delivery = owner.delivery;
    const turnEnded = payload.previousState === "working" && payload.state !== "working";
    const sinceDelivery =
      delivery.lastDeliveredAt !== undefined && payload.timestamp >= delivery.lastDeliveredAt;
    // The turn a line started has ended. If that line is confirmed written it
    // is no longer outstanding: otherwise one ignored line would silence the
    // pane for good.
    if (delivery.status === "outstanding" && turnEnded && sinceDelivery) {
      if (delivery.confirmed === true) {
        this.settleOutstanding(owner);
      } else {
        delivery.settledSinceDelivery = true;
      }
      return;
    }
    // A failed line may have left text in the composer. A turn that ended
    // since it was queued means the composer was submitted, so it is clear.
    if (delivery.status === "failed" && turnEnded && sinceDelivery) {
      this.settleOutstanding(owner);
      return;
    }
    // Any change can be what a held or blocked line was waiting for.
    if (payload.state !== "working") this.armTimer(owner, NOTIFY_SETTLE_GRACE_MS);
  }

  private settleOutstanding(owner: PaneOwner): void {
    if (owner.releaseTimer !== undefined) clearTimeout(owner.releaseTimer);
    owner.releaseTimer = undefined;
    owner.delivery = {
      status: "idle",
      ...(owner.delivery.lastDeliveredAt !== undefined
        ? { lastDeliveredAt: owner.delivery.lastDeliveredAt }
        : {}),
    };
    this.schedule(owner);
    this.publish(owner);
    this.maybeDispose(owner);
  }

  private hasUndelivered(owner: PaneOwner): boolean {
    return owner.fired.some((entry) => entry.wakeToken === undefined);
  }

  /**
   * Arrange a delivery attempt for fired notices. The first of a batch fixes
   * the deadline and later ones never move it, so continuous change across a
   * fleet still produces a delivery on time.
   */
  private schedule(owner: PaneOwner): void {
    if (owner.disposed) return;
    const status = owner.delivery.status;
    if (status === "outstanding" || status === "failed") return;
    if (!this.hasUndelivered(owner)) {
      if (status !== "idle") this.setDelivery(owner, { status: "idle" });
      return;
    }
    if (status === "idle") this.setDelivery(owner, { status: "scheduled" });
    this.armTimer(owner, NOTIFY_COALESCE_MS);
  }

  /** Set the attempt timer, moving an existing one earlier but never later. */
  private armTimer(owner: PaneOwner, delayMs: number): void {
    if (owner.disposed) return;
    const dueAt = this.now() + delayMs;
    if (owner.timer !== undefined) {
      if (owner.timerDueAt !== undefined && owner.timerDueAt <= dueAt) return;
      clearTimeout(owner.timer);
    }
    owner.timerDueAt = dueAt;
    owner.timer = setTimeout(() => {
      owner.timer = undefined;
      owner.timerDueAt = undefined;
      this.attempt(owner).catch((err: unknown) => {
        console.error("[MCP] terminal notify: delivery attempt failed:", err);
      });
    }, delayMs);
  }

  private async attempt(owner: PaneOwner): Promise<void> {
    if (owner.disposed || owner.attempting) return;
    const status = owner.delivery.status;
    if (status === "outstanding" || status === "failed") return;
    if (!this.deps.isEnabled()) return;
    if (!this.hasUndelivered(owner)) {
      this.setDelivery(owner, { status: "idle" });
      return;
    }

    const lastDeliveredAt = owner.delivery.lastDeliveredAt;
    if (lastDeliveredAt !== undefined) {
      const wait = lastDeliveredAt + MIN_NOTIFY_INTERVAL_MS - this.now();
      if (wait > 0) {
        this.setDelivery(owner, { status: "held", reason: "interval" });
        this.armTimer(owner, wait);
        return;
      }
    }

    const client = this.deps.getPtyClient();
    if (client === null) {
      this.setDelivery(owner, { status: "blocked", reason: "unreadable" });
      return;
    }

    owner.attempting = true;
    let info: NotifyTerminalInfo | null;
    try {
      const captures = owner.fired
        .filter((entry) => entry.wakeToken === undefined && entry.capture !== undefined)
        .map((entry) => entry.capture);
      if (captures.length > 0) await Promise.all(captures);
      info = await client.getTerminalAsync(owner.terminalId);
    } catch {
      info = null;
    } finally {
      owner.attempting = false;
    }
    if (owner.disposed || !this.deps.isEnabled()) return;
    if (owner.delivery.status === "outstanding" || owner.delivery.status === "failed") return;
    if (!this.hasUndelivered(owner)) {
      this.setDelivery(owner, { status: "idle" });
      return;
    }
    // No reading is not a safe reading.
    if (info === null) {
      this.setDelivery(owner, { status: "blocked", reason: "unreadable" });
      return;
    }

    const verdict = evaluateWakeGate(info);
    if (verdict.kind === "hold") {
      this.setDelivery(owner, { status: "held", reason: verdict.reason });
      return;
    }
    if (verdict.kind === "blocked") {
      this.setDelivery(owner, { status: "blocked", reason: verdict.reason });
      return;
    }
    const settledFor = info.lastStateChange === undefined ? 0 : this.now() - info.lastStateChange;
    if (settledFor < NOTIFY_SETTLE_GRACE_MS) {
      this.setDelivery(owner, { status: "scheduled" });
      this.armTimer(owner, NOTIFY_SETTLE_GRACE_MS - settledFor);
      return;
    }

    this.deliver(owner, client);
  }

  private deliver(owner: PaneOwner, client: TerminalNotifyPtyClient): void {
    // An earlier line the host never finished with would land beside this one;
    // taking it back returns its notices to this line.
    this.withdraw(owner);
    const token = randomUUID();
    const entries = owner.fired.filter((entry) => entry.wakeToken === undefined);
    for (const entry of entries) entry.wakeToken = token;
    const dropped = owner.droppedCount;
    owner.droppedCount = 0;
    const deliveredAt = this.now();
    owner.inHost = { token };
    remember(this.lastDeliveryAt, owner.terminalId, deliveredAt);
    owner.delivery = { status: "outstanding", lastDeliveredAt: deliveredAt, token };
    // The host re-checks the gate when the line reaches the lane, and drops
    // its Enter if anyone types before it lands.
    try {
      client.submit(
        owner.terminalId,
        formatNoticeLine(
          entries.map((entry) => entry.notice),
          dropped
        ),
        token,
        undefined,
        "settled-prompt"
      );
    } catch (err) {
      // Whether any of it reached the host is unknown, so this is a failed
      // line like any other: its notices wait for the pane's next turn.
      console.error("[MCP] terminal notify: submitting a line failed:", err);
      owner.inHost = undefined;
      for (const entry of entries) entry.wakeToken = undefined;
      owner.droppedCount += dropped;
      this.failDelivery(owner, "unknown");
      return;
    }
    this.publish(owner);
    this.confirmDelivery(owner, client, token, dropped).catch((err: unknown) => {
      console.error("[MCP] terminal notify: confirming a line failed:", err);
    });
  }

  /**
   * Follow a line until the host is done with it. A confirmed line takes its
   * notices with it; one that failed puts them back for the next line, which
   * waits for the pane's next finished turn rather than a timer.
   */
  private async confirmDelivery(
    owner: PaneOwner,
    client: TerminalNotifyPtyClient,
    token: string,
    dropped: number
  ): Promise<void> {
    const stillHeld = () => !owner.disposed && owner.inHost?.token === token;
    let lastSeen: TerminalNotifyDeliveryReason = "unknown";
    for (const delayMs of DELIVERY_CONFIRM_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (!stillHeld()) return;
      let info: NotifyTerminalInfo | null;
      try {
        info = await client.getTerminalAsync(owner.terminalId, token);
      } catch {
        info = null;
      }
      if (!stillHeld()) return;
      const phase = info?.submission?.phase;
      if (phase === "pty_written") {
        owner.inHost = undefined;
        owner.fired = owner.fired.filter((entry) => entry.wakeToken !== token);
        if (owner.delivery.token === token) {
          owner.delivery.confirmed = true;
          if (owner.delivery.settledSinceDelivery === true) {
            this.settleOutstanding(owner);
            return;
          }
          this.armRelease(owner, token);
        }
        this.publish(owner);
        this.maybeDispose(owner);
        return;
      }
      if (phase === "failed" || phase === "cancelled" || phase === "unknown") {
        owner.inHost = undefined;
        for (const entry of owner.fired) {
          if (entry.wakeToken === token) entry.wakeToken = undefined;
        }
        owner.droppedCount += dropped;
        // Part of the line may be sitting in the composer, and a guard refusal
        // looks the same from here. Neither makes sending again safe.
        if (owner.delivery.token === token) {
          const turnEnded = owner.delivery.settledSinceDelivery === true;
          this.failDelivery(owner, phase === "failed" ? "unknown" : phase);
          // …unless the pane already finished a turn since the line was queued:
          // the composer was submitted, which is what a failed line waits for.
          if (turnEnded) this.settleOutstanding(owner);
        }
        return;
      }
      lastSeen = info === null ? "unreadable" : "unknown";
    }
    if (!stillHeld()) return;
    // Still queued, or unreadable, after the whole window: take it back rather
    // than let it land later under a delivery already reported as failed.
    this.withdraw(owner);
    owner.droppedCount += dropped;
    if (owner.delivery.token === token) this.failDelivery(owner, lastSeen);
  }

  private armRelease(owner: PaneOwner, token: string): void {
    if (owner.releaseTimer !== undefined) clearTimeout(owner.releaseTimer);
    owner.releaseTimer = setTimeout(() => {
      owner.releaseTimer = undefined;
      if (owner.disposed) return;
      if (owner.delivery.status === "outstanding" && owner.delivery.token === token) {
        this.settleOutstanding(owner);
      }
    }, OUTSTANDING_RELEASE_MS);
  }

  private failDelivery(owner: PaneOwner, reason: TerminalNotifyDeliveryReason): void {
    owner.delivery = {
      status: "failed",
      reason,
      ...(owner.delivery.lastDeliveredAt !== undefined
        ? { lastDeliveredAt: owner.delivery.lastDeliveredAt }
        : {}),
    };
    this.publish(owner);
  }

  private setDelivery(
    owner: PaneOwner,
    next: { status: TerminalNotifyDelivery["status"]; reason?: TerminalNotifyDeliveryReason }
  ): void {
    const current = owner.delivery;
    if (current.status === next.status && current.reason === next.reason) return;
    owner.delivery = {
      status: next.status,
      ...(next.reason !== undefined ? { reason: next.reason } : {}),
      ...(current.lastDeliveredAt !== undefined
        ? { lastDeliveredAt: current.lastDeliveredAt }
        : {}),
    };
    this.publish(owner);
  }

  private paneState(owner: PaneOwner): PaneNotifyState {
    return {
      terminalId: owner.terminalId,
      pendingCount: owner.notices.size + owner.pendingLaunches,
      readyCount: owner.fired.length,
      delivery: publicDelivery(owner.delivery),
      revision: this.revision,
    };
  }

  private publish(owner: PaneOwner): void {
    if (owner.disposed) return;
    this.revision++;
    this.safePublish(owner.projectId, this.paneState(owner));
  }

  /** Chrome is best-effort: a failed push must never unwind a notice's state. */
  private safePublish(projectId: string, state: PaneNotifyState): void {
    try {
      this.deps.publish(projectId, state);
    } catch (err) {
      console.error("[MCP] terminal notify: publishing pane state failed:", err);
    }
  }
}

function clearSettling(notice: Notice): void {
  if (notice.settling === undefined) return;
  clearTimeout(notice.settling.timer);
  notice.settling = undefined;
}

/**
 * Whether a handback belongs to what this notice follows: the submission it
 * was armed on, or — for a notice armed on work already running — any.
 */
function handbackMatches(notice: Notice, handback: TerminalHandback): boolean {
  if (notice.source === "when-idle") return true;
  return handback.submissionToken === notice.submissionToken;
}

/** Insert as newest, dropping the oldest entry once the map holds too many. */
function remember<V>(map: Map<string, V>, key: string, value: V, prune = true): void {
  map.delete(key);
  map.set(key, value);
  while (prune && map.size > MAX_REMEMBERED) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function publicDelivery(delivery: DeliveryState): TerminalNotifyDelivery {
  return {
    status: delivery.status,
    ...(delivery.reason !== undefined ? { reason: delivery.reason } : {}),
    ...(delivery.lastDeliveredAt !== undefined
      ? { lastDeliveredAt: delivery.lastDeliveredAt }
      : {}),
  };
}

export const TERMINAL_NOTIFY_WHEN_IDLE_TOOL = "terminal.notifyWhenIdle";

/** The closes after which a pane's own notice for the target is dropped. */
export const NOTIFY_CLOSE_TOOLS: ReadonlySet<string> = new Set([
  "terminal.close",
  "terminal.closeOwned",
]);

/** The key paths that take `notify: true`. */
export const NOTIFY_KEY_TOOLS: ReadonlySet<string> = new Set([
  "terminal.sendKeys",
  "terminal.sendKeysOwned",
]);

/** The submit and key paths that take `notify: true`. */
export const NOTIFY_SEND_TOOLS: ReadonlySet<string> = new Set([
  "terminal.sendCommand",
  "terminal.sendCommandOwned",
  "agent.launch",
  ...NOTIFY_KEY_TOOLS,
]);

export type TerminalNotifyHandlers = Pick<
  TerminalNotifyService,
  "whenIdle" | "prepareSend" | "prepareLaunch" | "prepareKeys" | "forgetTarget"
>;

/**
 * Run `terminal.notifyWhenIdle` for a caller whose own pane is already
 * resolved. Throws {@link McpError} for malformed arguments and
 * {@link TerminalNotifyError} for a refusal.
 */
export async function runNotifyWhenIdleTool(
  rawArgs: unknown,
  pane: OwnPane,
  handlers: TerminalNotifyHandlers
): Promise<TerminalNotifyWhenIdleResult> {
  const parsed = TerminalNotifyWhenIdleArgsSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` at '${issue.path.map(String).join(".")}'` : "";
    throw new McpError(
      ErrorCode.InvalidParams,
      `${TERMINAL_NOTIFY_WHEN_IDLE_TOOL}: ${issue?.message ?? "invalid arguments"}${where}.`
    );
  }
  return handlers.whenIdle(pane, parsed.data);
}
