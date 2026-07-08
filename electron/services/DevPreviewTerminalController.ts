import type { DevPreviewSessionStatus } from "../../shared/types/ipc/devPreview.js";
import type { DevServerError } from "../../shared/utils/devServerErrors.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import { markPerformance } from "../utils/performance.js";
import { CRASH_SIGNALS, EXPECTED_TERMINATION_SIGNALS } from "./pty/terminalForensics.js";
import {
  normalizeNextjsDevCommand,
  normalizeViteDevCommand,
} from "./DevPreviewCommandNormalizer.js";
import { guardedReinstall, type CrashLoopGuardSession } from "./DevPreviewCrashLoopGuard.js";
import { classifyDevPreviewExit } from "./DevPreviewOutputProcessor.js";
import { capDiagnosticText, type DevPreviewDiagnosticInput } from "./DevPreviewDiagnosticsRing.js";
import { detectInstallCommand } from "./DevPreviewDiskUsage.js";
import {
  allocatePort,
  releasePort,
  waitForPortFree,
  PORT_FREE_TIMEOUT_MS,
} from "./DevPreviewPortAllocator.js";
import { createSessionKey, sanitizeToken } from "./DevPreviewRequestValidators.js";
import type { PtyClient } from "./PtyClient.js";

const DEFAULT_TIMEOUT_MS = 8000;
const STALE_START_RECOVERY_MS = 10000;
const STARTUP_REPLAY_DELAY_MS = 1500;
const REPLAY_HISTORY_MAX_LINES = 300;
const PTY_SUBMIT_AFTER_SPAWN_MS = 100;

// Local copy of the orchestrator's RUNNING_STATES: duplicated (not imported)
// to keep the import arrow one-directional (orchestrator -> this module only).
const RUNNING_STATES: ReadonlySet<DevPreviewSessionStatus> = new Set([
  "starting",
  "installing",
  "running",
]);

export interface TerminalControllerSession extends CrashLoopGuardSession {
  panelId: string;
  projectId: string;
  cwd: string;
  devCommand: string;
  turbopackEnabled: boolean;
  env?: Record<string, string>;
  buffer: string;
  lastErrorKey: string | null;
  terminalId: string | null;
  status: DevPreviewSessionStatus;
  url: string | null;
  predictedUrl: string | null;
  pendingUrl: string | null;
  readinessAbort: AbortController | null;
  markerSeen: boolean;
  needsInstall: boolean;
  isRunningInstall: boolean;
  installAttemptedGeneration: number | null;
  startupReplayTimer: ReturnType<typeof setTimeout> | null;
  updatedAtPerformanceMs: number;
  compiling: boolean;
  compilingTimer: ReturnType<typeof setTimeout> | null;
  compilingClearTimer: ReturnType<typeof setTimeout> | null;
  phaseLabel?: "Compiling";
}

export interface TerminalControllerSessionUpdate {
  status?: DevPreviewSessionStatus;
  url?: string | null;
  predictedUrl?: string | null;
  error?: DevServerError | null;
  terminalId?: string | null;
  isRestarting?: boolean;
  generation?: number;
  phaseLabel?: "Compiling";
  forceKilled?: boolean;
}

export interface TerminalControllerDeps<TSession extends TerminalControllerSession> {
  ptyClient: PtyClient;
  portRegistry: Map<string, number>;
  terminalToSession: Map<string, string>;
  portWaitAborts: Set<AbortController>;
  isDisposed(): boolean;
  recordDiagnostic(key: string, generation: number, input: DevPreviewDiagnosticInput): void;
  recordSessionDiagnostic(session: TSession, input: DevPreviewDiagnosticInput): void;
  updateSession(session: TSession, updates: TerminalControllerSessionUpdate): void;
  clearCompiling(session: TSession): void;
  pollServerReadiness(
    session: TSession,
    url: string,
    signal: AbortSignal,
    generation: number
  ): void;
}

export function createTerminalId(
  session: Pick<TerminalControllerSession, "projectId" | "panelId">
): string {
  const projectToken = sanitizeToken(session.projectId);
  const panelToken = sanitizeToken(session.panelId);
  const timestampToken = Date.now().toString(36);
  const randomToken = Math.random().toString(36).slice(2, 8);
  return `dev-preview-${projectToken}-${panelToken}-${timestampToken}-${randomToken}`;
}

