# Daintree MCP server (agent → IDE control surface)

## Purpose

Daintree ships its own local **MCP (Model Context Protocol) HTTP server** that lets an external agent — or Daintree's own in-app help assistant — drive the IDE programmatically. Every tool the server exposes is a [built-in action](./action-system.md): a `tools/call` request resolves to an `ActionService.dispatch(actionId, args)` in a renderer, and the dispatch result is serialized back as the tool result. The server is `daintree`'s control plane for agents; it is **inbound** — agents call _into_ the IDE.

Do not confuse this with the two outbound MCP concepts in the plugin docs:

| Concept | Direction | Owner | Docs |
| --- | --- | --- | --- |
| **Daintree MCP server** (this doc) | agent → IDE | `electron/services/McpServerService.ts` + `electron/services/mcp-server/` | here |
| Plugin-authored MCP servers | IDE → external MCP server | plugin process, supervised | [`docs/plugins/`](../plugins/) |
| Plugin-MCP supervisor | spawns/monitors plugin servers | host | [`docs/plugins/architecture.md`](../plugins/architecture.md) |

This server is **security-load-bearing**: it accepts network connections (loopback only) and turns them into privileged IDE mutations (commit, push, delete worktree, launch agents). The auth ladder, tier model, per-tool grants, rate limits, and abuse policy below are the gates that keep an agent from doing more than the user authorized. The whole subsystem is ~7.5K LOC across `electron/services/mcp-server/` plus the `McpServerService` orchestrator.

## File map

| File | LOC | Role |
| --- | --- | --- |
| `McpServerService.ts` (parent dir) | ~615 | Top-level orchestrator. Owns `SessionStore`, `AuditService`, `TurnOutcomeService`, `HttpLifecycle`, `AbusePolicy`, renderer bridge; exposes IPC-facing methods (`setEnabled`, `rotateApiKey`, `setSessionTier`, `issueGrant`, `disconnectBearer`). Singleton `mcpServerService`. |
| `httpLifecycle.ts` | ~1379 | The HTTP server itself: bind/teardown, supervised restart, the `handleRequest` auth+routing gate, bearer register, session pinning, tier-elevation and grant IPC. |
| `sessionServer.ts` | ~1120 | Per-session MCP `Server` instance — `tools/list`, `tools/call`, resources, prompts. The `CallTool` handler is the end-to-end dispatch pipeline (tier → grant → rate-limit → dedup → confirm → dispatch → audit). |
| `shared.ts` | ~881 | Tier model (`McpTier`, `TIER_ALLOWLISTS`), constants (TTLs, ports, timeouts), error codes/envelopes, dedup + rate-limit config, resource URIs, prompt definitions. |
| `sessionStore.ts` | ~664 | Per-session state: SSE + Streamable-HTTP session maps, tier map, idle timers, `GrantCache`, dedup caches, rate-limit buckets, WebContents/context pins. |
| `auditLog.ts` | ~606 | Ring-buffer audit log + anomaly signals (first-seen combos, latency drift, failure clusters, p95 z-score). Persisted to the `mcpServer` store key. |
| `turnOutcomeLog.ts` | ~476 | Classifies each help-session assistant _turn_ (`answered`/`refused`/`tool-error`/…) by correlating FSM transitions with recent audit records. |
| `grantCache.ts` | ~417 | Per-`(sessionId, toolId)` time-bounded "Approve once" grants — issue/check/refresh/revoke, sliding TTL + hard ceiling, denial-suppression counters. |
| `rendererBridge.ts` | ~340 | IPC bridge to the renderer: requests the action manifest and dispatches actions, with per-session pinning (`SessionBindingError` when the pinned view is gone). |
| `tierAuth.ts` | ~214 | Auth primitives: bearer extraction, timing-safe API-key compare, tier resolution, `shouldExposeTool`/`isTierPermitted`, tool schema/annotation builders, `requestKey` parsing. Re-exports `deriveBand`/`BAND_OVERRIDES`. |
| `readinessProbe.ts` | ~522 | Active `initialize` round-trip probe (`/mcp` and `/sse`) proving the server actually answers, not just that the socket is bound. Used by `HelpSessionService` before launching the assistant. |
| `waitUntilIdle.ts` | ~193 | The `terminal.waitUntilIdle` handshake — blocks until an agent FSM leaves `working`. Runs in main, not via renderer dispatch. |
| `abusePolicy.ts` | ~67 | Per-session sliding-window denial counter (401 + tier-mismatch). Trips → revoke session. |
| `sessionDedup.ts` | ~88 | Idempotency keys + canonical args hashing for the creation-tool dedup cache. |

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
| `external` | `MCP_TOOL_ALLOWLIST` — the full vetted tool set for API-key callers (when `fullToolSurface` is on, `external` may bypass the allowlist entirely). |

