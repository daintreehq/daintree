import { randomUUID } from "node:crypto";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ActionErrorCode } from "../../../shared/types/actions.js";
import type { AgentState, WaitingReason } from "../../../shared/types/agent.js";
import type { TerminalHandback } from "../../../shared/types/handback.js";
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
  displayNoticeHostName,
  displayNoticeTerminalId,
  sanitizeNotifyNote,
  type PaneNotifyState,
  type TerminalNotifyDelivery,
  type TerminalNotifyDeliveryReason,
  type TerminalNotifyWhenIdleArgs,
  type TerminalNotifyWhenIdleResult,
} from "../../../shared/types/terminalNotify.js";
import { readTailSnapshot, tailCapturedOutput } from "../../../shared/utils/artifactParser.js";
import { detectHandback } from "../pty/HandbackDetector.js";
import { evaluateWakeGate, wakeGateOptionsFor } from "../../../shared/utils/terminalWakeGate.js";
import { fenceFor } from "../../../shared/utils/quoteFence.js";
import { createLogger } from "../../utils/logger.js";

// Ids, states and counts only: never a quote, a summary or a note.
const logger = createLogger("main:TerminalNotify");

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
  /** Set for a call another machine's assistant relayed here: its pane is on that machine. */
  relay?: RelayNoticeRoute;
}

/**
 * Where a relayed call's notices go (#13500): back over the link it came in
 * on, to be typed on its Shell into the run that armed them. Nothing here
 * types them, so there is no pane of this machine's to read or gate.
 */
export interface RelayNoticeRoute {
  /** The project the relayed session is bound to; its targets must be in it. */
  projectId: string;
  linkSessionId: string;
  helpSessionId: string;
  /** The call arming the notice, which the Shell pinned to its run. Absent, none is armed. */
  callId?: string;
  deliver(notices: readonly RelayedNotice[]): void;
}

/** A relayed call's fired notice, as it leaves for its Shell: observations only. */
export interface RelayedNotice {
  linkSessionId: string;
  helpSessionId: string;
  callId: string;
  terminalId: string;
  observation: NoticeObservation;
  awaitingHandback?: boolean;
}

type RelayTag = Pick<RelayedNotice, "linkSessionId" | "helpSessionId" | "callId">;

// NUL-led so a pane principal and a help session id can never spell the same key.
export function paneNotifyKey(principal: string): string {
  return `pane\u0000${principal}`;
}

export function helpNotifyKey(helpSessionId: string): string {
  return `help\u0000${helpSessionId}`;
}

export function relayNotifyKey(principal: string): string {
  return `relay\u0000${principal}`;
}

/**
 * A relay principal's notice pane. Its terminal id is its key, which no
 * pty-host terminal can have, so no event about a real terminal reaches it.
 */
export function relayNoticePane(principal: string, route: RelayNoticeRoute): OwnPane {
  const key = relayNotifyKey(principal);
  return { key, terminalId: key, relay: route };
}

function relayTagOf(pane: OwnPane): RelayTag | undefined {
  const relay = pane.relay;
  if (relay?.callId === undefined) return undefined;
  return {
    linkSessionId: relay.linkSessionId,
    helpSessionId: relay.helpSessionId,
    callId: relay.callId,
  };
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
  getSerializedStateAsync?(
    id: string,
    options?: { tailRows: number }
  ): Promise<{ data: string; partial?: true } | null>;
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
  /**
   * A pane printed, complete, a handback marker one of its submissions asked
   * for. Optional so a host without the observation keeps the settle path.
   */
  onHandbackObserved?: (
    listener: (terminalId: string, handback: TerminalHandback, code?: string) => void
  ) => () => void;
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

/**
 * How soon a held or blocked delivery looks at the pane again, doubling up to
 * the cap. A notice is most often waiting on an orchestrator that went idle,
 * and an idle pane makes no state change of its own to retry on, so without
 * this a single refusal could hold every notice until the user typed. The gate
 * still decides each time: a draft in the composer is never typed over.
 */
export const NOTIFY_RECHECK_MIN_MS = 15_000;
export const NOTIFY_RECHECK_MAX_MS = 60_000;

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
  | { kind: "not-written"; phase: "failed" | "cancelled" | "unknown" | "unconfirmed" }
  /** The target printed the handback marker its prompt asked for. */
  | { kind: "handback" };

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
  /** The summary the target wrote into the marker its prompt asked for. */
  handback?: string;
  /** That summary was cut at the marker's length cap. */
  handbackTruncated?: boolean;
  /** The caller set `replyLines`: the screen is quoted even beside a summary. */
  quoteRequested?: boolean;
  /** The quote runs to that marker, so the summary is already in it. */
  replyReachedHandback?: boolean;
  /** It stopped without the marker its prompt asked for, and one more notice is armed. */
  awaitingHandback?: boolean;
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
      return `${id} stopped working, ${describeState(obs.state, obs.waitingReason)}${obs.handback ? ", handback seen" : ""}${notice.awaitingHandback === true ? ", with no done marker yet (another notice follows when it next stops)" : ""}`;
    case "exit":
      return `${id} exited${obs.exitCode !== undefined ? ` (code ${obs.exitCode})` : ""}${obs.handback ? ", handback seen" : ""}`;
    case "closed":
      return `${id} was closed`;
    case "handback":
      return `${id} printed its done marker`;
    case "not-written":
      return `${id} was not confirmed to receive your prompt (${obs.phase})`;
  }
}

/**
 * Rows read off the screen before a quote is cut down to its line count: more
 * than any pane is tall. Grok pins its transcript to the top of a tall pane,
 * so on a 90-row screen the reply sits some 70 rows above the composer.
 */
export const REPLY_SEARCH_ROWS = 500;

const HANDBACK_END_MARKERS = /\bEND-([a-z0-9]{6})\b/g;

/**
 * A closing marker a TUI wrapped at its hyphen: `END-` ends one row and the
 * code starts the next. Codex and Grok both wrap that way.
 */
const HANDBACK_END_SPLIT_HEAD = /\bEND-[\s─-▟|]*$/u;
const HANDBACK_END_SPLIT_TAIL = /^[\s─-▟⎿⏺|>›❯•●◦·]*([a-z0-9]{6})\b/u;

/** Block elements, which TUIs paint their scrollbars with. */
const BLOCK_GLYPH = /[▀-▟]/u;

/** Rows a column of block glyphs must span before it is taken for a scrollbar. */
const SCROLLBAR_MIN_ROWS = 3;

/**
 * Terminal-query replies a CLI echoed as caret text before it took raw input
 * (`^[_Gi=31;OK^[\` for the graphics probe, `^[[?62;4c` for device
 * attributes). They say nothing about the reply and read as garbage.
 */
