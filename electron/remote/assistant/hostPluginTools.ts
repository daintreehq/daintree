import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isGlobalPluginToolOperation } from "../../../shared/config/globalAssistant.js";
import type { AuditOutcome } from "../../services/mcp-server/auditLog.js";
import { createLogger } from "../../utils/logger.js";
import { answerPluginToolOperation, type LocalPluginTools } from "./localPluginTools.js";
import type { RelayMcpSession, RelayMcpSessionSpec } from "./mcpRelayExecutor.js";

const logger = createLogger("main:hostPluginTools");

/** The plugin tools a host's relayed sessions share, as `GlobalAssistantPluginTools` is. */
export interface HostPluginToolsAdapter extends LocalPluginTools {
  endSession(holder: string): void;
  dispose(): void;
}

/** How a host's relayed callers stand, as the adapter reads them before minting and dispatching. */
export interface HostPluginToolsPolicy {
  /** Whether the relayed session holding grants under this key may still reach plugins. */
  isSessionLive(holder: string): boolean;
  /** Why a change can't be made in the project for that session's Shell now, or null. */
  refuseWrite(projectId: string, holder: string): string | null;
}

/**
 * A relay session this host admitted (`McpRelaySessionHandle`): its own id,
 * and the gates and record its own tools' calls meet, for the two operations
 * answered beside it.
 */
export interface AdmittedRelaySession extends RelayMcpSession {
  readonly sessionId: string;
  /** Aborts once the session closes, whoever closed it. */
  readonly closed: AbortSignal;
  /** Why a change in its project can't be made for its Shell now, by its own write rule; null when it can. */
  refuseWrite(): string | null;
  /** Records a call answered beside the session as one of its own: attributed to its Shell, values kept out. */
  recordCall(call: {
    toolId: string;
    args: unknown;
    startedAt: number;
    callId: string;
    outcome: AuditOutcome;
  }): void;
}

export interface HostPluginToolsDeps {
  /** Built on the first plugin operation any relayed session makes here. */
  createTools(policy: HostPluginToolsPolicy): Promise<HostPluginToolsAdapter>;
  /**
   * Whether that Shell could still change the project now, read without
   * telling the lease a change is coming; absent, a drive move ends nothing.
   */
  mayStillChange?(projectId: string, linkSessionId: string): boolean;
  now?: () => number;
}

export interface HostPluginTools {
  /**
   * Answers the two operations for another machine's global Assistant inside
   * the session this host admitted for it; any other session passes through.
   */
  decorate(session: AdmittedRelaySession, spec: RelayMcpSessionSpec): RelayMcpSession;
  /** The Shell said this help session of its sender ended: what it held goes, and it gets no more. */
  endHelpSession(senderId: string, helpSessionId: string): void;
  /**
   * A Shell's link can't resume: the plugin grants of its sessions go now,
   * aborting what runs under them, though the relay lets its other calls drain.
   */
  expireLink(linkSessionId: string): void;
  /**
   * This host stopped letting other machines' assistants work here: every
   * relayed grant goes now, so nothing queued under one starts. Each is
   * minted again on a later call once the host lets them back.
   */
  consentWithdrawn(): void;
  /**
   * Some project's drive target may have moved: a session whose Shell could
   * change its project and no longer can loses its grants, so nothing queued
   * under one (a database write waiting for a slot) starts under another
   * machine's lease or a reservation. One that couldn't change it keeps its
   * reads. Minted again on a later call, which the write rule judges afresh.
   */
  driveTargetChanged(): void;
  dispose(): void;
}

interface Holder {
  readonly pair: string;
  readonly projectId: string;
  readonly linkSessionId: string;
  readonly session: AdmittedRelaySession;
  readonly stillAccepted: (() => boolean) | undefined;
  /** Closed, its link expired, or its help session ended: it never holds a grant again. */
  ended: boolean;
  /** Whether its Shell could change the project when last read. */
  mayChange: boolean;
}

const SESSION_ENDED = "This assistant session has ended. Nothing was run.";

/**
 * Help sessions a release fences off, and links an expiry did, remembered for
 * a session of one admitted after its end. A holder that already existed is
 * ended for good, whatever later crowds these out.
 */
const MAX_ENDED_HELP_SESSIONS = 1024;
const MAX_EXPIRED_LINKS = 256;

function pairOf(senderId: string, helpSessionId: string): string {
  return `${senderId}\u0000${helpSessionId}`;
}

function remember(set: Set<string>, value: string, max: number): void {
  set.delete(value);
  set.add(value);
  if (set.size > max) set.delete(set.values().next().value!);
}

/**
 * Grants are held by the relayed session, under a key this host mints and no
 * help session id can spell, so two Shells naming the same help session, or
 * this machine's own global Assistant, never share one.
 */
function holderOf(session: AdmittedRelaySession): string {
  return `relay-mcp\u0000${session.sessionId}`;
}

function auditOutcomeOf(result: CallToolResult): AuditOutcome {
  return result.isError === true
    ? {
        kind: "result",
        value: {
          ok: false,
          error: { code: "EXECUTION_ERROR", message: "The plugin tool answered with an error." },
        },
      }
    : { kind: "result", value: { ok: true, result: null } };
}

