/**
 * Forge provider abstraction — foundation types.
 *
 * A "forge" is the developer-platform layer that sits on top of git: issues,
 * pull/merge requests, reviews, CI roll-up, releases, project boards, and
 * auth. See `docs/architecture/forge-provider-abstraction.md` for the design.
 *
 * This module is the runtime contract a forge plugin implements
 * (`ForgeProviderImpl`) plus the manifest entry that registers it
 * (`ForgeProviderContribution`). It is type-only and carries zero runtime
 * behavior — the host registry, SDK host API, and GitHub built-in plugin
 * land in later PRs of the migration plan.
 *
 * The host abstracts deliberately little: a thin shared interface for what
 * genuinely converges, a capability mechanism for what does not, and a
 * `rawData` escape hatch on every returned shape. The host never inspects
 * `rawData`; it exists for plugin-shipped views to consume their own data.
 * A first-party read of `rawData` is an interface-review signal — the missing
 * field should be promoted to the typed surface or a capability instead.
 */

/**
 * Identity of a repository on a forge, derived from a git remote URL via
 * {@link ForgeProviderImpl.parseRemote}.
 */
export interface RepoRef {
  host: string;
  owner: string;
  repo: string;
  rawData: unknown;
  /**
   * Absolute on-disk root of the project (its main worktree), injected by the
   * host so a file- or CLI-backed provider doesn't have to reconstruct the
   * directory from `repo` via `getActiveWorktree()`. It's the project root, not
   * the active linked worktree — project-scoped forge data lives once at the
   * root; a provider that genuinely needs the active worktree still reads it
   * from `getActiveWorktree()`. Present on refs the host resolves for a concrete
   * project; absent for synthetic refs or legacy callers, so consume it
   * defensively (`if (repo.projectPath)`). A network provider ignores it. Never
   * embed it in a remote API payload or a persisted cache key — it's host-local
   * context, not repository identity.
   */
  projectPath?: string;
}

/**
 * Provider-agnostic reference to a single resource (issue or PR). Used by
 * branch→PR linkage payloads so consumers can route back through the owning
 * provider without re-parsing.
 */
export interface ResourceRef {
  providerId: string;
  owner: string;
  repo: string;
  number: number;
  rawData: unknown;
}

/**
 * Normalized PR state. Provider enums diverge (GitHub `OPEN|CLOSED|MERGED`,
 * GitLab `opened|closed|locked|merged`, Bitbucket `OPEN|MERGED|DECLINED|
 * SUPERSEDED`, Gitea `open|closed`); the host normalizes to this set and
 * preserves the verbatim provider value as `rawState`. When submitting state
 * back to a provider API, plugins use `rawState`, never the normalized value.
 */
export type NormalizedPRState = "open" | "merged" | "closed" | "declined";

/** Normalized issue state. `rawState` preserves the verbatim provider value. */
export type NormalizedIssueState = "open" | "closed";

/**
 * Normalized review-decision roll-up for a PR — the aggregate approval state a
 * row badge needs without an N+1 per-PR review fetch. Provider enums diverge
 * (GitHub `reviewDecision`: `APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED`;
 * GitLab `approvalState`; Bitbucket "approved-by" lists); the host normalizes
 * to this closed set. `null` means the provider does not gate on reviews (no
 * required reviewers configured), distinct from `undefined` which means the
 * provider did not report a decision. Provider-specific states belong in
 * `rawData`, never here.
 */
export type NormalizedReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;

/**
 * Uniform rate-limit projection. Plugins parse their own transport (e.g. the
 * GitHub GraphQL `rateLimit` node) and populate this shape; the host renders
 * the rate-limit indicator from it. `null` means the provider does not report
 * that dimension.
 */
export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  /** Epoch milliseconds. */
  resetAt: number | null;
  secondaryThrottled?: boolean;
  /**
   * Background-poll cadence multiplier derived from the remaining rate-limit
   * budget. `1` at full speed; values above `1` stretch background fetch
   * intervals so multiple instances drawing on the same token budget back off
   * in step. Only the idle (background) branch is scaled; the active/focused
   * poll cadence is unaffected.
   */
  throttleMultiplier?: number;
}

/** Boolean-ish CI roll-up. The host renders a summary; it does not graph checks. */
export type CIStatusState = "success" | "failure" | "pending" | "neutral" | "unknown";

export interface CIStatus {
  state: CIStatusState;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  /** Whether required-checks gating is currently satisfied, if the provider gates. */
  requiredChecksPassing?: boolean;
  /** Opaque freshness token the host round-trips; see {@link FetchOptions}. */
  freshnessToken?: string;
  /** `true` when unchanged since `ifNotChangedSince`; see {@link FetchOptions}. */
  notModified?: boolean;
  rawData: unknown;
}

/** Result of validating stored credentials against the provider. */
export interface AuthValidation {
  valid: boolean;
  scopes?: string[];
  /** Epoch milliseconds, or `null` when the token does not expire. */
  expiresAt?: number | null;
  error?: string;
}

/**
 * Opaque credential the host passes through without inspecting. Token
 * storage, refresh, SSO, scope validation, and OAuth flows are fully owned
 * by the plugin.
 */
export interface Credentials {
  kind: "bearer" | "basic";
  value: string;
}

/** Repository metadata roll-up. */
export interface RepoMetadata {
  defaultBranch: string;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  description?: string | null;
  license?: string | null;
  topics?: string[];
  /** Opaque freshness token the host round-trips; see {@link FetchOptions}. */
  freshnessToken?: string;
  /** `true` when unchanged since `ifNotChangedSince`; see {@link FetchOptions}. */
  notModified?: boolean;
  rawData: unknown;
}

/**
 * Paged-listing options. All fields advisory — providers ignore options they
 * do not support. `cursor` is opaque and provider-defined.
 */
