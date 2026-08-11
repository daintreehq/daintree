# IPC, services & clients reference

This document maps the backend and bridge surface that connects the Renderer to the Main process: ~130 top-level services in `electron/services/`, ~105 top-level IPC handler files in `electron/ipc/handlers/`, ~71 namespaces exposed across the `window.electron` bridge in `electron/preload.cts`, and ~32 typed client wrappers in `src/clients/`. The goal is to make the conventions durable so a feature author knows which layer to touch and why.

For the mechanical "add a channel" recipe, see the [IPC pattern checklist in development.md](../development.md#ipc-pattern). This doc documents the layering, the wire mechanics, error propagation, and where the major service clusters live — it does not duplicate the five-step recipe.

## The layered flow

The canonical data path is **Service → IPC → Store → UI** (and the reverse for commands). Each arrow is a hard boundary:

```
┌─────────────────────────── Renderer (V8 per project view) ───────────────────────────┐
│  Component ──> Zustand store ──> src/clients/<x>Client ──> window.electron.<ns>.<m>()  │
└───────────────────────────────────────────│──────────────────────────────────────────┘
                                             │  contextBridge (electron/preload.cts)
                                  ipcRenderer.invoke / .on
                                             │
┌─────────────────────────────────── Main process ─────────────────────────────────────┐
│  ipcMain.handle wrapper (setup/security.ts) ──> handler (ipc/handlers/<domain>.ts)     │
│        └──> service (electron/services/<x>) ──> node-pty / simple-git / fs / network   │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

**Main never imports renderer.** Main-process code (`electron/`) must not import from `src/`. The renderer reaches Main only through the typed clients and `window.electron`, never by importing a service. This is documented as a rule in [development.md](../development.md#code-patterns) and is what keeps the two V8 contexts independent.

### When a feature needs a service vs an inline handler

- **Inline handler** (`electron/ipc/handlers/<domain>.ts`) — when the operation is a thin, stateless bridge: read a value, call one library function, return. The handler body _is_ the logic. Most of the ~105 handler files are this thin.
- **Service** (`electron/services/<x>.ts` or a cluster directory) — when there is durable state, a process/resource to own (a node-pty host, a poll loop, a cache), cross-handler reuse, or lifecycle (init/dispose) to manage. Handlers then become thin adapters that call the service. Examples: `CopyTreeService`, `GitService`, `DevPreviewSessionService`, `HibernationService`.

Rule of thumb: if two handlers would need the same logic, or the logic outlives a single IPC call, it belongs in a service.

## IPC mechanics

There are two transport shapes, and they return different things:

| Shape | Renderer side | Main side | Returns | Use for |
| --- | --- | --- | --- | --- |
| **invoke / handle** | `ipcRenderer.invoke` | `ipcMain.handle` | `Promise<result>` | Request/response — read, mutate, query |
| **send / on** | `ipcRenderer.on` | `webContents.send` / broadcast | a **cleanup** `() => void` | Events — pushes from Main to Renderer |

Every `on*` method on `window.electron` returns its own unsubscribe function. Renderer subscribers (stores, hooks) **must** call it on teardown — the convention is `useEffect(() => clientCleanup, [])`.

### Channels

Channel strings are a single source of truth: `CHANNELS` in `electron/ipc/channels.ts` (~880 lines, one `as const` object). Preload, handlers, and the event bus all import from it — never hand-write a channel literal at a call site.

### The typed contract

The handler signature and the preload binding are both constrained by the shared `IpcInvokeMap` (request/response) and `IpcEventMap` / `IpcEventBusMap` (events) in `shared/types/ipc/`. Wiring is done via the declare-once helpers in `electron/ipc/define.ts`:

- `defineIpcNamespace({ name, ops })` colocates channel strings, handler implementations, and the preload binding shape in one definition. Its `op(channel, handler)` / `opValidated(channel, schema, handler)` entries are type-checked against `IpcInvokeMap[channel]`. `register()` wires `ipcMain.handle` for every op and returns a cleanup; `preloadBindings(invoke)` produces the matching renderer-side object. The `build*PreloadBindings(...)` functions imported at the top of `electron/preload.cts` are these namespace bindings.
- Lower-level handlers register through `typedHandle` / `typedHandleWithContext` (and `*Validated` variants) in `electron/ipc/utils.ts`. The `WithContext` forms receive an `IpcContext` (`{ event, webContentsId, senderWindow, projectId }`, from `electron/ipc/types.ts`) so a handler can scope to the calling project view in the multi-window architecture.

### The envelope and the global wrapper

`enforceIpcSenderValidation()` (`electron/setup/security.ts`) monkey-patches `ipcMain.handle` / `handleOnce` / `on` **once at bootstrap, before any handler registers**. Every handler is therefore wrapped to:

1. **Reject untrusted senders** — `event.senderFrame.url` must pass `isTrustedRendererUrl`; otherwise the call returns an error envelope (or, for `on` channels, is silently dropped).
2. **Validate the invoke envelope** — arg-count cap and per-category byte budget (`validateIpcInvokeEnvelope`).
3. **Wrap the return** — success becomes `{ __daintreeIpcEnvelope: true, ok: true, data }`; a thrown error becomes `{ ...ok: false, error: serializedError }`.

Ordering is enforced by `assertIpcSecurityReady(channel)` (`electron/ipc/ipcGuard.ts`), called at every registration site — registering a handler before the wrapper is installed is a hard startup crash that names the offending channel, not a silent security gap.

Because the wrapper auto-wraps `{ok: true, data}`, a handler that _returned_ `{ok: false, ...}` would be silently nested inside a success envelope. `define.ts` forbids this at the type level via `ForbidIpcEnvelopeKeys<Result>` (the `SafeResult` constraint) — such handlers must `throw` instead.

On the renderer side, `_unwrappingInvoke` in `electron/preload.cts` unwraps the envelope: `ok: true` returns `data`; `ok: false` reconstructs and **throws** the error (special-casing `AppError` and `GitOperationError`, else `deserializeError`). So renderer callers see a resolved value or a thrown typed error — they never inspect the envelope themselves.

### The event bus

High-frequency and migrated per-domain events funnel through a single `ipcRenderer` listener on `CHANNELS.EVENTS_PUSH`, multiplexed by event name in the preload (`_eventBusOn`, ref-counted per name). This keeps the `ipcRenderer` listener count at exactly 1 so Node's `MaxListenersExceededWarning` (10/channel) can't trip as more events migrate onto the bus. A small replay buffer (`_eventBusReplayable`, currently just `plugin:deep-link`) delivers a latest-wins signal to a late-mounting subscriber.

### Zod validation

Structural validation lives at the IPC boundary. `opValidated` / `typedHandle*Validated` parse the first arg with a Zod schema (`electron/schemas/`: `ipc.ts`, `plugin.ts`, `agent.ts`, `customSchemes.ts`, `external.ts`) before the handler body runs. On parse failure the full Zod issue list is logged **locally in Main only**, and a sanitized `ValidationError` (channel name only — no schema shape, field paths, or user values) is thrown to the renderer. Semantic checks (path containment, access control) still belong inside the handler; `opValidated` only enforces structure.

### Rate limiting

`electron/ipc/utils.ts` also owns rate-limit primitives used by expensive handlers: a sliding-window `checkRateLimit` / `waitForRateLimitSlot(key, maxCalls, windowMs)` and a strict-interval leaky bucket `waitForRateLimitSlot(key, intervalMs)` (used for smooth-cadence git worktree creation). `channelToCategory` groups related channels (`fileOps`, `gitOps`, `terminalSpawn`, …) under a shared budget. Queues drain to rejection on shutdown (`drainRateLimitQueues`).

## The client layer (`src/clients/`)

~32 typed wrappers (barrel: `src/clients/index.ts`) sit between stores/components and `window.electron`. Each is a plain `const xClient = { ... } as const` of typed methods that forward to `window.electron.<namespace>`.

**When a feature warrants a client:** when the renderer touches a namespace from more than one place, when the call needs renderer-side shaping the raw bridge doesn't provide (caching with invalidation — `projectClient`'s `invalidateCurrentCache`, `globalEnvClient`'s `invalidateGlobalEnvCache`), or when one logical operation routes across multiple bridge methods. `worktreeClient` is the canonical example: `getAll`/`refresh` forward straight through, but `delete`, `resourceAction`, and `retrySetup` route through `window.electron.worktreePort.request(...)` (the dedicated worktree MessagePort) so a host crash mid-call rejects immediately and `mutationId` dedupes outbox replays — a detail no caller should have to know.

**When to call `window.electron` directly:** a one-off call from a single component with no shaping. The development.md recipe phrases step 5 as "add a typed wrapper _if complex_" — the client layer is opt-in, not mandatory for every channel.

## Error propagation

Services throw **typed** errors — `AppError` (with an `AppErrorCode`) and `GitOperationError` from `electron/utils/errorTypes.ts`. The flow:

1. A service throws. The handler either lets it propagate or catches and re-throws.
2. The global `ipcMain.handle` wrapper serializes it into an `ok: false` envelope. In a packaged build it scrubs `stack`, `path`, `context`, `cause`, `properties` and sanitizes the message before it leaves Main.
3. `_unwrappingInvoke` (preload) reconstructs `AppError` / `GitOperationError` and **throws** in the renderer, so the awaiting caller sees a typed rejection.

Separately, durable user-facing errors are **pushed** from Main as `ErrorRecord`s over the `errors` event channel. The renderer subscribes via `errorsClient.onError` (`src/clients/errorsClient.ts`), wired in `src/hooks/useErrors.ts`, which feeds `src/store/errorStore.ts` for display, retry (`retry` / `cancelRetry` / `onRetryProgress`), and dismissal. This is the _recoverable_ error path.

The _fatal_ path — crashes, hung shutdown, the dirty-exit marker, crash-recovery banners — is a separate spine documented in [fatal-error-spine.md](./fatal-error-spine.md). When a feature must survive or report a process-level crash, that spine (not `errorStore`) is the relevant subsystem.

## Multi-process topology

Not all "services" run in the Main process. Two heavy subsystems run in their own Node processes and are reached from Main via client shims:

| Process | Entry | Renderer-facing client (in Main) | Owns |
| --- | --- | --- | --- |
| **PTY host** | `electron/pty-host.ts`, `electron/pty-host/` | `PtyClient` (`electron/services/pty/`) | node-pty processes, backpressure, `FdMonitor`, `ResourceGovernor` |
| **Workspace host** | `electron/workspace-host.ts`, `electron/workspace-host/` | `electron/services/workspace-client/` (`WorkspaceHostPool`, `WorkspaceHostEventRouter`) | `WorkspaceService` git polling, `WorktreeMonitor`, PR integration |

These hosts keep expensive/risky work off the Main thread; a host crash is isolated and recoverable. The renderer's worktree mutations route through a dedicated MessagePort (`window.electron.worktreePort`) rather than ordinary invoke channels, so a host crash rejects in-flight requests with `HOST_EXITED` instead of leaving promises pending. The cross-process request/response correlation primitive lives in `electron/services/rpc/RequestResponseBroker.ts`.

## A tour of the major service clusters

Top-level files live directly in `electron/services/`; cohesive subsystems get a subdirectory with its own `index.ts`. Where to look:

- **`pty/`** (~58 files) — agent terminal brain. `PtyClient` (host transport + correlation), `AgentStateService` / `AgentStateMachine`, `AgentPatternDetector`, `CompletionDetector`/`CompletionTimer`, `BootDetector`, `agentSessionHistory`, `PtyEventRouter`/`PtyEventsBridge`/`PtyEventBuffer`. This is where output heuristics turn raw PTY bytes into idle/working/waiting/completed state.
- **`git/`** + top-level `GitService.ts` / `GitServiceCache.ts` — simple-git operations, porcelain conflict parsing (`porcelainConflicts.ts`, `conflictMarkerScan.ts`), repo operation state.
- **`worktree/`** + `workspace-client/` — worktree polling strategy, mood/notes readers; the `workspace-client/` shims that talk to the workspace host.
- **DevPreview (`DevPreview*.ts`, 7 top-level files)** — `DevPreviewSessionService`, `DevPreviewProxyService`, `DevPreviewPortAllocator`, `DevPreviewReadinessProbe`, `DevPreviewManifestService`, `DevPreviewCommandNormalizer`, `DevPreviewRequestValidators`. Event routing for this cluster has its own doc: [dev-preview-event-routing.md](./dev-preview-event-routing.md).
- **`connectivity/`** — `ServiceConnectivityRegistry` (aggregates GitHub token health and MCP server runtime state into one snapshot; derived from work the app already does, never speculative traffic).
- **`commands/`** — higher-level orchestrations invoked as commands (`githubCreateIssue`, `githubWorkIssue`).
- **`events.ts`** — the Main-process `EventEmitter` hub with `EVENT_META` categorizing every event type; the bridge between service-internal events and the renderer event bus.
- **Other clusters worth knowing:** `forge/` + `forgeProvider*` (provider abstraction — see [forge-provider-abstraction.md](./forge-provider-abstraction.md)), `mcp-server/` + `plugin-mcp/`, `plugin/`, `persistence/`, `migrations/`, `voice/`, `gemini/`, `rpc/`.

## Cross-references

- [development.md → IPC pattern](../development.md#ipc-pattern) — the five-step add-a-channel checklist (not duplicated here).
- [fatal-error-spine.md](./fatal-error-spine.md) — the crash/shutdown error path that sits beside the recoverable `errorStore` path.
- [dev-preview-event-routing.md](./dev-preview-event-routing.md) — event routing for the DevPreview cluster.
- [forge-provider-abstraction.md](./forge-provider-abstraction.md) — the forge provider service layer.
- [terminal-lifecycle.md](./terminal-lifecycle.md) — how the PTY host cluster is driven across a terminal's life.
