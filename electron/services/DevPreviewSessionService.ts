import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import {
  getInvalidCommandMessage,
  normalizeNextjsDevCommand,
} from "./DevPreviewCommandNormalizer.js";
import {
  allocatePort,
  releasePort,
  waitForPortFree,
  PORT_FREE_TIMEOUT_MS,
} from "./DevPreviewPortAllocator.js";
import { waitForServerReady, READINESS_TIMEOUT_MS } from "./DevPreviewReadinessProbe.js";
import {
  createSessionKey,
  sanitizeToken,
  cloneEnv,
  envEquals,
  validateEnsureRequest,
  validateSessionRequest,
  validateStopByPanelRequest,
} from "./DevPreviewRequestValidators.js";

export { normalizeNextjsDevCommand } from "./DevPreviewCommandNormalizer.js";
import type { PtyClient } from "./PtyClient.js";
import { UrlDetector } from "./UrlDetector.js";
import type {
  DevPreviewEnsureRequest,
  DevPreviewSessionRequest,
  DevPreviewStopByPanelRequest,
  DevPreviewSessionState,
  DevPreviewSessionStatus,
  DevPreviewDirMeta,
  DevPreviewDestructivePreviewMeta,
  DevPreviewDestructivePreviewSizes,
  DevPreviewDestructivePreviewSizesRequest,
  DevPreviewPackageManager,
} from "../../shared/types/ipc/devPreview.js";
import type { DevServerError } from "../../shared/utils/devServerErrors.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import { markPerformance } from "../utils/performance.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

interface DevPreviewSession extends DevPreviewSessionState {
  cwd: string;
  devCommand: string;
  turbopackEnabled: boolean;
  env?: Record<string, string>;
  buffer: string;
  lastErrorKey: string | null;
  pendingUrl: string | null;
  readinessAbort: AbortController | null;
  markerSeen: boolean;
  needsInstall: boolean;
  isRunningInstall: boolean;
  installAttemptedGeneration: number | null;
  startupReplayTimer: ReturnType<typeof setTimeout> | null;
  updatedAtPerformanceMs: number;
  phaseLabel?: "Compiling";
  compilingEmitted: boolean;
  compilingTimer: ReturnType<typeof setTimeout> | null;
  forceKilled?: boolean;
}

const RUNNING_STATES: ReadonlySet<DevPreviewSessionStatus> = new Set([
  "starting",
  "installing",
  "running",
]);

// Framework build/dep caches wiped by restartAndClearCache, relative to the
// session cwd. node_modules/.vite is Vite's dep-optimization cache and is
// distinct from a root-level .vite directory.
const CACHE_DIRS: readonly string[] = [
  ".next",
  ".vite",
  ".turbo",
  path.join("node_modules", ".vite"),
];

const DEFAULT_TIMEOUT_MS = 8000;
const DEV_PREVIEW_STOP_ESCALATION_MS = 5000;
const STALE_START_RECOVERY_MS = 10000;
const STARTUP_REPLAY_DELAY_MS = 1500;
const REPLAY_HISTORY_MAX_LINES = 300;
const PTY_SUBMIT_AFTER_SPAWN_MS = 100;

export class DevPreviewSessionService {
  private readonly detector = new UrlDetector();
  private readonly textDecoder = new TextDecoder();
  private readonly sessions = new Map<string, DevPreviewSession>();
  private readonly terminalToSession = new Map<string, string>();
  private readonly locks = new Map<string, Promise<void>>();
  private disposed = false;
  private readonly portRegistry = new Map<string, number>(); // sessionKey -> allocated port
  private readonly worktreeToSession = new Map<string, string>(); // worktreeId -> sessionKey
  private readonly onDataListener: (id: string, data: string | Uint8Array) => void;
  private readonly onExitListener: (id: string, exitCode: number) => void;

  constructor(
    private readonly ptyClient: PtyClient,
    private readonly onStateChanged: (state: DevPreviewSessionState) => void
  ) {
    this.onDataListener = this.handleData.bind(this);
    this.onExitListener = this.handleExit.bind(this);
    this.ptyClient.on("data", this.onDataListener);
    this.ptyClient.on("exit", this.onExitListener);
  }

  /**
   * After a session is deleted, remove its stale worktreeToSession entry and
   * hand the mapping back to any surviving session that still claims the same worktreeId.
   */
  private restoreWorktreeMapping(worktreeId: string | undefined, deletedKey: string): void {
    if (!worktreeId) return;
    if (this.worktreeToSession.get(worktreeId) !== deletedKey) return;
    this.worktreeToSession.delete(worktreeId);
    for (const [survivingKey, survivingSession] of this.sessions) {
      if (survivingSession.worktreeId === worktreeId) {
        this.worktreeToSession.set(worktreeId, survivingKey);
        break;
      }
    }
  }

  getByWorktree(worktreeId: string): DevPreviewSessionState | null {
    const key = this.worktreeToSession.get(worktreeId);
    if (!key) return null;
    const session = this.sessions.get(key);
    if (!session) return null;
    return this.toPublicState(session);
  }

  dispose(): void {
    this.disposed = true;
    this.ptyClient.off("data", this.onDataListener);
    this.ptyClient.off("exit", this.onExitListener);
    for (const session of this.sessions.values()) {
      this.clearStartupReplay(session);
      session.readinessAbort?.abort();
      this.clearCompiling(session);
    }
    for (const terminalId of this.terminalToSession.keys()) {
      this.ptyClient.setIpcDataMirror(terminalId, false);
      try {
        this.ptyClient.kill(terminalId, "dev-preview:dispose");
      } catch (err) {
        const message = formatErrorMessage(err, "Failed to kill dev preview terminal");
        if (!this.isBenignMissingTerminalError(message)) {
          console.warn("[DevPreviewSessionService] Failed to kill terminal during dispose:", err);
        }
      }
    }
    this.terminalToSession.clear();
    this.sessions.clear();
    this.locks.clear();
    this.portRegistry.clear();
    this.worktreeToSession.clear();
  }