export interface ListOptions {
  /**
   * State filter. `"merged"` is PR-only — `listIssues` providers treat it as
   * the default open set since issues have no merged state. Advisory: a
   * provider that can't filter by a given state ignores it.
   */
  state?: "open" | "closed" | "merged" | "all";
  cursor?: string | null;
  perPage?: number;
  labels?: string[];
  assignee?: string;
  sort?: string;
  direction?: "asc" | "desc";
  /** Free-text search query. Advisory — providers ignore it if unsupported. */
  search?: string;
  /**
   * Skip the provider's in-memory list cache and any in-flight coalescing, and
   * fetch fresh data. The result still populates the cache for later reads.
   * Providers that don't cache ignore this. Advisory only.
   */
  bypassCache?: boolean;
  /**
   * Opaque freshness token from a prior {@link Page.freshnessToken} response.
   * Advisory: providers that support conditional listing skip the fetch and
   * return `notModified: true` when nothing changed; providers for which
   * probing costs the same as fetching may ignore it. See {@link FetchOptions}.
   */
  ifNotChangedSince?: string;
}

/**
 * Conditional-fetch options for the single-resource methods ({@link
 * ForgeProviderImpl.getIssue}, {@link ForgeProviderImpl.getPR}, {@link
 * ForgeProviderImpl.getCIStatus}, {@link ForgeProviderImpl.getRepoMetadata}).
 *
 * Freshness pass-through, end to end: the host stores the `freshnessToken` a
 * provider returns on a response shape and hands it back here as
 * `ifNotChangedSince` on the next call. The token is OPAQUE — REST providers
 * pack an ETag (`If-None-Match`), GraphQL providers pack a timestamp tuple; the
 * host only byte-compares two tokens for equality and never interprets one.
 *
 * `ifNotChangedSince` is advisory: a provider may ignore it whenever probing
 * for change costs the same as a full fetch. When a provider honors it and the
 * resource is unchanged, it sets `notModified: true` on the returned shape and
 * the host keeps its own cached copy. A `null` return still means "no such
 * resource" definitively — it is never a 304-equivalent.
 */
export interface FetchOptions {
  /** Opaque freshness token from a prior response; advisory (see above). */
  ifNotChangedSince?: string;
}

/**
 * One page of results. `nextCursor` is `null` when there are no more pages.
 * Client-side filtering across pages is forbidden — listing filters go
 * through {@link ListOptions} and the provider's native query.
 */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount?: number;
  /**
   * Opaque token capturing this page's freshness — the host stores it and
   * passes it back as {@link ListOptions.ifNotChangedSince} on the next call.
   * The host never interprets it (see {@link FetchOptions}).
   */
  freshnessToken?: string;
  /**
   * `true` when the provider honored `ifNotChangedSince` and nothing changed —
   * the host keeps its cached page. Only meaningful alongside `freshnessToken`;
   * `items` may be empty in this case.
   */
  notModified?: boolean;
}

/** Minimal actor projection. */
export interface ForgeUser {
  login: string;
  avatarUrl?: string;
  rawData: unknown;
}

export interface ForgeLabel {
  name: string;
  color?: string;
}

/**
 * Compact projection of a PR linked to an issue, for list-row badges. The
 * provider decides what "linked" means on its forge (GitHub closing
 * references, GitLab related MRs, …).
 */
export interface LinkedPRSummary {
  number: number;
  state: NormalizedPRState;
  url: string;
  ciStatus?: CIStatusState;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: NormalizedIssueState;
  /** Verbatim provider state value — use this when submitting state back. */
  rawState: string;
  url: string;
  author?: ForgeUser;
  assignees: ForgeUser[];
  labels: ForgeLabel[];
  /** Comment count, when the provider reports one. */
  commentCount?: number;
  /** Linked PR, when the provider links issues to PRs. */
  linkedPR?: LinkedPRSummary;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. */
  updatedAt: number;
  /** Epoch milliseconds, or `null` while open. */
  closedAt?: number | null;
  /** Opaque freshness token the host round-trips; see {@link FetchOptions}. */
  freshnessToken?: string;
  /** `true` when unchanged since `ifNotChangedSince`; see {@link FetchOptions}. */
  notModified?: boolean;
  rawData: unknown;
}

/**
 * Normalized input for {@link ForgeProviderImpl.createIssue}. Mirrors the
 * lowest common denominator across forges — `title` is required, `body` and
 * `labels` are optional. Providers map these onto their own create payload and
 * silently ignore fields they don't support.
 */
export interface CreateIssueInput {
  title: string;
  body?: string;
  labels?: string[];
}

export interface PR {
  number: number;
  title: string;
  body: string;
  state: NormalizedPRState;
  /** Verbatim provider state value — use this when submitting state back. */
  rawState: string;
  isDraft: boolean;
  merged: boolean;
  url: string;
  author?: ForgeUser;
  baseRef: string;
  headRef: string;
  /** `null` when the provider has not computed mergeability yet. */
  mergeable?: boolean | null;
  /**
   * Normalized aggregate review decision, for row badges without an N+1
   * per-PR review fetch. `null` when the provider doesn't gate on reviews,
   * `undefined` when not reported. See {@link NormalizedReviewDecision}.
   */
  reviewDecision?: NormalizedReviewDecision;
  /** Comment count, when the provider reports one. */
  commentCount?: number;
  /** Roll-up CI status for the head commit, when the provider reports one in lists. */
  ciStatus?: CIStatusState;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. */
  updatedAt: number;
  /** Epoch milliseconds, or `null` while open. */
  closedAt?: number | null;
  /** Epoch milliseconds, or `null` when not merged. */
  mergedAt?: number | null;
  /** Opaque freshness token the host round-trips; see {@link FetchOptions}. */
  freshnessToken?: string;
  /** `true` when unchanged since `ifNotChangedSince`; see {@link FetchOptions}. */
  notModified?: boolean;
  rawData: unknown;
}

export interface Release {
  id: string;
  tagName: string;
  name: string;
  body: string;
  isDraft: boolean;
  isPrerelease: boolean;
  url: string;
  /** Epoch milliseconds, or `null` for an unpublished draft. */
  publishedAt?: number | null;
  /** Epoch milliseconds. */
  createdAt: number;
  rawData: unknown;
}

