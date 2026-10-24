import { events } from "./events.js";
import { logInfo, logWarn, logDebug } from "../utils/logger.js";
import type { WorktreeSnapshot as WorktreeState } from "../../shared/types/workspace-host.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { mergeIntentEqual } from "../../shared/utils/prMergeIntent.js";
import { applyMergeObservation, sameMergeEpisode } from "./prMergeObservation.js";
import { createHardenedGit } from "../utils/hardenedGit.js";
import { getForgeBridge } from "../workspace-host/forgeBridge.js";
import { BatchLoader } from "../workspace-host/batchLoader.js";
import {
  PullRequestCiTracker,
  applyHeadMove,
  clearLocalHeadMove,
  isGraceOpen,
  isKnownHeadDuringLocalMove,
  upstreamNamesPRHead,
} from "./PullRequestCiTracker.js";
import type { InternalLinkedPR } from "./pullRequestEntry.js";
import type {
  RepoRef,
  PR as ForgePR,
  PRSnapshot,
  RateLimitInfo,
  CIStatus,
  NormalizedPRState,
} from "../../shared/types/forge.js";

// Focus-aware polling cadence: faster when any Daintree window is focused so
// users see PR transitions promptly, slower when fully blurred to conserve the
// GitHub API quota during background sessions.
const FOCUSED_POLL_INTERVAL_MS = 30 * 1000;
const BLURRED_POLL_INTERVAL_MS = 2 * 60 * 1000;
// Minimum gap between automatic checkForPRs() invocations (focus catch-up,
// debounced branch-change recheck, post-restart startup check, poll backoff).
// Matches SWR's 5s `focusThrottleInterval` convention so rapid alt-tabbing —
// and a fleet-wide host-restart burst — don't hammer the GitHub API. Manual
// refresh() bypasses this by resetting `lastCheckAt` first.
const FOCUS_CATCHUP_THROTTLE_MS = 5 * 1000;

// Randomised delay before the first checkForPRs() after start(). The
// workspace-host's own restart is jittered, but the singleton's resolved-PR
// state wipes on restart, so without this every candidate worktree refetches
// at once — and across many windows whose hosts crashed together, that's a
// synchronised GitHub API burst right when GitHub itself may still be flaky.
// A short uniform spread (not the error-indexed `computeBackoff`) decorrelates
// the fleet. `resume()` (focus-restore) passes 0 to skip the jitter.
const STARTUP_JITTER_MIN_MS = 500;
const STARTUP_JITTER_MAX_MS = 2_500;

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// AWS full-jitter backoff: sleep = random_between(floor, min(cap, base * 2^attempt))
// See https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 5 * 60_000;
const BACKOFF_FLOOR_MS = 1_000;

function computeBackoff(consecutiveErrors: number): number {
  const attempt = Math.max(0, consecutiveErrors - 1);
  const cap = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return BACKOFF_FLOOR_MS + Math.random() * (cap - BACKOFF_FLOOR_MS);
}

const MAX_CONSECUTIVE_ERRORS = 3;
const UPDATE_DEBOUNCE_MS = 100;

// Slow-cadence revalidation for resolved PRs to detect state changes (merged/closed)
const RESOLVED_REVALIDATION_INTERVAL_MS = 90 * 1000; // 90 seconds

// Adaptive boost: when any resolved PR has CI in-flight (pending), drop
// the revalidation cadence so users see green/red transitions promptly. 30s is
// the floor. Each CI status query costs ~2 GraphQL points (commits(last:1) +
// nested contexts(first:100) = 101 nodes; 101/100 rounds to 2), and with the
// accompanying getPR call (~1 point), revalidating each resolved PR costs ~3
// points total. At 30s the full 5000/hr primary limit can support ~14 PRs; the
// decay bands reduce that burn rate proportionally. The ceiling caps boosted
// polling at 15 min after the last observed pending result, preventing a hung
// CI from indefinitely burning quota; subsequent pending observations slide the
// window forward.
const RESOLVED_REVALIDATION_BOOST_INTERVAL_MS = 30 * 1000; // 30 seconds
const RESOLVED_REVALIDATION_BOOST_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// Decay thresholds: when CI status hasn't changed for this many consecutive
// polls on the most-stagnant PR, the revalidation interval steps up.
const STAGNANT_POLL_DECAY_AT_10 = 10;
const STAGNANT_POLL_DECAY_AT_20 = 20;
const RESOLVED_REVALIDATION_DECAY_INTERVAL_MS = 60 * 1000;
const RESOLVED_REVALIDATION_MAX_DECAY_INTERVAL_MS = 120 * 1000;

// A push seen locally re-runs revalidation this soon rather than on the next
// tick. Long enough for the forge to have moved the PR's head (its probe then
// reports the change, which also retires the provider's cached verdict for the
// old head), short enough to ask while GitHub is registering the new checks.
const LOCAL_HEAD_MOVE_REVALIDATION_DELAY_MS = 3 * 1000;

// Rate-limit block constants extracted from the GitHub-specific service so the
// polling loops consult the active provider's rate-limit state through
// ForgeProviderImpl.getRateLimit() rather than the gitHubRateLimitService singleton.
const RATE_LIMIT_CLOCK_SKEW_MS = 7_000; // buffer applied to server resetAt for clock skew
const RATE_LIMIT_SECONDARY_FALLBACK_MS = 60_000; // pause when throttled without a retry-after

interface WorktreeContext {
  issueNumber?: number;
  /** Set when an issues provider claimed `issueNumber` from the branch name (#13744). */
  issueClaim?: { issueProviderId: string; issueKey: string };
  branchName?: string;
  // Last observation of the branch's upstream tracking ref, for spotting a push.
  upstreamRef?: string;
  upstreamHeadSha?: string;
}

export interface PRDetectionResult {
  worktreeId: string;
  prNumber: number;
  prUrl: string;
  prState: NormalizedPRState;
}

function isCandidateBranch(branchName: string | undefined): boolean {
  if (!branchName) return false;
  const normalized = branchName.trim();
  if (!normalized) return false;

  const lower = normalized.toLowerCase();
  if (lower === "head") return false;
  if (lower === "main" || lower === "master") return false;
  return true;
}

class PullRequestService {
  private pollTimer: NodeJS.Timeout | null = null;
  private revalidationTimer: NodeJS.Timeout | null = null;
  private revalidationsRunning = 0;
  private earlyRevalidationAt: number | undefined;
  private pollIntervalMs: number = FOCUSED_POLL_INTERVAL_MS;
  private cwd: string = "";
  private isPolling: boolean = false;
  private consecutiveErrors: number = 0;
  private nextRetryAt: number = 0;
  private detectionStateTripped: boolean = false;
  private boostExpiresAt: number | null = null;
  private refreshInFlight: Promise<void> | null = null;
  // Bumped when something a refresh depends on changes underneath it (forge
  // settings, a service reset). An in-flight pass stamped with an older epoch
  // resolved against the previous configuration, so a caller arriving after the
  // change must not be handed its result.
  private refreshEpoch = 0;
  private refreshInFlightEpoch = -1;
  private lastCheckAt: number = Number.NEGATIVE_INFINITY;
  private startupDelayTimer: NodeJS.Timeout | null = null;
  private startupDelayResolve: (() => void) | null = null;

  get isEnabled(): boolean {
    return this.nextRetryAt === 0 || Date.now() >= this.nextRetryAt;
  }

  private candidates = new Map<string, WorktreeContext>();
  private resolvedWorktrees = new Set<string>();
  // Tracks worktrees with a confirmed successful issue-title fetch. Decoupled
  // from `resolvedWorktrees` so a worktree whose PR resolved but whose issue
  // title still failed (or was never fetched) remains eligible for retry on
  // the next polling cycle (#8851).
  private issueTitleFetchedWorktrees = new Set<string>();
  private detectedPRs = new Map<string, InternalLinkedPR>();
  // Worktrees whose authoritative "no PR" has already been announced, keyed to
  // the branch + provider it was decided for. A branch without a PR is never
  // resolved, so every poll re-asks and would otherwise re-emit the same clear.
  private announcedNoPR = new Map<string, string>();
  private updateDebounceTimer: NodeJS.Timeout | null = null;
  private unsubscribers: (() => void)[] = [];

  // Forge provider resolution (resolved once on init, invalidated on refresh).
  // The impl itself lives in main (registered by `PluginService` on plugin
  // activate); the workspace-host only holds the resolved identity here and
  // dispatches calls through the `ForgeBridge` IPC client.
  private projectId: string | null = null;
  private providerNamespacedId: string | null = null;
  private repoRef: RepoRef | null = null;
  // Outcome of the last `resolveProvider()` round-trip. `"no-match"` is a
  // definitive answer (plugin scan complete, no provider matches the remote):
  // polling pauses and re-resolution is skipped until `invalidateProvider()`
  // clears it back to null — without this, a GitLab/Bitbucket project would
  // spin on the 5s cold-start cap forever (#9997). `"not-ready"` and null
  // keep the cold-start retry cap. Re-armed by forge settings changes, remote
  // changes, and `forge:provider-registry-updated` pushes from main.
  private providerResolutionStatus: "resolved" | "no-match" | "not-ready" | null = null;
  // Bumped by every invalidation, so a resolution in flight across one cannot
  // write its now-stale answer back over it — the cached answer is reused
  // until invalidated (#12519), so nothing else would correct it.
  private providerGeneration = 0;
  // The last resolution read the remote URL through a failed git call, so its
  // answer (usually "no-match" for a missing URL) is a guess. `start()` and
  // `refresh()` re-derive it; the debounced poll path still honours it, or a
  // repo whose git keeps failing would spin on it (#9997).
  private providerResolutionDegraded = false;
  // Forge provider routing settings, pushed in from the main process. The
  // workspace-host can't read `projectStore` or `electron-store` directly —
  // those modules pull `BrowserWindow`/`app` into the bundle and crash the
  // UtilityProcess (#8316). Main process plumbs these through
  // `load-project` / `update-forge-settings` so the resolver stays a pure
  // function here.
  private forgeProviderOverride: string | null = null;
  private globalDefaultProviderId: string | null = null;
  // Selected git remote name (`forgeRemote`, #8456). When set, the provider is
  // resolved against this remote's URL instead of `origin`.
  private forgeRemote: string | null = null;
  // Host-side request coalescers, scoped to the resolved provider. Created in
  // `resolveProvider()`, disposed in `invalidateProvider()` — a fresh instance
  // per provider so a swap can never bind the old provider's in-flight results
  // (the dispose rejects them). They replace the hand-rolled per-branch
  // in-flight dedup map and collapse same-tick fan-out (branch → PR, PR-number
  // → PR, PR-number → CI status) into one batch call when the provider
  // implements the matching `batchLookups` capability.
  private prByBranchLoader: BatchLoader<string, ForgePR | null> | null = null;
  private prByNumberLoader: BatchLoader<number, ForgePR | null> | null = null;
  private ciStatusLoader: BatchLoader<number, CIStatus | null> | null = null;