export function attachTerminal<TSession extends TerminalControllerSession>(
  session: TSession,
  terminalId: string,
  deps: Pick<TerminalControllerDeps<TSession>, "ptyClient" | "terminalToSession">
): void {
  const key = createSessionKey(session.projectId, session.panelId);
  if (session.terminalId && session.terminalId !== terminalId) {
    clearStartupReplay(session);
    deps.terminalToSession.delete(session.terminalId);
    deps.ptyClient.setIpcDataMirror(session.terminalId, false);
  }
  deps.terminalToSession.set(terminalId, key);
  deps.ptyClient.setIpcDataMirror(terminalId, true);
  session.terminalId = terminalId;
}

export function detachTerminal<TSession extends TerminalControllerSession>(
  session: TSession,
  deps: Pick<TerminalControllerDeps<TSession>, "ptyClient" | "terminalToSession">
): void {
  if (!session.terminalId) return;
  deps.terminalToSession.delete(session.terminalId);
  deps.ptyClient.setIpcDataMirror(session.terminalId, false);
  session.terminalId = null;
}

export function clearStartupReplay(session: TerminalControllerSession): void {
  if (session.startupReplayTimer !== null) {
    clearTimeout(session.startupReplayTimer);
    session.startupReplayTimer = null;
  }
}

function scheduleStartupReplay<TSession extends TerminalControllerSession>(
  session: TSession,
  deps: Pick<TerminalControllerDeps<TSession>, "ptyClient">
): void {
  clearStartupReplay(session);
  const generation = session.generation;
  const terminalId = session.terminalId;
  if (!terminalId) return;

  session.startupReplayTimer = setTimeout(() => {
    session.startupReplayTimer = null;
    if (
      session.generation !== generation ||
      session.terminalId !== terminalId ||
      session.status !== "starting" ||
      session.url ||
      session.pendingUrl
    ) {
      return;
    }
    void replayRecentOutput(terminalId, deps);
  }, STARTUP_REPLAY_DELAY_MS);
}

async function replayRecentOutput(
  terminalId: string,
  deps: { ptyClient: PtyClient }
): Promise<void> {
  try {
    await deps.ptyClient.replayHistoryAsync(terminalId, REPLAY_HISTORY_MAX_LINES);
  } catch (err) {
    console.warn("[DevPreviewSessionService] replayRecentOutput failed for terminal:", {
      terminalId,
      error: formatErrorMessage(err, "Failed to replay terminal history"),
    });
  }
}

export function isBenignMissingTerminalError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("not found") ||
    normalized.includes("does not exist") ||
    normalized.includes("terminal not found") ||
    normalized.includes("unknown terminal")
  );
}

async function isTerminalAlive(
  terminalId: string,
  projectId: string,
  deps: { ptyClient: PtyClient }
): Promise<boolean> {
  try {
    const terminal = await deps.ptyClient.getTerminalAsync(terminalId);
    if (!terminal || !terminal.hasPty) return false;
    if (terminal.projectId && terminal.projectId !== projectId) return false;
    return true;
  } catch {
    return false;
  }
}

