import { events } from "./events.js";
import { logInfo, logWarn, logDebug } from "../utils/logger.js";
import type { WorktreeSnapshot as WorktreeState } from "../../shared/types/workspace-host.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { generateProjectId } from "./projectStorePaths.js";
import { createHardenedGit } from "../utils/hardenedGit.js";
import { getForgeBridge } from "../workspace-host/forgeBridge.js";
import { BatchLoader } from "../workspace-host/batchLoader.js";
import type {
  RepoRef,
  PR as ForgePR,
  PRSnapshot,
  RateLimitInfo,
  CIStatus,
  CIStatusState,
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

// Rate-limit block constants extracted from the GitHub-specific service so the
// polling loops consult the active provider's rate-limit state through
// ForgeProviderImpl.getRateLimit() rather than the gitHubRateLimitService singleton.
const RATE_LIMIT_CLOCK_SKEW_MS = 7_000; // buffer applied to server resetAt for clock skew
const RATE_LIMIT_SECONDARY_FALLBACK_MS = 60_000; // pause when throttled without a retry-after

interface WorktreeContext {
  issueNumber?: number;
  branchName?: string;
}

interface InternalLinkedPR {
  number: number;
  title: string;
  url: string;
  state: NormalizedPRState;
  isDraft?: boolean;
  ciStatus?: CIStatusState;
  _ciStatus?: CIStatus;
  providerId: string;
  stagnantPollCount: number;
  // REST change-detection markers for the open-PR-list revalidation probe.
  // Only the REST probe populates these (the GraphQL PR shape carries neither
  // head.sha nor a raw ISO updated_at), so they stay undefined until the first
  // probe-driven revalidation cycle seeds them.
  headSha?: string;
  updatedAt?: string;
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
  private pollIntervalMs: number = FOCUSED_POLL_INTERVAL_MS;
  private cwd: string = "";
  private isPolling: boolean = false;
  private consecutiveErrors: number = 0;
  private nextRetryAt: number = 0;
  private detectionStateTripped: boolean = false;
  private boostExpiresAt: number | null = null;
  // Drop the GraphQL CI-status enrichment when the instance is unattended:
  // worker-role instances (which never have a focused window) start disabled,
  // and attended instances toggle it off on window blur. When disabled, the
  // cheap REST probe (probeOpenPRList) still tracks PR existence/state, but the
  // ~2-point-per-PR getCIStatuses fan-out is skipped — absent CI reads as
  // "unknown" (undefined), never success (#6240). Initialized at field-
  // declaration time so it's correct before the singleton's first checkForPRs.
  private ciEnrichmentEnabled: boolean = process.env.DAINTREE_INSTANCE_ROLE !== "worker";
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
  // keep the cold-start retry cap. Re-armed by forge settings changes,
  // manual refresh, and `forge:provider-registry-updated` pushes from main.
  private providerResolutionStatus: "resolved" | "no-match" | "not-ready" | null = null;
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
    const issueChanged = currentContext?.issueNumber !== newIssueNumber;

    const shouldTrack = !state.isMainWorktree && isCandidateBranch(newBranchName);

    // Build the next context first
    const nextContext: WorktreeContext = {
      branchName: newBranchName,
      issueNumber: newIssueNumber,
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

    const shouldRecheck =
      this.isPolling &&
      (branchChanged ||
        !wasCandidate ||
        (issueChanged && !this.resolvedWorktrees.has(state.worktreeId)));

    if (shouldRecheck) {
      this.scheduleDebounceCheck();
    }
  }

  private handleWorktreeRemove({ worktreeId }: { worktreeId: string }): void {
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

  public initialize(cwd: string): void {
    this.cwd = cwd;
    this.projectId = generateProjectId(cwd);
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
    this.invalidateProvider();
  }

  private async resolveProvider(): Promise<void> {
    if (!this.projectId) return;
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
      const readRemoteUrl = async (remoteName: string): Promise<string | null> => {
        const result = await git.getConfig(`remote.${remoteName}.url`).catch(() => null);
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
      // A thrown resolution (git read or IPC failure) is transient — leave
      // the status null so the cold-start retry cap stays in effect.
      this.providerResolutionStatus = null;
      this.providerNamespacedId = null;
      this.repoRef = null;
      this.disposeLoaders();
    }
  }

  private invalidateProvider(): void {
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
        batchMap = await bridge.findPRsByNumbers(providerId, repo, list);
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
      // CI status is best-effort: a transient failure resolves to null rather
      // than rejecting, so it never invalidates an already-detected PR.
      return Promise.all(
        list.map((prNumber) => bridge.getCIStatus(providerId, repo, prNumber).catch(() => null))
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

  private runInitialCheck(): Promise<void> {
    return this.resolveProvider().then(() =>
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

  public async refresh(): Promise<void> {
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
    // Re-resolve the forge provider on manual refresh so token changes
    // and provider installs/uninstalls take effect immediately.
    // `invalidateProvider()` disposes the request coalescers, rejecting any
    // in-flight lookup so a stale promise from the previous provider can't bind
    // a wrong-repo PR to a worktree after refresh.
    this.invalidateProvider();
    await this.resolveProvider();
    await this.clearProviderPullRequestCaches();
    // Manual refresh is an explicit "I want fresh data now" — bypass the 5s
    // floor by clearing the throttle clock before the direct checkForPRs().
    this.lastCheckAt = Number.NEGATIVE_INFINITY;
    await this.checkForPRs();

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
    this.consecutiveErrors = 0;
    this.nextRetryAt = 0;
    // reset() runs on project switch, service teardown, and token removal
    // (updateToken(null) → reset()). Token removal does NOT re-attach the
    // worktree port, so a silent clear would strand a tripped glyph in the
    // renderer until the next wake. setDetectionState only emits on a genuine
    // true→false transition, so this is a no-op when not tripped and cannot
    // suppress a later genuine trip (the flag is false afterward).
    this.setDetectionState(false);
    this.boostExpiresAt = null;
    this.clearStagnantPollCounts();
    this.lastCheckAt = Number.NEGATIVE_INFINITY;
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

  /**
   * Toggle the GraphQL CI-status enrichment. Driven by window focus (blur →
   * disable, focus → enable) for attended instances; worker-role instances stay
   * disabled. The probe loop is untouched — only the per-PR getCIStatuses
   * fan-out is gated.
   *
   * On disable we must sweep any in-flight CI state so the adaptive boost
   * collapses: a pending entry left in `detectedPRs` keeps
   * `updateBoostFromDetectedPRs` re-arming the 30s boost every revalidation
   * tick with no fetch behind it (#6149). Clearing those entries to `undefined`
   * — not success — also keeps "no CI fetched" from reading as passing (#6240),
   * and re-emits so the renderer drops any preserved dot rather than holding it
   * stale forever (no phase-2 emit is coming while disabled).
   */
  public setCIEnrichmentEnabled(enabled: boolean): void {
    // Worker instances must stay disabled regardless of any focus signal that
    // reaches them — the env role is the authoritative invariant, not the
    // transient IPC cadence flag.
    if (enabled && process.env.DAINTREE_INSTANCE_ROLE === "worker") {
      return;
    }
    if (this.ciEnrichmentEnabled === enabled) {
      return;
    }

    if (!enabled) {
      this.sweepStaleCiStatus();
    }

    this.ciEnrichmentEnabled = enabled;

    if (!enabled) {
      // The boost just collapsed (boostExpiresAt = null), but an already-armed
      // boosted revalidationTimer would still fire early. Reschedule now so the
      // next tick lands at the 90s baseline instead of the stale 30s.
      this.scheduleRevalidation();
    }
  }

  // Clear in-flight CI state and re-emit the affected PRs without a CI status so
  // the boost decays and the renderer stops showing a stale spinner/dot. Only
  // pending entries are touched — terminal states (success/failure) and
  // already-unknown PRs are correct as-is, so re-emitting them would be noise.
  private sweepStaleCiStatus(): void {
    const repo = this.repoRef;
    // Track the exact worktrees we sweep, not the PR numbers: sibling worktrees
    // on the same branch share one InternalLinkedPR object (so clearing it once
    // covers them all), while two worktrees that coincidentally resolve the same
    // PR number through different objects must not cross-clear — re-emitting a
    // success worktree without its CI field would wrongly blank its dot.
    const sweptWorktrees: string[] = [];
    const sweptObjects = new Set<InternalLinkedPR>();

    for (const [worktreeId, pr] of this.detectedPRs) {
      if (pr.ciStatus === "pending") {
        sweptWorktrees.push(worktreeId);
        sweptObjects.add(pr);
      }
    }
    for (const pr of sweptObjects) {
      pr.ciStatus = undefined;
      pr._ciStatus = undefined;
      pr.stagnantPollCount = 0;
    }

    // updateBoostFromDetectedPRs runs unconditionally — with no pending entries
    // left it collapses boostExpiresAt to null so the next scheduleRevalidation
    // picks the 90s baseline instead of the boosted 30s.
    this.updateBoostFromDetectedPRs();

    if (!repo || sweptWorktrees.length === 0) {
      return;
    }

    for (const worktreeId of sweptWorktrees) {
      const detected = this.detectedPRs.get(worktreeId);
      if (!detected) continue;
      events.emit("sys:pr:detected", {
        worktreeId,
        prNumber: detected.number,
        prUrl: detected.url,
        prState: detected.state,
        // No prCiStatus / ciStatus / isCiStatusLoading: an absent CI field means
        // "unknown", which the renderer must not treat as passing or loading.
        prTitle: detected.title,
        issueNumber: this.candidates.get(worktreeId)?.issueNumber,
        branchName: this.candidates.get(worktreeId)?.branchName,
        providerId: detected.providerId,
        owner: repo.owner,
        repo: repo.repo,
        timestamp: Date.now(),
      });
    }
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
    const hasPendingCi = Array.from(this.detectedPRs.values()).some(
      (pr) => pr.ciStatus === "pending"
    );
    this.boostExpiresAt = hasPendingCi
      ? Date.now() + RESOLVED_REVALIDATION_BOOST_DURATION_MS
      : null;
  }

  private getBoostRevalidationIntervalMs(): number {
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

  private scheduleRevalidation(): void {
    if (!this.isPolling) {
      return;
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
    const intervalMs =
      this.boostExpiresAt !== null
        ? this.getBoostRevalidationIntervalMs()
        : RESOLVED_REVALIDATION_INTERVAL_MS;

    this.revalidationTimer = setTimeout(() => {
      this.revalidationTimer = null;
      void this.revalidateResolvedPRs()
        .catch((err) =>
          logWarn("Revalidation unexpected error", {
            error: formatErrorMessage(err, "PR revalidation failed"),
          })
        )
        .finally(() => this.scheduleRevalidation());
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
            events.emit("sys:pr:cleared", {
              worktreeId,
              branchName: lookupBranchByWorktreeId.get(worktreeId),
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
            detectedPR.url !== pr.url;

          if (prChanged) {
            const oldState = detectedPR.state;
            detectedPR.state = newState;
            detectedPR.title = pr.title;
            detectedPR.url = pr.url;

            logInfo("PR metadata changed during revalidation", {
              worktreeId,
              prNumber: pr.number,
              changes: {
                state: oldState !== newState ? `${oldState} → ${newState}` : undefined,
                title: detectedPR.title !== pr.title ? true : undefined,
              },
            });

            events.emit("sys:pr:detected", {
              worktreeId,
              prNumber: pr.number,
              prUrl: pr.url,
              prState: newState,
              prCiStatus: detectedPR.ciStatus,
              prTitle: pr.title,
              issueNumber: this.candidates.get(worktreeId)?.issueNumber,
              branchName: lookupBranchByWorktreeId.get(worktreeId),
              providerId: detectedPR.providerId,
              owner: repo.owner,
              repo: repo.repo,
              baseRef: pr.baseRef,
              timestamp: Date.now(),
            });
          }

          // Advance the change-detection snapshot from the probe's fresh REST
          // data so the next probe tick resolves to a zero-cost 304. Only the
          // REST probe carries head.sha / raw updated_at (the GraphQL PR shape
          // does not), so seeding from anywhere else is impossible. This runs on
          // the success path only — a transient error skips it above, leaving
          // the stale snapshot so the next probe re-flags the PR (self-healing).
          const snap = changedSnapshotByNumber.get(prNumber);
          if (snap) {
            detectedPR.headSha = snap.headSha ?? undefined;
            detectedPR.updatedAt = snap.updatedAt ?? undefined;
          }

          // Revalidate CI status once per unique PR number. Multiple
          // worktrees on the same branch share the same detectedPR object
          // reference — deduplicating avoids double-counting stagnant polls
          // and redundant API calls.
          if (this.ciEnrichmentEnabled && !enrichedPRNumbers.has(prNumber)) {
            enrichedPRNumbers.add(prNumber);
            this.enrichPRWithCIStatus(detectedPR, repo);
          }
        }
      }

      // CI status can change without the PR's metadata changing — a re-run does
      // not bump updated_at, so the probe reports those PRs unchanged. Keep
      // polling CI for any in-flight PR not already enriched above, so green/red
      // transitions still surface promptly even on an otherwise-quiet tick.
      // Skipped entirely when enrichment is disabled (unattended instance): the
      // sweep on disable already cleared pending entries, so this loop would be
      // a no-op anyway, but the guard keeps it from re-fetching after a
      // re-detection re-seeds a pending state mid-blur.
      if (this.ciEnrichmentEnabled) {
        for (const detectedPR of this.detectedPRs.values()) {
          if (enrichedPRNumbers.has(detectedPR.number)) continue;
          if (detectedPR.ciStatus === "pending") {
            enrichedPRNumbers.add(detectedPR.number);
            this.enrichPRWithCIStatus(detectedPR, repo);
          }
        }
      }

      this.updateBoostFromDetectedPRs();

      // Retry issue-title fetches for any candidate that still lacks a
      // confirmed successful title (#8851). Polling otherwise stops once all
      // PRs resolve, leaving the offline branchDerivedTitle as the only
      // visible label until the next manual refresh.
      const issueRetryLookups: Promise<void>[] = [];
      for (const [worktreeId, context] of this.candidates) {
        if (!context.issueNumber || typeof context.issueNumber !== "number") continue;
        if (this.issueTitleFetchedWorktrees.has(worktreeId)) continue;
        const issueNumber = context.issueNumber;
        const branchAtFetchStart = context.branchName;
        issueRetryLookups.push(
          bridge
            .getIssue(providerId, repo, issueNumber)
            .then((issue) => {
              const currentBranch = this.candidates.get(worktreeId)?.branchName;
              if (currentBranch !== branchAtFetchStart) return;
              if (issue) {
                this.issueTitleFetchedWorktrees.add(worktreeId);
                events.emit("sys:issue:detected", {
                  worktreeId,
                  issueNumber,
                  issueTitle: issue.title,
                  branchName: branchAtFetchStart,
                  providerId,
                  owner: repo.owner,
                  repo: repo.repo,
                  timestamp: Date.now(),
                });
              } else {
                events.emit("sys:issue:not-found", {
                  worktreeId,
                  issueNumber,
                  timestamp: Date.now(),
                });
              }
            })
            .catch(() => {
              // Silent; will retry on the next revalidation cycle.
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

  private async checkForPRs(): Promise<void> {
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
    if (
      (!this.providerNamespacedId || !this.repoRef) &&
      this.providerResolutionStatus !== "no-match"
    ) {
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
    const bridge = getForgeBridge();

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
        const lookupBranch = lookupBranchByWorktreeId.get(c.worktreeId);
        const branchAtFetchStart = this.candidates.get(c.worktreeId)?.branchName;
        issueLookups.push(
          bridge
            .getIssue(providerId, repo, c.issueNumber)
            .then((issue) => {
              // Branch-token check (lesson #2243): if the worktree's branch
              // changed during the fetch, the result is stale — don't write
              // the fetched marker, let the next pass retry against the new
              // branch's issue number.
              const currentBranch = this.candidates.get(c.worktreeId)?.branchName;
              if (currentBranch !== branchAtFetchStart) {
                return;
              }
              if (issue) {
                this.issueTitleFetchedWorktrees.add(c.worktreeId);
                events.emit("sys:issue:detected", {
                  worktreeId: c.worktreeId,
                  issueNumber: c.issueNumber,
                  issueTitle: issue.title,
                  branchName: lookupBranch,
                  providerId,
                  owner: repo.owner,
                  repo: repo.repo,
                  timestamp: Date.now(),
                });
              } else {
                // Null = forge confirmed not-found. Leave eligible for
                // retry (no marker added) so private/transient cases get
                // another chance on the next polling cycle.
                events.emit("sys:issue:not-found", {
                  worktreeId: c.worktreeId,
                  issueNumber: c.issueNumber,
                  timestamp: Date.now(),
                });
              }
            })
            .catch(() => {
              // Issue lookup failure is silent — not an error worth surfacing
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
          providerId,
          stagnantPollCount: 0,
        };

        for (const worktreeId of worktreeIds) {
          this.resolvedWorktrees.add(worktreeId);
          this.detectedPRs.set(worktreeId, internalPR);

          const lookupBranch = lookupBranchByWorktreeId.get(worktreeId);
          const issueNumber = this.candidates.get(worktreeId)?.issueNumber;

          logInfo("PR detected for worktree", {
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
            isCiStatusLoading: this.ciEnrichmentEnabled || undefined,
            prTitle: pr.title,
            issueNumber,
            branchName: lookupBranch,
            providerId,
            owner: repo.owner,
            repo: repo.repo,
            baseRef: pr.baseRef,
            timestamp: Date.now(),
          });
        }

        // Fire-and-forget CI status enrichment (skipped on unattended
        // instances; enrichPRWithCIStatus also self-guards, but skipping here
        // avoids the needless call).
        if (this.ciEnrichmentEnabled) {
          this.enrichPRWithCIStatus(internalPR, repo);
        }
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

  /**
   * Fire CI status lookup as a non-blocking tail after PR detection.
   * On success, updates the detectedPRs entry and re-emits sys:pr:detected
   * with the enriched CI status so the renderer can update the badge.
   */
  private enrichPRWithCIStatus(pr: InternalLinkedPR, repo: RepoRef): void {
    if (!this.ciEnrichmentEnabled) return;
    const loader = this.ciStatusLoader;
    if (!loader) return;
    // Synchronous `load()` here: enrichPRWithCIStatus is called fire-and-forget
    // in a `for` loop per detected PR, so all loads enqueue in the same tick and
    // coalesce into one `getCIStatuses` batch. Do NOT add an `await` before this
    // call — it would drain the microtask queue and defeat the coalescing.
    loader
      .load(pr.number)
      .then((ciStatus) => {
        // Enrichment may have been disabled (window blur) while this batch was
        // in flight — discard the result rather than write a CI status back and
        // re-arm the boost the sweep just collapsed.
        if (!this.ciEnrichmentEnabled) return;
        const prevCiStatus = pr.ciStatus;
        // A resolved value is authoritative: the batch contract surfaces a
        // transient miss as a rejection (→ .catch below), so a `null` here is a
        // confirmed "no CI checks." Map it to undefined and still re-emit so a
        // dot the phase-1 emit preserved is actually cleared once checks
        // genuinely disappear, rather than lingering stale (#9551).
        pr.ciStatus =
          ciStatus &&
          (ciStatus.state === "success" ||
            ciStatus.state === "failure" ||
            ciStatus.state === "pending")
            ? ciStatus.state
            : undefined;
        pr._ciStatus = ciStatus ?? undefined;
        if (pr.ciStatus !== undefined) {
          pr.stagnantPollCount = prevCiStatus === pr.ciStatus ? pr.stagnantPollCount + 1 : 0;
        }
        // Re-emit (phase-2) for each worktree that has this PR — including the
        // confirmed "no checks" case so a preserved phase-1 dot is cleared.
        for (const [worktreeId, detected] of this.detectedPRs) {
          if (detected.number === pr.number) {
            events.emit("sys:pr:detected", {
              worktreeId,
              prNumber: pr.number,
              prUrl: pr.url,
              // Read state from the live map entry, not the captured `pr` — a
              // re-detection may have replaced the entry while this enrichment
              // was in flight, and the stale capture would revert its state.
              prState: detected.state,
              prCiStatus: pr.ciStatus,
              prTitle: pr.title,
              issueNumber: this.candidates.get(worktreeId)?.issueNumber,
              branchName: this.candidates.get(worktreeId)?.branchName,
              providerId: pr.providerId,
              owner: repo.owner,
              repo: repo.repo,
              ciStatus: pr._ciStatus,
              timestamp: Date.now(),
            });
          }
        }
        this.updateBoostFromDetectedPRs();
      })
      .catch(() => {
        // CI status fetch is best-effort; failure does not invalidate the PR detection
      });
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