/**
 * Review threads diverge too much across providers to normalize. The host
 * exposes only an opaque shape; plugins ship their own review-thread UI.
 */
export interface ReviewThread {
  id: string;
  rawData: unknown;
}

export interface ApprovalState {
  approved: boolean;
  required: number;
  approvedCount: number;
  changesRequested: boolean;
  rawData: unknown;
}

/** Stub shape — fields beyond identity are validated when a provider implements it. */
export interface ProjectBoard {
  id: string;
  rawData: unknown;
}

/** Stub shape — fields beyond identity are validated when a provider implements it. */
export interface Milestone {
  id: string;
  rawData: unknown;
}

/**
 * Provider-recognized push-failure classification. `code` is a short,
 * provider-stable identifier surfaced in the push-error banner so users have
 * something searchable (e.g. GitHub's `GH###` codes). The renderer derives the
 * settings route from the already-resolved provider's `contribution.id`, so
 * the provider does not declare its own settings tab here.
 */
export interface PushErrorClassification {
  code: string;
}

export interface ReviewCapability {
  getReviewThreads(repo: RepoRef, prNumber: number): Promise<ReviewThread[]>;
}

export interface ApprovalCapability {
  getApprovalState(repo: RepoRef, prNumber: number): Promise<ApprovalState>;
}

export interface ReleaseCapability {
  listReleases(repo: RepoRef, opts: ListOptions): Promise<Page<Release>>;
  getLatestRelease(repo: RepoRef): Promise<Release | null>;
}

export interface ProjectBoardCapability {
  listBoards(repo: RepoRef, opts: ListOptions): Promise<Page<ProjectBoard>>;
}

export interface MilestoneCapability {
  listMilestones(repo: RepoRef, opts: ListOptions): Promise<Page<Milestone>>;
}

/**
 * Lightweight snapshot of a PR's change-detection fields, exchanged with
 * {@link BatchLookupCapability.probeOpenPRList}. The caller passes its current
 * view of each tracked PR; the provider diffs it against a cheap probe and
 * returns only the PRs that changed. `headSha`/`updatedAt` are the change
 * markers a REST provider reads straight from its pulls-list response;
 * `state` lets the provider interpret a PR's *absence* from the open-PR list
 * correctly — a known-merged/closed PR is expected to be absent (not a change),
 * whereas an open PR's absence means it left the open set. A `null` field means
 * "unknown" (a not-yet-seeded caller snapshot, or — in a returned `changed`
 * entry — that the probe had no fresh data and the caller must re-fetch through
 * the authoritative path to learn the new value).
 */
export interface PRSnapshot {
  number: number;
  headSha: string | null;
  updatedAt: string | null;
  state: NormalizedPRState | null;
  title: string | null;
}

/**
 * Result of {@link BatchLookupCapability.probeOpenPRList}.
 *   - `unchanged` — no tracked PR changed; the caller skips its expensive
 *     per-PR revalidation entirely (the probe cost ~zero quota on a 304).
 *   - `changed` — `changed` lists the tracked PRs that changed; the caller
 *     re-fetches only those through the authoritative path. A snapshot with
 *     all-`null` change fields means "changed, but the probe has no fresh data"
 *     (e.g. the PR left the open set) — re-fetch to learn its new state.
 *   - `fallback` — the probe was inconclusive (auth/network/rate-limit/cold
 *     cache); the caller must run its full revalidation as if no probe existed.
 */
export type PRListProbeResult =
  | { kind: "unchanged" }
  | { kind: "changed"; changed: PRSnapshot[] }
  | { kind: "fallback" };

/**
 * Optional multi-key batch lookups. The host's host-side `BatchLoader`
 * coalesces same-tick `getCIStatus`/`getPR` fan-out into one of these calls
 * when the provider implements them, collapsing N round-trips into ceil(N/100)
 * requests. Each method returns a `Map` keyed by the input number; an explicit
 * `null` value means the lookup confirmed "not found", while a key *omitted*
 * from the map means the implementation could not resolve it in this batch
 * (transient error) and the caller should retry it — mirroring the
 * {@link ForgeProviderImpl.findPRsByBranches} omission convention. Providers
 * that don't batch simply omit the capability; the host falls back to per-key
 * calls transparently.
 */
export interface BatchLookupCapability {
  getCIStatuses?(repo: RepoRef, prNumbers: number[]): Promise<Map<number, CIStatus | null>>;
  findPRsByNumbers?(repo: RepoRef, prNumbers: number[]): Promise<Map<number, PR | null>>;
  findIssuesByNumbers?(repo: RepoRef, issueNumbers: number[]): Promise<Map<number, Issue | null>>;
  /**
   * Optional cheap conditional probe of the repo's open-PR list. Given the
   * caller's current {@link PRSnapshot}s of the PRs it tracks, return only
   * those that changed (or `unchanged`/`fallback`). Lets a steady-state
   * revalidation poll skip the expensive per-PR GraphQL fan-out when nothing
   * changed — an authenticated conditional `304` costs zero quota. Providers
   * that can't probe cheaply omit it; the caller then re-fetches every PR.
   */
  probeOpenPRList?(repo: RepoRef, tracked: PRSnapshot[]): Promise<PRListProbeResult>;
}

/**
 * Optional viewer-identity probe. Lets the renderer resolve "who am I" through
 * the active forge provider instead of reading the GitHub token's username
 * directly, so non-GitHub forges (GitLab, Gitea, Bitbucket) can wire the same
 * "assign issue to me" flow against their own identity. Returns `null` when
 * no authenticated viewer is available (no token, token rejected, or the
 * provider doesn't carry viewer info) — callers treat that as "skip
 * self-assignment" rather than an error.
 */
export interface IdentityCapability {
  getCurrentUser(): Promise<ForgeUser | null>;
}

/**
 * Hover-tooltip projection of an issue — the subset a hover card renders
 * without fetching the full resource. Providers truncate `bodyExcerpt`
 * themselves; the host renders it verbatim.
 */
