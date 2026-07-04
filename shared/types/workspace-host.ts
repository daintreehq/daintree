/**
 * Message protocol types for Workspace Host IPC communication.
 *
 * This module defines the message format for communication between
 * the Main process (WorkspaceClient) and the Workspace Host (UtilityProcess).
 *
 * The Workspace Host consolidates all file-system and worktree-related operations:
 * - Phase 1: Git operations (WorktreeService, GitService)
 * - Phase 2: Context generation (CopyTreeService) - future
 *
 * All types are serializable (no functions, no circular refs) for IPC transport.
 */

import type { BranchInfo, CreateWorktreeOptions, RepoState, WorktreeChanges } from "./git.js";
import type {
  Worktree,
  WorktreeMood,
  WorktreeLifecycleStatus,
  WorktreeLifecyclePhaseResult,
  WorktreeResourceStatus,
  WslGitEligibility,
} from "./worktree.js";
import type { CIStatusState, Credentials, RepoRef } from "./forge.js";
import type { ForgeProviderMatcher } from "../utils/forgeHostnames.js";
import type { PluginWorktreeLinked } from "./plugin.js";
import type {
  CopyTreeOptions,
  CopyTreeProgress,
  CopyTreeResult,
  CopyTreeTestConfigResult,
  FileTreeNode,
} from "./ipc.js";
import type { ProjectPulse, PulseRangeDays } from "./pulse.js";
import type { WorkerResourceSnapshot } from "./workerGovernance.js";

/**
 * Worker-governance snapshot for one workspace host: the copytree worker's
 * state plus the host process's own memory usage (the copytree worker is a
 * worker_thread inside this host, so host-level memory is its memory story).
 */
export interface WorkspaceHostGovernanceSnapshot {
  timestamp: number;
  workers: WorkerResourceSnapshot[];
  hostMemory: {
    rssBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
  };
}

export type { BranchInfo, CreateWorktreeOptions } from "./git.js";

/**
 * Host-minted version stamp for worktree state events.
 *
 * `epoch` is a UUID regenerated each time the workspace-host process starts —
 * it identifies a single host run and is compared by identity only (UUIDv4
 * strings carry no meaningful ordering). `seq` is a monotonic counter within an
 * epoch. The renderer compares stamps by checking epoch equality first: a
 * differing epoch means the host restarted, so the event is always accepted and
 * the renderer re-hydrates from a fresh snapshot. Within the same epoch, the
 * higher `seq` wins. This replaces the renderer-minted counter that could not
 * see a host-restart boundary (#8403).
 */
export interface WorktreeEventVersion {
  epoch: string;
  seq: number;
}

/** Pull request service status */
export interface PRServiceStatus {
  isRunning: boolean;
  candidateCount: number;
  resolvedPRCount: number;
  lastCheckTime?: number;
  circuitBreakerTripped?: boolean;
}

/**
 * Worktree state snapshot for IPC transport.
 *
 * IMPORTANT: All fields must be serializable via structured clone algorithm.
 * No functions, class instances, symbols, or circular references allowed.
 * Snapshots are automatically sanitized via ensureSerializable() before sending.
 */
