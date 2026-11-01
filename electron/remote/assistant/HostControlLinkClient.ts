import type { HostId } from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import { senderIdForCredential } from "./hostSenders.js";
import { relayCallArmsNotice } from "../../services/mcp-server/terminalNotify.js";
import type { LinkSession } from "../link/session.js";
import {
  AgentsAnswerSchema,
  AssistantLinkMethod,
  McpCallAnswerSchema,
  RelayApprovePayloadSchema,
  RelayApproveTimedPayloadSchema,
  RelayNoticeStatusAnswerSchema,
  RelayNoticesPayloadSchema,
  ThrowawayCallAnswerSchema,
  type AgentsAnswer,
  type AgentsPayload,
  type McpCallAnswer,
  type RelayCallRequest,
  type RelayApproveAnswer,
  type RelayApprovePayload,
  type RelayApproveTimedPayload,
  type RelayNoticeStatusAnswer,
  type RelayNoticeStatusPayload,
  type RelayNoticesPayload,
  type ThrowawayCallAnswer,
  type ThrowawayCallPayload,
  type ThrowawayReleasePayload,
} from "./linkMethods.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("main:HostControlLinkClient");

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
  /** The credential already kept for a host, never minting one; null when there is none. */
  existingCredential?(hostId: HostId): string | null;
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
        receiveApproval(
          hostId: HostId,
          payload: RelayApprovePayload | RelayApproveTimedPayload
        ): Promise<RelayApproveAnswer>;
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
  /** Sessions to a host from before GLOBAL_MCP_CALL; one session is always one host build. */
  private readonly noGlobalCalls = new WeakSet<LinkSession>();
  private readonly follows = new Map<LinkSession, NoticeFollow>();
  private readonly disposers: Array<() => void> = [];
  private disposed = false;
  private readonly timeoutMs: number;
  private readonly noticeStatusDelayMs: number;

  constructor(private readonly deps: HostControlLinkClientDeps) {
    this.timeoutMs = deps.callTimeoutMs ?? CALL_TIMEOUT_MS;
    this.noticeStatusDelayMs = deps.noticeStatusDelayMs ?? NOTICE_STATUS_DELAY_MS;
  }

  /**
   * The sender this Shell is to a host, as that host derives it, for telling
   * its own assistants in what the host reports (#14166). Never mints a
   * credential: a host this Shell never authenticated to knows it as no one.
   */
  senderIdOf(hostId: HostId): string | null {
    const credential = this.deps.existingCredential?.(hostId) ?? null;
    return credential === null ? null : senderIdForCredential(credential);
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
        // there; nobody to take it refuses it, which approves nothing. Asked
        // the timed way, it also says how long it waits (#15699).
        const answerApproval = (
          payload: RelayApprovePayload | RelayApproveTimedPayload
        ): Promise<RelayApproveAnswer> | RelayApproveAnswer => {
          const receiver = this.disposed ? undefined : this.deps.approvalReceiver?.();
          return (
            receiver?.receiveApproval(hostId, payload) ?? {
              approvalId: payload.approvalId,
              argsHash: payload.argsHash,
              decision: "refused",
            }
          );
        };
        session.registerCallHandler(
          AssistantLinkMethod.RELAY_APPROVE,
          RelayApprovePayloadSchema,
          answerApproval
        );
        session.registerCallHandler(
          AssistantLinkMethod.RELAY_APPROVE_TIMED,
          RelayApproveTimedPayloadSchema,
          answerApproval
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
    if (this.disposed) return;
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
      if (this.disposed || !session.isOpen) return;
      const parsed = RelayNoticeStatusAnswerSchema.safeParse(
        await this.call(hostId, session, AssistantLinkMethod.RELAY_NOTICE_STATUS, { calls })
      );
      if (!parsed.success) throw invalidAnswer(hostId, AssistantLinkMethod.RELAY_NOTICE_STATUS);
      if (!this.disposed) receiver.receiveNoticeStatus(hostId, parsed.data);
    } catch (error) {
      // A host from before this can't say; its link still stays open for them.
      if (codeOf(error) === "UNSUPPORTED") return;
      logger.warn("Couldn't ask a host after its notices", { error });
    }
  }

  /**
   * Run one of the host's own MCP tools for one of this Shell's assistants
   * (#13493), once this Shell's sender is proven on the session. The host
   * records the call by its callId, so a resend after a lost answer is safe.
   */
  async relayCall(
    hostId: HostId,
    request: RelayCallRequest,
    timeoutMs: number
  ): Promise<McpCallAnswer> {
    const { global, ...payload } = request;
    const session = await this.open(hostId);
    try {
      await this.authenticate(hostId, session);
    } catch (error) {
      // Nothing of the call left yet, whatever became of the proof.
      if (isUnknownOutcome(error)) throw unreachable(hostId);
      throw error;
    }
    let answer: unknown;
    let answered = false;
    if (global === true && !this.noGlobalCalls.has(session)) {
      try {
        answer = await this.call(
          hostId,
          session,
          AssistantLinkMethod.GLOBAL_MCP_CALL,
          payload,
          timeoutMs
        );
        answered = true;
      } catch (error) {
        // An unknown method is refused before anything runs, so the same call,
        // resend flag and all, goes again as one any assistant could make.
        if (codeOf(error) !== "UNSUPPORTED") throw error;
        this.noGlobalCalls.add(session);
      }
    }
    if (!answered) {
      answer = await this.call(hostId, session, AssistantLinkMethod.MCP_CALL, payload, timeoutMs);
    }
    const parsed = McpCallAnswerSchema.safeParse(answer);
    if (!parsed.success) throw invalidAnswer(hostId, AssistantLinkMethod.MCP_CALL);
    // A call can arm nothing, or have its notice answered by its own reply
    // wait, without a notice ever coming: ask, so its link need not wait on it.
    if (relayCallArmsNotice(payload.tool, payload.args)) this.followNoticesLater(hostId, session);
    return parsed.data;
  }

  /**
   * Run one throwaway tool on the host for one of this Shell's assistants
   * (#14446), with no project. Recorded by callId there as `relayCall` is; a
   * host from before throwaway agents answers UNSUPPORTED.
   */
  async throwawayCall(
    hostId: HostId,
    payload: ThrowawayCallPayload,
    timeoutMs: number
  ): Promise<ThrowawayCallAnswer> {
    const session = await this.open(hostId);
    try {
      await this.authenticate(hostId, session);
    } catch (error) {
      if (isUnknownOutcome(error)) throw unreachable(hostId);
      throw error;
    }
    const parsed = ThrowawayCallAnswerSchema.safeParse(
      await this.call(hostId, session, AssistantLinkMethod.THROWAWAY_CALL, payload, timeoutMs)
    );
    if (!parsed.success) throw invalidAnswer(hostId, AssistantLinkMethod.THROWAWAY_CALL);
    return parsed.data;
  }

  /** Tells the host one of this Shell's help sessions ended, so its throwaway runs there go (#14447). */
  async throwawayRelease(hostId: HostId, payload: ThrowawayReleasePayload): Promise<void> {
    const session = await this.open(hostId);
    await this.authenticate(hostId, session);
    // No deadline: a release that settles unsent is dropped, and its runs live on to their own limits.
    await this.call(hostId, session, AssistantLinkMethod.THROWAWAY_RELEASE, payload, 0);
  }

  /**
   * The host's workers and assistants as its own directory reads them
   * (#14455), for `host.list`. A host from before this answers UNSUPPORTED.
   */
  async agents(hostId: HostId, payload: AgentsPayload, timeoutMs?: number): Promise<AgentsAnswer> {
    const session = await this.open(hostId);
    try {
      await this.authenticate(hostId, session);
    } catch (error) {
      if (isUnknownOutcome(error)) throw unreachable(hostId);
      throw error;
    }
    const parsed = AgentsAnswerSchema.safeParse(
      await this.call(hostId, session, AssistantLinkMethod.AGENTS, payload, timeoutMs)
    );
    if (!parsed.success) throw invalidAnswer(hostId, AssistantLinkMethod.AGENTS);
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
