import type { DevPreviewSessionStatus } from "../../shared/types/ipc/devPreview.js";
import type { DevServerError } from "../../shared/utils/devServerErrors.js";
import type { DevPreviewDiagnosticInput } from "./DevPreviewDiagnosticsRing.js";

// Per-session crash-loop guard. A broken config (missing deps that an install
// can't fix) otherwise drives an unbounded install→crash→reinstall cycle that
// burns CPU and battery. The guard counts consecutive fast cycles, backs off
// geometrically between re-install attempts, and after CRASH_LOOP_MAX_ATTEMPTS
// halts auto-respawn into a recoverable "stopped" state. A dev server that
// survives CRASH_LOOP_MIN_UPTIME_MS graduates and resets the counter. Values
// are tuned for a dev workflow (sub-3s cap) — not Kubernetes-style multi-minute
// waits — so a developer who just fixed the bug isn't punished. The first
// re-install in a fresh window runs immediately; backoff applies only to
// repeats.
export const CRASH_LOOP_MIN_UPTIME_MS = 5000;
export const CRASH_LOOP_INITIAL_DELAY_MS = 500;
export const CRASH_LOOP_BACKOFF_MULTIPLIER = 1.5;
export const CRASH_LOOP_MAX_DELAY_MS = 3000;
export const CRASH_LOOP_MAX_ATTEMPTS = 5;

export interface CrashLoopGuardSession {
  backoffAbort: AbortController | null;
  crashCount: number;
  devSpawnedAt: number | null;
  crashLoopStopped: boolean;
  generation: number;
}

export interface CrashLoopSessionUpdate {
  status?: DevPreviewSessionStatus;
  url?: string | null;
  predictedUrl?: string | null;
  error?: DevServerError | null;
  terminalId?: string | null;
  isRestarting?: boolean;
  crashLoopStopped?: boolean;
  phaseLabel?: "Compiling";
}

export interface CrashLoopGuardDeps<TSession extends CrashLoopGuardSession> {
  isDisposed(): boolean;
  recordSessionDiagnostic(session: TSession, input: DevPreviewDiagnosticInput): void;
  updateSession(session: TSession, updates: CrashLoopSessionUpdate): void;
  runInstall(session: TSession): void | Promise<void>;
}

/**
 * Clear the crash-loop guard for an explicit user- or config-driven restart:
 * cancel any pending backoff, zero the counter, and lift the stopped flag.
 * Callers must run this before spawning/installing so the broadcast that
 * follows reports a fresh (non-crash-looped) state.
 */
export function resetCrashLoopGuard(session: CrashLoopGuardSession): void {
  session.backoffAbort?.abort();
  session.backoffAbort = null;
  session.crashCount = 0;
  session.crashLoopStopped = false;
}

/**
 * Run `action` after `delayMs`, guarded so a user restart or dispose during
 * the wait cancels it. The pending AbortController is parked on the session;
 * resetCrashLoopGuard()/dispose() abort it to clear the timer, and the
 * generation check rejects a respawn whose session moved on while waiting.
 */
function scheduleBackoffRespawn(
  session: CrashLoopGuardSession,
  delayMs: number,
  action: () => void,
  isDisposed: () => boolean
): void {
  session.backoffAbort?.abort();
  const abort = new AbortController();
  session.backoffAbort = abort;
  const generation = session.generation;
  const timer = setTimeout(() => {
    if (session.backoffAbort === abort) session.backoffAbort = null;
    if (isDisposed() || abort.signal.aborted || session.generation !== generation) return;
    action();
  }, delayMs);
  abort.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
}

/**
 * Decide whether to auto-respawn after a dev-server exit that wants a
 * (re)install, applying the crash-loop guard. A server that survived
 * CRASH_LOOP_MIN_UPTIME_MS graduates and resets the counter. Once
 * CRASH_LOOP_MAX_ATTEMPTS consecutive fast cycles accumulate, auto-respawn
 * halts and the session lands in a recoverable "stopped" state. Otherwise
 * the install is scheduled — immediately for the first attempt in a window,
 * with geometric backoff for repeats. Returns nothing; the caller must
 * `return` after invoking it (it owns the respawn decision).
 */
export function guardedReinstall<TSession extends CrashLoopGuardSession>(
  session: TSession,
  deps: CrashLoopGuardDeps<TSession>
): void {
  const uptime =
    session.devSpawnedAt !== null ? performance.now() - session.devSpawnedAt : Infinity;
  if (uptime >= CRASH_LOOP_MIN_UPTIME_MS) {
    session.crashCount = 0;
  }
  session.crashCount += 1;

  if (session.crashCount > CRASH_LOOP_MAX_ATTEMPTS) {
    deps.recordSessionDiagnostic(session, { type: "crash-loop-stopped" });
    deps.updateSession(session, {
      status: "stopped",
      url: null,
      predictedUrl: null,
      error: null,
      terminalId: null,
      isRestarting: false,
      crashLoopStopped: true,
      phaseLabel: undefined,
    });
    return;
  }

  const delayMs =
    session.crashCount <= 1
      ? 0
      : Math.min(
          CRASH_LOOP_INITIAL_DELAY_MS * CRASH_LOOP_BACKOFF_MULTIPLIER ** (session.crashCount - 2),
          CRASH_LOOP_MAX_DELAY_MS
        );

  if (delayMs === 0) {
    void deps.runInstall(session);
    return;
  }
  deps.recordSessionDiagnostic(session, {
    type: "crash-loop-backoff",
    attempt: session.crashCount,
    delayMs,
  });
  scheduleBackoffRespawn(
    session,
    delayMs,
    () => {
      void deps.runInstall(session);
    },
    deps.isDisposed
  );
}
