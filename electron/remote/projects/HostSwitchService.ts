import type {
  HostSwitchCheckDestinationPayload,
  HostSwitchExecutePayload,
  HostSwitchExecuteResult,
  HostSwitchOpPayload,
  HostSwitchPlan,
  HostSwitchPlanPayload,
  HostSwitchPreparation,
  HostSwitchStatus,
} from "../../../shared/types/ipc/hostSwitch.js";
import type {
  CloneAndOpenOutcome,
  DestinationCheck,
  HostBranchTarget,
  HostCloneOptions,
  HostProjectOpened,
} from "../../../shared/types/ipc/projectMatch.js";
import {
  LOCAL_HOST_ID,
  isLocalHostId,
  type HostId,
  type OperationOutcome,
} from "../../../shared/types/remoteHosts.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { IpcContext } from "../../ipc/types.js";
import { normalizeOperationId } from "../../services/operations/OperationRegistry.js";
import type { ProjectAcrossHostsService } from "../../services/projectAcrossHosts/index.js";
import { AppError } from "../../utils/errorTypes.js";
import { fileTransferSource } from "../link/transfer.js";
import { expectClientBundle } from "./bundleSinks.js";
import {
  LocalHostGateway,
  RemoteHostGateway,
  type HostGateway,
  type SessionResolver,
} from "./gateways.js";
import { BUNDLE_SINK_PREFIX, CloneOutcomeSchema, ProjectLinkMethod } from "./linkMethods.js";

export interface HostSwitchServiceOptions {
  /** This machine's host-side service (the "local" host). */
  local: ProjectAcrossHostsService;
  resolveSession: SessionResolver;
  /** The host the calling view belongs to: the source of any switch it asks for. */
  hostOfSender(ctx: IpcContext): HostId;
  isKnownHost(hostId: HostId): boolean;
  /** Wait for a dropped host to come back; true once it is usable again. */
  whenReconnected(hostId: HostId, timeoutMs: number): Promise<boolean>;
  pollIntervalMs?: number;
  reconnectTimeoutMs?: number;
  now?: () => number;
}

const DEFAULT_POLL_MS = 400;
const DEFAULT_RECONNECT_TIMEOUT_MS = 120_000;
const TRACK_RETENTION_MS = 10 * 60_000;
const MAX_TRACKED = 100;
const MAX_UNKNOWN_POLLS = 5;

interface Tracked {
  /** The request itself, so a reused opId can't be answered with another request's result. */
  fingerprint: string;
  status: HostSwitchStatus;
  settledAt: number | null;
  cancel: (() => Promise<boolean>) | null;
  promise: Promise<HostSwitchExecuteResult>;
}

function invalid(message: string): AppError {
  return new AppError({ code: "VALIDATION", message });
}