  async ensure(request: DevPreviewEnsureRequest): Promise<DevPreviewSessionState> {
    validateEnsureRequest(request);
    if (this.disposed) return this.getSessionState(request.projectId, request.panelId);
    markPerformance(PERF_MARKS.DEVPREVIEW_ENSURE_START, {
      panelId: request.panelId,
      projectId: request.projectId,
      worktreeId: request.worktreeId ?? null,
    });
    const key = createSessionKey(request.projectId, request.panelId);
    let state: DevPreviewSessionState | undefined;
    await this.runLocked(key, async () => {
      if (this.disposed) return;
      const session = this.getOrCreateSession(request.projectId, request.panelId);
      const envChanged = !envEquals(session.env, request.env);
      const nextTurbopackEnabled = request.turbopackEnabled ?? true;
      const configChanged =
        session.cwd !== request.cwd ||
        session.worktreeId !== request.worktreeId ||
        session.devCommand !== request.devCommand ||
        session.turbopackEnabled !== nextTurbopackEnabled ||
        envChanged;

      session.cwd = request.cwd;
      const prevWorktreeId = session.worktreeId;
      session.worktreeId = request.worktreeId;
      session.devCommand = request.devCommand;
      session.turbopackEnabled = nextTurbopackEnabled;
      if (envChanged) {
        session.env = cloneEnv(request.env);
      }

      if (prevWorktreeId && prevWorktreeId !== session.worktreeId) {
        this.worktreeToSession.delete(prevWorktreeId);
      }
      if (session.worktreeId) {
        const sessionKey = createSessionKey(session.projectId, session.panelId);
        this.worktreeToSession.set(session.worktreeId, sessionKey);
      }

      const commandError = getInvalidCommandMessage(session.devCommand);
      if (commandError) {
        if (configChanged && session.terminalId) {
          await this.stopSessionTerminal(session, "invalid-command");
        }
        this.updateSession(session, {
          status: "error",
          error: { type: "unknown", message: commandError },
          url: null,
          assignedUrl: null,
          terminalId: null,
          isRestarting: false,
        });
        return;
      }

      if (configChanged && session.terminalId) {
        await this.stopSessionTerminal(session, "config-change");
      }

      await this.ensureSessionTerminal(session);
      state = this.getSessionState(request.projectId, request.panelId);
    });
    return state ?? this.getSessionState(request.projectId, request.panelId);
  }

  async restart(request: DevPreviewSessionRequest): Promise<DevPreviewSessionState> {
    validateSessionRequest(request);
    const restartStartedAt = Date.now();
    markPerformance(PERF_MARKS.DEVPREVIEW_RESTART_START, {
      panelId: request.panelId,
      projectId: request.projectId,
    });
    const key = createSessionKey(request.projectId, request.panelId);
    let state: DevPreviewSessionState | undefined;
    try {
      await this.runLocked(key, async () => {
        const session = this.sessions.get(key);
        if (!session) return;

        const commandError = getInvalidCommandMessage(session.devCommand);
        if (commandError) {
          if (session.terminalId) {
            await this.stopSessionTerminal(session, "invalid-command");
          }
          this.updateSession(session, {
            status: "error",
            error: { type: "unknown", message: commandError },
            url: null,
            assignedUrl: null,
            terminalId: null,
            isRestarting: false,
          });
          state = this.getSessionState(request.projectId, request.panelId);
          return;
        }

        this.updateSession(session, {
          status: "starting",
          url: null,
          error: null,
          isRestarting: true,
          forceKilled: undefined,
        });

        await this.stopSessionTerminal(session, "restart");
        if (!(await this.waitForRegisteredPortFree(session, key))) {
          state = this.getSessionState(request.projectId, request.panelId);
          return;
        }
        await this.spawnSessionTerminal(session);
        state = this.getSessionState(request.projectId, request.panelId);
      });
    } finally {
      markPerformance(PERF_MARKS.DEVPREVIEW_RESTART_END, {
        panelId: request.panelId,
        projectId: request.projectId,
        durationMs: Date.now() - restartStartedAt,
      });
    }
    return state ?? this.getSessionState(request.projectId, request.panelId);
  }

  async restartAndClearCache(request: DevPreviewSessionRequest): Promise<DevPreviewSessionState> {
    validateSessionRequest(request);
    const key = createSessionKey(request.projectId, request.panelId);
    await this.runLocked(key, async () => {
      const session = this.sessions.get(key);
      if (!session) return;

      const commandError = getInvalidCommandMessage(session.devCommand);
      if (commandError) {
        if (session.terminalId) {
          await this.stopSessionTerminal(session, "invalid-command");
        }
        this.updateSession(session, {
          status: "error",
          error: { type: "unknown", message: commandError },
          url: null,
          assignedUrl: null,
          terminalId: null,
          isRestarting: false,
        });
        return;
      }

      this.updateSession(session, {
        status: "starting",
        url: null,
        error: null,
        isRestarting: true,
      });

      // Caches must be deleted only after the PTY is confirmed dead — Vite and
      // Next.js hold file handles on these directories, and a live process
      // causes EPERM on Windows.
      await this.stopSessionTerminal(session, "restart-clear-cache");

      if (!(await this.waitForRegisteredPortFree(session, key))) {
        return;
      }

      const deletionError = await this.clearCacheDirs(session.cwd);
      if (deletionError) {
        this.updateSession(session, {
          status: "error",
          url: null,
          assignedUrl: null,
          error: {
            type: "unknown",
            message: `Failed to clear cache: ${deletionError}`,
          },
          terminalId: null,
          isRestarting: false,
        });
        return;
      }

      await this.spawnSessionTerminal(session);
    });
    return this.getSessionState(request.projectId, request.panelId);
  }

