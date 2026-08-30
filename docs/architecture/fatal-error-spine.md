# Fatal-Error Spine

This document describes how Daintree's main process handles every termination path — graceful or otherwise — and the invariants that keep the next launch honest.

The spine has one job: **on every exit path, the answer to "was the last exit clean?" must be correct on next launch**. `CrashRecoveryService.running.lock` is the source of truth for that answer. Every code path below either preserves the marker (dirty exit) or removes it (clean exit) — never both, never neither.

## Dirty-exit marker (`running.lock`)

`CrashRecoveryService` (`electron/services/CrashRecoveryService.ts`) writes `<userData>/running.lock` during `initialize()` and removes it during `cleanupOnExit()`. The presence of the marker on next launch means the previous session terminated without the cleanup chain completing — the launcher reads it via `consumeMarker()` and surfaces a pending-crash banner.

**Invariants:**

1. **The marker is the universal dirty-exit signal.** Any path that kills the process without removing the marker — `TerminateProcess`, `SIGKILL`, OS-forced termination after `HungAppTimeout`, hard `process.exit` from the safety belt, the `before-quit` error branch — looks like a crash on next launch. This is intentional: a truncated shutdown is operationally indistinguishable from a crash.
2. **`cleanupOnExit()` runs only on the success branch of the cleanup chain.** In `shutdown.ts`, the marker is removed inside the `Promise.race` success handler, before the safety-belt timer fires. The error/timeout branch deliberately does **not** call `cleanupOnExit()` — leaving the marker on disk is the dirty-exit signal. The marker-removal call is wrapped in `try/catch` and its failure is logged, not propagated: if the filesystem refuses the delete (AV lock, permission flap), the marker remains and the next launch will treat the exit as dirty. That is the correct outcome — the marker tracks "did the cleanup chain reach its end?", and a failed delete means the on-disk truth is still "session in progress".
3. **Telemetry must never block the marker write.** `closeTelemetry()` is called _after_ the marker writes (`cleanupOnExit()`, `markCleanExit()`, `markCleanLaunch()`) in the success branch of `Promise.race` in `shutdown.ts`. If telemetry hangs or throws, the marker is already gone and the exit is recorded as clean. The error branch only calls `closeTelemetry()` — no marker writes — for the same reason.
4. **`recordCrash()` writes a marker with crash metadata.** The fatal-error path writes the marker _with_ the crash entry attached, so the next-launch banner can show details. A path that records a crash and then somehow reaches `cleanupOnExit()` cleanly is fine — `cleanupOnExit()` skips marker removal when `crashRecorded` is true (the `if (!this.crashRecorded)` guard in `CrashRecoveryService.ts`).

## Signal path (`SIGTERM` / `SIGINT` / `SIGUSR2` / `SIGHUP`)

Registered in `registerAppLifecycleHandlers` (`electron/lifecycle/appLifecycle.ts`). The handler is:

```
setSignalShutdown();
const handle = setTimeout(() => {
  setSafetyBeltTimer(null);
  app.exit(1);
}, SAFETY_BELT_TIMEOUT_MS);
handle.unref();
setSafetyBeltTimer(handle);
app.quit();
```

- `setSignalShutdown()` tells the `before-quit` handler in `shutdown.ts` to skip the agent-count confirmation dialog (one of the `canShowDialog` conditions). The dialog is a foot-gun when the OS is asking the app to terminate.
- `app.quit()` enters the `before-quit` cleanup chain. The chain disposes services, closes the database, and on success calls `cleanupOnExit()` → marker removed.
- The safety-belt timer is a last-resort `app.exit(1)` (a **dirty** exit, never `process.exit(0)`) so a stuck dispose call cannot wedge the process while still reporting the correct exit code to process supervisors (systemd/nodemon). It is sized at the named `SAFETY_BELT_TIMEOUT_MS` constant (`shutdownConfig.ts`) = `CLEANUP_TIMEOUT_MS + 3_000 + 2_500` (10s + 3s + 2.5s = 15.5s): `CLEANUP_TIMEOUT_MS` covers the cleanup chain, the 3s is a historical buffer, and the 2.5s is the `closeTelemetry()` budget (Sentry init-wait cap 500ms + close timeout 2000ms). `.unref()` so this timer never holds the event loop open on its own.
- The belt handle is stored via `setSafetyBeltTimer()` (in `signalShutdownState.ts`) so `shutdown.ts` can call `clearSafetyBeltTimer()` before each of its `app.exit()` calls. Defusing the belt first means a slow `closeTelemetry()` can't let the timer fire after a normal exit and clobber the exit code with `exit(1)`. The handle lives in `signalShutdownState.ts` rather than `appLifecycle.ts` so `shutdown.ts` can cancel it without a cross-module import cycle.
- A second signal within 2000ms force-exits with status 1 — escape hatch when shutdown stalls. Repeats outside that window are ignored (cleanup is already running).

