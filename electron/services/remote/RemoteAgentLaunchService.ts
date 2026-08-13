import {
  REMOTE_GATEWAY_LIMITS,
  REMOTE_PROTOCOL_VERSION,
  type RemoteEnvelope,
  type RemoteErrorCode,
  type RemoteLaunchAgentRequest,
  type RemoteLaunchAgentResult,
  type RemoteCloseAgentRequest,
  type RemoteCloseAgentResult,
  type RemoteLaunchableAgents,
  type RemoteLaunchableAgentsRequest,
} from "../../../shared/types/remote/index.js";
import { remoteContentMetadata, type RemoteAuditService } from "./RemoteAuditService.js";
import type { RemoteCapabilityService } from "./RemoteCapabilityService.js";
import {
  RemoteIdempotencyConflictError,
  type RemoteMutationLedgerService,
  type RemoteMutationRequest,
  type RemoteMutationResult,
} from "./RemoteMutationLedgerService.js";
import type { RemoteProjectDetailProjectionService } from "./RemoteProjectDetailProjectionService.js";
import type { RemoteProjectViewBroker, RemoteProjectViewLease } from "./RemoteProjectViewBroker.js";
import { RemoteRendererBridgeError, type RemoteRendererBridge } from "./RemoteRendererBridge.js";
import { REMOTE_RATE_WINDOW_MS } from "./RemoteProtocolRouter.js";
import type { RemoteSession, RemoteSessionRegistry } from "./RemoteSessionRegistry.js";

interface LaunchSender {
  sendApplicationEnvelope(connectionId: string, envelope: RemoteEnvelope): void;
  sendApplicationError(
    connectionId: string,
    requestId: string,
    code: RemoteErrorCode,
    message: string
  ): void;
}

interface CreatedLaunch {
  panelId: string;
  launchGeneration: number;
  placement: "grid" | "dock";
}

interface LaunchReservation {
  key: string;
  owner: string;
  deviceId: string;
  token: symbol;
}

type LaunchReservationResult =
  | { ok: true; reservation: LaunchReservation }
  | { ok: false; resultCode: "invalid-target" | "rate-limited" };

type CreatedInspection =
  { status: "created"; created: CreatedLaunch } | { status: "absent" } | { status: "unavailable" };

export const MAX_CONCURRENT_REMOTE_LAUNCHES = 4;
export const MAX_CONCURRENT_REMOTE_LAUNCHES_PER_DEVICE = 2;
const REMOTE_LAUNCH_GENERATION_SETTLE_MS = 1_000;
const REMOTE_LAUNCH_GENERATION_POLL_MS = 20;

export class RemoteAgentLaunchService {
  private readonly panelReservations = new Map<string, LaunchReservation>();
  private readonly activeByDevice = new Map<string, number>();
  private activeLaunches = 0;

  constructor(
    private readonly details: Pick<
      RemoteProjectDetailProjectionService,
      "resolveWorktreeSource" | "currentGeneration"
    >,
    private readonly views: Pick<RemoteProjectViewBroker, "ensureBackgroundView">,
    private readonly renderer: Pick<
      RemoteRendererBridge,
      "getPanelProjection" | "getLaunchableAgents" | "launchAgent" | "closeAgent"
    >,
    private readonly capabilities: RemoteCapabilityService,
    private readonly sessions: Pick<RemoteSessionRegistry, "get" | "isDeviceLaunchWithinRate">,
    private readonly mutations: RemoteMutationLedgerService,
    private readonly audit: RemoteAuditService,
    private readonly sender: LaunchSender,
    private readonly now: () => number = Date.now
  ) {}