  async reinstallAndRestart(request: DevPreviewSessionRequest): Promise<DevPreviewSessionState> {
    validateSessionRequest(request);
    const key = createSessionKey(request.projectId, request.panelId);
    await this.runLocked(key, async () => {
      const session = this.sessions.get(key);
      if (!session) return;

      const commandError = getInvalidCommandMessage(session.devCommand);
      if (commandError) {
        if (session.terminalId) {
          await this.stopSessionTerminal(session, "invalid-command");
        }
        this.updateSession(session, {
          status: "error",
          error: { type: "unknown", message: commandError },
          url: null,
          assignedUrl: null,
          terminalId: null,
          isRestarting: false,
        });
        return;
      }

      this.updateSession(session, {
        status: "starting",
        url: null,
        error: null,
        isRestarting: true,
      });

      await this.stopSessionTerminal(session, "reinstall-restart");

      // node_modules deletion uses retries because Windows Defender frequently
      // holds locks on files mid-scan, surfacing as transient EPERM/EBUSY.
      try {
        await fsPromises.rm(path.join(session.cwd, "node_modules"), {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      } catch (err) {
        const message = formatErrorMessage(err, "Failed to remove node_modules");
        this.updateSession(session, {
          status: "error",
          url: null,
          assignedUrl: null,
          error: {
            type: "unknown",
            message: `Failed to remove node_modules: ${message}`,
          },
          terminalId: null,
          isRestarting: false,
        });
        return;
      }

      // runInstall spawns its own install PTY; the handleExit chain respawns
      // the dev server when the install exits 0. Do NOT call
      // spawnSessionTerminal here — that would double-spawn.
      await this.runInstall(session);
    });
    return this.getSessionState(request.projectId, request.panelId);
  }

  /**
   * Deletes the framework cache directories under cwd. Returns an error
   * message string if any deletion failed, or null on success. `force: true`
   * makes missing directories a no-op.
   */
  private async clearCacheDirs(cwd: string): Promise<string | null> {
    const failures: string[] = [];
    for (const dir of CACHE_DIRS) {
      try {
        await fsPromises.rm(path.join(cwd, dir), { recursive: true, force: true });
      } catch (err) {
        failures.push(`${dir} (${formatErrorMessage(err, "deletion failed")})`);
      }
    }
    return failures.length > 0 ? failures.join(", ") : null;
  }

  async stop(request: DevPreviewSessionRequest): Promise<DevPreviewSessionState> {
    validateSessionRequest(request);
    const key = createSessionKey(request.projectId, request.panelId);
    await this.runLocked(key, async () => {
      const session = this.sessions.get(key);
      if (!session) return;

      if (session.terminalId) {
        this.updateSession(session, { status: "stopping", isRestarting: false });
        const stopStartedAt = performance.now();
        await this.stopSessionTerminal(session, "stop", DEV_PREVIEW_STOP_ESCALATION_MS);
        const forceKilled = performance.now() - stopStartedAt >= DEV_PREVIEW_STOP_ESCALATION_MS;

        const port = this.portRegistry.get(key);
        if (port !== undefined) {
          const portAbort = new AbortController();
          const portFree = await waitForPortFree(port, portAbort.signal);
          if (!portFree) {
            // Release the registry entry so a subsequent ensure() picks a fresh
            // port via allocatePort instead of immediately re-hitting the busy one.
            releasePort(this.portRegistry, key);
            this.updateSession(session, {
              status: "error",
              url: null,
              assignedUrl: null,
              error: {
                type: "port-conflict",
                message: `Port ${port} did not release within ${PORT_FREE_TIMEOUT_MS / 1000}s after stopping. Retry to start again.`,
                port: String(port),
              },
              terminalId: null,
              isRestarting: false,
              forceKilled,
              phaseLabel: undefined,
            });
            return;
          }
        }

        this.updateSession(session, {
          status: "stopped",
          url: null,
          assignedUrl: null,
          error: null,
          terminalId: null,
          isRestarting: false,
          forceKilled,
          phaseLabel: undefined,
        });
      } else {
        this.updateSession(session, {
          status: "stopped",
          url: null,
          assignedUrl: null,
          error: null,
          terminalId: null,
          isRestarting: false,
          phaseLabel: undefined,
        });
      }
    });
    return this.getSessionState(request.projectId, request.panelId);
  }

  async stopByPanel(request: DevPreviewStopByPanelRequest): Promise<void> {
    validateStopByPanelRequest(request);
    const targets = [...this.sessions.values()].filter(
      (session) => session.panelId === request.panelId
    );

    await Promise.all(
      targets.map(async (session) => {
        const key = createSessionKey(session.projectId, session.panelId);
        await this.runLocked(key, async () => {
          try {
            await this.stopSessionTerminal(session, "panel-closed");
            this.updateSession(session, {
              status: "stopped",
              url: null,
              assignedUrl: null,
              error: null,
              terminalId: null,
              isRestarting: false,
            });
            this.sessions.delete(key);
            releasePort(this.portRegistry, key);
            this.restoreWorktreeMapping(session.worktreeId, key);
          } catch (err) {
            const message = formatErrorMessage(err, "Failed to stop dev preview");
            this.updateSession(session, {
              status: "error",
              url: null,
              assignedUrl: null,
              error: { type: "unknown", message: `Failed to stop dev preview: ${message}` },
              terminalId: null,
              isRestarting: false,
            });
            console.warn("[DevPreviewSessionService] stopByPanel failed for session", {
              panelId: session.panelId,
              projectId: session.projectId,
              error: message,
            });
          }
        });
      })
    );
  }

  async stopByProject(projectId: string): Promise<void> {
    const targets = [...this.sessions.entries()].filter(
      ([, session]) => session.projectId === projectId
    );

    await Promise.all(
      targets.map(async ([key, session]) => {
        await this.runLocked(key, async () => {
          try {
            await this.stopSessionTerminal(session, "project-hibernated");
            this.updateSession(session, {
              status: "stopped",
              url: null,
              assignedUrl: null,
              error: null,
              terminalId: null,
              isRestarting: false,
            });
            this.sessions.delete(key);
            releasePort(this.portRegistry, key);
            this.restoreWorktreeMapping(session.worktreeId, key);
          } catch (err) {
            const message = formatErrorMessage(err, "Failed to stop dev preview");
            console.warn("[DevPreviewSessionService] stopByProject failed for session", {
              panelId: session.panelId,
              projectId: session.projectId,
              error: message,
            });
          }
        });
      })
    );
  }

  // Called from the renderer's worktree delete path BEFORE `git worktree
  // remove` runs. On Windows the dev server holds a directory lock — if the
  // session isn't stopped first, the removal fails outright (#9084). The
  // first stop failure rejects so the caller can abort the delete before
  // git removal makes a partial mess.
  async stopByWorktree(worktreeId: string): Promise<void> {
    const targets = [...this.sessions.entries()].filter(
      ([, session]) => session.worktreeId === worktreeId
    );

    const errors: unknown[] = [];
    await Promise.all(
      targets.map(async ([key, session]) => {
        await this.runLocked(key, async () => {
          try {
            await this.stopSessionTerminal(session, "worktree-delete");
            this.updateSession(session, {
              status: "stopped",
              url: null,
              assignedUrl: null,
              error: null,
              terminalId: null,
              isRestarting: false,
            });
            this.sessions.delete(key);
            releasePort(this.portRegistry, key);
            this.restoreWorktreeMapping(session.worktreeId, key);
          } catch (err) {
            const message = formatErrorMessage(err, "Failed to stop dev preview");
            console.warn("[DevPreviewSessionService] stopByWorktree failed for session", {
              panelId: session.panelId,
              projectId: session.projectId,
              worktreeId: session.worktreeId,
              error: message,
            });
            errors.push(err);
          }
        });
      })
    );

    if (errors.length > 0) {
      throw errors[0];
    }
  }

  getState(request: DevPreviewSessionRequest): DevPreviewSessionState {
    validateSessionRequest(request);
    return this.getSessionState(request.projectId, request.panelId);
  }

  private getOrCreateSession(projectId: string, panelId: string): DevPreviewSession {
    const key = createSessionKey(projectId, panelId);
    let session = this.sessions.get(key);
    if (session) return session;

    session = {
      panelId,
      projectId,
      worktreeId: undefined,
      status: "stopped",
      url: null,
      assignedUrl: null,
      error: null,
      terminalId: null,
      isRestarting: false,
      generation: 0,
      updatedAt: Date.now(),
      updatedAtPerformanceMs: performance.now(),
      phaseLabel: undefined,
      cwd: "",
      devCommand: "",
      turbopackEnabled: true,
      env: undefined,
      buffer: "",
      lastErrorKey: null,
      pendingUrl: null,
      readinessAbort: null,
      markerSeen: false,
      needsInstall: false,
      isRunningInstall: false,
      installAttemptedGeneration: null,
      startupReplayTimer: null,
      compilingEmitted: false,
      compilingTimer: null,
    };
    this.sessions.set(key, session);
    return session;
  }

  private getSessionState(projectId: string, panelId: string): DevPreviewSessionState {
    const key = createSessionKey(projectId, panelId);
    const session = this.sessions.get(key);
    if (!session) {
      return {
        panelId,
        projectId,
        worktreeId: undefined,
        status: "stopped",
        url: null,
        assignedUrl: null,
        error: null,
        terminalId: null,
        isRestarting: false,
        generation: 0,
        updatedAt: Date.now(),
        forceKilled: undefined,
        phaseLabel: undefined,
      };
    }
    return this.toPublicState(session);
  }

  private toPublicState(session: DevPreviewSession): DevPreviewSessionState {
    return {
      panelId: session.panelId,
      projectId: session.projectId,
      worktreeId: session.worktreeId,
      status: session.status,
      url: session.url,
      assignedUrl: session.assignedUrl,
      error: session.error,
      terminalId: session.terminalId,
      isRestarting: session.isRestarting,
      generation: session.generation,
      updatedAt: session.updatedAt,
      phaseLabel: session.phaseLabel,
      forceKilled: session.forceKilled,
    };
  }

  private updateSession(
    session: DevPreviewSession,
    updates: Partial<
      Pick<
        DevPreviewSession,
        | "status"
        | "url"
        | "assignedUrl"
        | "error"
        | "terminalId"
        | "isRestarting"
        | "worktreeId"
        | "generation"
        | "phaseLabel"
        | "forceKilled"
      >
    >
  ): void {
    if (this.disposed) return;
    if (updates.status !== undefined) session.status = updates.status;
    if (updates.url !== undefined) session.url = updates.url;
    if (updates.assignedUrl !== undefined) session.assignedUrl = updates.assignedUrl;
    if (updates.error !== undefined) session.error = updates.error;
    if (updates.terminalId !== undefined) session.terminalId = updates.terminalId;
    if (updates.isRestarting !== undefined) session.isRestarting = updates.isRestarting;
    if (updates.worktreeId !== undefined) session.worktreeId = updates.worktreeId;
    if (updates.generation !== undefined) session.generation = updates.generation;
    if ("phaseLabel" in updates) session.phaseLabel = updates.phaseLabel;
    if ("forceKilled" in updates) session.forceKilled = updates.forceKilled;
    session.updatedAt = Date.now();
    session.updatedAtPerformanceMs = performance.now();
    this.onStateChanged(this.toPublicState(session));
  }

  private async runLocked(key: string, task: () => Promise<void>): Promise<void> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(task)
      .finally(() => {
        if (this.locks.get(key) === next) {
          this.locks.delete(key);
        }
      });
    this.locks.set(key, next);
    return next;
  }

  private async ensureSessionTerminal(session: DevPreviewSession): Promise<void> {
    if (session.terminalId) {
      const alive = await this.isTerminalAlive(session.terminalId, session.projectId);
      if (alive) {
        const terminalId = session.terminalId;
        this.attachTerminal(session, terminalId);
        if (!RUNNING_STATES.has(session.status)) {
          this.updateSession(session, {
            status: "starting",
            error: null,
            url: null,
            forceKilled: undefined,
          });
        }

        if ((session.status === "starting" || session.status === "installing") && !session.url) {
          await this.replayRecentOutput(terminalId);
        }

        if (
          session.status === "starting" &&
          !session.url &&
          !session.pendingUrl &&
          performance.now() - session.updatedAtPerformanceMs >= STALE_START_RECOVERY_MS
        ) {
          await this.stopSessionTerminal(session, "stale-start-recovery");
          await this.spawnSessionTerminal(session);
        }
        return;
      }
      this.detachTerminal(session);
      session.readinessAbort?.abort();
      session.readinessAbort = null;
      session.pendingUrl = null;
      session.markerSeen = false;
      session.needsInstall = false;
      session.isRunningInstall = false;
      this.updateSession(session, { terminalId: null, url: null, assignedUrl: null });
    }

    await this.spawnSessionTerminal(session);
  }

  private async replayRecentOutput(terminalId: string): Promise<void> {
    try {
      await this.ptyClient.replayHistoryAsync(terminalId, REPLAY_HISTORY_MAX_LINES);
    } catch (err) {
      console.warn("[DevPreviewSessionService] replayRecentOutput failed for terminal:", {
        terminalId,
        error: formatErrorMessage(err, "Failed to replay terminal history"),
      });
    }
  }

  private async spawnSessionTerminal(session: DevPreviewSession): Promise<void> {
    const terminalId = this.createTerminalId(session);
    const nextGeneration = session.generation + 1;

    const sessionKey = createSessionKey(session.projectId, session.panelId);
    const port = await allocatePort(this.portRegistry, sessionKey);
    // dispose() can fire while allocatePort awaits its net probe. Guard here
    // so we don't spawn a terminal on a disposed service; roll back the
    // reservation to avoid a stale portRegistry entry after disposal cleared it.
    if (this.disposed) {
      releasePort(this.portRegistry, sessionKey);
      return;
    }
    const assignedUrl = `http://localhost:${port}`;

    const spawnEnv: Record<string, string> = { ...session.env, PORT: String(port) };

    session.buffer = "";
    session.lastErrorKey = null;
    session.markerSeen = false;
    session.assignedUrl = assignedUrl;
    this.clearCompiling(session);
    this.attachTerminal(session, terminalId);
    this.updateSession(session, {
      terminalId,
      status: "starting",
      url: null,
      assignedUrl,
      error: null,
      generation: nextGeneration,
      forceKilled: undefined,
    });

    try {
      this.ptyClient.spawn(terminalId, {
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

      // The allocated PORT is authoritative for the common zero-config path.
      // Keep output URL detection below as an override for servers that choose
      // their own port, but do not depend on a single terminal line to start.
      setTimeout(() => {
        if (this.disposed) return;
        if (session.generation !== nextGeneration || session.terminalId !== terminalId) return;
        if (session.status !== "starting" || session.url || session.readinessAbort) return;

        const abort = new AbortController();
        session.readinessAbort = abort;
        this.pollServerReadiness(session, assignedUrl, abort.signal, nextGeneration);
      }, 0);
    } catch (error) {
      const message = formatErrorMessage(error, "Failed to start dev server");
      this.detachTerminal(session);
      this.updateSession(session, {
        status: "error",
        url: null,
        assignedUrl: null,
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
          if (this.ptyClient.hasTerminal(terminalId)) {
            this.ptyClient.submit(terminalId, cmd);
          }
        } catch (err) {
          console.warn("[DevPreviewSessionService] Failed to submit dev command:", err);
        }
      }, PTY_SUBMIT_AFTER_SPAWN_MS);
    };

    void normalizeNextjsDevCommand(trimmedCommand, session.cwd, session.turbopackEnabled)
      .then((normalizedCommand) => {
        submitCommand(normalizedCommand);
      })
      .catch(() => {
        submitCommand(trimmedCommand);
      });

    this.scheduleStartupReplay(session);
  }

  private clearStartupReplay(session: DevPreviewSession): void {
    if (session.startupReplayTimer !== null) {
      clearTimeout(session.startupReplayTimer);
      session.startupReplayTimer = null;
    }
  }

  private scheduleStartupReplay(session: DevPreviewSession): void {
    this.clearStartupReplay(session);
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
      void this.replayRecentOutput(terminalId);
    }, STARTUP_REPLAY_DELAY_MS);
  }