export interface WorktreeSnapshot {
  id: string;
  path: string;
  name: string;
  branch?: string;
  isCurrent: boolean;
  /**
   * Whether this is the main worktree (project permanent worktree).
   * Determined by canonical path match with project root, not git primary status.
   * Main worktrees are protected from deletion and cleanup operations.
   * False when project root path is unavailable (no protection applied).
   */
  isMainWorktree?: boolean;
  gitDir?: string;
  summary?: string;
  modifiedCount?: number;
  mood?: WorktreeMood;
  lastActivityTimestamp?: number | null;
  createdAt?: number;
  aiNote?: string;
  aiNoteTimestamp?: number;
  issueNumber?: number;
  prNumber?: number;
  prUrl?: string;
  prState?: "open" | "merged" | "closed";
  /**
   * Roll-up CI check status for the PR's head commit, in the normalized
   * forge vocabulary. Absent when the PR has no checks configured or before
   * the first PR detection lands.
   */
  prCiStatus?: CIStatusState;
  prTitle?: string;
  issueTitle?: string;
  /**
   * Offline-derived sentence-cased title parsed from `issue-<n>-<slug>`
   * branches, used as a fallback headline when `issueTitle` hasn't been
   * fetched yet so the sidebar never shows the raw slug (#8851).
   */
  branchDerivedTitle?: string;
  /**
   * PR number this worktree was created from via the GitHub PR dropdown (#8888).
   * Acts as the "PR-originated" discriminator: when set, the card surfaces the
   * PR title as the primary headline with the linked issue underneath, inverting
   * the default issue-first display. Held in-memory by the monitor (like
   * `worktreeMode`); not persisted to disk, so after a host restart the PR is
   * re-detected by polling and shown as a subordinate badge until then.
   */
  sourcePrNumber?: number;
  prLastUpdatedAt?: number;
  issueLastUpdatedAt?: number;
  worktreeChanges?: WorktreeChanges | null;
  worktreeId: string;
  timestamp?: number;
  /** Current or last completed lifecycle script status */
  lifecycleStatus?: WorktreeLifecycleStatus;

  /**
   * Per-phase teardown results, accumulated across a multi-phase teardown run
   * (resource-teardown then teardown). Distinct from `lifecycleStatus`, which
   * only reflects the last-active phase — a later phase no longer overwrites an
   * earlier phase's outcome here. Omitted when no teardown has run.
   */
  lifecyclePhaseResults?: WorktreeLifecyclePhaseResult[];

  /** Whether a plan file (TODO.md, PLAN.md, etc.) exists in the worktree root */
  hasPlanFile?: boolean;

  /** Relative path to the detected plan file (e.g. "TODO.md") */
  planFilePath?: string;

  /** Number of commits ahead of the upstream tracking branch */
  aheadCount?: number;

  /** Number of commits behind the upstream tracking branch */
  behindCount?: number;

  /** Name of the base branch (e.g. "develop") for divergence display */
  baseBranchName?: string | null;

  /** Commits the worktree branch is ahead of the base branch */
  baseAheadCount?: number | null;

  /** Commits the worktree branch is behind the base branch */
  baseBehindCount?: number | null;

  /** True when the upstream tracking branch and base branch point to the same commit */
  baseMatchesUpstream?: boolean;

  /**
   * Epoch ms of the last successful background `git fetch` for this worktree's
   * repo. Mirrored from `RepoFetchCoordinator` so siblings sharing a commondir
   * see the same timestamp. `null` until the first success lands.
   */
  lastFetchedAt?: number | null;

  /** Epoch ms of the last completed git status check for this worktree. */
  lastGitStatusCheckedAt?: number;

  /** True when this worktree's repo is in an auth-failed fetch state. */
  fetchAuthFailed?: boolean;

  /** True when the most recent fetch failed for a transient (non-auth) reason. */
  fetchNetworkFailed?: boolean;

  /** True while a background `git fetch` is in-flight for this worktree's repo. */
  isFetchInFlight?: boolean;

  /**
   * Canonical id of the registered forge provider whose hostname patterns
   * match the remote's fetch URL, or `null` when none matches.
   */
  matchedForgeProviderId?: string | null;

  /**
   * Provider-agnostic projection of the worktree's linked forge resources
   * (issue and/or PR). Populated by PRIntegrationService through the forge
   * provider. Replaces the legacy flat `prNumber` / `prState` / `issueNumber`
   * / `issueTitle` fields, which remain populated for backward compatibility.
   */
  linked?: PluginWorktreeLinked | null;

  /** Resource status from the last manual status check */
  resourceStatus?: WorktreeResourceStatus;