  private readonly ciTracker = new PullRequestCiTracker({
    detectedPRs: this.detectedPRs,
    candidates: this.candidates,
    getRepo: () => this.repoRef,
    getLoader: () => this.ciStatusLoader,
    publish: (payload) => events.emit("sys:pr:detected", payload),
    refreshBoost: () => {
      const wasArmed = this.boostExpiresAt !== null;
      this.updateBoostFromDetectedPRs();
      return !wasArmed && this.boostExpiresAt !== null;
    },
    scheduleRevalidation: () => this.scheduleRevalidation(),
  });

  private get ciEnrichmentEnabled(): boolean {
    return this.ciTracker.ciEnrichmentEnabled;
  }

  constructor() {
    this.unsubscribers.push(events.on("sys:worktree:update", this.handleWorktreeUpdate.bind(this)));
    this.unsubscribers.push(events.on("sys:worktree:remove", this.handleWorktreeRemove.bind(this)));
    this.unsubscribers.push(
      events.on("sys:forge:remote-changed", this.handleForgeRemoteChanged.bind(this))
    );
  }

  /**
   * The repo's remotes changed (#11155) — `WorkspaceService` emits this only
   * after a `.git/config` write actually altered the remote table. A cached
   * "no-match" may now resolve, so drop the resolution and re-check. This is
   * the ONLY worktree-adjacent signal allowed to release the no-match pause:
   * `handleWorktreeUpdate` must stay inert on it, or #9997's 5s-forever spin
   * on remote-less repos returns.
   */
  private handleForgeRemoteChanged(): void {
    this.notifyForgeProviderRegistryUpdated();
  }

  private handleWorktreeUpdate(state: WorktreeState): void {
    const currentContext = this.candidates.get(state.worktreeId);
    const newIssueNumber = state.issueNumber;
    const newBranchName = state.branch;

    const branchChanged = currentContext?.branchName !== newBranchName;
    const newIssueClaim =
      state.issueProviderId && state.issueKey
        ? { issueProviderId: state.issueProviderId, issueKey: state.issueKey }
        : undefined;
    const claimChanged =
      currentContext?.issueClaim?.issueProviderId !== newIssueClaim?.issueProviderId ||
      currentContext?.issueClaim?.issueKey !== newIssueClaim?.issueKey;
    const issueChanged = currentContext?.issueNumber !== newIssueNumber || claimChanged;
    // A title fetched for the old owner's issue says nothing about the new one.
    if (currentContext && claimChanged) this.issueTitleFetchedWorktrees.delete(state.worktreeId);

    const shouldTrack = !state.isMainWorktree && isCandidateBranch(newBranchName);

    // Build the next context first
    const nextContext: WorktreeContext = {
      branchName: newBranchName,
      issueNumber: newIssueNumber,
      ...(newIssueClaim ? { issueClaim: newIssueClaim } : {}),
      upstreamRef: state.upstreamRef,
      upstreamHeadSha: state.upstreamHeadSha,
    };

    const wasCandidate = Boolean(currentContext);

    // Update candidates BEFORE emitting any events to prevent synchronous event loops.
    // The sys:pr:cleared event triggers emitUpdate which emits sys:worktree:update,
    // causing handleWorktreeUpdate to be called again synchronously. If we don't
    // update candidates first, we'll detect the same branch change repeatedly.
    if (shouldTrack) {
      this.candidates.set(state.worktreeId, nextContext);
    } else if (currentContext) {
      this.candidates.delete(state.worktreeId);
    }
    if (branchChanged || !shouldTrack) {
      this.announcedNoPR.delete(state.worktreeId);
    }

    // Drop PR state whenever we de-track a previously-tracked worktree, not
    // just on a branch change. Otherwise a worktree that flips to
    // isMainWorktree without a branch swap (e.g., user designates it the
    // root) leaves a stale detectedPRs entry behind — and any pending
    // ciStatus on that entry would keep the adaptive boost armed for up to
    // 15 minutes against a worktree we no longer poll.
    const shouldClearPRState = currentContext && (branchChanged || !shouldTrack);

    if (shouldClearPRState) {
      if (branchChanged) {
        logDebug("Worktree branch changed - clearing PR state", {
          worktreeId: state.worktreeId,
          oldIssue: currentContext.issueNumber,
          newIssue: newIssueNumber,
          oldBranch: currentContext.branchName,
          newBranch: newBranchName,
        });
      }

      // Read providerId BEFORE deleting so the clear event carries the
      // correct provider reference. Compare with handleWorktreeRemove below.
      const clearedProviderId = this.detectedPRs.get(state.worktreeId)?.providerId;
      this.resolvedWorktrees.delete(state.worktreeId);
      this.issueTitleFetchedWorktrees.delete(state.worktreeId);
      this.detectedPRs.delete(state.worktreeId);

      // Tag the clear with the OLD branch and provider so the renderer drops it
      // if the worktree's branch has since moved on again — the clear is only valid
      // for the branch identity at the time it was decided.
      events.emit("sys:pr:cleared", {
        worktreeId: state.worktreeId,
        branchName: currentContext.branchName,
        providerId: clearedProviderId,
        timestamp: Date.now(),
      });
    }

    if (!shouldTrack) {
      return;
    }

    // Deliberately no recheck: an upstream move only ever speaks for a PR this
    // worktree already resolved, and must not release the no-match pause.
    if (currentContext && !branchChanged) {
      this.handleUpstreamMove(state.worktreeId, currentContext, nextContext);
    }

    const shouldRecheck =
      this.isPolling &&
      (branchChanged ||
        !wasCandidate ||
        (issueChanged && !this.resolvedWorktrees.has(state.worktreeId)));

    if (shouldRecheck) {
      this.scheduleDebounceCheck();
    }
  }

  /**
   * A push completes by moving the remote-tracking ref, so the upstream ref
   * moving off the PR's head is a quota-free sighting that the PR's head moved
   * (#13400) — the same retraction the probe would make, ahead of it. Seen for
   * a push from anywhere in Daintree or a terminal, and for one made elsewhere
   * once a fetch brings it in.
   *
   * Only the PR's own head may move it: a ref under refs/remotes (never a
   * local upstream, which a commit moves) naming the PR's head branch, that was
   * on the commit we know as the PR's head. Anything unknown is just recorded —
   * hiding a real failure over a ref that wasn't the PR's head is the worse
   * mistake, and the probe still catches what this misses.
   */
  private handleUpstreamMove(
    worktreeId: string,
    previous: WorktreeContext,
    next: WorktreeContext
  ): void {
    const ref = next.upstreamRef;
    const from = previous.upstreamHeadSha;
    const to = next.upstreamHeadSha;
    if (!ref || ref !== previous.upstreamRef || !from || !to || from === to) return;

    const entry = this.detectedPRs.get(worktreeId);
    const repo = this.repoRef;
    if (!entry || !repo || !this.resolvedWorktrees.has(worktreeId)) return;
    if (entry.state !== "open" || !entry.headRef || !upstreamNamesPRHead(ref, entry.headRef)) {
      return;
    }
    if ((entry.localHeadSha ?? entry.headSha ?? entry._ciStatus?.headSha) !== from) return;

    logDebug("Upstream ref moved off the PR head - treating as a push", {
      worktreeId,
      prNumber: entry.number,
    });
    this.ciTracker.applyLocalHeadMove(entry, from, to, repo);
    this.updateBoostFromDetectedPRs();
    this.scheduleRevalidation(LOCAL_HEAD_MOVE_REVALIDATION_DELAY_MS);
  }

  private handleWorktreeRemove({ worktreeId }: { worktreeId: string }): void {
    this.announcedNoPR.delete(worktreeId);
    if (this.candidates.has(worktreeId) || this.detectedPRs.has(worktreeId)) {
      const branchName = this.candidates.get(worktreeId)?.branchName;
      const clearedProviderId = this.detectedPRs.get(worktreeId)?.providerId;
      this.candidates.delete(worktreeId);
      this.resolvedWorktrees.delete(worktreeId);
      this.issueTitleFetchedWorktrees.delete(worktreeId);
      this.detectedPRs.delete(worktreeId);

      events.emit("sys:pr:cleared", {
        worktreeId,
        branchName,
        providerId: clearedProviderId,
        timestamp: Date.now(),
      });

      logDebug("Worktree removed - cleared PR state", { worktreeId });
    }
  }

  private scheduleDebounceCheck(delayMs: number = UPDATE_DEBOUNCE_MS): void {
    if (this.updateDebounceTimer) {
      clearTimeout(this.updateDebounceTimer);
    }

    this.updateDebounceTimer = setTimeout(() => {
      this.updateDebounceTimer = null;

      if (!this.hasUnresolvedCandidates() || !this.isEnabled) {
        return;
      }

      // Startup jitter still pending: skip entirely. handleWorktreeUpdate
      // already updated the candidate map synchronously, so the upcoming
      // jittered initial check (runInitialCheck → checkForPRs) will pick
      // this candidate up. Running here would bypass the jitter and recreate
      // the synchronised post-restart burst (#8072).
      if (this.startupDelayTimer !== null) {
        return;
      }

      // A branch-change recheck inside the 5s floor is deferred until the
      // floor clears rather than dropped to the next poll tick — keeps
      // branch switches responsive (≤5s) without bursting the API.
      const waitMs = this.msUntilCheckAllowed();
      if (waitMs > 0) {
        this.scheduleDebounceCheck(waitMs);
        return;
      }

      logDebug("Running debounced PR check", { candidateCount: this.candidates.size });
      void this.checkForPRs().catch((err) =>
        logWarn("Debounced PR check failed", {
          error: formatErrorMessage(err, "Debounced PR check failed"),
        })
      );

      if (!this.pollTimer) {
        this.scheduleNextPoll();
      }
    }, delayMs);
  }

  /**
   * Milliseconds until an automatic checkForPRs() is allowed again under the
   * 5s floor. 0 means a check may proceed now. `lastCheckAt` is only advanced
   * when a real GitHub batch is attempted, so throttled/skipped calls never
   * push this window forward (avoids a no-progress reschedule loop).
   */
  private msUntilCheckAllowed(): number {
    return Math.max(0, FOCUS_CATCHUP_THROTTLE_MS - (Date.now() - this.lastCheckAt));
  }

  public initialize(cwd: string, projectId: string): void {
    this.cwd = cwd;
    // Immutable id threaded from main via load-project. The host has no DB
    // access, so hashing `cwd` here (the old behaviour) would mint a stale id
    // for any relocated project and detach every id-keyed lookup (#11282).
    this.projectId = projectId;
    logInfo("PullRequestService initialized", { cwd, projectId: this.projectId });
  }

  public setForgeSettings(args: {
    forgeProviderOverride: string | null;
    forgeDefaultProviderId: string | null;
    forgeRemote?: string | null;
  }): void {
    this.forgeProviderOverride = args.forgeProviderOverride;
    this.globalDefaultProviderId = args.forgeDefaultProviderId;
    this.forgeRemote = args.forgeRemote ?? null;
    // Supersede any in-flight refresh: it resolved the provider these settings
    // just replaced, so the caller that follows this change needs its own pass.
    this.refreshEpoch += 1;
    this.invalidateProvider();
  }