export interface IssueTooltipData {
  number: number;
  title: string;
  bodyExcerpt: string;
  state: NormalizedIssueState;
  /** Verbatim provider state value, for provider-flavored display if needed. */
  rawState: string;
  /** Epoch milliseconds. */
  createdAt: number;
  author?: ForgeUser;
  assignees: ForgeUser[];
  labels: ForgeLabel[];
}

/** Hover-tooltip projection of a PR. See {@link IssueTooltipData}. */
export interface PRTooltipData {
  number: number;
  title: string;
  bodyExcerpt: string;
  state: NormalizedPRState;
  /** Verbatim provider state value, for provider-flavored display if needed. */
  rawState: string;
  /** `false` for forges with no draft concept. */
  isDraft: boolean;
  /** Epoch milliseconds. */
  createdAt: number;
  author?: ForgeUser;
  assignees: ForgeUser[];
  labels: ForgeLabel[];
}

/**
 * Optional hover-tooltip lookups. Distinct from `getIssue`/`getPR` so a
 * provider can serve tooltips from a dedicated short-TTL cache without
 * disturbing its list caches. Returns `null` when the resource doesn't exist
 * or the lookup fails — tooltip rendering is best-effort and never surfaces
 * an error state.
 */
export interface TooltipCapability {
  getIssueTooltip(repo: RepoRef, issueNumber: number): Promise<IssueTooltipData | null>;
  getPRTooltip(repo: RepoRef, prNumber: number): Promise<PRTooltipData | null>;
}

/**
 * Forge-side repository counts plus freshness metadata, as returned by
 * {@link RepoStatsCapability.getRepoStats}. Local-git facts (commit count)
 * are deliberately absent — the host computes those itself; the provider
 * reports only what lives on the forge.
 */
export interface ForgeRepoCounts {
  /** Open issues count, `null` when unavailable. */
  issueCount: number | null;
  /** Open PRs count, `null` when unavailable. */
  prCount: number | null;
  /** Counts came from a cache and may be outdated. */
  stale?: boolean;
  /** Epoch milliseconds of the last successful forge fetch. */
  lastUpdated?: number;
  /**
   * Epoch ms when each count was last read from a forge count endpoint. Unlike
   * `lastUpdated`, these are NOT re-stamped when an "unchanged" probe re-serves
   * cached counts — the host uses them for true count recency (badge
   * arbitration, dropdown-open refresh). Per-count because a list write-back
   * refreshes only its own kind.
   */
  issueCountRefreshedAt?: number;
  prCountRefreshedAt?: number;
  /** Human-readable error when the forge fetch failed (counts may be cached). */
  error?: string;
  /** Epoch milliseconds when an active rate-limit block resumes. */
  rateLimitResetAt?: number;
  /** Kind of active rate limit (primary quota vs secondary abuse throttle). */
  rateLimitKind?: "primary" | "secondary";
  /**
   * Suggested delay (ms) until the next background stats poll, derived from
   * the provider's own activity probing/backoff. Absent when the provider has
   * no adaptive signal.
   */
  nextPollIntervalMs?: number;
}

/**
 * One page of items in stats/first-page payloads. Narrower than {@link Page}:
 * stats snapshots don't round-trip freshness tokens.
 */
export interface StatsPage<T> {
  items: T[];
  endCursor: string | null;
  hasNextPage: boolean;
  totalCount?: number;
}

/** Result of {@link RepoStatsCapability.getRepoStats}. */
export interface RepoStatsSnapshot {
  counts: ForgeRepoCounts;
  /** First page of open issues (created-desc) when the fetch produced page data. */
  issues?: StatsPage<Issue> | null;
  /** First page of open PRs (created-desc) when the fetch produced page data. */
  prs?: StatsPage<PR> | null;
  /** Where the snapshot came from; `network` results are push-broadcast by the host. */
  source?: "network" | "memory-cache" | "disk";
}

/** Disk-persisted first-page snapshot for cold-start hydration. */
export interface FirstPageSnapshot {
  issues: StatsPage<Issue>;
  prs: StatsPage<PR>;
  /** Epoch milliseconds when the snapshot was written. */
  lastUpdated: number;
  /** Bootstrap-eligible cached counts, present even if page items expired. */
  counts?: { issueCount: number; prCount: number; lastUpdated: number };
}

/**
 * Optional repository-stats lookups powering the toolbar counts badge and
 * dropdown priming. Providers own caching, activity probing, and backoff;
 * the host owns local-git facts and push-broadcasting fresh results.
 */
export interface RepoStatsCapability {
  getRepoStats(repo: RepoRef, opts?: { bypassCache?: boolean }): Promise<RepoStatsSnapshot>;
  /** Cold-start hydration from the provider's disk cache; `null` when absent. */
  getFirstPageCache?(repo: RepoRef): Promise<FirstPageSnapshot | null>;
}

/**
 * Project-health roll-up for the project pulse card. All fields are
 * forge-sourced; `none`-ish defaults mean "provider has no signal", not an
 * error.
 */
export interface ProjectHealthSnapshot {
  ciStatus: "success" | "failure" | "error" | "pending" | "expected" | "none";
  issueCount: number;
  prCount: number;
  latestRelease: {
    tagName: string;
    publishedAt: string | null;
    url: string;
  } | null;
  securityAlerts: {
    visible: boolean;
    count: number;
  };
  mergeVelocity: {
    mergedCounts: Record<60 | 120 | 180, number>;
  };
  repoUrl: string;
  /** Epoch milliseconds of the last successful fetch. */
  lastUpdated?: number;
}

/** Optional project-health lookup powering the project pulse card. */
export interface ProjectHealthCapability {
  getProjectHealth(
    repo: RepoRef,
    opts?: { bypassCache?: boolean }
  ): Promise<{ health: ProjectHealthSnapshot | null; error?: string }>;
}

/**
 * Optional commit-author avatar resolution. Maps a commit author email to an
 * avatar URL via the provider's user search, or `null` when unresolvable.
 * Providers cache internally; the lookup must be cheap to call repeatedly.
 */