`shouldExposeTool` (used by `tools/list`) and `isTierPermitted` (used by `tools/call`) are the two gates. Both **hard-deny `danger === "restricted"`** and any tool whose `mcpVisibility` is `hidden` or `discoverable` — `restricted` actions are never reachable over MCP regardless of tier.

### Risk bands and `danger`

`deriveBand` / `BAND_OVERRIDES` / `RISK_BAND_OPEN_WORLD_CATEGORIES` (`shared/utils/actionRiskBand.ts`) classify each action into a `RiskBand` (`reversible` | `external-effect` | `destructive-local` | `destructive-network`) from its `danger` + `category`, with per-id overrides (`git.push` → `external-effect`, `copyTree.generateAndCopyFile` → `destructive-local`). The band drives the renderer's blast-radius preview and the MCP tool annotations (`buildAnnotations`).

How `danger` interacts with tier gating:

- `danger: "restricted"` — never exposed, never dispatchable over MCP (hard floor in `shouldExposeTool`/`isTierPermitted`).
- `danger: "confirm"` — _exposed and dispatchable_ if the tier permits, but the `CallTool` handler routes it through an **MCP elicitation confirmation** when the client supports `elicitation.form`. This is the MCP-side wiring of the same confirm gate documented in [`destructive-action-safeguards.md`](./destructive-action-safeguards.md): `danger:"confirm"` classifies the action; the elicitation prompt is the user-facing confirm before the mutation fires.

## Session lifecycle (`sessionStore.ts`, `httpLifecycle.ts`)

A session is created on transport open: SSE sessions live in `SessionStore.sessions`, Streamable-HTTP in `SessionStore.httpSessions`. At handshake `httpLifecycle`:

1. Resolves and records the tier (`sessionTierMap`).
2. Registers client metadata + the bearer in `bearerRegister` (`touchBearer`).
3. Pins the WebContents (`sessionWebContentsMap`) and `ActionContext` (`sessionContextMap`) for help bearers.
4. Builds the per-session `SessionServerDeps` and calls `createSessionServer`.
5. Arms an idle timer (`MCP_SSE_IDLE_TIMEOUT_MS`, 30 min).

`transport.onclose` tears everything down: clears the idle/elevation timers, deletes the tier, revokes the session's grants (`grantCache.revokeSession(..., "session-ended")` — _before_ dropping the WebContents pin so the lifecycle emitter can still target the pinned renderer), clears dedup + rate-limit + client metadata, drops abuse state, and detaches the bearer.

The **idle reaper** is awake-time corrected (`SystemSleepService.getAwakeTimeSince` / `recomputeIdleTimers` on wake) so suspend time doesn't count against the 30-minute window.

### Bearer register

`HttpLifecycle.bearerRegister` is the live view of every connected client (keyed by token hash, never the raw token). It backs the settings tab's `listActiveBearers()` (display suffix + hash only) and `disconnectBearer(tokenHash)`, which revokes every session a bearer owns and evicts it. Help bearers are tracked but filtered out of `listActiveBearers`; `disconnectHelpBearer(rawToken)` tears them down eagerly when the help session is revoked rather than waiting for the idle reaper.

### Tier elevation vs. per-tool grants

Two distinct mechanisms widen what a session can do past its baseline:

- **Session-tier elevation** ("Always allow"): `setSessionTier(sessionId, tier)` raises the whole session's tier. It silently decays back to `workbench` after `MCP_TIER_ELEVATION_TTL_MS` (30 min, awake-corrected) so a stale "Always allow" can't outlive intent across hibernate/project-switch. On decay, `onTierDecayed` pushes `tools/list_changed` and writes a `tier.decayed` audit record.
- **Per-tool grants** ("Approve once"): `GrantCache` mints a `(sessionId, toolId)` grant authorizing _one_ tool without elevating the session. It has a **sliding TTL** (`MCP_GRANT_TTL_MS`, 15 min, refreshed on each successful dispatch through the grant) and a **hard wall-clock ceiling** (`MCP_GRANT_MAX_LIFETIME_MS`, 30 min from `issuedAt`) so a model calling more often than once per TTL can't hold a grant forever. The `issuedAt` field doubles as a race token: a `refresh` carrying a stale `issuedAt` (the grant was revoked and re-issued mid-dispatch) is a silent no-op, so a winning revoke is never resurrected (lesson #2243). All three TTLs are intentionally ≤ the 30-minute SSE idle timeout so a grant/elevation can never silently outlive its session.

`minimumPermittingTier(toolId)` computes the lowest non-`external` tier that would permit a denied tool, so the renderer's "Approve once" / "Always allow" buttons target the _narrowest_ sufficient tier rather than blanket-elevating to `system`.

## End-to-end `tools/call` flow (`sessionServer.ts`)

The `CallTool` handler is a fixed-order gate chain. Each gate that denies writes an audit record and returns a structured tool-error (`buildToolError`) — never a silent skip.