  private async resolveProvider(): Promise<void> {
    if (!this.projectId) return;
    const generation = this.providerGeneration;
    let remoteReadFailed = false;
    try {
      const git = await createHardenedGit(this.cwd);
      // simple-git's typed `getConfig` returns a `ConfigGetResult` envelope at
      // runtime (`{ key, paths, scopes, value, values }`). Earlier code cast it
      // straight to `string | null` on the assumption that daintree's wiring
      // unwrapped to the bare value — that's true under the test mock but not
      // in the real workspace-host UtilityProcess, where this read silently
      // returned null and the provider failed to resolve (#8870). Unwrap
      // explicitly: prefer the envelope's `value`, fall back to a literal
      // string for callers that genuinely return one.
      // A missing key is not a failure — git exits 1 with no stderr, which
      // simple-git reports as a null value — so a rejection is a read that
      // actually failed, and the answer built on it is only a guess.
      const readRemoteUrl = async (remoteName: string): Promise<string | null> => {
        const result = await git.getConfig(`remote.${remoteName}.url`).catch(() => {
          remoteReadFailed = true;
          return null;
        });
        if (result === null || result === undefined) return null;
        const raw =
          typeof result === "string"
            ? result
            : ((result as { value?: string | null }).value ?? null);
        return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
      };
      // Resolve against the user-selected remote (`forgeRemote`, #8456) when
      // set, falling back to `origin` so existing projects keep working.
      const selectedRemote =
        this.forgeRemote && this.forgeRemote.trim().length > 0 ? this.forgeRemote.trim() : null;
      const remoteUrl =
        (selectedRemote ? await readRemoteUrl(selectedRemote) : null) ??
        (await readRemoteUrl("origin"));

      // The bridge does provider resolution and `parseRemote` in one IPC
      // roundtrip: the registry lives in main (where plugins activate), so
      // there's no point trying to consult it locally. A miss is
      // discriminated (#9997): "not-ready" (plugin scan still running —
      // retry on the cold-start cap) vs "no-match" (definitive — pause
      // polling until invalidation).
      const resolved = await getForgeBridge().resolveProvider({
        remoteUrl,
        forgeProviderOverride: this.forgeProviderOverride,
        globalDefaultProviderId: this.globalDefaultProviderId,
        // This service is a project-level singleton initialized with the project
        // root, so `this.cwd` is the main worktree path main stamps onto
        // `RepoRef.projectPath` (#10563).
        projectPath: this.cwd,
      });
      if (generation !== this.providerGeneration) return;
      this.providerResolutionDegraded = remoteReadFailed;
      if (resolved.status !== "resolved") {
        this.providerResolutionStatus = resolved.status;
        this.providerNamespacedId = null;
        this.repoRef = null;
        this.disposeLoaders();
        if (resolved.status === "no-match") {
          logInfo(
            "PullRequestService: no forge provider matches this project — pausing PR polling",
            {
              hasRemoteUrl: remoteUrl !== null,
            }
          );
        }
        return;
      }
      this.providerResolutionStatus = "resolved";
      this.providerNamespacedId = resolved.namespacedId;
      this.repoRef = resolved.repo;
      this.createLoaders(resolved.namespacedId, resolved.repo);
      logInfo("PullRequestService resolved forge provider", {
        namespacedId: resolved.namespacedId,
        owner: resolved.repo.owner,
        repo: resolved.repo.repo,
      });
    } catch (error) {
      logWarn("PullRequestService provider resolution failed", {
        error: formatErrorMessage(error, "Provider resolution failed"),
      });
      if (generation !== this.providerGeneration) return;
      // A thrown resolution (git read or IPC failure) is transient — leave
      // the status null so the cold-start retry cap stays in effect.
      this.providerResolutionDegraded = false;
      this.providerResolutionStatus = null;
      this.providerNamespacedId = null;
      this.repoRef = null;
      this.disposeLoaders();
    }
  }

  private invalidateProvider(): void {
    this.providerGeneration++;
    this.providerResolutionDegraded = false;
    this.providerResolutionStatus = null;
    this.providerNamespacedId = null;
    this.repoRef = null;
    this.disposeLoaders();
  }

  /**
   * Main pushed `forge:provider-registry-updated` — a forge provider
   * descriptor was registered OR removed (startup scan, runtime plugin
   * install/enable, or live disable). A cached "no-match"/"not-ready" miss
   * may now resolve, and a resolved provider may no longer exist (the
   * registry-updated signal covers removals since live built-in disable,
   * #9304 follow-up), so always drop the cached resolution and re-check —
   * re-resolving to the same provider is cheap, but keeping a resolution for
   * an unregistered provider strands polling on RPC failures.
   */
  public notifyForgeProviderRegistryUpdated(): void {
    this.invalidateProvider();
    if (!this.isPolling || this.startupDelayTimer !== null) return;
    // Re-enter the poll loop: "no-match" pauses without an armed timer, so a
    // debounced check (which respects the 5s floor and re-arms the poll
    // timer when none is pending) is the wake-up.
    this.scheduleDebounceCheck();
  }

  private async clearProviderPullRequestCaches(): Promise<void> {
    const providerId = this.providerNamespacedId;
    if (!providerId) return;
    try {
      await getForgeBridge().clearPullRequestCaches(providerId);
    } catch (error) {
      logDebug("PullRequestService provider cache clear failed", {
        providerId,
        error: formatErrorMessage(error, "Provider cache clear failed"),
      });
    }
  }