export interface AvatarCapability {
  resolveAuthorAvatar(email: string): Promise<string | null>;
}

/** A single named rate-limit bucket as reported by the provider. */
export interface RateLimitBucket {
  /** Provider-defined bucket name (e.g. `core`, `graphql`, `search`). */
  name: string;
  limit: number;
  used: number;
  remaining: number;
  /** Epoch milliseconds when this bucket's quota resets. */
  resetAt: number;
}

/**
 * Detailed per-bucket rate-limit snapshot for diagnostics UI. Providers with
 * a single quota return one bucket; providers with no inspectable quota omit
 * the capability method entirely.
 */
export interface RateLimitDetails {
  buckets: RateLimitBucket[];
  /** Epoch milliseconds when the snapshot was fetched. */
  fetchedAt: number;
}

/**
 * Current health of the provider's stored credential.
 *
 * - `unknown`: no credential configured or no probe has completed yet
 * - `healthy`: the most recent probe succeeded
 * - `unhealthy`: the provider authoritatively rejected the credential
 *   (expired/revoked) — transient network failures must NOT flip to this
 */
export type ForgeTokenHealthStatus = "unknown" | "healthy" | "unhealthy";

/** Token-health state pushed through {@link HealthEventsCapability}. */
export interface ForgeTokenHealthState {
  status: ForgeTokenHealthStatus;
  /** Monotonic credential version at the time of the last completed probe. */
  tokenVersion: number;
  /** Epoch milliseconds at which the last probe completed. */
  checkedAt: number;
  /** Provider re-authorization URL (e.g. SSO), when one was observed. */
  reauthUrl?: string;
}

/**
 * Optional health-event surface. The host subscribes once per registered
 * provider and relays state to every renderer over the providerId-keyed
 * `forge:*` push channels, and paces workspace-host background polling from
 * the rate-limit `throttleMultiplier`. Subscriptions return a disposer; the
 * host disposes them when the provider implementation is replaced or
 * unregistered.
 */
export interface HealthEventsCapability {
  /** Replay the current token-health state (for late-mounting windows). */
  getTokenHealth(): ForgeTokenHealthState;
  onTokenHealthChanged(callback: (state: ForgeTokenHealthState) => void): () => void;
  onRateLimitChanged?(callback: (info: RateLimitInfo) => void): () => void;
  /** Detailed per-bucket snapshot for diagnostics UI; omit when not inspectable. */
  getRateLimitDetails?(): Promise<RateLimitDetails | null>;
  /**
   * Optional. Re-probe credential health now. The host calls this on
   * focus-regain (unforced — the provider applies its own cooldown) and on
   * system wake (`force: true`, so a credential that expired during a long
   * sleep is detected promptly). Results surface via
   * {@link onTokenHealthChanged}; the host never awaits the result.
   */
  refreshTokenHealth?(options?: { force?: boolean }): Promise<void> | void;
}

/** Result of probing whether a provider can authenticate a clone. */
export interface CloneAuthProbe {
  authenticated: boolean;
  /** Short human-readable explanation when `authenticated` is `false`. */
  reason?: string;
}

/** Options for {@link CloneCapability.cloneRepository}. */
export interface CloneRequestOptions {
  /** Clone with `--depth 1` semantics when the provider's tooling supports it. */
  shallow?: boolean;
  /** Abort signal — the provider must kill its clone process tree on abort. */
  signal?: AbortSignal;
  /** Progress relay; `stage` is a stable lowercase dedup key, `message` is display text. */
  onProgress?(stage: string, progress: number, message: string): void;
}

/**
 * Optional authenticated-clone support, powering the host's clone-repository
 * flow without it hardcoding any one forge's CLI. The host probes
 * {@link probeAuth} first and only takes a capability path when it reports
 * `authenticated: true`; otherwise — or when the provider omits the
 * capability entirely — it falls back to a plain anonymous `git clone`.
 * {@link cloneRepository} is preferred over {@link getAuthenticatedCloneUrl}
 * when both are present. Errors thrown from `cloneRepository` surface to the
 * user directly (no plain-git retry), so a provider whose tooling may be
 * absent should report that through `probeAuth` rather than failing the
 * clone. Authenticated URLs may embed credentials: the host never logs or
 * persists them, and providers must not either.
 */
export interface CloneCapability {
  /**
   * Probe whether an authenticated clone path is currently available
   * (tooling installed and signed in, or a valid stored credential). Drives
   * the host's path selection; an unauthenticated probe also means the clone
   * dialog shows no provider sign-in recovery affordance beyond the standard
   * auth-failure banner.
   */
  probeAuth(signal?: AbortSignal): Promise<CloneAuthProbe>;
  /**
   * Rewrite a clone URL to carry the provider's credentials (e.g. an
   * embedded token). Return `null` when no authenticated URL is available;
   * the host then clones the original URL anonymously.
   */
  getAuthenticatedCloneUrl?(url: string): Promise<string | null>;
  /**
   * Clone using the provider's own tooling (e.g. `gh repo clone`).
   * `targetDir` is the absolute directory the clone must create; its parent
   * is validated to exist before the call.
   */
  cloneRepository?(url: string, targetDir: string, opts: CloneRequestOptions): Promise<void>;
}

/**
 * Runtime contract a forge plugin implements and registers via
 * `host.registerForgeProvider`. Every provider implements the base methods;
 * optional capabilities are sibling fields the host probes at runtime.
 * Adding a new capability adds a sibling field — the base interface never
 * changes.
 *
 * Capability presence check: use a truthiness/`!= null` guard
 * (`if (provider.reviews)`), NOT the `in` operator. An optional property
 * explicitly set to `undefined` still satisfies `"reviews" in provider`,
 * so `in` would falsely report the capability as available.
 */
export interface ForgeProviderImpl {
  // Auth — fully owned by the plugin; the host never inspects credentials.
  getCredentials(): Promise<Credentials | null>;
  setCredentials?(credentials: Credentials | null): void;
  validateCredentials(): Promise<AuthValidation>;

