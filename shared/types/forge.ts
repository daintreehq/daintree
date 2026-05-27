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
  state?: "open" | "closed" | "all";
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

  // Mutations — providers that don't support assignment throw "Not supported".
  assignIssue(repo: RepoRef, issueNumber: number, username: string): Promise<void>;
  unassignIssue(repo: RepoRef, issueNumber: number, username: string): Promise<void>;
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
}

/**
 * Suggested capability vocabulary surfaced in the manifest's `capabilities`
 * array. The host does not interpret these strings — they are informational,
 * driving the Preferences "supports: …" display only. Behavior gates on
 * whether the matching {@link ForgeProviderImpl} capability field is present
 * at runtime, which keeps the claim honest. The open union preserves
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
 * stub. The host never inspects the entered value beyond passing the primary
 * field to {@link ForgeProviderImpl.validateToken}; storage stays opaque.
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
   * Exact hostnames for git remote URLs; first matching provider wins.
   *
   * Matching is case-insensitive and strips a leading `www.` from both the
   * remote URL hostname and each pattern. Glob, wildcard, suffix, and
   * regular-expression patterns are not supported — list every distinct
   * hostname your forge serves as a separate entry.
   */
  matches: string[];
  /** Informational capability hints; the host does not interpret these. */
  capabilities?: ForgeCapabilityHint[];
  /**
   * Credential inputs the host renders a real settings form from. Absent or
   * empty means the provider needs no host-side credential entry (the host
   * shows "No configuration needed"). The first `"password"`-typed field —
   * or the first field when none is `"password"` — is the primary credential
   * passed to {@link ForgeProviderImpl.validateToken}.
   */
  credentialFields?: CredentialField[];
  /** ID prefix in this plugin's `settings` contributions, used to group provider settings. */
  settingsScopeRef?: string;
  /** IDs of `views` contributions shown under this provider's panel section. */
  viewRefs?: string[];
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
  capabilities?: ForgeCapabilityHint[];
  settingsScopeRef?: string;
  viewRefs?: string[];
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
