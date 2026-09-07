# Process & window model

Multi-process topology, IPC transports, multi-window isolation.

## Why this doc exists

`docs/development.md` shows a two-box Main ↔ Renderer diagram. That is the on-ramp, not the reality. Daintree actually runs as **five+ process classes** plus **per-project renderer isolation**, and the boundaries between them use three different IPC transports with different failure semantics. This is the single largest reverse-engineering trap in the codebase: a "Main process singleton" is not one singleton, a "the renderer" is one of N independent V8 contexts, and a crash in one host does not look like a crash in another. Read this before touching anything that crosses a process boundary.

## Process inventory

| Process class | Entry | UtilityProcess `serviceName` | Lives | Isolated because |
| --- | --- | --- | --- | --- |
| **Main** | `electron/main.ts` → `electron/bootstrap.ts` | — (the Electron main process) | one per app | Owns everything: forks the hosts, owns `BrowserWindow`s, registers IPC handlers, holds global services |
| **Renderer (per-project view)** | `src/main.tsx` loaded into a `WebContentsView` | — | **one V8 context per cached project** (`ProjectViewManager`) | Site Isolation; an OOM/crash in one project view doesn't take the window down |
| **PTY host** | `electron/pty-host.ts` + `electron/pty-host/` | `daintree-pty-host` (single, app-global; **sharded per project** behind `DAINTREE_PTY_FABRIC` — [pty-host-fabric.md](./pty-host-fabric.md)) | one per app | node-pty is native and can segfault/OOM; isolating it keeps terminal crashes off the main thread and out of the window |
| **Workspace host** | `electron/workspace-host.ts` + `electron/workspace-host/` | `daintree-workspace-host:<basename>-<sha1[0:8]>` (**one per open project**) | one per project | git polling + file watchers are CPU/FD heavy and can wedge on a bad repo; per-project isolation contains the blast radius and lets `inotify`/`EMFILE` exhaustion be scoped |
| **Watchdog host** | `electron/watchdog-host.ts` + `electron/watchdog-host-core.ts` | `daintree-watchdog` (single) | one per app | Detects a _frozen main process_ — must live outside main so a main-thread deadlock can't also freeze the detector. SIGKILLs main when it stops sending pings |
| **Plugin worker** | `electron/plugin-dev-worker.ts` (+ `-bootstrap`), managed by `electron/services/plugin/PluginDevWorkerHost.ts` | `daintree-plugin-<dev\|prod>:<pluginId>-<sha1[0:8]>` (**one per activated plugin**) | one per loaded plugin | Third-party code must not share an isolate with the host. Per-plugin isolation gives each its own crash budget, its own `execArgv` permission flags, and a dispose path that reclaims it when idle. `mode: "dev"` additionally watches the bundle for hot reload |