  // Repository identity.
  parseRemote(url: string): RepoRef | null;

  // Core CRUD — every provider implements these.
  listIssues(repo: RepoRef, opts: ListOptions): Promise<Page<Issue>>;
  listPRs(repo: RepoRef, opts: ListOptions): Promise<Page<PR>>;
  getIssue(repo: RepoRef, number: number, options?: FetchOptions): Promise<Issue | null>;
  getPR(repo: RepoRef, number: number, options?: FetchOptions): Promise<PR | null>;
  findPRByBranch(repo: RepoRef, branchName: string): Promise<PR | null>;
  /**
   * Optional batch variant of {@link findPRByBranch}. When present, callers
   * resolving PRs for many branches in a single sweep (e.g. the worktree
   * dashboard's PR-detection poll) should prefer this over N per-branch calls
   * so the provider can amortize the round-trip. The returned `Map` is keyed
   * by branch name; absent or `null` values mean no PR was found for that
   * branch. Branches the implementation could not resolve (transient errors
   * within a chunk) may be omitted; callers should treat omissions as the
   * fallback path's responsibility.
   */
  findPRsByBranches?(repo: RepoRef, branches: string[]): Promise<Map<string, PR | null>>;
  getCIStatus(repo: RepoRef, prNumber: number, options?: FetchOptions): Promise<CIStatus | null>;
  getRepoMetadata(repo: RepoRef, options?: FetchOptions): Promise<RepoMetadata>;

  // URL builders — the provider knows its own URL shape.
  buildIssueUrl(repo: RepoRef, number: number): string;
  buildPRUrl(repo: RepoRef, number: number): string;
  buildIssuesUrl(repo: RepoRef, options?: { query?: string; state?: string }): string;
  buildPRsUrl(repo: RepoRef, options?: { query?: string; state?: string }): string;
  buildCommitsUrl(repo: RepoRef, branch?: string): string;
  /**
   * Optional. Build a deep-link to a specific file's entry on a PR's
   * "Files changed" view. The provider knows its own anchor algorithm
   * (GitHub hashes the path bytes; GitLab uses a different hash + prefix;
   * Bitbucket uses a literal path) so the renderer never reconstructs a
   * provider-shaped URL. The renderer consumes the result via
   * {@link FileDecoration.url}; this method exists for the provider-side
   * decoration hook to call. The `path` is the raw, repository-relative
   * path as the provider's review-thread data returns it — do not
   * URL-encode, the provider decides whether to hash the raw bytes or the
   * encoded form. Returns nothing (omit the field) when the provider
   * doesn't support PR-file deep-links.
   */
  buildPRFileUrl?(repo: RepoRef, number: number, path: string): string;

  // Mutations — providers that don't support a mutation throw "Not supported".
  /**
   * Create a new issue and return the normalized {@link Issue}. Providers that
   * can't create issues throw `"Not supported"`, matching the assignment
   * convention. The host clears its issue caches after a successful create so
   * the new issue shows up in subsequent {@link listIssues} calls.
   */
  createIssue(repo: RepoRef, input: CreateIssueInput): Promise<Issue>;
  assignIssue(repo: RepoRef, issueNumber: number, username: string): Promise<void>;
  unassignIssue(repo: RepoRef, issueNumber: number, username: string): Promise<void>;
  /**
   * Validate a single freshly-entered credential value at save time. The host
   * passes exactly one string — the primary of the provider's declared
   * {@link ForgeProviderContribution.credentialFields} (see that field for the
   * primary-selection rule), never the full multi-field record. This signature
   * is frozen at 1.0: a provider needing more than one value to authenticate
   * (e.g. self-hosted forge wanting base URL + token) reads its other fields
   * from its own settings (`settingsScopeRef`) and validates the assembled
   * credential through {@link validateCredentials} instead, which runs against
   * the provider's stored state rather than a host-supplied argument.
   */
  validateToken(token: string): Promise<AuthValidation>;

  // Host-visible rate-limit state, parsed from the provider's own transport.
  getRateLimit?(): Promise<RateLimitInfo>;

  // Optional provider-owned cache invalidation used by explicit user refreshes.
  clearPullRequestCaches?(): void | Promise<void>;

  /**
   * Optional. Capture a cheap, opaque freshness token for the repo's overall
   * activity, so a caller can skip an expensive list/stats refresh when nothing
   * has changed since the last probe. The token is opaque to the host — a
   * GraphQL provider packs an activity timestamp tuple (e.g. repo `pushedAt`
   * plus the newest issue/PR `updatedAt`), a REST provider packs an ETag — and
   * the host only byte-compares two tokens for equality.
   *
   * This is a cost optimization, not a correctness guarantee: a timestamp-tuple
   * probe misses mutations that don't bump those fields (emoji reactions,
   * Project v2 metadata, repo settings, wiki/discussion edits). Callers should
   * pair it with a bounded TTL so list content can't go stale indefinitely
   * behind a continuously-matching probe.
   *
   * May reject when the probe is unavailable (auth/network failure, the
   * provider can't compute a token). Since the optimization is best-effort,
   * callers must catch and fall back to a full fetch rather than surfacing the
   * error.
   */
  getRepoActivityProbe?(repo: RepoRef): Promise<{ freshnessToken: string }>;

  /**
   * Optional. Classify a `git push` failure from raw stderr. Lets the host
   * surface a provider-stable error code in the push-error banner without
   * hardcoding any one forge's error format. Return `null` when the stderr
   * doesn't match a recognized failure; the banner then falls back to a
   * generic "push failed" state with the raw stderr. Must never throw —
   * classification failures are non-fatal to the banner.
   */
  classifyPushError?(stderr: string): PushErrorClassification | null;

  // Optional capabilities — host checks presence via a truthiness guard (see above).
  reviews?: ReviewCapability;
  approvals?: ApprovalCapability;
  releases?: ReleaseCapability;
  projectBoards?: ProjectBoardCapability;
  milestones?: MilestoneCapability;
  batchLookups?: BatchLookupCapability;
  identity?: IdentityCapability;
  tooltips?: TooltipCapability;
  repoStats?: RepoStatsCapability;
  projectHealth?: ProjectHealthCapability;
  avatars?: AvatarCapability;
  healthEvents?: HealthEventsCapability;
  clone?: CloneCapability;
}

