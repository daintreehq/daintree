# Daintree MCP server (agent → IDE control surface)

## Purpose

Daintree ships its own local **MCP (Model Context Protocol) HTTP server** that lets an external agent — or Daintree's own in-app help assistant — drive the IDE programmatically. Every tool the server exposes is a [built-in action](./action-system.md): a `tools/call` request resolves to an `ActionService.dispatch(actionId, args)` in a renderer, and the dispatch result is serialized back as the tool result. The server is `daintree`'s control plane for agents; it is **inbound** — agents call _into_ the IDE.

Do not confuse this with the two outbound MCP concepts in the plugin docs:

| Concept | Direction | Owner | Docs |
| --- | --- | --- | --- |
| **Daintree MCP server** (this doc) | agent → IDE | `electron/services/McpServerService.ts` + `electron/services/mcp-server/` | here |
| Plugin-authored MCP servers | IDE → external MCP server | plugin process, supervised | [`docs/plugins/`](../plugins/) |
| Plugin-MCP supervisor | spawns/monitors plugin servers | host | [`docs/plugins/architecture.md`](../plugins/architecture.md) |

This server is **security-load-bearing**: it accepts network connections (loopback only) and turns them into privileged IDE mutations (commit, push, delete worktree, launch agents). The auth ladder, tier model, per-tool grants, rate limits, and abuse policy below are the gates that keep an agent from doing more than the user authorized. The subsystem lives in `electron/services/mcp-server/` plus the `McpServerService` orchestrator.

## Connecting an external client

Turn the server on in **Settings → MCP server**. The Connection section then shows the URL to connect to, a client picker, and a **Copy MCP config** button that copies the config in that client's own format. The config blocks below are what that button produces; the CLI commands are equivalents you can run instead. The settings tab is the source of truth for the live port and key, so prefer copying from it over transcribing these examples.