`SIGTERM` / `SIGINT` / `SIGUSR2` are always registered. `SIGHUP` is dev-only (`!app.isPackaged`):

- **`SIGUSR2`** is nodemon's restart signal in dev. Without this handler every rebuild bypassed `before-quit`, never ran `markCleanExit()`, and `CrashLoopGuard` counted each restart as a crash — after three rebuilds in a minute the dev app booted into safe mode for no reason.
- **`SIGHUP`** fires when the dev terminal closes. Packaged builds are TTY-detached, and launchd/systemd conventionally use `SIGHUP` to mean "reload config" — we deliberately do not intercept that.

## Windows planned-shutdown path (`session-end`)

Registered per-window in `registerWindowSessionEndHandler` (`electron/lifecycle/appLifecycle.ts`), called from `electron/main.ts` after `registerWindowForFocusThrottle(win)`. The handler is:

```
setSignalShutdown();
app.quit();
```

The `BrowserWindow.on("session-end")` event maps to Win32's `WM_ENDSESSION` and fires on **planned** termination: user logoff, standard shutdown, restart, Windows Update reboot, and Fast Startup (which is logoff + kernel hibernate). It does **not** fire on `TerminateProcess` / `taskkill /F` — those bypass the message pump entirely; the dirty-marker fallback covers them.

**Best-effort, not guaranteed.** Windows' default `HungAppTimeout` is 5 seconds. The full safety-belt budget is `SAFETY_BELT_TIMEOUT_MS` = 15.5 seconds. The OS will frequently kill the process mid-chain. This is acceptable because:

1. Without the handler, the marker is _always_ left on disk after a Windows shutdown — every reboot would look like a crash. With the handler, the chain at least _starts_, and on a fast machine often completes (DB close + a couple of service disposes is sub-second).
2. The dirty-marker fallback is honest about truncation: a partial cleanup that gets killed at 5s leaves `running.lock` on disk, the next launch shows the pending-crash banner, and `CrashRecoveryService` surfaces session-state from the last backup. This is the same UX as a real crash, which is the right outcome for "we got killed mid-cleanup".

**No `query-session-end` veto.** We do not register a `query-session-end` handler that calls `event.preventDefault()` to block the OS shutdown. The user asked the OS to shut down; that is the user's decision, not ours to second-guess.

**No `ShutdownBlockReasonCreate`.** Calling the Win32 API to extend the per-process shutdown deadline would require a native addon and additional packaging/ABI surface. The best-effort handler is strictly better than nothing; native-extension territory is out of scope.

## Unhandled-exception path

Registered in `registerGlobalErrorHandlers` (`electron/setup/globalErrorHandlers.ts`).

**`uncaughtException`** (`globalErrorHandlers.ts`) — the process is about to die:

1. `emergencyLogMainFatal()` writes a synchronous crash dump to disk (best-effort).
2. `CrashRecoveryService.recordCrash(error)` writes the marker _with_ crash metadata so the next launch can show details.
3. `appendPendingError()` stores the error record so the next session's renderer can display it.
4. `notifyRenderer()` posts the error to the current renderer (best-effort — the renderer may already be gone).
5. `CrashLoopGuard.shouldRelaunch()` decides whether to call `app.relaunch()` — bounded to prevent infinite crash-loop reboots.
6. `closeTelemetry()` drains Sentry, then `app.exit(1)`. The drain is required because this handler is registered before `initializeTelemetry()` and fires before Sentry's own `onUncaughtExceptionIntegration`; a synchronous `app.exit(1)` would kill the process before the crash report could flush.

A re-entrant fatal (a second crash during the first crash handler) skips the telemetry drain and exits synchronously — a second crash mid-flush should not wait another 2 seconds.

**`unhandledRejection`** (`globalErrorHandlers.ts`) — the app **keeps running**:

- Logs, persists the error, and notifies the renderer.
- Deliberately does **NOT** call `recordCrash()`. Writing a marker here would poison every subsequent clean `Cmd-Q` on the next launch into looking like a crash. Only `uncaughtException` — which terminates the process — marks the crash.

