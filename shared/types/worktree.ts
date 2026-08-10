import type { FileChangeDetail, RepoState, WorktreeChanges } from "./git.js";
import type { CIStatusState } from "./forge.js";
import type { PluginWorktreeLinked } from "./plugin.js";

/**
 * Opaque ownership token for an active fleet scope. Minted by
 * `enterFleetScope()` and required by `exitFleetScope(token)` so a stale exit
 * whose async continuation runs after a newer `enterFleetScope()` becomes a
 * structural no-op (token mismatch) rather than racing a mutable slot.
 */
export type FleetScopeToken = string & { readonly __brand: unique symbol };

/** Worktree mood indicator */
export type WorktreeMood = "stable" | "active" | "stale" | "error";

/**
 * Three-state WSL git eligibility. Replaces a bare boolean so the renderer can
 * distinguish "ineligible" (probe ran, distro mismatch) from "unprobed" (probe
 * hasn't run, is in flight, or failed). The old `boolean | undefined` shape
 * collapsed `false` and `undefined` together, hiding the difference. `'unprobed'`
 * is also what a missing/legacy snapshot field maps to at the renderer boundary.
 */
export type WslGitEligibility = "eligible" | "ineligible" | "unprobed";

/** Phase of worktree lifecycle script execution */
export type WorktreeLifecyclePhase =
  | "setup"
  | "teardown"
  | "resource-provision"
  | "resource-teardown"
  | "resource-resume"
  | "resource-pause"
  | "resource-status";

/** State of worktree lifecycle script execution */
export type WorktreeLifecycleState = "running" | "success" | "failed" | "timed-out";

/** Status of worktree lifecycle script execution (serializable) */
export interface WorktreeLifecycleStatus {
  phase: WorktreeLifecyclePhase;
  state: WorktreeLifecycleState;
  currentCommand?: string;
  commandIndex?: number;
  totalCommands?: number;
  output?: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
  /**
   * Absolute path to the persisted full-output log file for this run, when the
   * caller (teardown / resource-teardown phases) opted into log persistence.
   * Undefined for phases that don't persist a log, or when the write failed.
   */
  logPath?: string;
}

/**
 * Failure-severity classification for a settled lifecycle phase.
 * `billing-critical` — the failure may leave cloud resources running and
 * billing (resource teardown). `cosmetic` — local cleanup failed but the
 * worktree directory is about to be deleted anyway.
 */
export type WorktreeLifecyclePhaseCategory = "billing-critical" | "cosmetic";

/**
 * Settled result for a single lifecycle phase, accumulated across multi-phase
 * runs (resource-teardown then teardown) so a later phase no longer overwrites
 * an earlier phase's outcome. All fields are primitives for structured-clone
 * IPC transport. `exitCode`/`signalName` capture the child-process `close`
 * event structurally — a SIGKILL after timeout escalation is categorically
 * different from a self-inflicted non-zero exit.
 */
export interface WorktreeLifecyclePhaseResult {
  phase: WorktreeLifecyclePhase;
  state: WorktreeLifecycleState;
  category: WorktreeLifecyclePhaseCategory;
  exitCode: number | null;
  signalName: string | null;
  output?: string;
  error?: string;
  startedAt: number;
  completedAt: number;
  timedOut?: boolean;
  aborted?: boolean;
}

/** Resource status from the last manual status check */
export interface WorktreeResourceStatus {
  /** Raw status string from CLI output (e.g., "ready", "paused", "running") */
  lastStatus?: string;
  /** Last command output (tail) */
  lastOutput?: string;
  /** Error message if the last resource command failed */
  error?: string;
  /** Timestamp of the last status check */
  lastCheckedAt?: number;
  /** Resource endpoint URL from status JSON */
  endpoint?: string;
  /** Arbitrary metadata from status JSON */
  meta?: Record<string, unknown>;
  /** Provider identifier from config */
  provider?: string;
  /** Timestamp (ms epoch) when resource was last resumed */
  resumedAt?: number;
  /** Timestamp (ms epoch) when resource was last paused */
  pausedAt?: number;
}

/** Git worktree - multiple working trees on same repo */
export interface Worktree {
  /** Stable identifier for this worktree (normalized absolute path) */
  id: string;

  /** Absolute path to the worktree root directory */
  path: string;

  /** Human-readable name (branch name or last path segment) */
  name: string;

  /** Git branch name if available (undefined for detached HEAD) */
  branch?: string;

  /** HEAD commit hash (only populated when in detached HEAD state) */
  head?: string;

  /** Whether this worktree is in detached HEAD state */
  isDetached?: boolean;

  /** Current in-progress git operation (REBASING, MERGING, CHERRY_PICKING, REVERTING). Absent when no blocking operation is in progress. */
  repoState?: RepoState;

  /** Whether this is the currently active worktree based on cwd */
  isCurrent: boolean;

