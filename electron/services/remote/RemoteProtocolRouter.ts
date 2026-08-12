import {
  REMOTE_GATEWAY_LIMITS,
  REMOTE_PROTOCOL_VERSION,
  type RemoteErrorCode,
  type RemoteEnvelope,
  negotiateRemoteProtocol,
  parseRemoteFrame,
} from "../../../shared/types/remote/index.js";
import type { RemoteAuthenticationService } from "./RemoteAuthenticationService.js";
import { RemoteAbuseGuard } from "./RemoteAbuseGuard.js";
import { remoteContentMetadata, type RemoteAuditService } from "./RemoteAuditService.js";
import type { RemoteConnection } from "./RemoteConnection.js";
import type { RemotePairingService } from "./RemotePairingService.js";
import type { RemoteSession, RemoteSessionRegistry } from "./RemoteSessionRegistry.js";

export const REMOTE_RATE_WINDOW_MS = 60_000;

export type RemoteApplicationHandler = (
  session: RemoteSession,
  envelope: RemoteEnvelope
) => void | Promise<void>;

export class RemoteProtocolRouter {
  private readonly cleanups = new Map<string, Array<() => void>>();
  private applicationHandler: RemoteApplicationHandler;
  private audit: RemoteAuditService | null = null;
  private pairing: RemotePairingService | null = null;

  constructor(
    private readonly sessions: RemoteSessionRegistry,
    private readonly authentication: RemoteAuthenticationService,
    private readonly appVersion: string,
    applicationHandler: RemoteApplicationHandler = () => undefined,
    private readonly now: () => number = Date.now,
    private readonly abuseGuard = new RemoteAbuseGuard(now)
  ) {
    this.applicationHandler = applicationHandler;
  }

  setApplicationHandler(handler: RemoteApplicationHandler): void {
    this.applicationHandler = handler;
  }

  setAuditService(audit: RemoteAuditService): void {
    this.audit = audit;
  }

  setPairingService(pairing: RemotePairingService): void {
    this.pairing = pairing;
  }

  attach(connection: RemoteConnection): void {
    const session = this.sessions.create(connection);
    this.audit?.record({ sessionId: session.id, operation: "connection.start", result: "started" });
    this.cleanups.set(connection.id, [
      connection.onMessage((frame) => void this.handleFrame(connection, frame)),
      connection.onClose(() => this.detach(connection.id)),
    ]);
  }

  closeAll(): void {
    this.sessions.closeAll();
    this.sessions.clearRateLimits();
    this.abuseGuard.clear();
    for (const connectionId of [...this.cleanups.keys()]) this.detach(connectionId);
  }