  /** Connect command from .daintree/config.json resource block */
  resourceConnectCommand?: string;

  /** Whether this worktree's project has a resource config block */
  hasResourceConfig?: boolean;

  /** Whether the resource config has a status command */
  hasStatusCommand?: boolean;

  /** Whether the resource config has a pause command */
  hasPauseCommand?: boolean;

  /** Whether the resource config has a resume command */
  hasResumeCommand?: boolean;

  /** Whether the resource config has a teardown command */
  hasTeardownCommand?: boolean;

  /** Whether the resource config has a provision command */
  hasProvisionCommand?: boolean;

  /** Worktree environment mode ("local" or an environment key from resourceEnvironments) */
  worktreeMode?: string;

  /** Cached display label for the environment (e.g., "Docker", "Akash") */
  worktreeEnvironmentLabel?: string;

  /** True when the worktree path is mounted via \\wsl$\ or \\wsl.localhost\. */
  isWslPath?: boolean;

  /** Distro name parsed from the WSL UNC mount, when `isWslPath` is true. */
  wslDistro?: string;

  /**
   * WSL git eligibility: `'eligible'` matches the default distro (gates "Enable"
   * UI), `'ineligible'` is a confirmed mismatch, `'unprobed'`/absent means the
   * probe hasn't resolved or failed.
   */
  wslGitEligible?: WslGitEligibility;

  /** User has opted in to WSL-routed git for this worktree. */
  wslGitOptIn?: boolean;

  /** User dismissed the WSL git suggestion banner without opting in. */
  wslGitDismissed?: boolean;

  /** POSIX path inside the WSL distro (mirrors `Worktree.wslPosixPath`). */
  wslPosixPath?: string;

  /** Current in-progress git operation (REBASING, MERGING, CHERRY_PICKING, REVERTING). Absent when no blocking operation is in progress. */
  repoState?: RepoState;

  /** Whether this worktree is in detached HEAD state. Mirrors the Worktree field. */
  isDetached?: boolean;

  /** HEAD commit hash (only populated when in detached HEAD state). */
  head?: string;
}

/** Monitor configuration for polling intervals */
export interface MonitorConfig {
  pollIntervalActive?: number;
  pollIntervalBackground?: number;
  /** FetchScheduler focused (isCurrent) fetch interval (ms) */
  fetchIntervalActiveMs?: number;
  /** FetchScheduler background (non-current) fetch interval (ms) */
  fetchIntervalBackgroundMs?: number;
  adaptiveBackoff?: boolean;
  pollIntervalMax?: number;
  circuitBreakerThreshold?: number;
  gitWatchEnabled?: boolean;
  gitWatchDebounceMs?: number;
  /**
   * Profile-aware cap on the number of background worktrees allowed to hold a
   * `git-only` file watcher concurrently (per workspace-host). The focused
   * worktree is excluded from this budget. Background worktrees beyond the cap
   * fall back to the adaptive poll path. See `ResourceProfileConfig`.
   */
  backgroundGitWatcherCap?: number;
}

/**
 * Requests sent from Main → Workspace Host.
 * Each request is a discriminated union type for compile-time safety.
 * Request IDs enable tracking responses for async operations.
 */
