import type {
  CIStatusState,
  ForgeTokenHealthState,
  Issue,
  PR,
  ProjectHealthSnapshot,
  RateLimitInfo,
  StatsPage,
} from "../forge.js";

/**
 * Provider-agnostic rate-limit kind. `primary` is quota exhaustion (the
 * provider's request budget is spent until `resetAt`); `secondary` is an
 * abuse / burst throttle. The vocabulary is intentionally generic — it is
 * not GitHub-specific even though GitHub is currently the only built-in
 * provider that reports it.
 */
export type ForgeRateLimitKind = "primary" | "secondary";

/**
 * Push payload for `forge:rate-limit-changed`. Carries the canonical
 * `providerId` so the renderer can key state per provider — GitHub and any
 * additional forge provider flow through the same channel and never
 * cross-contaminate. `state` is the provider-agnostic {@link RateLimitInfo}
 * the workspace-host observed; the renderer normalizes it per provider.
 */
export interface ForgeRateLimitChangedPayload {
  providerId: string;
  state: RateLimitInfo;
}

/**
 * Push payload for `forge:token-health-changed`. Emitted by the host's
 * provider-health relay whenever a registered provider's
 * {@link import("../forge.js").HealthEventsCapability} reports a token-health
 * transition. `state` carries the full provider-reported snapshot so banner
 * surfaces can render re-auth links and probe freshness without a follow-up
 * fetch; `isUnhealthy` is the derived boolean store slices key on.
 */
export interface ForgeTokenHealthChangedPayload {
  providerId: string;
  isUnhealthy: boolean;
  state?: ForgeTokenHealthState;
}

/**
 * Push payload for `sys:pr:detected` / the renderer PR-detected channel.
 * Emitted by the host's PR-detection poll when a worktree's branch resolves
 * to a PR through the active forge provider. CI status uses the normalized
 * {@link CIStatusState} vocabulary — provider-specific check semantics never
 * cross this boundary.
 */
export interface PRDetectedPayload {
  worktreeId: string;
  prNumber: number;
  prUrl: string;
  prState: "open" | "merged" | "closed";
  /**
   * Roll-up CI status for the PR's head commit. Absent when the PR has no
   * checks configured or enrichment hasn't run.
   */
  prCiStatus?: CIStatusState;
  prTitle?: string;
  issueNumber?: number;
  issueTitle?: string;
  timestamp: number;
}

/** Payload for PR cleared notification. */
export interface PRClearedPayload {
  worktreeId: string;
  timestamp: number;
}

/** Issue detected payload. */
export interface IssueDetectedPayload {
  worktreeId: string;
  issueNumber: number;
  issueTitle: string;
}

/** Emitted when the forge confirms an issue doesn't exist on the current repo. */
export interface IssueNotFoundPayload {
  worktreeId: string;
  issueNumber: number;
  timestamp: number;
}

/** Git remote with parsed forge repo info (provider-agnostic). */
export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  parsedRepo: { owner: string; repo: string } | null;
}

/**
 * Provider-agnostic repository stats for the toolbar counts badge. Blends the
 * host-computed local-git fact (`commitCount`) with the provider-reported
 * forge counts ({@link import("../forge.js").ForgeRepoCounts}).
 */
export interface ForgeRepositoryStats {
  /** Total commit count for the current branch (host-computed, local git). */
  commitCount: number;
  /** Open issues count (`null` if unavailable). */
  issueCount: number | null;
  /** Open pull requests count (`null` if unavailable). */
  prCount: number | null;
  /** Whether stats are currently loading (renderer-side bookkeeping). */
  loading: boolean;
  /** Error message when the forge fetch failed (counts may still be cached). */
  error?: string;
  /** Whether the stats are from cache and may be outdated. */
  stale?: boolean;
  /** Epoch ms when stats were last successfully fetched from the forge. */
  lastUpdated?: number;
  /**
   * Epoch ms when the issue/PR counts were last read from a forge count
   * endpoint. `lastUpdated` is re-stamped when the main process confirms
   * "nothing changed" and re-serves cached counts; these are not — consumers
   * that need true count recency (badge arbitration, dropdown-open refresh)
   * read them, treating absence on a `stale: true` payload as unknown rather
   * than fresh. Per-count because a list query's write-back refreshes only its
   * own kind.
   */
  issueCountRefreshedAt?: number;
  prCountRefreshedAt?: number;
  /** Epoch ms when an active rate-limit block resumes. */
  rateLimitResetAt?: number;
  /** Kind of active rate limit (primary quota vs secondary abuse throttle). */
  rateLimitKind?: ForgeRateLimitKind;
  /** Provider-suggested delay (ms) until the next background stats poll. */
  nextPollIntervalMs?: number;
}