  async launchable(
    session: RemoteSession,
    requestId: string,
    request: RemoteLaunchableAgentsRequest
  ): Promise<void> {
    if (!this.authorized(session, requestId, "launch-agents")) return;
    const sourceWorktreeId = await this.resolveWorktree(request.projectId, request.worktreeId);
    if (!sourceWorktreeId) {
      this.error(session, requestId, "NOT_FOUND", "Project or worktree was not found");
      return;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let lease: RemoteProjectViewLease | null = null;
      try {
        lease = await this.views.ensureBackgroundView(request.projectId);
        if (!this.authorized(session, requestId, "launch-agents")) return;
        const currentSource = await this.resolveWorktree(request.projectId, request.worktreeId);
        if (currentSource !== sourceWorktreeId) {
          this.error(session, requestId, "NOT_FOUND", "Worktree ownership changed");
          return;
        }
        const result = await this.renderer.getLaunchableAgents(lease, sourceWorktreeId);
        const response: RemoteLaunchableAgents = {
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          agents: result.agents,
        };
        this.send(session, requestId, "agents.launchable", response);
        return;
      } catch (error) {
        if (
          attempt === 0 &&
          error instanceof RemoteRendererBridgeError &&
          (error.code === "UNAVAILABLE" || error.code === "BINDING_STALE")
        ) {
          continue;
        }
        this.error(session, requestId, "HOST_UI_UNAVAILABLE", "Project renderer is unavailable");
        return;
      } finally {
        lease?.release();
      }
    }
  }

  async launch(
    session: RemoteSession,
    requestId: string,
    request: RemoteLaunchAgentRequest
  ): Promise<void> {
    if (!this.authorized(session, requestId, "launch-agents")) {
      this.auditResult(session, request, "denied");
      return;
    }
    this.audit.record({
      actorDeviceId: session.deviceId!,
      sessionId: session.id,
      operation: "agent.launch.request",
      result: "accepted",
      targetProjectId: request.projectId,
      targetWorktreeId: request.worktreeId,
      targetPanelId: request.requestedPanelId,
      ...(request.prompt ? remoteContentMetadata(request.prompt) : {}),
    });

    const mutationRequest: RemoteMutationRequest = {
      deviceId: session.deviceId!,
      idempotencyKey: request.idempotencyKey,
      operation: "agent.launch",
      arguments: request,
    };
    let created: CreatedLaunch | null = null;
    let execution;
    const effect = async (): Promise<RemoteMutationResult> => {
      const reserved = this.reserveLaunch(session.deviceId!, request);
      if (!reserved.ok) {
        return { outcome: "rejected", resultCode: reserved.resultCode };
      }
      try {
        const committed = await this.commit(session, request, reserved.reservation);
        created = committed.created;
        return committed.result;
      } finally {
        this.releaseLaunch(reserved.reservation);
      }
    };
    try {
      execution = await this.mutations.execute(mutationRequest, effect);
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
      this.sendUnknown(session, requestId, request, "internal-error");
      return;
    }

    let result: RemoteMutationResult = execution.result;
    if (execution.replayed && result.outcome !== "rejected") {
      const inspected = await this.reconcileCreated(session, request, mutationRequest);
      if (inspected.status === "created") {
        created = inspected.created;
        result = {
          outcome: "committed",
          resultCode: "created",
          createdResourceId: inspected.created.panelId,
        };
      } else if (
        inspected.status === "absent" &&
        result.outcome === "unknown" &&
        !this.panelReservations.has(this.panelReservationKey(request))
      ) {
        try {
          execution = await this.mutations.retryUnknown(mutationRequest, effect);
          result = execution.result;
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
          this.sendUnknown(session, requestId, request, "internal-error");
          return;
        }
      }
    }
    if (result.outcome === "committed" && created) {
      this.auditResult(session, request, "committed", created.panelId);
      this.sendCreated(session, requestId, request, created, execution.replayed);
      return;
    }
    if (result.outcome === "unknown" || result.outcome === "committed") {
      this.auditResult(session, request, "unknown", result.createdResourceId);
      this.sendUnknown(
        session,
        requestId,
        request,
        result.resultCode === "commit-in-progress" ? "commit-in-progress" : "internal-error"
      );
      return;
    }
    this.auditResult(session, request, "rejected");
    this.sendRejection(session, requestId, result);
  }