export type WorkspaceHostRequest =
  // Project lifecycle
  | {
      type: "load-project";
      requestId: string;
      rootPath: string;
      globalEnvVars?: Record<string, string>;
      /**
       * Persisted per-worktree WSL git opt-in state (Windows only). Map key is
       * the worktree id; values capture the user's previous Enable/Dismiss
       * decisions so the host can apply them when constructing monitors.
       */
      wslGitByWorktree?: Record<string, { enabled: boolean; dismissed: boolean }>;
      /**
       * Per-project `forgeProviderOverride` setting (#8111). The host can't
       * read `projectStore` directly — its main-process bindings would crash
       * the UtilityProcess (#8316). Plumbed through with the initial load so
       * `PullRequestService` can resolve the right provider without
       * importing `ProjectStore`.
       */
      forgeProviderOverride?: string | null;
      /**
       * Global `forgeDefaultProviderId` setting (#8110). Same rationale as
       * `forgeProviderOverride` — `electron-store` is main-process-only.
       */
      forgeDefaultProviderId?: string | null;
      /**
       * Selected git remote name (`forgeRemote`, #8456). The host resolves the
       * provider against this remote's URL rather than always `origin`, so a
       * project that pushes PRs to `upstream` resolves correctly. Plumbed in
       * for the same main-process-only reason as the fields above.
       */
      forgeRemote?: string | null;
    }
  | {
      type: "update-forge-settings";
      forgeProviderOverride: string | null;
      forgeDefaultProviderId: string | null;
      forgeRemote: string | null;
    }
  | {
      type: "sync";
      requestId: string;
      worktrees: Worktree[];
      activeWorktreeId: string | null;
      mainBranch: string;
      monitorConfig?: MonitorConfig;
    }
  | { type: "project-switch"; requestId: string }
  // Worktree queries
  | { type: "get-all-states"; requestId: string }
  | { type: "get-monitor"; requestId: string; worktreeId: string }
  // Worktree operations
  | { type: "set-active"; requestId: string; worktreeId: string; silent?: boolean }
  | { type: "refresh"; requestId: string; worktreeId?: string }
  | { type: "refresh-on-wake"; requestId: string }
  | { type: "refresh-prs"; requestId: string }
  | { type: "get-pr-status"; requestId: string }
  | { type: "reset-pr-state"; requestId: string }
  | {
      type: "create-worktree";
      requestId: string;
      rootPath: string;
      options: CreateWorktreeOptions;
    }
  | {
      type: "delete-worktree";
      requestId: string;
      worktreeId: string;
      force?: boolean;
      deleteBranch?: boolean;
    }
  // Branch operations
  | { type: "list-branches"; requestId: string; rootPath: string }
  | { type: "get-recent-branches"; requestId: string; rootPath: string }
  | {
      type: "fetch-pr-branch";
      requestId: string;
      rootPath: string;
      prNumber: number;
      headRefName: string;
    }
  // Git operations
  | {
      type: "get-file-diff";
      requestId: string;
      cwd: string;
      filePath: string;
      status: string;
      ignoreWhitespace?: boolean;
    }
  // Polling control
  | { type: "set-polling-enabled"; enabled: boolean }
  // PR polling cadence control (window-focus aware)
  | { type: "set-pr-poll-cadence"; focused: boolean }
  // WSL-routed git opt-in / banner dismissal (Windows only)
  | {
      type: "set-wsl-opt-in";
      worktreeId: string;
      enabled: boolean;
      dismissed: boolean;
    }
  // Re-probe the WSL default distro on demand and refresh eligibility (Windows only)
  | { type: "reprobe-wsl"; worktreeId: string }
  // Background/foreground lifecycle
  | { type: "background" }
  | { type: "foreground" }
  // GitHub rate-limit fetch-throttle multiplier relayed from main, where the
  // forge HTTP calls (and thus rate-limit observations) live post-#8870.
  | { type: "apply-fetch-throttle"; multiplier: number }
  // Forge provider hostname-matcher table relayed from main's registry so
  // monitors can resolve remote URLs to a provider id without registry access.
  | { type: "forge-provider-matchers"; matchers: ForgeProviderMatcher[] }
  // Health check
  | { type: "health-check" }
  // Lifecycle
  | { type: "dispose" }
  // Live log-level override updates from main (map of stable logger names to
  // `debug|info|warn|error|off`). Empty map clears all overrides.
  | { type: "set-log-level-overrides"; overrides: Record<string, string> }
  // CopyTree operations
  | {
      type: "copytree:generate";
      requestId: string;
      operationId: string;
      rootPath: string;
      options?: CopyTreeOptions;
    }
  | { type: "copytree:cancel"; operationId: string }
  | {
      type: "copytree:test-config";
      requestId: string;
      operationId: string;
      rootPath: string;
      options?: CopyTreeOptions;
    }
  // Worker-governance snapshot pull (copytree worker + host memory)
  | { type: "governance:snapshot"; requestId: string }
  // Resource profile config update
  | { type: "update-monitor-config"; requestId: string; config: MonitorConfig }
  // Resource actions
  | {
      type: "resource-action";
      requestId: string;
      worktreeId: string;
      action: "provision" | "teardown" | "resume" | "pause" | "status";
    }
  | {
      type: "switch-worktree-environment";
      requestId: string;
      worktreeId: string;
      envKey: string;
    }
  | { type: "has-resource-config"; requestId: string; rootPath: string }
  // Forge credential propagation
  | { type: "update-forge-credentials"; providerId: string; credentials: Credentials | null }
  // A forge provider descriptor was registered in main's plugin registry
  // (startup scan or runtime install/enable). Hosts paused on a "no-match"
  // resolution re-evaluate their provider on receipt (#9997).
  | { type: "forge:provider-registry-updated" }
  // User-triggered retry of auth-suspended fetches (e.g. clicking the auth-failed sync badge)
  | { type: "retry-auth-fetch" }
  // Project environment variable propagation
  | { type: "update-project-env"; vars: Record<string, string> }
  // File tree operations
  | {
      type: "get-file-tree";
      requestId: string;
      worktreePath: string;
      dirPath?: string;
    }
  // Project Pulse operations
  | {
      type: "git:get-project-pulse";
      requestId: string;
      worktreePath: string;
      worktreeId: string;
      mainBranch: string;
      rangeDays: PulseRangeDays;
      includeDelta?: boolean;
      includeRecentCommits?: boolean;
      forceRefresh?: boolean;
    }
  | { type: "invalidate-pulse-cache"; worktreeId: string }
  // Forge RPC response (main → workspace-host). Correlated to a prior
  // `forge:rpc` event by `forgeRequestId`. Carries either a successful return
  // value or an error message. See `ForgeRpcMethod` for the supported methods.
  | {
      type: "forge:rpc-result";
      forgeRequestId: string;
      ok: true;
      value: unknown;
    }
  | {
      type: "forge:rpc-result";
      forgeRequestId: string;
      ok: false;
      error: string;
    };

