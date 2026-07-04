# Crash recovery, safe mode & host-failure handling

This document describes the safety-critical recovery subsystem: how Daintree detects that the previous session died, how it re-arms against a deadlocked main process, how it backs off from a crash loop, and how each failure mode surfaces in the UI. It is the runtime/liveness companion to [fatal-error-spine.md](./fatal-error-spine.md), which covers the on-exit marker contract (`running.lock`) and the synchronous fatal-error path. Where this doc says "the marker tells the next launch the exit was dirty", the spine doc owns the why.

The subsystem has one job: **a process that can no longer make progress — whether it is wedged, looping, or its GPU/PTY host is dead — must be detected, recovered if safe, and never silently abandon the user's session.** Every kill path is gated and fail-open: a false positive (killing a healthy process, booting into safe mode for no reason) is treated as strictly worse than missing one detection cycle.

## Mental model: five independent guards

There is no single "recovery service". Five guards run concurrently, each watching a different liveness axis, each with its own sentinel file or sliding window, each fail-open in isolation. They share constants and defer to each other at the relaunch decision, but none depends on another being alive.

| Guard | Watches | Authority | Sentinel / window | Surfaces as |
| --- | --- | --- | --- | --- |
| `MainProcessWatchdogClient` + `watchdog-host` | Main-process event-loop liveness | External UtilityProcess SIGKILLs main | `watchdog-kill.flag` | `WatchdogDisabledBanner` (when the _detector itself_ dies) |
| `CrashRecoveryService` | Did the last session exit cleanly? | None (records + restores) | `running.lock` marker + `backups/` | `CrashRecoveryDialog` |
| `CrashLoopGuardService` | Consecutive dirty launches | Decides relaunch vs hard stop, safe mode | `crash-loop-state.json` | `SafeModeBanner` |
| `GpuCrashMonitorService` | GPU child-process crashes | Relaunches with fallback / disables HW accel | `gpu-disabled.flag`, `gpu-angle-fallback.flag` | (relaunch; no banner) |
| `PtyHealthWatchdog` | PTY host responsiveness | SIGKILLs the PTY host | (in-memory heartbeat) | `HostCrashBanner` (via `backendStatus`) |

`WaitingWatchdog` is a sixth, narrower watchdog living in the agent-activity layer — it detects a _stuck-waiting agent_, not a process failure, and is documented at the end.

```
                       ┌──────────────────────────────────────────┐
   external process →  │  watchdog-host (UtilityProcess)           │  SIGKILL ┐
   (no main eventloop) │  createWatchdog(): tick / ping / sleep    │──────────┤
                       └──────────────────────────────────────────┘          │
                              ▲ ping every 5s                                 ▼
   ┌───────────────────────── MAIN PROCESS ──────────────────────────────────────────┐
   │ MainProcessWatchdogClient ── onDisabled ──▶ wireWatchdogDisabledBroadcast ──IPC──┼─▶ WatchdogDisabledBanner
   │ CrashLoopGuardService.initialize() ─ crash-loop-state.json ─ isSafeMode() ───────┼─▶ SafeModeBanner
   │ CrashRecoveryService.initialize() ─ consumeMarker() ─ running.lock + backups ────┼─▶ CrashRecoveryDialog
   │ GpuCrashMonitorService ─ app.on("child-process-gone") ─ relaunch/disable ────────┤
   │ PtyHealthWatchdog (in PtyClient) ─ health-check/pong ─ SIGKILL pty-host ─────────┼─▶ backendStatus ─▶ HostCrashBanner
   └─────────────────────────────────────────────────────────────────────────────────┘
```

All five are wired during boot in `electron/main.ts`: `initializeCrashLoopGuard()` (before global error handlers, so safe-mode state exists when the first fatal can fire), then `initializeCrashRecoveryService()`, then `initializeGpuCrashMonitor()` (before the first window, so it sees GPU crashes during startup). The main-process watchdog is started later, in `perWindowInit.ts`, alongside `PtyClient` (`electron/window/perWindowInit.ts:140`).

---

## 1. Main-process watchdog (deadlock liveness)

**Problem:** a fully-deadlocked main process can't kill itself — no timer fires, no IPC drains. Detection must live _outside_ the main event loop.