  async close(
    session: RemoteSession,
    requestId: string,
    request: RemoteCloseAgentRequest
  ): Promise<void> {
    if (!this.authorized(session, requestId, "launch-agents")) {
      this.auditClose(session, request, "denied");
      return;
    }
    this.audit.record({
      actorDeviceId: session.deviceId!,
      sessionId: session.id,
      operation: "agent.close.request",
      result: "accepted",
      targetProjectId: request.projectId,
      targetWorktreeId: request.worktreeId,
      targetPanelId: request.panelId,
    });
    const mutationRequest: RemoteMutationRequest = {
      deviceId: session.deviceId!,
      idempotencyKey: request.idempotencyKey,
      operation: "agent.close",
      arguments: request,
    };
    try {
      const execution = await this.mutations.execute(mutationRequest, () =>
        this.commitClose(session, request)
      );
      if (execution.result.outcome === "committed") {
        this.auditClose(session, request, "committed");
        const result: RemoteCloseAgentResult = {
          idempotencyKey: request.idempotencyKey,
          panelId: request.panelId,
          disposition: "closed",
        };
        this.send(session, requestId, "agent.closeResult", result);
        return;
      }
      if (execution.result.outcome === "unknown") {
        this.auditClose(session, request, "unknown");
        const result: RemoteCloseAgentResult = {
          idempotencyKey: request.idempotencyKey,
          panelId: request.panelId,
          disposition: "unknown",
          resultCode:
            execution.result.resultCode === "commit-in-progress"
              ? "commit-in-progress"
              : "internal-error",
        };
        this.send(session, requestId, "agent.closeResult", result);
        return;
      }
      this.auditClose(session, request, "rejected");
      const code: RemoteErrorCode =
        execution.result.resultCode === "stale-generation"
          ? "STALE_GENERATION"
          : execution.result.resultCode === "revoked"
            ? "DEVICE_REVOKED"
            : execution.result.resultCode === "unauthorized" ||
                execution.result.resultCode === "capability-denied"
              ? "FORBIDDEN"
              : execution.result.resultCode === "invalid-target"
                ? "NOT_FOUND"
                : "HOST_UI_UNAVAILABLE";
      this.error(session, requestId, code, "Agent panel could not be closed");
    } catch (error) {
      if (error instanceof RemoteIdempotencyConflictError) {
        this.auditClose(session, request, "conflict");
        this.error(
          session,
          requestId,
          "CONFLICT",
          "Idempotency key conflicts with another request"
        );
        return;
      }
      this.auditClose(session, request, "unknown");
      this.error(session, requestId, "INTERNAL_ERROR", "Agent panel close could not be confirmed");
    }
  }

  private async commitClose(
    session: RemoteSession,
    request: RemoteCloseAgentRequest
  ): Promise<RemoteMutationResult> {
    if (!this.isCurrentSession(session) || !session.deviceId) {
      return { outcome: "rejected", resultCode: "unauthorized" };
    }
    const authorization = this.capabilities.authorize(session.deviceId, "launch-agents");
    if (!authorization.allowed) return this.authorizationRejection(authorization.reason);
    const sourceWorktreeId = await this.resolveWorktree(request.projectId, request.worktreeId);
    if (!sourceWorktreeId) return { outcome: "rejected", resultCode: "invalid-target" };
    let lease: RemoteProjectViewLease | null = null;
    try {
      lease = await this.views.ensureBackgroundView(request.projectId);
      if (!this.isCurrentSession(session)) {
        return { outcome: "rejected", resultCode: "unauthorized" };
      }
      const finalAuthorization = this.capabilities.authorize(session.deviceId, "launch-agents");
      if (!finalAuthorization.allowed)
        return this.authorizationRejection(finalAuthorization.reason);
      const projection = await this.renderer.getPanelProjection(lease);
      if (projection.status !== "available") {
        return { outcome: "rejected", resultCode: "unavailable" };
      }
      const panel = projection.panels.find((candidate) => candidate.panelId === request.panelId);
      if (!panel || panel.worktreeSourceId !== sourceWorktreeId) {
        return { outcome: "rejected", resultCode: "invalid-target" };
      }
      if (
        panel.launchGeneration !== request.launchGeneration ||
        this.details.currentGeneration(request.panelId) !== request.launchGeneration
      ) {
        return { outcome: "rejected", resultCode: "stale-generation" };
      }
      if (!this.isCurrentSession(session)) {
        return { outcome: "rejected", resultCode: "unauthorized" };
      }
      const immediateAuthorization = this.capabilities.authorize(session.deviceId, "launch-agents");
      if (!immediateAuthorization.allowed) {
        return this.authorizationRejection(immediateAuthorization.reason);
      }
      await this.renderer.closeAgent(lease, {
        worktreeId: sourceWorktreeId,
        panelId: request.panelId,
        launchGeneration: request.launchGeneration,
      });
      return { outcome: "committed", resultCode: "closed" };
    } catch {
      return { outcome: "unknown", resultCode: "internal-error" };
    } finally {
      lease?.release();
    }
  }

