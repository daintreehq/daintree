import { McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { canonicalArgsHash } from "../../services/mcp-server/sessionDedup.js";
import { AppError } from "../../utils/errorTypes.js";
import type { LinkSession } from "../link/session.js";
import type { MetricsSessionContext, MetricsSessionSource } from "../metrics/hostMetricsHost.js";
import {
  AssistantLinkMethod,
  MAX_RELAY_RESULT_BYTES,
  McpCallPayloadSchema,
  type McpCallAnswer,
  type McpCallPayload,
} from "./linkMethods.js";
import { RelayCallLedger } from "./relayCallLedger.js";
import type { SenderSessions } from "./senderSessions.js";

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

export interface HostMcpRelayDeps {
  /** Read at each call: the exchange host registers it with the authenticate call. */
  senders(): Pick<SenderSessions, "senderOf"> | undefined;
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
  now?: () => number;
  /** How long an unused session stays open. */
  idleMs?: number;
}

export interface HostMcpRelaySource extends MetricsSessionSource {
  onSessionExpired(listener: (info: { sessionId: string }) => void): () => void;
}

const RELAY_SESSION_IDLE_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
/** How long a Shell assistant's hold on what it made here outlasts its last call. */
const RELAY_PRINCIPAL_RETENTION_MS = 24 * 60 * 60_000;
/** Help sessions one Shell's sender holds things here for at once; the least recent go first. */
const RELAY_PRINCIPALS_PER_SENDER = 64;
/** Ended links remembered, for calls still being admitted when theirs went. */
const MAX_EXPIRED_LINKS = 256;

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

function noSender(): AppError {
  return new AppError({
    code: "PERMISSION",
    message: "This session hasn't authenticated an assistant sender",
  });
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
 * A tool's MCP result as the Shell carries it: its structured half when it
 * has one, else its text. One too large to carry whole is cut, saying that
 * the call ran, so nobody runs it again to see the rest.
 */
export function projectRelayResult(
  result: CallToolResult
): Extract<McpCallAnswer, { status: "done" }>["result"] {
  const isError = result.isError === true;
  const structured =
    result.structuredContent !== null &&
    typeof result.structuredContent === "object" &&
    !Array.isArray(result.structuredContent)
      ? result.structuredContent
      : null;
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
 * The host's side of `host.call` (#13493): each authenticated Shell may run
 * this host's own MCP tools for one of its assistants. Every call goes
 * through a real MCP session this host admits for that Shell's sender and
 * help session, bound to one project, so its tier, grants, ownership, drive
 * lease and audit are this host's own gates, not the relay's. Calls are at
 * most once per callId (see RelayCallLedger); a session goes once unused,
 * and with the link session it was opened for.
 */
export function installHostMcpRelay(
  server: HostMcpRelaySource,
  deps: HostMcpRelayDeps
): {
  dispose(): void;
} {
  const now = deps.now ?? Date.now;
  const idleMs = deps.idleMs ?? RELAY_SESSION_IDLE_MS;
  const ledger = new RelayCallLedger<McpCallAnswer>({ now });
  const sessions = new Map<string, CachedSession>();
  // Links that can't resume, for a call that was still being admitted when its link went.
  const expiredLinks = new Set<string>();
  // Each relay principal this host admitted, by sender then help session, with its last call.
  const principals = new Map<string, Map<string, number>>();
  // Running a call, still opening, or open: a closed one waiting to be swept holds nothing.
  const principalInUse = (senderId: string, helpSessionId: string): boolean =>
    [...sessions.values()].some(
      (cached) =>
        cached.senderId === senderId &&
        cached.helpSessionId === helpSessionId &&
        (cached.inFlight > 0 || cached.session === null || cached.session.isOpen())
    );
  const retire = (senderId: string, helpSessionId: string): void => {
    const held = principals.get(senderId);
    held?.delete(helpSessionId);
    if (held?.size === 0) principals.delete(senderId);
    try {
      deps.retirePrincipal?.(senderId, helpSessionId);
    } catch (error) {
      console.warn("[HostMcpRelay] Couldn't retire a relay principal:", error);
    }
  };
  const touchPrincipal = (senderId: string, helpSessionId: string): void => {
    let held = principals.get(senderId);
    if (!held) {
      held = new Map();
      principals.set(senderId, held);
    }
    held.delete(helpSessionId);
    held.set(helpSessionId, now());
    // Least recent first, in insertion order; one with a session open stays.
    for (const other of [...held.keys()]) {
      if (held.size <= RELAY_PRINCIPALS_PER_SENDER) break;
      if (other !== helpSessionId && !principalInUse(senderId, other)) retire(senderId, other);
    }
  };
  const wired = new WeakSet<LinkSession>();
  let disposed = false;

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

  const sessionFor = async (
    spec: RelayMcpSessionSpec
  ): Promise<{ cached: CachedSession; session: RelayMcpSession } | null> => {
    const key = [
      spec.linkSessionId,
      spec.senderId,
      spec.helpSessionId,
      spec.projectId,
      spec.tier,
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
    // Its link ended while this was being admitted: serve this call, then close.
    if (expiredLinks.has(spec.linkSessionId)) {
      if (sessions.get(key) === cached) sessions.delete(key);
      cached.retired = true;
    }
    return { cached, session: opened };
  };

  const execute = async (
    spec: RelayMcpSessionSpec,
    payload: McpCallPayload
  ): Promise<McpCallAnswer> => {
    if (!deps.acceptsRemoteControl()) return { status: "refused", reason: "control-off" };
    if (!(await deps.hasProject(payload.projectId))) {
      return { status: "refused", reason: "no-project" };
    }
    touchPrincipal(spec.senderId, spec.helpSessionId);
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

  const wire = ({ session, sessionId, client }: MetricsSessionContext): void => {
    if (wired.has(session)) return;
    wired.add(session);
    session.registerCallHandler(
      AssistantLinkMethod.MCP_CALL,
      McpCallPayloadSchema,
      async (payload) => {
        if (disposed) throw noSender();
        const senderId = deps.senders()?.senderOf(session);
        if (!senderId) throw noSender();
        const spec: RelayMcpSessionSpec = {
          linkSessionId: sessionId,
          senderId,
          helpSessionId: payload.helpSessionId,
          projectId: payload.projectId,
          tier: payload.tier,
          shellName: client?.clientName || "Remote Shell",
        };
        const digest = canonicalArgsHash(payload.tool, {
          helpSessionId: payload.helpSessionId,
          projectId: payload.projectId,
          tier: payload.tier,
          args: payload.args,
        });
        const answer = await ledger.run(senderId, payload.callId, digest, payload.resend, () =>
          execute(spec, payload)
        );
        if (answer.status === "unknown") return { status: "unknown" } satisfies McpCallAnswer;
        if (answer.status === "conflict") return { status: "conflict" } satisfies McpCallAnswer;
        return answer.value;
      }
    );
  };

  // An unused session goes; one still running a call stays, however long it runs.
  const sweep = setInterval(() => {
    const cutoff = now() - idleMs;
    for (const [key, cached] of sessions) {
      if (cached.inFlight === 0 && cached.usedAt < cutoff) closeCached(key, cached);
    }
    const stale = now() - RELAY_PRINCIPAL_RETENTION_MS;
    for (const [senderId, held] of [...principals]) {
      for (const [helpSessionId, usedAt] of [...held]) {
        if (usedAt < stale && !principalInUse(senderId, helpSessionId)) {
          retire(senderId, helpSessionId);
        }
      }
    }
    ledger.sweep();
  }, SWEEP_INTERVAL_MS);
  sweep.unref?.();

  for (const ctx of server.sessions) wire(ctx);
  const offSession = server.onSession(wire);
  // A Shell that can't resume its link takes its sessions with it; a new one opens its
  // own. A call still running finishes first, so a resend can still read its answer.
  const offExpired = server.onSessionExpired(({ sessionId }) => {
    expiredLinks.add(sessionId);
    if (expiredLinks.size > MAX_EXPIRED_LINKS) {
      expiredLinks.delete(expiredLinks.values().next().value!);
    }
    for (const [key, cached] of [...sessions]) {
      if (cached.linkSessionId !== sessionId) continue;
      sessions.delete(key);
      if (cached.inFlight > 0) cached.retired = true;
      else closeCached(key, cached);
    }
  });

  return {
    dispose: () => {
      disposed = true;
      clearInterval(sweep);
      offSession();
      offExpired();
      for (const [key, cached] of [...sessions]) closeCached(key, cached);
      ledger.clear();
    },
  };
}
