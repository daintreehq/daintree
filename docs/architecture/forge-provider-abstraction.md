# Forge Provider Abstraction

Daintree currently has GitHub hardwired across the IPC layer, services, components, stores, and actions. This document captures the decision to refactor that integration into a plugin-shaped abstraction.

**Scope of this stage:** ship the plugin contract for forge integrations, and rehome GitHub as the first plugin on top of it. No other providers ship in this work. The contract is _designed_ to admit future providers (GitLab, Gitea, Bitbucket, Forgejo) without re-shaping the host, but those plugins are explicitly later work.

The motivation is decoupling, not eviction: GitHub stays as a built-in plugin shipped with the app. The load-bearing test that the contract is honest is that GitHub fits through it cleanly.

## What This Abstracts

The integration we're refactoring is **not git itself**. Local git operations (clone, branch, status, diff, commit) run through `simple-git` and `node-pty` and are not affected by this work — that base layer is shared across every forge.

What we're abstracting is the **forge** layer that sits on top of git: the developer-platform tier providers expose over HTTP APIs. "Forge" is the established term of art (Gitea, Forgejo, SourceHut all self-identify as forges; ForgeFed is the cross-forge federation spec). The forge layer covers, at minimum:

- Issues and their metadata (assignees, labels, comments, milestones, linked PRs)
- Pull requests / merge requests and their metadata (state, draft flag, base/head refs, mergeability)
- Review threads, line comments, approval state, suggested edits
- CI / checks roll-up and required-checks gating
- Repository metadata (default branch, license, topics, fork status, archived)
- Releases, tags, and changelog surface
- Labels, milestones, project boards (capability-gated — not all forges have these)
- Webhooks and rate-limit reporting (host-visible state, not configuration)
- Authentication (tokens, OAuth, SSO, scopes, expiry)
- Branch → PR linkage queries

What the **host** abstracts inside this layer is deliberately _minimal_. Mainstream IDEs (VS Code, JetBrains, Zed, Theia) have all converged on the same pattern: per-provider plugins consume shared **UI** primitives but not a shared **data** abstraction. Trying to unify code-review semantics collapses into a lowest-common-denominator surface that can't represent provider-exclusive features and decays whenever any provider ships a new one. Daintree follows the same pattern: a thin shared interface for what genuinely converges, plus a capability mechanism and a raw-data escape hatch for everything else.

## What Is Shared and What Is Not

| Concern | Shared by host | Owned by plugin |
| --- | --- | --- |
| PR / issue listing (paginated, basic filter) | ✓ thin interface | implementation |
| Branch → PR linkage detection | ✓ thin interface | per-provider query |
| CI status roll-up (boolean-ish summary) | ✓ thin interface | per-provider parse |
| Auth (token storage, refresh, SSO, scopes) | — | ✓ fully opaque |
| Review threads, approvals, merge trains | — | ✓ capability sub-interface |
| Releases, tags, project boards, milestones | — | ✓ capability sub-interface |
| Provider-specific UI panels | — | ✓ ships own React views |
| State enum normalization | partial — see below | preserves `rawState` |
| Rate-limit reporting | uniform shape | parses per-provider transport |

The host does NOT abstract: review thread shape, approval workflows, CI graphs, merge strategies, label semantics, security alerts, or anything provider-exclusive. Plugins surface those via `views`-contributed panels rendering their own React components.

## Contribution Point: `forgeProviders`

Added to `plugin.json`'s `contributes` field. Status: **Planned**, ships in this stage.