  status(session: RemoteSession, requestId: string, idempotencyKey: string): void {
    if (!this.isCurrentSession(session) || !session.deviceId) {
      this.error(session, requestId, "SESSION_NOT_READY", "Remote session is no longer active");
      return;
    }
    const canLaunch = this.capabilities.authorize(session.deviceId, "launch-agents").allowed;
    const canPrompt = this.capabilities.authorize(session.deviceId, "prompt-agents").allowed;
    if (!canLaunch && !canPrompt) {
      this.error(session, requestId, "FORBIDDEN", "Mutation capability is required");
      return;
    }
    const result = this.mutations.status(session.deviceId, idempotencyKey);
    this.send(session, requestId, "request.status", {
      idempotencyKey,
      disposition: result?.outcome ?? "not-found",
      ...(result?.resultCode ? { resultCode: result.resultCode } : {}),
      ...(result?.createdResourceId ? { createdResourceId: result.createdResourceId } : {}),
    });
  }

  private async commit(
    session: RemoteSession,
    request: RemoteLaunchAgentRequest,
    reservation: LaunchReservation
  ): Promise<{ result: RemoteMutationResult; created: CreatedLaunch | null }> {
    if (!this.isCurrentSession(session) || !session.deviceId) {
      return { result: { outcome: "rejected", resultCode: "unauthorized" }, created: null };
    }
    const authorization = this.capabilities.authorize(session.deviceId, "launch-agents");
    if (!authorization.allowed) {
      return { result: this.authorizationRejection(authorization.reason), created: null };
    }
    const sourceWorktreeId = await this.resolveWorktree(request.projectId, request.worktreeId);
    if (!sourceWorktreeId) {
      return { result: { outcome: "rejected", resultCode: "invalid-target" }, created: null };
    }

    let lease: RemoteProjectViewLease | null = null;
    try {
      lease = await this.views.ensureBackgroundView(request.projectId);
      if (!this.isCurrentSession(session) || !this.isLaunchReservationCurrent(reservation)) {
        return { result: { outcome: "rejected", resultCode: "unauthorized" }, created: null };
      }
      const finalAuthorization = this.capabilities.authorize(session.deviceId, "launch-agents");
      if (!finalAuthorization.allowed) {
        return { result: this.authorizationRejection(finalAuthorization.reason), created: null };
      }
      const currentSource = await this.resolveWorktree(request.projectId, request.worktreeId);
      if (currentSource !== sourceWorktreeId) {
        return { result: { outcome: "rejected", resultCode: "invalid-target" }, created: null };
      }
      const catalog = await this.renderer.getLaunchableAgents(lease, sourceWorktreeId);
      const agent = catalog.agents.find((candidate) => candidate.agentId === request.agentId);
      if (
        !agent ||
        (request.modelId && !agent.modelIds.includes(request.modelId)) ||
        (request.prompt && !agent.supportsPrompt)
      ) {
        return { result: { outcome: "rejected", resultCode: "invalid-target" }, created: null };
      }
      const projection = await this.renderer.getPanelProjection(lease);
      if (projection.status !== "available") {
        return { result: { outcome: "rejected", resultCode: "unavailable" }, created: null };
      }
      if (projection.panels.some((panel) => panel.panelId === request.requestedPanelId)) {
        return { result: { outcome: "rejected", resultCode: "invalid-target" }, created: null };
      }
      if (!this.isCurrentSession(session)) {
        return { result: { outcome: "rejected", resultCode: "unauthorized" }, created: null };
      }
      const dispatchAuthorization = this.capabilities.authorize(session.deviceId, "launch-agents");
      if (!dispatchAuthorization.allowed) {
        return { result: this.authorizationRejection(dispatchAuthorization.reason), created: null };
      }
      const dispatchSource = await this.resolveWorktree(request.projectId, request.worktreeId);
      if (dispatchSource !== sourceWorktreeId) {
        return { result: { outcome: "rejected", resultCode: "invalid-target" }, created: null };
      }
      if (!this.isCurrentSession(session) || !this.isLaunchReservationCurrent(reservation)) {
        return { result: { outcome: "rejected", resultCode: "unauthorized" }, created: null };
      }
      if (
        !this.sessions.isDeviceLaunchWithinRate(
          session.deviceId,
          this.now(),
          REMOTE_RATE_WINDOW_MS,
          REMOTE_GATEWAY_LIMITS.maxLaunchesPerMinute
        )
      ) {
        return { result: { outcome: "rejected", resultCode: "rate-limited" }, created: null };
      }
      const immediateAuthorization = this.capabilities.authorize(session.deviceId, "launch-agents");
      if (!immediateAuthorization.allowed) {
        return {
          result: this.authorizationRejection(immediateAuthorization.reason),
          created: null,
        };
      }
      const launched = await this.renderer.launchAgent(lease, {
        worktreeId: sourceWorktreeId,
        agentId: request.agentId,
        requestedPanelId: request.requestedPanelId,
        ...(request.prompt ? { prompt: request.prompt } : {}),
        ...(request.presetId !== undefined ? { presetId: request.presetId } : {}),
        ...(request.modelId ? { modelId: request.modelId } : {}),
        ...(request.name ? { name: request.name } : {}),
      });
      const generation = await this.waitForGeneration(launched.panelId, launched.launchGeneration);
      const created =
        launched.panelId === request.requestedPanelId && generation === launched.launchGeneration
          ? {
              panelId: launched.panelId,
              launchGeneration: launched.launchGeneration,
              placement: launched.placement,
            }
          : null;
      if (!created) {
        return {
          result: {
            outcome: "unknown",
            resultCode: "internal-error",
            createdResourceId: launched.panelId,
          },
          created: null,
        };
      }
      return {
        result: { outcome: "committed", resultCode: "created", createdResourceId: created.panelId },
        created,
      };
    } catch (error) {
      const inspected = lease
        ? await this.inspectCreated(lease, request, sourceWorktreeId)
        : ({ status: "unavailable" } as const);
      if (inspected.status === "created") {
        return {
          result: {
            outcome: "committed",
            resultCode: "created",
            createdResourceId: inspected.created.panelId,
          },
          created: inspected.created,
        };
      }
      if (
        error instanceof RemoteRendererBridgeError &&
        error.code === "ACTION_FAILED" &&
        inspected.status === "absent"
      ) {
        return { result: { outcome: "rejected", resultCode: "unavailable" }, created: null };
      }
      return {
        result: {
          outcome: "unknown",
          resultCode: "internal-error",
          createdResourceId: request.requestedPanelId,
        },
        created: null,
      };
    } finally {
      lease?.release();
    }
  }