  private async handleFrame(connection: RemoteConnection, frame: string): Promise<void> {
    const parsed = parseRemoteFrame(frame, REMOTE_GATEWAY_LIMITS.maxFrameBytes);
    if (!parsed.ok) {
      const current = this.sessions.get(connection.id);
      this.audit?.record({
        actorDeviceId: current?.deviceId ?? undefined,
        sessionId: current?.id,
        operation: "frame.malformed",
        result: "invalid",
      });
      if (current?.deviceId)
        this.abuseGuard.recordViolation(current.deviceId, connection.sourceAddress);
      connection.close(parsed.error.code === "FRAME_TOO_LARGE" ? 1009 : 1008, parsed.error.code);
      return;
    }
    const session = this.sessions.get(connection.id);
    if (!session) return;
    const envelope = parsed.envelope;
    if (
      envelope.kind === "request" &&
      !this.consumeRate(session.requestTimes, REMOTE_GATEWAY_LIMITS.maxRequestsPerMinute)
    ) {
      this.audit?.record({
        actorDeviceId: session.deviceId ?? undefined,
        sessionId: session.id,
        operation: "rate.limit",
        result: "limited",
      });
      if (session.deviceId)
        this.abuseGuard.recordViolation(session.deviceId, connection.sourceAddress);
      this.sendError(
        session,
        this.requestId(parsed.envelope, "rate-limit"),
        "RATE_LIMITED",
        "Request rate exceeded"
      );
      connection.close(4008, "RATE_LIMITED");
      return;
    }

    if (session.state === "connected") {
      if (
        envelope.kind === "request" &&
        (envelope.type === "hosts.pair.begin" || envelope.type === "hosts.pair.verify")
      ) {
        this.handlePairing(session, envelope);
        return;
      }
      if (
        envelope.kind === "request" &&
        envelope.type === "session.hello" &&
        this.abuseGuard.isBanned(envelope.payload.deviceId, connection.sourceAddress)
      ) {
        connection.close(4008, "TEMPORARILY_BANNED");
        return;
      }
      this.handleHello(session, envelope);
      return;
    }
    if (envelope.sessionId !== session.id) {
      if (session.deviceId)
        this.abuseGuard.recordViolation(session.deviceId, connection.sourceAddress);
      this.sendError(
        session,
        this.requestId(envelope, "session"),
        "AUTHENTICATION_FAILED",
        "Session identity does not match"
      );
      connection.close(4001, "AUTHENTICATION_FAILED");
      return;
    }
    if (session.state === "authenticated") {
      this.handleReady(session, envelope);
      return;
    }
    if (session.state !== "ready") {
      this.sendError(
        session,
        this.requestId(envelope, "session"),
        "SESSION_NOT_READY",
        "Session is not ready"
      );
      connection.close(4003, "SESSION_NOT_READY");
      return;
    }
    if (session.deviceId && this.abuseGuard.isBanned(session.deviceId, connection.sourceAddress)) {
      connection.close(4008, "TEMPORARILY_BANNED");
      return;
    }
    if (envelope.kind === "ack" && envelope.type === "stream.ack") {
      if (
        !this.sessions.acknowledgeConsoleOutput(
          session.connection.id,
          envelope.streamId,
          envelope.ack
        )
      ) {
        connection.close(1008, "INVALID_STREAM_ACK");
      }
      return;
    }

    if (envelope.kind === "request" && envelope.type === "prompt.submit") {
      if (
        new TextEncoder().encode(envelope.payload.text).byteLength >
        REMOTE_GATEWAY_LIMITS.maxPromptBytes
      ) {
        this.audit?.record({
          actorDeviceId: session.deviceId ?? undefined,
          sessionId: session.id,
          operation: "prompt.submit.result",
          result: "rejected",
          targetProjectId: envelope.payload.projectId,
          targetWorktreeId: envelope.payload.worktreeId,
          targetPanelId: envelope.payload.panelId,
          ...remoteContentMetadata(envelope.payload.text),
        });
        this.sendError(session, envelope.requestId, "INVALID_REQUEST", "Prompt exceeds 64 KiB");
        return;
      }
    }
    if (envelope.kind === "request" && envelope.type === "agent.launch") {
      if (
        !session.deviceId ||
        !this.sessions.consumeDeviceLaunch(
          session.deviceId,
          this.now(),
          REMOTE_RATE_WINDOW_MS,
          REMOTE_GATEWAY_LIMITS.maxLaunchesPerMinute
        )
      ) {
        if (session.deviceId) {
          this.abuseGuard.recordViolation(session.deviceId, connection.sourceAddress);
        }
        this.sendError(session, envelope.requestId, "RATE_LIMITED", "Launch rate exceeded");
        return;
      }
    }
    if (envelope.kind === "request" && envelope.type === "console.subscribe") {
      if (!this.sessions.reserveConsoleSubscription(session.connection.id, envelope.requestId)) {
        this.sendError(
          session,
          envelope.requestId,
          "RATE_LIMITED",
          "Console subscription limit reached"
        );
        return;
      }
      this.audit?.record({
        actorDeviceId: session.deviceId ?? undefined,
        sessionId: session.id,
        operation: "console.subscribe.start",
        result: "accepted",
        targetProjectId: envelope.payload.projectId,
        targetWorktreeId: envelope.payload.worktreeId,
        targetPanelId: envelope.payload.panelId,
      });
    }
    if (envelope.kind === "request" && envelope.type === "console.unsubscribe") {
      this.sessions.removeConsoleStream(session.connection.id, envelope.payload.streamId);
      this.audit?.record({
        actorDeviceId: session.deviceId ?? undefined,
        sessionId: session.id,
        operation: "console.subscribe.end",
        result: "ended",
      });
    }
    try {
      await this.applicationHandler(session, envelope);
    } catch {
      if (envelope.kind === "request") {
        this.sendError(session, envelope.requestId, "INTERNAL_ERROR", "Remote request failed");
      }
    }
  }