/**
 * Forge RPC methods the workspace-host can request from main. The
 * implementations live in main's forge provider registry (registered by
 * plugin activations). The workspace-host never holds impls itself — it
 * issues IPC calls through {@link ForgeBridge} and routes results by
 * `forgeRequestId`.
 *
 * `resolveProvider` is special-cased: it bundles `parseRemote` into the
 * lookup so the workspace-host gets `{ namespacedId, repo }` in a single
 * roundtrip and never needs to call sync provider methods.
 */
export type ForgeRpcMethod =
  | "resolveProvider"
  | "findPRByBranch"
  | "findPRsByBranches"
  | "findPRsByNumbers"
  | "getPR"
  | "getIssue"
  | "getCIStatus"
  | "getCIStatuses"
  | "probeOpenPRList"
  | "getRateLimit"
  | "clearPullRequestCaches";

/**
 * Result shape for `resolveProvider` — used by typed parsing of
 * `forge:rpc-result.value`. Discriminated so the workspace-host can tell a
 * transient miss from a permanent one (#9997): `"not-ready"` means the plugin
 * registry hasn't finished its startup scan yet (retry soon), `"no-match"`
 * means the scan is complete and no registered provider matches this project's
 * remote (stop polling until forge settings or the plugin registry change).
 */
export type ForgeResolveProviderResult =
  | { status: "resolved"; namespacedId: string; repo: RepoRef }
  | { status: "no-match" }
  | { status: "not-ready" };