  private async reconcileCreated(
    session: RemoteSession,
    request: RemoteLaunchAgentRequest,
    mutationRequest: RemoteMutationRequest
  ): Promise<CreatedInspection> {
    if (!this.isCurrentSession(session)) return { status: "unavailable" };
    const sourceWorktreeId = await this.resolveWorktree(request.projectId, request.worktreeId);
    if (!sourceWorktreeId) return { status: "unavailable" };
    let lease: RemoteProjectViewLease | null = null;
    try {
      lease = await this.views.ensureBackgroundView(request.projectId);
      const inspected = await this.inspectCreated(lease, request, sourceWorktreeId);
      if (inspected.status !== "created") return inspected;
      this.mutations.reconcile(mutationRequest, {
        outcome: "committed",
        resultCode: "created",
        createdResourceId: inspected.created.panelId,
      });
      return inspected;
    } catch {
      return { status: "unavailable" };
    } finally {
      lease?.release();
    }
  }

  private async inspectCreated(
    lease: RemoteProjectViewLease,
    request: RemoteLaunchAgentRequest,
    sourceWorktreeId: string
  ): Promise<CreatedInspection> {
    let projection;
    try {
      projection = await this.renderer.getPanelProjection(lease);
    } catch {
      return { status: "unavailable" };
    }
    if (projection.status !== "available") return { status: "unavailable" };
    const panel = projection.panels.find(
      (candidate) => candidate.panelId === request.requestedPanelId
    );
    if (!panel) return { status: "absent" };
    if (
      panel.worktreeSourceId !== sourceWorktreeId ||
      panel.agentId !== request.agentId ||
      !panel.spawnedRemotely
    ) {
      return { status: "unavailable" };
    }
    if (panel.launchGeneration === undefined || panel.placement === undefined) {
      return { status: "unavailable" };
    }
    const generation = this.details.currentGeneration(panel.panelId);
    if (generation === undefined || generation !== panel.launchGeneration) {
      return { status: "unavailable" };
    }
    return {
      status: "created",
      created: {
        panelId: panel.panelId,
        launchGeneration: panel.launchGeneration,
        placement: panel.placement,
      },
    };
  }