  private createTerminalId(session: DevPreviewSession): string {
    const projectToken = sanitizeToken(session.projectId);
    const panelToken = sanitizeToken(session.panelId);
    const timestampToken = Date.now().toString(36);
    const randomToken = Math.random().toString(36).slice(2, 8);
    return `dev-preview-${projectToken}-${panelToken}-${timestampToken}-${randomToken}`;
  }

  private attachTerminal(session: DevPreviewSession, terminalId: string): void {
    const key = createSessionKey(session.projectId, session.panelId);
    if (session.terminalId && session.terminalId !== terminalId) {
      this.clearStartupReplay(session);
      this.terminalToSession.delete(session.terminalId);
      this.ptyClient.setIpcDataMirror(session.terminalId, false);
    }
    this.terminalToSession.set(terminalId, key);
    this.ptyClient.setIpcDataMirror(terminalId, true);
    session.terminalId = terminalId;
  }

  private detachTerminal(session: DevPreviewSession): void {
    if (!session.terminalId) return;
    this.terminalToSession.delete(session.terminalId);
    this.ptyClient.setIpcDataMirror(session.terminalId, false);
    session.terminalId = null;
  }

  private async stopSessionTerminal(
    session: DevPreviewSession,
    context: string,
    escalationDelayMs?: number
  ): Promise<void> {
    this.clearStartupReplay(session);
    session.readinessAbort?.abort();
    session.readinessAbort = null;
    session.pendingUrl = null;
    session.markerSeen = false;
    this.clearCompiling(session);
    session.needsInstall = false;
    session.isRunningInstall = false;

    const terminalId = session.terminalId;
    if (!terminalId) return;

    this.detachTerminal(session);
    session.buffer = "";
    session.lastErrorKey = null;

    try {
      if (escalationDelayMs !== undefined) {
        this.ptyClient.kill(terminalId, `dev-preview:${context}`, { escalationDelayMs });
      } else {
        this.ptyClient.kill(terminalId, `dev-preview:${context}`);
      }
    } catch (err) {
      const message = formatErrorMessage(err, "Failed to kill dev preview terminal");
      if (!this.isBenignMissingTerminalError(message)) {
        throw new Error(`Failed to kill terminal (${context}): ${message}`, { cause: err });
      }
    }

    const stopped = await this.waitForTerminalGone(terminalId, session.projectId);
    if (!stopped) {
      throw new Error(`Timed out waiting for terminal ${terminalId} to stop (${context})`);
    }
  }