Always connect to `/mcp` (Streamable HTTP). The server also still answers `/sse`, but that transport was deprecated by the MCP spec in revision 2025-03-26, and client support for attaching the `Authorization` header to its separate POST leg is inconsistent (see the `McpPaneConfigService` comments for the client bugs we've hit). Config generation lives in [`shared/config/mcpClientConfigs.ts`](../../shared/config/mcpClientConfigs.ts), which derives the URL and the snippet together so a surface cannot advertise one endpoint while handing out another. Copying re-reads the server status first, so the snippet carries the current key even if it was rotated from another tab.

The port is whatever the server bound (default `45454`, incremented on collision) and the key is the one shown under **API key** in the same tab. Both appear in the examples below as `<port>` and `<api-key>`.

### Claude Code

Verified against Claude Code 2.1.220. Either run the CLI:

```bash
claude mcp add --transport http daintree "http://127.0.0.1:<port>/mcp" --header "Authorization: Bearer <api-key>"
```

That writes to the local (per-project) scope; add `--scope user` to make it available everywhere instead. Or paste the copied JSON into `.mcp.json` in your project, or `~/.claude.json` for a user-scoped server:

```json
{
  "mcpServers": {
    "daintree": {
      "type": "http",
      "url": "http://127.0.0.1:<port>/mcp",
      "headers": {
        "Authorization": "Bearer <api-key>"
      }
    }
  }
}
```

### Codex

Verified against Codex CLI 0.146.0. Paste the copied TOML into `~/.codex/config.toml`:

```toml
[mcp_servers.daintree]
url = "http://127.0.0.1:<port>/mcp"
http_headers = { Authorization = "Bearer <api-key>" }
```

`codex mcp get daintree` should report `transport: streamable_http` and an `http_headers` entry. Codex also accepts a `bearer_token_env_var` indirection instead, which keeps the key out of the config file at the cost of having to export the variable before every Codex launch and re-export it after each rotation:

```bash
export DAINTREE_MCP_TOKEN="<api-key>"
codex mcp add daintree --url "http://127.0.0.1:<port>/mcp" --bearer-token-env-var DAINTREE_MCP_TOKEN
```

### Any other client

Pick **Other client** in the picker for the transport-level details, which any Streamable HTTP client can be configured from by hand:

```text
Transport: Streamable HTTP
URL: http://127.0.0.1:<port>/mcp
Header: Authorization: Bearer <api-key>
```

Editors such as Cursor and VS Code read their own config files; their exact schemas aren't verified here, so use the values above rather than assuming the Claude Code JSON is portable to them.

### Scoping a client to one project

By default an external client's calls land in whichever Daintree window you focused last, which makes two agents driving two projects unsafe: focusing one retargets the other. **Copy config for this project** in the same tab emits the same config plus a `Daintree-Workspace-Id` header, and a client configured from it stays on that project no matter where focus goes — running in the background, without switching projects or stealing focus.

The plain **Copy MCP config** button is unchanged and still follows focus, so existing configs keep working exactly as before.

Two things to know about a scoped client: it connects whether or not the project is open, but its calls only run while that project is open in exactly one window (a closed or duplicated project fails each call with a message naming which, and the same call works once you fix it — no reconnect), and confirm-gated tools such as `recipe.run` are not part of its tool surface — nobody is watching a background project to approve the dialog, so those calls are refused up front rather than hanging until they time out. Run those from Daintree, or connect an unscoped client for them.

### Keeping a connection working

The copied config embeds the key verbatim, so treat any file holding it as a secret and keep it out of commits. Rotating the key (**Rotate API key** in the same tab) is the revoke-all primitive: it immediately invalidates every client still presenting the old key, and each one has to be re-pasted. Changing the configured port likewise invalidates the URL every client holds.

Connected clients show up under **External clients** in the Connection section. Entries are keyed by the hash of the bearer they present, so every client configured from this tab shares one entry — disconnecting it drops every session using that key, and does not stop a client from reconnecting with the same key. Rotate the key to lock one out for good.

Troubleshooting the failures worth naming:

- **401** — the `Authorization` header is missing, malformed, or carries a rotated-away key. Re-copy the config. A client that doesn't attach the header to `/sse` POSTs lands here too, which is one reason to stay on `/mcp`.
- **403** — the request never reached the auth gate: its `Host` didn't match the loopback address and port exactly, or it sent an `Origin` that isn't the loopback one. Relevant mainly if a proxy rewrites either header. A _missing_ `Origin` is fine and expected — non-browser MCP clients don't send one.
- **A tool call that returns an error rather than a failed request** — the tool is above the session's tier, or its per-tool grant hasn't been approved; the error carries `TIER_NOT_PERMITTED`. Note that a plain API-key session has no pinned renderer to prompt for a grant. See [Auth ladder](#auth-ladder-tierauthts--httplifecyclehandlerequest) and [Tier model](#tier-model-sharedts) below.

## File map

Roughly in dependency order rather than by size — per-file line counts are deliberately not listed, because they drift on every change to the subsystem and nothing in CI compares them against the real files.

| File | Role |
| --- | --- |
| `McpServerService.ts` (parent dir) | Top-level orchestrator. Owns `SessionStore`, `AuditService`, `TurnOutcomeService`, `HttpLifecycle`, `AbusePolicy`, renderer bridge; exposes IPC-facing methods (`setEnabled`, `rotateApiKey`, `setSessionTier`, `issueGrant`, `disconnectBearer`). Singleton `mcpServerService`. |
| `httpLifecycle.ts` | The HTTP server itself: bind/teardown, supervised restart, the `handleRequest` auth+routing gate, bearer register, session pinning, tier-elevation and grant IPC. |
| `sessionServer.ts` | Per-session MCP `Server` instance — `tools/list`, `tools/call`, resources, prompts. The `CallTool` handler is the end-to-end dispatch pipeline (tier → grant → rate-limit → dedup → confirm → dispatch → audit). |
| `shared.ts` | Tier model (`McpTier`, `TIER_ALLOWLISTS`), constants (TTLs, ports, timeouts, `RESOURCE_TEXT_MAX_BYTES`), error codes/envelopes, dedup + rate-limit config, resource URIs, prompt definitions. |
| `sessionStore.ts` | Per-session state: SSE + Streamable-HTTP session maps, tier map, idle timers, `GrantCache`, dedup caches, rate-limit buckets, WebContents/context pins. |
| `toolCallResult.ts` | The `tools/call` response budget — byte-capped text bodies, UTF-8-safe truncation, and the structured half re-derived from the bounded text. See [Payload and registry budgets](#payload-and-registry-budgets-11526-11585). |
| `auditLog.ts` | Ring-buffer audit log + anomaly signals (first-seen combos, latency drift, failure clusters, p95 z-score). Persisted to the `mcpServer` store key. |
| `turnOutcomeLog.ts` | Classifies each help-session assistant _turn_ (`answered`/`refused`/`tool-error`/…) by correlating FSM transitions with recent audit records. |
| `grantCache.ts` | Per-`(sessionId, toolId)` time-bounded "Approve once" grants — issue/check/refresh/revoke, sliding TTL + hard ceiling, denial-suppression counters. |
| `rendererBridge.ts` | IPC bridge to the renderer: requests the action manifest and dispatches actions, with per-session pinning (`SessionBindingError` when the pinned view is gone). |
| `tierAuth.ts` | Auth primitives: bearer extraction, timing-safe API-key compare, tier resolution, `shouldExposeTool`/`isTierPermitted`, tool schema/annotation builders, `requestKey` parsing. Re-exports `deriveBand`/`BAND_OVERRIDES`. |
| `readinessProbe.ts` | Active `initialize` round-trip probe (`/mcp` and `/sse`) proving the server actually answers, not just that the socket is bound. Used by `HelpSessionService` before launching the assistant. |
| `waitUntilIdle.ts` | The `terminal.waitUntilIdle` / `terminal.waitUntilIdleBatch` handshakes — bounded long-polls until an agent FSM leaves `working` (interactive sessions capped at 60s). Runs in main, not via renderer dispatch. |
| `projectCheck.ts` | Main-process short-circuit for `project.runCheck` — validates the runner against the project's detected set, spawns it, and projects the capped, secret-scrubbed result. |
| `skills.ts` | Main-process short-circuit for `skills.search` / `skills.load` against the skill registry. |
| `abusePolicy.ts` | Per-session sliding-window denial counter (401 + tier-mismatch). Trips → revoke session. |
| `sessionDedup.ts` | Idempotency keys + canonical args hashing for the creation-tool dedup cache. |
| `resourceOwnership.ts` | Which session created which terminal/worktree, written only from trusted post-dispatch results. Backs `terminal.closeOwned` / `worktree.deleteOwned`. See [Resource ownership](#resource-ownership-11909). |

Tier tool lists live in `shared/config/helpAssistantTierAllowlists.ts` so the renderer's blast-radius preview can read them without an IPC round-trip.

## Topology and process ownership

```
 external agent / help assistant
        │  HTTP (loopback only: 127.0.0.1 / localhost)
        ▼
 ┌─────────────────────────────── MAIN PROCESS ───────────────────────────────┐
 │  http.Server  ──►  HttpLifecycle.handleRequest                              │
 │                       │  host/origin guard → auth ladder → DNS-rebind guard │
 │                       ▼                                                      │
 │   /mcp (Streamable HTTP)   /sse + /messages (legacy SSE)                     │
 │                       │                                                      │
 │                       ▼  per session                                        │
 │   createSessionServer(sessionId)  ── MCP Server (SDK)                        │
 │     tools/list · tools/call · resources · prompts                           │
 │                       │                                                      │
 │   SessionStore: tier · grants · dedup · rate-limit · idle timer · pins      │
 │   AuditService · TurnOutcomeService · AbusePolicy                           │
 │                       │  rendererBridge (IPC)                               │
 └───────────────────────┼──────────────────────────────────────────────────-─┘
                         ▼
        renderer WebContents → ActionService.dispatch(actionId, args)
```

The HTTP server, `SessionStore`, and the audit/turn-outcome logs all live in **main**. Action _execution_ happens in a **renderer** `WebContents` reached through `rendererBridge`. There are two transports on one port: `/mcp` (Streamable HTTP, the modern path) and `/sse` + `POST /messages` (legacy SSE). Default port is `45454` (`DEFAULT_PORT`), with up to `MAX_PORT_RETRIES` (10) fallback ports on bind conflict.

## Auth ladder (`tierAuth.ts` + `httpLifecycle.handleRequest`)

Every request passes `isAuthorized(authHeader, apiKeyBearerHash, helpTokenValidator)`. The checks, in order:

1. **API-key bearer (timing-safe).** When an API key is configured, the server precomputes `sha256("Bearer <key>")` at startup (`precomputeApiKeyBearerHash`). Each request's raw `Authorization` header is hashed and compared with `crypto.timingSafeEqual` — a constant-time compare so an attacker can't recover the key byte-by-byte from response timing. A match grants the `external` tier.
2. **Empty-auth fallback (no key configured).** If `apiKeyBearerHash` is `null` _and_ the header is empty (`authHeader.length === 0`), the request is allowed at `external`. This is the "loopback-only, no key set" convenience path — it only matters because the server already refuses any non-loopback `Host`/`Origin` (see below), so the trust boundary is the OS network stack, not the bearer. The moment a key is set, this branch is dead.
3. **Per-pane token.** `mcpPaneConfigService.isValidPaneToken(token)` — tokens minted for a specific terminal pane. `getTierForToken` maps the pane token to `workbench`/`action`/`system`, so a pane gets exactly the surface its config grants, never `external`.
4. **Help-session token.** A `helpTokenValidator` (injected by `HelpSessionService`) validates tokens minted for the in-app assistant and returns its `HelpAssistantTier`. Help bearers are also **pinned** to the WebContents that minted them (`helpSessionWebContentsResolver`) and to the `ActionContext` captured at provision time (`helpSessionActionContextResolver`), so every tool call dispatches against the worktree/terminal the user had focused when they launched the assistant — not whatever is focused when the model's call lands.

A failed `isAuthorized` returns `401` with `WWW-Authenticate: Bearer realm="Daintree MCP"`, records `auth401` in the audit log, and feeds the session into the abuse policy.

**Network trust boundary.** Before auth, `handleRequest` rejects any request whose `Host` is not `127.0.0.1:<port>`/`localhost:<port>` (`403`), and rejects a mismatched `Origin` (`403`). The SSE and Streamable transports additionally enable `enableDnsRebindingProtection` with explicit allowlists. The server binds `127.0.0.1` only.

### Tier resolution

`resolveTokenTier` mirrors `isAuthorized` and returns the `McpTier` for the bearer: API-key/empty → `external`; pane token → its mapped tier; help token → its help tier; otherwise the `workbench` baseline.

## Tier model (`shared.ts`)

```ts
type McpTier = "workbench" | "action" | "system" | "external";
```

`TIER_ALLOWLISTS` is the static authorization floor — an O(1) `Set` per tier:

| Tier | Allowed surface |
| --- | --- |
| `workbench` | `WORKBENCH_TIER_TOOLS` — read-only / low-risk introspection (the help-assistant baseline). |
| `action` | workbench ∪ `ACTION_TIER_ADDONS` (includes `terminal.waitUntilIdle`). |
| `system` | workbench ∪ action ∪ `SYSTEM_TIER_ADDONS`. |
| `external` | `MCP_TOOL_ALLOWLIST` (the `Set` built from `MCP_EXTERNAL_TIER_TOOLS`) — a small, budgeted roster of orchestration tools for API-key callers, and the only surface they can reach. Nothing widens it: adding an entry to that list is the sole way to expose a tool externally (#11537 removed the never-reachable `fullToolSurface` opt-in that used to promise otherwise). See [Payload and registry budgets](#payload-and-registry-budgets-11526-11585) for the enforced size range; the roster itself lives in [`shared/config/mcpExternalTierAllowlist.ts`](../../shared/config/mcpExternalTierAllowlist.ts) and is deliberately not restated here, because a count in prose drifts the moment a tool is added or cut and nothing in CI compares the two. |

The `external` surface is deliberately small (#11585) — it stood at 100 entries / ~128 KB of schema, past what MCP clients tolerate, and [Payload and registry budgets](#payload-and-registry-budgets-11526-11585) covers the caps that now bound it. The selection rule is **what only Daintree can do**: terminal and agent orchestration, worktrees, recipes, skills, live IDE context. An external agent driving Daintree over MCP is sitting in a terminal with its own shell and its own `gh`, so git plumbing, forge reads and writes, file reads, and project queries are its job. Those remain fully available to the in-app assistant through the workbench/action/system tiers, which the external cut did not touch — though those tiers are much larger and carry their own client-registry exposure, as [Payload and registry budgets](#payload-and-registry-budgets-11526-11585) sets out.

Two consequences worth knowing. `git.push` keeps its bespoke MCP plumbing (branch/commit preview in the confirm dialog, cwd pinning against a mid-modal worktree switch, the headless-safe confirm path) — it is reachable at `system`, just not externally. And because MCP resources authorize through their backing action (`RESOURCE_BACKING_ACTIONS`), external sessions no longer read `daintree://project/current/issues` or `daintree://worktree/{id}/pulse`; terminal-scrollback and agent-state resources are unaffected.

`shouldExposeTool` (used by `tools/list`) and `isTierPermitted` (used by `tools/call`) are the two gates. `isTierPermitted` owns tier membership and nothing else. `shouldExposeTool` layers two ceilings — `danger === "restricted"` and `mcpVisibility: "hidden"` — on top and then defers to `isTierPermitted`, so membership can never drift between the two. `restricted` actions are unreachable regardless of tier: `ActionService.dispatch` rejects them independently.

There is deliberately **no** third state where a tool is withheld from `tools/list` but left dispatchable. `mcpVisibility: "discoverable"` used to be exactly that, on the theory that the meta-tools kept omitted tools reachable. #11585 established that they do not: shipped clients build their tool registry from `tools/list` and reject an unlisted name before it ever becomes a request, so withholding a name is indistinguishable from revoking it. The value was removed. To take a tool away from a caller class, cut it from that tier's allowlist — which revokes it at both gates, visibly.

The introspection tools (`actions.list`, `actions.search`, `actions.getSchema`) are narrowed by a third gate, `filterIntrospectionResultForSession`, applied in main to the dispatch result (#11525). It layers `isTierPermitted`'s allowlist — widened by any live per-tool or native automation grant — on top of the `hidden`/`restricted` ceilings, so discovery returns what the session can actually call. Introspection therefore _describes_ the session's surface (argument shapes, enabled state, live grants) rather than reaching past it.

**The first-party existence catalog (#12117)** is the one exception, and it is a reporting exception rather than an authorization one. A renderer-owned session — origin `help` or `assistant-pane`, a pinned panel with a human watching — additionally receives an `unavailable` collection naming actions that exist above its tier: `{ id, title, band, minimumTier, callable: false }` and nothing else, with `actions.getSchema` answering `TIER_NOT_PERMITTED` plus one stub instead of the indistinguishable `NOT_FOUND`. No description, no schemas, no policy record. Before it, an out-of-tier id was indistinguishable from a nonexistent one at every surface, so the assistant reported shipped features as absent. `buildUnavailableStub` gates on `TargetPolicySessionSnapshot.rendererOwnedOrigin` and the in-app ladder, so external and api-key clients receive the payload they received before, key for key — and nothing in the catalog is listed, dispatchable, or reported by `mcp.surface`.

### Session continuity and the human handoff boundary (#11908)

The in-app assistant can carry a session across a close and back, and can draft a recipe for the user. None of the tools below writes a recipe to disk. The split runs along one line: **the assistant proposes, the person commits.**

Reads stay at `workbench` (`agentSessionHistory.list`, `session.bookmarks.list`). Everything that changes something sits at `action`:

| Tool | Why it is where it is |
| --- | --- |
| `agentSessionHistory.resume` | Spawns a pane, so it belongs with the other spawn tools rather than with the listings it reads from. |
| `session.bookmark.promote` / `.rename` | Reversible metadata edits. Scoped in the action: the journal is keyed by `sessionId` alone and main matches it across every project's records, so each mutation first proves the id is in the caller's own project — an id lifted from another project is refused with the same not-found error an unknown id gets. |
| `session.bookmarkAndClose` / `session.bookmark.delete` | `danger: "confirm"` — each removes something the person can see (a live pane, a durable bookmark), so the renderer's own dialog gates the mutation. The first-party assistant is pinned to a WebContents rather than workspace-bound, so the confirm-withholding rule above (which keys on the `external` tier) never applies and the tools stay listed. Pinning supplies a route, not an audience: if that renderer is gone or nobody is looking, the dispatch times out rather than proceeding. |
| `recipe.editor.open` / `recipe.editor.openFromLayout` | Handoffs, not writes — see below. |

`terminal.resumeSessions` is deliberately on **no** tier. It opens the human resume palette: no session id in, no terminal id out, nothing an agent can act on. `agentSessionHistory.resume` is the callable form, and it is stricter than the palette in three ways that matter:

- **The record owns the launch directory, not the caller.** Resume is directory-coupled — the CLI locates a conversation from the launch cwd (#4781) — so a `worktreeId` argument scopes the _lookup_ and is never treated as a relocation. A session recorded in another worktree is refused rather than re-homed, because relaunching it elsewhere would silently produce a fresh session wearing a resumed session's id.
- **It focuses rather than duplicates.** A live pane already carrying that session in that worktree is brought forward and its id returned (`outcome: "activatedExisting"`), and overlapping dispatches collapse onto one spawn. Records are non-destructive, so without this two agents would end up on one provider transcript.
- **It does not move the user's view.** An agent-sourced dispatch never switches the active worktree, so a pane resumed into a non-active worktree opens off-screen; the caller addresses it by the returned `terminalId`. Foreground dispatches still switch, which is why the shared helper takes the switch as a callback rather than performing it itself.

**The recipe-editor handoff.** `recipe.editor.open` and `recipe.editor.openFromLayout` put a draft on screen and stop there. They return `{ opened, mode, worktreeId, recipeId, terminalCount }` — deliberately nothing that reports a save, because neither performs one. `opened` is earned rather than assumed: the handoff travels as a DOM event, which tells its dispatcher nothing, so the editor's listener acknowledges the request and an unacknowledged dispatch throws instead of claiming a screen that never changed. `recipe.saveToRepo` and `recipe.delete` are on no tier at all, so the write half of recipe authoring has no MCP surface — nothing in this section turns a draft into a tracked file under `.daintree/recipes/`.

One wrinkle worth knowing: `recipe.editor.open` is `danger: "safe"`, but an agent dispatch carrying a `recipeId` is elevated to `"confirm"` by `resolveEffectiveActionDanger`, which keys on the argument rather than the action (#11860). The elevation is deliberate over-gating; the action carries its own `dangerRationale` so the dialog says what this call actually does — open an editor — rather than the generic "spawns the recipe's terminals" text written for the composites that do.

That boundary is a property of the tool surface, not a rule the model is asked to follow — which is the point. But be precise about what it guarantees: **no recipe tool writes a recipe**, not "the assistant cannot write one". The assistant also holds terminal tools, and a recipe file is just JSON on disk, so the editor is the only _exposed_ path, not the only reachable one. Anything that widens the assistant's ability to write tracked recipe files — a new tool, a shell helper, a broader path allowance — is re-opening this decision and belongs in review as such.

### Risk bands and `danger`

`deriveBand` / `BAND_OVERRIDES` / `RISK_BAND_OPEN_WORLD_CATEGORIES` (`shared/utils/actionRiskBand.ts`) classify each action into a `RiskBand` (`reversible` | `external-effect` | `destructive-local` | `destructive-network`) from its `danger` + `category`, with per-id overrides (`git.push` → `external-effect`, `copyTree.generateAndCopyFile` → `destructive-local`). The band drives the renderer's blast-radius preview and the MCP tool annotations (`buildAnnotations`).

How `danger` interacts with tier gating:

- `danger: "restricted"` — never exposed (hard floor in `shouldExposeTool`) and never dispatchable, the latter enforced by `ActionService.dispatch` rather than by the tier gate.
- `danger: "confirm"` — _exposed and dispatchable_ if the tier permits, but the `CallTool` handler dispatches it **unconfirmed** so the human approves it host-side in the renderer's native `McpConfirmDialog` (via the renderer bridge) before the mutation fires. This is the MCP-side wiring of the same confirm gate documented in [`destructive-action-safeguards.md`](./destructive-action-safeguards.md): `danger:"confirm"` classifies the action; the host `ConfirmDialog` is the user-facing confirm. A client's self-declared `elicitation.form` capability is **never** treated as authorization — a headless/agentic client could otherwise answer its own in-band elicitation `accept` and self-approve a destructive call with no human in the loop (#11342). When no Daintree window is open to surface the dialog the call is refused with `CONFIRMATION_REQUIRED` (`confirmationChannel: "unavailable"`); only a host-issued native automation grant pre-authorizes a dispatch — and it does so whether or not the static tier already permitted the action, since pre-authorizing the modal is orthogonal to clearing the floor (#11878).

## Session lifecycle (`sessionStore.ts`, `httpLifecycle.ts`)

A session is created on transport open: SSE sessions live in `SessionStore.sessions`, Streamable-HTTP in `SessionStore.httpSessions`. At handshake `httpLifecycle`:

1. Resolves and records the tier (`sessionTierMap`) and the **origin** (`sessionOriginMap`).
2. Registers client metadata + the bearer in `bearerRegister` (`touchBearer`).
3. Pins the WebContents (`sessionWebContentsMap`) and `ActionContext` (`sessionContextMap`) for help bearers, or records a **workspace binding** (`sessionWorkspaceMap`) for an external bearer that sent a selector.
4. Builds the per-session `SessionServerDeps` and calls `createSessionServer`.
5. Arms an idle timer (`MCP_SSE_IDLE_TIMEOUT_MS`, 30 min).

`transport.onclose` tears everything down: clears the idle/elevation timers, deletes the tier, revokes the session's grants (`grantCache.revokeSession(..., "session-ended")` — _before_ dropping the WebContents pin so the lifecycle emitter can still target the pinned renderer), clears dedup + rate-limit + client metadata, drops abuse state, and detaches the bearer.

The **idle reaper** is awake-time corrected (`SystemSleepService.getAwakeTimeSince` / `recomputeIdleTimers` on wake) so suspend time doesn't count against the 30-minute window.

### Session origin vs. routing (#11789)

Every session records an explicit `origin` — `"help" | "assistant-pane" | "external"` — separate from how it routes. Before #11789, "is this one of Daintree's own surfaces" was inferred from presence in `sessionWebContentsMap`, which was safe only while external sessions were never pinned. They can be now, so the two questions are answered by different fields:

- **Routing** reads `sessionWorkspaceMap` first, then `sessionWebContentsMap`, then falls back to focus order.
- **Authorization** (`issueGrant`, `setSessionTier`), **notifications** (the five `wc.send` closures in `buildSessionServerDeps`, plus the 401-abuse revoke) and **inventory** (`listExternalActiveClients`) read `origin` via `SessionStore.isRendererOwnedOrigin`.

`getOrigin` defaults to `"external"` — the least-privileged answer — so a session whose handshake never recorded one, or one already half torn down, can never be mistaken for an assistant surface. `clearSessionBinding` drops route, context, origin and workspace together; every teardown path calls it rather than deleting maps individually.

Getting this wrong is not theoretical. `issueGrant` has no rank floor (`setSessionTier` is saved by `external` sitting top of the rank order); its only other check is `minimumPermittingTier(toolId) !== null`, and the call gate honours a grant over failed tier membership. A bound external session reaching that surface could hold a grant for a tool outside `MCP_EXTERNAL_TIER_TOOLS` entirely.

### Workspace binding (#11789)

An external session can bind to one workspace at handshake and route there for its whole life, instead of following window focus. The selector is read **only** when creating a new session, on `/mcp`:

- Header `Daintree-Workspace-Id: <opaque workspace id>`, and/or
- Query param `?workspaceId=<opaque workspace id>`

Both spellings are equal-authority: sending both is fine when they agree and **fails the handshake** when they don't — there is no precedence order, because silently preferring one would let a stale value in a copied config override an explicit one on the URL. The id is the same one `org.daintree/resolved-workspace` already reports (a project id or a scratch id), and stays opaque — it is never parsed as a path.

An empty or whitespace-only selector is **invalid, not absent**: a client that sends the field at all believes it is scoping itself, and reading a blank one as "no selector" would hand it a focus-following session while it thought otherwise. The same reasoning covers the later legs — a selector on an established `/mcp` session must match what that session actually resolved to (it never rebinds; `DELETE` is exempt so a client can always clean up), and a selector on `POST /messages` is refused, because that is precisely where clients are known to attach headers inconsistently.

Resolution goes through `getWebContentsForProject`, a registry read with no attach/thaw/focus/switch side effects. **Exactly one** live view must own the workspace for a call to _route_; zero and many both fail closed, and neither ever falls back to another window.

What that costs the client is decided at the handshake, and the two are deliberately different (#12082). A refusal is permanent in practice — no MCP client SDK retries a non-2xx `initialize`, so a 400 does not mean "this attempt failed", it means "this client has no Daintree tools until someone restarts it" (#12081). So the handshake refuses only what can never become valid, and binds everything else:

| Condition | Handshake | Why |
| --- | --- | --- |
| Header and query param disagree | 400 `WORKSPACE_SELECTOR_MISMATCH` | A config that names two workspaces names none. |
| Empty, repeated, comma-folded, or not shaped like a workspace id | 400 `WORKSPACE_SELECTOR_INVALID` | The id space is structural (64-hex project, UUIDv4 scratch — `shared/utils/workspaceIds.ts`); a value outside it names nothing that could ever exist. |
| Selector from a help / assistant-pane bearer, or a build with no resolver wired | 400 `WORKSPACE_SELECTOR_NOT_ALLOWED` | Neither becomes true mid-session. |
| Workspace has zero live views, or more than one | **binds**, identity only | Which windows are open is user-controlled and changes minute to minute. The workspace id outlives every view. |
| Resolver throws anything else | propagates to HTTP 500 | A host bug of unknown duration; nothing has been allocated yet, so it leaves no session behind. |

The shape test lives in `HttpLifecycle.resolveWorkspaceSelector`, not in `parseWorkspaceSelector` — the parser stays syntax-only and never interprets an id.

A degraded binding carries the `workspaceId` and nothing else: `kind` and `workspacePath` are read off the live view, so their absence is the signal. There is deliberately **no** liveness flag on the binding — `capabilities.experimental` is built once at `initialize` and never updated, so a flag would be a snapshot that is wrong seconds after it is read. The live answer is the per-call one.

A refused handshake returns HTTP 400 with a JSON-RPC error body at `MCP_HANDSHAKE_REJECTED_CODE` (`-32002`, distinct from the `-32001` "Session not found"), a stable `error.data.code`, and **no** `Mcp-Session-Id` — no session state is created at all. Note that SDK 1.29's `StreamableHTTPClientTransport` surfaces a non-2xx handshake as a `StreamableHTTPError` carrying the raw body as text, so a client that wants to branch on `data.code` has to parse that body itself; the codes are a stable contract, not something the stock client destructures for you.

### The bound-but-viewless surface (#12082)

Completing the handshake alone would only convert "connection failed" into "connected, permanently no tools", which is harder to diagnose. So a bound session whose workspace has no single live view is served a **host-authoritative base surface** at `tools/list`: `electron/services/mcp-server/generated/mcpExternalBaseManifest.ts`, read through `getExternalBaseManifest()`.

- **Generated, not hand-written.** `src/services/actions/__tests__/mcpExternalBaseManifest.test.ts` drives a real `ActionService` over the real action registry and both regenerates the artifact (`UPDATE_MCP_BASE_MANIFEST=1`) and fails when it drifts. There is no second copy of `toManifestEntry` to keep in sync.
- **Scoped to `MCP_EXTERNAL_TIER_TOOLS`.** That is the whole reachable surface: binding is refused for any origin or tier but `external`, and a bound session can never be elevated (`setSessionTier` / `issueGrant` are gated on renderer-owned origins).
- **Never `getCachedManifest()`.** That describes whichever _other_ window last reported a manifest — a cross-workspace isolation bug, since the bound session is specifically forbidden from routing there. The generated artifact describes nobody's view. `getCachedManifestForWorkspace` still fails closed to `null`.
- **Discovery only.** It authorizes nothing. The bound pre-dispatch confirm guard still needs a live workspace route, and dispatch still goes through `dispatchActionForWorkspace`, so a viewless `tools/call` stays fail-closed. Confirm-gated tools are withheld either way — `sessionSurface.workspaceBound` is set from _having_ a binding, not from view liveness.
- **A dead pin is not this case.** `SessionBindingError` (destroyed pinned WebContents) still fails `tools/list` outright; only `WorkspaceBindingError` reaches the base surface.

Per-call failures report `SESSION_BINDING_GONE` as before, but `retriable` is now read off the error instance rather than the code: `WorkspaceBindingError` is retriable for both reasons (opening the workspace, or closing the duplicate, makes the identical call route), `SessionBindingError` is not. `RETRIABLE_ERROR_CODES` is deliberately untouched — adding the shared code to it would have made the destroyed-pin case retriable too.

A selector from a help or assistant-pane bearer is refused: those already route through the renderer that minted them, so a selector would name a second plausible target. Binding is likewise `/mcp`-only — a selector on the deprecated `/sse` endpoint is refused rather than ignored, since a silently-ignored routing selector is worse than an unsupported one.

The binding is echoed in the `initialize` result under `capabilities.experimental["org.daintree/workspace-binding"]`, so a client can verify where its calls will land before issuing a mutation. It is declared at `Server` construction, never by registering a second `InitializeRequestSchema` handler — that would shadow the SDK's own `_oninitialize` and lose the `_clientCapabilities` capture the elicitation negotiation depends on.

A bound view that Chromium has **frozen** (`Page.setWebLifecycleState`, applied to cached views under the Efficiency profile) is a known gap, not a handled case: its renderer event loop is suspended, so a dispatch queues rather than running, the caller times out at 30s, and the action executes on reactivation with its response discarded. Freezing is skipped for a project with a live agent, which covers the common orchestration case, but keeping a bound view thawed is #11790's job. Refusing dispatch to any _cached_ view would not be a stand-in — most cached views are merely CPU-throttled and work fine, so that would break the feature's whole point.

**The binding stores the workspace id, not a WebContents id.** A view's id lives and dies with that view: a warm project switch reuses the same view, but LRU eviction destroys it and a later cold start registers a new id under the same workspace. Re-resolving per call lets a session recover once its workspace has a live view again; caching the handshake id would leave it permanently `SESSION_BINDING_GONE`. Dispatching into a _frozen_ view is #11790 — this is correct whenever the bound view is live.

Failures fail closed and never fall back to another window, and a bound session never serves a cached manifest after a binding failure — that cache describes a view it can no longer reach. What a failure _looks_ like depends on the surface: `tools/list` answers from the host base surface above; `tools/call` returns an `isError` result whose text content carries `SESSION_BINDING_GONE` with `retriable: true`; and `resources/list` and `resources/read` throw with the same payload on `McpError.data` rather than a generic "unavailable" or, worse, an authoritative-looking empty listing. One limit is deliberate: `daintree://agent/<id>/state` answers from a process-global store, so a bound session's route is probed before it is served — but _which_ workspace an agent belongs to is not checked, because that is the pre-existing #11789 scoping gap rather than this one.

**Confirm-gated tools are withheld from a bound session.** A `danger: "confirm"` dispatch is only ever approved in the target renderer's native dialog, which gives up at 28s — inside main's 30s dispatch timeout and the client's 60s request timeout. Nobody is watching a background-bound view, and no arrangement holds the call open long enough to find someone. So such tools are dropped from the session's effective surface across `tools/list`, the introspection tools and `mcp.surface`, and a direct call is refused **before dispatch** with `CONFIRMATION_REQUIRED` and `details.confirmationChannel: "workspace-bound"` (distinct from the `"unavailable"` a windowless host reports, which clears when a window opens). The exclusion is derived from the manifest's own `danger` rather than a curated id list, so a future confirm-gated addition to `MCP_EXTERNAL_TIER_TOOLS` is covered the day it lands. It is a hard ceiling: a live per-tool or native grant widens dispatch past the tier floor but not past this. The guard keys on external tier **and** bound, never on "has a renderer route" — the Daintree Assistant is pinned and carries confirm-gated tools in its own allowlist.

Binding is opt-in. An unbound external session keeps the documented focus-following behaviour, `recipe.run` included.

### Resource ownership (#11909)

Routing identity says where a session's calls land. Ownership says which resources it may clean up, and the two stay separate concepts: a session bound to a workspace can reach every panel in it, and owns almost none of them.

`SessionStore.resourceOwnership` (`resourceOwnership.ts`) records which terminals and worktrees each session created. Entries are written **only** from the dispatch envelope a completed action returned — never from `spawnedBy` (caller-supplied and purely descriptive), never from tool arguments, never from a later scan of `terminal.list`. The recording hook sits in `sessionServer`'s dispatch path immediately after the envelope resolves, and covers the four creation tools an external session can reach: `terminal.new`, `agent.launch`, `recipe.run` and `worktree.createWithRecipe`. The last two return `spawnedTerminalIds` precisely so composite child terminals are attributable — a count identifies nothing, and inferring ids from a later listing would attribute the user's panels too. A `worktree.createWithRecipe` that creates the worktree and then fails its recipe still attributes the worktree — the caller has to be able to clean up the mess its own call made. That attribution keys on the `PARTIAL_SUCCESS` **error code**, which `ActionService` stamps only for a thrown `PartialSuccessError` (`shared/utils/partialSuccess.ts`), never on the message shape: the composite calls forge providers and git before the worktree exists, and `forgeAuditService` rethrows a provider's message unchanged, so a provider returning a suitably-shaped string could otherwise mint a record for a worktree nothing created.

`agent.launch` returns a `worktreeId` and it is deliberately **not** recorded: that names the worktree the agent launched _into_, which the session did not create.

Two tools consume the ledger, and neither is the general primitive:

- **`terminal.closeOwned`** (`danger: "safe"`) — checks ownership, then dispatches the real `terminal.close`, so trash/recovery behaviour and the "reports the exact panel closed" contract are the shipped ones.
- **`worktree.deleteOwned`** (`danger: "confirm"`) — checks ownership, then dispatches the real `worktree.delete`. Delegating under that literal id is what makes the D2 preview work: `resolveMcpConfirmPreviewTarget` in `useMcpBridge` matches on the action id to build the tracked/untracked file-count preview. Its `danger: "confirm"` also feeds `isWithheldFromBoundSession`, so a workspace-bound session — routed at a view nobody is watching — is refused it at discovery and at dispatch alike. `force`, `deleteBranch` and `closeTerminals` are absent from its schema and stripped from the delegated call: owning a worktree is not authority to destroy uncommitted work, delete a branch the session never created, or close every terminal in it (`closeTerminals` is a blunt boolean over all of them, so it cannot be narrowed to the owned ones).

The generic `terminal.close` and `worktree.delete` stay off `MCP_EXTERNAL_TIER_TOOLS`. Both `*Owned` tools execute as main-process short-circuits because the ledger is keyed by MCP session id, which the renderer never sees.

A refusal is `RESOURCE_NOT_OWNED`, and it is deliberately one code for three situations — the id never existed, it belongs to another session, or it belongs to the user, a plugin, or the in-app assistant. Distinguishing them would make the cleanup tools an enumeration oracle. The check runs before the delegated dispatch, so a refused call never reaches a renderer.

**Ownership lasts exactly as long as the session, and disconnect does not clean anything up.** `clearSessionBinding` drops the ledger alongside route, context, origin and workspace, and `drain` clears it wholesale — that revokes _authority_, not the resources. Terminals and worktrees a disconnected client created stay exactly where they are: the session ending is not a decision to destroy work the user can still see, and a reconnecting client gets a new session id with an empty ledger. Cleaning up after a client that went away is the user's call, through the normal UI. Ownership is recorded for every tier rather than only `external`, because "this session created it" is a fact about the session rather than about its privileges.

Re-recording an id moves the record to the newest creator. Ids are reusable — `agent.launch` accepts a `requestedId` that `addPanel` honours without a collision check, and worktree ids are paths that come back after a delete — so an older record for a live id is the stale one. Keeping it would be the dangerous choice: a session holding a record for a panel the user closed could otherwise close whatever replacement now answers to that id. The only way to reach the transfer is to successfully create a resource under the id, which replaces whatever it named before, so authority always follows what actually exists.

Two smaller consequences worth knowing. A creation that lands _after_ its session was torn down records nothing — otherwise a dead session's authority would come back and, worse, claim the id away from whoever records it next. And `worktree.deleteOwned` is deliberately absent from the dedup allowlist that `worktree.delete` sits in: worktree ids are paths, create → delete → recreate is a supported workflow, and a cached delete would report success for a second, genuinely different worktree.

### Bearer register

`HttpLifecycle.bearerRegister` is the live view of every connected client (keyed by token hash, never the raw token). It backs the settings tab's `listActiveBearers()` (display suffix + hash only) and `disconnectBearer(tokenHash)`, which revokes every session a bearer owns and evicts it. Help bearers are tracked but filtered out of `listActiveBearers`; `disconnectHelpBearer(rawToken)` tears them down eagerly when the help session is revoked rather than waiting for the idle reaper.

### Tier elevation vs. per-tool grants

Two distinct mechanisms widen what a session can do past its baseline:

- **Session-tier elevation** ("Always allow"): `setSessionTier(sessionId, tier)` raises the whole session's tier. It silently decays back to `workbench` after `MCP_TIER_ELEVATION_TTL_MS` (30 min, awake-corrected) so a stale "Always allow" can't outlive intent across hibernate/project-switch. On decay, `onTierDecayed` pushes `tools/list_changed` and writes a `tier.decayed` audit record.
- **Per-tool grants** ("Approve once"): `GrantCache` mints a `(sessionId, toolId)` grant authorizing _one_ tool without elevating the session. It has a **sliding TTL** (`MCP_GRANT_TTL_MS`, 15 min, refreshed on each successful dispatch through the grant) and a **hard wall-clock ceiling** (`MCP_GRANT_MAX_LIFETIME_MS`, 30 min from `issuedAt`) so a model calling more often than once per TTL can't hold a grant forever. The `issuedAt` field doubles as a race token: a `refresh` carrying a stale `issuedAt` (the grant was revoked and re-issued mid-dispatch) is a silent no-op, so a winning revoke is never resurrected (lesson #2243). All three TTLs are intentionally ≤ the 30-minute SSE idle timeout so a grant/elevation can never silently outlive its session.

`minimumPermittingTier(toolId)` computes the lowest non-`external` tier that would permit a denied tool, so the renderer's "Approve once" / "Always allow" buttons target the _narrowest_ sufficient tier rather than blanket-elevating to `system`.

## End-to-end `tools/call` flow (`sessionServer.ts`)

The `CallTool` handler is a fixed-order gate chain. Each gate that denies writes an audit record and returns a structured tool-error (`buildToolError`) — never a silent skip. Gate 0 is the exception: a request whose session is already gone is refused without an audit record, because there is no tier it could honestly be recorded under.

**`getTier` returns `McpTier | null`, and `null` means "no live transport" (#11799).** `workbench` is not a floor — `TIER_ALLOWLISTS` gives `external` its own allowlist rather than a subset of `workbench`, so defaulting a vanished session to `workbench` _widened_ a revoked external bearer onto 46 tools its allowlist withholds. Every authorization path (`tools/list`, `tools/call`, and all four resource handlers) resolves the tier once at entry and fails closed on `null` with `SESSION_GONE`. Discovery throws rather than answering with an empty list, which would read as a legitimate empty surface.

**Authorization has one lifetime per call.** The tier is captured once, at admission, and reused for the rest of the handler — through the manifest fetch, the native-grant charge, and dispatch. Revocation stops the _next_ request; it does not retroactively refuse a call the gate already admitted, and re-reading mid-handler would only make the response disagree with the gate and the audit record.

```
tools/call(actionId, args)
  │
  ├─0 Session liveness: sessionStore.getTier(sessionId) → null?
  │      └─ yes → return SESSION_GONE (business, do not retry) before any audit,
  │               denial counter, grant lookup, dedup entry or dispatch
  │
  ├─1 Admission — did anything OTHER than a native grant let this call in?
  │      ├─ isTierPermitted(tier, actionId) → yes: admitted by the floor
  │      └─ no → grantCache.check(sessionId, actionId)
  │             └─ granted → admitted (capture issuedAt for post-dispatch
  │                          refresh; widens the floor only, never bypasses
  │                          confirm)
  │
  ├─2 Native grant: peekNativeGrant(sessionId, actionId)  (#11878)
  │      │  Runs independently of gate 1, because a native grant answers a
  │      │  different question: it both widens the floor AND pre-authorizes
  │      │  the confirm modal. Nesting it under either admission source left
  │      │  it unreachable — worktree.delete is danger:"confirm" but
  │      │  tier-permitted (action since #12116), so pre-authorizing it did
  │      │  nothing; the same held when a per-tool grant had just admitted it.
  │      │  Skipped only for an already-admitted introspection carrier, which
  │      │  can never raise a modal, so a peek would just drain the budget.
  │      │  Refused outright for a per-resolved-target tool (#12121) —
  │      │  terminal.killAll / terminal.closeAll act on every target they find,
  │      │  so no use count bounds them; issuance rejects such a scope and the
  │      │  peek refuses one minted around it.
  │      ├─ granted → capture grantId (widens the floor AND pre-authorizes
  │      │            confirm; the use is charged later, at commit-to-dispatch)
  │      └─ neither gate 1 nor a grant admitted it → incrementDenial → maybe
  │                   notifyTierMismatch (banner, suppressed after
  │                   MCP_DENIAL_SILENCE_THRESHOLD) → recordDenial(abusePolicy);
  │                   if tripped → revokeSession → return TIER_NOT_PERMITTED
  │
  ├─3 Dedup (creation-tool allowlist only):
  │      ├─ cached result within TTL & same args → return cached (audit: dedup)
  │      ├─ same key, different args → return MCP_DEDUP_KEY_COLLISION
  │      └─ in-flight same key → await shared promise (singleflight)
  │
  ├─4 Confirm: entry.danger === "confirm" is dispatched UNCONFIRMED (unless a
  │      native grant pre-authorized it). The host approves it in the renderer's
  │      native McpConfirmDialog during dispatch; a client's elicitation.form
  │      response is never authorization (#11342). No window open →
  │      CONFIRMATION_REQUIRED (confirmationChannel: "unavailable").
  │
  ├─5 Dispatch:
  │      ├─ main-process short-circuits (never via rendererBridge):
  │      │    terminal.waitUntilIdle      → handleWaitUntilIdle
  │      │    terminal.waitUntilIdleBatch → handleWaitUntilIdleBatch
  │      │    skills.search / skills.load → skills.ts
  │      │    project.runCheck            → projectCheck.ts
  │      │    help.displayImage           → inline handler in sessionServer.ts
  │      └─ else → rendererBridge.dispatchAction(actionId, args, confirmed)
  │              ├─ danger:"confirm" & unconfirmed → renderer surfaces the
  │              │  native ConfirmDialog, dispatches only after human approval
  │              └─ pinned view gone → SESSION_BINDING_GONE (do not retry)
  │
  ├─6 On success through a grant → grantCache.refresh + reset idle timer
  │
  └─7 Audit: appendAuditRecord({ toolId, tier, args, durationMs, outcome })
```

Gate order is load-bearing: a native grant's use is charged **after** admission and after the workspace-bound confirm ceiling — an unauthorized or refused call must never burn one — but **before** dedup, so a replayed duplicate spends a use without dispatching. The per-call rate limiter that used to sit between admission and dedup was removed in #10764.

One use is also the only cost the charge site can express, and it is charged before dispatch — so a tool whose target set is resolved from live renderer state inside `run()` has no honest count available at the moment it would be billed. Those tools are barred from native grants entirely (`shared/config/nativeGrantUsePolicies.ts`) rather than under-charged: `HttpLifecycle.issueNativeGrant` rejects a scope naming one, and `peekNativeGrant`/`consumeNativeGrantUse` refuse one anyway as defence in depth. **A new destructive fan-out action must be added to that policy** — the default is `per-dispatch`, so an omission fails open.

### Dedup

- **Dedup** (`MCP_DEDUP_ALLOWLIST`): creation tools only, admitted on one of two distinct grounds — either an LLM retry leaves a duplicate artifact (an orphan terminal, a second agent, a duplicate issue/comment/review), or the retry creates nothing and the cached success is preferable to the error a redundant redispatch would raise (`worktree.delete`, `forge.createPR`, `forge.mergePR`, which 422s a duplicate PR and PUTs a merge). Keyed by a caller-supplied `requestKey` (prefixed with `actionId`, capped at `MAX_REQUEST_KEY_LENGTH`) or an auto canonical args hash, with an args-hash collision guard (#8429). TTL `MCP_DEDUP_TTL_MS` (120s), FIFO-capped at `MCP_DEDUP_MAX_ENTRIES_PER_SESSION` (256). Deliberately **out** (#11534): navigation (`forge.open*`) and idempotent state-sets (assign/unassign, close/reopen/edit, labels), which create no duplicate to suppress and whose cached 120s no-op breaks the legitimate repeat — reopening a URL the user closed, or re-assigning after an unassign — plus `git.commit`/`git.push`, whose arguments a legitimate repeat reuses unchanged, so deduping them would report success for a commit or push that never happened.

## Tool argument and result conventions (#11543)

One rule per axis, so a caller learns the surface once instead of per namespace. The shared building blocks live in [`src/services/actions/definitions/locationArgs.ts`](../../src/services/actions/definitions/locationArgs.ts) and [`schemas.ts`](../../src/services/actions/definitions/schemas.ts) — use them rather than hand-rolling the fields.

**Location.** A worktree-scoped tool accepts `worktreeId?` (preferred) or `worktreePath?`; a project-scoped tool accepts `projectId?` (preferred) or `projectPath?`. Omitting every selector targets the active worktree/project; an explicit id wins over an explicit path. Build the schema with `withWorktreeLocation(extra, opts)` / `withProjectLocation(extra, opts)` and resolve in `run()` with `requireWorktreePath` / `requireWorktreeId` / `resolveProjectLocation` — the resolver fills in whichever half the underlying IPC needs, so the tool's argument names no longer leak whether its IPC happens to be id- or path-based.

A tool with no meaningful active-worktree default opts out with `{ requireSelector: true }`, which rejects a call that supplies no selector rather than retargeting it. Use it wherever the fallback would be silently wrong: a destructive write (`artifact.applyPatch` — a "if none given, use the active one" default on a destructive submit is the pattern CLAUDE.md bans), or a tool that anchors on the REPO ROOT while the active worktree is usually a linked one (`worktree.create`, `worktree.getDefaultPath`).

`cwd`, `rootPath`, and `path` remain accepted as legacy aliases for `worktreePath`, declared per-tool via `{ legacy: [...] }` so the advertised surface only grows where the tool already had them. Argument names are not part of the action-id contract, which is what makes this convergence non-breaking. Do **not** alias a `cwd` that means something else — `agent.launch`'s PTY launch directory and `artifact.saveToFile`'s save directory are operation-specific and stay as they are.

Aliases collapse inside the zod schema (a whole-object `.transform()`), not in the MCP bridge, because every surface — MCP, palette, keybindings, context menus — funnels through `ActionService.dispatch`, which validates `argsSchema` before the handler runs. `z.toJSONSchema(..., { io: "input" })` unwraps the transform and still advertises every alias property with its own description; `locationArgs.test.ts` asserts that, so a zod upgrade that changed it fails loudly instead of silently emptying the advertised surface. Never wrap a `resultSchema` in `.transform()` — the matching `io: "output"` call collapses a transformed schema to an empty object, erasing the advertised output shape.

**Errors.** Throw for anything the caller must treat as a failure. A value returned from `run()` is serialized by the bridge as a _successful_ tool result, so an inline `{ ok: false }` or an `error` string beside the data is invisible to an agent checking `isError`; only a throw (→ `EXECUTION_ERROR`) or a dispatch-gate rejection becomes a tool error. One transport-level exception sits outside that rule: a response whose promised `structuredContent` the result helper had to omit — because the text was truncated, because it nested too deeply, or because it could not be reproduced as bounded transport-safe JSON — is flagged `isError` even though `run()` succeeded. See [Payload and registry budgets](#payload-and-registry-budgets-11526-11585). Error messages must be static — never interpolate the rejected input, and never surface a caught `ZodError.message`, which in zod 4 carries the offending values inline.

Two narrow exceptions, both genuinely domain data rather than execution status: a **per-item failure inside a batch result**, where the other entries are still useful (`terminal.getStatuses`), and a **lookup miss** where "not found" is the answer the caller asked for (`actions.getSchema`, which also answers `TIER_NOT_PERMITTED` with an existence stub for a renderer-owned session — see the first-party existence catalog above). A new per-item failure should carry `{ code, message }` rather than a bare string so a caller can branch on the code; the existing terminal batch surfaces still return a bare `error` string and have not been migrated.

**Pagination.** A list tool takes `limit?` plus a positional selector — `cursor?` for sources that issue one, `offset?` for sources that page by index — and returns `{ items, hasMore, nextCursor, total? }`. `skip` stays accepted as a legacy alias for `offset`. Build with `withPagination(extra, opts)` (or `withWorktreeLocation(extra, { pagination })` when the tool needs both) and shape the result with `PaginatedResultSchema(itemSchema)`. Where a source pages by index, its `nextCursor` is simply the next offset, so a caller can round-trip the cursor without knowing that. Choosing the actual `limit` ceilings is issue #11531, not this convention.

## Payload and registry budgets (#11526, #11585)

Two independent budgets bound this surface, and they fail in different ways. The **registry** budget bounds what the tool list costs a client before any call happens; the **payload** budget bounds what a single call returns. Neither is derived from the other, and staying inside one says nothing about the other.

### Registry budget — what `tools/list` costs

A tool registry is charged to the model's context on every request, so an oversized one is not merely wasteful — it gets silently mangled. The `external` surface stood at 100 entries and ~128 KB of schema before #11585, past what MCP clients tolerate: Cursor caps the tool count across all connected servers and truncates the overflow without telling anyone, while GitHub Copilot's 128-tool cap is a hard error. Truncated or rejected, the client was choosing our tools for us. Two regression thresholds now bound the external roster on **both** axes, because either one alone is gameable:

- **Tool count** — `EXTERNAL_BUDGET_MAX` (26) and a floor of 15, asserted in [`tierAuth.test.ts`](../../electron/services/mcp-server/__tests__/tierAuth.test.ts). The floor is as load-bearing as the ceiling: a surface that quietly erodes to nothing is also a regression.
- **Aggregate description bytes** — `MAX_DESCRIPTION_BYTES` (16,000 UTF-8 bytes summed across the whole external roster, not per tool), asserted in [`actionDefinitions.quality.test.ts`](../../src/services/actions/__tests__/actionDefinitions.quality.test.ts). Counting tools alone would miss the obvious workaround: a couple of dozen tools carrying novel-length descriptions reproduces the same problem with a count that looks fine.

Both are **test thresholds, not runtime constants** — nothing rejects a call or a listing for exceeding them; the unit suite fails in CI instead. Both derive their input from the real allowlist rather than restating it, so neither can drift from the gate it budgets. Note what they do _not_ measure: only top-level `description` bytes are summed, while a real `tools/list` response also ships input schemas, annotations, optional output schemas, and examples. Those can grow without moving either number, so the thresholds are a regression tripwire on the roster, not a bound on the serialized listing.

The help-assistant tiers (`workbench` / `action` / `system`) are outside **these tests** and were not cut by #11585 — but they are not exempt from client limits. They are cumulative and each is several times the size of the external roster; the `system` tier is comfortably past the Copilot figure above, by a margin no plausible edit closes. So a help client that enforces its own registry ceiling still enforces it here — there is simply no test standing guard. Derive the current totals from `HELP_TIER_CUMULATIVE` in [`shared/config/helpAssistantTierAllowlists.ts`](../../shared/config/helpAssistantTierAllowlists.ts) rather than trusting a number written down here, for the same reason the external count isn't restated above. What #11585 changed is the `external` roster only: do not read "the surface was cut to a couple dozen tools" as a statement about any help tier.

### Payload budget — what one `tools/call` returns

`buildToolCallResult` / `buildToolCallTextResult` ([`toolCallResult.ts`](../../electron/services/mcp-server/toolCallResult.ts)) cap the **text block** of a tool response at `TOOL_RESULT_TEXT_MAX_BYTES`, 50 KiB. Before #11526 resources were capped and tool results were not capped at all, so one call could return 31 MB. The bound is deliberately **byte-based, not token-based** — tokenization is a client concern and pinning the server to one vendor's tokenizer would be worse than a conservative fixed bound. 50 KiB of compact JSON lands in the low tens of thousands of tokens for typical content, but that is an estimate across tokenizers, not a guarantee: the server guarantees bytes.

Read that as a per-block cap, not an envelope cap. A promised `structuredContent` is measured against the same 50 KiB separately, so a response carrying both halves can exceed 50 KiB in total. Two paths bypass the helper entirely: non-text content (`browser.captureScreenshot` returns an uncapped base64 image block) and protocol-level JSON-RPC errors, which never reach it.

Over the cap, the text is truncated at a **UTF-8 character boundary** (`utf8BoundaryEnd` backs off continuation bytes, so a chopped multi-byte tail is dropped rather than decoded to U+FFFD) and the notice is **prefixed, not appended**: a client that trims the tail again would cut a trailing marker off and leave the model reading incomplete JSON as though it were complete. The notice states bytes shown vs. original and tells the caller to narrow its filters, limits, or paths and retry.

The structured half is derived from the text rather than accepted as given: `structuredFromText` **re-derives `structuredContent` by parsing the already-bounded text**, then measures that value's own serialization against the cap. Taking the caller's object as-is would leave `structuredContent` unbounded, since the transport `JSON.stringify`s it independently and the two can diverge without limit — a getter, a `toJSON`, or a replacer-rewritten value all ship different bytes than the ones that were counted. Round-tripping through the text keeps both halves derived from the same bounded source, which is what the #10676 "same data" contract needs, and it also removes the transport's only unserializable inputs (a cyclic or BigInt-bearing result would make the transport's own `JSON.stringify` throw). It does not make the two encodings byte-identical — re-serialization can rewrite a value (`1e20` parses from 4 bytes and re-emits as 21), which is exactly why the re-serialized form is what gets measured. The structured half is dropped when the text was truncated, when nesting exceeds `MAX_STRUCTURED_DEPTH` (100), or when that re-serialized size exceeds the cap.

**Whenever a promised structured half is dropped, for any reason, the envelope is flagged `isError: true`.** This is not cosmetic: an MCP client that declared an `outputSchema` treats a response carrying neither `structuredContent` nor `isError` as a protocol violation and throws client-side, before the model ever sees the notice explaining what happened. The flag also encodes the truth — the caller asked for structured output and did not get it. A structured-only drop (text fits, structure could not be produced) carries its own distinct notice rather than the truncation one.

Two sibling thresholds sit at the same 50 KiB, applied independently of the tool-result budget:

- **Resource reads** — `RESOURCE_TEXT_MAX_BYTES` in [`shared.ts`](../../electron/services/mcp-server/shared.ts), the truncation threshold `truncateText()` applies to pulse, scrollback, and issue-body resources. It is a threshold rather than a hard ceiling: the helper slices to the limit and then appends a `[truncated]` marker, so the returned body can run slightly over. Agent-state resource bodies are assembled from small scalar fields and don't go through it at all.
- **`project.runCheck` output** — `PROJECT_CHECK_MAX_OUTPUT_BYTES` in [`shared/types/projectCheck.ts`](../../shared/types/projectCheck.ts). Tail-preserving (a failing check's useful output is at the end) and secret-scrubbed across an 8 KiB overlap window, so a credential straddling the cut is still redacted. The outer tool-result budget still applies on top, and the result flags the field-level cut separately from the envelope-level notice above.

### Why this is the drift story

The surface drifted because nothing bounded it. Every individually reasonable "expose one more tool" and "return one more field" was invisible in isolation and only legible in aggregate — at which point the failure mode was a client silently truncating a registry, or a 31 MB response blowing a context window, neither of which reports itself as an MCP error. The two kinds of budget answer that differently, and it is worth keeping them straight: **roster growth trips a unit test** in CI, in a diff, against a number someone chose, while **payload growth is degraded at runtime** by truncation or structured-output omission and never fails a build at all. So when adding a tool to the external surface the question is what earns the slot; when widening a result the question is what the caller loses when the tail is cut, because nothing will stop it being cut.

## Forge action surface (`forgeActions.ts`)

The `forge.*` tools are how an agent reads and mutates the project's issues, pull requests, and reviews over MCP. Every action is defined in [`src/services/actions/definitions/forgeActions.ts`](../../src/services/actions/definitions/forgeActions.ts); the `run()` bodies stay provider-agnostic and provider routing (GitHub, GitLab, …) is resolved at the IPC layer in `electron/ipc/handlers/forge.ts`. For how a provider is selected and normalized, see [`forge-provider-abstraction.md`](./forge-provider-abstraction.md) — this section documents only the MCP-facing contract (id, args, tier, `danger`, rate limit, dedup). No forge action sets `mcpVisibility`, so they all take the eager `tools/list` path and surface whenever the caller's tier permits them.

The tables below are the authoritative `forge.*` surface, derived from three sources that must stay in sync: `forgeActions.ts` (`kind`, `danger`, `argsSchema`), `shared/config/helpAssistantTierAllowlists.ts` (tier membership — `WORKBENCH_TIER_TOOLS` reads, `SYSTEM_TIER_ADDONS` writes), and `electron/services/mcp-server/shared.ts` (`RATE_LIMIT_TOOL_MAP` for the bucket, `MCP_DEDUP_ALLOWLIST` for dedup). The external surface is no longer one of them: `shared/config/mcpExternalTierAllowlist.ts` contains no `forge.*` ids at all (#11585), so forge is a help-assistant-only surface and tier membership is decided entirely by the two lists above. Location arguments follow the repo-wide convention below: every repo-scoped forge action takes `worktreeId?` / `worktreePath?` (with `cwd?` still accepted as a legacy alias), the three browser-open list actions (`forge.openIssues`/`forge.openPRs`/`forge.openCommits`) take `projectId?` / `projectPath?` and resolve against the current project's path, and `forge.validateToken` takes no location arg.

Two axes are independent — do not infer one from another:

- **`danger`** gates the user-facing confirm. `danger:"confirm"` dispatches the call unconfirmed so the human approves it host-side in the native `McpConfirmDialog` before the mutation fires (see [Risk bands and `danger`](#risk-bands-and-danger)); `danger:"safe"` does not. It says nothing about rate limit. `forge.createIssue` is `safe` while `forge.closeIssue` is `confirm`; `forge.approvePR` is `confirm` yet on the `standard` bucket while `forge.createPR` is `confirm` on `mutation`.
- **Rate limit** is the token bucket (`standard` 30/min, `mutation` 10/min). It is set per-id in `RATE_LIMIT_TOOL_MAP`, not derived from `danger` or write-intent — the browser-open commands `forge.openIssue`/`forge.openPR` are `safe` but `mutation`-bucketed because an LLM retry would pop a duplicate browser tab. There used to be a third, **External**, marking whether an action was in `MCP_TOOL_ALLOWLIST`. It is gone because the answer is now uniformly no: #11585 removed every `forge.*` id from the external surface, so reads and writes alike are reachable only through an in-app session at their stated tier, never by an API key. There is no setting that changes this — see [Tier model](#tier-model-sharedts).

### Forge reads (`workbench` tier)

All eight are in `WORKBENCH_TIER_TOOLS` (the help-assistant baseline), so they are reachable at `workbench` and above — but not at `external`. All are `kind:"query"`, `danger:"safe"`, on the `standard` bucket, and not deduped.

| Action ID | Key args |
| --- | --- |
| `forge.getRepoStats` | `bypassCache?`, `cwd?` |
| `forge.listIssues` | `search?`, `state?`, `perPage?`, `sort?`, `direction?`, `cursor?`, `view?`, `bypassCache?`, `cwd?` |
| `forge.listPRs` | `search?`, `state?`, `perPage?`, `sort?`, `direction?`, `cursor?`, `view?`, `bypassCache?`, `cwd?` |
| `forge.getIssue` | `issueNumber`, `cwd?` |
| `forge.listIssueComments` | `issueNumber`, `cursor?`, `perPage?`, `cwd?` |
| `forge.getPR` | `prNumber`, `cwd?` |
| `forge.getCIStatus` | `prNumber`, `cwd?` |
| `forge.getChecks` | `prNumber`, `cwd?` |

The two list actions are the only **strict** action schemas in the codebase (#11527): an unrecognized arg is a validation error, not a silently stripped key. That is deliberate — Zod's default strip meant `labels: [...]` or `limit: 10` came back as a confidently _unfiltered_ page, which an agent would then act on.

- **`search` is a provider-native query fragment**, not a plain-text filter. On GitHub it is issue-search syntax, so negation works where the structured `ListOptions` fields cannot express it: `search: "no:assignee -label:human-review"`. The provider trims it and appends it after the repo/type/state/sort qualifiers it generates, truncating to fit GitHub's 256-character query cap — so it is passed through unparsed, but not untouched. It routes through the search API, which has its own depth and rate ceilings, and its results are deliberately kept out of the list cache that plain paging is served from. `forge.listPRs` takes the same key with the PR dialect (#11897): state there is expressed as `is:open`/`is:closed`/`is:merged`, since GitHub's `state:` qualifier only accepts open/closed for pull requests. `is:closed` includes merged PRs on both paths, so adding a search term never changes which PRs a `state: "closed"` request means.
- **`view` defaults to `summary`**, which drops each row's `body` and `rawData` (the verbatim provider node) and flattens actors and labels to their names, keeping what is needed to choose an item — including `linkedPR`, which answers whether a PR is already working the issue. Pass `view: "full"` for the complete provider object. This is a runtime projection built in `run()`, not a schema effect: `dispatch()` never parses `resultSchema`, so a field stops being sent only when `run()` stops building it. Neither list action sets `mcpOutputSchema`, so their `resultSchema` is declarative metadata for readers of the definition rather than an advertised MCP `outputSchema` — deliberately, since `sessionServer` emits `structuredContent` _alongside_ the serialized text body, which would send every row twice and undo the projection's whole point.
- **`bypassCache` is the only escape from a warm list cache.** Providers cache list pages, so a change made outside the app — the user running a forge CLI in a terminal, another agent closing an issue — stays invisible until the entry ages out. Pass `bypassCache: true` to re-read; it costs a provider round trip, so leave it off for ordinary paging. Same knob as `forge.getRepoStats`.
- `perPage` is 1-100 (default 20), `sort` is `created`|`updated`, `direction` is `asc`|`desc`. Structured `labels`/`assignee` filtering is not yet wired provider-side; use `search`.

`forge.getCIStatus` and `forge.getChecks` are the only forge reads that set `mcpOutputSchema: true`, so they are also the only ones advertising an MCP `outputSchema` and returning `structuredContent`. Both wrap their result — as `{ ciStatus }` and `{ checks }` — rather than returning it bare: `buildToolOutputSchema` forwards only object-typed schemas, so a top-level nullable would silently advertise nothing. The handler projects the provider's `CIStatus` down to the roll-up fields and drops `rawData`/`freshnessToken`/`notModified` — `rawData` in particular is populated on a network fetch but `null` on a cache hit, so forwarding it would make the response depend on cache state. `forge.getChecks` drops per-check `rawData` too, though for a different reason: it bypasses that cache entirely, so its `rawData` is always populated — it is dropped because the verbatim provider node is not part of the advertised cross-provider schema.

The two answer different questions and are deliberately separate calls. `getCIStatus` is the cheap roll-up — "is this PR green?" — and stays the authority on that verdict. `getChecks` is the diagnostic follow-up — "which check failed, and where is its log?" (#11786) — and costs a request per 100 checks, since it pages the provider's check list to the end rather than returning a first page that might be short. Its three outcomes are distinct and must not be conflated: `{ checks: [] }` means the PR has no checks, `{ checks: null }` means no such PR, and a provider without the `checks` capability rejects.

### Forge writes and commands (`system` tier)

Every action below is in `SYSTEM_TIER_ADDONS` and requires the `system` tier (or a per-tool grant) to dispatch. All are `kind:"command"` except `forge.validateToken`, which is a non-mutating `query` that still lives in the system tier. Rows are in `SYSTEM_TIER_ADDONS` order.

| Action ID | Danger | Rate limit | Dedup | Key args |
| --- | --- | --- | --- | --- |
| `forge.openIssues` | safe | standard | no | `projectPath?`, `query?`, `state?` |
| `forge.openPRs` | safe | standard | no | `projectPath?`, `query?`, `state?` |
| `forge.openCommits` | safe | standard | no | `projectPath?`, `branch?` |
| `forge.openIssue` | safe | mutation | no | `issueNumber`, `cwd?` |
| `forge.openPR` | safe | mutation | no | `prNumber`, `cwd?` |
| `forge.assignIssue` | safe | mutation | no | `issueNumber`, `username`, `cwd?` |
| `forge.unassignIssue` | safe | standard | no | `issueNumber`, `username`, `cwd?` |
| `forge.approvePR` | confirm | standard | yes | `prNumber`, `body?`, `cwd?` |
| `forge.requestChanges` | confirm | standard | yes | `prNumber`, `body`, `cwd?` |
| `forge.dismissReview` | confirm | standard | no | `prNumber`, `reviewId`, `message`, `cwd?` |
| `forge.requestReviewers` | confirm | standard | no | `prNumber`, `users?`, `teams?` (at least one), `cwd?` |
| `forge.createPR` | confirm | mutation | yes | `head`, `base`, `title`, `body?`, `draft?`, `cwd?` |
| `forge.closePR` | confirm | mutation | no | `prNumber`, `cwd?` |
| `forge.reopenPR` | confirm | mutation | no | `prNumber`, `cwd?` |
| `forge.mergePR` | confirm | mutation | yes | `prNumber`, `mergeMethod?`, `commitTitle?`, `commitMessage?`, `cwd?` |
| `forge.convertPRToDraft` | confirm | mutation | no | `prNumber`, `cwd?` |
| `forge.markPRReadyForReview` | confirm | mutation | no | `prNumber`, `cwd?` |
| `forge.commentOnPR` | confirm | mutation | yes | `prNumber`, `body`, `cwd?` |
| `forge.editPR` | confirm | mutation | no | `prNumber`, `title?`, `body?` (at least one), `cwd?` |
| `forge.createIssue` | safe | standard | yes | `title`, `body?`, `labels?`, `cwd?` |
| `forge.closeIssue` | confirm | standard | no | `issueNumber`, `stateReason?`, `cwd?` |
| `forge.reopenIssue` | safe | standard | no | `issueNumber`, `cwd?` |
| `forge.editIssue` | confirm | standard | no | `issueNumber`, `title?`, `body?` (at least one), `cwd?` |
| `forge.addIssueComment` | safe | standard | yes | `issueNumber`, `body`, `cwd?` |
| `forge.addIssueLabel` | safe | standard | no | `issueNumber`, `label`, `cwd?` |
| `forge.removeIssueLabel` | safe | standard | no | `issueNumber`, `label`, `cwd?` |
| `forge.validateToken` | safe | standard | no | `providerId`, `token` |

No forge action — read or write — is reachable at the `external` tier. The table used to carry an `External` column because the split ran down the middle of this list; #11585 removed the whole forge surface from `MCP_TOOL_ALLOWLIST`, so the column was uniformly `no` and is gone. The reasoning is not that forge writes are too dangerous for an API-key caller (the `system` tier runs them under the same confirm gate) but that an external agent driving Daintree over MCP already has `gh` or its provider's own tooling, and every slot on a capped surface has to earn its place against something only Daintree can do. That also retired a real drift hazard: forge placement used to be curated by hand in two files with nothing linking them, which shipped a tool invisible to one caller class twice (#10696, #11545). There is now one forge list.

Adding a forge action is therefore an edit to `SYSTEM_TIER_ADDONS` (or `WORKBENCH_TIER_TOOLS` for a read) and nothing else; the `forge.rateLimit` test and the tier snapshots guard against drift.

## Submitting input (`terminal.sendCommand`)

`terminal.sendCommand` is how an agent puts text into a terminal — a shell command for a plain pane, or the next prompt/turn for an agent pane (Claude/Codex/Gemini/…). The name is shell-flavoured for historical reasons; the operation is "submit this text to whatever owns the PTY". It routes through `terminalClient.submit` → `TerminalProcess.performSubmit`, which is the load-bearing detail: the body is delivered as **one atomic bracketed paste** (or, on agents without bracketed-paste support, the body with interior `\n` rewritten to the agent's soft-newline) followed by **exactly one Enter**. So multi-line text is safe — embedded newlines insert line breaks and never prematurely submit a partial message — and a trailing newline is the submit Enter (N trailing newlines send N times). The call is **fire-and-return**: it does not block on the agent's reply, so it carries none of the `waitUntilIdle` conversation-hostage constraint below. The right decomposition for "send and read the answer" is `sendCommand` then a separate `terminal.getStatus`/`waitUntilIdle` poll, not a single blocking call. `sendCommand` sets `denyPluginDispatch` — plugins must declare `agent:input` and use `host.sendToActiveAgent(...)` rather than routing input through this `safe` action (#10558).

## The `waitUntilIdle` handshake (`waitUntilIdle.ts`)

`terminal.waitUntilIdle` is the agent-orchestration primitive: an orchestrator agent kicks off a task in another terminal, then waits on `waitUntilIdle` until that agent's FSM leaves the `working` state (or the wait times out — `timedOut: true` means "still working, re-poll"), before issuing its next dispatch. It is the synchronization point between independent agents.

A blocking MCP call holds the whole conversation hostage in an interactive session — the user can't talk to the assistant until the call returns, so the session looks frozen and escape-cancel is their only out. The wait is therefore a **bounded long-poll**, not an open-ended block: the default is `DEFAULT_WAIT_UNTIL_IDLE_TIMEOUT_MS` (60s), and the `CallTool` handler clamps the effective ceiling by session tier — interactive help sessions (workbench/action/system) are capped at `INTERACTIVE_WAIT_UNTIL_IDLE_TIMEOUT_CAP_MS` (60s) regardless of the requested `timeoutMs`, while headless `external` (api-key) sessions may block up to `MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS` (2h). Agents in interactive sessions are steered (via the help CLAUDE.md and the `triage_terminals` prompt) to `ScheduleWakeup`-paced non-blocking checks instead of back-to-back long-polls.

It is special-cased in the `CallTool` handler to run **in the main process** rather than through `rendererBridge`, because (a) the MCP `AbortSignal` can't cross IPC, and (b) renderer dispatch has a 30s wall — too short for the multi-hour waits external sessions may request. The implementation:

1. Resolves the terminal's agent id via `AgentAvailabilityStore.getAgentIdForTerminal`. No agent → immediate `idle`.
2. If already non-`working`, returns immediately (`already-idle`).
3. Otherwise subscribes to `events.on("agent:state-changed")` and settles on the first transition away from `working`, or on `timeoutMs` (default `DEFAULT_WAIT_UNTIL_IDLE_TIMEOUT_MS`, capped at the tier-resolved ceiling above), or on abort.

The returned `busyState`/`idleReason`/`waitingReason` are mapped from the canonical `AgentState` FSM (`mapAgentStateToBusyState`, `mapAgentStateToIdleReason`). The FSM and the `agent:state-changed` event it consumes are owned by `AgentStateService` — see [`agent-activity-monitoring.md`](./agent-activity-monitoring.md). For polling _many_ terminals at once, the `triage_terminals` prompt steers agents to `terminal.getStatus` instead of fanning `waitUntilIdle` out N ways.

## Fleet-run supervision (`fleet.getRunStatus`)

The in-app fleet broadcast is supervised past submission (#10930): `fleetRunStore` (renderer) tracks each structured broadcast as a run — per-target submission outcome (`sent` / `failed` with the permanent-vs-transient classification / `skipped` on cancel), a live agent-state snapshot per target, and a `watching` phase that finalizes once every sent target leaves `working`/`directing` (`waiting` counts as settled, mirroring `waitUntilIdleBatch`). Finalized runs append a durable `runHistory` record carrying `runId`, run `status`, and per-target `failureKind`/`finalAgentState`.

`fleet.getRunStatus` is the read-only MCP window onto that run: workbench tier and the external allowlist, `readOnlyHint`, structured `outputSchema`, no args. It reports the run owned by the dispatching window and never dispatches anything. The broadcast itself is deliberately NOT MCP-exposed (`terminal.bulkCommand` stays renderer-only on every tier) — an external orchestrator fans out `terminal.sendCommand` per terminal and watches with batched `terminal.getStatus` / bounded `waitUntilIdleBatch`, per the `triage_terminals` prompt and `CLAUDE.tasks.md` guidance.

## Guard rails and observability

- **`abusePolicy.ts`** — per-session sliding-window counter shared by `401`s and tier-mismatches (`abusePolicyMaxDenials` within `abusePolicyWindowMs`). Tripping revokes the session and notifies the pinned renderer (`MCP_SESSION_REVOKED`). The counter map is dropped on every per-session cleanup hook so it can't grow unbounded across session churn, and wiped wholesale on stop/restart.
- **`auditLog.ts`** (`AuditService`) — ring buffer of `McpLogRecord`s persisted to the `mcpServer` store key, debounced (`AUDIT_FLUSH_DEBOUNCE_MS`). Every gate outcome above is recorded. Derives anomaly signals: first-seen `(tool, tier)` combos, latency drift, failure clusters, p95 z-score. Grant lifecycle events and `tier.decayed` are appended here too.
- **`turnOutcomeLog.ts`** (`TurnOutcomeService`) — classifies each help-session assistant _turn_ into a `TurnOutcomeClass` (`answered`, `hedged`, `refused`, `docs-empty`, `tier-rejected`, `mcp-not-ready`, `agent-stuck`, `tool-error`, `reasoning-loop`, `hibernate-resume-stale`, `unknown`) by correlating `agent:state-changed` FSM transitions and recent agent output with the audit records for that session. Wired via long-lived `persistentListeners` that deliberately survive `HttpLifecycle.stop()`/restart.
- **`readinessProbe.ts`** — `probeMcpServer` / `probeMcpSseServer` POST a real MCP `initialize` and require HTTP 200 + a `mcp-session-id` header, then DELETE the probe session so it doesn't linger. Used by `HelpSessionService` before writing `.mcp.json` and launching the assistant — `isRunning` only proves the socket is bound, not that the handler answers. The probe self-cleans on success.
- **`httpLifecycle.ts`** — bind (`listenWithRetry` over `DEFAULT_PORT`…`+MAX_PORT_RETRIES`), supervised restart with exponential backoff (`MAX_RESTART_ATTEMPTS`, `RESTART_BASE_DELAY_MS` … `RESTART_MAX_DELAY_MS`, jitter, `RESTART_STABLE_RESET_MS`), and graceful teardown (`stop()` drains in-flight requests within `MCP_STOP_DRAIN_TIMEOUT_MS` before force-closing sockets). On an _unexpected_ close it drains sessions, wipes bearers + abuse state, and rejects pending manifest/dispatch promises.
- **`rendererBridge.ts`** — owns manifest fetch + action dispatch over IPC, with the cached manifest and per-session pinning. A dispatch to a destroyed pinned view throws `SessionBindingError` (`SESSION_BINDING_GONE`, "do not retry") rather than silently routing to another window.

## Where it's started

`mcpServerService` is a singleton. It is started from `globalServicesInit.ts` (the deferred `mcp-server` task) and on demand by `HelpSessionService.ensureMcpServerReady()` and the terminal-lifecycle handler (`mcpServerService.ensureReady()`). `setEnabled`/`setPort`/`rotateApiKey` are driven from the settings tab over IPC. Config (enabled flag, port, API key, audit + turn-outcome logs) lives under the `mcpServer` store key.

## See also

- [`action-system.md`](./action-system.md) — the `ActionService`, `ActionDefinition`, and `BuiltInActionId` surface every MCP tool maps onto.
- [`destructive-action-safeguards.md`](./destructive-action-safeguards.md) — the `danger` tier model and the per-action confirm audit that the MCP host-confirmation gate participates in.
- [`agent-activity-monitoring.md`](./agent-activity-monitoring.md) — `AgentStateService`, the agent FSM, and the `agent:state-changed` events that `waitUntilIdle` and `TurnOutcomeService` consume.
- [`docs/plugins/`](../plugins/) — the _outbound_, plugin-authored MCP servers (distinct from this server).