  /**
   * Build the provider-scoped coalescers. Each loader's batch function prefers
   * the optional `batchLookups` capability (one round-trip for many keys) and
   * falls back to per-key bridge calls when the provider doesn't implement it,
   * mirroring the truthiness-guarded capability convention. `providerId`/`repo`
   * are captured here so the loader always calls the provider it was minted
   * for; a swap disposes it before a new one is created.
   */
  private createLoaders(providerId: string, repo: RepoRef): void {
    this.disposeLoaders();
    const bridge = getForgeBridge();

    this.prByBranchLoader = new BatchLoader<string, ForgePR | null>(async (branches) => {
      const list = [...branches];
      let batchMap: Map<string, ForgePR | null> | null = null;
      try {
        batchMap = await bridge.findPRsByBranches(providerId, repo, list);
      } catch (error) {
        logWarn("Batched PR-by-branch lookup failed; retrying per-branch", {
          branchCount: list.length,
          error: formatErrorMessage(error, "findPRsByBranches failed"),
        });
      }
      // A present key (even null-valued) is authoritative "found / not found";
      // a branch missing from the batch map falls back to a per-branch call.
      // The fallback preserves the transient-vs-not-found distinction:
      // findPRByBranch resolves null for a confirmed missing PR but throws on
      // transient failure, which we surface as a per-key Error so the loader
      // rejects it and the caller skips (never clears) that branch.
      return Promise.all(
        list.map((branch) => {
          if (batchMap?.has(branch)) return batchMap.get(branch) ?? null;
          return bridge.findPRByBranch(providerId, repo, branch).then(
            (pr) => pr,
            (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
          );
        })
      );
    });

    this.prByNumberLoader = new BatchLoader<number, ForgePR | null>(async (prNumbers) => {
      const list = [...prNumbers];
      let batchMap: Map<number, ForgePR | null> | null = null;
      try {
        // Fresh: this loader only re-reads PRs the REST probe just flagged, and
        // the probe's markers advance on this answer — a cached one would hide
        // the change (an auto-merge armed on github.com, say) until a refresh.
        batchMap = await bridge.findPRsByNumbers(providerId, repo, list, { fresh: true });
      } catch {
        batchMap = null; // fall through to per-number lookups
      }
      if (batchMap) {
        // A present key (even with a null value) is authoritative "found / not
        // found"; an omitted key is a transient miss → surface as a per-key
        // Error so the loader rejects it and the caller skips (never wipes) it.
        return list.map((prNumber) =>
          batchMap.has(prNumber)
            ? (batchMap.get(prNumber) ?? null)
            : new Error(`PR #${prNumber} omitted from findPRsByNumbers batch`)
        );
      }
      // Per-number fallback preserves the transient-vs-not-found distinction:
      // getPR resolves null for a confirmed missing PR but throws on transient
      // failure, which we surface as a per-key Error.
      return Promise.all(
        list.map((prNumber) =>
          bridge.getPR(providerId, repo, prNumber).then(
            (pr) => pr,
            (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
          )
        )
      );
    });

    this.ciStatusLoader = new BatchLoader<number, CIStatus | null>(async (prNumbers) => {
      const list = [...prNumbers];
      let batchMap: Map<number, CIStatus | null> | null = null;
      try {
        batchMap = await bridge.getCIStatuses(providerId, repo, list);
      } catch {
        batchMap = null; // fall through to per-number lookups
      }
      if (batchMap) {
        // A present key (even null-valued) is authoritative; an omitted key is
        // a transient miss per the BatchLookupCapability contract — surface it
        // as a per-key Error so it rejects (enrich drops it) and stays eligible
        // for retry rather than being written as a confirmed "no CI status".
        return list.map((prNumber) =>
          batchMap.has(prNumber)
            ? (batchMap.get(prNumber) ?? null)
            : new Error(`CI status for PR #${prNumber} omitted from getCIStatuses batch`)
        );
      }
      // Same contract on the fallback: a resolved value (null included) is a
      // confirmed answer, a thrown one is a transient miss and rejects. Landing
      // a failure here as `null` would read downstream as "no checks" and clear
      // a status the provider never actually contradicted — and a cleared entry
      // is neither pending nor terminal, so nothing re-polls it afterwards.
      return Promise.all(
        list.map((prNumber) =>
          bridge
            .getCIStatus(providerId, repo, prNumber)
            .catch(
              (cause: unknown) =>
                new Error(`CI status lookup failed for PR #${prNumber}`, { cause })
            )
        )
      );
    });
  }

  private disposeLoaders(): void {
    this.prByBranchLoader?.dispose();
    this.prByNumberLoader?.dispose();
    this.ciStatusLoader?.dispose();
    this.prByBranchLoader = null;
    this.prByNumberLoader = null;
    this.ciStatusLoader = null;
  }

  /**
   * Currently-resolved forge provider context, or null when no provider has
   * resolved yet (e.g. token not connected). Read synchronously so callers can
   * eagerly compose a `linked` projection at worktree-create time without an
   * IPC roundtrip (#8888).
   */
  public getProviderContext(): { providerId: string; owner: string; repo: string } | null {
    if (!this.providerNamespacedId || !this.repoRef) return null;
    return {
      providerId: this.providerNamespacedId,
      owner: this.repoRef.owner,
      repo: this.repoRef.repo,
    };
  }

  /**
   * Start polling. The first check is delayed by a randomised
   * STARTUP_JITTER_MIN..MAX window so a fleet-wide host restart doesn't fire a
   * synchronised PR refetch burst. Pass `startupDelayMs = 0` to check
   * immediately (focus-restore / resume(), which is not a crash-recovery
   * path). The returned promise resolves after the (delayed) first check, or
   * immediately if stop()/reset() cancels the pending delay.
   */
  public start(startupDelayMs?: number): Promise<void> {
    if (this.isPolling) {
      // Benign no-op (resume/focus-restore re-entrancy) — fires repeatedly on
      // the project-switch hot path, where each sync log write adds main-thread
      // I/O. Diagnostic only, so keep it at debug.
      logDebug("PullRequestService already polling");
      return Promise.resolve();
    }

    if (!this.cwd) {
      logWarn("PullRequestService not initialized - call initialize() first");
      return Promise.resolve();
    }

    this.isPolling = true;
    this.nextRetryAt = 0;
    this.consecutiveErrors = 0;

    const delay = startupDelayMs ?? randomBetween(STARTUP_JITTER_MIN_MS, STARTUP_JITTER_MAX_MS);

    // start()/stop() fire on every project switch (each project's PR poller is
    // torn down and re-armed). At INFO each pair is two synchronous log writes
    // on the switch hot path; they're lifecycle diagnostics, not user signals,
    // so keep them at debug.
    logDebug("PullRequestService started", {
      intervalMs: this.pollIntervalMs,
      startupDelayMs: Math.round(delay),
    });

    if (delay <= 0) {
      return this.runInitialCheck();
    }

    return new Promise<void>((resolve) => {
      this.startupDelayResolve = resolve;
      this.startupDelayTimer = setTimeout(() => {
        this.startupDelayTimer = null;
        this.startupDelayResolve = null;
        void this.runInitialCheck().finally(resolve);
      }, delay);
    });
  }

  /**
   * Whether the cached resolution must be (re)derived — the same test
   * `checkForPRs()` applies. Both definitive answers (a provider, or "no-match")
   * stay valid until one of their inputs moves, and each input has its own
   * invalidation: `setForgeSettings()` (override, default, selected remote),
   * `sys:forge:remote-changed` (the remote URL on disk) and
   * `notifyForgeProviderRegistryUpdated()` (registry contents).
   */
  private needsProviderResolution(): boolean {
    return (
      (!this.providerNamespacedId || !this.repoRef) && this.providerResolutionStatus !== "no-match"
    );
  }

  /** `needsProviderResolution()` for the once-per-call paths, which also retry a degraded answer. */
  private needsProviderResolutionOnDemand(): boolean {
    return this.needsProviderResolution() || this.providerResolutionDegraded;
  }

  private runInitialCheck(): Promise<void> {
    // Every project switch-away/back is a stop()/start() pair that invalidates
    // nothing, so re-resolving here unconditionally redid the git-config read
    // and the registry round trip on each return to a warm host (#12519). Still
    // resolved eagerly rather than left to `checkForPRs()`, which returns
    // before resolving when there are no candidates yet — and
    // `getProviderContext()` is read at worktree-create time (#8888).
    const resolution = this.needsProviderResolutionOnDemand()
      ? this.resolveProvider()
      : Promise.resolve();
    return resolution.then(() =>
      this.checkForPRs().finally(() => {
        this.scheduleNextPoll();
        this.scheduleRevalidation();
      })
    );
  }

  private clearStartupDelay(): void {
    if (this.startupDelayTimer) {
      clearTimeout(this.startupDelayTimer);
      this.startupDelayTimer = null;
    }
    // Resolve a still-pending start() promise so callers awaiting it (e.g.
    // PRIntegrationService.initialize) don't hang when stop()/reset() cancels
    // the jitter before the first check runs.
    if (this.startupDelayResolve) {
      const resolve = this.startupDelayResolve;
      this.startupDelayResolve = null;
      resolve();
    }
  }

  public stop(): void {
    this.clearStartupDelay();
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.revalidationTimer) {
      clearTimeout(this.revalidationTimer);
      this.revalidationTimer = null;
    }
    if (this.updateDebounceTimer) {
      clearTimeout(this.updateDebounceTimer);
      this.updateDebounceTimer = null;
    }
    this.boostExpiresAt = null;
    this.clearStagnantPollCounts();
    this.isPolling = false;
    logDebug("PullRequestService stopped");
  }

  /**
   * Manual "give me fresh data now" pass. One sidebar click reaches this same
   * host twice — once via the view's worktree port (WorkspaceService.refresh)
   * and once via the pool-wide `refresh-prs` fan-out — so the two are coalesced
   * onto a single pass. Without that, the second caller's `invalidateProvider()`
   * disposes the first's in-flight coalescers mid-cycle and
   * `resolvePRsForBranches()` absorbs the disposal as `null`, silently skipping
   * those branches on the very click that promised fresh data.
   */
  public refresh(): Promise<void> {
    const existing = this.refreshInFlight;
    // Join only a pass that still reflects the current configuration. Without
    // the epoch check, `updateForgeSettings()`'s follow-up refresh would be
    // handed a pass that resolved the PREVIOUS provider, and the new one would
    // never get a detection cycle.
    if (existing && this.refreshInFlightEpoch === this.refreshEpoch) return existing;
    const epoch = this.refreshEpoch;
    // A superseded pass is chained after, not run alongside: two overlapping
    // passes are exactly the disposal race this single-flight exists to remove.
    const run = (existing ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.performRefresh())
      .finally(() => {
        // Identity-guarded so a settled older pass can't clear a newer one.
        if (this.refreshInFlight === run) this.refreshInFlight = null;
      });
    this.refreshInFlight = run;
    this.refreshInFlightEpoch = epoch;
    return run;
  }

  private async performRefresh(): Promise<void> {
    if (!this.cwd) {
      return;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    // Manual refresh re-evaluates everything from scratch, so cancel any
    // pre-armed revalidation tick and clear the boost window — the post-check
    // reschedule below picks an interval based on the fresh CI status.
    if (this.revalidationTimer) {
      clearTimeout(this.revalidationTimer);
      this.revalidationTimer = null;
    }
    this.boostExpiresAt = null;
    this.clearStagnantPollCounts();
    this.nextRetryAt = 0;
    this.consecutiveErrors = 0;
    this.setDetectionState(false);
    // Force a full re-detect cycle so already-resolved worktrees re-query
    // dynamic PR fields (state, CI status). Without this, checkForPRs() skips
    // resolved worktrees and only the 90s revalidation timer would refresh
    // their CI status — which contradicts the "I want fresh data now"
    // semantics of a manual refresh.
    this.resolvedWorktrees.clear();
    this.issueTitleFetchedWorktrees.clear();
    // Reuse the cached resolution. This pass also runs on every app focus, and
    // re-deriving an answer none of whose inputs moved cost a git-config read
    // and a registry round trip each time (#12519). Each input invalidates on
    // its own — settings, `.git/config` remotes, registry installs and removals
    // — and credentials were never one: they're read in main per call.
    if (this.needsProviderResolutionOnDemand()) {
      await this.resolveProvider();
    }
    await this.clearProviderPullRequestCaches();
    // Manual refresh is an explicit "I want fresh data now" — bypass the 5s
    // floor by clearing the throttle clock before the direct checkForPRs().
    this.lastCheckAt = Number.NEGATIVE_INFINITY;
    // Force CI enrichment for this pass. `ciEnrichmentEnabled` tracks window
    // focus (and is clamped off for worker instances), so an unforced refresh
    // dispatched while blurred completes with no CI fetched at all and the
    // badges never move. The force rides the call rather than the shared flag:
    // flipping the flag would run the disable sweep on restore and discard the
    // very result this pass fetched.
    await this.checkForPRs({ forceCiEnrichment: true });

    if (this.isPolling) {
      if (this.hasUnresolvedCandidates()) {
        this.scheduleNextPoll();
      }
      this.scheduleRevalidation();
    }
  }

  public reset(): void {
    this.stop();
    this.candidates.clear();
    this.resolvedWorktrees.clear();
    this.issueTitleFetchedWorktrees.clear();
    this.detectedPRs.clear();
    this.announcedNoPR.clear();
    this.consecutiveErrors = 0;
    this.nextRetryAt = 0;
    // A pass from the previous project/token must not satisfy a refresh
    // requested after the reset.
    this.refreshEpoch += 1;
    // reset() runs on project switch, service teardown, and token removal
    // (updateToken(null) → reset()). Token removal does NOT re-attach the
    // worktree port, so a silent clear would strand a tripped glyph in the
    // renderer until the next wake. setDetectionState only emits on a genuine
    // true→false transition, so this is a no-op when not tripped and cannot
    // suppress a later genuine trip (the flag is false afterward).
    this.setDetectionState(false);
    this.boostExpiresAt = null;
    this.earlyRevalidationAt = undefined;
    this.clearStagnantPollCounts();
    this.lastCheckAt = Number.NEGATIVE_INFINITY;
    this.ciTracker.reset();
    this.invalidateProvider();
  }

  /**
   * Switch poll cadence based on global window-focus state. Focused = ~30s
   * (snappy enough that PR transitions surface promptly), blurred = ~120s
   * (conserves GitHub API quota during long background sessions). Called
   * from main via the workspace-host IPC pipe; powerMonitor.ts is the focus
   * aggregator and idempotency guard, so this method is only invoked on a
   * real focus-state transition.
   *
   * On focus regain, also fires an immediate catch-up poll throttled to
   * FOCUS_CATCHUP_THROTTLE_MS (5s) — protects against rapid alt-tabbing
   * causing API bursts. The throttle is co-located with the rate-limited
   * resource (this service) rather than the IPC layer to avoid a second
   * round-trip just to decide whether to skip.
   */
  public setFocusCadence(focused: boolean): void {
    const targetInterval = focused ? FOCUSED_POLL_INTERVAL_MS : BLURRED_POLL_INTERVAL_MS;
    this.updatePollInterval(targetInterval);

    if (!focused || !this.isPolling) {
      return;
    }

    // CI freshness is independent of PR-detection resolution, so this runs
    // before the unresolved-candidate gate below — that gate is false in the
    // common steady state (every worktree already has its PR), which is exactly
    // when the CI catch-up matters most (#11513).
    if (this.isEnabled && this.repoRef) {
      this.ciTracker.recheckResolvedCIOnFocus(this.resolvedWorktrees, this.repoRef);
    }

    if (!this.hasUnresolvedCandidates() || !this.isEnabled) {
      return;
    }

    // Cheap pre-filter against the shared 5s floor. checkForPRs() is the
    // authoritative throttle gate (lesson #3333 — one guard at the choke
    // point), but skipping the pollTimer clear/reschedule here avoids
    // starving the poll loop when a user alt-tabs rapidly.
    if (this.msUntilCheckAllowed() > 0) {
      logDebug("Skipping PR focus catch-up — within throttle window", {
        waitMs: this.msUntilCheckAllowed(),
      });
      return;
    }

    // Cancel the scheduled poll and run an immediate check; the .finally
    // re-arms the timer at the new (focused) cadence. Avoids waiting up to
    // 30s after focus regain for the next normal tick.
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    void this.checkForPRs()
      .catch((err) => this.handleError(formatErrorMessage(err, "PR focus catch-up failed")))
      .finally(() => this.scheduleNextPoll());
  }

  /** Toggle the GraphQL CI-status enrichment; see PullRequestCiTracker. */
  public setCIEnrichmentEnabled(enabled: boolean): void {
    this.ciTracker.setCIEnrichmentEnabled(enabled);
  }

  private updatePollInterval(ms: number): void {
    if (this.pollIntervalMs === ms) {
      return;
    }
    this.pollIntervalMs = ms;
    logDebug("PR poll cadence updated", { intervalMs: ms });

    if (!this.isPolling) {
      return;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.scheduleNextPoll();
  }

  public destroy(): void {
    this.reset();
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }

  private scheduleNextPoll(): void {
    if (!this.isPolling) {
      return;
    }

    // Defensive clear: setFocusCadence and updatePollInterval can interleave
    // such that a `pollTimer` is already armed when the catch-up's `.finally`
    // re-enters this method. Without this clear we'd orphan the prior timer
    // and double the polling rate until `stop()`.
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    if (!this.isEnabled) {
      const delay = this.nextRetryAt - Date.now();
      if (delay > 0) {
        logDebug("Circuit breaker tripped - scheduling retry", { delayMs: delay });
        this.pollTimer = setTimeout(() => {
          this.pollTimer = null;
          if (!this.isPolling) return;
          logDebug("Circuit breaker recovery - running immediate check");
          this.consecutiveErrors = 0;
          this.nextRetryAt = 0;
          this.setDetectionState(false);
          void this.checkForPRs()
            .catch((err) => this.handleError(formatErrorMessage(err, "PR check failed")))
            .finally(() => this.scheduleNextPoll());
        }, delay);
      }
      return;
    }

    if (!this.hasUnresolvedCandidates()) {
      logDebug("All candidates resolved - pausing polling");
      return;
    }

    // Definitive "no provider matches this remote" (#9997): pause without a
    // timer, exactly like the all-resolved case above. Re-armed by
    // `invalidateProvider()` (forge settings change, manual refresh, or a
    // `forge:provider-registry-updated` push when a plugin registers a new
    // provider). Without this, the cold-start cap below would re-poll a
    // GitLab/Bitbucket project every 5s forever.
    if (this.providerResolutionStatus === "no-match") {
      logDebug("No matching forge provider - pausing polling until invalidation");
      return;
    }

    let interval = this.pollIntervalMs;
    if (this.consecutiveErrors > 0) {
      interval = computeBackoff(this.consecutiveErrors);
      logDebug("Using backoff interval", { errors: this.consecutiveErrors, intervalMs: interval });
    }

    // computeBackoff can return sub-5s intervals; raise the next tick to the
    // throttle boundary so the timer fires exactly when checkForPRs() would
    // be admitted again, instead of churning through throttled no-op wakeups.
    interval = Math.max(interval, this.msUntilCheckAllowed());

    // Cap the interval when the forge provider hasn't resolved yet. The forge
    // registry lives in main and is populated asynchronously by
    // `PluginService.initialize()` — the workspace-host's first poll often
    // fires before that completes, leaving `providerNamespacedId` null. At the
    // blurred cadence (120s) the user would otherwise stare at empty PR
    // sub-rows for two minutes after every cold start. Once the bridge returns
    // a real provider the next poll uses the normal cadence again. This cap
    // only ever applies to a transient miss ("not-ready"/null) — a definitive
    // "no-match" already paused above (#9997).
    //
    // Skip this when `consecutiveErrors > 0`: the circuit-breaker backoff is
    // deliberate (the last call failed against the API), and punching through
    // it with a 5s retry would burst error-prone calls right when we want to
    // back off. Resolution will get its chance once the backoff window closes.
    if (!this.providerNamespacedId && this.consecutiveErrors === 0) {
      interval = Math.min(interval, FOCUS_CATCHUP_THROTTLE_MS);
    }

    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.checkForPRs()
        .catch((err) => this.handleError(formatErrorMessage(err, "PR check failed")))
        .finally(() => this.scheduleNextPoll());
    }, interval);
  }

  // Sliding boost window: if any resolved PR has CI in flight, extend
  // boostExpiresAt so the next scheduleRevalidation picks the 30s cadence.
  // A clean sweep clears it so the cadence decays back to the 90s baseline.
  // Called from the happy paths of checkForPRs and revalidateResolvedPRs —
  // a failed batch leaves the prior state alone so a transient error doesn't
  // accidentally cancel a live boost.
  private updateBoostFromDetectedPRs(): void {
    // Gated on ambient enrichment: a forced (manual-refresh) `pending` result
    // can land while the flag is off, and arming the 30s boost then would keep
    // re-arming a revalidation cadence with no ambient CI fetch behind it
    // (#6149) — exactly what the disable sweep exists to collapse.
    const hasPendingCi =
      this.ciEnrichmentEnabled &&
      Array.from(this.detectedPRs.values()).some(
        (pr) => pr.ciStatus === "pending" || pr.ciGraceUntil !== undefined
      );
    this.boostExpiresAt = hasPendingCi
      ? Date.now() + RESOLVED_REVALIDATION_BOOST_DURATION_MS
      : null;
  }

  private getBoostRevalidationIntervalMs(): number {
    // A post-push wait is short and bounded, so it always gets the floor; a
    // long-stagnant pending PR elsewhere must not stretch it to 2-minute ticks.
    const now = Date.now();
    if (Array.from(this.detectedPRs.values()).some((pr) => isGraceOpen(pr, now))) {
      return RESOLVED_REVALIDATION_BOOST_INTERVAL_MS;
    }
    const maxStagnant = Math.max(
      0,
      ...Array.from(this.detectedPRs.values(), (pr) =>
        pr.ciStatus === "pending" ? pr.stagnantPollCount : 0
      )
    );
    if (maxStagnant >= STAGNANT_POLL_DECAY_AT_20) {
      return RESOLVED_REVALIDATION_MAX_DECAY_INTERVAL_MS;
    }
    if (maxStagnant >= STAGNANT_POLL_DECAY_AT_10) {
      return RESOLVED_REVALIDATION_DECAY_INTERVAL_MS;
    }
    return RESOLVED_REVALIDATION_BOOST_INTERVAL_MS;
  }

  private clearStagnantPollCounts(): void {
    for (const pr of this.detectedPRs.values()) {
      pr.stagnantPollCount = 0;
    }
  }

  private hasUnresolvedCandidates(): boolean {
    for (const worktreeId of this.candidates.keys()) {
      if (!this.resolvedWorktrees.has(worktreeId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * `delayMs` asks for the next tick sooner than the cadence would. The
   * request is a deadline every later reschedule honours until a tick runs, so
   * a cadence change in between can't push it back out. A pass already under
   * way reschedules when it settles, so it isn't raced by a second one.
   */
  private scheduleRevalidation(delayMs?: number): void {
    if (!this.isPolling) {
      return;
    }

    if (delayMs !== undefined) {
      const at = Date.now() + delayMs;
      this.earlyRevalidationAt = Math.min(this.earlyRevalidationAt ?? at, at);
      if (this.revalidationsRunning > 0) return;
    }

    if (this.revalidationTimer) {
      clearTimeout(this.revalidationTimer);
    }

    if (!this.isEnabled) {
      const delay = this.nextRetryAt - Date.now();
      if (delay > 0) {
        this.revalidationTimer = setTimeout(() => {
          this.revalidationTimer = null;
          this.scheduleRevalidation();
        }, delay);
      }
      return;
    }

    // Clear an expired boost timestamp before selecting the interval so a stale
    // value doesn't force one extra boosted tick after the ceiling has passed.
    if (this.boostExpiresAt !== null && this.boostExpiresAt <= Date.now()) {
      this.boostExpiresAt = null;
    }
    const cadenceMs =
      this.boostExpiresAt !== null
        ? this.getBoostRevalidationIntervalMs()
        : RESOLVED_REVALIDATION_INTERVAL_MS;
    const intervalMs =
      this.earlyRevalidationAt !== undefined && this.revalidationsRunning === 0
        ? Math.min(Math.max(0, this.earlyRevalidationAt - Date.now()), cadenceMs)
        : cadenceMs;

    this.revalidationTimer = setTimeout(() => {
      this.revalidationTimer = null;
      this.earlyRevalidationAt = undefined;
      this.revalidationsRunning += 1;
      void this.revalidateResolvedPRs()
        .catch((err) =>
          logWarn("Revalidation unexpected error", {
            error: formatErrorMessage(err, "PR revalidation failed"),
          })
        )
        .finally(() => {
          this.revalidationsRunning -= 1;
          this.scheduleRevalidation();
        });
    }, intervalMs);
  }

  /**
   * Consult the active forge provider's rate-limit state and return the active
   * block (`kind` matches `handleError`'s rate-limit marker) or null when
   * unblocked. Fails open (null) when the provider is absent, lacks
   * `getRateLimit`, or the call throws — a provider bug must not stall polling.
   */
  private async checkRateLimitGate(): Promise<{
    kind: "primary" | "secondary";
    resumeAt: number;
  } | null> {
    if (!this.providerNamespacedId) {
      return null;
    }
    try {
      const info: RateLimitInfo | null = await getForgeBridge().getRateLimit(
        this.providerNamespacedId
      );
      // `null` here means the provider does not implement `getRateLimit` —
      // fail open, polling proceeds without a rate-limit gate.
      if (!info) return null;
      const now = Date.now();
      if (info.secondaryThrottled) {
        const resumeAt = info.resetAt ?? now + RATE_LIMIT_SECONDARY_FALLBACK_MS;
        if (resumeAt <= now) return null;
        return { kind: "secondary", resumeAt };
      }
      if (info.remaining === 0) {
        const resumeAt = info.resetAt
          ? info.resetAt + RATE_LIMIT_CLOCK_SKEW_MS
          : now + RATE_LIMIT_SECONDARY_FALLBACK_MS;
        if (resumeAt <= now) return null;
        return { kind: "primary", resumeAt };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async revalidateResolvedPRs(): Promise<void> {
    if (!this.isEnabled || this.resolvedWorktrees.size === 0) {
      return;
    }

    const repo = this.repoRef;
    const providerId = this.providerNamespacedId;
    if (!repo || !providerId) return;
    const bridge = getForgeBridge();

    const rateLimitBlock = await this.checkRateLimitGate();
    if (rateLimitBlock) {
      this.nextRetryAt = rateLimitBlock.resumeAt;
      logDebug("Skipping PR revalidation — rate limit active", {
        providerId,
        resumeAt: rateLimitBlock.resumeAt,
      });
      return;
    }

    // Collect resolved worktrees that need revalidation, plus a per-PR snapshot
    // (state + REST change markers) for the cheap open-PR-list probe below.
    const lookupBranchByWorktreeId = new Map<string, string | undefined>();
    const uniquePRNumbers = new Set<number>();
    const trackedByNumber = new Map<number, PRSnapshot>();
    for (const worktreeId of this.resolvedWorktrees) {
      const context = this.candidates.get(worktreeId);
      const detectedPR = this.detectedPRs.get(worktreeId);
      if (context && detectedPR) {
        lookupBranchByWorktreeId.set(worktreeId, context.branchName);
        uniquePRNumbers.add(detectedPR.number);
        if (!trackedByNumber.has(detectedPR.number)) {
          trackedByNumber.set(detectedPR.number, {
            number: detectedPR.number,
            headSha: detectedPR.headSha ?? null,
            updatedAt: detectedPR.updatedAt ?? null,
            state: detectedPR.state,
            title: detectedPR.title,
          });
        }
      }
    }

    if (uniquePRNumbers.size === 0) return;
    logDebug("Revalidating resolved PRs", { count: uniquePRNumbers.size });

    const prByNumberLoader = this.prByNumberLoader;
    if (!prByNumberLoader) return;

    // Cheap conditional probe of the repo's open-PR list. When the provider
    // supports it, an authenticated 304 (or a clean diff) means none of the
    // tracked PRs changed, so the per-PR GraphQL re-fetch fan-out is skipped
    // entirely — the dominant steady-state quota cost this issue addresses. A
    // `fallback` result or an absent capability re-fetches every tracked PR,
    // preserving the pre-probe behavior. CI polling for in-flight PRs still runs
    // below regardless, since a CI re-run doesn't bump the PR's updated_at.
    let numbersToRefetch: number[];
    const changedSnapshotByNumber = new Map<number, PRSnapshot>();
    try {
      const probe = await bridge.probeOpenPRList(providerId, repo, [...trackedByNumber.values()]);
      if (probe && probe.kind === "unchanged") {
        numbersToRefetch = [];
      } else if (probe && probe.kind === "changed") {
        for (const snap of probe.changed) {
          if (uniquePRNumbers.has(snap.number)) {
            changedSnapshotByNumber.set(snap.number, snap);
          }
        }
        numbersToRefetch = [...changedSnapshotByNumber.keys()];
      } else {
        // `fallback`, or a `null` result (capability absent) — re-fetch all.
        numbersToRefetch = [...uniquePRNumbers];
      }
    } catch {
      // A probe RPC failure must not stall revalidation — fall back to a full
      // re-fetch, exactly as if the provider had no probe capability.
      numbersToRefetch = [...uniquePRNumbers];
    }

    try {
      // Revalidate the PRs the probe flagged (or all, on fallback) by number
      // through the provider-scoped loader, coalescing the fan-out into one
      // `findPRsByNumbers` batch when supported. The loader resolves null for a
      // confirmed-missing PR but rejects on a transient error, which we map to
      // `error: true` and skip so a flaky API call doesn't clear valid PR state.
      const results =
        numbersToRefetch.length === 0
          ? []
          : await Promise.all(
              numbersToRefetch.map((prNumber) =>
                prByNumberLoader.load(prNumber).then(
                  (pr): { prNumber: number; pr: ForgePR | null; error: boolean } => ({
                    prNumber,
                    pr,
                    error: false,
                  }),
                  (): { prNumber: number; pr: ForgePR | null; error: boolean } => ({
                    prNumber,
                    pr: null,
                    error: true,
                  })
                )
              )
            );

      // Stale-in-flight guard: if `setForgeSettings`/`refresh()` swapped the
      // provider while the probe or the GraphQL re-fetch was in flight, the
      // results (and the snapshots we'd seed) belong to the OLD provider.
      // Abandon the cycle quietly — the next poll picks up the new provider's
      // PRs. Mirrors the same guard in checkForPRs.
      if (
        this.providerNamespacedId !== providerId ||
        this.repoRef?.host !== repo.host ||
        this.repoRef?.owner !== repo.owner ||
        this.repoRef?.repo !== repo.repo
      ) {
        logDebug("Discarding stale PR revalidation results — provider changed mid-cycle", {
          fromProviderId: providerId,
          toProviderId: this.providerNamespacedId,
        });
        return;
      }

      const enrichedPRNumbers = new Set<number>();
      // Once per entry, like the head move below: siblings can share one, and
      // a second pass would see its own update and report no change.
      const mergeChangedByEntry = new Map<InternalLinkedPR, boolean>();

      // Decided per PR number before any entry's snapshot advances below:
      // sibling worktrees can share one entry, and the first iteration would
      // otherwise hide the move from the rest. The stored rollup's own commit
      // counts too, which catches a push seen on the very first probe, before
      // any head marker was seeded.
      const movedHeadNumbers = new Set<number>();
      const headMoveApplied = new Set<InternalLinkedPR>();
      for (const [prNumber, snap] of changedSnapshotByNumber) {
        if (!snap.headSha) continue;
        for (const entry of this.detectedPRs.values()) {
          if (entry.number !== prNumber) continue;
          if (entry.localHeadSha !== undefined) {
            if (isKnownHeadDuringLocalMove(entry, snap.headSha)) continue;
            movedHeadNumbers.add(prNumber);
            break;
          }
          const ciHead = entry._ciStatus?.headSha;
          if (
            (entry.headSha !== undefined && entry.headSha !== snap.headSha) ||
            (ciHead !== undefined && ciHead !== snap.headSha)
          ) {
            movedHeadNumbers.add(prNumber);
            break;
          }
        }
      }

      for (const { prNumber, pr, error } of results) {
        // Skip transient errors — a single flaky API call must not wipe PR state.
        if (error) continue;

        // Find all worktrees that have this PR
        for (const [worktreeId, detectedPR] of this.detectedPRs) {
          if (detectedPR.number !== prNumber) continue;

          if (!pr) {
            this.resolvedWorktrees.delete(worktreeId);
            this.issueTitleFetchedWorktrees.delete(worktreeId);
            this.detectedPRs.delete(worktreeId);
            logInfo("PR no longer found during revalidation - clearing state", { worktreeId });
            const clearedBranch = lookupBranchByWorktreeId.get(worktreeId);
            if (clearedBranch !== undefined) {
              // This clear already announces the absence the next branch
              // lookup is about to confirm.
              this.announcedNoPR.set(worktreeId, `${detectedPR.providerId}\0${clearedBranch}`);
            }
            events.emit("sys:pr:cleared", {
              worktreeId,
              branchName: clearedBranch,
              providerId: detectedPR.providerId,
              timestamp: Date.now(),
            });
            continue;
          }

          const newState = pr.state;
          const prChanged =
            detectedPR.state !== newState ||
            detectedPR.number !== pr.number ||
            detectedPR.title !== pr.title ||
            detectedPR.url !== pr.url ||
            detectedPR.baseRef !== pr.baseRef;

          let mergeChanged = mergeChangedByEntry.get(detectedPR);
          if (mergeChanged === undefined) {
            const intentBefore = detectedPR.mergeIntent;
            const movedBefore = detectedPR.headMovedWhileArmed;
            // The probe's REST head is fresh where the GraphQL read may be up to
            // a minute old, and once the probe's markers advance nothing re-reads
            // — so a push the cached read missed would never be seen.
            const head = changedSnapshotByNumber.get(prNumber)?.headSha ?? pr.headSha;
            applyMergeObservation(detectedPR, detectedPR, pr.mergeIntent, head);
            mergeChanged =
              !mergeIntentEqual(intentBefore, detectedPR.mergeIntent) ||
              movedBefore !== detectedPR.headMovedWhileArmed;
            mergeChangedByEntry.set(detectedPR, mergeChanged);
          }

          const snap = changedSnapshotByNumber.get(prNumber);
          const headMoved = movedHeadNumbers.has(prNumber);

          // Dropped before anything is emitted, once per entry: siblings can
          // share one, and a second pass would re-arm a wait the state change
          // below just closed. An entry a local push already moved to this
          // head keeps whatever it has read for it since.
          const movedLocally =
            snap?.headSha != null &&
            detectedPR.localHeadSha !== undefined &&
            isKnownHeadDuringLocalMove(detectedPR, snap.headSha);
          if (headMoved && !movedLocally && !headMoveApplied.has(detectedPR)) {
            headMoveApplied.add(detectedPR);
            const displaced =
              detectedPR.localHeadSha ?? detectedPR.headSha ?? detectedPR._ciStatus?.headSha;
            applyHeadMove(
              detectedPR,
              displaced !== snap?.headSha ? displaced : undefined,
              Date.now()
            );
            clearLocalHeadMove(detectedPR);
          }

          if (prChanged) {
            const oldState = detectedPR.state;
            detectedPR.state = newState;
            detectedPR.title = pr.title;
            detectedPR.url = pr.url;
            detectedPR.baseRef = pr.baseRef;

            logInfo("PR metadata changed during revalidation", {
              worktreeId,
              prNumber: pr.number,
              changes: {
                state: oldState !== newState ? `${oldState} → ${newState}` : undefined,
                title: detectedPR.title !== pr.title ? true : undefined,
              },
            });
          }

          // Checks for a closed or merged PR are never waited on.
          if (detectedPR.state !== "open") detectedPR.ciGraceUntil = undefined;

          if (prChanged || headMoved || mergeChanged) {
            events.emit("sys:pr:detected", {
              worktreeId,
              prNumber: pr.number,
              prUrl: pr.url,
              prState: newState,
              // Both CI fields or neither. The host rebuilds `linked.pr` from
              // the rich `ciStatus` on every detection event and full-replaces
              // it, so an emit carrying only the flat rollup blanks the mark
              // every badge actually reads until the enrichment below lands a
              // round trip later — the blink this branch used to produce on any
              // title or state edit. A metadata change on the same head says
              // nothing about CI, so the last known status rides along; a new
              // head already cleared both above. No `isCiStatusLoading`: that
              // flag would preserve the very rollup this emit retracts.
              prCiStatus: detectedPR.ciStatus,
              ciStatus: detectedPR._ciStatus,
              prTitle: pr.title,
              issueNumber: this.candidates.get(worktreeId)?.issueNumber,
              branchName: lookupBranchByWorktreeId.get(worktreeId),
              providerId: detectedPR.providerId,
              owner: repo.owner,
              repo: repo.repo,
              baseRef: pr.baseRef,
              mergeIntent: detectedPR.mergeIntent,
              headMovedWhileArmed: detectedPR.headMovedWhileArmed,
              timestamp: Date.now(),
            });
          }

          // Advance the change-detection snapshot from the probe's fresh REST
          // data so the next probe tick resolves to a zero-cost 304. Only the
          // REST probe carries head.sha / raw updated_at (the GraphQL PR shape
          // does not), so seeding from anywhere else is impossible. This runs on
          // the success path only — a transient error skips it above, leaving
          // the stale snapshot so the next probe re-flags the PR (self-healing).
          if (snap) {
            detectedPR.headSha = snap.headSha ?? undefined;
            detectedPR.updatedAt = snap.updatedAt ?? undefined;
            if (snap.headSha != null && detectedPR.localHeadSha === snap.headSha) {
              clearLocalHeadMove(detectedPR);
            }
          }

          // Revalidate CI status once per unique PR number. Multiple
          // worktrees on the same branch share the same detectedPR object
          // reference — deduplicating avoids double-counting stagnant polls
          // and redundant API calls.
          if (this.ciEnrichmentEnabled && !enrichedPRNumbers.has(prNumber)) {
            enrichedPRNumbers.add(prNumber);
            this.ciTracker.enrichPRWithCIStatus(detectedPR, repo);
          }
        }
      }

      this.ciTracker.enrichDueCiStatuses(enrichedPRNumbers, repo);

      this.updateBoostFromDetectedPRs();

      // Retry issue-title fetches for any candidate that still lacks a
      // confirmed successful title (#8851). Polling otherwise stops once all
      // PRs resolve, leaving the offline branchDerivedTitle as the only
      // visible label until the next manual refresh.
      const issueRetryLookups: Promise<void>[] = [];
      for (const [worktreeId, context] of this.candidates) {
        if (!context.issueNumber || typeof context.issueNumber !== "number") continue;
        if (this.issueTitleFetchedWorktrees.has(worktreeId)) continue;
        issueRetryLookups.push(
          this.fetchIssueTitle({
            worktreeId,
            issueNumber: context.issueNumber,
            issueClaim: context.issueClaim,
            branchAtFetchStart: context.branchName,
            branchName: context.branchName,
            providerId,
            repo,
          })
        );
      }
      if (issueRetryLookups.length > 0) {
        await Promise.allSettled(issueRetryLookups);
      }
    } catch (error) {
      logWarn("Revalidation check error", {
        error: formatErrorMessage(error, "PR revalidation failed"),
      });
    }
  }

  /**
   * Fetch one candidate's issue title and announce it (#8851). A number an
   * issues provider claimed from the branch name is looked up through that
   * provider by its key, never as the code forge's issue of the same number
   * (#13744). Failures are silent; the next cycle retries.
   */
  private fetchIssueTitle(lookup: {
    worktreeId: string;
    issueNumber: number;
    issueClaim: WorktreeContext["issueClaim"];
    branchAtFetchStart: string | undefined;
    branchName: string | undefined;
    providerId: string;
    repo: RepoRef;
  }): Promise<void> {
    const { worktreeId, issueNumber, issueClaim, branchAtFetchStart, providerId, repo } = lookup;
    const bridge = getForgeBridge();
    const request = issueClaim
      ? bridge.getIssueForLink({ projectPath: this.cwd, ...issueClaim })
      : bridge.getIssue(providerId, repo, issueNumber);
    return request
      .then((issue) => {
        // Branch-token check (lesson #2243): if the worktree's branch changed
        // during the fetch, the result is stale — don't write the fetched
        // marker, let the next pass retry against the new branch's issue.
        const current = this.candidates.get(worktreeId);
        if (current?.branchName !== branchAtFetchStart) return;
        if (
          current?.issueClaim?.issueProviderId !== issueClaim?.issueProviderId ||
          current?.issueClaim?.issueKey !== issueClaim?.issueKey
        ) {
          return;
        }
        if (issue) {
          this.issueTitleFetchedWorktrees.add(worktreeId);
          events.emit("sys:issue:detected", {
            worktreeId,
            issueNumber,
            issueTitle: issue.title,
            branchName: lookup.branchName,
            providerId,
            owner: repo.owner,
            repo: repo.repo,
            ...(issueClaim
              ? {
                  issueProvenance: {
                    ...issueClaim,
                    ...(issue.id ? { issueId: issue.id } : {}),
                  },
                }
              : {}),
            timestamp: Date.now(),
          });
        } else {
          // Null = forge confirmed not-found. Leave eligible for retry (no
          // marker added) so private/transient cases get another chance on
          // the next polling cycle.
          events.emit("sys:issue:not-found", {
            worktreeId,
            issueNumber,
            timestamp: Date.now(),
          });
        }
      })
      .catch(() => {
        // Issue lookup failure is silent — not an error worth surfacing.
      });
  }

  private async checkForPRs(options?: { forceCiEnrichment?: boolean }): Promise<void> {
    // A forced pass (manual refresh) fetches CI regardless of the ambient
    // focus-driven flag, and awaits the result so the refresh resolves only
    // once the badges have actually been re-emitted.
    // The force overrides the focus-driven flag only. A worker instance still
    // never fetches CI: the env role is the authoritative quota invariant, and
    // there is no user at the keyboard there to have asked for a refresh.
    const forceCi =
      options?.forceCiEnrichment === true && process.env.DAINTREE_INSTANCE_ROLE !== "worker";
    const shouldEnrichCi = forceCi || this.ciEnrichmentEnabled;
    const forcedCiEnrichments: Array<Promise<void>> = [];
    const activeCandidates: Array<{
      worktreeId: string;
      issueNumber?: number;
      branchName?: string;
    }> = [];
    // Issue-title lookup candidates include BOTH active and resolved
    // worktrees that have an issue number and haven't had a successful title
    // fetch yet (#8851). Resolved-PR worktrees still need this path because
    // `revalidateResolvedPRs` only re-checks PR metadata, not issue titles.
    const issueLookupCandidates: Array<{
      worktreeId: string;
      issueNumber: number;
      branchName?: string;
    }> = [];
    const lookupBranchByWorktreeId = new Map<string, string | undefined>();
    for (const [worktreeId, context] of this.candidates) {
      if (!this.resolvedWorktrees.has(worktreeId)) {
        activeCandidates.push({
          worktreeId,
          issueNumber: context.issueNumber,
          branchName: context.branchName,
        });
        lookupBranchByWorktreeId.set(worktreeId, context.branchName);
      }
      if (
        context.issueNumber &&
        typeof context.issueNumber === "number" &&
        !this.issueTitleFetchedWorktrees.has(worktreeId)
      ) {
        issueLookupCandidates.push({
          worktreeId,
          issueNumber: context.issueNumber,
          branchName: context.branchName,
        });
        if (!lookupBranchByWorktreeId.has(worktreeId)) {
          lookupBranchByWorktreeId.set(worktreeId, context.branchName);
        }
      }
    }

    if (activeCandidates.length === 0 && issueLookupCandidates.length === 0) {
      logDebug("No candidates to check for PRs");
      return;
    }

    const waitMs = this.msUntilCheckAllowed();
    if (waitMs > 0) {
      logDebug("Skipping PR check — within throttle window", { waitMs });
      return;
    }

    this.lastCheckAt = Date.now();

    logDebug("Checking PRs for candidates", { count: activeCandidates.length });

    // Re-resolve when we don't have a cached provider yet. The forge registry
    // lives in main and is populated by `PluginService.initialize()`; the
    // workspace-host UtilityProcess starts polling before that finishes, so a
    // one-shot resolution at `start()` would lose the race permanently. Each
    // poll retries until main answers definitively — and both definitive
    // answers are then cached (cleared explicitly by `refresh()` /
    // `setForgeSettings()` / `forge:provider-registry-updated`): a resolved
    // provider, or a "no-match" miss, which would otherwise re-spawn
    // `resolveProvider()`'s git-config reads on every debounced worktree
    // update (#9997).
    if (this.needsProviderResolution()) {
      await this.resolveProvider();
    }

    const repo = this.repoRef;
    const providerId = this.providerNamespacedId;

    if (!repo || !providerId) {
      // No forge provider resolved — all candidates get null linkage.
      // No error, no toast, no log spam (per issue spec).
      logDebug("Skipping PR check — no forge provider resolved");
      return;
    }

    const rateLimitBlock = await this.checkRateLimitGate();
    if (rateLimitBlock) {
      this.nextRetryAt = rateLimitBlock.resumeAt;
      logDebug("Skipping PR check — rate limit active", {
        providerId,
        resumeAt: rateLimitBlock.resumeAt,
        waitMs: rateLimitBlock.resumeAt - Date.now(),
      });
      return;
    }

    try {
      // Dedup by branch: each unique branch gets one findPRByBranch call.
      const uniqueBranches = new Map<string, string[]>();
      for (const c of activeCandidates) {
        const branch = c.branchName;
        if (!branch) continue;
        const existing = uniqueBranches.get(branch);
        if (existing) {
          existing.push(c.worktreeId);
        } else {
          uniqueBranches.set(branch, [c.worktreeId]);
        }
      }

      // Issue lookups (independent of PR lookups, run in parallel per candidate)
      const issueLookups: Promise<void>[] = [];
      for (const c of issueLookupCandidates) {
        const context = this.candidates.get(c.worktreeId);
        issueLookups.push(
          this.fetchIssueTitle({
            worktreeId: c.worktreeId,
            issueNumber: c.issueNumber,
            issueClaim: context?.issueClaim,
            branchAtFetchStart: context?.branchName,
            branchName: lookupBranchByWorktreeId.get(c.worktreeId),
            providerId,
            repo,
          })
        );
      }

      // Resolve unique branches → PR. Prefer the optional batch capability
      // when present; on failure fall back per-branch so a single transient
      // error doesn't blank every row's PR state. Truthiness guard per the
      // forge.ts capability convention.
      const branches = [...uniqueBranches.keys()];
      const prResults = await this.resolvePRsForBranches(branches);

      // Fire issue lookups in parallel with PR lookups
      await Promise.allSettled(issueLookups);

      // Stale-in-flight guard: if `setForgeSettings` invalidated the provider
      // (or refresh() swapped it) while branch/issue lookups were in flight,
      // the results belong to the OLD provider. Writing them to
      // detectedPRs/resolvedWorktrees would tag worktrees with a provider
      // they're no longer routed through. Abandon the cycle quietly — the
      // next poll picks up the new provider's PRs at the fast cadence.
      if (
        this.providerNamespacedId !== providerId ||
        this.repoRef?.host !== repo.host ||
        this.repoRef?.owner !== repo.owner ||
        this.repoRef?.repo !== repo.repo
      ) {
        logDebug("Discarding stale PR check results — provider changed mid-cycle", {
          fromProviderId: providerId,
          toProviderId: this.providerNamespacedId,
        });
        return;
      }

      let branchErrorCount = 0;
      let firstBranchError: Error | null = null;

      for (const { branch, pr, error } of prResults) {
        const worktreeIds = uniqueBranches.get(branch);
        if (!worktreeIds) continue;

        if (error) {
          // Transient lookup failure — NOT authoritative absence. Skip the
          // branch so any existing PR row survives; the loader evicts settled
          // keys, so the branch retries fresh next cycle. Routed to
          // handleError once per cycle after the loop.
          branchErrorCount++;
          firstBranchError ??= error;
          continue;
        }

        if (!pr) {
          // Authoritative "no PR found" for a fresh candidate. Without this,
          // `WorktreeMonitor._linked` stays `undefined` (its initial state)
          // and the renderer's preservation rule (#8870) would hold any
          // `linked.pr` carried over from a prior session indefinitely.
          for (const worktreeId of worktreeIds) {
            // Drop any stale detection alongside the clear: refresh() empties
            // `resolvedWorktrees` but keeps `detectedPRs`, so a PR that
            // disappeared between cycles would otherwise leave a pending
            // entry keeping the 30s revalidation boost armed indefinitely.
            this.detectedPRs.delete(worktreeId);
            const noPRKey = `${providerId}\0${branch}`;
            if (this.announcedNoPR.get(worktreeId) === noPRKey) continue;
            this.announcedNoPR.set(worktreeId, noPRKey);
            events.emit("sys:pr:cleared", {
              worktreeId,
              branchName: branch,
              providerId,
              timestamp: Date.now(),
            });
          }
          continue;
        }

        const internalPR: InternalLinkedPR = {
          number: pr.number,
          title: pr.title,
          url: pr.url,
          state: pr.state,
          isDraft: pr.isDraft,
          baseRef: pr.baseRef,
          headRef: pr.headRef,
          providerId,
          stagnantPollCount: 0,
        };
        // Any entry for this PR carries the episode, not just this lookup's own
        // worktrees: a sibling resolved earlier may already have seen the head
        // move, and a worktree joining later must not reset that to a clean
        // baseline. The URL names the repository, so a remote switched to
        // another repo's #42 inherits nothing. An entry on the episode this
        // read reports beats one on an older episode, then a seen move wins.
        let samePRPrior: InternalLinkedPR | undefined;
        let bestRank = -1;
        for (const prior of this.detectedPRs.values()) {
          if (prior.number !== internalPR.number || prior.providerId !== providerId) continue;
          if (prior.url !== internalPR.url) continue;
          const rank =
            (sameMergeEpisode(prior.mergeIntent, pr.mergeIntent) ? 2 : 0) +
            (prior.headMovedWhileArmed ? 1 : 0);
          if (rank > bestRank) {
            samePRPrior = prior;
            bestRank = rank;
          }
        }
        applyMergeObservation(internalPR, samePRPrior, pr.mergeIntent, pr.headSha);
        // A refresh must not forget what the post-push guards rely on: which
        // head the PR is on, which it moved off, whether it has CI at all, and
        // a wait already under way (whose deadline it must not restart).
        for (const worktreeId of worktreeIds) {
          const prior = this.detectedPRs.get(worktreeId);
          if (prior?.number !== internalPR.number || prior.providerId !== providerId) continue;
          internalPR.headSha = prior.headSha;
          internalPR.localHeadSha = prior.localHeadSha;
          internalPR.localHeadAt = prior.localHeadAt;
          internalPR.localMoveBaseSha = prior.localMoveBaseSha;
          internalPR.displacedByLocalMove = prior.displacedByLocalMove;
          internalPR.displacedHeadSha = prior.displacedHeadSha;
          internalPR.ciSeen = prior.ciSeen;
          if (internalPR.state === "open") internalPR.ciGraceUntil = prior.ciGraceUntil;
          break;
        }

        for (const worktreeId of worktreeIds) {
          // A refresh keeps `detectedPRs`, so the prior entry tells a genuine
          // detection apart from a re-announcement of the same PR.
          const prior = this.detectedPRs.get(worktreeId);
          const reannounced =
            prior !== undefined &&
            prior.number === internalPR.number &&
            prior.state === internalPR.state &&
            prior.title === internalPR.title &&
            prior.url === internalPR.url &&
            prior.isDraft === internalPR.isDraft &&
            prior.baseRef === internalPR.baseRef &&
            prior.providerId === internalPR.providerId &&
            mergeIntentEqual(prior.mergeIntent, internalPR.mergeIntent) &&
            prior.headMovedWhileArmed === internalPR.headMovedWhileArmed;
          this.resolvedWorktrees.add(worktreeId);
          this.detectedPRs.set(worktreeId, internalPR);
          this.announcedNoPR.delete(worktreeId);

          const lookupBranch = lookupBranchByWorktreeId.get(worktreeId);
          const issueNumber = this.candidates.get(worktreeId)?.issueNumber;

          (reannounced ? logDebug : logInfo)("PR detected for worktree", {
            worktreeId,
            prNumber: pr.number,
            prState: internalPR.state,
            providerId,
          });

          events.emit("sys:pr:detected", {
            worktreeId,
            prNumber: pr.number,
            prUrl: pr.url,
            prState: internalPR.state,
            // CI status is omitted here and resolved by the fire-and-forget
            // enrichment below; flag it so the renderer keeps its prior dot
            // instead of blinking to "no checks" between the two emits. When
            // enrichment is disabled there is no phase-2 emit coming, so omit
            // the flag entirely (`|| undefined` → absent, not false) — a held
            // "loading" with no resolution would spin forever (#6240).
            isCiStatusLoading: shouldEnrichCi || undefined,
            prTitle: pr.title,
            issueNumber,
            branchName: lookupBranch,
            providerId,
            owner: repo.owner,
            repo: repo.repo,
            baseRef: pr.baseRef,
            mergeIntent: internalPR.mergeIntent,
            headMovedWhileArmed: internalPR.headMovedWhileArmed,
            timestamp: Date.now(),
          });
        }

        // Fire-and-forget CI status enrichment (skipped on unattended
        // instances; enrichPRWithCIStatus also self-guards, but skipping here
        // avoids the needless call).
        if (shouldEnrichCi) {
          const enrichment = this.ciTracker.enrichPRWithCIStatus(internalPR, repo, forceCi);
          if (forceCi) forcedCiEnrichments.push(enrichment);
        }
      }

      // Every load enqueued above coalesced into one getCIStatuses batch in the
      // same tick; only now is it safe to await. Draining before the boost
      // update also lets it read the freshly-landed CI status.
      if (forcedCiEnrichments.length > 0) {
        await Promise.allSettled(forcedCiEnrichments);
      }

      this.updateBoostFromDetectedPRs();

      if (branchErrorCount > 0 && firstBranchError) {
        // Route the cycle's transient lookup failures through the breaker
        // exactly once — per cycle, not per branch, so breaker behavior isn't
        // topology-dependent on how many branches a repo happens to have.
        // Re-consult the rate-limit gate first: a 429 that landed mid-cycle
        // (after the top-of-cycle gate passed) must pause polling via the
        // rate-limit path rather than count toward the circuit breaker.
        const rateLimit = await this.checkRateLimitGate();
        this.handleError(
          `PR branch lookup failed for ${branchErrorCount} of ${prResults.length} branches: ${firstBranchError.message}`,
          rateLimit ?? undefined
        );
      } else if (prResults.length > 0) {
        // Only a cycle that actually completed a PR lookup counts as success
        // for the breaker — an issue-title-only retry cycle (no unresolved
        // branch candidates) must not clear a real PR-lookup error streak.
        this.consecutiveErrors = 0;
      }
    } catch (error) {
      this.handleError(formatErrorMessage(error, "PR check failed"));
    }
  }

  /**
   * Resolve a list of unique branches to PRs through the provider-scoped
   * `prByBranchLoader`. All `load()` calls here enqueue synchronously, so the
   * loader coalesces them into a single `findPRsByBranches` batch (or per-branch
   * fallback) and dedups any branch already in flight from an overlapping
   * cycle. A resolved `pr` (including null) is authoritative; a transient
   * lookup failure surfaces as a non-null `error` so the caller skips the
   * branch (never clears it) and routes the failure to the circuit breaker.
   */
  private async resolvePRsForBranches(
    branches: string[]
  ): Promise<Array<{ branch: string; pr: ForgePR | null; error: Error | null }>> {
    if (branches.length === 0) return [];

    const loader = this.prByBranchLoader;
    if (!loader) {
      // Unreachable in practice — checkForPRs() resolves the provider (which
      // creates the loaders) before calling here. Guard defensively without
      // wiping state: leave every branch unresolved for the next cycle.
      logWarn("resolvePRsForBranches called with no provider loader; skipping");
      return [];
    }

    // A disposal rejection comes from a mid-cycle provider swap
    // (`invalidateProvider()` from refresh()/setForgeSettings()), not a lookup
    // failure — absorb it as `null` so it never bumps `consecutiveErrors`
    // toward the circuit breaker. The downstream stale-provider guard discards
    // the whole cycle once it sees the provider changed, so the null is never
    // written as a spurious `sys:pr:cleared`. Any other rejection is a
    // transient lookup failure surfaced via the per-key Error contract.
    return Promise.all(
      branches.map((branch) =>
        loader.load(branch).then(
          (pr) => ({ branch, pr, error: null as Error | null }),
          (error: unknown) => {
            const err = error instanceof Error ? error : new Error(String(error));
            const isDisposed = err.message === "BatchLoader disposed";
            return {
              branch,
              pr: null as ForgePR | null,
              error: isDisposed ? null : err,
            };
          }
        )
      )
    );
  }

  private handleError(
    errorMsg: string,
    rateLimit?: { kind: "primary" | "secondary"; resumeAt: number }
  ): void {
    // Prefer a rate-limit marker captured synchronously alongside the
    // failing request — checking the mutable singleton here would race
    // with a concurrent 2xx clearing state between the 429 and this
    // handler. Treat a rate-limit pause distinctly from a circuit-breaker
    // trip: GitHub's docs warn that blind retry through secondary limits
    // can escalate to a permanent ban.
    if (rateLimit) {
      this.nextRetryAt = rateLimit.resumeAt;
      // Clear the streak: failures preceding the pause were likely the same
      // rate limit manifesting as transient errors before the gate caught it,
      // so carrying them over would leave the breaker on a hair trigger for
      // the first post-pause hiccup.
      this.consecutiveErrors = 0;
      logWarn("PR check hit a GitHub rate limit — pausing without tripping circuit breaker", {
        reason: rateLimit.kind,
        resumeAt: rateLimit.resumeAt,
      });
      return;
    }

    this.consecutiveErrors++;
    logWarn("PR check failed", { error: errorMsg, consecutiveErrors: this.consecutiveErrors });

    if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      const backoffMs = computeBackoff(this.consecutiveErrors);
      this.nextRetryAt = Date.now() + backoffMs;
      logWarn("Too many consecutive errors - pausing PR polling", { retryInMs: backoffMs });
      // No ui:notify here: this service runs in the workspace-host UtilityProcess,
      // where the EventBuffer subscriber (main-process only) does not exist, so the
      // emit was inert. The breaker trip is surfaced ambiently via setDetectionState
      // (sys:pr:detection-state → PRDetectionPausedIndicator), the correct tier for
      // auto-recovering state.
      this.setDetectionState(true);
    }
  }

  /**
   * Emit the circuit-breaker ambient state to the renderer, but only on a
   * genuine transition. Errors keep arriving while the breaker is tripped and
   * `refresh()` runs frequently, so an unconditional emit would flood the
   * worktree port and the PR badge store with redundant events.
   */
  private setDetectionState(tripped: boolean): void {
    if (this.detectionStateTripped === tripped) {
      return;
    }
    this.detectionStateTripped = tripped;
    events.emit("sys:pr:detection-state", { tripped, timestamp: Date.now() });
  }

  public getStatus(): {
    isPolling: boolean;
    isEnabled: boolean;
    candidateCount: number;
    resolvedCount: number;
    consecutiveErrors: number;
    detectionStateTripped: boolean;
  } {
    return {
      isPolling: this.isPolling,
      isEnabled: this.isEnabled,
      candidateCount: this.candidates.size,
      resolvedCount: this.resolvedWorktrees.size,
      consecutiveErrors: this.consecutiveErrors,
      // Distinct from `!isEnabled`: a rate-limit pause also disables polling
      // but does NOT trip the circuit breaker. The badge ambient signal must
      // only reflect the genuine 3-error breaker, not a transient 429 pause.
      detectionStateTripped: this.detectionStateTripped,
    };
  }
}

export const pullRequestService = new PullRequestService();