/**
 * A host's side of the global Assistant's plugin tool operations (#18256):
 * another machine's global Assistant lists and calls the plugin agent tools
 * this host's project allows its Assistant, through the relay session this
 * host admitted for it. The grants are this host's, read against its own
 * remote-control consent and the project's Agent tools answer at every list,
 * mint and dispatch. They go when that session closes, its Shell's link
 * expires, its Shell says the help session ended, or the host withdraws consent.
 */
export function createHostPluginTools(deps: HostPluginToolsDeps): HostPluginTools {
  const now = deps.now ?? Date.now;
  const holders = new Map<string, Holder>();
  const endedPairs = new Set<string>();
  const expiredLinks = new Set<string>();
  let disposed = false;
  let tools: Promise<HostPluginToolsAdapter> | undefined;

  const policy: HostPluginToolsPolicy = {
    isSessionLive: (key) => {
      const holder = holders.get(key);
      return (
        !disposed &&
        holder !== undefined &&
        !holder.ended &&
        holder.session.isOpen() &&
        holder.stillAccepted?.() === true
      );
    },
    refuseWrite: (_projectId, key) => {
      const holder = holders.get(key);
      if (holder === undefined || holder.ended) return SESSION_ENDED;
      const refused = holder.session.refuseWrite();
      // A change allowed now is standing a later move can take away.
      if (refused === null) holder.mayChange = true;
      return refused;
    },
  };

  const adapter = (): Promise<HostPluginToolsAdapter> => {
    if (disposed) return Promise.reject(new Error(SESSION_ENDED));
    tools ??= deps.createTools(policy).then(
      (built) => {
        // Built after the relay went: nothing is left to hold it.
        if (disposed) {
          built.dispose();
          throw new Error(SESSION_ENDED);
        }
        return built;
      },
      (error: unknown) => {
        tools = undefined;
        throw error;
      }
    );
    return tools;
  };

  const release = (key: string): void => {
    void tools?.then((built) => built.endSession(key)).catch(() => {});
  };

  /** Its standing now, and whether it just lost the standing to change its project. */
  const noteStanding = (holder: Holder): boolean => {
    const mayStillChange = deps.mayStillChange;
    if (mayStillChange === undefined) return false;
    const was = holder.mayChange;
    holder.mayChange = mayStillChange(holder.projectId, holder.linkSessionId);
    return was && !holder.mayChange;
  };

  /** Ended for good: what it holds goes, and it is never live again. */
  const end = (key: string, holder: Holder): void => {
    if (holder.ended) return;
    holder.ended = true;
    if (holders.get(key) === holder) holders.delete(key);
    release(key);
  };

  return {
    decorate: (session, spec) => {
      if (spec.global !== true || spec.local === true) return session;
      const key = holderOf(session);
      const pair = pairOf(spec.senderId, spec.helpSessionId);
      const holder: Holder = {
        pair,
        projectId: spec.projectId,
        linkSessionId: spec.linkSessionId,
        session,
        stillAccepted: spec.stillAccepted,
        // Admitted after its help session or link ended: it never holds one.
        ended: disposed || endedPairs.has(pair) || expiredLinks.has(spec.linkSessionId),
        mayChange: false,
      };
      noteStanding(holder);
      if (!holder.ended) {
        holders.set(key, holder);
        // Closed underneath, as when the MCP server stops: its grants go with it.
        if (session.closed.aborted) end(key, holder);
        else session.closed.addEventListener("abort", () => end(key, holder), { once: true });
      }
      return {
        isOpen: () => session.isOpen(),
        close: () => {
          end(key, holder);
          session.close();
        },
        callTool: async (tool, args, options) => {
          if (!isGlobalPluginToolOperation(tool)) return session.callTool(tool, args, options);
          // Read as the operation starts, so a write it queues is one a later move ends.
          noteStanding(holder);
          const startedAt = now();
          let outcome: AuditOutcome | undefined;
          try {
            const result = await answerPluginToolOperation(
              adapter,
              key,
              spec.projectId,
              tool,
              args,
              options
            );
            outcome = auditOutcomeOf(result);
            return result;
          } catch (error) {
            outcome = { kind: "throw", error };
            throw error;
          } finally {
            try {
              session.recordCall({
                toolId: tool,
                args,
                startedAt,
                callId: options.callId,
                outcome: outcome!,
              });
            } catch (error) {
              logger.warn("Couldn't record a relayed plugin tool call", { error });
            }
          }
        },
      };
    },
    endHelpSession: (senderId, helpSessionId) => {
      if (disposed) return;
      const pair = pairOf(senderId, helpSessionId);
      remember(endedPairs, pair, MAX_ENDED_HELP_SESSIONS);
      for (const [key, holder] of [...holders]) {
        if (holder.pair === pair) end(key, holder);
      }
    },
    expireLink: (linkSessionId) => {
      if (disposed) return;
      remember(expiredLinks, linkSessionId, MAX_EXPIRED_LINKS);
      for (const [key, holder] of [...holders]) {
        if (holder.linkSessionId === linkSessionId) end(key, holder);
      }
    },
    consentWithdrawn: () => {
      if (disposed) return;
      for (const key of holders.keys()) release(key);
    },
    driveTargetChanged: () => {
      if (disposed) return;
      for (const [key, holder] of holders) {
        if (noteStanding(holder)) release(key);
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const holder of holders.values()) holder.ended = true;
      holders.clear();
      endedPairs.clear();
      expiredLinks.clear();
      void tools?.then((built) => built.dispose()).catch(() => {});
    },
  };
}
