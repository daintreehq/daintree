import { existsSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import type { PtyClient } from "./PtyClient.js";
import { UrlDetector } from "./UrlDetector.js";
import type {
  DevPreviewEnsureRequest,
  DevPreviewSessionRequest,
  DevPreviewStopByPanelRequest,
  DevPreviewSessionState,
  DevPreviewSessionStatus,
} from "../../shared/types/ipc/devPreview.js";
import type { DevServerError } from "../../shared/utils/devServerErrors.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import { markPerformance } from "../utils/performance.js";

interface DevPreviewSession extends DevPreviewSessionState {
  cwd: string;
  devCommand: string;
  env?: Record<string, string>;
  buffer: string;
  lastErrorKey: string | null;
  pendingUrl: string | null;
  readinessAbort: AbortController | null;
  needsInstall: boolean;
  isRunningInstall: boolean;
  installAttemptedGeneration: number | null;
}

const RUNNING_STATES: ReadonlySet<DevPreviewSessionStatus> = new Set([
  "starting",
  "installing",
  "running",
]);

const DEFAULT_TIMEOUT_MS = 8000;
const STALE_START_RECOVERY_MS = 10000;
const REPLAY_HISTORY_MAX_LINES = 300;
const READINESS_TIMEOUT_MS = 30000;
const READINESS_POLL_INTERVAL_MS = 500;
const READINESS_REQUEST_TIMEOUT_MS = 5000;

function createSessionKey(projectId: string, panelId: string): string {
  return `${projectId}\u0000${panelId}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeToken(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 24) || "x";
}

function cloneEnv(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env) return undefined;
  return { ...env };
}

function envEquals(left?: Record<string, string>, right?: Record<string, string>): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function getInvalidCommandMessage(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return "No dev command configured";
  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    return "Multi-line commands are not allowed";
  }
  return null;
}

export class DevPreviewSessionService {
  private readonly detector = new UrlDetector();
  private readonly textDecoder = new TextDecoder();
  private readonly sessions = new Map<string, DevPreviewSession>();
  private readonly terminalToSession = new Map<string, string>();
  private readonly locks = new Map<string, Promise<void>>();
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

  dispose(): void {
    this.ptyClient.off("data", this.onDataListener);
    this.ptyClient.off("exit", this.onExitListener);
    for (const session of this.sessions.values()) {
      session.readinessAbort?.abort();
    }
    for (const terminalId of this.terminalToSession.keys()) {
      this.ptyClient.setIpcDataMirror(terminalId, false);
      try {
        this.ptyClient.kill(terminalId, "dev-preview:dispose");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!this.isBenignMissingTerminalError(message)) {
          console.warn("[DevPreviewSessionService] Failed to kill terminal during dispose:", err);
        }
      }
    }
    this.terminalToSession.clear();
    this.sessions.clear();
    this.locks.clear();
  }

  async ensure(request: DevPreviewEnsureRequest): Promise<DevPreviewSessionState> {
    this.validateEnsureRequest(request);
    markPerformance(PERF_MARKS.DEVPREVIEW_ENSURE_START, {
      panelId: request.panelId,
      projectId: request.projectId,
      worktreeId: request.worktreeId ?? null,
    });
    const key = createSessionKey(request.projectId, request.panelId);
    await this.runLocked(key, async () => {
      const session = this.getOrCreateSession(request.projectId, request.panelId);
      const envChanged = !envEquals(session.env, request.env);
      const configChanged =
        session.cwd !== request.cwd ||
        session.worktreeId !== request.worktreeId ||
        session.devCommand !== request.devCommand ||
        envChanged;

      session.cwd = request.cwd;
      session.worktreeId = request.worktreeId;
      session.devCommand = request.devCommand;
      if (envChanged) {
        session.env = cloneEnv(request.env);
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
          terminalId: null,
          isRestarting: false,
        });
        return;
      }

      if (configChanged && session.terminalId) {
        await this.stopSessionTerminal(session, "config-change");
      }

      await this.ensureSessionTerminal(session);
    });
    return this.getSessionState(request.projectId, request.panelId);
  }

  async restart(request: DevPreviewSessionRequest): Promise<DevPreviewSessionState> {
    this.validateSessionRequest(request);
    const restartStartedAt = Date.now();
    markPerformance(PERF_MARKS.DEVPREVIEW_RESTART_START, {
      panelId: request.panelId,
      projectId: request.projectId,
    });
    const key = createSessionKey(request.projectId, request.panelId);
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

        await this.stopSessionTerminal(session, "restart");
        await this.spawnSessionTerminal(session);
      });
    } finally {
      markPerformance(PERF_MARKS.DEVPREVIEW_RESTART_END, {
        panelId: request.panelId,
        projectId: request.projectId,
        durationMs: Date.now() - restartStartedAt,
      });
    }
    return this.getSessionState(request.projectId, request.panelId);
  }

  async stop(request: DevPreviewSessionRequest): Promise<DevPreviewSessionState> {
    this.validateSessionRequest(request);
    const key = createSessionKey(request.projectId, request.panelId);
    await this.runLocked(key, async () => {
      const session = this.sessions.get(key);
      if (!session) return;

      await this.stopSessionTerminal(session, "stop");
      this.updateSession(session, {
        status: "stopped",
        url: null,
        error: null,
        terminalId: null,
        isRestarting: false,
      });
    });
    return this.getSessionState(request.projectId, request.panelId);
  }

  async stopByPanel(request: DevPreviewStopByPanelRequest): Promise<void> {
    this.validateStopByPanelRequest(request);
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
              error: null,
              terminalId: null,
              isRestarting: false,
            });
            this.sessions.delete(key);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.updateSession(session, {
              status: "error",
              url: null,
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

  getState(request: DevPreviewSessionRequest): DevPreviewSessionState {
    this.validateSessionRequest(request);
    return this.getSessionState(request.projectId, request.panelId);
  }

  private validateEnsureRequest(request: DevPreviewEnsureRequest): void {
    if (!request || typeof request !== "object") {
      throw new Error("Invalid dev preview request");
    }
    if (typeof request.panelId !== "string" || !request.panelId.trim()) {
      throw new Error("panelId is required");
    }
    if (typeof request.projectId !== "string" || !request.projectId.trim()) {
      throw new Error("projectId is required");
    }
    if (typeof request.cwd !== "string" || !request.cwd.trim()) {
      throw new Error("cwd is required");
    }
    if (typeof request.devCommand !== "string") {
      throw new Error("devCommand must be a string");
    }
    if (request.worktreeId !== undefined && typeof request.worktreeId !== "string") {
      throw new Error("worktreeId must be a string if provided");
    }
    if (request.env !== undefined) {
      if (!isPlainRecord(request.env)) {
        throw new Error("env must be a plain object if provided");
      }

      for (const [key, value] of Object.entries(request.env)) {
        const isReserved = key === "__proto__" || key === "constructor" || key === "prototype";
        const isValidEnvKey = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
        if (!key || isReserved || !isValidEnvKey) {
          throw new Error("env contains invalid key");
        }
        if (typeof value !== "string") {
          throw new Error("env values must be strings");
        }
      }
    }
  }

  private validateSessionRequest(request: DevPreviewSessionRequest): void {
    if (!request || typeof request !== "object") {
      throw new Error("Invalid dev preview session request");
    }
    if (typeof request.panelId !== "string" || !request.panelId.trim()) {
      throw new Error("panelId is required");
    }
    if (typeof request.projectId !== "string" || !request.projectId.trim()) {
      throw new Error("projectId is required");
    }
  }

  private validateStopByPanelRequest(request: DevPreviewStopByPanelRequest): void {
    if (!request || typeof request !== "object") {
      throw new Error("Invalid dev preview stop-by-panel request");
    }
    if (typeof request.panelId !== "string" || !request.panelId.trim()) {
      throw new Error("panelId is required");
    }
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
      error: null,
      terminalId: null,
      isRestarting: false,
      generation: 0,
      updatedAt: Date.now(),
      cwd: "",
      devCommand: "",
      env: undefined,
      buffer: "",
      lastErrorKey: null,
      pendingUrl: null,
      readinessAbort: null,
      needsInstall: false,
      isRunningInstall: false,
      installAttemptedGeneration: null,
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
        error: null,
        terminalId: null,
        isRestarting: false,
        generation: 0,
        updatedAt: Date.now(),
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
      error: session.error,
      terminalId: session.terminalId,
      isRestarting: session.isRestarting,
      generation: session.generation,
      updatedAt: session.updatedAt,
    };
  }

  private updateSession(
    session: DevPreviewSession,
    updates: Partial<
      Pick<
        DevPreviewSession,
        "status" | "url" | "error" | "terminalId" | "isRestarting" | "worktreeId" | "generation"
      >
    >
  ): void {
    if (updates.status !== undefined) session.status = updates.status;
    if (updates.url !== undefined) session.url = updates.url;
    if (updates.error !== undefined) session.error = updates.error;
    if (updates.terminalId !== undefined) session.terminalId = updates.terminalId;
    if (updates.isRestarting !== undefined) session.isRestarting = updates.isRestarting;
    if (updates.worktreeId !== undefined) session.worktreeId = updates.worktreeId;
    if (updates.generation !== undefined) session.generation = updates.generation;
    session.updatedAt = Date.now();
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
          this.updateSession(session, { status: "starting", error: null, url: null });
        }

        if ((session.status === "starting" || session.status === "installing") && !session.url) {
          await this.replayRecentOutput(terminalId);
        }

        if (
          session.status === "starting" &&
          !session.url &&
          !session.pendingUrl &&
          Date.now() - session.updatedAt >= STALE_START_RECOVERY_MS
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
      session.needsInstall = false;
      session.isRunningInstall = false;
      this.updateSession(session, { terminalId: null, url: null });
    }

    await this.spawnSessionTerminal(session);
  }

  private async replayRecentOutput(terminalId: string): Promise<void> {
    try {
      await this.ptyClient.replayHistoryAsync(terminalId, REPLAY_HISTORY_MAX_LINES);
    } catch {
      // Best-effort only - missing replay support should not block ensure.
    }
  }

  private async spawnSessionTerminal(session: DevPreviewSession): Promise<void> {
    const terminalId = this.createTerminalId(session);
    const nextGeneration = session.generation + 1;

    session.buffer = "";
    session.lastErrorKey = null;
    this.attachTerminal(session, terminalId);
    this.updateSession(session, {
      terminalId,
      status: "starting",
      url: null,
      error: null,
      generation: nextGeneration,
    });

    try {
      this.ptyClient.spawn(terminalId, {
        projectId: session.projectId,
        kind: "dev-preview",
        cwd: session.cwd,
        worktreeId: session.worktreeId,
        cols: 80,
        rows: 30,
        restore: false,
        env: session.env,
        isEphemeral: true,
      });
      markPerformance(PERF_MARKS.DEVPREVIEW_TERMINAL_SPAWNED, {
        panelId: session.panelId,
        projectId: session.projectId,
        terminalId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.detachTerminal(session);
      this.updateSession(session, {
        status: "error",
        url: null,
        error: { type: "unknown", message: `Failed to start dev server: ${message}` },
        terminalId: null,
        isRestarting: false,
      });
      return;
    }

    const trimmedCommand = session.devCommand.trim();

    setTimeout(() => {
      try {
        if (this.ptyClient.hasTerminal(terminalId)) {
          this.ptyClient.submit(terminalId, trimmedCommand);
        }
      } catch (err) {
        console.warn("[DevPreviewSessionService] Failed to submit dev command:", err);
      }
    }, 100);
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

  private async stopSessionTerminal(session: DevPreviewSession, context: string): Promise<void> {
    session.readinessAbort?.abort();
    session.readinessAbort = null;
    session.pendingUrl = null;
    session.needsInstall = false;
    session.isRunningInstall = false;

    const terminalId = session.terminalId;
    if (!terminalId) return;

    this.detachTerminal(session);
    session.buffer = "";
    session.lastErrorKey = null;

    try {
      this.ptyClient.kill(terminalId, `dev-preview:${context}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!this.isBenignMissingTerminalError(message)) {
        throw new Error(`Failed to kill terminal (${context}): ${message}`);
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

  private async waitForTerminalGone(
    terminalId: string,
    projectId: string,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
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

  private handleData(id: string, data: string | Uint8Array): void {
    const sessionKey = this.terminalToSession.get(id);
    if (!sessionKey) return;
    const session = this.sessions.get(sessionKey);
    if (!session || session.terminalId !== id) return;

    if (session.isRunningInstall) return;

    const dataString = typeof data === "string" ? data : this.textDecoder.decode(data);
    const result = this.detector.scanOutput(dataString, session.buffer);
    session.buffer = result.buffer;

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

      this.pollServerReadiness(session, result.url, abort.signal, session.generation);
    }

    if (!result.error) return;
    const errorKey = `${result.error.type}:${result.error.message}`;
    if (errorKey === session.lastErrorKey) return;
    session.lastErrorKey = errorKey;

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
      isRestarting: false,
    });
  }

  private handleExit(id: string, exitCode: number): void {
    const sessionKey = this.terminalToSession.get(id);
    if (!sessionKey) return;
    const session = this.sessions.get(sessionKey);
    if (!session || session.terminalId !== id) return;

    session.readinessAbort?.abort();
    session.readinessAbort = null;
    session.pendingUrl = null;

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
        error: {
          type: "missing-dependencies",
          message: `Dependency installation failed (exit code ${exitCode})`,
        },
        terminalId: null,
        isRestarting: false,
      });
      return;
    }

    if (
      session.needsInstall &&
      session.installAttemptedGeneration !== session.generation
    ) {
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
        error,
        terminalId: null,
        isRestarting: false,
      });
      return;
    }

    this.updateSession(session, {
      status: "stopped",
      url: null,
      error: null,
      terminalId: null,
      isRestarting: false,
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
        worktreeId: session.worktreeId,
        cols: 80,
        rows: 30,
        restore: false,
        env: session.env,
        isEphemeral: true,
      });
    } catch (error) {
      session.isRunningInstall = false;
      const message = error instanceof Error ? error.message : String(error);
      this.detachTerminal(session);
      this.updateSession(session, {
        status: "error",
        url: null,
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
    }, 100);
  }

  private detectInstallCommand(cwd: string): string {
    if (existsSync(path.join(cwd, "bun.lockb"))) return "bun install";
    if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm install";
    if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn install";
    return "npm install";
  }

  private pollServerReadiness(
    session: DevPreviewSession,
    url: string,
    signal: AbortSignal,
    generation: number
  ): void {
    void this.waitForServerReady(url, signal)
      .then((ready) => {
        if (signal.aborted || session.generation !== generation) return;
        if (session.readinessAbort?.signal !== signal) return;

        session.pendingUrl = null;
        session.readinessAbort = null;

        if (ready) {
          session.needsInstall = false;
          this.updateSession(session, {
            status: "running",
            url,
            error: null,
            isRestarting: false,
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
            error: {
              type: "unknown",
              message: `Dev server at ${url} did not respond within ${READINESS_TIMEOUT_MS / 1000} seconds`,
            },
            isRestarting: false,
          });
        }
      })
      .catch((err) => {
        if (signal.aborted || session.generation !== generation) return;
        if (session.readinessAbort?.signal !== signal) return;

        session.pendingUrl = null;
        session.readinessAbort = null;

        const message = err instanceof Error ? err.message : String(err);
        console.warn("[DevPreviewSessionService] Readiness poll error:", {
          url,
          panelId: session.panelId,
          error: message,
        });
        this.updateSession(session, {
          status: "error",
          url: null,
          error: {
            type: "unknown",
            message: `Dev server readiness check failed: ${message}`,
          },
          isRestarting: false,
        });
      });
  }

  private async waitForServerReady(
    url: string,
    signal: AbortSignal,
    timeoutMs = READINESS_TIMEOUT_MS
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let useHttps: boolean;
    try {
      useHttps = new URL(url).protocol === "https:";
    } catch {
      return false;
    }
    const requestModule = useHttps ? https : http;

    while (Date.now() < deadline) {
      if (signal.aborted) return false;

      const ready = await new Promise<boolean>((resolve) => {
        let settled = false;
        const onAbort = () => {
          req?.destroy();
          settle(false);
        };
        const settle = (value: boolean) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        };

        let req: ReturnType<typeof requestModule.request> | undefined;
        try {
          req = requestModule.request(
            url,
            {
              method: "HEAD",
              timeout: READINESS_REQUEST_TIMEOUT_MS,
              ...(useHttps ? { rejectUnauthorized: false } : {}),
            },
            (res) => {
              res.resume();
              const status = res.statusCode ?? 0;
              // Any HTTP response means the server is listening and can process requests.
              // We only keep polling on transport-level failures (connection refused, timeout, etc.).
              if (status >= 100 && status < 600) {
                settle(true);
              } else {
                settle(false);
              }
            }
          );
          req.on("error", () => settle(false));
          req.on("timeout", () => {
            req!.destroy();
            settle(false);
          });
          if (signal.aborted) {
            req.destroy();
            settle(false);
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
            req.end();
          }
        } catch {
          settle(false);
        }
      });

      if (ready) return true;
      if (signal.aborted) return false;

      try {
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, READINESS_POLL_INTERVAL_MS);
          signal.addEventListener("abort", onAbort, { once: true });
        });
      } catch {
        return false;
      }
    }

    return false;
  }
}