/**
 * Push payload broadcast after a successful network repo-stats poll that
 * produced first-page data. Carries the counts plus the first page of open
 * issues and PRs (created-desc) so renderers prime their resource caches
 * with no click-time round-trip.
 */
export interface ForgeRepoStatsAndPagePayload {
  providerId: string;
  /** Absolute project path the payload corresponds to. */
  projectPath: string;
  stats: ForgeRepositoryStats;
  issues: StatsPage<Issue>;
  prs: StatsPage<PR>;
  /** Wall-clock timestamp when the poll completed (ms). */
  fetchedAt: number;
}

/**
 * Lightweight count-only push, broadcast when a background poll refreshed the
 * counts via a cheap path with no first-page items to ship.
 */
export interface ForgeRepoCountsUpdatedPayload {
  providerId: string;
  /** Absolute project path the payload corresponds to. */
  projectPath: string;
  stats: ForgeRepositoryStats;
  /** Wall-clock timestamp when the poll completed (ms). */
  fetchedAt: number;
}

/**
 * Disk-persisted first page returned by `forge:get-first-page-cache`, for
 * cold-start toolbar hydration before the first network poll lands.
 */
export interface ForgeFirstPageCachePayload {
  providerId: string;
  /** Absolute project path the entry was written for. */
  projectPath: string;
  issues: StatsPage<Issue>;
  prs: StatsPage<PR>;
  /** Wall-clock timestamp (ms) when the entry was written. */
  lastUpdated: number;
  /**
   * Cached counts for cold-start hydration even when page items expired.
   * `commitCount` is blended in host-side (local git), not reported by the
   * provider — without it the renderer seeded a hardcoded 0 and the commit pill
   * shifted even when the issue/PR pills hydrated cleanly (issue #11078).
   */
  stats?: { commitCount: number; issueCount: number; prCount: number; lastUpdated: number };
}

/**
 * Project-health payload returned by `forge:get-project-health`. The
 * provider-reported {@link import("../forge.js").ProjectHealthSnapshot}
 * plus host-side presentation state.
 */
export interface ForgeProjectHealthPayload extends ProjectHealthSnapshot {
  hasRemote: boolean;
  loading: boolean;
  error?: string;
  /**
   * `true` when the resolved provider implements no `projectHealth`
   * capability. Distinct from an error or a missing remote: the repository
   * and provider are fine, this provider just has no health signal, so the
   * pulse card hides the health section instead of hinting at recovery
   * steps that wouldn't help.
   */
  unsupported?: boolean;
}

/**
 * Result classification for a single forge-provider method invocation.
 *
 * - `success`: the call resolved normally.
 * - `not-found`: the call resolved with `null` for a lookup that distinguishes
 *   "absent" from "failed" (`getIssue`/`getPR` return `Issue | null`). Forge
 *   APIs surface a 404 as a null return, not a thrown error, so this is a
 *   nominal outcome — not a failure.
 * - `error`: the call threw (network failure, auth rejection, malformed
 *   response). Recorded even when the caller's UI banner is suppressed, per
 *   the #8442 audit-even-when-silenced doctrine.
 */
export type ForgeAuditResult = "success" | "not-found" | "error";

/**
 * Derived severity for a forge audit record, computed at write time so
 * readers triage without re-deriving from `result`.
 *
 * - `info`: success — nominal call.
 * - `notice`: not-found — a lookup miss, expected during normal use.
 * - `error`: the provider call threw.
 */
export type ForgeAuditSeverity = "info" | "notice" | "error";

/**
 * Known `ForgeProviderImpl` methods that emit audit records. Kept as an open
 * union (`| (string & {})`) so a provider method added later still type-checks
 * as a `methodName` while the known names autocomplete and stay greppable.
 */