Each UtilityProcess is forked from a `*-bootstrap.js` (`pty-host-bootstrap.ts`, `workspace-host-bootstrap.ts`, `watchdog-host-bootstrap.ts`, `plugin-dev-worker-bootstrap.ts`) with `stdio: "pipe"` (not `"inherit"` — fd 2 may point at a dead pty on AppImage GUI launches, #5588). The three long-lived hosts fork with `cwd: os.homedir()` and tag themselves with `DAINTREE_UTILITY_PROCESS_KIND` in `env`; a plugin worker instead forks at its plugin's own directory.

Two more process classes exist but are not part of the steady-state topology: an **assistant native host** (`electron/services/assistant-host/`, contract landed, nothing spawns it yet — see [assistant-native-host.md](./assistant-native-host.md)), and the **paint-fabric surface views** behind `DAINTREE_PAINT_FABRIC_VIEWS` (sibling `WebContentsView`s, not utility processes — see [terminal-paint-fabric.md](./terminal-paint-fabric.md)).

### Topology

```
                         ┌──────────────────────────────────────────────┐
                         │                 MAIN PROCESS                  │
                         │                                               │
   ipc invoke/handle     │  IPC handlers (electron/ipc/handlers/)        │
  ◄────────────────────► │  Global services:  PtyClient, WorkspaceClient │
   ipc send/on (push)    │                    WorktreePortBroker         │
                         │                    MainProcessWatchdogClient  │
                         │  Per-window (WindowContext.services):         │
                         │    PortalManager, EventBuffer, ProjectViewMgr │
                         └───┬───────────┬──────────────┬───────────┬────┘
                             │ fork      │ fork          │ fork      │ ping/sleep/wake
                             │ +ports    │ +ports        │           │ (send/on)
                ┌────────────▼──┐  ┌─────▼──────────┐  ┌─▼────────┐  ┌▼──────────────┐
                │  PTY HOST     │  │ WORKSPACE HOST │  │ WORKSPACE│  │ WATCHDOG HOST │
                │ daintree-pty- │  │  project A     │  │  HOST    │  │ daintree-     │
                │ host (1)      │  │                │  │ project B│  │ watchdog (1)  │
                │ node-pty      │  │ git/watchers   │  │  …       │  │ SIGKILLs main │
                └──────┬────────┘  └───────┬────────┘  └──────────┘  └───────────────┘
                       │                   │
                       │ MessageChannelMain│ MessageChannelMain (one port per VIEW)
                       │ (one port per     │
   ┌───────────────────▼─── WINDOW ────────▼────────────────────────────────────────┐
   │                       BrowserWindow (one OS window)                             │
   │   ┌─────────────────────┐   ┌─────────────────────┐   ┌──────────────────────┐ │
   │   │ Project view A       │   │ Project view B      │   │ app/shell webContents │ │
   │   │ (WebContentsView,    │   │ (WebContentsView,   │   │                       │ │
   │   │  independent V8)     │   │  independent V8)    │   │                       │ │
   │   │  terminal-port ◄─────┘   │  worktree-port ◄────┘   │                       │ │
   │   └─────────────────────┘   └─────────────────────┘   └──────────────────────┘ │
   └────────────────────────────────────────────────────────────────────────────────┘
```

## Transport map

Three transports, chosen per boundary by latency and shape:

| Boundary | Transport | Why |
| --- | --- | --- |
| Renderer → Main (request) | `ipcRenderer.invoke` / `ipcMain.handle` | Request/response with a Promise; the default for `window.electron.*` calls |
| Main → Renderer (push) | `webContents.send` / `ipcRenderer.on` (`CHANNELS.EVENTS_PUSH`) | Fire-and-forget broadcasts (state changes, crash notices, memory warnings) — fanned out per-window/per-view |
| Main ↔ host (PTY, workspace) | `utilityProcess.postMessage` / `child.on("message")`, correlated by `RequestResponseBroker` | Structured request/response over the UtilityProcess channel |
| Main → host (watchdog) | `utilityProcess.postMessage` (`ping`/`sleep`/`wake`/`dispose`) | One-way liveness signal; no responses needed |
| **Renderer ↔ PTY host** (terminal I/O) | **`MessageChannelMain` MessagePort**, brokered by main, then direct | Terminal byte streams are high-volume; routing every keystroke/output chunk through main would add a hop. Main mints the pair and hands one end to each side, then steps out of the data path |
| **Renderer view ↔ workspace host** | **`MessageChannelMain` MessagePort** per view | Same reasoning; "the port IS the isolation boundary" — one port per view to its project's host, no routing/filtering |

### RequestResponseBroker

`electron/services/rpc/RequestResponseBroker.ts` is the shared request/response correlation engine for both `PtyClient` and `WorkspaceClient`. It maps a generated `requestId` → `{ resolve, reject, timeout }`, fires the timeout rejection, and clears in bulk on host exit/shutdown. Rejections carry a typed `BrokerError` whose `code` is one of:

- `HOST_EXITED` — the host crashed; the caller may retry after restart.
- `APP_SHUTDOWN` — terminal; the broker was disposed.
- `TIMEOUT` — no response within the per-request window.

`WorkspaceHostProcess` constructs its broker with `defaultTimeoutMs: 30000` (slow git ops — `project-pulse`, `file-diff`, `create-worktree` — need the 30 s ceiling); the broker's own default is `5000`.

**contextBridge caveat:** Electron's `contextBridge` strips all custom `Error` properties (including `name` and `code`) when an error crosses preload → renderer. `encodeBrokerError()` therefore packs the code into a message prefix (`[BrokerError|<code>] …`) and the renderer-side guard `src/utils/clientBrokerError.ts` (`isClientBrokerError`) decodes it back. Mirror this whenever a typed error must survive the preload boundary.

## The two port-distribution paths (do not confuse them)

These look similar and are the easiest thing to get wrong. They serve different hosts and have different lifecycles.

### Path 1 — renderer ↔ PTY host (`electron/window/portDistribution.ts`)

`distributePortsToView()` mints **one** `MessageChannelMain` pair per _window_ plus a **32-byte hex handshake token** (`randomBytes(32)`), then posts two separate messages to the target webContents:

1. `targetWc.postMessage("terminal-port-token", { token })`
2. `targetWc.postMessage("terminal-port", { token }, [port1])`

`port2` goes to the PTY host via `ptyClient.connectMessagePort(windowId, port2)`. Each call **replaces** the window's active pair — the PTY host keeps exactly one renderer connection per `windowId` (tracked in `ctx.services.activeRendererPort` / `activePtyHostPort`). The renderer side (`src/clients/terminalClient.ts`) correlates the two messages by token and tolerates either arrival order; a port arriving without a matching token is closed. The handshake exists because the two `postMessage` deliveries can race, and a stray port must never be activated.

### Path 2 — renderer view ↔ workspace host (`electron/services/WorktreePortBroker.ts`)

`brokerPort(host, webContents)` mints one pair **per webContents (view)**: `port1` → the project's workspace host via `host.attachWorktreePort(port1)` (`postMessage({ type: "attach-worktree-port" }, [port1])`); `port2` → the renderer via `webContents.postMessage("worktree-port", null, [port2])`. No token, no routing, no fallback — "the port IS the isolation boundary." The broker keys ports by `webContents.id`, holds a reverse `projectPath → Set<wcId>` map, and auto-closes a view's port on `destroyed`, main-frame navigation, or `port1.on("close")`. On host restart, `closePortsForHost(projectPath)` snapshots the view IDs, closes them, and `reBrokerForHost()` re-creates them against the fresh host (wired in `electron/window/windowServices.ts` on the `host-restarted` event).

## Multi-window & per-project view isolation

- **`electron/window/WindowRegistry.ts`** — `WindowContext` per `BrowserWindow`: `{ windowId, webContentsId, browserWindow, projectPath, abortController, services, cleanup }`. Indexes `webContentsId → windowId` (including extra app views) and tracks focus history / primary window.
- **`electron/window/ProjectViewManager.ts`** — per-project `WebContentsView` lifecycle. Each project gets its own `WebContentsView` with an **independent V8 context** (Site Isolation). `switchTo()` swaps the visible view (a cached view returns in <16 ms). View state is `"loading" | "active" | "cached"`. Cached views are CPU-throttled (`Emulation.setCPUThrottlingRate`) or Efficiency-frozen (`Page.setWebLifecycleState`). A paint gate keeps the outgoing view on screen until the incoming one paints (soft 1500 ms / hard 4000 ms) so the user never sees an unpainted frame.
- **LRU eviction** — `evictStaleViews(reason)` (`"lru" | "pressure" | "limit-change"`) destroys the least-recently-used views once `views.size` exceeds `maxCachedViews` (user setting, clamped 1–5; default 1). Under a low-memory floor the cap is overridden to 1 **per pass** (`maxCachedViews` is never mutated). Eviction is **pure LRU, not size-first** (#8602): the biggest renderer is usually the project you're working in, so size-first would evict the most valuable view. On eviction the view's port is cleaned up via the registered eviction callback.

### Global vs per-window services

| Scope | Held in | Examples |
| --- | --- | --- |
| **Global** (shared across all windows) | `electron/window/serviceRefs.ts` (leaf module, zero runtime imports), set by `globalServicesInit.ts` | `PtyClient`, `WorkspaceClient`, `WorktreePortBroker`, `MainProcessWatchdogClient`, `ResourceProfileService`, agent/CCR services |
| **Per-window** | `WindowContext.services` (`WindowServices`), set by `perWindowInit.ts` | `PortalManager`, `EventBuffer`, `ProjectSwitchService`, `ProjectViewManager`, `activeRendererPort`, `activePtyHostPort` |

`globalServicesInit.ts` runs once (guarded by `globalServicesInitialized`); most of it registers **deferred tasks** that drain after the renderer reports first-interactive (`registerDeferredTask`), so service starts don't contend with React hydration. `perWindowInit.ts` runs per window and wires the per-window event fanout (e.g. `ptyClient.on("host-crash-details")` → `terminal:backend-recovering` push to every window's app webContents).

### The correctness rule (real bug class)

> **Module-level singletons do NOT span `WebContentsView` contexts.** Each view evaluates the renderer modules independently in its own V8 context. A Zustand store, an accessor slot, an event emitter declared at module scope in view A is a _different object_ in view B. **Cross-view sync MUST route through Main-process IPC.**

This is documented from the renderer side in [store-init-order.md](./store-init-order.md). The same rule applies in reverse to anything in Main that fans out to renderers: you must iterate `windowRegistry.all()` (and, for view-level pushes, `pvm.getAllViews()`) and `webContents.send` to each — there is no implicit broadcast that reaches every project view. See the fanout helpers in `globalServicesInit.ts` (`sampleBlinkMemory`, `accelerateTerminalHibernation`, etc.) for the canonical pattern.

## Host lifecycle

The PTY host and workspace host share an almost-identical fork/exit/restart loop. PTY: `electron/services/pty/PtyHostLifecycle.ts`. Workspace: `electron/services/WorkspaceHostProcess.ts`.

1. **Spawn** — `utilityProcess.fork(<bootstrap>.js, …)`. A fresh `readyPromise` is created on **every** start; `waitForReady()` returns the current one. Reassigning it per fork is a subtle invariant — it prevents a "wrong promise resolved" bug across restarts.
2. **Ready** — the host emits `ready`; `markReady()` resolves the promise. `crashTimestamps` is deliberately **not** cleared on ready (clearing here would defeat the sliding window in a crash-ready-crash-ready loop, #8553/#8683).
3. **Exit** — the `exit` handler runs synchronously (reject `readyPromise` if it wasn't ready, clear the broker with `HOST_EXITED`), then **defers crash classification by one `setImmediate` tick**. This bridges the Electron `exit` / `child-process-gone` ordering race ([electron/electron#42283](https://github.com/electron/electron/issues/42283)): `exit` usually fires _before_ `child-process-gone` for utility-process crashes, so the authoritative crash reason and exit code arrive a tick late. The deferred handler prefers the `child-process-gone` exit code over the `exit` code (defense-in-depth for the Windows signed/unsigned mangling bug, fixed in Electron 41.0.4 / electron/electron#50386).
4. **Restart backoff** — full jitter with a floor: `delay = RESTART_FLOOR_MS + rand(0, cap - RESTART_FLOOR_MS)` where `cap = min(RESTART_CAP_BASE_MS · 2^N, RESTART_CAP_MAX_MS)`. PTY/workspace use `FLOOR=100ms, BASE=1000ms, MAX=10000ms`. The restart timer is `unref`'d so it never holds the event loop alive past quit.
5. **Crash-loop guard** — a time-windowed sliding counter. Three crashes (`CRASH_THRESHOLD = 3`) within `CRASH_WINDOW_MS` (30 min) trips the cap and emits `host-crash`; older timestamps decay lazily at crash-record time (no reset timer). The constant is duplicated across `PtyHostLifecycle`, `WorkspaceHostProcess`, and `CrashLoopGuardService` (they operate at independent layers) and **kept in lockstep**, asserted by `electron/services/__tests__/crashGuardAlignment.test.ts`.
6. **Deferred-restart no-op** — if `manualRestart()` (or any other path) already spawned a new host during the `setImmediate` window, the deferred auto-restart no-ops (`if (this.child !== null) return`) so it can't orphan that host. The same guard protects against scheduling a second restart during a window recreation.

`manualRestart()` clears `crashTimestamps` for a fresh budget and emits `restarted` (workspace) so `WorkspaceHostProcess` consumers can re-broker ports. A `pendingChildProcessGoneReason` is captured by a per-instance, `serviceName`-filtered `app.on("child-process-gone")` listener and consumed by the next `exit` tick (the workspace host hashes the full project path into its `serviceName` so two same-basename projects don't cross-attribute crashes).

### How a host crash surfaces to the renderer

- **Transient crash + auto-restart in progress** → `BrokerError("HOST_EXITED")` rejects in-flight requests immediately (the renderer-side guard decodes the code from the message prefix). PTY: a `host-crash-details` event also pushes `terminal:backend-recovering` to every window (`perWindowInit.ts`).
- **Restart budget exhausted** (`host-crash` emitted) → PTY pushes `terminal:backend-crashed`; the renderer's `panelStore.backendStatus` flips off `"connected"`, and the global **host-crash banner** (`src/components/Recovery/HostCrashBanner.tsx`, routed through `GlobalBannerCoordinator`) takes the top-of-app slot. When that banner is active, per-pane duplicate error banners with no distinct recovery are suppressed.

### Watchdog host

`electron/watchdog-host-core.ts` is pure, testable logic; `watchdog-host.ts` is the thin runtime that injects `killMain`/timer primitives. Main's `MainProcessWatchdogClient` forks `daintree-watchdog` with `--main-pid=<pid>` and sends a `ping` every `PING_INTERVAL_MS` (5 s). The watchdog arms on the first ping and increments `missedBeats` each tick it goes without one; at `MAX_MISSED = 3` (~15 s of main-thread unresponsiveness) it writes a `watchdog-kill.flag` sidecar (fail-open, swallows write errors) and SIGKILLs main. `CrashRecoveryService` reads and unlinks the flag on next launch to attribute the crash as a deadlock kill. The watchdog suppresses ticks queued during OS sleep via a monotonic `performance.now()` grace window (one heartbeat interval after a `wake`), so suspended `setInterval` bursts at resume can't false-trip the kill. Main quiesces the watchdog around its own sleep with `sleep`/`wake` messages. The watchdog's _own_ restart guard uses different constants (`FLOOR=250ms, BASE=1500ms, MAX=5000ms`, `RAPID_CRASH_WINDOW_MS = 300_000`) — do not assume it matches the host guard.

## Who owns what

| Process | Owned services / state | Talks to | Channels / transport |
| --- | --- | --- | --- |
| **Main** | `PtyClient`, `WorkspaceClient`, `WorktreePortBroker`, `MainProcessWatchdogClient`, all IPC handlers, `WindowRegistry`, per-window `PortalManager`/`EventBuffer`/`ProjectViewManager` | every other process + all renderers | `invoke/handle`, `send/on`, `MessageChannelMain`, `utilityProcess.postMessage` |
| **PTY host** (`daintree-pty-host`) | node-pty processes, scrollback, backpressure (`pty-host/`), FD monitor, resource governor | Main (`PtyClient`), renderers (direct via MessagePort) | broker over UtilityProcess channel; `terminal-port` MessagePort per window |
| **Workspace host** (per project) | `WorkspaceService`, `WorktreeMonitor`, file watchers, `PRIntegrationService`, forge polling | Main (`WorkspaceClient` / `WorkspaceHostProcess`), renderer views | broker over UtilityProcess channel; `worktree-port` MessagePort per view; forge RPC round-trips back to main |
| **Watchdog host** (`daintree-watchdog`) | deadlock-kill timer + kill flag | Main only | `ping`/`sleep`/`wake`/`dispose` (one-way `postMessage`) |
| **Plugin worker** (per plugin) | one plugin's `activate()`, its imperative registrations, its managed processes and fs watchers | Main (`PluginDevWorkerHost` → `PluginService`) | structured `postMessage` over the UtilityProcess channel |
| **Renderer view** (per project) | Zustand stores, xterm instances, React tree — all V8-local | Main (IPC), PTY host + workspace host (direct MessagePort) | `window.electron.*` (invoke), `EVENTS_PUSH` (on), MessagePorts |

## Pointers into the code

- Brokered RPC: `electron/services/rpc/RequestResponseBroker.ts`, `src/utils/clientBrokerError.ts`.
- PTY host main-side: `electron/services/PtyClient.ts`, `electron/services/pty/PtyHostLifecycle.ts`, and the shard router in `electron/services/pty/`. Host process: `electron/pty-host.ts`, `electron/pty-host/`.
- Workspace host main-side: `electron/services/WorkspaceClient.ts`, `electron/services/WorkspaceHostProcess.ts`, `electron/services/workspace-client/WorkspaceHostPool.ts`. Host process: `electron/workspace-host.ts`, `electron/workspace-host/`.
- Ports: `electron/window/portDistribution.ts` (PTY), `electron/services/WorktreePortBroker.ts` (workspace), `src/clients/terminalClient.ts` (renderer handshake consumer).
- Windows/views: `electron/window/WindowRegistry.ts`, `electron/window/ProjectViewManager.ts`, `electron/window/serviceRefs.ts`, `electron/window/globalServicesInit.ts`, `electron/window/perWindowInit.ts`, `electron/window/windowServices.ts`.
- Watchdog: `electron/watchdog-host-core.ts`, `electron/watchdog-host.ts`, `electron/services/MainProcessWatchdogClient.ts`.
- Plugin workers: `electron/plugin-dev-worker.ts`, `electron/services/plugin/PluginDevWorkerHost.ts`, `electron/services/PluginService.ts`.
- Crash-guard alignment: `electron/services/__tests__/crashGuardAlignment.test.ts`.

## Related docs

- [terminal-lifecycle.md](./terminal-lifecycle.md) — PTY spawn/attach/teardown over the brokered channel.
- [terminal-identity.md](./terminal-identity.md) — terminal ID scheme that flows across the same boundaries.
- [store-init-order.md](./store-init-order.md) — the renderer side of the per-V8-context singleton rule.
- [fatal-error-spine.md](./fatal-error-spine.md) — how fatal errors and crash attribution surface across processes.
- [crash-recovery-and-safe-mode.md](./crash-recovery-and-safe-mode.md) — the five liveness guards that watch these processes, and how each failure surfaces.
- [resource-governance.md](./resource-governance.md) — the freeze / LRU-eviction / paint-gate policy `ProjectViewManager` applies to the views described here.
- [pty-host-fabric.md](./pty-host-fabric.md) — the per-project PTY host shards behind `DAINTREE_PTY_FABRIC`.
- [ipc-services.md](./ipc-services.md) — the service/handler/client layering that rides these transports.