## `before-quit` cleanup chain

Registered in `registerShutdownHandler` (`electron/lifecycle/shutdown.ts`). Triggered by every path above that calls `app.quit()`. The chain is `Promise.race(cleanupPromise, timeoutPromise)`:

- **Success branch**: three independent marker writes — `cleanupOnExit()` (marker removed), `getCrashLoopGuard().markCleanExit()`, and `getPanelSuspectLedger().markCleanLaunch()` — each in its own `try/catch` so one failure doesn't skip the others. Then `clearSafetyBeltTimer()`, then `closeTelemetry()`, then `app.exit(0)`. The marker writes precede the telemetry drain so a telemetry failure can't poison the next launch.
- **Error/timeout branch**: log, `clearSafetyBeltTimer()`, `closeTelemetry()`, then `app.exit(1)`. Marker is deliberately preserved — dirty exit on next launch.

The chain is also gated by an `isQuitting` flag (`shutdown.ts`) that prevents double-entry. This matters when two triggers race — e.g., a `SIGTERM` during a `session-end`. The first `app.quit()` sets `isQuitting`; the second `before-quit` returns immediately.

`isConfirmingQuit` suppresses re-entry while the agent-count confirmation dialog is open. The dialog (`canShowDialog`) is gated by a three-way AND: it shows only when `process.env.DAINTREE_E2E_MODE !== "1"` **and** `!isSignalShutdown()` **and** a primary `BrowserWindow` exists (`deps.windowRegistry?.getPrimary()?.browserWindow != null`). The signal path and Windows `session-end` path both set the signal flag specifically to skip it; E2E mode and a missing primary window suppress it for their own reasons.

## CrashRecoveryService fallback

The marker is the safety net for every path the in-process handlers cannot cover:

| Termination path | Handler | Marker outcome |
| --- | --- | --- |
| `SIGTERM` / `SIGINT` (graceful) | Signal handler → `before-quit` success | Removed (clean) |
| `SIGUSR2` (nodemon dev restart) | Signal handler → `before-quit` success | Removed (clean) |
| `SIGHUP` (dev terminal close) | Signal handler → `before-quit` success | Removed (clean) |
| Windows planned shutdown (`session-end`) | `registerWindowSessionEndHandler` → `before-quit` | Removed if chain completes within `HungAppTimeout`; preserved otherwise |
| `uncaughtException` | `globalErrorHandlers` → `recordCrash` + `app.exit(1)` | Preserved with crash metadata |
| `unhandledRejection` | `globalErrorHandlers` (no exit) | Unchanged — app keeps running |
| `before-quit` cleanup timeout | `shutdown.ts` error branch → `app.exit(1)` | Preserved (dirty) |
| Renderer-initiated quit, no agents | `app.quit()` → `before-quit` success | Removed (clean) |
| Renderer-initiated quit, user confirms agents-running dialog | `before-quit` success | Removed (clean) |
| `SIGKILL` / `kill -9` | None — kernel-level termination | Preserved (dirty) |
| `TerminateProcess` / `taskkill /F` | None — bypasses message pump | Preserved (dirty) |
| OS kill after `HungAppTimeout` | None — `session-end` started but didn't finish | Preserved (dirty) |
| Power loss / hard reboot | None | Preserved (dirty) |

The bottom four rows are exactly the cases the marker is designed for. On next launch, `CrashRecoveryService.initialize()` calls `consumeMarker()` — if the marker is present, the renderer is told to surface the pending-crash banner with the last session-state backup.

## Related files

- `electron/lifecycle/appLifecycle.ts` — signal registration, Windows `session-end` registration
- `electron/lifecycle/shutdown.ts` — `before-quit` cleanup chain, `isQuitting` / `isConfirmingQuit` guards, marker-on-success-only policy
- `electron/lifecycle/shutdownConfig.ts` — `CLEANUP_TIMEOUT_MS`
- `electron/lifecycle/signalShutdownState.ts` — `setSignalShutdown` / `isSignalShutdown` flag
- `electron/setup/globalErrorHandlers.ts` — `uncaughtException` / `unhandledRejection`
- `electron/services/CrashRecoveryService.ts` — marker write/read/delete, session-state backups
- `electron/services/CrashLoopGuardService.ts` — relaunch budget, safe-mode boot
- `electron/services/TelemetryService.ts` — `closeTelemetry` timeout constants
