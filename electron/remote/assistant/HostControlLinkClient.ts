import type { HostId } from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import type { LinkSession } from "../link/session.js";
import {
  AssistantLinkMethod,
  McpCallAnswerSchema,
  RelayApprovePayloadSchema,
  RelayNoticeStatusAnswerSchema,
  RelayNoticesPayloadSchema,
  type McpCallAnswer,
  type McpCallPayload,
  type RelayApproveAnswer,
  type RelayApprovePayload,
  type RelayNoticeStatusAnswer,
  type RelayNoticeStatusPayload,
  type RelayNoticesPayload,
} from "./linkMethods.js";

/** What takes a host's notices, and follows the calls they belong to (#13500, #13930). */
export interface RelayNoticeReceiver {
  receiveNotices(hostId: HostId, payload: RelayNoticesPayload): null;
  /** The calls to a host whose notices are still awaited. */
  noticeCalls(hostId: HostId): RelayNoticeStatusPayload["calls"];
  receiveNoticeStatus(hostId: HostId, answer: RelayNoticeStatusAnswer): void;
}

export interface HostControlLinkClientDeps {
  /** This Shell's sender credential for a host, minted and saved before it is ever presented. */
  credential(hostId: HostId): string;
  /** The host's open session, connecting it if need be; null when the host can't be reached. */
  session(hostId: HostId): Promise<LinkSession | null>;
  onSessionOpened(listener: (hostId: HostId, session: LinkSession) => void): () => void;
  /** Takes what a host saw of terminals this Shell's assistants asked it about (#13500). */
  noticeReceiver?: () => RelayNoticeReceiver | undefined;
  /**
   * Answers a host asking the person here about one of this Shell's relayed
   * calls (#13501); absent, every ask is refused.
   */
  approvalReceiver?: () =>
    | {
        receiveApproval(hostId: HostId, payload: RelayApprovePayload): Promise<RelayApproveAnswer>;
      }
    | undefined;
  callTimeoutMs?: number;
  /** How long after a host's notices it is asked what it still holds. */
  noticeStatusDelayMs?: number;
}

const CALL_TIMEOUT_MS = 15_000;
/** Long enough for the host to have taken this Shell's answer to the notices it sent. */
const NOTICE_STATUS_DELAY_MS = 5_000;

/** Asking one session's host after its notices: one ask at a time, and one more if wanted meanwhile. */
interface NoticeFollow {
  asking: boolean;
  again: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

function isUnknownOutcome(error: unknown): boolean {
  const code = codeOf(error);
  return code === "OUTCOME_UNKNOWN" || code === "HOST_DISCONNECTED";
}

function unsupported(hostId: HostId, cause: unknown): AppError {
  return new AppError({
    code: "UNSUPPORTED",
    message: `Host ${hostId} can't run tools for this Shell's assistants`,
    userMessage: "This host needs a newer Daintree.",
    cause: cause instanceof Error ? cause : undefined,
  });
}

function unreachable(hostId: HostId): AppError {
  return new AppError({
    code: "HOST_DISCONNECTED",
    message: `Host ${hostId} is not connected`,
    userMessage: "Couldn't reach this host. Check that it is on and try again.",
  });
}

function invalidAnswer(hostId: HostId, method: string): AppError {
  return new AppError({
    code: "INTERNAL",
    message: `Host ${hostId} sent an invalid ${method} answer`,
  });
}

/**
 * The Shell's side of `host.call` (#13493): it proves this Shell's sender on
 * each session to a host before relaying a call there, and takes the notices
 * and approval questions the host sends back about those calls.
 */
export class HostControlLinkClient {
  private readonly authenticated = new WeakSet<LinkSession>();
  private readonly follows = new Map<LinkSession, NoticeFollow>();
  private readonly disposers: Array<() => void> = [];
  private disposed = false;
  private readonly timeoutMs: number;
  private readonly noticeStatusDelayMs: number;

  constructor(private readonly deps: HostControlLinkClientDeps) {
    this.timeoutMs = deps.callTimeoutMs ?? CALL_TIMEOUT_MS;
    this.noticeStatusDelayMs = deps.noticeStatusDelayMs ?? NOTICE_STATUS_DELAY_MS;
  }