async function waitForTerminalGone(
  terminalId: string,
  projectId: string,
  deps: { ptyClient: PtyClient },
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const alive = await isTerminalAlive(terminalId, projectId, deps);
    if (!alive) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export async function stopSessionTerminal<TSession extends TerminalControllerSession>(
  session: TSession,
  context: string,
  deps: TerminalControllerDeps<TSession>,
  escalationDelayMs?: number
): Promise<void> {
  clearStartupReplay(session);
  session.readinessAbort?.abort();
  session.readinessAbort = null;
  // Cancel a pending crash-loop backoff: otherwise the deferred re-install
  // fires after the terminal is gone (and, on the delete paths, after the
  // session is removed), spawning an orphan PTY on a stopped session.
  session.backoffAbort?.abort();
  session.backoffAbort = null;
  session.pendingUrl = null;
  session.markerSeen = false;
  deps.clearCompiling(session);
  session.needsInstall = false;
  session.isRunningInstall = false;

  const terminalId = session.terminalId;
  if (!terminalId) return;

  detachTerminal(session, deps);
  session.buffer = "";
  session.lastErrorKey = null;

  try {
    if (escalationDelayMs !== undefined) {
      deps.ptyClient.kill(terminalId, `dev-preview:${context}`, { escalationDelayMs });
    } else {
      deps.ptyClient.kill(terminalId, `dev-preview:${context}`);
    }
  } catch (err) {
    const message = formatErrorMessage(err, "Failed to kill dev preview terminal");
    if (!isBenignMissingTerminalError(message)) {
      throw new Error(`Failed to kill terminal (${context}): ${message}`, { cause: err });
    }
  }

  const stopped = await waitForTerminalGone(terminalId, session.projectId, deps);
  if (!stopped) {
    throw new Error(`Timed out waiting for terminal ${terminalId} to stop (${context})`);
  }
}

/**
 * Wait for the session's registered port to release before respawning. On
 * Windows a force-killed dev server can hold the socket in TIME_WAIT, which
 * would otherwise cause the next spawn to fail with EADDRINUSE on the same
 * port (allocatePort returns the registered port without re-probing).
 * Returns true if free (or no port registered); on timeout, releases the
 * port from the registry so a subsequent allocate picks a fresh candidate
 * and surfaces an error state.
 */
export async function waitForRegisteredPortFree<TSession extends TerminalControllerSession>(
  session: TSession,
  key: string,
  deps: TerminalControllerDeps<TSession>
): Promise<boolean> {
  const port = deps.portRegistry.get(key);
  if (port === undefined) return true;
  const abort = new AbortController();
  deps.portWaitAborts.add(abort);
  const free = await waitForPortFree(port, abort.signal).finally(() => {
    deps.portWaitAborts.delete(abort);
  });
  if (free) return true;
  releasePort(deps.portRegistry, key);
  deps.recordSessionDiagnostic(session, { type: "port-conflict", port });
  deps.updateSession(session, {
    status: "error",
    url: null,
    predictedUrl: null,
    error: {
      type: "port-conflict",
      message: `Port ${port} did not release within ${PORT_FREE_TIMEOUT_MS / 1000}s. Retry to start again.`,
      port: String(port),
    },
    terminalId: null,
    isRestarting: false,
    phaseLabel: undefined,
  });
  return false;
}

export async function ensureSessionTerminal<TSession extends TerminalControllerSession>(
  session: TSession,
  deps: TerminalControllerDeps<TSession>
): Promise<void> {
  if (session.terminalId) {
    const alive = await isTerminalAlive(session.terminalId, session.projectId, deps);
    if (alive) {
      const terminalId = session.terminalId;
      attachTerminal(session, terminalId, deps);
      if (!RUNNING_STATES.has(session.status)) {
        deps.updateSession(session, {
          status: "starting",
          error: null,
          url: null,
          forceKilled: undefined,
        });
      }

      if ((session.status === "starting" || session.status === "installing") && !session.url) {
        await replayRecentOutput(terminalId, deps);
      }

      if (
        session.status === "starting" &&
        !session.url &&
        !session.pendingUrl &&
        performance.now() - session.updatedAtPerformanceMs >= STALE_START_RECOVERY_MS
      ) {
        await stopSessionTerminal(session, "stale-start-recovery", deps);
        await spawnSessionTerminal(session, deps);
      }
      return;
    }
    detachTerminal(session, deps);
    session.readinessAbort?.abort();
    session.readinessAbort = null;
    session.pendingUrl = null;
    session.markerSeen = false;
    session.needsInstall = false;
    session.isRunningInstall = false;
    deps.updateSession(session, { terminalId: null, url: null, predictedUrl: null });
  }

  // A tripped crash-loop guard halts auto-respawn until the user restarts
  // explicitly. ensure() runs on every remount (dock↔grid, eviction
  // rehydration) with unchanged config, so without this the pane would
  // silently respawn a known-broken server on each transition. A config
  // change clears the guard upstream (resetCrashLoopGuard in ensure()), and
  // restart() clears it before spawning, so only the automatic path is held.
  if (session.crashLoopStopped) return;

  await spawnSessionTerminal(session, deps);
}

export async function spawnSessionTerminal<TSession extends TerminalControllerSession>(
  session: TSession,
  deps: TerminalControllerDeps<TSession>
): Promise<void> {
  const terminalId = createTerminalId(session);
  const nextGeneration = session.generation + 1;

  const sessionKey = createSessionKey(session.projectId, session.panelId);
  const port = await allocatePort(deps.portRegistry, sessionKey);
  // dispose() can fire while allocatePort awaits its net probe. Guard here
  // so we don't spawn a terminal on a disposed service; roll back the
  // reservation to avoid a stale portRegistry entry after disposal cleared it.
  if (deps.isDisposed()) {
    releasePort(deps.portRegistry, sessionKey);
    return;
  }
  // Recorded with the generation this spawn is about to become, so the whole
  // spawn lifecycle (port-allocated → spawned → …) shares one generation.
  deps.recordDiagnostic(sessionKey, nextGeneration, { type: "port-allocated", port });
  const predictedUrl = `http://localhost:${port}`;

  const spawnEnv: Record<string, string> = { ...session.env, PORT: String(port) };

  // Mark the dev-server spawn time for the crash-loop graduation check. Set
  // only here (the dev server), never in runInstall — an install is part of
  // recovery, not a crash, and must not count toward the survival window.
  session.devSpawnedAt = performance.now();

  session.buffer = "";
  session.lastErrorKey = null;
  session.markerSeen = false;
  session.predictedUrl = predictedUrl;
  deps.clearCompiling(session);
  attachTerminal(session, terminalId, deps);
  deps.updateSession(session, {
    terminalId,
    status: "starting",
    url: null,
    predictedUrl,
    error: null,
    generation: nextGeneration,
    forceKilled: undefined,
  });

  try {
    deps.ptyClient.spawn(terminalId, {
      projectId: session.projectId,
      kind: "dev-preview",
      cwd: session.cwd,
      cols: 80,
      rows: 30,
      restore: false,
      env: spawnEnv,
      isEphemeral: true,
    });
    markPerformance(PERF_MARKS.DEVPREVIEW_TERMINAL_SPAWNED, {
      panelId: session.panelId,
      projectId: session.projectId,
      terminalId,
    });
    deps.recordSessionDiagnostic(session, { type: "spawned", terminalId, port });

    // predictedUrl is the allocator-derived starting point for the readiness
    // poller — it's accurate for frameworks that honor env.PORT or the
    // injected --port flag, but not authoritative. UrlDetector overwrites
    // state.url when real output reveals a different bind address (e.g. next
    // dev auto-incrementing past EADDRINUSE on configs without --strictPort).
    setTimeout(() => {
      if (deps.isDisposed()) return;
      if (session.generation !== nextGeneration || session.terminalId !== terminalId) return;
      if (session.status !== "starting" || session.url || session.readinessAbort) return;

      const abort = new AbortController();
      session.readinessAbort = abort;
      deps.pollServerReadiness(session, predictedUrl, abort.signal, nextGeneration);
    }, 0);
  } catch (error) {
    const message = formatErrorMessage(error, "Failed to start dev server");
    deps.recordSessionDiagnostic(session, {
      type: "spawn-failed",
      message: capDiagnosticText(message),
    });
    detachTerminal(session, deps);
    deps.updateSession(session, {
      status: "error",
      url: null,
      predictedUrl: null,
      error: { type: "unknown", message: `Failed to start dev server: ${message}` },
      terminalId: null,
      isRestarting: false,
    });
    return;
  }

  const trimmedCommand = session.devCommand.trim();

  const submitCommand = (cmd: string) => {
    setTimeout(() => {
      try {
        if (deps.ptyClient.hasTerminal(terminalId)) {
          deps.ptyClient.submit(terminalId, cmd);
        }
      } catch (err) {
        console.warn("[DevPreviewSessionService] Failed to submit dev command:", err);
      }
    }, PTY_SUBMIT_AFTER_SPAWN_MS);
  };

  void normalizeNextjsDevCommand(trimmedCommand, session.cwd, session.turbopackEnabled)
    .then((nextNormalized) => normalizeViteDevCommand(nextNormalized, session.cwd, port))
    .then((normalizedCommand) => {
      submitCommand(normalizedCommand);
    })
    .catch(() => {
      submitCommand(trimmedCommand);
    });

  scheduleStartupReplay(session, deps);
}

export async function runInstall<TSession extends TerminalControllerSession>(
  session: TSession,
  deps: TerminalControllerDeps<TSession>
): Promise<void> {
  session.installAttemptedGeneration = session.generation;
  session.isRunningInstall = true;

  const installCommand = detectInstallCommand(session.cwd);
  deps.recordSessionDiagnostic(session, {
    type: "install-started",
    command: capDiagnosticText(installCommand),
  });

  const terminalId = createTerminalId(session);
  session.buffer = "";
  session.lastErrorKey = null;
  attachTerminal(session, terminalId, deps);
  deps.updateSession(session, {
    terminalId,
    status: "installing",
    error: {
      type: "missing-dependencies",
      message: `Running ${installCommand}...`,
    },
  });

  try {
    deps.ptyClient.spawn(terminalId, {
      projectId: session.projectId,
      kind: "dev-preview",
      cwd: session.cwd,
      cols: 80,
      rows: 30,
      restore: false,
      env: session.env,
      isEphemeral: true,
    });
  } catch (error) {
    session.isRunningInstall = false;
    const message = formatErrorMessage(error, "Failed to start dependency install");
    deps.recordSessionDiagnostic(session, {
      type: "install-failed",
      message: capDiagnosticText(message),
    });
    detachTerminal(session, deps);
    deps.updateSession(session, {
      status: "error",
      url: null,
      predictedUrl: null,
      error: { type: "unknown", message: `Failed to start dependency install: ${message}` },
      terminalId: null,
      isRestarting: false,
    });
    return;
  }

  setTimeout(() => {
    try {
      if (deps.ptyClient.hasTerminal(terminalId)) {
        deps.ptyClient.submit(terminalId, installCommand);
      }
    } catch (err) {
      console.warn("[DevPreviewSessionService] Failed to submit install command:", err);
    }
  }, PTY_SUBMIT_AFTER_SPAWN_MS);
}

/**
 * Handle a dev-preview terminal exit: clear pending timers/aborts, detach the
 * terminal, classify the failure (if any), and decide whether to auto-respawn
 * (install completion, crash-loop-guarded reinstall) or land in a terminal
 * stopped/error state. Mirrors the orchestrator's former `handleExit` body —
 * callers are expected to have already checked disposal/session-lookup/
 * terminal-id-match.
 */
export function handleDevPreviewTerminalExit<TSession extends TerminalControllerSession>(
  session: TSession,
  exitCode: number,
  signal: number | undefined,
  deps: TerminalControllerDeps<TSession>
): void {
  clearStartupReplay(session);
  session.readinessAbort?.abort();
  session.readinessAbort = null;
  session.pendingUrl = null;
  session.markerSeen = false;
  deps.clearCompiling(session);

  detachTerminal(session, deps);
  const recentOutput = session.buffer;
  session.buffer = "";
  session.lastErrorKey = null;

  if (session.isRunningInstall) {
    session.isRunningInstall = false;
    if (exitCode === 0) {
      deps.recordSessionDiagnostic(session, { type: "install-completed" });
      void spawnSessionTerminal(session, deps);
      return;
    }
    deps.recordSessionDiagnostic(session, {
      type: "install-failed",
      message: `Dependency installation failed (exit code ${exitCode})`,
    });
    deps.updateSession(session, {
      status: "error",
      url: null,
      predictedUrl: null,
      error: {
        type: "missing-dependencies",
        message: `Dependency installation failed (exit code ${exitCode})`,
      },
      terminalId: null,
      isRestarting: false,
      phaseLabel: undefined,
    });
    return;
  }

  deps.recordSessionDiagnostic(session, {
    type: "terminal-exited",
    exitCode,
    ...(signal !== undefined ? { signal } : {}),
  });

  if (session.needsInstall && session.installAttemptedGeneration !== session.generation) {
    session.needsInstall = false;
    guardedReinstall(session, {
      isDisposed: deps.isDisposed,
      recordSessionDiagnostic: deps.recordSessionDiagnostic,
      updateSession: deps.updateSession,
      runInstall: (target) => runInstall(target, deps),
    });
    return;
  }
  session.needsInstall = false;

  if (
    session.status === "starting" ||
    session.status === "installing" ||
    session.status === "error"
  ) {
    // Expected termination signals during startup/error = clean stop (user interrupted it)
    if (signal !== undefined && EXPECTED_TERMINATION_SIGNALS.has(signal)) {
      deps.updateSession(session, {
        status: "stopped",
        url: null,
        predictedUrl: null,
        error: null,
        terminalId: null,
        isRestarting: false,
        phaseLabel: undefined,
      });
      return;
    }
    const error = classifyDevPreviewExit(exitCode, signal, recentOutput) ?? {
      type: "unknown",
      message: `Dev server exited with code ${exitCode}`,
    };
    deps.updateSession(session, {
      status: "error",
      url: null,
      predictedUrl: null,
      error,
      terminalId: null,
      isRestarting: false,
      phaseLabel: undefined,
    });
    return;
  }

  const crashError =
    signal !== undefined && CRASH_SIGNALS.has(signal)
      ? classifyDevPreviewExit(exitCode, signal, recentOutput)
      : null;

  deps.updateSession(session, {
    status: "stopped",
    url: null,
    predictedUrl: null,
    error: crashError,
    terminalId: null,
    isRestarting: false,
    phaseLabel: undefined,
  });
}
