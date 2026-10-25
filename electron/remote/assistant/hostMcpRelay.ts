import { AppError } from "../../utils/errorTypes.js";
import type { LinkSession } from "../link/session.js";
import type { MetricsSessionContext, MetricsSessionSource } from "../metrics/hostMetricsHost.js";
import {
  AssistantLinkMethod,
  McpCallPayloadSchema,
  RelayNoticeStatusPayloadSchema,
  ThrowawayCallPayloadSchema,
  ThrowawayReleasePayloadSchema,
} from "./linkMethods.js";
import {
  createMcpRelayExecutor,
  type McpRelayExecutorDeps,
  type RelayMcpSessionSpec,
} from "./mcpRelayExecutor.js";
import { RelayNoticeOutbox } from "./relayNoticeOutbox.js";
import type { SenderSessions } from "./senderSessions.js";
import { askShellApproval } from "./relayApprovals.js";
import { createThrowawayRelay, type HostThrowawayExecutor } from "./throwawayRelay.js";

export {
  projectRelayResult,
  type RelayMcpSession,
  type RelayMcpSessionSpec,
} from "./mcpRelayExecutor.js";

export interface HostMcpRelayDeps extends Omit<McpRelayExecutorDeps, "waitingNoticeCalls"> {
  /** Read at each call: the sender host registers it with the authenticate call. */
  senders(): Pick<SenderSessions, "senderOf" | "senderOfSessionId"> | undefined;
  /** This host's throwaway runs (#14445), read at each call; absent or null, they are off. */
  throwawayRuns?(): HostThrowawayExecutor | null;
}

export interface HostMcpRelaySource extends MetricsSessionSource {
  /** A session's link dropped; it may still resume within its grace window. */
  onSessionDetached?(listener: (info: { sessionId: string }) => void): () => void;
  onSessionExpired(listener: (info: { sessionId: string }) => void): () => void;
}

/**
 * How long a Shell's throwaway runs outlast its last link dropping (#14447):
 * room for a quick resume, well inside a run's default time limit.
 */
export const THROWAWAY_SHELL_GONE_GRACE_MS = 30_000;