  private async resolveWorktree(projectId: string, worktreeId: string): Promise<string | null> {
    try {
      return await this.details.resolveWorktreeSource(projectId, worktreeId);
    } catch {
      return null;
    }
  }

  private async waitForGeneration(panelId: string, expected: number): Promise<number | undefined> {
    if (expected <= 0) return this.details.currentGeneration(panelId);
    let current = this.details.currentGeneration(panelId);
    for (
      let elapsed = 0;
      current === undefined && elapsed < REMOTE_LAUNCH_GENERATION_SETTLE_MS;
      elapsed += REMOTE_LAUNCH_GENERATION_POLL_MS
    ) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, REMOTE_LAUNCH_GENERATION_POLL_MS);
        timer.unref?.();
      });
      current = this.details.currentGeneration(panelId);
    }
    return current;
  }

  private reserveLaunch(
    deviceId: string,
    request: RemoteLaunchAgentRequest
  ): LaunchReservationResult {
    const key = this.panelReservationKey(request);
    if (this.panelReservations.has(key)) {
      return { ok: false, resultCode: "invalid-target" };
    }
    const deviceCount = this.activeByDevice.get(deviceId) ?? 0;
    if (
      this.activeLaunches >= MAX_CONCURRENT_REMOTE_LAUNCHES ||
      deviceCount >= MAX_CONCURRENT_REMOTE_LAUNCHES_PER_DEVICE
    ) {
      return { ok: false, resultCode: "rate-limited" };
    }
    const reservation: LaunchReservation = {
      key,
      owner: `${deviceId}:${request.idempotencyKey}`,
      deviceId,
      token: Symbol(key),
    };
    this.panelReservations.set(key, reservation);
    this.activeLaunches += 1;
    this.activeByDevice.set(deviceId, deviceCount + 1);
    return { ok: true, reservation };
  }

  private releaseLaunch(reservation: LaunchReservation): void {
    if (this.panelReservations.get(reservation.key)?.token !== reservation.token) return;
    this.panelReservations.delete(reservation.key);
    this.activeLaunches = Math.max(0, this.activeLaunches - 1);
    const deviceCount = this.activeByDevice.get(reservation.deviceId) ?? 0;
    if (deviceCount <= 1) this.activeByDevice.delete(reservation.deviceId);
    else this.activeByDevice.set(reservation.deviceId, deviceCount - 1);
  }

  private isLaunchReservationCurrent(reservation: LaunchReservation): boolean {
    return (
      this.panelReservations.get(reservation.key)?.token === reservation.token &&
      this.activeLaunches <= MAX_CONCURRENT_REMOTE_LAUNCHES &&
      (this.activeByDevice.get(reservation.deviceId) ?? 0) <=
        MAX_CONCURRENT_REMOTE_LAUNCHES_PER_DEVICE
    );
  }

  private panelReservationKey(request: RemoteLaunchAgentRequest): string {
    return `${request.projectId}:${request.requestedPanelId}`;
  }

  private authorized(
    session: RemoteSession,
    requestId: string,
    capability: "launch-agents"
  ): boolean {
    if (!this.isCurrentSession(session) || !session.deviceId) {
      this.error(session, requestId, "SESSION_NOT_READY", "Remote session is no longer active");
      return false;
    }
    const authorization = this.capabilities.authorize(session.deviceId, capability);
    if (!authorization.allowed) {
      this.error(
        session,
        requestId,
        authorization.reason === "revoked" ? "DEVICE_REVOKED" : "FORBIDDEN",
        authorization.reason === "revoked"
          ? "Paired device was revoked"
          : "Agent launch capability is required"
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

  private sendCreated(
    session: RemoteSession,
    requestId: string,
    request: RemoteLaunchAgentRequest,
    created: CreatedLaunch,
    replayed: boolean
  ): void {
    const result: RemoteLaunchAgentResult = {
      idempotencyKey: request.idempotencyKey,
      requestedPanelId: request.requestedPanelId,
      panelId: created.panelId,
      launchGeneration: created.launchGeneration,
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      agentId: request.agentId,
      placement: created.placement,
      spawnStatus: "starting",
      disposition: replayed ? "existing" : "created",
    };
    this.send(session, requestId, "agent.launchResult", result);
  }

  private sendUnknown(
    session: RemoteSession,
    requestId: string,
    request: RemoteLaunchAgentRequest,
    resultCode: "commit-in-progress" | "internal-error" | "unavailable"
  ): void {
    const result: RemoteLaunchAgentResult = {
      idempotencyKey: request.idempotencyKey,
      requestedPanelId: request.requestedPanelId,
      disposition: "unknown",
      resultCode,
    };
    this.send(session, requestId, "agent.launchResult", result);
  }

  private sendRejection(
    session: RemoteSession,
    requestId: string,
    result: RemoteMutationResult
  ): void {
    const code: RemoteErrorCode =
      result.resultCode === "rate-limited"
        ? "RATE_LIMITED"
        : result.resultCode === "revoked"
          ? "DEVICE_REVOKED"
          : result.resultCode === "capability-denied" || result.resultCode === "unauthorized"
            ? "FORBIDDEN"
            : result.resultCode === "invalid-target"
              ? "NOT_FOUND"
              : "INTERNAL_ERROR";
    this.error(session, requestId, code, "Agent launch was rejected");
  }

  private auditResult(
    session: RemoteSession,
    request: RemoteLaunchAgentRequest,
    result: "committed" | "rejected" | "unknown" | "conflict" | "denied",
    panelId = request.requestedPanelId
  ): void {
    this.audit.record({
      actorDeviceId: session.deviceId ?? undefined,
      sessionId: session.id,
      operation: "agent.launch.result",
      result,
      targetProjectId: request.projectId,
      targetWorktreeId: request.worktreeId,
      targetPanelId: panelId,
      ...(request.prompt ? remoteContentMetadata(request.prompt) : {}),
    });
  }

  private auditClose(
    session: RemoteSession,
    request: RemoteCloseAgentRequest,
    result: "committed" | "rejected" | "unknown" | "conflict" | "denied"
  ): void {
    this.audit.record({
      actorDeviceId: session.deviceId ?? undefined,
      sessionId: session.id,
      operation: "agent.close.result",
      result,
      targetProjectId: request.projectId,
      targetWorktreeId: request.worktreeId,
      targetPanelId: request.panelId,
    });
  }

  private send(
    session: RemoteSession,
    requestId: string,
    type: "agents.launchable" | "agent.launchResult" | "agent.closeResult" | "request.status",
    payload: unknown
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