```json
{
  "contributes": {
    "forgeProviders": [
      {
        "id": "github",
        "name": "GitHub",
        "matches": ["github.com"],
        "capabilities": ["issues", "pulls", "reviews", "required-checks", "releases"],
        "settingsScopeRef": "github",
        "viewRefs": ["github-issues", "github-prs"]
      }
    ]
  }
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Namespaced at runtime as `{pluginId}.{id}`. The built-in GitHub plugin uses bare `github`. |
| `name` | yes | Display label in Preferences → Forge Integrations. |
| `matches` | yes | Hostname or glob patterns for git remote URLs. The first registered provider whose pattern matches a project's remote wins. |
| `capabilities` | no | Free-form strings the host does not interpret. UI consumers query them to decide what affordances to surface. Suggested vocabulary: `issues`, `pulls`, `reviews`, `approvals`, `merge-trains`, `required-checks`, `draft-prs`, `assignees`, `releases`, `project-boards`, `milestones`. |
| `settingsScopeRef` | no | ID prefix in this plugin's `settings` contributions—used to group provider settings under one heading. |
| `viewRefs` | no | IDs of `views` contributions that should appear under this provider's panel section. |

Eager registration (manifest-driven) populates the Preferences UI and remote-routing table before any plugin code runs. The implementation handler is bound lazily on first use, matching the existing contribution-point lifecycle in `electron/services/PluginService.ts`.

## Host API: `registerForgeProvider`

Added to `PluginHostApi` in `@daintreehq/plugin-sdk`. Called from `activate(host)`.

```ts
interface PluginHostApi {
  registerForgeProvider(descriptor: ForgeProviderDescriptor, impl: ForgeProviderImpl): Disposable;
}
```

`descriptor` mirrors the manifest entry; the plugin can omit fields already declared statically. `impl` is the runtime contract:

```ts
interface ForgeProviderImpl {
  // Auth — fully owned by the plugin.
  getCredentials(): Promise<Credentials | null>;
  validateCredentials(): Promise<AuthValidation>;

  // Repository identity.
  parseRemote(url: string): RepoRef | null;

  // Core CRUD — every provider implements these.
  listIssues(repo: RepoRef, opts: ListOptions): Promise<Page<Issue>>;
  listPRs(repo: RepoRef, opts: ListOptions): Promise<Page<PR>>;
  getIssue(repo: RepoRef, number: number): Promise<Issue | null>;
  getPR(repo: RepoRef, number: number): Promise<PR | null>;
  findPRByBranch(repo: RepoRef, branchName: string): Promise<PR | null>;
  getCIStatus(repo: RepoRef, prNumber: number): Promise<CIStatus | null>;
  getRepoMetadata(repo: RepoRef): Promise<RepoMetadata>;

  // URL builders — provider knows its own URL shape.
  buildIssueUrl(repo: RepoRef, number: number): string;
  buildPRUrl(repo: RepoRef, number: number): string;

  // Optional capabilities — host checks via a truthiness guard at runtime
  // (`if (provider.reviews)`), not the `in` operator; see Capability discovery.
  reviews?: ReviewCapability;
  approvals?: ApprovalCapability;
  releases?: ReleaseCapability;
  projectBoards?: ProjectBoardCapability;
  milestones?: MilestoneCapability;
}

interface ReviewCapability {
  getReviewThreads(repo: RepoRef, prNumber: number): Promise<ReviewThread[]>;
}

interface ApprovalCapability {
  getApprovalState(repo: RepoRef, prNumber: number): Promise<ApprovalState>;
}

interface ReleaseCapability {
  listReleases(repo: RepoRef, opts: ListOptions): Promise<Page<Release>>;
  getLatestRelease(repo: RepoRef): Promise<Release | null>;
}
```

New capabilities are added as sibling optional fields. The base interface does not change when a new capability is introduced.

GitHub implements every base method and every capability listed above. Future providers will implement the base contract and whichever capabilities they actually support; the contract is designed to admit that variation without re-shaping the host. Validating against a second provider is later work — not part of this stage.

### `rawData` on Every Domain Object

Every returned shape (`Issue`, `PR`, `ReviewThread`, `Release`, etc.) carries `rawData: unknown` — the provider's untransformed response. Plugin-shipped views may consume it directly; the host never inspects it. This is the escape hatch that prevents the abstraction from blocking provider-specific UI.

`rawData` is meant for plugin views to consume their own data. If a host-side component or a first-party Daintree component finds itself reading `rawData`, the interface is wrong and the missing field should be promoted to the typed surface or a capability. Treat first-party `rawData` reads as an interface-review signal.

## State Normalization

Even though only GitHub ships in this stage, the interface normalizes states so future providers don't force a re-shape. PR state enums diverge across providers (GitHub `OPEN | CLOSED | MERGED`, GitLab `opened | closed | locked | merged`, Bitbucket `OPEN | MERGED | DECLINED | SUPERSEDED`, Gitea `open | closed`). The host's normalized enum is:

```ts
type NormalizedPRState = "open" | "merged" | "closed" | "declined";
```

Every `PR` returned by a provider carries both:

```ts
interface PR {
  state: NormalizedPRState;
  rawState: string; // verbatim provider value
  // ...
}
```

When a plugin needs to submit state back to the provider API, it uses `rawState`, not the normalized value. Issue states use the same pattern: normalized `"open" | "closed"`, `rawState` preserved.

## Auth Model

Auth is **fully opaque to the host**. The shared interface exposes only:

```ts
interface ForgeProviderImpl {
  getCredentials(): Promise<Credentials | null>;
  validateCredentials(): Promise<AuthValidation>;
}