### Topology

- `electron/watchdog-host.ts` — the UtilityProcess entry point. Forked by `MainProcessWatchdogClient` via `utilityProcess.fork()` (service name `daintree-watchdog`). Receives the main PID as `--main-pid=<pid>` argv.
- `electron/watchdog-host-core.ts` — pure, dependency-injected logic (`createWatchdog(deps)`), extracted so the kill state machine is testable without a UtilityProcess. Exports the constants and the `watchdog-kill.flag` payload builder.
- `electron/watchdog-host-bootstrap.ts` — 18-line shim that the client actually forks (`watchdog-host-bootstrap.js`); it loads the host.
- `electron/services/MainProcessWatchdogClient.ts` — the main-side manager: pings, restarts the host with backoff, routes sleep/wake, and emits the `onDisabled` event when it gives up.

### Heartbeat contract

`MainProcessWatchdogClient` sends `{ type: "ping" }` every `PING_INTERVAL_MS = 5000`. The host expects one each interval; after `MAX_MISSED = 3` consecutive missed ticks (`HEARTBEAT_INTERVAL_MS = 5000` → ~15s of unresponsiveness) it SIGKILLs main. The `MAX_MISSED = 3` floor is deliberate: V8 major GC and synchronous `better-sqlite3` ops can legitimately pause main for several seconds, so a threshold under ~10s would false-positive (`watchdog-host-core.ts:8-13`).

The host stays **inert until armed**: a `ping` sets `isArmed = true`. A slow-booting main that hasn't sent its first ping is never killed. After a kill the host **disarms itself** (`state.isArmed = false`) so a queued tick can't re-fire before the relaunched main sends its first ping (`watchdog-host-core.ts:95-100`).

### Sleep/wake — the burst-tick problem

When the OS suspends, `setInterval` callbacks queued during sleep fire as a **packed burst at wake** — each would increment `missedBeats` and cross the kill threshold before the post-wake arming ping lands, producing a false-positive SIGKILL on resume. Two defenses, both must hold:

1. `MainProcessWatchdogClient.pause()` stops the ping interval _and_ sends `{ type: "sleep" }` (belt-and-suspenders against out-of-order delivery). `resume()` sends `{ type: "wake" }` then an immediate ping. These are driven from the power monitor (`electron/window/powerMonitor.ts`).
2. The host's `tick()` ignores any tick within one `HEARTBEAT_INTERVAL_MS` of the last `wake` (`watchdog-host-core.ts:80-82`). This uses `performance.now()` (monotonic), **not** `Date.now()`, so NTP/wall-clock jumps can't defeat the grace window.

Note the subtle restart-during-sleep case in `startHost()`: if the watchdog crashed and re-forked _while suspended_, the new child is armed by the first ping but would accumulate missed beats during sleep — so the client sends `sleep` immediately after the arming ping (`MainProcessWatchdogClient.ts:186-199`).

### The kill flag (crash attribution)

Before SIGKILL the host writes `<userData>/watchdog-kill.flag` synchronously (`writeWatchdogKillFlag`). This is **best-effort and must never gate the kill** — the helper swallows all errors and SIGKILL fires unconditionally (`watchdog-host.ts:84-92`). On the next launch `CrashRecoveryService.consumeWatchdogKillFlag()` reads and unlinks it, and — if the flag's mtime is fresh (`>= sessionStartMs - WATCHDOG_GRACE_MS`, 5s) — attributes the crash as `cause: "watchdog-deadlock"` instead of `"unknown"`. The mtime guard prevents a stale flag from a prior session poisoning attribution. Defensive range checks reject an all-zero corrupt flag (`killedAt > 0`, `missedBeats >= 1`, `mainPid > 0`).

Before SIGKILL the host also re-probes `process.kill(pid, 0)` (POSIX existence check) — if main already exited it skips the kill (`watchdog-host.ts:77-83`). `parseMainPid` rejects partial-numeric argv like `"123abc"` so the kill always targets exactly the intended PID.

### Watchdog crash-loop backoff → "watchdog disabled"