/**
 * Events sent from Workspace Host → Main.
 * Includes both responses to requests and spontaneous updates.
 */
export type WorkspaceHostEvent =
  // Lifecycle events
  | { type: "ready" }
  | { type: "pong" }
  | { type: "error"; error: string; requestId?: string }
  // Project lifecycle responses
  | { type: "load-project-result"; requestId: string; success: boolean; error?: string }
  | { type: "sync-result"; requestId: string; success: boolean; error?: string }
  | { type: "update-monitor-config-result"; requestId: string; success: boolean; error?: string }
  | { type: "project-switch-result"; requestId: string; success: boolean }
  // Worktree query responses
  | {
      type: "all-states";
      requestId: string;
      states: WorktreeSnapshot[];
      epoch: string;
      seq: number;
      // Epoch-scoped mutation IDs the host has successfully acknowledged so
      // the renderer can prune outbox entries that landed before a crash
      // (#8405). Optional in the event union for compatibility with hosts
      // that predate this field; the port `get-all-states` response always
      // includes it.
      lastAcknowledgedMutationIds?: string[];
    }
  | { type: "monitor"; requestId: string; state: WorktreeSnapshot | null }
  // Worktree operation responses
  | { type: "set-active-result"; requestId: string; success: boolean }
  | { type: "refresh-result"; requestId: string; success: boolean; error?: string }
  | { type: "refresh-prs-result"; requestId: string; success: boolean; error?: string }
  | { type: "get-pr-status-result"; requestId: string; status: PRServiceStatus | null }
  | { type: "reset-pr-state-result"; requestId: string; success: boolean }
  | {
      type: "create-worktree-result";
      requestId: string;
      success: boolean;
      worktreeId?: string;
      error?: string;
    }
  | { type: "delete-worktree-result"; requestId: string; success: boolean; error?: string }
  // Branch operation responses
  | { type: "list-branches-result"; requestId: string; branches: BranchInfo[]; error?: string }
  | { type: "get-recent-branches-result"; requestId: string; branches: string[]; error?: string }
  | {
      type: "fetch-pr-branch-result";
      requestId: string;
      success: boolean;
      error?: string;
      gitReason?: import("./ipc/errors.js").GitOperationReason;
      recoveryAction?: import("./ipc/errors.js").RecoveryAction;
    }
  // Git operation responses
  | { type: "get-file-diff-result"; requestId: string; diff: string; error?: string }
  // Spontaneous updates (no requestId - these are pushed events)
  | { type: "worktree-update"; worktree: WorktreeSnapshot; epoch: string; seq: number }
  | { type: "worktree-removed"; worktreeId: string; epoch: string; seq: number }
  // Host-originated active-worktree change. Emitted from the host's authoritative
  // `setActiveWorktree` writer so the per-view renderer's WorktreeStoreContext
  // learns the new active id in the same tick as any accompanying
  // `worktree-removed` (auto-switch in `runTopologyReconcile` and
  // `deleteWorktree`). Separate surface from the legacy
  // `CHANNELS.WORKTREE_ACTIVATED` echo path that PR #3603's `silent` flag
  // suppresses for renderer-initiated IPC.
  // `silent` is propagated from the originating `set-active` request; when
  // true, the main-process router must skip the plugin-bus emit so callers
  // that explicitly marked the activation silent (the renderer IPC path)
  // do not double-notify subscribers that the legacy
  // `CHANNELS.WORKTREE_ACTIVATED` path already suppresses.
  | {
      type: "worktree-activated";
      worktreeId: string;
      epoch: string;
      seq: number;
      silent?: boolean;
    }
  // Per-worktree lifecycle setup failure surfaced to the renderer's error
  // banner. Emitted from sites that previously swallowed errors to
  // `console.warn` (the `createWorktree` async tail and the
  // `switchWorktreeEnvironment` catch). The main-process router translates
  // this into a `notifyError` with `context.worktreeId` so the failure shows
  // on the matching worktree card alongside the lifecycle status.
  | {
      type: "lifecycle-setup-error";
      worktreeId: string;
      message: string;
      details?: string;
    }
  // Linux-only: fired once per host-process lifetime when the recursive file
  // watcher hits the inotify watch limit (ENOSPC).
  | { type: "inotify-limit-reached" }
  // macOS-only: fired once per host-process lifetime when the recursive file
  // watcher hits the FSEvents file descriptor ceiling (EMFILE).
  | { type: "emfile-limit-reached" }
  // Fired when a previously-degraded recursive watcher successfully re-arms.
  // Clears the one-shot degradation guards so a later relapse can re-signal,
  // and hides the persistent degraded indicator in the renderer.
  | { type: "watcher-recovered" }
  // Fired once per repo (guarded host-side) when a background-fetch auth
  // failure persists past the retry/backoff confirmation threshold — i.e. the
  // forge credential is genuinely broken, not a transient blip. The renderer
  // surfaces a single escalation toast instead of the per-card auth stripe.
  // Re-armed by `retry-auth-fetch` / credential rotation so a later
  // re-confirmation can re-signal.
  | { type: "fetch-auth-failure-confirmed"; reason: import("./ipc/errors.js").GitOperationReason }
  // Fired when the topology watcher goes "dark": either the `@parcel/watcher`
  // subscribe() rejected at cold start (no events will ever arrive), or a 5s
  // pending-event safety valve expired without the watcher delivering the
  // matching event (the watcher missed a worktree-tree mutation the app itself
  // produced). Both mean the worktree list may silently drift out of date.
  // One-shot per dark period; clears via `topology-watcher-recovered`.
  | { type: "topology-watcher-dark" }
  // Fired when a topology reconcile completes successfully after a dark period,
  // restoring confidence that the worktree list is current. Independent of the
  // recursive-watcher `watcher-recovered` signal.
  | { type: "topology-watcher-recovered" }
  // PR events
  | {
      type: "pr-detected";
      worktreeId: string;
      prNumber: number;
      prUrl: string;
      prState: "open" | "merged" | "closed";
      prCiStatus?: CIStatusState;
      prTitle?: string;
      issueNumber?: number;
      issueTitle?: string;
      prLastUpdatedAt?: number;
      issueLastUpdatedAt?: number;
      /** Branch the lookup was initiated against — receiver drops the overlay if the worktree's branch has since changed. */
      branchName?: string;
      /** Provider that resolved the PR (e.g. `"daintree.github.github"`). */
      providerId?: string;
      /** Provider-agnostic linked projection (dual-shipped alongside legacy fields during migration). */
      linked?: PluginWorktreeLinked | null;
    }
  | {
      type: "pr-cleared";
      worktreeId: string;
      /** Branch the clear was initiated against — receiver drops the overlay if the worktree's branch has since changed. */
      branchName?: string;
      /** Provider whose linkage was cleared. */
      providerId?: string;
    }
  | {
      /** Service-wide PR detection circuit breaker tripped (paused) or recovered. */
      type: "pr-detection-state";
      tripped: boolean;
    }
  // Issue events
  | {
      type: "issue-detected";
      worktreeId: string;
      issueNumber: number;
      issueTitle: string;
      issueLastUpdatedAt?: number;
      /** Branch the lookup was initiated against — receiver drops the overlay if the worktree's branch has since changed. */
      branchName?: string;
      /** Provider that resolved the issue (e.g. `"daintree.github.github"`). */
      providerId?: string;
      /** Provider-agnostic linked projection (dual-shipped alongside legacy fields during migration). */
      linked?: PluginWorktreeLinked | null;
    }
  | {
      type: "issue-not-found";
      worktreeId: string;
      issueNumber: number;
    }
  // Forge provider rate-limit state observed in the workspace-host utility
  // process. The main process routes to the appropriate rate-limit handler
  // by providerId — GitHub's handler updates `gitHubRateLimitService` so
  // main-process callers (IPC handlers, toolbar countdown) see limits
  // triggered by PullRequestService polling too.
  | {
      type: "forge-rate-limit-changed";
      providerId: string;
      state: import("./forge.js").RateLimitInfo;
    }
  // Forge provider token-health state observed in the workspace-host utility
  // process. Forward-compat: the main process keys it by providerId and
  // broadcasts `forge:token-health-changed`. No provider implementation emits
  // this yet — GitHub token health still flows over the legacy GitHub path.
  | {
      type: "forge-token-health-changed";
      providerId: string;
      isUnhealthy: boolean;
    }
  // CopyTree events
  | { type: "copytree:progress"; operationId: string; progress: CopyTreeProgress }
  | {
      type: "copytree:complete";
      requestId: string;
      operationId: string;
      result: CopyTreeResult;
    }
  | { type: "copytree:error"; requestId: string; operationId: string; error: string }
  | {
      type: "copytree:test-config-result";
      requestId: string;
      result: CopyTreeTestConfigResult;
    }
  // Worker-governance snapshot result
  | {
      type: "governance:snapshot-result";
      requestId: string;
      snapshot: WorkspaceHostGovernanceSnapshot;
    }
  // File tree events
  | {
      type: "file-tree-result";
      requestId: string;
      nodes: FileTreeNode[];
      error?: string;
    }
  // Project Pulse events
  | { type: "git:project-pulse"; requestId: string; data: ProjectPulse }
  | { type: "git:project-pulse-error"; requestId: string; error: string }
  // Resource action responses
  | {
      type: "resource-action-result";
      requestId: string;
      success: boolean;
      output?: string;
      error?: string;
    }
  | {
      type: "has-resource-config-result";
      requestId: string;
      hasConfig: boolean;
    }
  // Forge RPC request (workspace-host → main). Forge provider impls live in
  // main (registered by `PluginService` on plugin activate); the workspace-host
  // dispatches calls here and awaits the matching `forge:rpc-result` request
  // back. `namespacedId` is omitted for `method === "resolveProvider"` since
  // that call discovers the provider from the remote URL.
  | {
      type: "forge:rpc";
      forgeRequestId: string;
      method: ForgeRpcMethod;
      namespacedId?: string;
      args: unknown[];
    }
  // WSL git opt-in entry is no longer reachable from the live worktree set
  // (#9926). Fired both on individual worktree removal (via the host's
  // `removeMonitor` chokepoint) and as a bulk self-heal pass at the end of
  // `loadProject` for any persisted keys not present in the freshly-listed
  // worktree set. Fire-and-forget — the persistent store prune is idempotent
  // (batched read-mutate-set) so a duplicate clear after a missed delivery
  // is a no-op. The host emits the raw `monitor.id` (no normalization); main
  // does a case-insensitive lookup on win32 to handle legacy mixed-case
  // persisted keys.
  | {
      type: "clear-wsl-git-opt-in";
      worktreeId: string;
    };

/** Configuration for WorkspaceClient */
export interface WorkspaceClientConfig {
  /** Maximum restart attempts before giving up */
  maxRestartAttempts?: number;
  /** Health check interval in milliseconds */
  healthCheckIntervalMs?: number;
  /** Whether to show dialog on crash */
  showCrashDialog?: boolean;
  /**
   * Max dormant (backgrounded, refCount=0) workspace hosts kept warm before the
   * oldest is evicted. Hosts demoted on switch-away poll at a reduced cadence
   * and still expire after the 180s idle grace, so a larger pool just avoids
   * respawning a host when the user cycles back to a recent project — it does
   * not add steady-state work. Defaults to a RAM-scaled value aligned with the
   * project-view cache so a warm project view keeps its host warm too; pinning
   * it (e.g. in tests) keeps eviction deterministic.
   */
  maxWarmEntries?: number;
}