/**
 * Suggested capability vocabulary surfaced in the manifest's `capabilities`
 * array. Frozen at 1.0 as informational only: the host never interprets these
 * strings and no behavior — feature gating, privilege, routing — is ever
 * derived from them. They drive the Preferences "supports: …" display and
 * nothing else. Every actual capability gates on whether the matching
 * {@link ForgeProviderImpl} field is present at runtime (e.g. `impl.reviews`),
 * so a declared-but-unimplemented hint can never enable a feature, and an
 * implemented-but-undeclared one still works. Do not add runtime checks that
 * cross-reference these strings against the impl. The open union preserves
 * autocomplete while allowing provider-defined strings.
 */
export type ForgeCapabilityHint =
  | "issues"
  | "pulls"
  | "reviews"
  | "approvals"
  | "merge-trains"
  | "required-checks"
  | "draft-prs"
  | "assignees"
  | "releases"
  | "project-boards"
  | "milestones"
  | "batch-branch-prs"
  | "identity"
  | "pr-files"
  | "clone"
  | (string & {});

/**
 * Input type for a declared credential field. The open union keeps the two
 * built-in types autocompleting while letting a provider name a custom
 * renderer hint without failing TypeScript (precedent: PR #4489). The host
 * only distinguishes `"password"` (masked input) from everything else (plain
 * text); unknown values fall back to text.
 */
export type CredentialFieldType = "password" | "text" | (string & {});

/**
 * One credential input a forge provider declares in its manifest so the host
 * can render a real settings form for it instead of a "no configuration"
 * stub. A provider may declare several fields for the form, but the contract
 * (frozen at 1.0) passes only the PRIMARY field's value to
 * {@link ForgeProviderImpl.validateToken} and `setCredentials` — the primary
 * being the first `"password"`-typed field, or the first field when none is
 * `"password"`. Every entered value is persisted in the credential record, but
 * the host never inspects any of them beyond the primary; storage stays
 * opaque. Providers needing more than the primary at auth time read the rest
 * from their own settings and use {@link ForgeProviderImpl.validateCredentials}.
 */
export interface CredentialField {
  /** Stable key the entered value is stored under in the credential record. */
  id: string;
  /** Field label shown in Preferences → Code Forge. */
  label: string;
  /** Renderer hint; `"password"` masks input, anything else renders text. */
  type: CredentialFieldType;
  placeholder?: string;
  /** Optional one-line hint rendered under the input. */
  helpText?: string;
}

/**
 * Registered forge provider — pairs a manifest contribution with its owning
 * pluginId. Returned by the host registry's listing functions and exposed to
 * the renderer via `window.electron.plugin.getForgeProviders()`.
 */
export interface RegisteredForgeProvider {
  pluginId: string;
  contribution: ForgeProviderContribution;
}

/**
 * Whether a forge provider reaches a remote forge over the network or serves a
 * local/offline data source. Display-only signal; see
 * {@link ForgeProviderContribution.kind}.
 */
export type ForgeProviderKind = "local" | "network";

/**
 * `forgeProviders` manifest entry. Eager (manifest-driven) registration
 * populates the Preferences UI and remote-routing table before any plugin
 * code runs; the implementation handler binds lazily on first use.
 */
export interface ForgeProviderContribution {
  /** Namespaced at runtime as `{pluginId}.{id}`; the built-in GitHub plugin uses bare `github`. */
  id: string;
  /** Display label in Preferences → Forge Integrations. */
  name: string;
  /**
   * Whether the provider talks to a remote forge over the network (`"network"`,
   * the default when omitted) or serves a local/offline data source backed by
   * files or a CLI (`"local"`). Display-only and frozen at 1.0: the host never
   * gates auth or routing on it — a `"local"` provider still owns its auth
   * methods (use {@link localAuthStubs} to satisfy them). Preferences uses it
   * only to label a provider that declares no {@link credentialFields} as
   * deliberately authless rather than unconfigured.
   */
  kind?: ForgeProviderKind;
  /**
   * Exact hostnames for git remote URLs; first matching provider wins.
   *
   * Matching is case-insensitive and strips a leading `www.` from both the
   * remote URL hostname and each pattern. Glob, wildcard, suffix, and
   * regular-expression patterns are not supported — list every distinct
   * hostname your forge serves as a separate entry.
   */
  matches: string[];
  /**
   * Informational capability hints; the host never interprets these and no
   * behavior is derived from them (display only). See {@link ForgeCapabilityHint}.
   */
  capabilities?: ForgeCapabilityHint[];
  /**
   * Credential inputs the host renders a real settings form from. Absent or
   * empty means the provider needs no host-side credential entry (the host
   * shows "No configuration needed"). The first `"password"`-typed field —
   * or the first field when none is `"password"` — is the primary credential,
   * the single value passed to {@link ForgeProviderImpl.validateToken} and
   * `setCredentials`. See {@link CredentialField} for the full single-primary
   * contract and the multi-field auth path.
   */
  credentialFields?: CredentialField[];
  /** ID prefix in this plugin's `settings` contributions, used to group provider settings. */
  settingsScopeRef?: string;
  /** IDs of `views` contributions shown under this provider's panel section. */
  viewRefs?: string[];
  /**
   * Named renderer view-slot refs for provider-owned UI. Each value is a
   * builtin-view id the plugin's renderer registers via
   * `registerBuiltinView`; the host resolves the ACTIVE provider's ref for
   * each seam instead of hardcoding any one plugin's view ids. All optional.
   *
   * Slot refs are validated for FORMAT only (non-empty string) at manifest
   * parse time — the host cannot check a ref against the renderer's view
   * registry from the main process, and a ref legitimately resolves to nothing
   * while its plugin is disabled. Resolving an unregistered or disabled ref to
   * a neutral fallback (or a hidden seam) is the defined 1.0 behavior, not an
   * error. In dev builds the renderer logs a one-line warning when a non-empty
   * ref was never registered at all, to flag plugin-author typos.
   */
  slots?: ForgeProviderSlots;
}

