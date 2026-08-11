import {
  REMOTE_GATEWAY_LIMITS,
  REMOTE_PROTOCOL_VERSION,
  type RemoteEnvelope,
  type RemoteErrorCode,
  type RemoteSubmitPromptRequest,
} from "../../../shared/types/remote/index.js";
import type { PtyHostTerminalInfo } from "../../../shared/types/pty-host.js";
import type { PtyClient } from "../PtyClient.js";
import { remoteContentMetadata, type RemoteAuditService } from "./RemoteAuditService.js";
import type { RemoteCapabilityService } from "./RemoteCapabilityService.js";
import {
  RemoteIdempotencyConflictError,
  type RemoteMutationLedgerService,
  type RemoteMutationResult,
} from "./RemoteMutationLedgerService.js";
import type { RemoteProjectDetailProjectionService } from "./RemoteProjectDetailProjectionService.js";
import type { RemoteSession, RemoteSessionRegistry } from "./RemoteSessionRegistry.js";

interface PromptSender {
  sendApplicationEnvelope(connectionId: string, envelope: RemoteEnvelope): void;
  sendApplicationError(
    connectionId: string,
    requestId: string,
    code: RemoteErrorCode,
    message: string
  ): void;
}

export class RemotePromptSubmissionService {
  constructor(
    private readonly details: RemoteProjectDetailProjectionService,
    private readonly pty: Pick<PtyClient, "getTerminalAsync" | "submitAcknowledged">,
    private readonly capabilities: RemoteCapabilityService,
    private readonly sessions: Pick<RemoteSessionRegistry, "get">,
    private readonly mutations: RemoteMutationLedgerService,
    private readonly audit: RemoteAuditService,
    private readonly sender: PromptSender
  ) {}

  async submit(
    session: RemoteSession,
    requestId: string,
    request: RemoteSubmitPromptRequest
  ): Promise<void> {
    if (!this.authorized(session, requestId)) {
      this.auditResult(session, request, "denied");
      return;
    }
    const byteCount = Buffer.byteLength(request.text, "utf8");
    if (request.text.trim().length === 0) {
      this.auditResult(session, request, "rejected");
      this.error(session, requestId, "INVALID_REQUEST", "Prompt must contain non-whitespace text");
      return;
    }
    if (byteCount > REMOTE_GATEWAY_LIMITS.maxPromptBytes) {
      this.auditResult(session, request, "rejected");
      this.error(session, requestId, "INVALID_REQUEST", "Prompt exceeds 64 KiB");
      return;
    }

    let execution;
    try {
      execution = await this.mutations.execute(
        {
          deviceId: session.deviceId!,
          idempotencyKey: request.idempotencyKey,
          operation: "prompt.submit",
          arguments: request,
        },
        () => this.commit(session, request)
      );
    } catch (error) {
      if (error instanceof RemoteIdempotencyConflictError) {
        this.auditResult(session, request, "conflict");
        this.error(
          session,
          requestId,
          "CONFLICT",
          "Idempotency key conflicts with another request"
        );
        return;
      }
      this.auditResult(session, request, "unknown");
      this.send(session, requestId, "prompt.result", {
        idempotencyKey: request.idempotencyKey,
        disposition: "unknown",
        resultCode: "internal-error",
      });
      return;
    }
    this.auditResult(
      session,
      request,
      execution.result.outcome === "unknown" ? "unknown" : execution.result.outcome
    );
    this.send(session, requestId, "prompt.result", {
      idempotencyKey: request.idempotencyKey,
      disposition: execution.result.outcome,
      ...(execution.result.resultCode ? { resultCode: execution.result.resultCode } : {}),
    });
  }

  status(session: RemoteSession, requestId: string, idempotencyKey: string): void {
    if (!this.authorized(session, requestId)) return;
    const result = this.mutations.status(session.deviceId!, idempotencyKey);
    this.send(session, requestId, "request.status", {
      idempotencyKey,
      disposition: result?.outcome ?? "not-found",
      ...(result?.resultCode ? { resultCode: result.resultCode } : {}),
    });
  }

  private async commit(
    session: RemoteSession,
    request: RemoteSubmitPromptRequest
  ): Promise<RemoteMutationResult> {
    if (!this.isCurrentSession(session)) return { outcome: "rejected", resultCode: "unauthorized" };
    const authorization = this.capabilities.authorize(session.deviceId!, "prompt-agents");
    if (!authorization.allowed) return this.authorizationRejection(authorization.reason);

    const initialBinding = await this.validateProjectedTarget(request);
    if (initialBinding) return initialBinding;
    const terminal = await this.pty.getTerminalAsync(request.panelId);
    const terminalVerdict = this.validateTerminal(terminal, request);
    if (terminalVerdict) return terminalVerdict;
    const finalBinding = await this.validateProjectedTarget(request);
    if (finalBinding) return finalBinding;
    if (!this.isCurrentSession(session)) return { outcome: "rejected", resultCode: "unauthorized" };
    const finalAuthorization = this.capabilities.authorize(session.deviceId!, "prompt-agents");
    if (!finalAuthorization.allowed) return this.authorizationRejection(finalAuthorization.reason);
    try {
      const result = await this.pty.submitAcknowledged(
        request.panelId,
        request.text,
        request.launchGeneration
      );
      if (!result.accepted) {
        return {
          outcome: "rejected",
          resultCode:
            result.reason === "generation-changed"
              ? "stale-generation"
              : result.reason === "not-live" || result.reason === "trashed"
                ? "not-live"
                : "unavailable",
        };
      }
      return { outcome: "committed", resultCode: "queued" };
    } catch {
      return { outcome: "unknown", resultCode: "internal-error" };
    }
  }