function isLinkDrop(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "HOST_DISCONNECTED" || code === "OUTCOME_UNKNOWN";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireOpId(value: unknown): string {
  const opId = normalizeOperationId(value);
  if (!opId) throw invalid("Invalid operation id");
  return opId;
}

/**
 * The Shell's half of getting a project onto another host: it asks the
 * source host about the branch, the target about what it already has, and
 * runs each confirmed step on the host it belongs to — a push on the source
 * with the source's credentials, a clone on the target with the target's.
 * Works the same in either direction; "source" is whichever host the
 * window is on.
 */
export class HostSwitchService {
  private readonly tracked = new Map<string, Tracked>();
  private readonly now: () => number;

  constructor(private readonly options: HostSwitchServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  private gateway(hostId: HostId): HostGateway {
    if (isLocalHostId(hostId)) return new LocalHostGateway(LOCAL_HOST_ID, this.options.local);
    if (!this.options.isKnownHost(hostId)) {
      throw new AppError({
        code: "NOT_FOUND",
        message: `No host with id "${hostId}"`,
        userMessage: "That host isn't in the host list.",
      });
    }
    return new RemoteHostGateway(hostId, this.options.resolveSession);
  }

  /** The source is the calling view's own host; the target is any other known host. */
  private endpoints(
    ctx: IpcContext,
    fromHostId: unknown,
    toHostId: unknown
  ): { from: HostGateway; to: HostGateway } {
    if (typeof fromHostId !== "string" || typeof toHostId !== "string") {
      throw invalid("fromHostId and toHostId are required");
    }
    if (this.options.hostOfSender(ctx) !== fromHostId) {
      throw invalid("fromHostId must be the calling window's host");
    }
    if (fromHostId === toHostId) throw invalid("The project is already on that host");
    return { from: this.gateway(fromHostId), to: this.gateway(toHostId) };
  }

  private source(ctx: IpcContext, fromHostId: unknown): HostGateway {
    if (typeof fromHostId !== "string") throw invalid("fromHostId is required");
    if (this.options.hostOfSender(ctx) !== fromHostId) {
      throw invalid("fromHostId must be the calling window's host");
    }
    return this.gateway(fromHostId);
  }

  async prepare(ctx: IpcContext, payload: HostSwitchPlanPayload): Promise<HostSwitchPreparation> {
    const { from, to } = this.endpoints(ctx, payload?.fromHostId, payload?.toHostId);
    const source = await from.describeSource({
      projectId: payload.projectId,
      worktreePath: payload.worktreePath ?? null,
    });
    const remoteUrls = source.remotes.map((remote) => remote.url);
    const [candidates, environment, destination] = await Promise.all([
      to.match({ remoteUrls, committedProjectId: source.committedProjectId }),
      to.environment(),
      to
        .suggestDestination({
          homeRelativePath: source.homeRelativePath,
          repoName: source.repoName,
          remoteUrls,
        })
        .catch((): DestinationCheck | null => null),
    ]);
    return {
      fromHostId: from.hostId,
      toHostId: to.hostId,
      projectId: source.projectId,
      projectName: source.projectName,
      worktreePath: source.worktreePath,
      branch: source.branch,
      branchCheck: source.branchCheck,
      remoteBranch: source.remoteBranch,
      cloneUrl: source.cloneUrl,
      hasUncommittedChanges: source.hasUncommittedChanges,
      unpushedCommits: source.unpushedCommits,
      remotes: source.remotes,
      committedProjectId: source.committedProjectId,
      candidates,
      destination,
      usesLfs: source.usesLfs,
      hasSubmodules: source.hasSubmodules,
      targetGitLfsAvailable: environment.gitLfsAvailable,
      recipes: source.recipes,
      defaultRecipeId: source.defaultRecipeId,
    };
  }

  async plan(ctx: IpcContext, payload: HostSwitchPlanPayload): Promise<HostSwitchPlan> {
    const prepared = await this.prepare(ctx, payload);
    const check = prepared.branchCheck;
    return {
      projectName: prepared.projectName,
      branch: prepared.branch,
      // Behind loses nothing by continuing from the remote, which is what a same tip means here.
      branchState:
        check?.kind === "behind"
          ? { kind: "same-tip", remote: check.remote, sha: check.sha }
          : check,
      hasUncommittedChanges: prepared.hasUncommittedChanges,
      remotes: prepared.remotes,
      candidates: prepared.candidates,
      suggestedDestination: prepared.destination?.path ?? null,
    };
  }

  checkDestination(payload: HostSwitchCheckDestinationPayload): Promise<DestinationCheck> {
    if (typeof payload?.toHostId !== "string") throw invalid("toHostId is required");
    return this.gateway(payload.toHostId).checkDestination({
      path: payload.path,
      remoteUrls: Array.isArray(payload.remoteUrls) ? payload.remoteUrls : [],
    });
  }

  execute(ctx: IpcContext, payload: HostSwitchExecutePayload): Promise<HostSwitchExecuteResult> {
    const opId = requireOpId(payload?.opId);
    const fingerprint = JSON.stringify({ from: this.options.hostOfSender(ctx), payload });
    const existing = this.tracked.get(opId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw invalid(`Operation id ${opId} belongs to another request`);
      }
      return existing.promise;
    }
    this.prune();

    let run: (track: Tracked) => Promise<HostSwitchExecuteResult>;
    switch (payload.kind) {
      case "push": {
        const from = this.source(ctx, payload.fromHostId);
        run = (track) => this.push(from, payload, track);
        break;
      }
      case "clone": {
        const { from, to } = this.endpoints(ctx, payload.fromHostId, payload.toHostId);
        run = (track) => this.clone(from, to, opId, payload, track);
        break;
      }
      case "open": {
        const to = this.gateway(payload.toHostId);
        run = async (track) => {
          this.stage(track, "opening", "Opening the project");
          return opened(
            to.hostId,
            await to.open({
              projectId: payload.candidate.projectId,
              path: payload.candidate.path,
              remoteUrls: payload.remoteUrls,
              branch: payload.branch,
              branchRemoteUrl: payload.branchRemoteUrl,
            })
          );
        };
        break;
      }
      case "checkout": {
        const to = this.gateway(payload.toHostId);
        run = async (track) => {
          this.stage(track, "worktree", "Creating the worktree");
          return opened(
            to.hostId,
            await to.checkOut({
              projectId: payload.projectId,
              branch: payload.branch,
              branchRemoteUrl: payload.branchRemoteUrl,
            })
          );
        };
        break;
      }
      default:
        throw invalid("Unknown step");
    }

    const track: Tracked = {
      fingerprint,
      status: { opId, state: "running", stage: null, message: null, fraction: null },
      settledAt: null,
      cancel: null,
      promise: Promise.resolve(null as unknown as HostSwitchExecuteResult),
    };
    track.promise = run(track).then(
      (result) => {
        this.settle(track, result.kind === "git-failed" ? "failed" : "succeeded");
        return result;
      },
      (error: unknown) => {
        const cancelled = (error as { code?: unknown } | null)?.code === "CANCELLED";
        this.settle(track, cancelled ? "cancelled" : "failed", formatErrorMessage(error, "Failed"));
        throw error;
      }
    );
    this.tracked.set(opId, track);
    return track.promise;
  }

  status(payload: HostSwitchOpPayload): HostSwitchStatus {
    const opId = requireOpId(payload?.opId);
    this.prune();
    const track = this.tracked.get(opId);
    return track
      ? { ...track.status }
      : { opId, state: "unknown", stage: null, message: null, fraction: null };
  }

  async cancel(payload: HostSwitchOpPayload): Promise<boolean> {
    const opId = requireOpId(payload?.opId);
    const track = this.tracked.get(opId);
    if (!track || track.status.state !== "running" || !track.cancel) return false;
    return track.cancel();
  }

  private stage(
    track: Tracked,
    stage: string,
    message: string | null,
    fraction: number | null = null
  ) {
    if (track.status.state !== "running") return;
    track.status = { ...track.status, stage, message, fraction };
  }

  private settle(track: Tracked, state: HostSwitchStatus["state"], message?: string): void {
    track.status = {
      ...track.status,
      state,
      ...(message !== undefined ? { message } : {}),
    };
    track.settledAt = this.now();
    track.cancel = null;
  }

  private prune(): void {
    const cutoff = this.now() - TRACK_RETENTION_MS;
    for (const [opId, track] of this.tracked) {
      if (track.settledAt !== null && track.settledAt < cutoff) this.tracked.delete(opId);
    }
    if (this.tracked.size <= MAX_TRACKED) return;
    for (const [opId, track] of this.tracked) {
      if (this.tracked.size <= MAX_TRACKED) break;
      if (track.settledAt !== null) this.tracked.delete(opId);
    }
  }

  private async push(
    from: HostGateway,
    payload: Extract<HostSwitchExecutePayload, { kind: "push" }>,
    track: Tracked
  ): Promise<HostSwitchExecuteResult> {
    this.stage(track, "pushing", `Pushing ${payload.branch}`);
    const outcome = await from.pushBranch({
      projectId: payload.projectId,
      worktreePath: payload.worktreePath,
      branch: payload.branch,
      remote: payload.remote,
      remoteBranch: payload.remoteBranch,
    });
    if (outcome.ok) return { kind: "pushed" };
    return {
      kind: "git-failed",
      step: "push",
      hostId: from.hostId,
      reason: outcome.reason,
      message: outcome.message,
    };
  }

  private async clone(
    from: HostGateway,
    to: HostGateway,
    opId: string,
    payload: Extract<HostSwitchExecutePayload, { kind: "clone" }>,
    track: Tracked
  ): Promise<HostSwitchExecuteResult> {
    let cancelled = false;
    let cloneStarted = false;
    track.cancel = async () => {
      cancelled = true;
      if (cloneStarted) return to.cancelOperation(opId);
      return true;
    };
    const stopIfCancelled = () => {
      if (cancelled) throw new AppError({ code: "CANCELLED", message: "Cancelled" });
    };

    let source: { kind: "remote"; url: string } | { kind: "bundle"; token: string };
    // A bundle on the target is ours to clean up until its clone has started.
    let unclaimedTargetBundle: string | null = null;
    try {
      if (payload.source.kind === "bundle") {
        this.stage(track, "bundling", "Packing the repository");
        const bundle = await from.createBundle(payload.projectId);
        if (cancelled) {
          await from.discardBundle(bundle.token).catch(() => {});
          stopIfCancelled();
        }
        this.stage(track, "sending", "Sending the repository");
        unclaimedTargetBundle = await this.moveBundle(from, to, bundle.token);
        source = { kind: "bundle", token: unclaimedTargetBundle };
      } else {
        source = { kind: "remote", url: payload.source.url };
      }
      stopIfCancelled();

      this.stage(track, "cloning", "Cloning", 0);
      await this.startCloneResiliently(to, opId, track, {
        opId,
        source,
        destination: payload.destination,
        branch: payload.branch as HostBranchTarget | null,
        options: payload.options as HostCloneOptions,
        setupRecipeId: payload.setupRecipeId,
      });
      unclaimedTargetBundle = null;
    } finally {
      if (unclaimedTargetBundle) await to.discardBundle(unclaimedTargetBundle).catch(() => {});
    }
    cloneStarted = true;
    if (cancelled) await to.cancelOperation(opId).catch(() => false);

    const outcome = await this.follow(to, opId, track);
    if (!outcome.ok) {
      return {
        kind: "git-failed",
        step: "clone",
        hostId: to.hostId,
        reason: outcome.reason,
        message: outcome.message,
      };
    }
    const { ok: _ok, ...result } = outcome;
    return opened(to.hostId, result);
  }

  /**
   * Start the target's clone. When the link drops before the answer, the
   * host may or may not have it: wait for the link, ask by opId, and only
   * resend (the host dedups by opId) when it has no record.
   */
  private async startCloneResiliently(
    to: HostGateway,
    opId: string,
    track: Tracked,
    payload: Parameters<HostGateway["startClone"]>[0]
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await to.startClone(payload);
        return;
      } catch (error) {
        if (to.kind !== "remote" || !isLinkDrop(error) || attempt >= 2) throw error;
      }
      this.stage(track, "reconnecting", "Waiting for the host to come back");
      const back = await this.options.whenReconnected(
        to.hostId,
        this.options.reconnectTimeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS
      );
      if (!back) {
        throw new AppError({
          code: "OUTCOME_UNKNOWN",
          message: `Lost the link to ${to.hostId} while starting the clone`,
          userMessage: "The host dropped off as the clone started. Check it once it's back.",
        });
      }
      const status = await to.operationStatus(opId).catch(() => null);
      if (status && status.status !== "unknown") return;
    }
  }

  /**
   * Follow the target's clone operation by id until it settles. A dropped
   * link doesn't end it — the host keeps working and keeps the outcome — so
   * wait for the host to come back and ask again.
   */
  private async follow(
    to: HostGateway,
    opId: string,
    track: Tracked
  ): Promise<CloneAndOpenOutcome> {
    const interval = this.options.pollIntervalMs ?? DEFAULT_POLL_MS;
    let unknown = 0;
    for (;;) {
      let outcome: OperationOutcome;
      try {
        outcome = await to.operationStatus(opId);
      } catch (error) {
        if (to.kind !== "remote" || !isLinkDrop(error)) throw error;
        this.stage(track, "reconnecting", "Waiting for the host to come back");
        const back = await this.options.whenReconnected(
          to.hostId,
          this.options.reconnectTimeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS
        );
        if (!back) {
          throw new AppError({
            code: "OUTCOME_UNKNOWN",
            message: `Lost the link to ${to.hostId} during the clone`,
            userMessage: "The host dropped off mid-clone. Check it once it's back.",
          });
        }
        continue;
      }
      switch (outcome.status) {
        case "running": {
          unknown = 0;
          const progress = outcome.progress;
          if (progress) {
            this.stage(track, progress.stage ?? "cloning", progress.message, progress.fraction);
          }
          break;
        }
        case "succeeded": {
          const parsed = CloneOutcomeSchema.safeParse(outcome.result);
          if (!parsed.success) {
            throw new AppError({
              code: "INTERNAL",
              message: "The host sent an invalid clone result",
            });
          }
          return parsed.data;
        }
        case "failed":
          return {
            ok: false,
            reason: outcome.error.code ?? "unknown",
            message: outcome.error.message,
          };
        case "cancelled":
          throw new AppError({ code: "CANCELLED", message: "Clone cancelled" });
        case "unknown":
          if (++unknown > MAX_UNKNOWN_POLLS) {
            throw new AppError({
              code: "OUTCOME_UNKNOWN",
              message: `Host ${to.hostId} has no record of clone ${opId}`,
              userMessage: "The host has no record of the clone. Check its project list.",
            });
          }
          break;
      }
      await sleep(interval);
    }
  }

  /**
   * Carry a bundle from the source host to the target over the links' bulk
   * lane, relaying through this machine when neither end is it. Whatever the
   * route, the source's copy is deleted afterwards.
   */
  private async moveBundle(from: HostGateway, to: HostGateway, fromToken: string): Promise<string> {
    const local = this.options.local;
    try {
      if (from instanceof LocalHostGateway && to instanceof RemoteHostGateway) {
        const entry = local.bundles.get(fromToken);
        if (!entry) throw new AppError({ code: "NOT_FOUND", message: "The bundle is gone" });
        return await this.upload(to, entry.path);
      }
      if (from instanceof RemoteHostGateway && to instanceof LocalHostGateway) {
        return await this.download(from, fromToken);
      }
      if (from instanceof RemoteHostGateway && to instanceof RemoteHostGateway) {
        const staged = await this.download(from, fromToken);
        try {
          return await this.upload(to, local.bundles.get(staged)!.path);
        } finally {
          await local.bundles.discard(staged);
        }
      }
      throw invalid("A bundle moves between two different hosts");
    } finally {
      await from.discardBundle(fromToken).catch(() => {});
    }
  }

  private async upload(to: RemoteHostGateway, localPath: string): Promise<string> {
    const token = await to.expectBundle();
    let source: Awaited<ReturnType<typeof fileTransferSource>> | null = null;
    try {
      const session = await to.session();
      source = await fileTransferSource(localPath);
      await session.transfers.send(source, {
        name: "repository.bundle",
        destination: { kind: "path", path: `${BUNDLE_SINK_PREFIX}${token}` },
      });
    } catch (error) {
      await to.discardBundle(token).catch(() => {});
      throw error;
    } finally {
      await source?.close?.();
    }
    return token;
  }

  /** Pull a host's bundle into this machine's bundle store; returns its token here. */
  private async download(from: RemoteHostGateway, fromToken: string): Promise<string> {
    const slot = await this.options.local.bundles.expect();
    const release = expectClientBundle(slot.token, slot.path);
    try {
      const session = await from.session();
      await session.call(
        ProjectLinkMethod.BUNDLE_SEND,
        { token: fromToken, sinkToken: slot.token },
        { timeoutMs: 0 }
      );
      return slot.token;
    } catch (error) {
      await this.options.local.bundles.discard(slot.token);
      throw error;
    } finally {
      release();
    }
  }
}

function opened(hostId: HostId, result: HostProjectOpened): HostSwitchExecuteResult {
  return { kind: "opened", hostId, ...result };
}