  /**
   * Whether this is the main worktree (project permanent worktree).
   * Taken from git's first `worktree list --porcelain` entry, which is always
   * the main worktree — not a path match against the project root (#2251: the
   * path-canonicalization variant failed closed and dropped delete protection
   * for every row when the root was unavailable).
   * Main worktrees are protected from deletion and cleanup operations.
   */
  isMainWorktree?: boolean;

  /** Path to the .git directory */
  gitDir?: string;

  /** Summary of work being done (last commit message or status) */
  summary?: string;

  /** Number of modified files in this worktree */
  modifiedCount?: number;

  /** Recent git status changes for this worktree */
  changes?: FileChangeDetail[];

  /** High-level mood/state for dashboard sorting */
  mood?: WorktreeMood;

  /** Most recent valid dirty-file modification time or HEAD committer time (milliseconds since epoch) */
  lastActivityTimestamp?: number | null;

  /** Timestamp when worktree directory was created (milliseconds since epoch, for sorting) */
  createdAt?: number;

  /** Content from .git/daintree/note file (for AI agent status communication) */
  aiNote?: string;

  /** Timestamp when the note file was last modified (milliseconds since epoch) */
  aiNoteTimestamp?: number;

  /** GitHub issue number extracted from branch name (e.g., 158 from feature/issue-158-description) */
  issueNumber?: number;

  /** GitHub pull request number linked to this worktree's issue or branch */
  prNumber?: number;

  /** GitHub pull request URL for quick access */
  prUrl?: string;

  /** Pull request state: open, merged, or closed */
  prState?: "open" | "merged" | "closed";

  /**
   * Roll-up CI check status for the PR's head commit, in the normalized
   * forge vocabulary. Absent when the PR has no checks configured or before
   * the first PR poll has landed.
   */
  prCiStatus?: CIStatusState;

  /** Pull request title */
  prTitle?: string;

  /** Timestamp when the PR state was last updated by the workspace-host */
  prLastUpdatedAt?: number;

  /** GitHub issue title */
  issueTitle?: string;

  /**
   * Offline-derived sentence-cased title parsed from the `issue-<n>-<slug>`
   * branch naming convention. Used as a fallback headline when `issueTitle`
   * hasn't been fetched yet so the sidebar never shows the raw slug.
   */
  branchDerivedTitle?: string;

  /**
   * PR number this worktree was created from via the GitHub PR dropdown (#8888).
   * When set, the card shows the PR title as the primary headline with the linked
   * issue underneath, inverting the default issue-first display.
   */
  sourcePrNumber?: number;

  /** Timestamp when the issue title was last updated by the workspace-host */
  issueLastUpdatedAt?: number;

  /** Worktree changes snapshot */
  worktreeChanges?: WorktreeChanges | null;

  /** Whether this worktree is locked (git worktree lock) */
  isLocked?: boolean;

  /** Reason the worktree is locked, if provided */
  lockReason?: string;

  /** Whether git considers this worktree prunable */
  isPrunable?: boolean;

  /** Reason git considers this worktree prunable, if provided */
  prunableReason?: string;

