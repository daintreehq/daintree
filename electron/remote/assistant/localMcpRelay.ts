import { randomUUID } from "node:crypto";
import { LOCAL_HOST_ID } from "../../../shared/types/remoteHosts.js";
import type { LinkSession } from "../link/session.js";
import type {
  McpCallAnswer,
  RelayApproveAnswer,
  RelayApprovePayload,
  RelayCallRequest,
  RelayNoticesPayload,
  ThrowawayCallAnswer,
  ThrowawayCallPayload,
} from "./linkMethods.js";
import {
  createMcpRelayExecutor,
  type McpRelayExecutorDeps,
  type RelayMcpSessionSpec,
} from "./mcpRelayExecutor.js";
import { askShellApproval } from "./relayApprovals.js";
import { createThrowawayRelay, type HostThrowawayExecutor } from "./throwawayRelay.js";

/**
 * The sender and link session a local call is admitted under. A remote
 * sender is a hex digest and a link session a host-minted id, so neither
 * can spell these; neither grants anything either, only `local` does.
 */
export const LOCAL_RELAY_SENDER_ID = LOCAL_HOST_ID;
export const LOCAL_RELAY_LINK_SESSION_ID = LOCAL_HOST_ID;

export interface LocalMcpRelayDeps extends Pick<
  McpRelayExecutorDeps,
  "hasProject" | "openSession" | "retirePrincipal" | "now" | "idleMs"
> {
  /** This machine's name, as the prompts its assistants send say where they came from. */
  machineName(): string;
  /** Takes the notices a local call armed, as a host's arrive over its link. */
  receiveNotices(payload: RelayNoticesPayload): void;
  /** Ends what the person handed one of this machine's help sessions (#14161). */
  releaseHandOvers?(helpSessionId: string): void;
  /** Puts one confirm-gated local call to the person, as a host's question would be. */
  receiveApproval(payload: RelayApprovePayload): Promise<RelayApproveAnswer>;
  /** This machine's throwaway runs (#14445), read at each call; absent or null, they are off. */
  throwawayRuns?(): HostThrowawayExecutor | null;
  newId?: () => string;
}

export interface LocalMcpRelay {
  relayCall(request: RelayCallRequest): Promise<McpCallAnswer>;
  /** A throwaway tool on this machine (#14446), with no project, session or view. */
  throwawayCall(payload: ThrowawayCallPayload): Promise<ThrowawayCallAnswer>;
  /**
   * One of this machine's help sessions ended: its sessions, its hold on what
   * it made and its throwaway runs go.
   */
  endHelpSession(helpSessionId: string): void;
  dispose(): void;
}

/**
 * `host.call` for this machine's own id (#14024): one of its assistants
 * reaching another of its projects through the same gates another machine's
 * assistant meets here, in process and with no link. Each call runs in a real
 * MCP session this machine admits for the caller's help session, bound to the
 * one project: `external` origin, so only the owned tools act, and only on
 * what that assistant made through these calls. The notices and approvals its
 * calls arm go to the runtime the way a host's come back over a link, so they
 * are checked against the run that made the call just as a host's are.
 */
export function createLocalMcpRelay(deps: LocalMcpRelayDeps): LocalMcpRelay {
  const newId = deps.newId ?? randomUUID;
  const executor = createMcpRelayExecutor({
    // The person here consents to their own assistants by running one.
    acceptsRemoteControl: () => true,
    hasProject: deps.hasProject,
    openSession: deps.openSession,
    ...(deps.retirePrincipal ? { retirePrincipal: deps.retirePrincipal } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.idleMs !== undefined ? { idleMs: deps.idleMs } : {}),
  });
  const throwaway = createThrowawayRelay({
    acceptsRemoteControl: () => true,
    executor: () => deps.throwawayRuns?.() ?? null,
    ...(deps.now ? { now: deps.now } : {}),
  });
  // What `askShellApproval` asks over a link, asked of this machine's runtime instead.
  const approvals: Pick<LinkSession, "call"> = {
    call: async (_method, payload) => deps.receiveApproval(payload as RelayApprovePayload),
  };
  let disposed = false;
  return {
    relayCall: async (payload) => {
      if (disposed) return { status: "refused", reason: "server-off" };
      const spec: RelayMcpSessionSpec = {
        linkSessionId: LOCAL_RELAY_LINK_SESSION_ID,
        senderId: LOCAL_RELAY_SENDER_ID,
        helpSessionId: payload.helpSessionId,
        projectId: payload.projectId,
        tier: payload.tier,
        shellName: deps.machineName(),
        local: true,
        ...(payload.global === true ? { global: true as const } : {}),
        deliverNotices: (fired) => {
          if (disposed || fired.length === 0) return;
          deps.receiveNotices({
            notices: fired.map((notice) => ({
              noticeId: newId(),
              helpSessionId: notice.helpSessionId,
              callId: notice.callId,
              terminalId: notice.terminalId,
              observation: notice.observation,
              ...(notice.awaitingHandback === true ? { awaitingHandback: true } : {}),
            })),
          });
        },
        requestApproval: (ask) =>
          askShellApproval(disposed ? null : approvals, {
            ...ask,
            helpSessionId: payload.helpSessionId,
            projectId: payload.projectId,
          }),
      };
      return executor.call(spec, payload);
    },
    throwawayCall: async (payload) => {
      if (disposed) return { status: "refused", reason: "throwaway-off" };
      return throwaway.call(LOCAL_RELAY_SENDER_ID, payload);
    },
    endHelpSession: (helpSessionId) => {
      deps.releaseHandOvers?.(helpSessionId);
      // Its throwaway runs go now, not at their time limits (#14447).
      deps
        .throwawayRuns?.()
        ?.endOwner({ senderId: LOCAL_RELAY_SENDER_ID, helpSessionId }, "session-ended");
      executor.endPrincipal(LOCAL_RELAY_SENDER_ID, helpSessionId);
    },
    dispose: () => {
      disposed = true;
      executor.dispose();
      throwaway.dispose();
    },
  };
}
