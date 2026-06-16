# Implementing a Forge Provider

This is the path from an empty plugin to a merged forge provider — GitLab, Gitea, Bitbucket, or anything else that sits on top of git. It assumes you've read [Forge provider abstraction](../architecture/forge-provider-abstraction.md), which covers _why_ the interface is shaped the way it is. This page covers _what to touch_.

The first-party GitHub plugin (`plugins/builtin/github/`) is the canonical worked example. Every pattern below points at the file that does it for real.

## Before you start

- Read the [architecture reference](../architecture/forge-provider-abstraction.md). It explains the thin-interface-plus-capabilities model, the `rawData` escape hatch, and the state-normalization rule. The rest of this page assumes that context.
- Skim `shared/types/forge.ts`. It is the source of truth for every signature — `ForgeProviderImpl`, the domain objects (`Issue`, `PR`, `RepoRef`, …), the capability sub-interfaces, and the manifest types. When the prose here and `forge.ts` disagree, `forge.ts` wins.
- Decide whether you're shipping a built-in (lands in `plugins/builtin/`, loaded by `PluginService`) or an external plugin (distributed as a `.dntr`). The runtime contract is identical; only the directory and distribution differ.

## Scaffold the plugin

External plugins start from the scaffolder — see [Getting started](./getting-started.md). A built-in lives under `plugins/builtin/{forge}/` and mirrors the GitHub layout:

```
plugins/builtin/gitea/
├── plugin.json
└── main/
    ├── index.ts          # activate() — registers the provider
    ├── forgeProvider.ts  # the ForgeProviderImpl object
    ├── GiteaAuth.ts       # token storage, client construction
    ├── GiteaQueries.ts    # transport (REST/GraphQL) calls
    └── __tests__/         # unit tests, mirroring github's
```

Keep transport, auth, and normalization in their own modules. `forgeProvider.ts` should read as a thin adapter from your transport to the typed surface — the GitHub provider's `forgeProvider.ts` is ~1200 lines and almost entirely shape-mapping helpers.

## Builtin plugin wiring

A built-in plugin at `plugins/builtin/<name>/{plugin.json,main/index.ts,renderer/index.tsx}` is fully auto-discovered — adding one requires zero build-config edits. `scripts/build-main.mjs` discovers every `plugins/builtin/*/main/index.ts` as an esbuild entry and copies each `plugin.json` next to the compiled output; `src/registry/builtinPluginRenderers.ts` eagerly imports every `plugins/builtin/*/renderer/index.{ts,tsx}` via `import.meta.glob` so renderer view slots register before first render; `tsconfig.json` includes `plugins/builtin/*/renderer` for typechecking. The renderer entry is optional — main-only plugins simply have no `renderer/` directory.

Plugin renderer code must use only relative, `@/` (host `src/`), and `@shared` imports — there is no per-plugin path alias.

## Declare the manifest entry

Add a `forgeProviders` contribution to `plugin.json`. Daintree reads this eagerly at startup, before any plugin code runs, so the provider shows up in Preferences and the remote-routing table even if its `activate()` never fires.

```json
{
  "name": "daintree.gitea",
  "version": "0.1.0",
  "displayName": "Gitea",
  "description": "Gitea forge provider — issues, pull requests, CI status.",
  "main": "main/index.js",
  "engines": { "daintree": ">=0.11.0" },
  "contributes": {
    "forgeProviders": [
      {
        "id": "gitea",
        "name": "Gitea",
        "matches": ["gitea.io", "gitea.example.com"],
        "capabilities": ["issues", "pulls", "required-checks"]
      }
    ]
  }
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Namespaced at runtime as `{pluginId}.{id}`. The built-in GitHub plugin uses the bare `github`. Must match the `descriptor.id` you pass to `registerForgeProvider`. |
| `name` | yes | Display label in Preferences → Forge Integrations. |
| `matches` | yes | List of exact hostnames. The host extracts the hostname from the project's git remote (HTTPS, SSH, and SCP-form `git@host:owner/repo.git` URLs all handled), lowercases and trims it, then matches it for **exact string equality** against each entry. Matching is case-insensitive and strips a leading `www.` from both the remote hostname and each pattern before comparing — but there is still no glob, wildcard, or suffix matching. List every distinct hostname your forge serves (e.g. a self-hosted instance and its CI mirror) as separate entries. First matching provider wins. |
| `capabilities` | no | Informational hints driving the Preferences "supports: …" display only. The host does **not** gate behavior on this array — see [Add optional capabilities](#add-optional-capabilities). |
| `settingsScopeRef` | no | ID prefix in this plugin's `settings` contributions, used to group provider settings. |
| `viewRefs` | no | IDs of `views` contributions shown under this provider's panel section. |

The `forgeProviders` contribution point is also documented in [Contribution points](./contribution-points.md#forge-providers).

## Register in activate()

`activate()` binds the implementation to the manifest descriptor. This must happen during activation — the host is revoked once `activate()` resolves.

```ts
// main/index.ts
import type { PluginHostApi } from "../../../../shared/types/plugin.js";
import { giteaForgeProvider } from "./forgeProvider.js";