interface Credentials {
  kind: "bearer" | "basic";
  value: string;
}
```

The plugin owns:

- Token storage (electron-store, OS keychain, or whatever the plugin chooses)
- Refresh logic
- SSO header parsing
- Scope validation
- 401 retry behavior
- Token expiry detection
- OAuth flows (the plugin may use `host.showToast` and an external browser via `shell.openExternal`)

Settings UI for auth is contributed by each plugin's own `settings` contribution. The host does not provide a "forge auth panel" — each provider's Preferences section is plugin-rendered.

## Branch → PR Linkage

`PRIntegrationService` (the worktree-PR linker) becomes provider-routed. The active provider for a worktree is determined by matching the worktree's remote URL against registered providers' `matches` patterns.

The shared interface delegates to each provider's native query. Client-side filtering across paged results is forbidden — GitHub uses GraphQL `pullRequests(headRefName: $branch)`, future GitLab plugins will use REST `/projects/:id/merge_requests?source_branch=`, etc.

Detection events become provider-aware:

```ts
interface ForgeLinkedEvent {
  worktreeId: string;
  providerId: string;
  issue?: ResourceRef;
  pr?: { ref: ResourceRef; state: NormalizedPRState; title: string; url: string };
}
```

This replaces today's GitHub-specific `PR_DETECTED` payload.

## Rate Limiting

Every provider reports rate-limit state in a uniform shape:

```ts
interface RateLimitInfo {
  limit: number | null; // null when provider does not report
  remaining: number | null;
  resetAt: number | null; // epoch ms
  secondaryThrottled?: boolean;
}
```

Plugins parse their own transport (GraphQL `rateLimit` node for GitHub) and populate this shape. The host renders the rate-limit indicator from this projection.

### Batching as the Quota-Reduction Strategy

GitHub's GraphQL endpoint does not support ETag conditional requests — that's a REST-only header — so providers cannot rely on `If-None-Match` to cheaply confirm "nothing changed." The primary lever for reducing per-poll quota burn is **batching**: collapsing N round-trips into one aliased query when the host has a list of identifiers to resolve.

The optional `findPRsByBranches(repo, branches): Map<string, PR | null>` capability on `ForgeProviderImpl` is the canonical example. `PullRequestService.checkForPRs` polls many worktree branches at once; with the capability present, the GitHub plugin issues one aliased `repository { pullRequests(headRefName: ...) }` block per branch in chunks (default 20) instead of one search query per branch. The host probes for the capability via a truthiness guard, calls it when present, and falls back to per-branch `findPRByBranch` when the batched call throws so a single transient chunk error doesn't blank every row's PR state.

Other forge providers can omit the capability — the host degrades gracefully — or implement it natively (GitLab's REST `/projects/:id/merge_requests?source_branch[]=...` accepts repeated query params for the same effect).

## Worktree Snapshot: Breaking Change

`PluginWorktreeSnapshot` in `shared/utils/pluginWorktreeSnapshot.ts` currently leaks GitHub-shaped fields (`issueNumber`, `issueTitle`, `prNumber`, `prUrl`, `prState`, `prTitle`). These get replaced with a provider-agnostic projection:

```ts
interface PluginWorktreeSnapshot {
  // ... existing identity fields ...
  linked: {
    providerId: string;
    issue?: { ref: ResourceRef; title?: string };
    pr?: { ref: ResourceRef; title?: string; url: string; state: NormalizedPRState };
  } | null;
}
```

This is an `@daintreehq/plugin-sdk` **breaking change** — major version bump. The plugin-snapshot allowlist (`shared/utils/pluginWorktreeSnapshot.ts`) is updated and the `engines.daintree` compatibility gate filters out plugins built against the old shape.

## GitHub as Built-In Plugin

The migration rehomes today's GitHub integration into a built-in plugin at `plugins/builtin/github/`:

- `electron/services/github/*` → `plugins/builtin/github/main/`
- `shared/types/github.ts` → `plugins/builtin/github/shared/types.ts`
- `src/components/GitHub/*` → `plugins/builtin/github/renderer/views/`
- `src/services/actions/definitions/githubActions.ts` → plugin-contributed commands
- `src/store/githubConfigStore.ts`, `githubFilterStore.ts`, `githubTokenHealthStore.ts` → plugin-internal state

Built-in plugins are bundled inside the Daintree app (no install step), but otherwise load through `PluginService` like any other plugin — same activation lifecycle, same disposal cascade, same capability disclosure. They are conceptually identical to third-party plugins; the only difference is location.

The built-in plugin loader is a new code path inside `PluginService` that scans an in-app directory before `~/.daintree/plugins/`. Built-ins cannot be uninstalled but can be disabled.

This rehoming is the load-bearing test that the contract is honest: if GitHub can't fit cleanly through the new contribution point and host API, the contract is wrong and we revise it before declaring the stage done.

## Action Namespace Migration

Host-owned actions become `forge.*` (the host dispatches to the active provider):

- `forge.openIssues`, `forge.openPRs`, `forge.openCommits`, `forge.openIssue`, `forge.assignIssue`
- `forge.validateToken` (per active provider)

The GitHub built-in plugin contributes `github.*` aliases that forward to the corresponding `forge.*` action for one release cycle so existing user-defined keybindings, recipes, and `actions.repeatLast` MRU entries keep working. The aliases are removed in the release after, with a CHANGELOG callout.

Even with only GitHub shipping, we land `forge.*` now so the action shape doesn't break a second time when the next provider arrives.

## Provider Selection and Settings UI

Preferences → Forge Integrations:

- Lists detected git remotes per active project
- Shows the matched provider for each remote (with only GitHub registered, that's "GitHub" or "No provider")
- Per-provider section rendered by the plugin's own `settings` contribution (auth, etc.)

Single-active-provider per project is the v1 design. Multi-tenancy (one project mirrored across multiple providers) is deferred and can be added later without changing the contribution point shape.

## Capability Discovery in Components

UI components consume capabilities via the discriminated optional fields, not free-form capability strings:

```ts
const provider = useActiveForgeProvider();
if (provider?.reviews) {
  // Render the review-threads panel — provider implements ReviewCapability
}
if (provider?.releases) {
  // Render the releases panel
}
```

The `capabilities` array in the manifest is _informational_ (used for the Preferences UI to display "GitHub supports: issues, pulls, reviews, required-checks, releases"). Behavior gates on whether the implementation field is present at runtime. This keeps the gate honest: a plugin can't claim a capability in the manifest and fail to implement it.

## Migration Plan

The refactor lands across multiple PRs in this order:

1. **Foundation types and manifest schema.** `shared/types/forge.ts` defining `ForgeProviderImpl`, `Issue`, `PR`, `Release`, `RepoRef`, etc. Manifest schema extension for `forgeProviders`. Zero behavior change.
2. **Host registry.** `electron/services/ForgeProviderRegistry.ts`. Tracks registered providers, exposes `getActiveProvider(repoRef)` for remote-URL routing.
3. **SDK host API.** `registerForgeProvider` added to `PluginHostApi`. Snapshot shape updated (breaking).
4. **Built-in plugin loader.** `PluginService` scans `plugins/builtin/` before user plugins. Built-ins skip the install-time capability dialog.
5. **GitHub built-in plugin: services.** Rehome `electron/services/github/*` into `plugins/builtin/github/main/`. Register via the new contribution point.
6. **GitHub built-in plugin: components.** Move `src/components/GitHub/*` and the three Zustand stores into the plugin's renderer entry.
7. **GitHub built-in plugin: actions.** Migrate `github.*` actions to host-owned `forge.*` with `github.*` aliases for one release.
8. **`PRIntegrationService` rewrite.** Replace direct GitHub calls with `ForgeProviderRegistry.getActiveProvider(...).findPRByBranch(...)`. Snapshot consumers updated to read `linked.*`.
9. **Settings UI.** Provider section in Preferences → Forge Integrations, rendering the GitHub plugin's auth UI.

Each step is a separate PR. The contract is allowed to evolve while GitHub is being migrated (steps 1–7); after step 7, the contract freezes and v1 of `@daintreehq/plugin-sdk` ships.

## Non-Goals (For This Stage)

- **Additional provider plugins.** GitLab, Gitea, Bitbucket, Forgejo all later work.
- **Multi-active providers per project.** v1 picks the first matching provider.
- **Git operations themselves.** Local git via `simple-git` and `node-pty` is unaffected. The forge layer sits on top of git; it doesn't replace git.
- **Federation / ForgeFed actor URLs.** Pattern matching is hostname-based; ActivityPub actor matching is not in scope.
- **A "forge auth" UI panel owned by the host.** Each plugin renders its own auth section.
- **A normalized review-thread shape.** Reviews diverge too much across providers. Plugins ship their own review-thread UI under a `ReviewCapability` interface that returns provider-shaped data.
- **MCP-as-forge-provider.** MCP servers can coexist alongside (a provider plugin can also ship an `mcpServers` contribution for agent use), but MCP is not the primary IDE data path.
- **Removing GitHub.** GitHub stays as a built-in plugin. The goal is decoupling, not eviction.

## Trade-offs

- **Plugin views run in-process with full Node privileges.** Future GitLab/Gitea plugins will ship React panels rendered inside Daintree's renderer. This matches Daintree's existing curated-trust model (see [plugins/architecture.md](../plugins/architecture.md)). Capability disclosure is the user-facing safeguard.
- **Built-in GitHub adds bundle weight.** The GitHub plugin ships with the app even for users who don't use GitHub. The alternative (lazy-loading the entire GitHub integration) costs first-paint latency for the common case. Tradeoff favors bundle weight.
- **Breaking SDK change is painful for early plugin authors.** The `PluginWorktreeSnapshot` field rename forces a recompile. Acceptable because the SDK is pre-1.0; communicate clearly in the CHANGELOG.
- **The contract is designed for providers we haven't built.** Capability shapes for releases, approvals, and merge-trains exist in the type system before any non-GitHub provider validates them. Some shapes may need adjustment when the second provider arrives. The alternative — design the contract minimally and expand later — risks a second breaking change on the next provider.

## Naming

This document uses "forge" rather than "VCS" / "version control" / "git host" / "code host" because the abstraction covers the whole developer-platform layer above git, not git itself. The term is established in the open-source ecosystem — Gitea, Forgejo, and SourceHut all self-identify as forges, and ForgeFed is the cross-forge federation specification. "VCS provider" would narrowly suggest source-control mechanics, which are handled separately and not in scope here.

## Related

- [`docs/plugins/contribution-points.md`](../plugins/contribution-points.md) — full contribution point reference (this doc adds the `forgeProviders` entry)
- [`docs/plugins/host-api.md`](../plugins/host-api.md) — host API reference (this doc adds `registerForgeProvider`)
- [`docs/plugins/architecture.md`](../plugins/architecture.md) — plugin lifecycle, disposal, renderer host model
- [`docs/architecture/action-system.md`](./action-system.md) — action dispatcher patterns (`forge.*` actions plug in here)
