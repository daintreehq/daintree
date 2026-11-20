import { randomUUID } from "node:crypto";
import { McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { canonicalArgsHash } from "../../services/mcp-server/sessionDedup.js";
import { DEFAULT_ENCODING_LIMITS, LONE_SURROGATE } from "../link/encoding.js";
import {
  MAX_RELAY_NOTICE_STATUS_CALLS,
  MAX_RELAY_RESULT_BYTES,
  RELAY_NOTICE_WINDOW_MS,
  type McpCallAnswer,
  type McpCallPayload,
  type RelayNoticeStatusAnswer,
} from "./linkMethods.js";
import { RelayCallLedger, type RelayCancelResult } from "./relayCallLedger.js";
import {
  relayCallArmsNotice,
  type RelayedNotice,
} from "../../services/mcp-server/terminalNotify.js";
import type { McpRelayCaller, RelayNextFallback } from "../../services/mcp-server/shared.js";
import type { ViewlessApprovalDecision } from "../../services/viewless/index.js";
import type { RelayApprovalAsk } from "./relayApprovals.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("main:mcpRelayExecutor");

/** Who a relayed session acts for, as this host established it. */
export interface RelayMcpSessionSpec {
  /** This host's own id for the Shell's link session: the requesting Shell, as the drive lease knows it. */
  linkSessionId: string;
  /** The sender the Shell proved on that session. */
  senderId: string;
  /** The Shell assistant's own help session, as the Shell named it: never one of this host's. */
  helpSessionId: string;
  /** Its lane's conversation, as the Shell's main named it (#17919); absent from an older Shell. */
  conversationId?: string;
  projectId: string;
  tier: "core" | "full";
  /** The Shell's machine name from its handshake: display only, never identity. */
  shellName: string;
  /**
   * One of this machine's own assistants reaching another of its projects
   * (#14024), set only by the in-process relay: its standing to change a
   * project is this machine's own views', never a link's.
   */
  local?: true;
  /**
   * The Shell's global Assistant (#14545), as the Shell's runtime said of its
   * own lane; absent for any other assistant and from an older Shell.
   */
  global?: true;
  /** Carries the notices the session's calls arm back to the Shell (#13500). */
  deliverNotices(notices: readonly RelayedNotice[]): void;
  /**
   * Puts one confirm-gated call to the person at the Shell, in its own window,
   * when no view here can (#13501). Decides that call alone.
   */
  requestApproval(
    ask: Omit<RelayApprovalAsk, "helpSessionId" | "projectId">
  ): Promise<ViewlessApprovalDecision>;
  /** Set only by the in-process relay (#17917): see `McpRelayCaller.nextFallback`. */
  nextFallback?: RelayNextFallback;
}

/**
 * The caller a session admitted for `spec` acts as, whichever way its call
 * came. Copies only what the spec says, so a project assistant's is never global.
 */
export function relayCallerOf(spec: RelayMcpSessionSpec): McpRelayCaller {
  return {
    linkSessionId: spec.linkSessionId,
    senderId: spec.senderId,
    helpSessionId: spec.helpSessionId,
    ...(spec.conversationId !== undefined ? { conversationId: spec.conversationId } : {}),
    shellName: spec.shellName,
    ...(spec.local === true ? { local: true as const } : {}),
    ...(spec.global === true ? { global: true as const } : {}),
    deliverNotices: spec.deliverNotices,
    requestApproval: spec.requestApproval,
    ...(spec.local === true && spec.nextFallback ? { nextFallback: spec.nextFallback } : {}),
  };
}

/** One MCP session this host admitted for a relay principal and project. */
export interface RelayMcpSession {
  isOpen(): boolean;
  callTool(
    tool: string,
    args: Record<string, unknown>,
    options: { timeoutMs: number; callId: string; signal?: AbortSignal }
  ): Promise<CallToolResult>;
  close(): void;
}

export interface McpRelayExecutorDeps {
  /** This machine's own consent to tools run for other machines' assistants, read at each call. */
  acceptsRemoteControl(): boolean;
  hasProject(projectId: string): Promise<boolean>;
  /** A session admitted through this host's own MCP gates; null while its MCP server is off. */
  openSession(spec: RelayMcpSessionSpec): Promise<RelayMcpSession | null>;
  /**
   * Ends a relay principal's hold on what it made here, once unused for long
   * enough or crowded out; the terminals and worktrees themselves stay. With
   * `keepConversation`, it ended, and what its conversation made stays for that
   * conversation resumed (#17919) until `forgetConversation`.
   */
  retirePrincipal?(senderId: string, helpSessionId: string, keepConversation?: true): void;
  /**
   * Ends what an ended caller's conversation made here (#17919), once the hold
   * it would have had runs out or the sender's bound crowds it out.
   */
  forgetConversation?(senderId: string, conversationId: string): void;
  /**
   * Conversations an earlier run of the app left holding what they made here
   * (#16845), each with its last call, held from then on as an ended caller's:
   * a day from that call, within the sender's bound. Null until those records
   * are loaded; asked again until they are.
   */
  keptConversations?(): ReadonlyArray<{
    senderId: string;
    conversationId: string;
    usedAt: number;
  }> | null;
  /** A caller's conversation is running a call here (#16845), so a restart can keep its day. */
  noteConversationCall?(senderId: string, conversationId: string, at: number): void;
  /**
   * The calls of a relay principal that still have notices armed or waiting
   * in this host's notice service (#13930); absent, none do.
   */
  watchingNoticeCalls?(
    senderId: string,
    helpSessionId: string
  ): ReadonlySet<string> | Promise<ReadonlySet<string>>;
  /** The calls whose notices wait to leave for a sender's help session; absent, none do. */
  waitingNoticeCalls?(senderId: string, helpSessionId: string): ReadonlySet<string>;
  now?: () => number;
  /** How long an unused session stays open. */
  idleMs?: number;
}

/** What runs relayed calls, whichever way they came to this machine. */
export interface McpRelayExecutor {
  /** Runs one relayed call, at most once per sender and callId. */
  call(spec: RelayMcpSessionSpec, payload: McpCallPayload): Promise<McpCallAnswer>;
  /**
   * Runs one read that arms nothing, through the same admission as `call`, with
   * no record kept: nobody resends it, and what it read isn't held for a resend
   * (#16191). A call that would arm a notice is refused as one this can't run.
   */
  read(
    spec: RelayMcpSessionSpec,
    read: { tool: string; args: Record<string, unknown>; runMs: number }
  ): Promise<McpCallAnswer>;
  /**
   * Its sender's cancel of one call from one of its help sessions (#17985):
   * see RelayCallLedger.cancel. `full` refuses a cancel for a call not yet here.
   */
  cancel(senderId: string, helpSessionId: string, callId: string): RelayCancelResult;
  /** Whether this host holds anything more for each of a sender's calls (#13930). */
  noticeStatus(
    senderId: string,
    calls: ReadonlyArray<{ helpSessionId: string; callId: string }>
  ): Promise<RelayNoticeStatusAnswer>;
  /** Notices crowded out before their sender took them: their calls lost what they armed. */
  noticesDropped(senderId: string, callIds: Iterable<string>): void;
  /** A link session that can't resume: its sessions go once the calls on them settle. */
  expireLink(linkSessionId: string): void;
  /**
   * A caller that will make no more calls: its sessions go once the calls on
   * them settle, and its hold on what it made goes with them.
   */
  endPrincipal(senderId: string, helpSessionId: string): void;
  dispose(): void;
}

const RELAY_SESSION_IDLE_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
/** How long a Shell assistant's hold on what it made here outlasts its last call. */
const RELAY_PRINCIPAL_RETENTION_MS = 24 * 60 * 60_000;
/** Help sessions one Shell's sender holds things here for at once; the least recent go first. */
const RELAY_PRINCIPALS_PER_SENDER = 64;
/** Ended links remembered, for calls still being admitted when theirs went. */
const MAX_EXPIRED_LINKS = 256;
/**
 * How long a call that asked for notices is remembered past the window its
 * Shell takes them for, so clocks a little apart never read it as forgotten.
 */
const NOTICE_CALL_MARGIN_MS = 60 * 60_000;

/** A call relayed here that asked for notices (#13930), while its Shell may still ask after it. */
interface NoticeCall {
  helpSessionId: string;
  at: number;
  running: number;
  /** A notice it armed was crowded out before its Shell took it. */
  lost?: boolean;
}

interface CachedSession {
  linkSessionId: string;
  senderId: string;
  helpSessionId: string;
  opening: Promise<RelayMcpSession | null>;
  session: RelayMcpSession | null;
  inFlight: number;
  usedAt: number;
  /** Its link session ended while a call ran: closed once that call settles. */
  retired: boolean;
}

function textOf(content: CallToolResult["content"]): string | null {
  if (!Array.isArray(content) || content.length === 0) return null;
  return content
    .map((block) => (block.type === "text" ? block.text : `[${block.type} content omitted]`))
    .join("\n");
}

/** Cut to `bytes` on a character boundary. */
function head(text: string, bytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

/**
 * How deep a carried object may nest: the link encoder's ceiling, less the
 * four levels of the frame an answer rides in, and as many again to spare.
 */
export const MAX_CARRIED_DEPTH = DEFAULT_ENCODING_LIMITS.maxDepth - 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Whether an object reaches the Shell whole: no deeper than the link encodes,
 * and no key the encoder refuses (a lone surrogate) or the Shell's validation
 * drops (`__proto__`). One that doesn't goes as its text, which always does.
 * Iterative, so a deep value can't overflow the walk meant to turn it away.
 */
function carriesWhole(object: Record<string, unknown>): boolean {
  const pending: Array<{ node: unknown; depth: number }> = [{ node: object, depth: 1 }];
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!;
    if (node === null || typeof node !== "object") continue;
    if (depth > MAX_CARRIED_DEPTH) return false;
    if (Array.isArray(node)) {
      for (const child of node) pending.push({ node: child, depth: depth + 1 });
      continue;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "__proto__" || LONE_SURROGATE.test(key)) return false;
      pending.push({ node: child, depth: depth + 1 });
    }
  }
  return true;
}