  private handlePairing(session: RemoteSession, envelope: RemoteEnvelope): void {
    if (!this.pairing || envelope.kind !== "request") {
      this.sendError(
        session,
        this.requestId(envelope, "pairing"),
        "FORBIDDEN",
        "Pairing is unavailable"
      );
      return;
    }
    try {
      if (envelope.type === "hosts.pair.begin") {
        const candidate = this.pairing.beginPairingRequest({
          pairingId: envelope.payload.pairingId,
          oneTimeSecret: envelope.payload.oneTimeSecret,
          deviceId: envelope.payload.deviceId,
          displayName: envelope.payload.deviceName,
          platform: envelope.payload.platform,
          publicKey: envelope.payload.devicePublicKey,
        });
        this.send(session, {
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          sessionId: session.id,
          kind: "response",
          type: "hosts.pair.verify",
          requestId: envelope.requestId,
          payload: {
            pairingId: candidate.pairingId,
            verificationCode: candidate.verificationCode,
            state: "match-required",
          },
        });
        return;
      }
      if (envelope.type === "hosts.pair.verify") {
        const candidate = this.pairing.verifyPairingRequest(
          envelope.payload.pairingId,
          envelope.payload.verificationProof
        );
        this.send(session, {
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          sessionId: session.id,
          kind: "response",
          type: "hosts.pair.verify",
          requestId: envelope.requestId,
          payload: {
            pairingId: candidate.pairingId,
            verificationCode: candidate.verificationCode,
            state: "awaiting-approval",
          },
        });
      }
    } catch {
      this.sendError(
        session,
        envelope.requestId,
        "AUTHENTICATION_FAILED",
        "Pairing request was rejected"
      );
    }
  }

  private handleHello(session: RemoteSession, envelope: RemoteEnvelope): void {
    if (envelope.kind !== "request" || envelope.type !== "session.hello") {
      this.sendError(
        session,
        envelope.kind === "request" || envelope.kind === "response"
          ? envelope.requestId
          : "authentication",
        "AUTHENTICATION_FAILED",
        "Device authentication is required"
      );
      session.connection.close(4001, "AUTHENTICATION_REQUIRED");
      return;
    }
    const negotiation = negotiateRemoteProtocol(envelope.payload.supportedProtocol);
    if (!negotiation.ok) {
      this.audit?.record({
        sessionId: session.id,
        operation: "protocol.mismatch",
        result: "rejected",
      });
      this.sendError(
        session,
        envelope.requestId,
        negotiation.error.code,
        negotiation.error.message
      );
      session.connection.close(4002, negotiation.error.code);
      return;
    }
    const authentication = this.authentication.authenticateClientChallenge({
      deviceId: envelope.payload.deviceId,
      challenge: envelope.payload.challenge,
      signature: envelope.payload.signature,
    });
    if (!authentication.authenticated) {
      this.audit?.record({
        actorDeviceId: envelope.payload.deviceId,
        sessionId: session.id,
        operation: "authorization.failure",
        result: authentication.reason === "revoked" ? "revoked" : "denied",
      });
      this.abuseGuard.recordViolation(envelope.payload.deviceId, session.connection.sourceAddress);
      this.sendError(
        session,
        envelope.requestId,
        authentication.reason === "revoked" ? "DEVICE_REVOKED" : "AUTHENTICATION_FAILED",
        authentication.reason === "revoked"
          ? "Device access has been revoked"
          : "Device authentication failed"
      );
      session.connection.close(4001, "AUTHENTICATION_FAILED");
      return;
    }
    try {
      this.sessions.authenticate(
        session.connection.id,
        authentication.deviceId,
        authentication.capabilities
      );
    } catch {
      this.sendError(session, envelope.requestId, "RATE_LIMITED", "Remote session limit reached");
      session.connection.close(4008, "SESSION_LIMIT_REACHED");
      return;
    }
    this.send(session, {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      sessionId: session.id,
      kind: "response",
      type: "session.welcome",
      requestId: envelope.requestId,
      payload: {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        sessionId: session.id,
        challenge: envelope.payload.challenge,
        signature: authentication.hostSignature,
        capabilities: authentication.capabilities,
        appVersion: this.appVersion,
        resumeAccepted: false,
      },
    });
  }

  private handleReady(session: RemoteSession, envelope: RemoteEnvelope): void {
    if (envelope.kind !== "request" || envelope.type !== "session.ready") {
      this.sendError(
        session,
        envelope.kind === "request" || envelope.kind === "response" ? envelope.requestId : "ready",
        "SESSION_NOT_READY",
        "Session readiness confirmation is required"
      );
      session.connection.close(4003, "SESSION_NOT_READY");
      return;
    }
    this.sessions.markReady(session.connection.id);
    this.send(session, {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      sessionId: session.id,
      kind: "response",
      type: "session.ready",
      requestId: envelope.requestId,
      payload: { ready: true },
    });
  }

  private sendError(
    session: RemoteSession,
    requestId: string,
    code: RemoteErrorCode,
    message: string
  ): void {
    this.sessions.cancelConsoleSubscription(session.connection.id, requestId);
    this.send(session, {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      sessionId: session.id,
      kind: "response",
      type: "request.error",
      requestId,
      payload: { code, message, retryable: code === "RATE_LIMITED" },
    });
  }