export type ForgeProviderMethodName =
  | "listIssues"
  | "listPRs"
  | "getIssue"
  | "getPR"
  | "getRepoMetadata"
  | "createIssue"
  | "assignIssue"
  | "unassignIssue"
  | "approvePR"
  | "requestChanges"
  | "dismissReview"
  | "requestReviewers"
  | "createPR"
  | "closePR"
  | "reopenPR"
  | "mergePR"
  | "convertPRToDraft"
  | "markPRReadyForReview"
  | "commentOnPR"
  | "editPR"
  | "closeIssue"
  | "reopenIssue"
  | "editIssue"
  | "addIssueComment"
  | "addIssueLabel"
  | "removeIssueLabel"
  | "validateToken"
  | "getCurrentUser";

export const FORGE_AUDIT_SCHEMA_VERSION = 1;

/** Minimum and maximum values accepted for the configurable ring-buffer cap. */
export const FORGE_AUDIT_MIN_RECORDS = 50;
export const FORGE_AUDIT_MAX_RECORDS = 10000;
export const FORGE_AUDIT_DEFAULT_MAX_RECORDS = 500;

const FORGE_SEVERITY_BY_RESULT: Record<ForgeAuditResult, ForgeAuditSeverity> = {
  success: "info",
  "not-found": "notice",
  error: "error",
};

export function computeForgeAuditSeverity(result: ForgeAuditResult): ForgeAuditSeverity {
  return FORGE_SEVERITY_BY_RESULT[result];
}

/**
 * Persisted audit record for a single `ForgeProviderImpl` method call. Written
 * once per invocation regardless of outcome — slow providers, credential
 * failures, and malformed responses all leave a trail. Distinct from
 * {@link import("./mcpServer.js").McpAuditRecord} (no `tier`/`sessionId`:
 * forge calls originate from the main process, not agent sessions).
 *
 * `argsSummary` is a redacted, single-level view of the call arguments — only
 * safe metadata (issue/PR number, list filters). Raw credential values are
 * never persisted: `validateToken` records an empty summary.
 *
 * `repoOwner`/`repoName` carry the owner/repo identity from the resolved
 * `RepoRef` — never the raw remote URL or any auth material. Absent on calls
 * with no repo context (`validateToken`).
 */
export interface ForgeAuditRecord {
  id: string;
  timestamp: number;
  /** Canonical `{pluginId}.{contributionId}` provider id. */
  providerId: string;
  methodName: ForgeProviderMethodName | (string & {});
  result: ForgeAuditResult;
  durationMs: number;
  repoOwner?: string;
  repoName?: string;
  /** Redacted single-level argument summary. Empty for credential calls. */
  argsSummary?: string;
  /** Provider error message on `result: "error"`. Absent otherwise. */
  errorMessage?: string;
  /** Schema version for forward-compat. New records always carry the current version. */
  schemaVersion: number;
  /** Derived severity so readers triage without re-deriving from result. */
  severity: ForgeAuditSeverity;
}

export type ForgeAnomalySeverity = "danger";

export type ForgeAnomalyKind =
  | "latency-drift"
  | "first-seen-method"
  | "failure-cluster"
  | "p95-z-score";

/**
 * Anomaly signal computed across the forge audit ring buffer. Mirrors
 * {@link import("./mcpServer.js").McpAnomalySignal} but keys on `methodName`
 * rather than `toolId`, and is scoped per `providerId` so a slow provider
 * doesn't poison another provider's baseline.
 */
export interface ForgeAnomalySignal {
  id: string;
  kind: ForgeAnomalyKind;
  providerId: string;
  methodName: string;
  severity: ForgeAnomalySeverity;
  timestamp: number;
  recordIds: string[];
  zScore?: number;
  durationMs?: number;
  baselineMedianMs?: number;
  p95Ms?: number;
  clusterSize?: number;
  clusterWindow?: number;
}

/**
 * Audit health snapshot for the forge audit ring buffer. Anomaly detection is
 * suppressed below {@link FORGE_AUDIT_ANOMALY_MIN_RECORDS} records — forge
 * calls are lower-frequency than MCP dispatches, so the floor is lower (10 vs
 * 50) and accrues across sessions via the persisted ring.
 */
export interface ForgeAuditStats {
  anomalySignals: ForgeAnomalySignal[];
  anomalySuppressed: boolean;
  anomalyRecordFloor: number;
}

/** Anomaly suppression floor — lower than MCP's 50 because forge calls are low-frequency. */
export const FORGE_AUDIT_ANOMALY_MIN_RECORDS = 10;