/**
 * The object a result answers with: its structured content, or, for a tool
 * with no output schema, the JSON object that is its whole text. An error
 * keeps its text, and so does text that isn't one JSON object alone, such as
 * a result already cut to fit or one with a note after it.
 */
function objectOf(result: CallToolResult, isError: boolean): Record<string, unknown> | null {
  if (isRecord(result.structuredContent)) return result.structuredContent;
  if (isError || !Array.isArray(result.content) || result.content.length !== 1) return null;
  const [block] = result.content;
  if (block?.type !== "text" || !block.text.trimStart().startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(block.text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A tool's MCP result as the Shell carries it: the JSON object it answers
 * with, whether or not the tool declares an output schema, else its text. One
 * too large to carry whole is cut to text, saying that the call ran, so nobody
 * runs it again to see the rest.
 */
export function projectRelayResult(
  result: CallToolResult
): Extract<McpCallAnswer, { status: "done" }>["result"] {
  const isError = result.isError === true;
  const object = objectOf(result, isError);
  const structured = object && carriesWhole(object) ? object : null;
  const projected = { isError, structured, text: structured ? null : textOf(result.content) };
  const fullBytes = Buffer.byteLength(JSON.stringify(projected), "utf8");
  if (fullBytes <= MAX_RELAY_RESULT_BYTES) return projected;
  const body = structured ? JSON.stringify(structured) : (projected.text ?? "");
  // Measured as it is carried: escaping can grow text past what its raw bytes say.
  let budget = MAX_RELAY_RESULT_BYTES - 512;
  for (;;) {
    const shown = head(body, budget);
    const cut = {
      isError,
      structured: null,
      text: `[The host's result was cut to fit: ${Buffer.byteLength(shown, "utf8")} of ${fullBytes} bytes shown. The call ran; don't run it again to see the rest.]\n${shown}`,
    };
    const size = Buffer.byteLength(JSON.stringify(cut), "utf8");
    if (size <= MAX_RELAY_RESULT_BYTES || budget === 0) return cut;
    budget = Math.max(0, budget - (size - MAX_RELAY_RESULT_BYTES) - 64);
  }
}

/** A failure the host's MCP server raised rather than answered, as the tool error it reads like. */
const CANCELLED_BEFORE = {
  status: "cancelled",
  dispatch: "before",
} as const satisfies McpCallAnswer;
const CANCELLED_AFTER = { status: "cancelled", dispatch: "after" } as const satisfies McpCallAnswer;

function errorResult(error: unknown): Extract<McpCallAnswer, { status: "done" }>["result"] {
  const data = error instanceof McpError ? (error.data as { code?: unknown } | undefined) : null;
  const payload =
    data && typeof data.code === "string"
      ? data
      : {
          code: "EXECUTION_ERROR",
          message: formatErrorMessage(error, "The host couldn't run the tool"),
        };
  return { isError: true, structured: null, text: head(JSON.stringify(payload), 8 * 1024) };
}

/**
 * Runs the calls relayed to this machine's own MCP tools (#13493), whichever
 * way they came: over a Shell's link, or from one of this machine's own
 * assistants reaching another of its projects (#14024). Every call goes
 * through a real MCP session this host admits for that sender and help
 * session, bound to one project, so its tier, grants, ownership, drive lease
 * and audit are this host's own gates, not the relay's. Calls are at most once
 * per callId (see RelayCallLedger); a session goes once unused.
 */
export function createMcpRelayExecutor(deps: McpRelayExecutorDeps): McpRelayExecutor {
  const now = deps.now ?? Date.now;
  const idleMs = deps.idleMs ?? RELAY_SESSION_IDLE_MS;
  const ledger = new RelayCallLedger<McpCallAnswer>({ now });
  // The calls that asked for notices, by sender then callId, least recent
  // first: a call a Shell still follows that is missing here is one whose
  // notices this host lost, as by restarting.
  const noticeCalls = new Map<string, Map<string, NoticeCall>>();
  const sessions = new Map<string, CachedSession>();
  // Links that can't resume, for a call that was still being admitted when its link went.
  const expiredLinks = new Set<string>();
  // Each relay principal this host admitted, by sender then help session, least recent
  // first: when it last ran a call, how many it runs now, and whether it will make no
  // more, so a call of its still being admitted or run finishes, then its hold goes.
  const principals = new Map<
    string,
    Map<string, { usedAt: number; running: number; ended?: boolean; conversationId?: string }>
  >();
  // Conversations whose caller ended (#17919), by sender then conversation, least
  // recent first, with when it last ran a call: each counts against the sender's
  // bound and goes a day after that call, as the caller's own hold would have.
  const dormant = new Map<string, Map<string, { usedAt: number }>>();
  let disposed = false;
  // Running a call, or with a session open or opening: a closed one waiting to be swept holds nothing.
  const principalInUse = (senderId: string, helpSessionId: string): boolean =>
    (principals.get(senderId)?.get(helpSessionId)?.running ?? 0) > 0 ||
    [...sessions.values()].some(
      (cached) =>
        cached.senderId === senderId &&
        cached.helpSessionId === helpSessionId &&
        (cached.session === null || cached.session.isOpen())
    );
  /** `keepConversation` for a principal that ended, never one that aged out or was crowded out. */
  const retire = (senderId: string, helpSessionId: string, keepConversation = false): void => {
    const held = principals.get(senderId);
    const record = held?.get(helpSessionId);
    held?.delete(helpSessionId);
    if (held?.size === 0) principals.delete(senderId);
    // Its watches go with its hold: a Shell still following one hears they are gone,
    // unless a notice is still on its way, which the outbox answers for.
    const calls = noticeCalls.get(senderId);
    for (const [callId, call] of calls ?? []) {
      if (call.helpSessionId === helpSessionId && call.running === 0) calls!.delete(callId);
    }
    if (calls?.size === 0) noticeCalls.delete(senderId);
    try {
      if (keepConversation) deps.retirePrincipal?.(senderId, helpSessionId, true);
      else deps.retirePrincipal?.(senderId, helpSessionId);
    } catch (error) {
      logger.warn("Couldn't retire a relay principal", { error });
    }
    if (record?.conversationId !== undefined) {
      leaveConversation(senderId, record.conversationId, record.usedAt, keepConversation);
    }
  };
  const forgetConversation = (senderId: string, conversationId: string): void => {
    const asleep = dormant.get(senderId);
    asleep?.delete(conversationId);
    if (asleep?.size === 0) dormant.delete(senderId);
    try {
      deps.forgetConversation?.(senderId, conversationId);
    } catch (error) {
      logger.warn("Couldn't forget a relay conversation", { error });
    }
  };
  /**
   * A principal is off a conversation (#17919): retired, or on to another.
   * Another of the sender's principals still on it keeps it, and decides when
   * it goes. Otherwise one that ended keeps it for the conversation resumed,
   * within the day from its last call its own hold would have had; any other
   * way off it, nothing does.
   */
  const leaveConversation = (
    senderId: string,
    conversationId: string,
    usedAt: number,
    ended: boolean
  ): void => {
    const shared = [...(principals.get(senderId)?.values() ?? [])].some(
      (other) => other.conversationId === conversationId
    );
    if (shared) return;
    if (!ended || usedAt < now() - RELAY_PRINCIPAL_RETENTION_MS) {
      forgetConversation(senderId, conversationId);
      return;
    }
    let asleep = dormant.get(senderId);
    if (!asleep) {
      asleep = new Map();
      dormant.set(senderId, asleep);
    }
    asleep.set(conversationId, {
      usedAt: Math.max(usedAt, asleep.get(conversationId)?.usedAt ?? 0),
    });
    boundPrincipals(senderId);
  };
  const retireEnded = (
    senderId: string,
    helpSessionId: string,
    record: { usedAt: number; conversationId?: string }
  ): void =>
    retire(
      senderId,
      helpSessionId,
      record.conversationId !== undefined && record.usedAt >= now() - RELAY_PRINCIPAL_RETENTION_MS
    );
  /**
   * Holds a sender to its bound, ended conversations counted with live holds:
   * the ended conversation whose last call is oldest goes first, then the least
   * recent principal not in use.
   */
  const boundPrincipals = (senderId: string): void => {
    const size = () => (principals.get(senderId)?.size ?? 0) + (dormant.get(senderId)?.size ?? 0);
    const asleep = [...(dormant.get(senderId)?.entries() ?? [])].sort(
      ([, a], [, b]) => a.usedAt - b.usedAt
    );
    for (const [conversationId] of asleep) {
      if (size() <= RELAY_PRINCIPALS_PER_SENDER) return;
      forgetConversation(senderId, conversationId);
    }
    for (const helpSessionId of [...(principals.get(senderId)?.keys() ?? [])]) {
      if (size() <= RELAY_PRINCIPALS_PER_SENDER) return;
      if (!principalInUse(senderId, helpSessionId)) retire(senderId, helpSessionId);
    }
  };
  // What an earlier run kept (#16845), taken in once its records have loaded.
  let keptTaken = deps.keptConversations === undefined;
  const takeKept = (): void => {
    if (keptTaken) return;
    let kept: ReturnType<NonNullable<McpRelayExecutorDeps["keptConversations"]>>;
    try {
      kept = deps.keptConversations!();
    } catch (error) {
      logger.warn("Couldn't read the relay conversations a restart kept", { error });
      kept = [];
    }
    if (kept === null) return;
    keptTaken = true;
    const senders = new Set<string>();
    for (const { senderId, conversationId, usedAt } of kept) {
      // A caller already on it this run holds it; its own end decides.
      const live = [...(principals.get(senderId)?.values() ?? [])].some(
        (record) => record.conversationId === conversationId
      );
      if (live) continue;
      let asleep = dormant.get(senderId);
      const latest = Math.max(usedAt, asleep?.get(conversationId)?.usedAt ?? 0);
      if (latest < now() - RELAY_PRINCIPAL_RETENTION_MS) {
        forgetConversation(senderId, conversationId);
        continue;
      }
      if (!asleep) {
        asleep = new Map();
        dormant.set(senderId, asleep);
      }
      asleep.set(conversationId, { usedAt: latest });
      senders.add(senderId);
    }
    for (const senderId of senders) boundPrincipals(senderId);
  };
  /** Held from before admission until the call settles, wherever its session went meanwhile. */
  const holdPrincipal = (
    senderId: string,
    helpSessionId: string,
    conversationId?: string
  ): (() => void) => {
    takeKept();
    let held = principals.get(senderId);
    if (!held) {
      held = new Map();
      principals.set(senderId, held);
    }
    const record = held.get(helpSessionId) ?? { usedAt: now(), running: 0 };
    held.delete(helpSessionId);
    const lastUsedAt = record.usedAt;
    record.usedAt = now();
    record.running += 1;
    if (conversationId !== undefined && record.conversationId !== conversationId) {
      const left = record.conversationId;
      record.conversationId = conversationId;
      // On to another conversation: the one it leaves is no longer its.
      if (left !== undefined) leaveConversation(senderId, left, lastUsedAt, false);
      // Resumed: an ended conversation's again, unless its day ran out first.
      const asleep = dormant.get(senderId)?.get(conversationId);
      if (asleep !== undefined) {
        if (asleep.usedAt < now() - RELAY_PRINCIPAL_RETENTION_MS) {
          forgetConversation(senderId, conversationId);
        } else {
          dormant.get(senderId)!.delete(conversationId);
          if (dormant.get(senderId)!.size === 0) dormant.delete(senderId);
        }
      }
    }
    held.set(helpSessionId, record);
    boundPrincipals(senderId);
    // The conversation this call runs under, though its caller moves on to another meanwhile.
    const callConversation = record.conversationId;
    const noteCall = (): void => {
      if (callConversation === undefined) return;
      try {
        deps.noteConversationCall?.(senderId, callConversation, record.usedAt);
      } catch (error) {
        logger.warn("Couldn't note a relay conversation's call", { error });
      }
    };
    noteCall();
    return () => {
      record.running -= 1;
      record.usedAt = now();
      // An ended caller's day runs from here, so a restart's does too.
      noteCall();
      if (
        record.ended === true &&
        principals.get(senderId)?.get(helpSessionId) === record &&
        !principalInUse(senderId, helpSessionId)
      ) {
        retireEnded(senderId, helpSessionId, record);
      }
    };
  };

  const closeCached = (key: string, cached: CachedSession): void => {
    if (sessions.get(key) === cached) sessions.delete(key);
    cached.session?.close();
    void cached.opening.then(
      (opened) => {
        if (opened && opened !== cached.session) opened.close();
      },
      () => {
        // Nothing opened, so nothing to close.
      }
    );
  };

  /** Each of `matches`'s sessions goes, once the call on it settles if one runs. */
  const closeSessions = (matches: (cached: CachedSession) => boolean): void => {
    for (const [key, cached] of [...sessions]) {
      if (!matches(cached)) continue;
      sessions.delete(key);
      if (cached.inFlight > 0) cached.retired = true;
      else closeCached(key, cached);
    }
  };

  const sessionFor = async (
    spec: RelayMcpSessionSpec
  ): Promise<{ cached: CachedSession; session: RelayMcpSession } | null> => {
    const key = [
      spec.linkSessionId,
      spec.senderId,
      spec.helpSessionId,
      // A session a read opened without it never binds the conversation (#17919).
      spec.conversationId ?? "",
      spec.projectId,
      spec.tier,
      spec.global === true ? "global" : "",
    ].join("\0");
    let cached = sessions.get(key);
    if (cached?.session && !cached.session.isOpen()) {
      closeCached(key, cached);
      cached = undefined;
    }
    if (!cached) {
      const entry: CachedSession = {
        linkSessionId: spec.linkSessionId,
        senderId: spec.senderId,
        helpSessionId: spec.helpSessionId,
        opening: deps.openSession(spec),
        session: null,
        inFlight: 0,
        usedAt: now(),
        retired: false,
      };
      sessions.set(key, entry);
      cached = entry;
      void entry.opening.then(
        (opened) => {
          if (sessions.get(key) !== entry || disposed) {
            opened?.close();
            return;
          }
          entry.session = opened;
          // The server was off: the next call asks again rather than keeping the answer.
          if (opened === null) sessions.delete(key);
        },
        () => {
          if (sessions.get(key) === entry) sessions.delete(key);
        }
      );
    }
    const opened = await cached.opening.catch(() => null);
    if (opened === null || !opened.isOpen()) return null;
    if (cached.session === null && sessions.get(key) === cached) cached.session = opened;
    // Its link or caller ended while this was being admitted: serve this call, then close.
    if (
      expiredLinks.has(spec.linkSessionId) ||
      principals.get(spec.senderId)?.get(spec.helpSessionId)?.ended === true
    ) {
      if (sessions.get(key) === cached) sessions.delete(key);
      cached.retired = true;
    }
    return { cached, session: opened };
  };

  /**
   * Remembered, as running, from when it runs: a resend of one this host
   * never ran arms nothing. Taken back if its call is refused, and only then
   * does it count against the sender's bound, so a refusal crowds out nothing.
   */
  const startNoticeCall = (
    senderId: string,
    helpSessionId: string,
    callId: string
  ): ((refused: boolean) => void) => {
    let calls = noticeCalls.get(senderId);
    if (!calls) {
      calls = new Map();
      noticeCalls.set(senderId, calls);
    }
    const call = calls.get(callId) ?? { helpSessionId, at: now(), running: 0 };
    call.running += 1;
    calls.delete(callId);
    calls.set(callId, call);
    return (refused) => {
      call.running -= 1;
      const held = noticeCalls.get(senderId);
      if (held === undefined) return;
      if (refused && call.running === 0 && held.get(callId) === call) held.delete(callId);
      // As many as the Shell follows; one still running stays.
      for (const [oldId, old] of held) {
        if (held.size <= MAX_RELAY_NOTICE_STATUS_CALLS) break;
        if (old.running === 0) held.delete(oldId);
      }
      if (held.size === 0) noticeCalls.delete(senderId);
    };
  };

  const execute = async (
    spec: RelayMcpSessionSpec,
    payload: McpCallPayload,
    signal: AbortSignal
  ): Promise<McpCallAnswer> => {
    // Cancelled before it came (#17985): nothing is held or opened for it.
    if (signal.aborted) return CANCELLED_BEFORE;
    const release = holdPrincipal(spec.senderId, spec.helpSessionId, spec.conversationId);
    const endNoticeCall = relayCallArmsNotice(payload.tool, payload.args)
      ? startNoticeCall(spec.senderId, spec.helpSessionId, payload.callId)
      : null;
    let answer: McpCallAnswer | undefined;
    try {
      answer = await executeHeld(spec, payload, signal);
      return answer;
    } finally {
      // Refused or cancelled before it ran: it armed nothing, and its Shell forgets it too.
      endNoticeCall?.(
        answer?.status === "refused" ||
          (answer?.status === "cancelled" && answer.dispatch === "before")
      );
      release();
    }
  };

  const executeHeld = async (
    spec: RelayMcpSessionSpec,
    payload: McpCallPayload,
    signal?: AbortSignal
  ): Promise<McpCallAnswer> => {
    // The Shell times the call from when it sent it, so admitting it here
    // comes out of its run rather than on top of it (#15699).
    const deadline = now() + payload.runMs;
    if (!deps.acceptsRemoteControl()) return { status: "refused", reason: "control-off" };
    const hasProject = await deps.hasProject(payload.projectId);
    // A cancel taken meanwhile is the answer: nothing ran either way, and its resend reads that.
    if (signal?.aborted) return CANCELLED_BEFORE;
    if (!hasProject) return { status: "refused", reason: "no-project" };
    const found = await sessionFor(spec);
    if (signal?.aborted) return CANCELLED_BEFORE;
    if (found === null) return { status: "refused", reason: "server-off" };
    const { cached, session } = found;
    cached.inFlight += 1;
    cached.usedAt = now();
    try {
      const timeoutMs = deadline - now();
      if (timeoutMs <= 0) {
        return {
          status: "done",
          result: errorResult(new Error("The call's time ran out before it reached the tool")),
        };
      }
      const result = await session.callTool(payload.tool, payload.args, {
        timeoutMs,
        callId: payload.callId,
        ...(signal ? { signal } : {}),
      });
      return { status: "done", result: projectRelayResult(result) };
    } catch (error) {
      // The SDK's wait ended on the cancel: the tool heard it, and its own answer never comes.
      if (signal?.aborted) return CANCELLED_AFTER;
      return { status: "done", result: errorResult(error) };
    } finally {
      cached.inFlight -= 1;
      cached.usedAt = now();
      if (cached.retired && cached.inFlight === 0) session.close();
    }
  };

  const noticeStatus = async (
    senderId: string,
    calls: ReadonlyArray<{ helpSessionId: string; callId: string }>
  ): Promise<RelayNoticeStatusAnswer> => {
    const armed = new Map<string, ReadonlySet<string> | null>();
    const armedFor = async (helpSessionId: string): Promise<ReadonlySet<string> | null> => {
      if (!armed.has(helpSessionId)) {
        let read: ReadonlySet<string> | null;
        try {
          read = (await deps.watchingNoticeCalls?.(senderId, helpSessionId)) ?? new Set();
        } catch (error) {
          logger.warn("Couldn't read a relay principal's notices", { error });
          read = null;
        }
        armed.set(helpSessionId, read);
      }
      return armed.get(helpSessionId)!;
    };
    const pending = (helpSessionId: string, callId: string): boolean => {
      const call = noticeCalls.get(senderId)?.get(callId);
      return (
        (call?.helpSessionId === helpSessionId && call.running > 0) ||
        deps.waitingNoticeCalls?.(senderId, helpSessionId).has(callId) === true
      );
    };
    const answered: RelayNoticeStatusAnswer["calls"] = [];
    for (const { helpSessionId, callId } of calls) {
      let status: RelayNoticeStatusAnswer["calls"][number]["status"];
      if (pending(helpSessionId, callId)) {
        status = "watching";
      } else {
        // Unreadable reads as still watching: holding a link open costs less than a lost notice.
        const watching = await armedFor(helpSessionId);
        const call = noticeCalls.get(senderId)?.get(callId);
        if (watching === null || watching.has(callId) || pending(helpSessionId, callId)) {
          // Read again after the wait: a notice may have left for the outbox meanwhile.
          status = "watching";
        } else if (call === undefined || call.helpSessionId !== helpSessionId || call.lost) {
          status = "unknown";
        } else {
          status = "settled";
        }
      }
      answered.push({ helpSessionId, callId, status });
    }
    return { calls: answered };
  };

  // An unused session goes; one still running a call stays, however long it runs.
  const sweep = setInterval(() => {
    takeKept();
    const cutoff = now() - idleMs;
    for (const [key, cached] of sessions) {
      if (cached.inFlight === 0 && cached.usedAt < cutoff) closeCached(key, cached);
    }
    const forgotten = now() - RELAY_NOTICE_WINDOW_MS - NOTICE_CALL_MARGIN_MS;
    for (const [senderId, calls] of [...noticeCalls]) {
      for (const [callId, call] of [...calls]) {
        if (call.running === 0 && call.at < forgotten) calls.delete(callId);
      }
      if (calls.size === 0) noticeCalls.delete(senderId);
    }
    const stale = now() - RELAY_PRINCIPAL_RETENTION_MS;
    for (const [senderId, held] of [...principals]) {
      for (const [helpSessionId, { usedAt }] of [...held]) {
        if (usedAt < stale && !principalInUse(senderId, helpSessionId)) {
          retire(senderId, helpSessionId);
        }
      }
      boundPrincipals(senderId);
    }
    for (const [senderId, asleep] of [...dormant]) {
      for (const [conversationId, { usedAt }] of [...asleep]) {
        if (usedAt < stale) forgetConversation(senderId, conversationId);
      }
    }
    ledger.sweep();
  }, SWEEP_INTERVAL_MS);
  sweep.unref?.();

  return {
    call: async (spec, payload) => {
      const digest = canonicalArgsHash(payload.tool, {
        helpSessionId: payload.helpSessionId,
        // A callId resent naming another conversation is another call (#17919).
        ...(spec.conversationId !== undefined ? { conversationId: spec.conversationId } : {}),
        projectId: payload.projectId,
        tier: payload.tier,
        args: payload.args,
      });
      const answer = await ledger.run(
        spec.senderId,
        payload.callId,
        digest,
        payload.resend,
        (signal) => execute(spec, payload, signal),
        spec.helpSessionId
      );
      if (answer.status === "unknown") return { status: "unknown" } satisfies McpCallAnswer;
      if (answer.status === "conflict") return { status: "conflict" } satisfies McpCallAnswer;
      return answer.value;
    },
    read: async (spec, { tool, args, runMs }) => {
      if (relayCallArmsNotice(tool, args)) {
        return { status: "done", result: errorResult(new Error("A read can't ask for notices")) };
      }
      const release = holdPrincipal(spec.senderId, spec.helpSessionId, spec.conversationId);
      try {
        return await executeHeld(spec, {
          helpSessionId: spec.helpSessionId,
          projectId: spec.projectId,
          tier: spec.tier,
          callId: randomUUID(),
          resend: false,
          tool,
          args,
          runMs,
        });
      } finally {
        release();
      }
    },
    // Disposed, it runs nothing more and holds nothing for a later call.
    cancel: (senderId, helpSessionId, callId) =>
      disposed ? "ignored" : ledger.cancel(senderId, helpSessionId, callId),
    noticeStatus,
    noticesDropped: (senderId, callIds) => {
      for (const callId of callIds) {
        const call = noticeCalls.get(senderId)?.get(callId);
        if (call !== undefined) call.lost = true;
      }
    },
    // A call still running finishes first, so a resend can still read its answer.
    expireLink: (linkSessionId) => {
      expiredLinks.add(linkSessionId);
      if (expiredLinks.size > MAX_EXPIRED_LINKS) {
        expiredLinks.delete(expiredLinks.values().next().value!);
      }
      closeSessions((cached) => cached.linkSessionId === linkSessionId);
    },
    endPrincipal: (senderId, helpSessionId) => {
      const record = principals.get(senderId)?.get(helpSessionId);
      if (record !== undefined) record.ended = true;
      // A session still opening is the call that opened it's to serve, then close.
      closeSessions(
        (cached) =>
          cached.senderId === senderId &&
          cached.helpSessionId === helpSessionId &&
          cached.session !== null
      );
      // One still running or admitting a call keeps its hold until that call settles.
      if (record !== undefined && !principalInUse(senderId, helpSessionId)) {
        retireEnded(senderId, helpSessionId, record);
      }
    },
    dispose: () => {
      disposed = true;
      clearInterval(sweep);
      for (const [key, cached] of [...sessions]) closeCached(key, cached);
      // Nothing here will retire them later: the holds go with the executor.
      for (const [senderId, held] of [...principals]) {
        for (const helpSessionId of [...held.keys()]) retire(senderId, helpSessionId);
      }
      for (const [senderId, asleep] of [...dormant]) {
        for (const conversationId of [...asleep.keys()])
          forgetConversation(senderId, conversationId);
      }
      ledger.clear();
      noticeCalls.clear();
    },
  };
}