  private validateTerminal(
    terminal: PtyHostTerminalInfo | null,
    request: RemoteSubmitPromptRequest
  ): RemoteMutationResult | null {
    if (!terminal || terminal.id !== request.panelId || terminal.projectId !== request.projectId) {
      return { outcome: "rejected", resultCode: "invalid-target" };
    }
    if (terminal.launchGeneration !== request.launchGeneration) {
      return { outcome: "rejected", resultCode: "stale-generation" };
    }
    if (!terminal.hasPty || terminal.isTrashed) {
      return { outcome: "rejected", resultCode: "not-live" };
    }
    return null;
  }

  private async validateProjectedTarget(
    request: RemoteSubmitPromptRequest
  ): Promise<RemoteMutationResult | null> {
    let snapshot: Awaited<ReturnType<RemoteProjectDetailProjectionService["snapshot"]>>;
    try {
      snapshot = await this.details.snapshot(request.projectId);
    } catch {
      return { outcome: "rejected", resultCode: "invalid-target" };
    }
    const projectedRun = snapshot.agents.find(
      (run) =>
        run.projectId === request.projectId &&
        run.worktreeId === request.worktreeId &&
        run.panelId === request.panelId &&
        run.launchGeneration === request.launchGeneration
    );
    if (!projectedRun) return { outcome: "rejected", resultCode: "invalid-target" };
    if (projectedRun.connectionState !== "live") {
      return { outcome: "rejected", resultCode: "not-live" };
    }
    const binding = this.details.validateBinding({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      panelId: request.panelId,
      launchGeneration: request.launchGeneration,
      projectionRevision: snapshot.revision,
    });
    if (binding.ok) return null;
    return {
      outcome: "rejected",
      resultCode:
        binding.code === "RUN_GENERATION_CHANGED" || binding.code === "PROJECTION_STALE"
          ? "stale-generation"
          : "invalid-target",
    };
  }

  private authorized(session: RemoteSession, requestId: string): boolean {
    if (!this.isCurrentSession(session) || !session.deviceId) {
      this.error(session, requestId, "SESSION_NOT_READY", "Remote session is no longer active");
      return false;
    }
    const authorization = this.capabilities.authorize(session.deviceId, "prompt-agents");
    if (!authorization.allowed) {
      this.error(
        session,
        requestId,
        authorization.reason === "revoked" ? "DEVICE_REVOKED" : "FORBIDDEN",
        authorization.reason === "revoked"
          ? "Paired device was revoked"
          : "Prompt capability is required"
      );
      return false;
    }
    return true;
  }

  private isCurrentSession(session: RemoteSession): boolean {
    return session.state === "ready" && this.sessions.get(session.connection.id) === session;
  }

  private authorizationRejection(
    reason: "not-found" | "wrong-host" | "revoked" | "capability-denied"
  ): RemoteMutationResult {
    return {
      outcome: "rejected",
      resultCode:
        reason === "revoked"
          ? "revoked"
          : reason === "capability-denied"
            ? "capability-denied"
            : "unauthorized",
    };
  }

  private auditResult(
    session: RemoteSession,
    request: RemoteSubmitPromptRequest,
    result: "committed" | "rejected" | "unknown" | "conflict" | "denied"
  ): void {
    this.audit.record({
      actorDeviceId: session.deviceId ?? undefined,
      sessionId: session.id,
      operation: "prompt.submit.result",
      result,
      targetProjectId: request.projectId,
      targetWorktreeId: request.worktreeId,
      targetPanelId: request.panelId,
      ...remoteContentMetadata(request.text),
    });
  }

  private send(
    session: RemoteSession,
    requestId: string,
    type: "prompt.result" | "request.status",
    payload: Record<string, unknown>
  ): void {
    this.sender.sendApplicationEnvelope(session.connection.id, {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      sessionId: session.id,
      kind: "response",
      type,
      requestId,
      payload,
    } as RemoteEnvelope);
  }

  private error(
    session: RemoteSession,
    requestId: string,
    code: RemoteErrorCode,
    message: string
  ): void {
    this.sender.sendApplicationError(session.connection.id, requestId, code, message);
  }
}