export function activate(host: PluginHostApi): () => void {
  return host.registerForgeProvider({ id: "gitea" }, giteaForgeProvider);
}
```

Return the disposer `registerForgeProvider` hands back. `descriptor.id` must match a `contributes.forgeProviders[].id` in `plugin.json` — an undeclared id is rejected so the impl can't drift away from the manifest's routing table. The descriptor mirrors the manifest entry; you can omit anything already declared statically, so `{ id }` alone is enough. All bindings are removed automatically on plugin unload. See [Host API → `registerForgeProvider`](./host-api.md#registerforgeprovider).

## Implement ForgeProviderImpl

`forgeProvider.ts` exports one object satisfying `ForgeProviderImpl`. Every provider implements the base methods; capabilities are optional sibling fields (next section). Signatures live in `shared/types/forge.ts` — this table is the map, not a substitute for reading them.

| Method | Returns | Key behavior |
| --- | --- | --- |
| `getCredentials()` | `Promise<Credentials \| null>` | `null` when no token is stored. The host passes credentials through without inspecting them. |
| `setCredentials?(creds)` | `void` | Optional. Accept an in-memory credential override; ignore kinds your forge doesn't support. |
| `validateCredentials()` | `Promise<AuthValidation>` | Validate the stored token against the provider. Return `{ valid, scopes?, expiresAt?, error? }`. |
| `parseRemote(url)` | `RepoRef \| null` | Return `null` for URLs that aren't yours — the registry only dispatches to you after a hostname match, but defensive `null` keeps you composable. |
| `listIssues(repo, opts)` | `Promise<Page<Issue>>` | Page through the provider's native query. No client-side filtering across pages — push filters into `ListOptions`. |
| `listPRs(repo, opts)` | `Promise<Page<PR>>` | Same paging contract as `listIssues`. |
| `getIssue(repo, n)` | `Promise<Issue \| null>` | `null` when the issue doesn't exist. |
| `getPR(repo, n)` | `Promise<PR \| null>` | `null` when the PR doesn't exist. |
| `findPRByBranch(repo, branch)` | `Promise<PR \| null>` | Resolve the open PR for a head branch. Escape branch names before interpolating into a search query. |
| `getCIStatus(repo, prN)` | `Promise<CIStatus \| null>` | Roll checks up to one `CIStatusState`. The host renders a summary; it does not graph individual checks. |
| `getRepoMetadata(repo)` | `Promise<RepoMetadata>` | Default branch, visibility, fork/archive flags, license, topics. |
| `buildIssueUrl(repo, n)` | `string` | You own your URL shape. |
| `buildPRUrl(repo, n)` | `string` | — |
| `buildIssuesUrl(repo, opts?)` | `string` | Optional `{ query, state }` filter. |
| `buildPRsUrl(repo, opts?)` | `string` | — |
| `buildCommitsUrl(repo, branch?)` | `string` | — |
| `assignIssue(repo, n, user)` | `Promise<void>` | Throw `"Not supported"` if your forge can't assign. |
| `unassignIssue(repo, n, user)` | `Promise<void>` | Base method, paired with `assignIssue`. Throw `"Not supported"` if your forge can't unassign. |
| `validateToken(token)` | `Promise<AuthValidation>` | Validate an arbitrary token (used by the token-entry UI before storing it). |
| `getRateLimit?()` | `Promise<RateLimitInfo>` | Optional. Project your transport's rate-limit signal into the uniform shape. `null` per dimension the provider doesn't report. |

Beyond the base surface, `forge.ts` declares several optional performance/resilience hooks worth opting into: `findPRsByBranches?` (batch variant of `findPRByBranch` for many-branch sweeps), `clearPullRequestCaches?` (provider-owned cache invalidation on explicit refresh), `getRepoActivityProbe?` (cheap freshness token to skip expensive list refreshes), and `classifyPushError?` (map raw `git push` stderr to a provider-stable error code). Read `shared/types/forge.ts` for their full contracts.

The shape-mapping is the bulk of the work. Mirror the GitHub provider's `toForgeIssue` / `toForgePR` helpers (`plugins/builtin/github/main/forgeProvider.ts`): one pure function per domain object, defensively reading untyped transport nodes and producing the typed shape.

## Normalize state, preserve rawState

Provider state enums diverge — GitHub `OPEN|CLOSED|MERGED`, GitLab `opened|closed|locked|merged`, Bitbucket `OPEN|MERGED|DECLINED|SUPERSEDED`, Gitea `open|closed`. The host renders against the normalized set (`NormalizedPRState`, `NormalizedIssueState`); every `Issue` and `PR` carries **both** the normalized `state` and the verbatim provider value in `rawState`.

```ts
function normalizePRState(rawState: string, merged: boolean): NormalizedPRState {
  if (merged) return "merged";
  const upper = rawState.toUpperCase();
  if (upper === "CLOSED") return "closed";
  if (upper === "MERGED") return "merged";
  return "open";
}
```

This example is GitHub's; it only ever produces `open|closed|merged`. `NormalizedPRState` also includes `"declined"` for providers that reject PRs without merging — Bitbucket's `DECLINED` (and `SUPERSEDED`). If your forge has such a state, map it explicitly instead of letting it fall through to the `return "open"` default:

```ts
if (upper === "DECLINED" || upper === "SUPERSEDED") return "declined";
```

When you submit state back to the provider's API, send `rawState`, never the normalized value — the normalized set is lossy by design.

## The rawData escape hatch

Every returned shape has a `rawData: unknown` field. Put the verbatim transport node there. Plugin-shipped views may read it to render provider-specific detail; the host never inspects it.

A first-party read of `rawData` is an interface-review signal — it means a field is missing from the typed surface and should be promoted there (or behind a capability), not papered over by reaching into `rawData`. Treat that as feedback on the interface, not a workaround.

## Add optional capabilities

Anything that doesn't converge across forges is a capability — a sibling field on the impl, present only when supported:

```ts
const reviewCapability: ReviewCapability = {
  getReviewThreads: getReviewThreadsImpl,
};

