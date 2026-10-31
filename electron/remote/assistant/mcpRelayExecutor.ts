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
import { RelayCallLedger } from "./relayCallLedger.js";
import {
  relayCallArmsNotice,
  type RelayedNotice,
} from "../../services/mcp-server/terminalNotify.js";
import type { McpRelayCaller } from "../../services/mcp-server/shared.js";
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
    shellName: spec.shellName,
    ...(spec.local === true ? { local: true as const } : {}),
    ...(spec.global === true ? { global: true as const } : {}),
    deliverNotices: spec.deliverNotices,
    requestApproval: spec.requestApproval,
  };
}

/** One MCP session this host admitted for a relay principal and project. */
export interface RelayMcpSession {
  isOpen(): boolean;
  callTool(
    tool: string,
    args: Record<string, unknown>,
    options: { timeoutMs: number; callId: string }
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
   * enough or crowded out; the terminals and worktrees themselves stay.
   */
  retirePrincipal?(senderId: string, helpSessionId: string): void;
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
    Map<string, { usedAt: number; running: number; ended?: boolean }>
  >();
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
  const retire = (senderId: string, helpSessionId: string): void => {
    const held = principals.get(senderId);
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
      deps.retirePrincipal?.(senderId, helpSessionId);
    } catch (error) {
      logger.warn("Couldn't retire a relay principal", { error });
    }
  };
  /** Retires the least recent of a sender's principals past its bound; one in use stays. */
  const boundPrincipals = (senderId: string): void => {
    const held = principals.get(senderId);
    if (!held) return;
    for (const helpSessionId of [...held.keys()]) {
      if (held.size <= RELAY_PRINCIPALS_PER_SENDER) return;
      if (!principalInUse(senderId, helpSessionId)) retire(senderId, helpSessionId);
    }
  };
  /** Held from before admission until the call settles, wherever its session went meanwhile. */
  const holdPrincipal = (senderId: string, helpSessionId: string): (() => void) => {
    let held = principals.get(senderId);
    if (!held) {
      held = new Map();
      principals.set(senderId, held);
    }
    const record = held.get(helpSessionId) ?? { usedAt: now(), running: 0 };
    held.delete(helpSessionId);
    record.usedAt = now();
    record.running += 1;
    held.set(helpSessionId, record);
    boundPrincipals(senderId);
    return () => {
      record.running -= 1;
      record.usedAt = now();
      if (
        record.ended === true &&
        principals.get(senderId)?.get(helpSessionId) === record &&
        !principalInUse(senderId, helpSessionId)
      ) {
        retire(senderId, helpSessionId);
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
    payload: McpCallPayload
  ): Promise<McpCallAnswer> => {
    const release = holdPrincipal(spec.senderId, spec.helpSessionId);
    const endNoticeCall = relayCallArmsNotice(payload.tool, payload.args)
      ? startNoticeCall(spec.senderId, spec.helpSessionId, payload.callId)
      : null;
    let answer: McpCallAnswer | undefined;
    try {
      answer = await executeHeld(spec, payload);
      return answer;
    } finally {
      // Refused before it ran: it armed nothing, and its Shell forgets it too.
      endNoticeCall?.(answer?.status === "refused");
      release();
    }
  };

  const executeHeld = async (
    spec: RelayMcpSessionSpec,
    payload: McpCallPayload
  ): Promise<McpCallAnswer> => {
    if (!deps.acceptsRemoteControl()) return { status: "refused", reason: "control-off" };
    if (!(await deps.hasProject(payload.projectId))) {
      return { status: "refused", reason: "no-project" };
    }
    const found = await sessionFor(spec);
    if (found === null) return { status: "refused", reason: "server-off" };
    const { cached, session } = found;
    cached.inFlight += 1;
    cached.usedAt = now();
    try {
      const result = await session.callTool(payload.tool, payload.args, {
        timeoutMs: payload.runMs,
        callId: payload.callId,
      });
      return { status: "done", result: projectRelayResult(result) };
    } catch (error) {
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
    ledger.sweep();
  }, SWEEP_INTERVAL_MS);
  sweep.unref?.();

  return {
    call: async (spec, payload) => {
      const digest = canonicalArgsHash(payload.tool, {
        helpSessionId: payload.helpSessionId,
        projectId: payload.projectId,
        tier: payload.tier,
        args: payload.args,
      });
      const answer = await ledger.run(spec.senderId, payload.callId, digest, payload.resend, () =>
        execute(spec, payload)
      );
      if (answer.status === "unknown") return { status: "unknown" } satisfies McpCallAnswer;
      if (answer.status === "conflict") return { status: "conflict" } satisfies McpCallAnswer;
      return answer.value;
    },
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
        retire(senderId, helpSessionId);
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
      ledger.clear();
      noticeCalls.clear();
    },
  };
}