/** Named view-slot refs a forge provider can fill. See {@link ForgeProviderContribution.slots}. */
export interface ForgeProviderSlots {
  /** Provider settings panel (Settings → Code forge). */
  settingsTab?: string;
  /** Brand icon component rendered beside the provider's name. */
  icon?: string;
  /** Content of the toolbar stats dropdown (issues / PRs / commits lists). */
  statsDropdown?: string;
  /** Bulk create-worktrees-from-issues dialog. */
  bulkCreateWorktreeDialog?: string;
  /** Issue-selector view used by worktree attach/create flows. */
  issueSelector?: string;
}

/**
 * Passed to `host.registerForgeProvider` alongside the implementation. Mirrors
 * the manifest entry; the plugin can omit fields already declared statically
 * in `plugin.json`, so only `id` is required here.
 */
export interface ForgeProviderDescriptor {
  id: string;
  name?: string;
  matches?: string[];
  /** See {@link ForgeProviderContribution.kind}. */
  kind?: ForgeProviderKind;
  capabilities?: ForgeCapabilityHint[];
  settingsScopeRef?: string;
  viewRefs?: string[];
  slots?: ForgeProviderSlots;
}

/**
 * Registry-surface shape for a `forgeProviders` contribution, paired with the
 * `pluginId` that registered it. Used by the host registry and surfaced over
 * IPC to the renderer so Preferences can list installed providers.
 */
export interface ForgeProviderEntry {
  pluginId: string;
  contribution: ForgeProviderContribution;
}

/**
 * Which precedence rule fired during a `resolveForgeProvider` call.
 *
 *   - `"override"` — per-project `forgeProviderOverride` named a registered provider.
 *   - `"default"`  — global default (`forgeDefaultProviderId`) matched one of
 *                    the project's remote candidates.
 *   - `"hostname"` — first hostname match for the project's remote URL.
 *
 * `null` lives on the wrapper alongside `entry: null` when no rule resolved.
 */
export type ForgeProviderResolutionVia = "override" | "default" | "hostname";

/**
 * Resolver output: the chosen provider entry plus the precedence rule that
 * picked it. The renderer renders an explanatory tooltip from `resolvedVia`
 * without re-implementing the precedence chain. When `entry === null`,
 * `resolvedVia === null` — no rule fired.
 */
export interface ResolvedForgeProvider {
  entry: ForgeProviderEntry | null;
  resolvedVia: ForgeProviderResolutionVia | null;
}

/**
 * Per-file decoration a plugin attaches to a path within a named scope.
 * Modelled on VS Code's `FileDecoration`. The host renders this opaquely —
 * it never inspects what the decoration represents (review threads, lint
 * errors, sync state, …); that meaning is entirely the plugin's.
 *
 * `color` is a raw string passed straight to `className` on the renderer
 * side, matching the existing plugin-contributed color convention
 * ({@link ForgeProviderContribution} has no color, but `PanelContribution`
 * and `ToolbarButtonContribution` already pass raw color/token strings).
 * Plugins are responsible for using a valid design-system semantic token.
 */
export interface FileDecoration {
  /** Short badge text — keep to ≤2 visible chars per the VS Code convention. */
  badge?: string;
  /** Hover tooltip describing what the decoration means. */
  tooltip?: string;
  /** Opaque color token/class passed through to `className` by the host. */
  color?: string;
  /**
   * Optional provider-authored deep-link for a clickable decoration. The host
   * opens this through `systemClient.openExternal` when present; the
   * decoration renders as non-interactive when absent. Built by the
   * decoration provider via the active forge's `buildPRFileUrl` (or a
   * provider-specific equivalent) — the host never reconstructs a
   * provider-shaped URL from a base PR URL.
   */
  url?: string;
}

/**
 * Runtime contract a plugin implements and binds via
 * `host.registerFileDecorationProvider`. The host invokes
 * {@link provideDecorations} on demand (renderer pull) and never caches the
 * result — invalidation is signalled separately via
 * `host.invalidateFileDecorations`.
 *
 * `scope` is a runtime string (e.g. `worktree-diff:/abs/worktree/path`); the
 * provider decides how to interpret it. `paths` is the set of file paths the
 * caller currently cares about — the provider should return a map containing
 * only the paths it has a decoration for (omitted paths render undecorated).
 */
export interface FileDecorationProviderImpl {
  provideDecorations(scope: string, paths: string[]): Promise<Record<string, FileDecoration>>;
}

/**
 * `fileDecorationProviders` manifest entry. Eager (manifest-driven)
 * registration lets the host know which plugin owns which scopes before any
 * plugin code runs; the implementation handler binds lazily during
 * `activate()` via `host.registerFileDecorationProvider`.
 *
 * `scopes` are exact strings or `prefix:*` wildcards (e.g. `worktree-diff:*`)
 * — the host matches a runtime scope against these to decide which providers
 * to invoke. At least one scope pattern is required.
 */
export interface FileDecorationContribution {
  /** Namespaced at runtime as `{pluginId}.{id}`; must match the descriptor passed to `registerFileDecorationProvider`. */
  id: string;
  /** Exact scope strings or `prefix:*` wildcards this provider handles. */
  scopes: string[];
}

/**
 * Passed to `host.registerFileDecorationProvider` alongside the impl. Mirrors
 * the manifest entry; only `id` is required since `scopes` are already
 * declared statically in `plugin.json`.
 */
export interface FileDecorationProviderDescriptor {
  id: string;
  scopes?: string[];
}

/**
 * Registry-surface shape for a `fileDecorationProviders` contribution, paired
 * with the `pluginId` that registered it.
 */
export interface RegisteredFileDecorationProvider {
  pluginId: string;
  contribution: FileDecorationContribution;
}