export const giteaForgeProvider: ForgeProviderImpl = {
  // …base methods…
  reviews: reviewCapability, // omit the field entirely if unsupported
};
```

The capability sub-interfaces are `ReviewCapability`, `ApprovalCapability`, `ReleaseCapability`, `ProjectBoardCapability`, `MilestoneCapability`, and `BatchLookupCapability`. Omitting the field is how you declare non-support — the base interface never changes when a capability is added.

**Probe with truthiness, not `in`.** The host checks capability presence with `if (provider.reviews)`, not `"reviews" in provider`. An optional property explicitly set to `undefined` still satisfies the `in` operator, so `in` would falsely report the capability as available. Do the same in any code that consumes a provider.

The manifest's `capabilities` array is informational only — it drives the Preferences "supports: …" label. Actual behavior gates on whether the capability field is present at runtime, which keeps the displayed claim honest even if the manifest is stale.

## Local / offline providers

Not every provider talks to a network forge. A provider backed by on-disk files or a local CLI has no token to store and no remote to authenticate against — the auth surface (`getCredentials` / `validateCredentials` / `validateToken`) is dead weight you still have to satisfy. Two pieces make that ergonomic:

- **`kind: "local"` on the manifest contribution.** A display-only signal — the host never gates auth or routing on it. Preferences uses it to label the provider "No configuration needed" rather than showing it as unconfigured. (`kind` defaults to `"network"`; it is frozen at 1.0 and otherwise inert.)
- **`localAuthStubs` from `@daintreehq/plugin-sdk`.** Spread it into your impl to satisfy the three auth methods with no-ops: `getCredentials → null`, `validateCredentials → { valid: true }`, `validateToken → { valid: true }`.

```ts
import { localAuthStubs } from "@daintreehq/plugin-sdk";