  private requestId(envelope: RemoteEnvelope, fallback: string): string {
    return envelope.kind === "request" || envelope.kind === "response"
      ? envelope.requestId
      : fallback;
  }

  private send(session: RemoteSession, envelope: RemoteEnvelope): void {
    const serialized = JSON.stringify(envelope);
    const serializedBytes = Buffer.byteLength(serialized);
    if (envelope.kind === "response" && envelope.type === "console.snapshot") {
      if (
        !this.sessions.registerConsoleStream(
          session.connection.id,
          envelope.requestId,
          envelope.payload.streamId
        )
      ) {
        session.connection.close(1008, "INVALID_CONSOLE_STREAM");
        return;
      }
    }
    if (envelope.kind === "event" && envelope.type === "console.output") {
      const tracking = this.sessions.trackConsoleOutputResult(
        session.connection.id,
        envelope.payload.streamId,
        envelope.payload.seq,
        serializedBytes
      );
      if (tracking !== "tracked") {
        if (tracking !== "missing") {
          this.sendConsoleResync(
            session,
            envelope.payload.streamId,
            tracking === "overflow" ? "queue-overflow" : "gap"
          );
        }
        return;
      }
    }
    if (envelope.kind === "event" && envelope.type === "console.resyncRequired") {
      this.sessions.removeConsoleStream(session.connection.id, envelope.payload.streamId);
      this.audit?.record({
        actorDeviceId: session.deviceId ?? undefined,
        sessionId: session.id,
        operation: "console.resync",
        result: "resync-required",
      });
    }
    const queuedLimit =
      envelope.kind === "response" && envelope.type === "console.snapshot"
        ? REMOTE_GATEWAY_LIMITS.maxQueuedBytes + REMOTE_GATEWAY_LIMITS.maxConsoleSnapshotBytes
        : REMOTE_GATEWAY_LIMITS.maxQueuedBytes;
    if (session.connection.bufferedAmount + serializedBytes > queuedLimit) {
      if (envelope.kind === "event" && envelope.type === "console.output") {
        this.sendConsoleResync(session, envelope.payload.streamId, "queue-overflow");
        return;
      }
      if (envelope.kind === "response" && envelope.type === "console.snapshot") {
        this.sendConsoleResync(session, envelope.payload.streamId, "queue-overflow");
        return;
      }
      session.connection.close(4008, "QUEUE_OVERFLOW");
      return;
    }
    session.connection.send(serialized);
  }

  private sendConsoleResync(
    session: RemoteSession,
    streamId: string,
    reason: "gap" | "queue-overflow"
  ): void {
    this.sessions.removeConsoleStream(session.connection.id, streamId);
    this.audit?.record({
      actorDeviceId: session.deviceId ?? undefined,
      sessionId: session.id,
      operation: "console.resync",
      result: "resync-required",
    });
    session.connection.send(
      JSON.stringify({
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        sessionId: session.id,
        kind: "event",
        type: "console.resyncRequired",
        payload: { streamId, reason },
      })
    );
  }

  sendApplicationEnvelope(connectionId: string, envelope: RemoteEnvelope): void {
    const session = this.sessions.get(connectionId);
    if (!session || session.state !== "ready") throw new Error("Remote session is not ready");
    if (envelope.sessionId !== session.id)
      throw new Error("Remote session identity does not match");
    this.send(session, envelope);
  }

  sendApplicationError(
    connectionId: string,
    requestId: string,
    code: RemoteErrorCode,
    message: string
  ): void {
    const session = this.sessions.get(connectionId);
    if (!session || session.state !== "ready") return;
    this.sendError(session, requestId, code, message);
  }

  private consumeRate(timestamps: number[], limit: number): boolean {
    const cutoff = this.now() - REMOTE_RATE_WINDOW_MS;
    while (timestamps.length > 0 && timestamps[0]! <= cutoff) timestamps.shift();
    if (timestamps.length >= limit) return false;
    timestamps.push(this.now());
    return true;
  }

  private detach(connectionId: string): void {
    const session = this.sessions.get(connectionId);
    this.audit?.record({
      actorDeviceId: session?.deviceId ?? undefined,
      sessionId: session?.id,
      operation: "connection.end",
      result: "ended",
    });
    for (const cleanup of this.cleanups.get(connectionId) ?? []) cleanup();
    this.cleanups.delete(connectionId);
    this.sessions.remove(connectionId);
  }
}