  /** Current or last completed lifecycle script status */
  lifecycleStatus?: WorktreeLifecycleStatus;

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
   * The ref the base counts were measured against — `upstream/main`, or a bare
   * `main` on the local fallback. Named in the badge tooltip so a multi-remote
   * repo the resolution still gets wrong reads as obviously wrong rather than
   * silently wrong (#11747).
   */
  baseCompareRef?: string | null;

  /**
   * Epoch ms of the last successful background `git fetch` for this worktree's
   * repo. Mirrors `RepoFetchCoordinator`'s per-commondir `lastSuccessfulFetch`
   * so all sibling worktrees sharing a `.git/objects` see the same timestamp.
   * `null` until the first successful fetch lands.
   */
  lastFetchedAt?: number | null;

  /** Epoch ms of the last completed git status check for this worktree. */
  lastGitStatusCheckedAt?: number;

  /**
   * True when this worktree's repo is currently in an auth-failed fetch state
   * (mirrored from `RepoFetchCoordinator.failure.kind === "auth"`). The card
   * surfaces a "Sign in to refresh" affordance when this is true and the
   * remote is GitHub; for other hosts the affordance stays silent.
   */
  fetchAuthFailed?: boolean;

  /**
   * True when the most recent fetch failed for a transient reason (network
   * unavailable / generic transient / repo-not-found-first). Surfaces as a
   * "Couldn't reach origin" tooltip line so users can distinguish a stale
   * count from one that's intentionally suppressed.
   */
  fetchNetworkFailed?: boolean;

  /** True while a background `git fetch` is in-flight for this worktree's repo. */
  isFetchInFlight?: boolean;

  /**
   * Canonical id of the registered forge provider whose hostname patterns
   * match the remote's fetch URL, or `null` when no registered provider
   * matches. Resolved at monitor start from the provider-matcher table main
   * relays into the workspace hosts; gates forge affordances (PR badge,
   * "sign in to refresh") without naming any one forge.
   */
  matchedForgeProviderId?: string | null;

  /**
   * Provider-agnostic projection of the worktree's linked forge resources
   * (issue and/or PR). Replaces the legacy flat `prNumber` / `prState` /
   * `issueNumber` / `issueTitle` fields.
   */
  linked?: PluginWorktreeLinked | null;

  /** Resource status from the last manual status check */
  resourceStatus?: WorktreeResourceStatus;

  /** Connect command from .daintree/config.json resource block */
  resourceConnectCommand?: string;

  /** Whether this worktree's project has a resource config block */
  hasResourceConfig?: boolean;

  /** Whether the configured resource environment has a pause command */
  hasPauseCommand?: boolean;

  /** Whether the configured resource environment has a resume command */
  hasResumeCommand?: boolean;

  /** Whether the configured resource environment has a teardown command */
  hasTeardownCommand?: boolean;

  /** Whether the configured resource environment has a status command */
  hasStatusCommand?: boolean;

  /** Whether the configured resource environment has a provision command */
  hasProvisionCommand?: boolean;

  /** Worktree environment mode ("local" or an environment key from resourceEnvironments) */
  worktreeMode?: string;

  /** Cached display label for the environment (e.g., "Docker", "Akash") */
  worktreeEnvironmentLabel?: string;

  /**
   * True when `path` falls outside `dirname(projectRootPath)` — the boundary
   * every Daintree-created worktree is structurally confined to, since
   * `validatePathPattern` rejects any pattern that escapes `{parent-dir}` and
   * `assertWorktreePathContained` enforces it on create. Marks a worktree git
   * reports but Daintree did not place (e.g. an agent's scratch worktree).
   * `undefined` when the boundary can't be determined; consumers must treat
   * only `true` as external so an unresolvable root can never flag the list.
   */
  isExternal?: boolean;

  /**
   * True when the worktree path is mounted via WSL (\\wsl$\… or
   * \\wsl.localhost\…). Detected at bind time on Windows; never set on
   * macOS/Linux.
   */
  isWslPath?: boolean;

  /** WSL distro name parsed from the UNC mount, when `isWslPath` is true. */
  wslDistro?: string;

  /**
   * Whether the detected `wslDistro` matches the WSL default distro and
   * Daintree can therefore route git operations through `wsl.exe git` (which
   * always targets the default distro). `'eligible'` shows the enable button;
   * `'ineligible'` shows a read-only informational note; `'unprobed'` (or
   * absent) means the probe hasn't resolved yet or failed.
   */
  wslGitEligible?: WslGitEligibility;

  /**
   * User has opted in to routing this worktree's git operations through WSL.
   * Persisted main-side in `wslGitByWorktree`; mirrored into the snapshot so
   * the renderer can hide the banner without a separate IPC round-trip.
   */
  wslGitOptIn?: boolean;

  /**
   * User has dismissed the WSL git banner without opting in. Banner stays
   * hidden until they explicitly enable WSL git from settings (future).
   */
  wslGitDismissed?: boolean;

  /**
   * POSIX path inside the WSL distro (always starts with `/`); present only
   * when `isWslPath` is true. Populated upstream by `enrichWorktreeWithWsl`
   * from `detectWslPath(path).posixPath` so downstream consumers (e.g.
   * `WorktreeMonitor`) do not re-parse the UNC.
   */
  wslPosixPath?: string;
}

/** Runtime worktree state (internal to WorktreeService) */
export interface WorktreeState extends Worktree {
  /** Alias for id (compatibility with some internal APIs) */
  worktreeId: string;
  /** Current changes snapshot (null if not yet calculated) */
  worktreeChanges: WorktreeChanges | null;
  /** Override to ensure the canonical dirty-file-or-commit activity timestamp is always present */
  lastActivityTimestamp: number | null;
}

/**
 * A worktree list paired with the workspace host's own answer to "is there a
 * repository here at all".
 *
 * The list on its own cannot be read as that answer. An empty array means "no
 * repository", "the host has not registered yet" and "the readiness gate timed
 * out" all at once, and the renderer has no way to tell them apart — so it has
 * to treat every empty list as unknown and keep whatever worktree state it
 * already had (#11234). That is correct for a slow host and wrong for a folder
 * with no `.git`, which is how a workspace ends up adopting the app-global
 * active worktree left behind by a different project (#11650).
 *
 * `gitBacked` closes that gap with the host's live probe rather than the
 * project row's persisted `gitBacked` column, whose NULL means both "real
 * repository" and "never classified" and so cannot gate anything. `null` here
 * is the honest "not classified yet" — callers must treat it as unknown and
 * stay permissive, never as `false`.
 */
export interface WorktreeListResult {
  worktrees: WorktreeState[];
  gitBacked: boolean | null;
}