export const localNotesProvider: ForgeProviderImpl = {
  ...localAuthStubs, // getCredentials / validateCredentials / validateToken
  parseRemote,
  listIssues,
  // …the rest of the base surface…
};
```

A local provider typically reads the project on disk rather than a remote. Use `repo.projectPath` for that: the host injects it as the absolute path to the project root (the main worktree) when it resolves a ref for a concrete project. It is optional — absent on synthetic refs the host builds without a project — so read it defensively (`if (repo.projectPath) …`). A network provider simply ignores the field.

## Expose the provider's CLI to the assistant

The Daintree Assistant runs forge CLIs inside an allowlist at `help/.claude/settings.json`. The `allow` list already grants `Bash(gh *)`, `Bash(glab *)` (GitLab), and `Bash(tea *)` (Gitea); the `deny` list blocks the destructive create/merge mutations for each (e.g. `Bash(glab mr create*)`, `Bash(glab mr merge*)`, `Bash(tea pulls merge*)`).

When you add a provider whose CLI the assistant should be able to drive, add it directly: an `allow` entry for the CLI binary (`Bash(bb *)` for Bitbucket, etc.) plus the corresponding `deny` entries for that CLI's issue/PR create and merge commands. Bitbucket's `bb` is still to be added by a future provider.

## Tests to ship

Mirror the GitHub provider's `__tests__/` coverage. A new provider ships unit tests for:

- **`parseRemote`** — HTTPS, SSH, and SCP-form URLs resolve; a hostname that isn't yours returns `null`.
- **State normalization** — every provider state value maps to the right `Normalized*` value, and `rawState` round-trips verbatim.
- **Core CRUD** — `listIssues`, `listPRs`, `getIssue`, `getPR`, `findPRByBranch`, `getCIStatus`, `getRepoMetadata` against a mocked transport, including empty pages and not-found.
- **`getRateLimit`** — if you implement it, the provider's rate-limit transport projects into `RateLimitInfo` correctly, including the `null`-per-dimension case.
- **`validateCredentials` / `validateToken`** — valid, expired, and missing-token paths.

External plugins use `@daintreehq/plugin-testing` (`createMockHost`) — see [Development loop → Testing](./dev-loop.md#testing). Built-ins follow the existing `plugins/builtin/github/main/__tests__/` patterns and run in the main test suite.

## Ship checklist

- [ ] `contributes.forgeProviders[]` entry in `plugin.json`, with `matches` listing every exact hostname your forge serves
- [ ] `activate()` returns `host.registerForgeProvider({ id }, impl)`
- [ ] All base `ForgeProviderImpl` methods implemented; unsupported mutations throw `"Not supported"`
- [ ] `state` normalized and `rawState` preserved on every `Issue`/`PR`
- [ ] Verbatim transport node in `rawData`; no first-party reads of it
- [ ] Optional capabilities present only when supported; consumers probe with truthiness
- [ ] CLI allow + create/merge deny entries added to `help/.claude/settings.json` if the assistant should drive your forge's CLI
- [ ] Unit tests mirroring the GitHub provider's coverage

## Related

- [Forge provider abstraction](../architecture/forge-provider-abstraction.md) — design rationale and the full interface narrative
- [Contribution points → Forge providers](./contribution-points.md#forge-providers) — manifest entry reference
- [Host API → `registerForgeProvider`](./host-api.md#registerforgeprovider) — registration signature and rules
- `shared/types/forge.ts` — the typed contract, source of truth
- `plugins/builtin/github/` — the canonical worked example
