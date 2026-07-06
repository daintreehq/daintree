# PTY Host Fabric

The PTY fabric dissolves the app-global singleton `daintree-pty-host` into a pool of **host shards** — one full pty-host UtilityProcess per open project — routed by `PtyClient` behind its unchanged public interface. Each shard owns a disjoint subset of terminals on its own event loop, its own RAM-scaled V8 heap, and its own `ResourceGovernor`, so one project's output flood, memory pressure, or native crash can no longer pause, throttle, or kill every other project's terminals.

## Status & flag

**Default: OFF.** The fabric ships behind `DAINTREE_PTY_FABRIC=1` (or `true`); with the flag unset, `PtyClient` runs exactly one shard (`main`) with the legacy singleton behavior — same service name, same fixed 512 MB heap, same restart/replay semantics — verified by the pre-existing PtyClient suites running unchanged. `PtyClientConfig.fabric` / `PtyClientConfig.maxProjectShards` override the env flag and shard cap for tests.

Phases landed (spec: "The Terminal Data-Plane Fabric"): **Phase 0** (fabric seam behind the `PtyClient` interface, shard-count 1 parity) and **Phase 1** (per-project shards, crash isolation, shard-bound terminal lifecycle), plus the Phase 2 slices that fall out structurally (per-shard governors with RAM-scaled budgets; no cross-project stop-the-world). Not yet landed: spill-to-disk / durable agent sessions (Phase 3), per-shard in-thread analysis (Phase 4), bounded-N packing (Phase 5).

## Architecture

- `electron/services/PtyClient.ts` — the router. Owns placement (`projectId → shard`), terminal ownership (`terminalId → shard`), window-port routing (`windowId → shard`), cross-shard aggregation, and the public API. Pure bookkeeping + port plumbing: terminal bytes flow renderer↔shard directly over `MessageChannelMain`, never through main.
- `electron/services/pty/PtyShard.ts` — one shard: `PtyHostLifecycle` (fork/restart/backoff, per-shard `serviceName`), `PtyHealthWatchdog`, a per-shard `RequestResponseBroker` (a crashing shard rejects only its own pending requests), pending MessagePorts, and the respawn/resync flags.
- `electron/services/pty/fabricConfig.ts` — pure policy: flag parsing, shard cap (`clamp(cores − 2, 1, 8)`), RAM-scaled heap budget (`clamp(totalMem/32, 512, 2048)` MB), shard service names (`daintree-pty-host:<key>-<hash>`; the default shard keeps the legacy name).
- The pty-host process itself is unchanged: every shard runs the same binary, and its governor/pool/analysis machinery is already per-process. `ResourceGovernor` now reads `DAINTREE_PTY_HEAP_BUDGET_MB` (set by `PtyHostLifecycle` from the same value as `--max-old-space-size`) so its thresholds track the real heap cap instead of a hardcoded 512.

## Placement invariants

- **One project → one shard.** A project's terminals never split across shards, so per-project ops (kill-by-project, stats, rollup rows, pool warm) stay single-shard. Future bounded-N packing (spec Phase 5) must preserve this invariant.
- Projectless terminals (help sessions, smoke tests) live on the default shard.
- Placement is **session-sticky**: a project past the shard cap, or whose shard exhausted its crash budget, is pinned to the default shard via `projectShardOverrides` and never flip-flops back mid-session.
- The default shard always exists, is never retired, and is the boot/ready gate (`waitForReady`, `isReady`).

## Window ports

Each window has one PTY MessagePort, connected to the shard owning the window's **active project**. `connectMessagePort` derives the target from the window's project context; if the port previously lived on another shard, that shard gets `disconnect-port` (tearing down its per-window queue/batcher). When a project switch moves a window to a different shard, `rerouteWindowPortIfNeeded` re-mints the channel via the targeted port-refresh callback (`setPortRefreshCallback` now takes an optional `windowId`; `perWindowInit` refreshes just that window). Background projects' terminals stream via the IPC fallback exactly as before — same as the pre-fabric behavior for non-active projects.