The client treats _its own_ host crashing as a crash-loop, using a **time-windowed** counter, **not** an uptime-reset counter (the old pattern was defeated by a slow crash-every-35s loop): `CRASH_THRESHOLD = 3` crashes within `RAPID_CRASH_WINDOW_MS = 300_000` trips the cap; `STABILITY_TIMEOUT_MS = 300_000` of clean running decays the window. Restart delay uses full-jitter backoff with `RESTART_FLOOR_MS = 250`, cap base `1_500`, cap max `5_000` — **intentionally distinct** from `PtyHostLifecycle`'s parameters so the two services don't synchronize restarts under a shared trigger (OOM, signal) (`MainProcessWatchdogClient.ts:34-46`).

When the cap is hit, deadlock detection is **off for the rest of the session**. The client fires `onDisabled(payload)` exactly once per cap cycle. `wireWatchdogDisabledBroadcast` (`electron/window/perWindowInit.ts:427`) turns that into a `watchdog:disabled` push to every renderer, setting `usePanelStore.watchdogStatus = "disabled"`. `WatchdogDisabledBanner` (`src/components/Recovery/WatchdogDisabledBanner.tsx`) renders, offering `watchdog.restart` (the IPC handler at `electron/ipc/handlers/watchdog.ts` re-wires the broadcast, calls `client.restart()` which resets the window, and broadcasts `watchdog:active` so sibling windows clear their stale banner).

**Crucial invariant:** "watchdog disabled" means the _detector_ died, **not** that main is unhealthy. Main is unharmed (the client never kills main — only the subprocess has that authority). It is a degraded-protection warning, which is why it ranks below `host-crash` but above `safe-mode` in the banner coordinator.

---

## 2. CrashRecoveryService (session snapshot & restore)

`electron/services/CrashRecoveryService.ts` (~1158 LOC) owns the dirty-exit marker, the rolling session backup, and the restore flow. The marker invariants live in [fatal-error-spine.md](./fatal-error-spine.md); this section covers the snapshot and restore mechanics.

### What is snapshotted

`captureSessionSnapshot()` writes `{ capturedAt, appState, windowStates }` to `<userData>/backups/session-state.json`. `appState` is the full Zustand-backed panel/layout state from the main-process `store`; `windowStates` is the multi-window geometry store. Backups are taken:

- Every `BACKUP_INTERVAL_MS = 60_000` (the timer also stamps the marker heartbeat).
- Debounced `DEBOUNCE_BACKUP_MS = 1_500` on explicit `scheduleBackup()` calls.
- On window blur, debounced `BLUR_BACKUP_DEBOUNCE_MS = 100` (only if no window is focused — i.e. the app is backgrounded).
- On clean exit (`cleanupOnExit`).

### Corruption resilience — the rolling pair

A single corrupt write must not destroy the only recovery snapshot. `takeBackup()` rotates current → `session-state.previous.json` **before** writing new current (Firefox-style pair). Every read path (`restoreBackup`, `readBackupInfo`, `readBackupFile`) falls back current → previous, and gates `hasBackup`/`exists` on actual _parseability_ — a stat-able but unparseable current is treated as missing so the UI never offers an unrestorable restore.

### consumeMarker — preserving the crashed snapshot

On launch, `consumeMarker()` runs before the new session's backup timer starts. The ordering is load-bearing:

1. Read+unlink the watchdog kill flag (before any dev-marker discard, so a real dev-mode watchdog kill isn't lost).
2. **Preserve** the live backup: rename `session-state.json` → `session-state.crashed-<sessionStartMs>.json` _before_ deleting the marker, so a kill between the two steps can't wipe the marker while a recoverable backup sits on disk. `preserveBackupForRecovery` is idempotent (reuses an existing crashed-\* file) and falls back rename → copy-then-unlink on Windows AV/indexer lock failures.
3. Cache the parsed snapshot in-memory (`cachedBackupSnapshot`) so the dialog and `restoreBackup` survive concurrent on-disk deletion/overwrite between marker consumption and the user clicking a button.
4. Classify the crash cause (see below) and extract per-panel summaries.

`PendingCrash` (the IPC payload) carries the crash log entry, `hasBackup`, `backupTimestamp`, and `panels: PanelSummary[]`. Panels created within `SUSPECT_WINDOW_MS = 30_000` of the crash are flagged `isSuspect` (`suspectReason: "crash-window"`) — a panel opened right before the crash is the likely trigger.

### Crash-cause classification

`classifyCrashCause()` is strict priority order, strongest signal wins (`CrashRecoveryService.ts:837`):

1. `crashLogPath` set → `"uncaught-exception"` (our own `recordCrash` wrote it — most trusted).
2. Recent Crashpad `.dmp` (mtime > sessionStart, scanning `new`/`pending`/`completed`) → `"native-crash"`.
3. `lastSuspendStart` present → `"suspended-then-lost"` (slept, never resumed — usually power loss during sleep).
4. `os.uptime()` shorter than elapsed wall-clock → `"power-loss"` (definitive reboot; reliable positively only).
5. Heartbeat older than `HEARTBEAT_STALE_THRESHOLD_MS = 120_000` → `"external-kill"` (SIGKILL/OOM killer/force-quit).
6. Else `"unknown"`.

The watchdog kill flag, when fresh, overrides the classified `cause` to `"watchdog-deadlock"` and annotates the on-disk log too.

### Restore-confirmation flow (renderer)

`CrashRecoveryDialog` (`src/components/Recovery/CrashRecoveryDialog.tsx`, ~753 LOC) renders the pending crash. It is shown _before_ the main app tree — note the in-code caveat that `notify()` is dead here because the Toaster isn't mounted yet, so recovery failures surface inline via `InlineStatusBanner` with a "Send diagnostics" action (`CrashRecoveryDialog.tsx:122-133`).

- With panels: a checkbox list of recoverable panels. Suspect panels are **deselected by default** once `crashCount >= 1` (`shouldDeselectSuspects`). The user restores the selected subset (`{ kind: "restore", panelIds }`) or continues fresh.
- `crashCount >= 2` → `isInCrashLoop`: the "restore automatically next time" toggle is replaced by an "Auto-restore paused — too many consecutive crashes" notice.
- "Continue without restoring" is gated behind a `ConfirmDialog` (Tier D1 — local irreversible) before `{ kind: "fresh" }` fires.
- The collapsible "Error details" exposes app/OS/memory metadata, the stack, the recent-action breadcrumb trail, and a redacted "Report this crash" → GitHub flow (clipboard fallback when the body exceeds the URL budget).

`restoreBackup(panelIds?)` prefers `cachedBackupSnapshot`, filters terminals onto a _shallow copy_ (so a failed apply is retryable with the full list), and refuses to restore an empty filter when the original had panels (a stale/typo'd ID would otherwise empty-then-unlink the recovery source — `CrashRecoveryService.ts:337-339`). On success it unlinks the crashed-\* file and clears the cache.

`autoRestoreOnCrash` (default `true`) lives in the main `store` under `crashRecovery`; when on and not in a crash loop, the dialog is skipped and the previous session is restored automatically (`main.ts:483` gates the dialog on `!guard.isSafeMode() && !crashService.getPendingCrash()`).

---

## 3. CrashLoopGuardService & safe mode

`electron/services/CrashLoopGuardService.ts` (~367 LOC) counts consecutive **dirty** launches and decides three things at boot: relaunch eligibility, safe-mode entry, and the hard stop.

### State & thresholds

`crash-loop-state.json` holds `{ version: 1, crashes, launches: number[], cleanExit, lastReset }`. The counter is a **lazy sliding window** evaluated only at boot and crash-record time — no `setTimeout`, no proactive reset. The window `CRASH_WINDOW_MS = 30 * 60 * 1000` (30 min) is deliberately wide: a narrower window left a slow-flap blind spot where a crash every 6+ minutes never accumulated strikes. Exported so `crashGuardAlignment.test.ts` can assert the three guards (this service, `PtyHostLifecycle`, `MainProcessWatchdogClient`) stay aligned.

At `initialize()`: if the prior exit was **not** clean, `crashes = (count of launches within the window)`; if clean, the counter resets. Then it appends the current launch and derives:

- `CRASH_THRESHOLD = 3` consecutive crashes → **safe mode** (`isSafeMode()` true).
- `HARD_STOP_THRESHOLD = 5` → **relaunch disabled** (`shouldRelaunch()` false). Beyond this the fatal-error path and `GpuCrashMonitor` stop relaunching (`globalErrorHandlers.ts:96`), and the user must restart manually — the app stops fighting an unwinnable loop.

The clean-exit flag is the linchpin: `markCleanExit()` is called on the success branch of shutdown; if it never fires, the launch counts as a crash. This is why the dev-mode `SIGUSR2`/nodemon handler exists (see fatal-error-spine.md) — without it every rebuild looked like a crash and booted dev into safe mode.

### What safe mode disables

Safe mode is **startup-only** — `AppHydrationService` always returns `safeMode: false` after the first hydration (`AppHydrationService.ts:21`). Its effect is at panel-restore time in `electron/ipc/handlers/app/state.ts`: when `guard.isSafeMode()`, panels the `PanelSuspectLedgerService` has quarantined are filtered out of the restore set (`getQuarantinedPanelIds()`), with `skippedPanelCount` and `quarantinedPanels` surfaced to the renderer. The ledger is fed the pending crash summaries at boot (`initializePanelSuspectLedger(...)` in `main.ts:192`); a likely-crashing panel is held back so the app can boot to a usable state. Fallbacks handle "ledger empty" and "all panels quarantined" so safe mode never restores nothing-then-everything in a partial way.

### Surfacing & exit

`SafeModeBanner` (`src/components/Recovery/SafeModeBanner.tsx`) reads `useSafeModeStore` (`safeMode`, `crashCount`, `lastCrashAt`, `skippedPanelCount`, `quarantinedPanels`). It shows crash metadata, a "Show details" popover listing quarantined panels (each individually restorable on next launch via `clearQuarantinedPanel`), and a "Restart normally" CTA gated behind a `ConfirmDialog` (restart kills all terminals/agent sessions). The CTA calls `window.electron.app.resetAndRelaunch()`, which on the main side runs `CrashLoopGuardService.resetForNormalBoot()` — atomically clearing the state file and the in-memory flags. `resetForNormalBoot()` **throws on disk-write failure** so the IPC handler can re-enable the button; silently swallowing would leave the unclean sentinel and boot straight back into safe mode (`CrashLoopGuardService.ts:158-173`).

### Corruption forensics

A malformed `crash-loop-state.json` is **quarantined**, not deleted: renamed to `.corrupted.<ts>`, perms tightened to `0o600` (POSIX only), and kept for forensics (`KEEP_CORRUPTED_SIBLINGS = 3`, older pruned at boot). Stale `.tmp` residue from interrupted atomic writes is swept after `TMP_ORPHAN_TTL_MS`. The standalone `isSafeModeActive(userDataPath?)` export lets other early-boot code (and the diagnostics cache path) read safe-mode status without instantiating the service.

---

## 4. GpuCrashMonitorService (GPU-crash handling)

`electron/services/GpuCrashMonitorService.ts` (~226 LOC) listens on `app.on("child-process-gone")` and acts only on `details.type === "GPU"` with a real crash reason (not `"clean-exit"`/`"killed"`). It must install the listener **before the first window** (`main.ts:214`) or startup GPU crashes are missed.

Sliding window: `GPU_CRASH_THRESHOLD = 3` within `GPU_CRASH_WINDOW_MS = 5 * 60 * 1000`. Two escalation tiers:

1. **First strike → soft ANGLE/Vulkan fallback.** Writes `gpu-angle-fallback.flag`, relaunches. But the ANGLE switches are only applied on **Linux + Wayland** (`electron/setup/environment.ts`), so on macOS/Windows the relaunch would be a no-op — the strike is allowed to accumulate toward the nuclear path instead of burning a session restart. The `alreadyHasAngleFallback` guard prevents an infinite loop when Vulkan itself crashes.
2. **Threshold reached → nuclear disable.** Writes `gpu-disabled.flag`, clears the ANGLE flag, persists `store.gpu.hardwareAccelerationDisabled = true`, relaunches with HW accel off.

Both tiers honor the crash-loop hard stop — if `getCrashLoopGuard().shouldRelaunch()` is false they `app.exit(0)` instead of relaunching, so back-to-back GPU crashes can't blow past `HARD_STOP_THRESHOLD`. Both **refuse to relaunch if the flag write fails** (read-only fs, permissions) — relaunching without persisting state would loop every session.

Helper exports: `isGpuDisabledByFlag` (cached), `isGpuAngleFallbackApplied` (Linux+Wayland gate, for UI — avoids a misleading "running in ANGLE mode" warning where ANGLE was never engaged), and the flag write/clear functions. `CrashRecoveryService` reads `isGpuDisabledByFlag` to enrich crash entries with `gpuAccelerationDisabled`.

There is no GPU banner — recovery is a transparent relaunch.

---

## 5. PTY-host health & the host-crash banner

The PTY host is its own UtilityProcess; if it wedges, terminals freeze but main is fine. `electron/services/pty/PtyHealthWatchdog.ts` (~278 LOC) owns the heartbeat for a single host run, delegated from `PtyClient`.

Each interval tick: increment `missedHeartbeats`, send `{ type: "health-check" }`; the next `pong` resets the counter (`recordPong`) and records an RTT sample. At `missedHeartbeats >= maxMissedHeartbeats` it **force-kills the host with `process.kill(child.pid, "SIGKILL")`** — `UtilityProcess.kill()` only sends SIGTERM, so the OS-level SIGKILL is required for a truly wedged host — and emits a `host-crash-details` event (`HostCrashPayload`, `crashType: "SIGNAL_TERMINATED"`).

Sleep/wake uses a one-ping handshake: `pause()` tears down the interval and any in-flight handshake; `resume()` sends a single ping and waits up to `HANDSHAKE_TIMEOUT_MS = 5_000` for the pong before starting the normal interval (whether or not the pong arrives). It also tracks a rolling RTT buffer (`RTT_BUFFER_SIZE = 20`) and logs p50/p95/p99 periodically, warning on spikes over `RTT_WARN_THRESHOLD_MS = 5_000`.

### Relation to the host-crash banner

A PTY-host crash (watchdog SIGKILL, or any host exit) flows through `PtyClient` → backend-health store listeners → `usePanelStore.backendStatus`. `HostCrashBanner` (`src/components/Recovery/HostCrashBanner.tsx`) renders whenever `backendStatus !== "connected"`:

- `"recovering"` → a spinner banner, gated behind the 400ms Doherty threshold (`useDohertyGate`) so a fast reconnect never flashes a banner.
- `"disconnected"` → an error banner with a `terminal.restartService` action and a "Send diagnostics" affordance.

This is the **most-urgent global banner** (top of the priority list) because the backend is unusable _right now_.

---

## 6. Global banner coordination & local-error suppression

All seven top-of-app recovery banners compete for a **single slot**. `useGlobalBannerPriority` (`src/components/Recovery/useGlobalBannerPriority.ts`) computes the winner; `GlobalBannerCoordinator` (mounted once in `App.tsx`) renders exactly one and **unmounts** the rest (so e.g. `RestoreConfirmationBanner`'s auto-dismiss timer only runs while visible).

Precedence (high → low):

```
host-crash         backendStatus !== "connected"   — backend unusable now
watchdog-disabled  watchdogStatus === "disabled"    — deadlock detector gone
safe-mode          safeMode && !dismissed           — panels held back after a crash loop
restore-confirmation                                — informational "session recovered"
forge-token                                         — expired forge credentials
cloud-sync                                          — synced-folder warning
rosetta                                             — x64 build translated on Apple Silicon
```

Watchdog ranks below host-crash (a live failure beats a downed monitor) and above safe-mode (the watchdog protects against the _next_ crash; safe-mode is a consequence of the _previous_ one).

### The local-error suppression rule

When a global recovery cause is active, **pane-local backend-dependent error banners are suppressed** — the user can't act on a per-pane "reconnect failed" while the global host-crash banner already owns the recovery action. `useShouldSuppressLocalError(category)` (`src/components/Recovery/useShouldSuppressLocalError.ts`) implements this:

- `category: "backend-dependent"` → suppressed whenever _any_ global cause is active.
- `category: "parse-error"` / `"permission-error"` → never suppressed (the terminal is operational; the user can fix these independently of host connectivity).

Suppression is **sticky-on / delayed-off**: it turns true synchronously with render (so a local banner never races a host-crash banner into view) and turns false only after `LOCAL_ERROR_SETTLE_MS` of sustained no-cause — absorbing `backendStatus` flicker between `"recovering"` and `"connected"`. Performance mode bypasses the settle window; reduced-motion does **not** (CSS owns reduced-motion; JS timers stay intact). This stacks on top of the 500ms backend-side recovery timer, giving a total dead-zone of roughly `500 + LOCAL_ERROR_SETTLE_MS` from reconnect to local-banner reappear.

---

## WaitingWatchdog (stuck-waiting agent detection)

`electron/services/pty/WaitingWatchdog.ts` (~118 LOC) is a different beast — it detects an **agent stuck in `waiting`**, not a process failure, and belongs to the agent-activity layer ([agent-activity-monitoring.md](./agent-activity-monitoring.md), [agent-state-tracking-strategy.md](./agent-state-tracking-strategy.md)). Included here only to disambiguate it from the process watchdogs above.

It fires only when an agent has been `idle` longer than `maxWaitingSilenceMs` (a ~10-minute ceiling) **and** a streak of consecutive probes finds no sign of life. It is heavily veto-biased: a spinner, a recent working-pattern match, fresh PTY data, high CPU, or _any_ active child process in the process tree all reset the fail streak. The process-tree probe is the **sole dead-vote signal** — `null` (validator unavailable or threw) is ambiguous and resets the streak. Only after `failThreshold` consecutive unambiguous dead votes does `onFire` trigger. It does not kill anything and is unrelated to the host-crash banner.

---

## Key files

| File | Role |
| --- | --- |
| `electron/watchdog-host-core.ts` | Pure watchdog state machine + kill-flag payload + `parseMainPid` |
| `electron/watchdog-host.ts` | UtilityProcess entry: SIGKILL primitives, flag write |
| `electron/services/MainProcessWatchdogClient.ts` | Main-side ping/backoff/`onDisabled` manager |
| `electron/services/CrashRecoveryService.ts` | Marker, rolling backup, restore, crash classification |
| `electron/services/CrashLoopGuardService.ts` | Consecutive-crash counter, safe mode, hard stop |
| `electron/services/GpuCrashMonitorService.ts` | GPU-crash escalation (ANGLE fallback → disable) |
| `electron/services/pty/PtyHealthWatchdog.ts` | PTY-host heartbeat + SIGKILL + RTT |
| `electron/services/pty/WaitingWatchdog.ts` | Stuck-waiting _agent_ detection (not a process guard) |
| `electron/ipc/handlers/watchdog.ts` | `watchdog.restart` IPC + broadcast re-wire |
| `electron/ipc/handlers/app/state.ts` | Safe-mode panel-skip at hydration |
| `src/components/Recovery/GlobalBannerCoordinator.tsx` | Single-slot top-of-app banner |
| `src/components/Recovery/useGlobalBannerPriority.ts` | Banner precedence |
| `src/components/Recovery/useShouldSuppressLocalError.ts` | Local-error suppression rule |
| `src/components/Recovery/CrashRecoveryDialog.tsx` | Pending-crash restore dialog |
| `src/components/Recovery/SafeModeBanner.tsx` | Safe-mode banner + quarantine list |
| `src/components/Recovery/WatchdogDisabledBanner.tsx` | Degraded-detector banner |
| `src/components/Recovery/HostCrashBanner.tsx` | PTY-host-down banner (via `backendStatus`) |

## See also

- [fatal-error-spine.md](./fatal-error-spine.md) — the `running.lock` dirty-exit contract, signal/shutdown paths, and the synchronous fatal-error handler that feeds `recordCrash()`.
- [agent-activity-monitoring.md](./agent-activity-monitoring.md) and [agent-state-tracking-strategy.md](./agent-state-tracking-strategy.md) — the agent-state machine that `WaitingWatchdog` participates in.
- [terminal-lifecycle.md](./terminal-lifecycle.md) — PTY host lifecycle and the `PtyHostLifecycle` backoff that `PtyHealthWatchdog` and `MainProcessWatchdogClient` intentionally stay out of phase with.