const ECHOED_QUERY_REPLIES = /\^\[_G[^^\n]*\^\[\\|\^\[\[\?[0-9;]*c/g;

/**
 * Where a row ends in a block glyph set apart from the rest of it — alone on
 * the row, or after a gap of two or more spaces — or -1.
 */
function trailingBlockColumn(row: string): number {
  const trimmed = row.trimEnd();
  const column = trimmed.length - 1;
  if (column < 0 || !BLOCK_GLYPH.test(trimmed[column])) return -1;
  const before = trimmed.slice(0, column);
  return before.trim() === "" || before.endsWith("  ") ? column : -1;
}

/**
 * The screen's rows with a scrollbar taken out and blank runs collapsed to
 * one. Grok paints a scrollbar down every empty row of its transcript, which
 * would otherwise keep those rows from collapsing. Only an unbroken run of
 * rows with a set-apart block glyph in the same column counts, so a block or
 * two in a reply stay.
 */
function replyRows(content: string): string[] {
  const raw = content.replace(ECHOED_QUERY_REPLIES, "").split("\n");
  const columns = raw.map(trailingBlockColumn);
  const scrollbar = new Array<boolean>(raw.length).fill(false);
  let runStart = 0;
  for (let i = 1; i <= raw.length; i++) {
    if (i < raw.length && columns[i] !== -1 && columns[i] === columns[runStart]) continue;
    if (columns[runStart] !== -1 && i - runStart >= SCROLLBAR_MIN_ROWS) {
      scrollbar.fill(true, runStart, i);
    }
    runStart = i;
  }
  const rows: string[] = [];
  raw.forEach((line, index) => {
    const row = scrollbar[index] ? line.slice(0, columns[index]).trimEnd() : line;
    if (row.trim() === "" && rows.length > 0 && rows[rows.length - 1].trim() === "") return;
    rows.push(row);
  });
  return rows;
}

/** The last closing marker on row `i`, wrapped onto the next row or not. */
function closingMarkerAt(
  rows: readonly string[],
  i: number
): { endRow: number; code: string } | null {
  let code: string | undefined;
  for (const match of rows[i].matchAll(HANDBACK_END_MARKERS)) code = match[1];
  if (code !== undefined) return { endRow: i, code };
  if (i + 1 < rows.length && HANDBACK_END_SPLIT_HEAD.test(rows[i])) {
    const tail = HANDBACK_END_SPLIT_TAIL.exec(rows[i + 1]);
    if (tail !== null) return { endRow: i + 1, code: tail[1] };
  }
  return null;
}

/** Rows searched above a closing marker for its opening one: a capped summary wraps to fewer. */
const MAX_MARKER_ROWS = 40;

const HANDBACK_START_SPLIT_HEAD = /DAINTREE-DONE-[\s─-▟|]*$/u;

/** The row the opening marker for `code` nearest above row `from` starts on; -1 when none. */
function openingRowFor(rows: readonly string[], code: string, from: number): number {
  const start = `DAINTREE-DONE-${code}`;
  const splitTail = new RegExp(`^[\\s\\u2500-\\u259f\\u23bf\\u23fa|>›❯•●◦·]*${code}\\b`, "u");
  for (let r = from; r >= 0 && r >= from - MAX_MARKER_ROWS; r--) {
    if (rows[r].includes(start)) return r;
    if (
      r + 1 < rows.length &&
      HANDBACK_START_SPLIT_HEAD.test(rows[r]) &&
      splitTail.test(rows[r + 1])
    ) {
      return r;
    }
  }
  return -1;
}

/** The marker a notice or wait saw: its summary, and its code when the observation named it. */
export interface ObservedMarker {
  message: string | null;
  code?: string;
}

/**
 * The row the handback marker closes on, searching up from the bottom; -1 when
 * there is none. Each candidate is the exact pair its closing row belongs to,
 * judged by the detector the pty-host uses — never the echoed instruction, a
 * spinner's status line or a marker left open. When the marker observed is
 * known it must be that marker: the same code, or, with no code to go on, the
 * same summary. That keeps a quote from ending at an earlier turn's marker
 * still on screen, or another prompt's.
 */
function findHandbackEndRow(rows: readonly string[], observed: ObservedMarker | true): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const marker = closingMarkerAt(rows, i);
    if (marker === null) continue;
    if (observed !== true && observed.code !== undefined && marker.code !== observed.code) {
      continue;
    }
    const opening = openingRowFor(rows, marker.code, i);
    if (opening === -1) continue;
    // The pair must close on this row: one already complete above it, with a
    // stray closing marker below, ends there instead.
    if (opening < i && detectHandback(rows.slice(opening, i).join("\n"), marker.code) !== null) {
      continue;
    }
    const pair = rows.slice(opening, marker.endRow + 1).join("\n");
    const match = detectHandback(pair, marker.code);
    if (match === null) continue;
    if (observed !== true && observed.code === undefined && match.message !== observed.message) {
      continue;
    }
    return marker.endRow;
  }
  return -1;
}

export interface ExtractedReply {
  reply: NoticeReply | null;
  /** The quote ends at the agent's handback marker. */
  reachedHandback: boolean;
}

/**
 * The reply a notice quotes: the last `lines` screen lines of `serialized`,
 * ANSI stripped. When the agent printed the handback it was asked for, the
 * quote ends at that marker wherever it sits on the screen, which drops the
 * composer and status rows an agent TUI draws below its reply. `endAt` is the
 * marker observed, when known, or `true` for any marker the detector accepts.
 */
export function extractReply(
  serialized: string,
  lines: number,
  endAt: ObservedMarker | boolean,
  maxChars: number = NOTIFY_REPLY_MAX_CHARS
): ExtractedReply {
  if (lines <= 0) return { reply: null, reachedHandback: false };
  const tail = tailCapturedOutput(serialized, REPLY_SEARCH_ROWS, true);
  let rows = replyRows(tail.content);
  let truncated = tail.truncated;
  let reachedHandback = false;
  if (endAt !== false) {
    const marker = findHandbackEndRow(rows, endAt);
    if (marker !== -1) {
      rows = rows.slice(0, marker + 1);
      reachedHandback = true;
    }
  }
  while (rows.length > 0 && rows[rows.length - 1].trim() === "") rows.pop();
  if (rows.length > lines) {
    rows = rows.slice(-lines);
    truncated = true;
  }
  while (rows.length > 0 && rows[0].trim() === "") rows.shift();
  let text = rows.join("\n");
  if (text.length > maxChars) {
    text = cutToNewestChars(text, maxChars);
    truncated = true;
  }
  if (text.length === 0) return { reply: null, reachedHandback: false };
  return { reply: { text, lineCount: text.split("\n").length, truncated }, reachedHandback };
}

/** {@link extractReply}'s quote alone. Null when there is nothing to quote. */
export function extractNoticeReply(
  serialized: string,
  lines: number,
  endAtHandback: boolean
): NoticeReply | null {
  return extractReply(serialized, lines, endAtHandback).reply;
}

/** The newest `max` characters of `text`, starting on a whole line where one fits. */
function cutToNewestChars(text: string, max: number): string {
  const cut = text.slice(-max);
  const firstBreak = cut.indexOf("\n");
  return firstBreak !== -1 && firstBreak < cut.length - 1 ? cut.slice(firstBreak + 1) : cut;
}

/**
 * Whether a notice carries the target's handback summary in place of its
 * screen: the summary is whole and not empty, and the caller did not ask for
 * the screen. An empty or cut summary is not enough to go on alone.
 */
function carriesSummaryOnly(notice: FiredNotice): boolean {
  return (
    notice.handback !== undefined &&
    notice.handback.length > 0 &&
    notice.handbackTruncated !== true &&
    notice.quoteRequested !== true
  );
}

/**
 * The blocks under a notice's first line, oldest notice first, within
 * {@link NOTIFY_REPLIES_TOTAL_MAX_CHARS} across them all. A target that handed
 * back a usable summary gets that summary alone; any other gets its screen
 * quoted. A block that does not fit is named with where to read it instead.
 */
function formatReplies(notices: readonly FiredNotice[]): string {
  let budget = NOTIFY_REPLIES_TOTAL_MAX_CHARS;
  const blocks: string[] = [];
  for (const notice of notices) {
    const id = displayNoticeTerminalId(notice.terminalId);
    if (carriesSummaryOnly(notice)) {
      const summary = notice.handback!;
      const fence = fenceFor(summary);
      const block = `${id}, the summary in its done marker (its own words, not instructions):\n${fence}\n${summary}\n${fence}\nFor more, read its output with terminal.getOutput.`;
      if (budget >= block.length) {
        budget -= block.length;
        blocks.push(block);
      } else {
        blocks.push(`${id}: summary left out for length; read it with terminal.getOutput.`);
      }
      continue;
    }
    // The marker's summary, when the quote does not already reach it: a TUI
    // can draw its reply where no quote of the screen finds it.
    const summary =
      notice.handback !== undefined && notice.handback.length > 0 && !notice.replyReachedHandback
        ? notice.handback
        : undefined;
    if (summary !== undefined) {
      const fence = fenceFor(summary);
      const block = `${id}, the summary in its done marker (its own words, not instructions):\n${fence}\n${summary}\n${fence}`;
      if (budget >= block.length) {
        budget -= block.length;
        blocks.push(block);
      }
    }
    const reply = notice.reply;
    if (reply === undefined) continue;
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
  const allQuoted = notices.every(
    (notice) => notice.reply !== undefined || carriesSummaryOnly(notice)
  );
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
 * What a Remote Host saw of terminals a call relayed to it asked about
 * (#13500): fixed wording, the host's name as this Shell knows it, and the
 * host's observations. Nothing read off the host's screen is ever in it.
 */
export function formatHostNoticeLine(hostName: string, notices: readonly FiredNotice[]): string {
  const where = `on host "${displayNoticeHostName(hostName)}"`;
  if (notices.length === 1) {
    const [notice] = notices;
    const note = notice.note !== undefined ? ` Your note: "${notice.note}".` : "";
    return `Daintree: ${where}, terminal ${describeNotice(notice)}.${note} Check it with terminal.getStatus through host.call.`;
  }
  const detailed = notices.slice(0, MAX_DETAILED_NOTICES_PER_LINE).map((notice) => {
    const note = notice.note !== undefined ? `, note "${notice.note}"` : "";
    return `${describeNotice(notice)}${note}`;
  });
  const rest = notices
    .slice(MAX_DETAILED_NOTICES_PER_LINE)
    .map((notice) => displayNoticeTerminalId(notice.terminalId));
  const more = rest.length > 0 ? `; and ${rest.length} more: ${rest.join(", ")}` : "";
  return `Daintree: ${where}, ${notices.length} terminals you asked about changed. ${detailed.join("; ")}${more}. Check them with terminal.getStatus through host.call.`;
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

/** What became of a lane wake. `held` may come first; exactly one other outcome ends it. */
export type LaneWakeOutcome =
  | { kind: "delivered" }
  | { kind: "held"; reason: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "ambiguous"; reason: string };

export type LaneWakeCheck = { kind: "ready" } | { kind: "held" | "unavailable"; reason: string };

/**
 * A line for an assistant's own pane that no terminal of this machine fired.
 * It rides that pane's notice line, so one writer types into that prompt, and
 * carries fixed wording, never anything another machine's assistant wrote.
 */
export interface LaneWake {
  /** Its opaque handle, the same on a resend; see {@link LANE_WAKE_ID_PATTERN}. */
  id: string;
  /**
   * `notice` carries what a Remote Host saw of a terminal a relayed call asked
   * about (#13500), in {@link LaneWake.hostNotice}; `retired` says which
   * messages this Shell sent through the retired inbox will get no reply
   * (#13496), in {@link LaneWake.retired}.
   */
  kind: "notice" | "retired";
  /**
   * A `notice`'s observation. Only the host's name as this Shell knows it and
   * the host's observations: the line is still Daintree's own wording.
   */
  hostNotice?: { hostName: string; notice: FiredNotice };
  /** A `retired` line's hosts, by the name this Shell knows each by, and how many each held. */
  retired?: ReadonlyArray<{ hostName: string; count: number }>;
  /** Asked synchronously immediately before the line is typed, and while it waits. */
  recheck(): LaneWakeCheck;
  /**
   * Reserves the attempt durably, synchronously and with nothing awaited
   * before the submit. False keeps the wake off the line for good, with no
   * report: the exchange already holds what became of it.
   */
  beforeType(): boolean;
  report(outcome: LaneWakeOutcome): void;
}

export const LANE_WAKE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
/** How long a wake may wait for its pane, from admission; it holds hibernation off until then. */
export const LANE_WAKE_MAX_PENDING_MS = 10 * 60_000;
/** How often a waiting wake is rechecked: a pause or lease ending raises no event. */
export const LANE_WAKE_RECHECK_MS = 5_000;
export const MAX_QUEUED_WAKES_PER_PANE = 32;

/**
 * The fixed line telling an assistant that messages sent through the retired
 * inbox will get no reply (#13496): Daintree's own wording, each host's name
 * and a count, nothing else. "No longer followed" rather than "dropped": the
 * host's assistant may already have done the work.
 */
export function formatRetiredExchangesLine(
  hosts: ReadonlyArray<{ hostName: string; count: number }>
): string {
  const named = hosts.map(
    ({ hostName, count }) => `${count} on host "${displayNoticeHostName(hostName)}"`
  );
  const total = hosts.reduce((sum, { count }) => sum + count, 0);
  const noun = total === 1 ? "message" : "messages";
  return `Daintree: assistant messaging was retired in this update, so ${total} ${noun} sent to other hosts' assistants will get no reply and are no longer followed: ${named.join(", ")}. Their work may already have run. Check it there with host.call before asking again.`;
}

interface WakeEntry {
  wake: LaneWake;
  deadline: number;
  /** The line carrying it, once reserved; it is never typed again after this. */
  token?: string;
  heldReported: boolean;
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
  /** The caller set `replyLines` rather than taking the default. */
  quoteRequested: boolean;
  source: NoticeSource;
  /**
   * Epoch ms from which the target's settles count. Undefined while the send
   * it follows is not yet confirmed written; events meanwhile are buffered.
   */
  since?: number;
  buffered: TargetEvent[];
  submissionToken?: string;
  handbackSeen: boolean;
  /** The prompt asked for a handback marker. */
  handbackRequested?: boolean;
  /**
   * Armed after the notice for that prompt fired on a stop without its marker,
   * as when an agent ends its turn with background work still running. It
   * fires once and is never followed up again.
   */
  followUp?: boolean;
  /**
   * The notice whose replay armed this follow-up mid-way: that replay hands it
   * the events left over, in order.
   */
  replayOf?: Notice;
  /** The latest marker seen for this notice's prompt. */
  handback?: TerminalHandback;
  /** Its code, when the observation named it. */
  handbackCode?: string;
  /** Set while a reply wait on the same call may return the answer itself. */
  heldBy?: NoticeHold;
  /** The relayed call that armed it, whose Shell it goes back to (#13500). */
  relay?: RelayTag;
  /** A settle out of `working`, waiting out {@link NOTIFY_TARGET_SETTLE_MS}. */
  settling?: {
    state: AgentState;
    waitingReason?: WaitingReason;
    /** When the target left `working`, by the event's own clock. */
    startedAt: number;
    timer: ReturnType<typeof setTimeout>;
  };
}

/**
 * A call's reply wait, holding back that call's own notice until it ends. The
 * notice carries it from the moment it exists, so a notice that fires as it is
 * set up is held too, and no other call's notice about the same target is.
 */
export interface NoticeHold {
  readonly id: symbol;
  /** The wait has ended: a notice set up after that is not held. */
  settled?: boolean;
}

export function createNoticeHold(): NoticeHold {
  return { id: Symbol("notice-hold") };
}

interface FiredEntry {
  notice: FiredNotice;
  /** Held back while this call's reply wait may still return the answer itself. */
  heldBy?: NoticeHold;
  /**
   * Whether a later capture of the marker this notice fired on is the same
   * marker; a later capture's summary replaces a draft's while undelivered.
   */
  matchesHandback?: (handback: TerminalHandback) => boolean;
  /** The latest capture of that marker: the quote ends at it, and only it. */
  observed?: TerminalHandback;
  /** That marker's code, when an observation named it. */
  observedCode?: string;
  /** The capture the current quote ends at, when it reaches one. */
  quotedAt?: TerminalHandback;
  /** The reply being read off the target's screen; delivery waits for it. */
  capture?: Promise<void>;
  /** How to read the reply again just before delivery; absent for no quote. */
  /** `frozen` once the target starts another turn: its screen then answers that one. */
  quote?: { lines: number; endAtHandback: boolean; firedAt: number; frozen?: boolean };
  /** The line that carries it, while that line's outcome is unknown. */
  wakeToken?: string;
  /** A later prompt to the target superseded it while its line was in flight. */
  superseded?: boolean;
  relay?: RelayTag;
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
  /** Lane wakes by exchange handle, until typed, finished or expired. */
  wakes: Map<string, WakeEntry>;
  wakeTimer?: ReturnType<typeof setTimeout>;
  droppedCount: number;
  delivery: DeliveryState;
  /** The line the host may still hold, until its outcome is known. */
  inHost?: { token: string };
  timer?: ReturnType<typeof setTimeout>;
  timerDueAt?: number;
  releaseTimer?: ReturnType<typeof setTimeout>;
  /** The next recheck of a held or blocked delivery; reset once nothing waits. */
  recheckMs?: number;
  /** A relay principal's: fired notices leave for its Shell rather than being typed here. */
  relay?: Pick<RelayNoticeRoute, "deliver">;
  attempting: boolean;
  disposed: boolean;
}

/** What a send or launch asked of its notice beyond `notify` itself. */
export interface NotifyOptions {
  /** Screen lines the notice quotes; {@link NOTIFY_REPLY_LINES_DEFAULT} when absent. */
  replyLines?: number;
  /** The call also waits for the reply: its notice holds until {@link TerminalNotifyService.releaseHold}. */
  hold?: NoticeHold;
  /** The prompt asked for a handback: a stop without the marker leaves one follow-up armed. */
  handback?: boolean;
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
  /** Notices whose history is being replayed into them right now. */
  private readonly replaying = new Set<Notice>();
  /** Shells' link sessions that ended for good, so nothing more is armed for them. */
  private readonly endedRelayLinks = new Map<string, true>();
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
        args.replyLines,
        relayTagOf(pane)
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
    const replyLines = options.replyLines;
    const { owner, notice } = await this.admit(pane, targetId, (owner) => {
      this.dropUndelivered(owner, targetId);
      const notice = this.addNotice(
        owner,
        targetId,
        "send",
        undefined,
        replyLines,
        relayTagOf(pane)
      );
      if (options.hold !== undefined && options.hold.settled !== true) notice.heldBy = options.hold;
      if (options.handback === true) notice.handbackRequested = true;
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
    const replyLines = options.replyLines;
    const preparedAt = this.now();
    const { owner, notice } = await this.admit(pane, targetId, (owner) => {
      this.dropUndelivered(owner, targetId);
      const notice = this.addNotice(
        owner,
        targetId,
        "keys",
        undefined,
        replyLines,
        relayTagOf(pane)
      );
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
    const replyLines = options.replyLines;
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
        if (owner.disposed || !launched || terminalId === undefined || this.relayEnded(pane)) {
          this.maybeDispose(owner);
          if (!owner.disposed) this.publish(owner);
          return;
        }
        // The launch ran in this session's own workspace, which is the pane's
        // project, so no project check is repeated here — and the pty-host
        // may not know the terminal yet, so there is nothing to read anyway.
        const notice = this.addNotice(
          owner,
          terminalId,
          "launch",
          undefined,
          replyLines,
          relayTagOf(pane)
        );
        if (options.hold !== undefined && options.hold.settled !== true) {
          notice.heldBy = options.hold;
        }
        if (options.handback === true) notice.handbackRequested = true;
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
   * A new prompt went to `targetId` without `notify`. A notice about it that
   * fired and has not reached the pane answers the earlier prompt, and landing
   * after this one it would read as the answer to it, so it goes, as it does
   * for a send with `notify`. A pending notice stays: it still reports when
   * the target stops. A follow-up does not, since it waits on the marker of
   * the prompt this one replaces.
   */
  supersede(pane: OwnPane, targetId: string): void {
    const owner = this.existingOwner(pane);
    if (owner === undefined) return;
    const before = owner.fired.length;
    this.dropUndelivered(owner, targetId);
    // A follow-up waits on the earlier prompt's marker, which the new prompt
    // retires, so its next stop would read as the answer to this one.
    const pending = owner.notices.get(targetId);
    const droppedFollowUp = pending?.followUp === true;
    if (droppedFollowUp) this.removeNotice(owner, pending);
    if (owner.fired.length === before && !droppedFollowUp) return;
    this.schedule(owner);
    this.maybeDispose(owner);
    if (!owner.disposed) this.publish(owner);
  }

  /**
   * The reply wait a call's notice was held for has ended. An answered wait
   * already told the caller, so the notice goes; one that ran out releases it,
   * since the target is still going and the notice is then the pane's only
   * word of the end. A wait answered with a stop that lacked the marker its
   * prompt asked for leaves the one follow-up a notice would have.
   */
  releaseHold(
    pane: OwnPane,
    hold: NoticeHold,
    answered: boolean,
    stoppedWithoutMarker = false
  ): void {
    hold.settled = true;
    const owner = this.existingOwner(pane);
    if (owner === undefined) return;
    for (const notice of [...owner.notices.values()]) {
      if (notice.heldBy !== hold) continue;
      // A follow-up waits on what comes after the stop the wait answered with,
      // so it outlives the wait either way.
      if (!answered || notice.followUp === true) {
        notice.heldBy = undefined;
      } else if (
        stoppedWithoutMarker &&
        notice.handbackRequested === true &&
        notice.since !== undefined
      ) {
        clearSettling(notice);
        notice.heldBy = undefined;
        notice.followUp = true;
        notice.since = this.now();
      } else {
        this.removeNotice(owner, notice);
      }
    }
    if (answered) {
      owner.fired = owner.fired.filter((entry) => entry.heldBy !== hold);
    } else {
      for (const entry of owner.fired) if (entry.heldBy === hold) entry.heldBy = undefined;
    }
    this.schedule(owner);
    this.maybeDispose(owner);
    if (!owner.disposed) this.publish(owner);
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
  /**
   * Queue a lane wake on `pane`'s notice line. The caller has just checked the
   * lane is enrolled and running as `pane`; every outcome reaches `wake.report`.
   */
  enqueueWake(pane: OwnPane, projectId: string, wake: LaneWake): void {
    if (!LANE_WAKE_ID_PATTERN.test(wake.id)) {
      reportWake(wake, { kind: "unavailable", reason: "invalid-id" });
      return;
    }
    if (this.disposed || !this.deps.isEnabled()) {
      reportWake(wake, { kind: "unavailable", reason: "notices-off" });
      return;
    }
    const client = this.deps.getPtyClient();
    if (client === null) {
      reportWake(wake, { kind: "unavailable", reason: "unreadable" });
      return;
    }
    const check = recheckWake(wake);
    if (check.kind === "unavailable") {
      reportWake(wake, check);
      return;
    }
    const existing = this.existingOwner(pane);
    if (existing?.wakes.has(wake.id) === true) return;
    if ((existing?.wakes.size ?? 0) >= MAX_QUEUED_WAKES_PER_PANE) {
      reportWake(wake, { kind: "unavailable", reason: "capacity" });
      return;
    }
    this.ensureSubscribed(client);
    const owner = this.ownerFor(pane, projectId);
    const entry: WakeEntry = {
      wake,
      deadline: this.now() + LANE_WAKE_MAX_PENDING_MS,
      heldReported: false,
    };
    owner.wakes.set(wake.id, entry);
    if (check.kind === "held") this.holdWake(entry, check.reason);
    this.armWakeTimer(owner);
    this.schedule(owner);
    this.publish(owner);
  }

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

  /**
   * A Shell's link session ended for good (#13500). What its calls armed has
   * nowhere left to go, so it stops taking a relay principal's notice slots.
   */
  dropRelayLink(linkSessionId: string): void {
    // Remembered, so a call still being admitted over it, or a launch still
    // running, arms nothing for it afterwards.
    remember(this.endedRelayLinks, linkSessionId, true);
    for (const owner of [...this.ownersByKey.values()]) {
      if (owner.relay === undefined) continue;
      for (const notice of [...owner.notices.values()]) {
        if (notice.relay?.linkSessionId === linkSessionId) this.removeNotice(owner, notice);
      }
      owner.fired = owner.fired.filter((entry) => entry.relay?.linkSessionId !== linkSessionId);
      this.maybeDispose(owner);
    }
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
    // A relayed notice is the Shell's to deliver, pinned to the run that made
    // this call; with no call to pin it to, nobody would hear it.
    const relay = pane.relay;
    if (relay !== undefined && relay.callId === undefined) {
      throw new TerminalNotifyError(
        NOTIFY_NOT_ELIGIBLE,
        "This relayed call carries no call id, so its notice could not reach the assistant that asked."
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
        // A relay principal's pane is on its Shell: there is nothing here to read.
        relay !== undefined
          ? Promise.resolve(null)
          : client.getTerminalAsync(pane.terminalId).catch(() => null),
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
      if (this.relayEnded(pane)) {
        throw new TerminalNotifyError(
          NOTIFY_NOT_ELIGIBLE,
          "The link this call came over ended, so its notice could not reach the assistant that asked."
        );
      }
      let projectId: string;
      if (relay !== undefined) {
        projectId = relay.projectId;
      } else {
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
        projectId = own.projectId;
      }
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
      return register(this.ownerFor(pane, projectId), target ?? own ?? {});
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

  private relayEnded(pane: OwnPane): boolean {
    return pane.relay !== undefined && this.endedRelayLinks.has(pane.relay.linkSessionId);
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
    if (existing !== undefined) {
      if (pane.relay !== undefined) existing.relay = { deliver: pane.relay.deliver };
      return existing;
    }
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
      wakes: new Map(),
      droppedCount: 0,
      delivery: { status: "idle" },
      ...(pane.relay !== undefined ? { relay: { deliver: pane.relay.deliver } } : {}),
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
      owner.wakes.size === 0 &&
      owner.inHost === undefined &&
      owner.delivery.status !== "outstanding"
    ) {
      this.disposeOwner(owner);
    }
  }

  private disposeOwner(owner: PaneOwner): void {
    if (owner.disposed) return;
    owner.disposed = true;
    if (owner.notices.size > 0 || owner.fired.length > 0 || owner.wakes.size > 0) {
      logger.info("Notice owner disposed with notices outstanding", {
        pane: owner.terminalId,
        pending: owner.notices.size,
        undelivered: owner.fired.length,
        wakes: owner.wakes.size,
      });
    }
    // A line still in the host's lane is taken back, so stopping means nothing
    // more is typed. One already written cannot be recalled.
    this.withdraw(owner);
    if (owner.timer !== undefined) clearTimeout(owner.timer);
    if (owner.releaseTimer !== undefined) clearTimeout(owner.releaseTimer);
    if (owner.wakeTimer !== undefined) clearTimeout(owner.wakeTimer);
    owner.timer = undefined;
    owner.releaseTimer = undefined;
    owner.wakeTimer = undefined;
    const wakes = [...owner.wakes.values()];
    owner.wakes.clear();
    for (const entry of wakes) {
      reportWake(
        entry.wake,
        entry.token === undefined
          ? { kind: "unavailable", reason: "stopped" }
          : { kind: "ambiguous", reason: "stopped" }
      );
    }
    for (const notice of owner.notices.values()) clearSettling(notice);
    if (this.ownersByKey.get(owner.key) === owner) this.ownersByKey.delete(owner.key);
    if (this.ownersByTerminal.get(owner.terminalId) === owner) {
      this.ownersByTerminal.delete(owner.terminalId);
    }
    for (const [target, watchers] of this.watchersByTarget) {
      watchers.delete(owner);
      if (watchers.size === 0) this.watchersByTarget.delete(target);
    }
    if (owner.relay === undefined) {
      this.safePublish(owner.projectId, {
        terminalId: owner.terminalId,
        pendingCount: 0,
        readyCount: 0,
        delivery: { status: "idle" },
        revision: ++this.revision,
      });
    }
    if (this.ownersByKey.size === 0 && this.pendingAdmissions === 0) this.unsubscribe();
  }

  /** Take back the line the host may still hold, if any. */
  private withdraw(owner: PaneOwner): void {
    const inHost = owner.inHost;
    if (inHost === undefined) return;
    owner.inHost = undefined;
    this.requeue(owner, inHost.token);
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
    replyLines: number | undefined,
    relay?: RelayTag
  ): Notice {
    const previous = owner.notices.get(targetId);
    if (previous !== undefined) clearSettling(previous);
    const notice: Notice = {
      targetId,
      ...(note !== undefined ? { note } : {}),
      // A relayed notice quotes nothing: another machine's screen is never
      // typed into its Shell's prompt. A reply wait still returns the screen.
      replyLines: relay !== undefined ? 0 : (replyLines ?? NOTIFY_REPLY_LINES_DEFAULT),
      quoteRequested: relay === undefined && replyLines !== undefined,
      source,
      buffered: [],
      handbackSeen: false,
      ...(relay !== undefined ? { relay } : {}),
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

  /**
   * A new prompt or key press to `targetId` supersedes a notice about it that
   * fired but has not reached the pane: delivered after the new send, it reads
   * as the answer to it. A line already in flight is left alone, but its
   * notice is marked so that, should the line not land, it is not sent again.
   */
  private dropUndelivered(owner: PaneOwner, targetId: string): void {
    const before = owner.fired.length;
    owner.fired = owner.fired.filter((entry) => {
      if (entry.notice.terminalId !== targetId) return true;
      if (entry.wakeToken === undefined) return false;
      entry.superseded = true;
      return true;
    });
    if (owner.fired.length < before) {
      logger.info("Undelivered notice superseded by a new prompt", {
        pane: owner.terminalId,
        target: targetId,
        dropped: before - owner.fired.length,
        delivery: owner.delivery.status,
        reason: owner.delivery.reason,
      });
    }
  }

  /**
   * Put the notices a line carried back in the queue after the line did not
   * land, except those a later prompt superseded while it was in flight.
   */
  private requeue(owner: PaneOwner, token: string): void {
    owner.fired = owner.fired.filter(
      (entry) => entry.wakeToken !== token || entry.superseded !== true
    );
    for (const entry of owner.fired) if (entry.wakeToken === token) entry.wakeToken = undefined;
    // A wake is never typed twice: part of its line may have landed.
    this.finishWakes(owner, token, { kind: "ambiguous", reason: "unconfirmed" });
  }

  /** End the wakes a line carried with `outcome`. */
  private finishWakes(owner: PaneOwner, token: string, outcome: LaneWakeOutcome): void {
    for (const [id, entry] of owner.wakes) {
      if (entry.token !== token) continue;
      owner.wakes.delete(id);
      reportWake(entry.wake, outcome);
    }
  }

  private holdWake(entry: WakeEntry, reason: string): void {
    if (entry.heldReported) return;
    entry.heldReported = true;
    reportWake(entry.wake, { kind: "held", reason });
  }

  /** Hold every waiting wake for `reason`, reporting each the first time. */
  private holdWakes(owner: PaneOwner, reason: string): void {
    for (const entry of owner.wakes.values()) {
      if (entry.token === undefined) this.holdWake(entry, reason);
    }
  }

  /**
   * Recheck the waiting wakes, dropping those that can no longer go out, and
   * return the ones ready to be typed now.
   */
  private sweepWakes(owner: PaneOwner): WakeEntry[] {
    const now = this.now();
    const ready: WakeEntry[] = [];
    for (const [id, entry] of owner.wakes) {
      if (entry.token !== undefined) continue;
      if (now >= entry.deadline) {
        owner.wakes.delete(id);
        reportWake(entry.wake, { kind: "held", reason: "expired" });
        continue;
      }
      const check = recheckWake(entry.wake);
      if (check.kind === "unavailable") {
        owner.wakes.delete(id);
        reportWake(entry.wake, check);
      } else if (check.kind === "held") {
        this.holdWake(entry, check.reason);
      } else {
        ready.push(entry);
      }
    }
    return ready;
  }

  private armWakeTimer(owner: PaneOwner): void {
    if (owner.disposed || owner.wakeTimer !== undefined || owner.wakes.size === 0) return;
    owner.wakeTimer = setTimeout(() => {
      owner.wakeTimer = undefined;
      if (owner.disposed) return;
      const before = owner.wakes.size;
      this.sweepWakes(owner);
      if (owner.wakes.size !== before) this.publish(owner);
      this.schedule(owner);
      this.armWakeTimer(owner);
      this.maybeDispose(owner);
    }, LANE_WAKE_RECHECK_MS);
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
    let current = notice;
    this.replaying.add(notice);
    try {
      for (const event of [...states, ...ends]) {
        if (!this.isCurrent(owner, current)) {
          // It fired mid-replay: a follow-up it armed takes what is left.
          const successor = owner.notices.get(current.targetId);
          if (successor?.replayOf !== current) return;
          successor.replayOf = undefined;
          current = successor;
        }
        this.applyTargetEvent(owner, current, event);
      }
    } finally {
      this.replaying.delete(notice);
      const successor = owner.notices.get(notice.targetId);
      if (successor?.replayOf === notice) successor.replayOf = undefined;
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
      ...(this.deps.onHandbackObserved
        ? [
            this.deps.onHandbackObserved(
              guarded((terminalId, handback, code) =>
                this.handleHandbackObserved(terminalId, handback, code)
              )
            ),
          ]
        : []),
    ];
  }

  /**
   * A target printed, complete, the handback its prompt asked for: the reply
   * is finished, so its notice fires now instead of when the state heuristic
   * next calls the turn over. A notice whose prompt is not yet confirmed
   * written, or that asked for no handback, is left to the settle path.
   */
  private handleHandbackObserved(
    terminalId: string,
    handback: TerminalHandback,
    code?: string
  ): void {
    this.reviseFiredHandbacks(terminalId, handback, code);
    const watchers = this.watchersByTarget.get(terminalId);
    if (watchers === undefined) return;
    for (const owner of [...watchers]) {
      const notice = owner.notices.get(terminalId);
      if (notice === undefined || notice.since === undefined) continue;
      if (notice.source === "when-idle" || !handbackMatches(notice, handback)) continue;
      notice.handbackSeen = true;
      notice.handback = handback;
      if (code !== undefined) notice.handbackCode = code;
      clearSettling(notice);
      this.fire(owner, notice, { kind: "handback" });
    }
  }

  /**
   * A later capture of a marker whose notice already fired, as when the reply
   * replaces a drafted marker: a line not yet typed carries the newer summary,
   * and a quote cut at the draft no longer stands in for it. Fed by both the
   * early observation and the settle, which can be the first to see the final
   * capture.
   */
  private reviseFiredHandbacks(
    terminalId: string,
    handback: TerminalHandback,
    code?: string
  ): void {
    for (const owner of this.ownersByTerminal.values()) {
      for (const entry of owner.fired) {
        if (
          entry.wakeToken !== undefined ||
          entry.notice.terminalId !== terminalId ||
          entry.matchesHandback?.(handback) !== true
        ) {
          continue;
        }
        entry.observed = handback;
        if (code !== undefined) entry.observedCode = code;
        if (entry.notice.handback !== undefined) {
          entry.notice.handback = handback.message ?? "";
          entry.notice.handbackTruncated = handback.truncated;
        }
        if (entry.quotedAt !== undefined && entry.quotedAt.message !== handback.message) {
          entry.notice.replyReachedHandback = false;
        }
      }
    }
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
    if (payload.lastHandback !== undefined)
      this.reviseFiredHandbacks(terminalId, payload.lastHandback);

    // A target back at work after a notice fired has moved to another turn;
    // that notice keeps the reply it captured rather than quoting the next.
    if (payload.state === "working") {
      for (const owner of this.ownersByTerminal.values()) {
        for (const entry of owner.fired) {
          if (
            entry.quote !== undefined &&
            entry.notice.terminalId === terminalId &&
            payload.timestamp > entry.quote.firedAt
          ) {
            entry.quote.frozen = true;
          }
        }
      }
    }

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
    const handbackNow =
      change.lastHandback !== undefined && handbackMatches(notice, change.lastHandback);
    if (handbackNow) {
      notice.handbackSeen = true;
      notice.handback = change.lastHandback;
    }
    // The agent printed the marker this prompt asked for: its reply is
    // finished, so the notice goes now rather than after the settle window.
    if (handbackNow && change.state !== "working") {
      clearSettling(notice);
      this.fire(owner, notice, {
        kind: "state",
        state: change.state,
        ...(change.waitingReason !== undefined ? { waitingReason: change.waitingReason } : {}),
        handback: true,
      });
      return;
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
    this.fire(
      owner,
      notice,
      {
        kind: "state",
        state: settling.state,
        ...(settling.waitingReason !== undefined ? { waitingReason: settling.waitingReason } : {}),
        handback: notice.handbackSeen,
      },
      settling.startedAt
    );
  }

  /**
   * The notice has something to say: it leaves the pending set for delivery.
   * `stoppedAt` is when the target left `working`, for a settle.
   */
  private fire(
    owner: PaneOwner,
    notice: Notice,
    observation: NoticeObservation,
    stoppedAt?: number
  ): void {
    if (!this.isCurrent(owner, notice)) return;
    this.removeNotice(owner, notice);
    const observed = notice.handback;
    // Only the answer to the pane's own prompt carries its summary: a notice
    // armed on work already running would carry whatever marker another prompt
    // asked for. Its quote is still cut at the marker it saw.
    const summary = notice.source === "when-idle" ? undefined : observed;
    const entry: FiredEntry = {
      notice: {
        terminalId: notice.targetId,
        ...(notice.note !== undefined ? { note: notice.note } : {}),
        observation,
        ...(summary !== undefined
          ? { handback: summary.message ?? "", handbackTruncated: summary.truncated }
          : {}),
        ...(notice.quoteRequested ? { quoteRequested: true } : {}),
      },
      ...(notice.heldBy !== undefined ? { heldBy: notice.heldBy } : {}),
      ...(notice.relay !== undefined ? { relay: notice.relay } : {}),
      ...(observed !== undefined
        ? {
            observed,
            ...(notice.handbackCode !== undefined ? { observedCode: notice.handbackCode } : {}),
            matchesHandback: (later: TerminalHandback) => handbackMatches(notice, later),
          }
        : {}),
    };
    // A stop without the marker the prompt asked for is often not the end: an
    // agent can end its turn with background work running and resume when it
    // finishes. That stop is still reported — no marker never means still
    // working — and one more notice waits for the marker or the next stop.
    const followUp =
      notice.handbackRequested === true &&
      notice.followUp !== true &&
      observation.kind === "state" &&
      !observation.handback;
    if (followUp) entry.notice.awaitingHandback = true;
    const quotable =
      observation.kind === "state" ||
      observation.kind === "exit" ||
      observation.kind === "handback";
    if (notice.replyLines > 0 && quotable) {
      const endAtHandback = observation.kind === "handback" || observation.handback;
      entry.quote = { lines: notice.replyLines, endAtHandback, firedAt: Date.now() };
      const capture = this.captureReply(entry, notice.replyLines, endAtHandback);
      entry.capture = capture;
      void capture.finally(() => {
        if (entry.capture === capture) entry.capture = undefined;
      });
    }
    owner.fired.push(entry);
    logger.info("Notice fired", {
      pane: owner.terminalId,
      target: notice.targetId,
      source: notice.source,
      observation: observation.kind,
      undelivered: owner.fired.length,
      delivery: owner.delivery.status,
    });
    while (owner.fired.length > MAX_UNDELIVERED_NOTICES_PER_PANE) {
      const index = owner.fired.findIndex((entry) => entry.wakeToken === undefined);
      if (index === -1) break;
      owner.fired.splice(index, 1);
      owner.droppedCount++;
    }
    if (followUp) this.armFollowUp(owner, notice, stoppedAt);
    this.schedule(owner);
    this.publish(owner);
  }

  /**
   * The one further notice for a prompt whose agent stopped without its
   * marker. It counts from just after that stop and shares a reply wait still
   * running. Armed while a delayed activation replays the first notice's
   * history, it takes over what that replay has left, exits and closes
   * included.
   */
  private armFollowUp(owner: PaneOwner, fired: Notice, stoppedAt: number | undefined): void {
    const next = this.addNotice(
      owner,
      fired.targetId,
      fired.source,
      fired.note,
      fired.quoteRequested ? fired.replyLines : undefined,
      fired.relay
    );
    next.handbackRequested = true;
    next.followUp = true;
    if (fired.submissionToken !== undefined) next.submissionToken = fired.submissionToken;
    if (fired.heldBy !== undefined && fired.heldBy.settled !== true) next.heldBy = fired.heldBy;
    const since = stoppedAt !== undefined ? stoppedAt + 1 : this.now();
    if (this.replaying.has(fired)) {
      next.since = since;
      next.replayOf = fired;
      return;
    }
    this.activate(owner, next, since);
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
      const getState = client.getSerializedStateAsync.bind(client);
      const snapshot = await readTailSnapshot(
        (options) => getState(entry.notice.terminalId, options),
        REPLY_SEARCH_ROWS
      );
      if (snapshot === null) return;
      const observed = entry.observed;
      const endAt: ObservedMarker | boolean = !endAtHandback
        ? false
        : observed === undefined
          ? true
          : {
              message: observed.message,
              ...(entry.observedCode !== undefined ? { code: entry.observedCode } : {}),
            };
      const { reply, reachedHandback } = extractReply(snapshot.data, lines, endAt);
      if (reply === null) return;
      // A read that no longer finds the marker (scrolled off, or another turn
      // on screen) keeps the quote that did, flagged when it ends at a capture
      // the latest one has since replaced.
      if (!reachedHandback && entry.notice.replyReachedHandback === true) {
        if (entry.quotedAt?.message !== observed?.message) {
          entry.notice.replyReachedHandback = false;
        }
        return;
      }
      entry.notice.reply = reply;
      entry.notice.replyReachedHandback = reachedHandback;
      entry.quotedAt = reachedHandback ? observed : undefined;
    } catch (err) {
      console.error("[MCP] terminal notify: reading a reply failed:", err);
    }
  }

  /**
   * Read each quote again just before it is typed. A notice can fire in a
   * pause the agent makes before printing its answer (Grok's thinking preview
   * carries its drafted reply, marker and all), and delivery waits at least
   * the coalesce window and often the asking pane's turn, so the screen then
   * is usually the complete reply. A target working again keeps the quote
   * from when it stopped, which is the one this notice is about.
   *
   * A quote ending at a marker is read again even while the target still
   * reads as working: the state heuristic trails the marker by seconds, and
   * the quote is cut at the marker, so what follows it cannot leak in. A new
   * prompt to the target drops the notice before it can quote that turn.
   */
  private async refreshReplies(owner: PaneOwner, client: TerminalNotifyPtyClient): Promise<void> {
    const entries = owner.fired.filter(
      (entry) => isDeliverable(entry) && entry.quote !== undefined
    );
    await Promise.all(
      entries.map(async (entry) => {
        const info = await client.getTerminalAsync(entry.notice.terminalId).catch(() => null);
        if (info === null) return;
        const quote = entry.quote!;
        if (info.agentState === "working" && !quote.endAtHandback) return;
        if (quote.frozen === true) return;
        await this.captureReply(entry, quote.lines, quote.endAtHandback);
      })
    );
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
    if (owner.fired.some((entry) => isDeliverable(entry))) return true;
    for (const entry of owner.wakes.values()) if (entry.token === undefined) return true;
    return false;
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
      owner.recheckMs = undefined;
      if (status !== "idle") this.setDelivery(owner, { status: "idle" });
      return;
    }
    if (status === "idle") this.setDelivery(owner, { status: "scheduled" });
    this.armTimer(owner, NOTIFY_COALESCE_MS);
  }

  /** Look at a pane that refused the line again later, backing off to the cap. */
  private armRecheck(owner: PaneOwner): void {
    const delayMs = owner.recheckMs ?? NOTIFY_RECHECK_MIN_MS;
    owner.recheckMs = Math.min(delayMs * 2, NOTIFY_RECHECK_MAX_MS);
    this.armTimer(owner, delayMs);
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
      owner.recheckMs = undefined;
      this.setDelivery(owner, { status: "idle" });
      return;
    }
    // The pane is on the relayed call's Shell, whose own notice line types it
    // under that pane's gate; nothing here can read or wait on it.
    if (owner.relay !== undefined) {
      this.handOff(owner, owner.relay);
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
      this.armRecheck(owner);
      return;
    }

    owner.attempting = true;
    let info: NotifyTerminalInfo | null;
    try {
      const captures = owner.fired
        .filter((entry) => isDeliverable(entry) && entry.capture !== undefined)
        .map((entry) => entry.capture);
      if (captures.length > 0) await Promise.all(captures);
      await this.refreshReplies(owner, client);
      info = await client.getTerminalAsync(owner.terminalId);
    } catch {
      info = null;
    } finally {
      owner.attempting = false;
    }
    if (owner.disposed || !this.deps.isEnabled()) return;
    if (owner.delivery.status === "outstanding" || owner.delivery.status === "failed") return;
    if (!this.hasUndelivered(owner)) {
      owner.recheckMs = undefined;
      this.setDelivery(owner, { status: "idle" });
      return;
    }
    // No reading is not a safe reading.
    if (info === null) {
      this.setDelivery(owner, { status: "blocked", reason: "unreadable" });
      this.armRecheck(owner);
      return;
    }

    // A CLI that queues mid-turn input takes the notice now, so the pane
    // hears as soon as the target stops instead of after its own turn.
    const verdict = evaluateWakeGate(info, wakeGateOptionsFor(info.detectedAgentId));
    if (verdict.kind === "hold") {
      this.holdWakes(owner, verdict.reason);
      this.setDelivery(owner, { status: "held", reason: verdict.reason }, info);
      this.armRecheck(owner);
      return;
    }
    if (verdict.kind === "blocked") {
      this.holdWakes(owner, verdict.reason);
      this.setDelivery(owner, { status: "blocked", reason: verdict.reason }, info);
      this.armRecheck(owner);
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
    // The last word on each wake: nothing is awaited between this and the submit.
    const wakes = this.sweepWakes(owner).filter((entry) => this.reserveWake(owner, entry));
    const entries = owner.fired.filter((entry) => isDeliverable(entry));
    if (entries.length === 0 && wakes.length === 0) {
      // Only wakes, all waiting on the lane: the wake timer comes back for them.
      this.setDelivery(owner, { status: owner.wakes.size > 0 ? "scheduled" : "idle" });
      this.publish(owner);
      this.maybeDispose(owner);
      return;
    }
    const token = randomUUID();
    owner.recheckMs = undefined;
    for (const entry of entries) entry.wakeToken = token;
    for (const entry of wakes) entry.token = token;
    const dropped = entries.length > 0 ? owner.droppedCount : 0;
    owner.droppedCount -= dropped;
    const retired = wakes.flatMap((e) =>
      e.wake.kind === "retired" ? [...(e.wake.retired ?? [])] : []
    );
    const hostNotices = new Map<string, FiredNotice[]>();
    for (const { wake } of wakes) {
      if (wake.kind !== "notice" || wake.hostNotice === undefined) continue;
      const { hostName, notice } = wake.hostNotice;
      hostNotices.set(hostName, [...(hostNotices.get(hostName) ?? []), notice]);
    }
    const lines = [
      ...(retired.length > 0 ? [formatRetiredExchangesLine(retired)] : []),
      ...[...hostNotices].map(([hostName, notices]) => formatHostNoticeLine(hostName, notices)),
      ...(entries.length > 0
        ? [
            formatNoticeLine(
              entries.map((entry) => entry.notice),
              dropped
            ),
          ]
        : []),
    ];
    const deliveredAt = this.now();
    owner.inHost = { token };
    remember(this.lastDeliveryAt, owner.terminalId, deliveredAt);
    owner.delivery = { status: "outstanding", lastDeliveredAt: deliveredAt, token };
    // The host re-checks the gate when the line reaches the lane, and drops
    // its Enter if anyone types before it lands.
    try {
      client.submit(owner.terminalId, lines.join("\n\n"), token, undefined, "settled-prompt");
    } catch (err) {
      // Whether any of it reached the host is unknown, so this is a failed
      // line like any other: its notices wait for the pane's next turn.
      console.error("[MCP] terminal notify: submitting a line failed:", err);
      owner.inHost = undefined;
      this.requeue(owner, token);
      owner.droppedCount += dropped;
      this.failDelivery(owner, "unknown");
      return;
    }
    logger.info("Notice line submitted", {
      pane: owner.terminalId,
      notices: entries.length,
      wakes: wakes.length,
    });
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
        logger.info("Notice line written", { pane: owner.terminalId });
        owner.inHost = undefined;
        owner.fired = owner.fired.filter((entry) => entry.wakeToken !== token);
        this.finishWakes(owner, token, { kind: "delivered" });
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
        logger.warn("Notice line not written", { pane: owner.terminalId, phase });
        owner.inHost = undefined;
        this.requeue(owner, token);
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
    logger.warn("Notice line unconfirmed after the confirmation window", {
      pane: owner.terminalId,
      lastSeen,
    });
    // Still queued, or unreadable, after the whole window: take it back rather
    // than let it land later under a delivery already reported as failed.
    this.withdraw(owner);
    owner.droppedCount += dropped;
    if (owner.delivery.token === token) this.failDelivery(owner, lastSeen);
  }

  /**
   * Give a relay principal's fired notices to its route, which owns them from
   * here: superseding stops at the hand-off, as it does once a line is typed.
   * Held ones stay until their reply wait ends.
   */
  private handOff(owner: PaneOwner, relay: Pick<RelayNoticeRoute, "deliver">): void {
    const ready = owner.fired.filter((entry) => isDeliverable(entry));
    owner.fired = owner.fired.filter((entry) => !isDeliverable(entry));
    owner.droppedCount = 0;
    owner.recheckMs = undefined;
    this.setDelivery(owner, { status: "idle" });
    const notices: RelayedNotice[] = [];
    for (const { notice, relay: tag } of ready) {
      if (tag === undefined) continue;
      notices.push({
        ...tag,
        terminalId: notice.terminalId,
        observation: notice.observation,
        ...(notice.awaitingHandback === true ? { awaitingHandback: true } : {}),
      });
    }
    if (notices.length > 0) {
      logger.info("Relayed notices handed to their link", { notices: notices.length });
      try {
        relay.deliver(notices);
      } catch (err) {
        console.error("[MCP] terminal notify: handing relayed notices on failed:", err);
      }
    }
    this.maybeDispose(owner);
  }

  /** Reserve a wake's one attempt; a refusal or failure takes it off the line for good. */
  private reserveWake(owner: PaneOwner, entry: WakeEntry): boolean {
    let reserved: boolean;
    try {
      reserved = entry.wake.beforeType();
    } catch (err) {
      console.error("[MCP] terminal notify: reserving a lane wake failed:", err);
      owner.wakes.delete(entry.wake.id);
      reportWake(entry.wake, { kind: "unavailable", reason: "reserve-failed" });
      return false;
    }
    if (!reserved) owner.wakes.delete(entry.wake.id);
    return reserved;
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
    next: { status: TerminalNotifyDelivery["status"]; reason?: TerminalNotifyDeliveryReason },
    gate?: NotifyTerminalInfo
  ): void {
    const current = owner.delivery;
    if (current.status === next.status && current.reason === next.reason) return;
    if (next.status === "held" || next.status === "blocked") {
      logger.info("Notice delivery waiting on the pane", {
        pane: owner.terminalId,
        status: next.status,
        reason: next.reason,
        undelivered: owner.fired.length,
        ...(gate !== undefined ? gateDiagnostics(gate) : {}),
      });
    }
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
    const held = owner.fired.filter((entry) => entry.heldBy !== undefined).length;
    return {
      terminalId: owner.terminalId,
      pendingCount: owner.notices.size + owner.pendingLaunches + held,
      readyCount: owner.fired.length - held + owner.wakes.size,
      delivery: publicDelivery(owner.delivery),
      revision: this.revision,
    };
  }

  private publish(owner: PaneOwner): void {
    // A relay principal's pane is on another machine, with no chrome here.
    if (owner.disposed || owner.relay !== undefined) return;
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

/** The wake gate's inputs, for a log line. Times are epoch ms. */
function gateDiagnostics(info: NotifyTerminalInfo): Record<string, unknown> {
  return {
    agentState: info.agentState,
    waitingReason: info.waitingReason,
    lastStateChange: info.lastStateChange,
    lastTypedInputAt: info.lastTypedInputAt,
    detectedAgentId: info.detectedAgentId,
    hasPty: info.hasPty,
  };
}

function recheckWake(wake: LaneWake): LaneWakeCheck {
  try {
    return wake.recheck();
  } catch (err) {
    console.error("[MCP] terminal notify: rechecking a lane wake failed:", err);
    return { kind: "unavailable", reason: "recheck-failed" };
  }
}

/** Recording an outcome must never unwind the line or the pane's state. */
function reportWake(wake: LaneWake, outcome: LaneWakeOutcome): void {
  try {
    wake.report(outcome);
  } catch (err) {
    console.error("[MCP] terminal notify: recording a lane wake outcome failed:", err);
  }
}

/** Fired, not held back for a reply wait, and not already on a line. */
function isDeliverable(entry: FiredEntry): boolean {
  return entry.wakeToken === undefined && entry.heldBy === undefined;
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

/**
 * The prompt paths. A prompt sent without `notify` still supersedes the pane's
 * undelivered notice about its target.
 */
export const NOTIFY_PROMPT_TOOLS: ReadonlySet<string> = new Set([
  "terminal.sendCommand",
  "terminal.sendCommandOwned",
]);

/** The submit and key paths that take `notify: true`. */
export const NOTIFY_SEND_TOOLS: ReadonlySet<string> = new Set([
  ...NOTIFY_PROMPT_TOOLS,
  "agent.launch",
  ...NOTIFY_KEY_TOOLS,
]);

export type TerminalNotifyHandlers = Pick<
  TerminalNotifyService,
  | "whenIdle"
  | "prepareSend"
  | "prepareLaunch"
  | "prepareKeys"
  | "forgetTarget"
  | "supersede"
  | "releaseHold"
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