```
tools/call(actionId, args)
  │
  ├─1 Tier floor: isTierPermitted(tier, actionId, fullToolSurface)?
  │      └─ no → grantCache.check(sessionId, actionId)
  │             ├─ granted → proceed (capture issuedAt for post-dispatch refresh)
  │             └─ denied  → incrementDenial → maybe notifyTierMismatch (banner,
  │                          suppressed after MCP_DENIAL_SILENCE_THRESHOLD) →
  │                          recordDenial(abusePolicy); if tripped → revokeSession →
  │                          return TIER_NOT_PERMITTED
  │
  ├─2 Rate limit: consumeRateLimitToken(sessionId, actionId)
  │      └─ empty bucket → return MCP_RATE_LIMITED (retryAfter; retriable)
  │
  ├─3 Dedup (creation-tool allowlist only):
  │      ├─ cached result within TTL & same args → return cached (audit: dedup)
  │      ├─ same key, different args → return MCP_DEDUP_KEY_COLLISION
  │      └─ in-flight same key → await shared promise (singleflight)
  │
  ├─4 Confirm: entry.danger === "confirm" & client supports elicitation.form
  │      └─ runElicitationConfirmation → approved | rejected (USER_REJECTED) |
  │         failed (ELICITATION_FAILED)
  │
  ├─5 Dispatch:
  │      ├─ terminal.waitUntilIdle → handleWaitUntilIdle (main process, see below)
  │      └─ else → rendererBridge.dispatchAction(actionId, args, confirmed)
  │              └─ pinned view gone → SESSION_BINDING_GONE (do not retry)
  │
  ├─6 On success through a grant → grantCache.refresh + reset idle timer
  │
  └─7 Audit: appendAuditRecord({ toolId, tier, args, durationMs, outcome })
```

Gate order is load-bearing: rate-limit is charged **after** the tier/grant check (an unauthorized call shouldn't consume tokens) but **before** dedup (dedup is an idempotency guard, not a rate-limit bypass — a tight loop replaying one dedup key must still be bounded).

### Rate limits and dedup

- **Rate limits** (`RATE_LIMIT_TIERS`, `RATE_LIMIT_TOOL_MAP`): per-`(session, toolId)` token bucket. `highFreqRead` (60/min) for cheap polling, `standard` (30/min) default, `mutation` (10/min) for side-effecting tools (commit, push, issue/PR, worktree.delete, snapshot revert/delete).
- **Dedup** (`MCP_DEDUP_ALLOWLIST`): only creation/destructive tools where an LLM retry would produce a visible duplicate (orphan terminal, duplicate commit, duplicate PR). Keyed by a caller-supplied `requestKey` (prefixed with `actionId`, capped at `MAX_REQUEST_KEY_LENGTH`) or an auto canonical args hash, with an args-hash collision guard (#8429). TTL `MCP_DEDUP_TTL_MS` (120s), FIFO-capped at `MCP_DEDUP_MAX_ENTRIES_PER_SESSION` (256).

## The `waitUntilIdle` handshake (`waitUntilIdle.ts`)

`terminal.waitUntilIdle` is the agent-orchestration primitive: an orchestrator agent kicks off a task in another terminal, then **blocks** on `waitUntilIdle` until that agent's FSM leaves the `working` state, before issuing its next dispatch. It is the synchronization point between independent agents.

It is special-cased in the `CallTool` handler to run **in the main process** rather than through `rendererBridge`, because (a) the MCP `AbortSignal` can't cross IPC, and (b) renderer dispatch has a 30s wall — far too short for the default 30-minute wait. The implementation:

1. Resolves the terminal's agent id via `AgentAvailabilityStore.getAgentIdForTerminal`. No agent → immediate `idle`.
2. If already non-`working`, returns immediately (`already-idle`).
3. Otherwise subscribes to `events.on("agent:state-changed")` and settles on the first transition away from `working`, or on `timeoutMs` (default `DEFAULT_WAIT_UNTIL_IDLE_TIMEOUT_MS`, capped at `MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS`), or on abort.

The returned `busyState`/`idleReason`/`waitingReason` are mapped from the canonical `AgentState` FSM (`mapAgentStateToBusyState`, `mapAgentStateToIdleReason`). The FSM and the `agent:state-changed` event it consumes are owned by `AgentStateService` — see [`agent-activity-monitoring.md`](./agent-activity-monitoring.md). For polling _many_ terminals at once, the `triage_terminals` prompt steers agents to `terminal.getStatus` instead of fanning `waitUntilIdle` out N ways.

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
- [`destructive-action-safeguards.md`](./destructive-action-safeguards.md) — the `danger` tier model and the per-action confirm audit that the MCP elicitation gate participates in.
- [`agent-activity-monitoring.md`](./agent-activity-monitoring.md) — `AgentStateService`, the agent FSM, and the `agent:state-changed` events that `waitUntilIdle` and `TurnOutcomeService` consume.
- [`docs/plugins/`](../plugins/) — the _outbound_, plugin-authored MCP servers (distinct from this server).
