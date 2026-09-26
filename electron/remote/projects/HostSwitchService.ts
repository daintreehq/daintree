import type {
  HostProjectPresence,
  HostSwitchCheckDestinationPayload,
  HostSwitchExecutePayload,
  HostSwitchExecuteResult,
  HostSwitchListDirectoryPayload,
  HostSwitchLocatePayload,
  HostSwitchOpPayload,
  HostSwitchPickerRootsPayload,
  HostSwitchPlan,
  HostSwitchPlanPayload,
  HostSwitchPreparation,
  HostSwitchStatus,
  HostSwitchSuggestClonePayload,
} from "../../../shared/types/ipc/hostSwitch.js";
import type { HostDirectoryListing, HostPickerRoots } from "../../../shared/types/ipc/hostFiles.js";
import type {
  CloneAndOpenOutcome,
  DestinationCheck,
  HostBranchTarget,
  HostCloneOptions,
  HostProjectOpened,
  PushBranchOutcome,
  PushBranchPayload,
} from "../../../shared/types/ipc/projectMatch.js";
import {
  LOCAL_HOST_ID,
  isLocalHostId,
  type HostId,
  type OperationOutcome,
} from "../../../shared/types/remoteHosts.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  isSupportedCloneUrl,
  repositoryNameFromRemote,
  stripGitRemoteCredentials,
  stripRemoteListCredentials,
} from "../../../shared/utils/gitRemoteUrl.js";
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
/** A menu asks about the hosts it lists; more than this is not a menu. */
const MAX_LOCATE_HOSTS = 32;

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
    const described = await from.describeSource({
      projectId: payload.projectId,
      worktreePath: payload.worktreePath ?? null,
    });
    // Neither the other host nor the dialog ever sees a remote's embedded credentials.
    const source = {
      ...described,
      remotes: stripRemoteListCredentials(described.remotes),
      cloneUrl: described.cloneUrl === null ? null : stripGitRemoteCredentials(described.cloneUrl),
    };
    const remoteUrls = source.remotes.map((remote) => remote.url);
    const [found, environment, destination] = await Promise.all([
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
    const candidates = found.map((candidate) => ({
      ...candidate,
      remotes: stripRemoteListCredentials(candidate.remotes),
    }));
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
      destination: destination && withoutGrant(destination),
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
    return this.gateway(payload.toHostId)
      .checkDestination({
        path: payload.path,
        remoteUrls: Array.isArray(payload.remoteUrls)
          ? payload.remoteUrls.map(stripGitRemoteCredentials)
          : [],
      })
      .then(withoutGrant);
  }

  /**
   * Which of `toHostIds` already have the window's project, by repository
   * identity: registered projects there sharing a remote with it. A shared
   * name or a committed id alone never counts. Only registered projects are
   * read (no disk scan), so a menu can ask each time it opens.
   */
  async locate(ctx: IpcContext, payload: HostSwitchLocatePayload): Promise<HostProjectPresence[]> {
    const from = this.source(ctx, payload?.fromHostId);
    if (!Array.isArray(payload.toHostIds)) throw invalid("toHostIds is required");
    const targets = [...new Set(payload.toHostIds)]
      .filter((id): id is HostId => typeof id === "string" && id !== from.hostId)
      .slice(0, MAX_LOCATE_HOSTS);
    const identity = await from.identify({ projectId: payload.projectId });
    const remoteUrls = stripRemoteListCredentials(identity.remotes).map((remote) => remote.url);
    return Promise.all(
      targets.map(async (hostId): Promise<HostProjectPresence> => {
        if (remoteUrls.length === 0) return { hostId, projects: [] };
        try {
          const found = await this.gateway(hostId).find({
            remoteUrls,
            committedProjectId: identity.committedProjectId,
          });
          return {
            hostId,
            projects: found
              .filter((c) => c.matchedBy === "remote-url" && c.projectId !== null)
              .map((c) => ({ projectId: c.projectId!, name: c.name, path: c.path })),
          };
        } catch {
          return { hostId, projects: null };
        }
      })
    );
  }

  /** Where a clone of `url` would go on the host, checked there. */
  async suggestCloneDestination(payload: HostSwitchSuggestClonePayload): Promise<DestinationCheck> {
    if (typeof payload?.toHostId !== "string") throw invalid("toHostId is required");
    const url = requireCloneUrl(payload.url);
    const repoName = repositoryNameFromRemote(url);
    if (!repoName) throw invalid("That URL doesn't name a repository");
    return this.gateway(payload.toHostId)
      .suggestDestination({ homeRelativePath: null, repoName, remoteUrls: [url] })
      .then(withoutGrant);
  }

  /** A folder on the host, for Daintree's picker browsing a host other than the window's. */
  listDirectory(payload: HostSwitchListDirectoryPayload): Promise<HostDirectoryListing> {
    if (typeof payload?.toHostId !== "string") throw invalid("toHostId is required");
    if (typeof payload.path !== "string") throw invalid("path is required");
    return this.gateway(payload.toHostId).listDirectory({
      path: payload.path,
      showHidden: payload.showHidden === true,
    });
  }

  pickerRoots(payload: HostSwitchPickerRootsPayload): Promise<HostPickerRoots> {
    if (typeof payload?.toHostId !== "string") throw invalid("toHostId is required");
    return this.gateway(payload.toHostId).pickerRoots();
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
              remoteUrls: payload.remoteUrls.map(stripGitRemoteCredentials),
              branch: payload.branch,
              branchRemoteUrl: stripOptional(payload.branchRemoteUrl),
            })
          );
        };
        break;
      }
      case "clone-url": {
        const to = this.gateway(payload.toHostId);
        const url = requireCloneUrl(payload.url);
        run = (track) => this.cloneUrl(to, opId, url, payload, track);
        break;
      }
      case "create-worktree": {
        const to = this.gateway(payload.toHostId);
        run = (track) => this.placeWorktree(to, opId, payload, track);
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
              branchRemoteUrl: stripOptional(payload.branchRemoteUrl),
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
        this.settle(
          track,
          result.kind === "git-failed" || result.kind === "push-unconfirmed"
            ? "failed"
            : "succeeded"
        );
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
    // Cancel kills git on the source host; the push then settles as cancelled.
    const controller = new AbortController();
    track.cancel = async () => {
      controller.abort();
      return true;
    };
    const request = {
      projectId: payload.projectId,
      worktreePath: payload.worktreePath,
      branch: payload.branch,
      remote: payload.remote,
      remoteBranch: payload.remoteBranch,
    };
    let outcome: PushBranchOutcome;
    try {
      outcome = await from.pushBranch({ opId: payload.opId, ...request }, controller.signal);
    } catch (error) {
      if (from.kind !== "remote" || !isLinkDrop(error) || controller.signal.aborted) throw error;
      return this.reconcilePush(from, payload.opId, request, track, controller.signal);
    }
    return pushResult(from.hostId, outcome);
  }

  /**
   * The link dropped before the push answered, and the remote ref may already
   * have moved. Once the source is back, take its record of the push; with no
   * settled record, look at the remote branch and the local tip rather than
   * guess, and report what was seen.
   */
  private async reconcilePush(
    from: HostGateway,
    opId: string,
    request: PushBranchPayload,
    track: Tracked,
    signal: AbortSignal
  ): Promise<HostSwitchExecuteResult> {
    // Cancelling now only stops the wait: the push itself already ended with the link.
    const stopIfCancelled = () => {
      if (signal.aborted) throw new AppError({ code: "CANCELLED", message: "Push cancelled" });
    };
    const interval = this.options.pollIntervalMs ?? DEFAULT_POLL_MS;
    for (let drops = 0; ;) {
      this.stage(track, "reconnecting", "Waiting for the host to come back");
      const back = await this.options.whenReconnected(
        from.hostId,
        this.options.reconnectTimeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS
      );
      if (!back) {
        throw new AppError({
          code: "OUTCOME_UNKNOWN",
          message: `Lost the link to ${from.hostId} during the push`,
          userMessage: `Lost the link to ${from.hostId} during the push. Check ${request.branch} on its remote once the host is back.`,
        });
      }
      stopIfCancelled();
      this.stage(track, "checking", "Checking the push with the host");
      try {
        // A push the host still reports running is followed only so long;
        // past that, what the remote shows is the answer.
        const deadline =
          this.now() + (this.options.reconnectTimeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS);
        let status = await from.pushStatus(opId, request.projectId);
        while (status.state === "running" && this.now() < deadline) {
          await sleep(interval);
          stopIfCancelled();
          status = await from.pushStatus(opId, request.projectId);
        }
        if (status.state === "settled") return pushResult(from.hostId, status.outcome);
        if (status.state === "cancelled") {
          throw new AppError({ code: "CANCELLED", message: "Push cancelled" });
        }
        const observed = await from.observePush(request);
        if (
          observed.remoteReachable &&
          observed.localSha !== null &&
          observed.remoteSha !== null &&
          observed.localSha.toLowerCase() === observed.remoteSha.toLowerCase()
        ) {
          return { kind: "pushed" };
        }
        return {
          kind: "push-unconfirmed",
          hostId: from.hostId,
          branch: request.branch,
          remote: request.remote,
          remoteBranch: request.remoteBranch,
          observed,
        };
      } catch (error) {
        if (!isLinkDrop(error) || ++drops > 2) throw error;
      }
    }
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
        source = { kind: "remote", url: stripGitRemoteCredentials(payload.source.url) };
      }
      stopIfCancelled();

      this.stage(track, "cloning", "Cloning", 0);
      const start = {
        opId,
        source,
        destination: payload.destination,
        branch: payload.branch as HostBranchTarget | null,
        options: payload.options as HostCloneOptions,
        setupRecipeId: payload.setupRecipeId,
      };
      await this.startResiliently(to, opId, track, () => to.startClone(start), "clone");
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
   * Start an operation on the target. When the link drops before the answer,
   * the host may or may not have it: wait for the link, ask by opId, and
   * only resend (the host dedups by opId) when it has no record.
   */
  private async startResiliently(
    to: HostGateway,
    opId: string,
    track: Tracked,
    start: () => Promise<void>,
    what: string
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await start();
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
          message: `Lost the link to ${to.hostId} while starting the ${what}`,
          userMessage: `The host dropped off as the ${what} started. Check it once it's back.`,
        });
      }
      const status = await to.operationStatus(opId).catch(() => null);
      if (status && status.status !== "unknown") return;
    }
  }

  /** Clone a repository by URL onto `to`: Add project… on a host, with no source project. */
  private async cloneUrl(
    to: HostGateway,
    opId: string,
    url: string,
    payload: Extract<HostSwitchExecutePayload, { kind: "clone-url" }>,
    track: Tracked
  ): Promise<HostSwitchExecuteResult> {
    let cancelled = false;
    let started = false;
    track.cancel = async () => {
      cancelled = true;
      return started ? to.cancelOperation(opId) : true;
    };
    this.stage(track, "cloning", "Cloning", 0);
    await this.startResiliently(
      to,
      opId,
      track,
      () =>
        to.startClone({
          opId,
          source: { kind: "remote", url },
          destination: payload.destination,
          branch: null,
          options: payload.options as HostCloneOptions,
          setupRecipeId: null,
        }),
      "clone"
    );
    started = true;
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
   * Create the new-worktree dialog's worktree on `to`, in a project it has:
   * open it there first (which is also what lets this Shell change it, on a
   * host where it has no view yet), then follow the host's operation by id.
   */
  private async placeWorktree(
    to: HostGateway,
    opId: string,
    payload: Extract<HostSwitchExecutePayload, { kind: "create-worktree" }>,
    track: Tracked
  ): Promise<HostSwitchExecuteResult> {
    let started = false;
    track.cancel = async () => (started ? to.cancelOperation(opId) : false);
    this.stage(track, "opening", "Opening the project");
    await to.open({
      projectId: payload.projectId,
      // Read only for an unregistered folder; a registered project is found by id.
      path: "/",
      remoteUrls: [],
      branch: null,
      branchRemoteUrl: null,
    });
    this.stage(track, "worktree", "Creating the worktree");
    await this.startResiliently(
      to,
      opId,
      track,
      () =>
        to.startPlaceWorktree({
          opId,
          projectId: payload.projectId,
          worktree: payload.worktree,
        }),
      "worktree"
    );
    started = true;
    const outcome = await this.follow(to, opId, track);
    if (!outcome.ok) {
      return {
        kind: "git-failed",
        step: "worktree",
        hostId: to.hostId,
        reason: outcome.reason,
        message: outcome.message,
      };
    }
    const { ok: _ok, ...result } = outcome;
    return opened(to.hostId, result);
  }

  /**
   * Follow the target's operation (a clone, or a placed worktree) by id until it settles. A dropped
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
              message: "The host sent an invalid result",
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

function requireCloneUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096)
    throw invalid("A repository URL is required");
  const url = stripGitRemoteCredentials(value.trim());
  if (!isSupportedCloneUrl(url)) throw invalid("Only HTTP(S) and SSH remotes can be cloned");
  return url;
}

function stripOptional(url: string | null | undefined): string | null {
  return typeof url === "string" ? stripGitRemoteCredentials(url) : null;
}

/** A destination grant is between the Shell's main process and the host; renderers never hold one. */
function withoutGrant(check: DestinationCheck & { grant?: unknown }): DestinationCheck {
  const { grant: _grant, ...rest } = check;
  return rest;
}

function pushResult(hostId: HostId, outcome: PushBranchOutcome): HostSwitchExecuteResult {
  if (outcome.ok) return { kind: "pushed" };
  return {
    kind: "git-failed",
    step: "push",
    hostId,
    reason: outcome.reason,
    message: outcome.message,
  };
}

function opened(hostId: HostId, result: HostProjectOpened): HostSwitchExecuteResult {
  return { kind: "opened", hostId, ...result };
}