function noSender(): AppError {
  return new AppError({
    code: "PERMISSION",
    message: "This session hasn't authenticated an assistant sender",
  });
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
  // What relayed calls ask to hear about goes back to their Shell's sender,
  // over whichever of its sessions is open when it fires.
  const notices = new RelayNoticeOutbox({
    server,
    senders: () => deps.senders(),
    now: deps.now ?? Date.now,
    onDropped: (senderId, dropped) =>
      runner.noticesDropped(
        senderId,
        dropped.map(({ callId }) => callId)
      ),
  });
  const runner = createMcpRelayExecutor({
    ...deps,
    waitingNoticeCalls: (senderId, helpSessionId) => notices.waitingCalls(senderId, helpSessionId),
  });
  // Throwaway runs belong to the host, not a project: no session, project or view is opened.
  const throwaway = createThrowawayRelay({
    acceptsRemoteControl: deps.acceptsRemoteControl,
    executor: () => deps.throwawayRuns?.() ?? null,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const wired = new WeakSet<LinkSession>();
  let disposed = false;
  // The sender each link made throwaway calls for, held here since the
  // sender bindings forget a link as it expires, before this hears of it.
  const throwawayLinks = new Map<string, string>();
  const shellGoneTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const senderLinked = (senderId: string): boolean =>
    server.sessions.some(
      (ctx) =>
        ctx.session.isOpen &&
        (deps.senders()?.senderOf(ctx.session) === senderId ||
          throwawayLinks.get(ctx.sessionId) === senderId)
    );
  const cancelShellGone = (senderId: string): void => {
    clearTimeout(shellGoneTimers.get(senderId));
    shellGoneTimers.delete(senderId);
  };
  // Nobody is left to close what a Shell with no link here launched, so its runs go.
  const endShellGone = (senderId: string): void => {
    cancelShellGone(senderId);
    if (senderLinked(senderId)) return;
    deps.throwawayRuns?.()?.endOwner({ senderId }, "shell-gone");
  };

  const liveLink = (linkSessionId: string): LinkSession | null => {
    for (const ctx of server.sessions) {
      if (ctx.sessionId === linkSessionId && ctx.session.isOpen) return ctx.session;
    }
    return null;
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
        // This session proved the sender, so what waited for it can go over it.
        notices.flushSender(senderId);
        const spec: RelayMcpSessionSpec = {
          linkSessionId: sessionId,
          senderId,
          helpSessionId: payload.helpSessionId,
          projectId: payload.projectId,
          tier: payload.tier,
          shellName: client?.clientName || "Remote Shell",
          deliverNotices: (fired) => notices.enqueue(senderId, fired),
          // Asked over whichever session is live for this link when the call needs it.
          requestApproval: (ask) =>
            askShellApproval(liveLink(sessionId), {
              ...ask,
              helpSessionId: payload.helpSessionId,
              projectId: payload.projectId,
            }),
        };
        return runner.call(spec, payload);
      }
    );
    session.registerCallHandler(
      AssistantLinkMethod.THROWAWAY_CALL,
      ThrowawayCallPayloadSchema,
      async (payload) => {
        if (disposed) throw noSender();
        const senderId = deps.senders()?.senderOf(session);
        if (!senderId) throw noSender();
        notices.flushSender(senderId);
        throwawayLinks.set(sessionId, senderId);
        cancelShellGone(senderId);
        return throwaway.call(senderId, payload);
      }
    );
    session.registerCallHandler(
      AssistantLinkMethod.THROWAWAY_RELEASE,
      ThrowawayReleasePayloadSchema,
      (payload) => {
        if (disposed) throw noSender();
        const senderId = deps.senders()?.senderOf(session);
        if (!senderId) throw noSender();
        deps
          .throwawayRuns?.()
          ?.endOwner({ senderId, helpSessionId: payload.helpSessionId }, "session-ended");
        return {};
      }
    );
    session.registerCallHandler(
      AssistantLinkMethod.RELAY_NOTICE_STATUS,
      RelayNoticeStatusPayloadSchema,
      (payload) => {
        if (disposed) throw noSender();
        const senderId = deps.senders()?.senderOf(session);
        if (!senderId) throw noSender();
        notices.flushSender(senderId);
        return runner.noticeStatus(senderId, payload.calls);
      }
    );
  };

  for (const ctx of server.sessions) wire(ctx);
  const offSession = server.onSession(wire);
  // A Shell that can't resume its link takes its sessions with it; a new one opens its
  // own. A call still running finishes first, so a resend can still read its answer.
  // The notices its calls armed stay: they belong to its sender and help session,
  // which the Shell's next session proves again (#13930).
  const offDetached =
    server.onSessionDetached?.(({ sessionId }) => {
      const senderId = throwawayLinks.get(sessionId);
      if (senderId === undefined || senderLinked(senderId) || shellGoneTimers.has(senderId)) {
        return;
      }
      const timer = setTimeout(() => endShellGone(senderId), THROWAWAY_SHELL_GONE_GRACE_MS);
      timer.unref?.();
      shellGoneTimers.set(senderId, timer);
    }) ?? (() => {});
  const offExpired = server.onSessionExpired(({ sessionId }) => {
    runner.expireLink(sessionId);
    const senderId = throwawayLinks.get(sessionId);
    throwawayLinks.delete(sessionId);
    if (senderId !== undefined) endShellGone(senderId);
  });

  return {
    dispose: () => {
      disposed = true;
      offSession();
      offDetached();
      offExpired();
      for (const timer of shellGoneTimers.values()) clearTimeout(timer);
      shellGoneTimers.clear();
      throwawayLinks.clear();
      notices.dispose();
      runner.dispose();
      throwaway.dispose();
    },
  };
}