  private isBenignMissingTerminalError(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes("not found") ||
      normalized.includes("does not exist") ||
      normalized.includes("terminal not found") ||
      normalized.includes("unknown terminal")
    );
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
  private async waitForRegisteredPortFree(
    session: DevPreviewSession,
    key: string
  ): Promise<boolean> {
    const port = this.portRegistry.get(key);
    if (port === undefined) return true;
    const abort = new AbortController();
    const free = await waitForPortFree(port, abort.signal);
    if (free) return true;
    releasePort(this.portRegistry, key);
    this.updateSession(session, {
      status: "error",
      url: null,
      assignedUrl: null,
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

  private async waitForTerminalGone(
    terminalId: string,
    projectId: string,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const alive = await this.isTerminalAlive(terminalId, projectId);
      if (!alive) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  private async isTerminalAlive(terminalId: string, projectId: string): Promise<boolean> {
    try {
      const terminal = await this.ptyClient.getTerminalAsync(terminalId);
      if (!terminal || !terminal.hasPty) return false;
      if (terminal.projectId && terminal.projectId !== projectId) return false;
      return true;
    } catch {
      return false;
    }
  }

  private clearCompiling(session: DevPreviewSession): void {
    if (session.compilingTimer !== null) {
      clearTimeout(session.compilingTimer);
      session.compilingTimer = null;
    }
    session.compilingEmitted = false;
    if (session.phaseLabel === "Compiling") {
      session.phaseLabel = undefined;
    }
  }

  private handleData(id: string, data: string | Uint8Array): void {
    if (this.disposed) return;
    const sessionKey = this.terminalToSession.get(id);
    if (!sessionKey) return;
    const session = this.sessions.get(sessionKey);
    if (!session || session.terminalId !== id) return;

    if (session.isRunningInstall) return;

    const dataString = typeof data === "string" ? data : this.textDecoder.decode(data);
    const result = this.detector.scanOutput(dataString, session.buffer);
    session.buffer = result.buffer;

    let urlJustStarted = false;
    if (result.url && result.url !== session.url && result.url !== session.pendingUrl) {
      markPerformance(PERF_MARKS.DEVPREVIEW_URL_DETECTED, {
        panelId: session.panelId,
        projectId: session.projectId,
        terminalId: id,
        url: result.url,
      });

      session.readinessAbort?.abort();
      const abort = new AbortController();
      session.readinessAbort = abort;
      session.pendingUrl = result.url;
      // A new URL (e.g. a port change) starts a fresh poll; allow its own
      // readiness marker to accelerate it again.
      session.markerSeen = false;

      this.clearCompiling(session);

      this.pollServerReadiness(session, result.url, abort.signal, session.generation);
      urlJustStarted = true;
    }

    // A framework readiness line ("ready in N ms", "✓ Ready in", "compiled
    // successfully") confirms the HTTP server is bound. When a poll is already
    // mid-cycle (sleeping between HEAD attempts), abort it and re-probe now to
    // skip the remaining poll interval. The poll itself stays the fallback for
    // unrecognized frameworks, so no marker means no behavior change.
    if (result.readyMarker && !session.markerSeen && !urlJustStarted && session.pendingUrl) {
      session.markerSeen = true;
      session.readinessAbort?.abort();
      const abort = new AbortController();
      session.readinessAbort = abort;
      this.pollServerReadiness(session, session.pendingUrl, abort.signal, session.generation);
    }

    // A readyMarker without a pending URL (post-install, pre-URL detection)
    // signals the framework is compiling. Debounce at 600ms to avoid label
    // flicker from markers that fire on consecutive data chunks.
    if (
      result.readyMarker &&
      !session.compilingEmitted &&
      session.status === "starting" &&
      !session.pendingUrl &&
      !session.isRunningInstall &&
      session.compilingTimer === null
    ) {
      session.compilingTimer = setTimeout(() => {
        session.compilingTimer = null;
        if (
          session.status === "starting" &&
          !session.pendingUrl &&
          !session.url &&
          !session.compilingEmitted
        ) {
          session.compilingEmitted = true;
          this.updateSession(session, { phaseLabel: "Compiling" });
        }
      }, 600);
    }

    if (!result.error) return;
    const errorKey = `${result.error.type}:${result.error.message}`;
    if (errorKey === session.lastErrorKey) return;
    session.lastErrorKey = errorKey;

    // Cancel any in-flight readiness poll: a server that still answers HEAD on
    // a half-started port would otherwise resolve to "running" and clobber the
    // error/installing status we are about to set.
    session.readinessAbort?.abort();
    session.readinessAbort = null;
    session.pendingUrl = null;
    session.markerSeen = false;
    this.clearCompiling(session);

    if (result.error.type === "missing-dependencies") {
      session.needsInstall = true;
      this.updateSession(session, {
        status: "installing",
        error: result.error,
        isRestarting: false,
      });
      return;
    }

    this.updateSession(session, {
      status: "error",
      error: result.error,
      url: null,
      assignedUrl: null,
      isRestarting: false,
      phaseLabel: undefined,
    });
  }

  private handleExit(id: string, exitCode: number): void {
    if (this.disposed) return;
    const sessionKey = this.terminalToSession.get(id);
    if (!sessionKey) return;
    const session = this.sessions.get(sessionKey);
    if (!session || session.terminalId !== id) return;

    this.clearStartupReplay(session);
    session.readinessAbort?.abort();
    session.readinessAbort = null;
    session.pendingUrl = null;
    session.markerSeen = false;
    this.clearCompiling(session);

    this.detachTerminal(session);
    session.buffer = "";
    session.lastErrorKey = null;

    if (session.isRunningInstall) {
      session.isRunningInstall = false;
      if (exitCode === 0) {
        void this.spawnSessionTerminal(session);
        return;
      }
      this.updateSession(session, {
        status: "error",
        url: null,
        assignedUrl: null,
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

    if (session.needsInstall && session.installAttemptedGeneration !== session.generation) {
      session.needsInstall = false;
      void this.runInstall(session);
      return;
    }
    session.needsInstall = false;

    if (session.status === "starting" || session.status === "installing") {
      const error: DevServerError = {
        type: "unknown",
        message: `Dev server exited with code ${exitCode}`,
      };
      this.updateSession(session, {
        status: "error",
        url: null,
        assignedUrl: null,
        error,
        terminalId: null,
        isRestarting: false,
        phaseLabel: undefined,
      });
      return;
    }

    this.updateSession(session, {
      status: "stopped",
      url: null,
      assignedUrl: null,
      error: null,
      terminalId: null,
      isRestarting: false,
      phaseLabel: undefined,
    });
  }

  private async runInstall(session: DevPreviewSession): Promise<void> {
    session.installAttemptedGeneration = session.generation;
    session.isRunningInstall = true;

    const installCommand = this.detectInstallCommand(session.cwd);

    const terminalId = this.createTerminalId(session);
    session.buffer = "";
    session.lastErrorKey = null;
    this.attachTerminal(session, terminalId);
    this.updateSession(session, {
      terminalId,
      status: "installing",
      error: {
        type: "missing-dependencies",
        message: `Running ${installCommand}...`,
      },
    });

    try {
      this.ptyClient.spawn(terminalId, {
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
      this.detachTerminal(session);
      this.updateSession(session, {
        status: "error",
        url: null,
        assignedUrl: null,
        error: { type: "unknown", message: `Failed to start dependency install: ${message}` },
        terminalId: null,
        isRestarting: false,
      });
      return;
    }

    setTimeout(() => {
      try {
        if (this.ptyClient.hasTerminal(terminalId)) {
          this.ptyClient.submit(terminalId, installCommand);
        }
      } catch (err) {
        console.warn("[DevPreviewSessionService] Failed to submit install command:", err);
      }
    }, PTY_SUBMIT_AFTER_SPAWN_MS);
  }

  private detectInstallCommand(cwd: string): string {
    const info = this.detectPackageManagerInfo(cwd);
    return `${info.packageManager} install`;
  }

  // Lockfile precedence mirrors detectInstallCommand: bun > pnpm > yarn > npm.
  // package-lock.json is only used to report the lockfile name when no other
  // lockfile is present; it does not change the install command (npm is the
  // default fallback regardless).
  private detectPackageManagerInfo(cwd: string): {
    packageManager: DevPreviewPackageManager;
    lockfileName: string | null;
  } {
    if (existsSync(path.join(cwd, "bun.lock"))) {
      return { packageManager: "bun", lockfileName: "bun.lock" };
    }
    if (existsSync(path.join(cwd, "bun.lockb"))) {
      return { packageManager: "bun", lockfileName: "bun.lockb" };
    }
    if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) {
      return { packageManager: "pnpm", lockfileName: "pnpm-lock.yaml" };
    }
    if (existsSync(path.join(cwd, "yarn.lock"))) {
      return { packageManager: "yarn", lockfileName: "yarn.lock" };
    }
    if (existsSync(path.join(cwd, "package-lock.json"))) {
      return { packageManager: "npm", lockfileName: "package-lock.json" };
    }
    return { packageManager: "npm", lockfileName: null };
  }

  async getDestructivePreviewMeta(
    request: DevPreviewSessionRequest
  ): Promise<DevPreviewDestructivePreviewMeta> {
    validateSessionRequest(request);
    const cwd = this.resolveSessionCwd(request);
    const [cacheDirs, nodeModules] = await Promise.all([
      Promise.all(CACHE_DIRS.map((relPath) => this.statDirMeta(cwd, relPath))),
      this.statDirMeta(cwd, "node_modules"),
    ]);
    const pmInfo = this.detectPackageManagerInfo(cwd);
    return {
      cwd,
      cacheDirs,
      nodeModules,
      packageManager: pmInfo.packageManager,
      lockfileName: pmInfo.lockfileName,
    };
  }

  async getDestructivePreviewSizes(
    request: DevPreviewDestructivePreviewSizesRequest
  ): Promise<DevPreviewDestructivePreviewSizes> {
    validateSessionRequest(request);
    const cwd = this.resolveSessionCwd(request);
    const skipNodeModules = request.skipNodeModules === true;
    const [cacheDirEntries, nodeModulesSizeBytes] = await Promise.all([
      Promise.all(
        CACHE_DIRS.map(async (relPath) => {
          const size = await this.computeDirSize(path.join(cwd, relPath));
          return [relPath, size] as const;
        })
      ),
      skipNodeModules ? Promise.resolve(null) : this.computeDirSize(path.join(cwd, "node_modules")),
    ]);
    return {
      cacheDirSizes: Object.fromEntries(cacheDirEntries),
      nodeModulesSizeBytes,
    };
  }

  private resolveSessionCwd(request: DevPreviewSessionRequest): string {
    const key = createSessionKey(request.projectId, request.panelId);
    const session = this.sessions.get(key);
    if (!session) {
      throw new Error(
        `No dev-preview session for panel ${request.panelId} in project ${request.projectId}`
      );
    }
    return session.cwd;
  }

  private async statDirMeta(cwd: string, relPath: string): Promise<DevPreviewDirMeta> {
    const fullPath = path.join(cwd, relPath);
    try {
      const stat = await fsPromises.stat(fullPath);
      if (!stat.isDirectory()) {
        return { relPath, exists: false, mtimeMs: null };
      }
      return { relPath, exists: true, mtimeMs: stat.mtimeMs };
    } catch {
      return { relPath, exists: false, mtimeMs: null };
    }
  }

  private async computeDirSize(dirPath: string): Promise<number | null> {
    try {
      const stat = await fsPromises.stat(dirPath);
      if (!stat.isDirectory()) return null;
    } catch {
      return null;
    }
    if (process.platform === "win32") {
      return this.computeDirSizeWalk(dirPath);
    }
    return this.computeDirSizeDu(dirPath);
  }

  // POSIX path: shell out to `du -sk` (kilobytes). execFile avoids shell
  // interpretation entirely — dirPath cannot inject. `du` deduplicates
  // hardlinks by inode within the traversal, so pnpm-linked files inside
  // node_modules count once per inode (still reports apparent content size,
  // not the disk that would actually be reclaimed by deletion).
  private async computeDirSizeDu(dirPath: string): Promise<number | null> {
    return new Promise((resolve) => {
      execFile(
        "du",
        ["-sk", dirPath],
        { maxBuffer: 1024 * 1024, timeout: 30_000 },
        (err, stdout) => {
          if (err) return resolve(null);
          const firstField = stdout.trim().split(/\s+/, 1)[0];
          const kilobytes = Number.parseInt(firstField, 10);
          if (!Number.isFinite(kilobytes)) return resolve(null);
          resolve(kilobytes * 1024);
        }
      );
    });
  }

  // Windows fallback: no `du` available. Walks the tree with opendir,
  // accumulating file sizes via lstat. Tracks an inode set to dedupe
  // hardlinks where the FS reports a stable inode (NTFS returns 0/unstable
  // values in some cases — those entries simply count each time, accepting a
  // small over-report on edge filesystems).
  private async computeDirSizeWalk(dirPath: string): Promise<number | null> {
    try {
      let total = 0;
      const seenInos = new Set<string>();
      const stack: string[] = [dirPath];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        let handle: Awaited<ReturnType<typeof fsPromises.opendir>>;
        try {
          handle = await fsPromises.opendir(cur);
        } catch {
          continue;
        }
        for await (const ent of handle) {
          const full = path.join(cur, ent.name);
          if (ent.isDirectory()) {
            stack.push(full);
          } else if (ent.isFile() || ent.isSymbolicLink()) {
            try {
              const st = await fsPromises.lstat(full);
              const inoKey = st.ino ? `${st.dev}:${st.ino}` : null;
              if (inoKey && seenInos.has(inoKey)) continue;
              if (inoKey) seenInos.add(inoKey);
              total += st.size;
            } catch {
              // skip unreadable
            }
          }
        }
      }
      return total;
    } catch {
      return null;
    }
  }

  private pollServerReadiness(
    session: DevPreviewSession,
    url: string,
    signal: AbortSignal,
    generation: number
  ): void {
    void waitForServerReady(url, signal)
      .then((ready) => {
        if (signal.aborted || session.generation !== generation) return;
        if (session.readinessAbort?.signal !== signal) return;

        session.pendingUrl = null;
        session.readinessAbort = null;

        if (ready) {
          session.needsInstall = false;
          this.clearCompiling(session);
          this.updateSession(session, {
            status: "running",
            url,
            error: null,
            isRestarting: false,
            phaseLabel: undefined,
          });
          markPerformance(PERF_MARKS.DEVPREVIEW_RUNNING, {
            panelId: session.panelId,
            projectId: session.projectId,
            terminalId: session.terminalId,
            url,
          });
        } else {
          this.updateSession(session, {
            status: "error",
            url: null,
            assignedUrl: null,
            error: {
              type: "unknown",
              message: `Dev server at ${url} did not respond within ${READINESS_TIMEOUT_MS / 1000} seconds`,
            },
            isRestarting: false,
            phaseLabel: undefined,
          });
        }
      })
      .catch((err) => {
        if (signal.aborted || session.generation !== generation) return;
        if (session.readinessAbort?.signal !== signal) return;

        session.pendingUrl = null;
        session.readinessAbort = null;

        const message = formatErrorMessage(err, "Dev server readiness check failed");
        console.warn("[DevPreviewSessionService] Readiness poll error:", {
          url,
          panelId: session.panelId,
          error: message,
        });
        this.updateSession(session, {
          status: "error",
          url: null,
          assignedUrl: null,
          error: {
            type: "unknown",
            message: `Dev server readiness check failed: ${message}`,
          },
          isRestarting: false,
          phaseLabel: undefined,
        });
      });
  }
}