  start(): void {
    this.disposers.push(
      this.deps.onSessionOpened((hostId, session) => {
        // Notices for calls this Shell's assistants made there; nobody to take them drops them.
        session.registerCallHandler(
          AssistantLinkMethod.RELAY_NOTICES,
          RelayNoticesPayloadSchema,
          (payload) => {
            if (this.disposed) return null;
            const taken = this.deps.noticeReceiver?.()?.receiveNotices(hostId, payload) ?? null;
            // Then ask what it still holds, so a call with nothing left lets the link go.
            this.followNoticesLater(hostId, session);
            return taken;
          }
        );
        // A host asking about a call one of this Shell's assistants is making
        // there; nobody to take it refuses it, which approves nothing.
        session.registerCallHandler(
          AssistantLinkMethod.RELAY_APPROVE,
          RelayApprovePayloadSchema,
          (payload): Promise<RelayApproveAnswer> | RelayApproveAnswer => {
            const receiver = this.disposed ? undefined : this.deps.approvalReceiver?.();
            return (
              receiver?.receiveApproval(hostId, payload) ?? {
                approvalId: payload.approvalId,
                argsHash: payload.argsHash,
                decision: "refused",
              }
            );
          }
        );
        // A new session after one the host couldn't resume: proving the sender
        // again lets the host send what it kept for this Shell, and asking
        // after the calls still awaited finds any it no longer holds (#13930).
        void this.followNotices(hostId, session);
      })
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const follow of this.follows.values()) clearTimeout(follow.timer);
    this.follows.clear();
  }

  private followNoticesLater(hostId: HostId, session: LinkSession): void {
    const follow = this.followOf(session);
    if (follow.timer !== undefined) return;
    follow.timer = setTimeout(() => {
      follow.timer = undefined;
      void this.followNotices(hostId, session);
    }, this.noticeStatusDelayMs);
    follow.timer.unref?.();
  }

  private followOf(session: LinkSession): NoticeFollow {
    let follow = this.follows.get(session);
    if (follow === undefined) {
      follow = { asking: false, again: false };
      this.follows.set(session, follow);
    }
    return follow;
  }

  /** Asks the host after the calls whose notices this Shell still awaits there. */
  private async followNotices(hostId: HostId, session: LinkSession): Promise<void> {
    const follow = this.followOf(session);
    if (follow.asking) {
      follow.again = true;
      return;
    }
    follow.asking = true;
    try {
      do {
        follow.again = false;
        await this.askNoticeStatus(hostId, session);
      } while (follow.again && !this.disposed && session.isOpen);
    } finally {
      follow.asking = false;
      if (follow.timer === undefined) this.follows.delete(session);
    }
  }

  private async askNoticeStatus(hostId: HostId, session: LinkSession): Promise<void> {
    const receiver = this.disposed ? undefined : this.deps.noticeReceiver?.();
    const calls = receiver?.noticeCalls(hostId) ?? [];
    if (receiver === undefined || calls.length === 0 || !session.isOpen) return;
    try {
      await this.authenticate(hostId, session);
      const parsed = RelayNoticeStatusAnswerSchema.safeParse(
        await this.call(hostId, session, AssistantLinkMethod.RELAY_NOTICE_STATUS, { calls })
      );
      if (!parsed.success) throw invalidAnswer(hostId, AssistantLinkMethod.RELAY_NOTICE_STATUS);
      if (!this.disposed) receiver.receiveNoticeStatus(hostId, parsed.data);
    } catch (error) {
      // A host from before this can't say; its link still stays open for them.
      if (codeOf(error) === "UNSUPPORTED") return;
      console.warn("[HostControl] Couldn't ask a host after its notices:", error);
    }
  }

  /**
   * Run one of the host's own MCP tools for one of this Shell's assistants
   * (#13493), once this Shell's sender is proven on the session. The host
   * records the call by its callId, so a resend after a lost answer is safe.
   */
  async relayCall(
    hostId: HostId,
    payload: McpCallPayload,
    timeoutMs: number
  ): Promise<McpCallAnswer> {
    const session = await this.open(hostId);
    try {
      await this.authenticate(hostId, session);
    } catch (error) {
      // Nothing of the call left yet, whatever became of the proof.
      if (isUnknownOutcome(error)) throw unreachable(hostId);
      throw error;
    }
    const parsed = McpCallAnswerSchema.safeParse(
      await this.call(hostId, session, AssistantLinkMethod.MCP_CALL, payload, timeoutMs)
    );
    if (!parsed.success) throw invalidAnswer(hostId, AssistantLinkMethod.MCP_CALL);
    return parsed.data;
  }

  private async open(hostId: HostId): Promise<LinkSession> {
    const session = await this.deps.session(hostId);
    if (!session || !session.isOpen) throw unreachable(hostId);
    return session;
  }

  private async authenticate(hostId: HostId, session: LinkSession): Promise<void> {
    if (this.authenticated.has(session)) return;
    // Saved before it is ever presented, so a host never knows a sender this Shell forgot.
    const credential = this.deps.credential(hostId);
    await this.call(hostId, session, AssistantLinkMethod.AUTHENTICATE, { credential });
    this.authenticated.add(session);
  }

  private async call(
    hostId: HostId,
    session: LinkSession,
    method: string,
    payload: unknown,
    timeoutMs = this.timeoutMs
  ): Promise<unknown> {
    try {
      return await session.call(method, payload, { timeoutMs });
    } catch (error) {
      if (codeOf(error) === "UNSUPPORTED") throw unsupported(hostId, error);
      throw error;
    }
  }
}