## Cross-shard invariants (re-provided by the router)

- **Memory rollup** (`getMemoryRollup`) — fan-out + merge; totals sum, `available` is AND-ed, per-project rows never overlap (placement invariant).
- **Flow-control snapshot** (`getFlowControlSnapshotAsync`) — terminals/queues concatenate, counters sum, the top-level governor/event-loop fields carry the **worst-shard** view ("PTY host lag p99" = worst shard), and the new optional `FlowControlSnapshot.shards` array carries the per-shard breakdown for why-slow diagnostics.
- **Host signals** (`host-throttled`, `host-memory-warning`) — consumers treat these as THE backend's state, so the router ORs per-shard booleans and forwards only aggregate edges; a healthy shard's release can't clear a struggling sibling's warning, and a departed shard's stale hold is dropped (with a release edge) on crash/retirement.
- **Global controls** (pause-all/resume-all on sleep, trim-state, resource profile, monitoring, session-persist suppression, log levels, plugin-agent registry) — cached and fanned out to every shard; a shard forked mid-session receives the full cache on its first `ready`.
- **Fleet broadcast** (`broadcastWrite`, `batchDoubleEscape`) — grouped per owning shard, one message per shard.
- **Lifecycle ledger** — generations mint/close exactly as before; migration and per-shard respawn each mint a fresh incarnation so the session journal's exactly-once gate holds across shards.

## Failure containment

- **Shard crash** — only that shard's terminals die; orphan-PID cleanup is scoped to its terminals (killing by owner map, never a sibling's PTY trees); its broker rejects only its own requests; its pending spawns respawn on the restarted shard with fresh generations; only its windows get a port refresh. `host-crash-details` (which drives the renderer's global "backend recovering" state) is emitted only for the default shard / singleton path — a project shard's crash is contained to a log plus its own targeted recovery, because unrelated windows would never receive the `terminal:backend-ready` that clears the recovering state.
- **Fork failure** — a project shard whose `utilityProcess.fork()` throws follows the same containment as a crash loop (deferred one tick so an in-flight spawn registration lands first): its project pins to the default shard and its terminals respawn there. Only a default-shard fork failure emits the global `host-crash`.
- **Crash loop** (3 crashes / 30 min, same budget as the singleton) — a _project_ shard's terminals migrate to the default shard (graceful degradation toward the singleton, never dropped terminals) with no global `host-crash`; the _default_ shard exhausting its budget still emits `host-crash` (global banner), as before.
- **Partial aggregates** — if any fanned-out shard fails/times out, `getMemoryRollup` marks the merged rollup `available: false` (consumers gate memory displays on it), and `getFlowControlSnapshotAsync` routes through the merge so the `shards` breakdown makes the missing shard observable.
- **Idle retirement** — a project shard with no terminals, no pending spawns, and no window on its project lingers `PTY_SHARD_IDLE_LINGER_MS` (45 s) and then exits, releasing all its FDs and heap. This binds terminal-tier resource lifetime to the shard instead of the renderer view — the structural fix for LRU view eviction leaking PTY FDs/RSS into a shared host.
- **Per-shard host files** — each shard writes its own emergency log (`pty-host-<shard>.log`; the default shard keeps `pty-host.log`) since the size-check-then-truncate rotation is not cross-process safe. Session snapshots stay safe unmodified: they are keyed per terminal id and a terminal lives on exactly one shard.

## Testing

- `electron/services/__tests__/PtyClient.fabric.test.ts` — placement, port routing/reroute, ready replay, crash isolation (scoped orphan cleanup, per-shard respawn), crash-loop migration, default-shard crash budget, idle retirement, cap overflow, aggregated signals, rollup/flow-control/all-terminals merges, fan-out controls.
- `electron/services/pty/__tests__/fabricConfig.test.ts` — policy clamps and service-name uniqueness.
- Singleton parity: the entire pre-existing `PtyClient.*` suite (adversarial, handshake, watchdog, multiPort, deferStart, projectId, lifecycleLedger, ipc.integration) runs unchanged with the flag off.
