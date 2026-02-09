import { EventEmitter } from "events";
import path from "path";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { randomBytes } from "crypto";
import type { PtyClient } from "./PtyClient.js";
import { extractLocalhostUrls } from "../../shared/utils/urlUtils.js";
import type { DevPreviewAttachSnapshot } from "../../shared/types/ipc/devPreview.js";
import {
  detectDevServerError,
  isRecoverableError,
  type DevServerError,
} from "../../shared/utils/devServerErrors.js";

export type DevPreviewStatus = "installing" | "starting" | "running" | "error" | "stopped";

export interface DevPreviewSession {
  sessionId: string;
  panelId: string;
  ptyId: string;
  projectRoot: string;
  status: DevPreviewStatus;
  statusMessage: string;
  url: string | null;
  packageManager: string | null;
  devCommand: string | null;
  installCommand: string | null;
  error?: string;
  timestamp: number;
  unsubscribers: (() => void)[];
  generation: number;
  submitTimeout?: NodeJS.Timeout;
  outputBuffer: string;
  recoveryInProgress: boolean;
  recoveryAttempts: number;
  worktreeId?: string;
}

export interface DevPreviewAttachOptions {
  panelId: string;
  ptyId: string;
  cwd: string;
  devCommand?: string;
}

export class DevPreviewService extends EventEmitter {
  private sessions = new Map<string, DevPreviewSession>();
  private generationCounter = 0;
  private lastSubmitByPty = new Map<string, { command: string; timestamp: number }>();
  private pendingAttaches = new Map<string, { sessionId: string; aborted: boolean }>();
  private static readonly SUBMIT_DEDUP_WINDOW_MS = 2000;

  constructor(private ptyClient: PtyClient) {
    super();
  }

  private generateSessionId(): string {
    return randomBytes(8).toString("hex");
  }

  private shouldDedupSubmit(ptyId: string, command: string): boolean {
    const last = this.lastSubmitByPty.get(ptyId);
    if (!last) return false;
    if (last.command !== command) return false;
    return Date.now() - last.timestamp < DevPreviewService.SUBMIT_DEDUP_WINDOW_MS;
  }

  private markSubmit(ptyId: string, command: string): void {
    this.lastSubmitByPty.set(ptyId, { command, timestamp: Date.now() });
  }

  /**
   * Attach to an existing PTY (spawned by the standard terminal pipeline).
   * Subscribes to data/exit events and auto-detects dev command + submits it.
   * Does NOT spawn or kill PTY processes.
   */
  async attach(options: DevPreviewAttachOptions): Promise<DevPreviewAttachSnapshot> {
    const { panelId, ptyId, cwd, devCommand: providedCommand } = options;
    const sessionId = this.generateSessionId();
    const buildSnapshot = (session: DevPreviewSession): DevPreviewAttachSnapshot => ({
      sessionId: session.sessionId,
      status: session.status,
      message: session.statusMessage,
      url: session.url,
      ptyId: session.ptyId,
      timestamp: session.timestamp,
      error: session.error,
      worktreeId: session.worktreeId,
    });
    const buildCancelledSnapshot = (): DevPreviewAttachSnapshot => {
      const current = this.sessions.get(panelId);
      if (current) return buildSnapshot(current);
      return {
        sessionId,
        status: "stopped",
        message: "Attach cancelled",
        url: null,
        ptyId,
        timestamp: Date.now(),
      };
    };

    const normalizedCommand = providedCommand?.trim() || undefined;
    const existingSession = this.sessions.get(panelId);

    if (existingSession) {
      const ptyMatches = existingSession.ptyId === ptyId;
      const cwdMatches = existingSession.projectRoot === cwd;
      const commandMatches =
        normalizedCommand === undefined || existingSession.devCommand === normalizedCommand;

      if (ptyMatches && cwdMatches && commandMatches) {
        existingSession.timestamp = Date.now();
        // Re-enable IPC mirroring in case PTY host restarted
        this.ptyClient.setIpcDataMirror(ptyId, true);
        this.emitStatus(
          panelId,
          existingSession.status,
          existingSession.statusMessage,
          existingSession.url
        );
        if (existingSession.url) {
          this.emit("url", {
            panelId,
            sessionId: existingSession.sessionId,
            url: existingSession.url,
            worktreeId: existingSession.worktreeId,
          });
        }
        return buildSnapshot(existingSession);
      }

      this.detach(panelId);
    }

    // Abort any previous in-flight attach for this panel and register ours
    const prevPending = this.pendingAttaches.get(panelId);
    if (prevPending) prevPending.aborted = true;
    this.pendingAttaches.set(panelId, { sessionId, aborted: false });
    const isStillCurrent = () => {
      const p = this.pendingAttaches.get(panelId);
      return !!p && p.sessionId === sessionId && !p.aborted;
    };

    try {
      // Fallback chain: provided command → auto-detect → browser-only mode
      let finalCommand = normalizedCommand;
      let packageManager: string | null = null;
      let installCommand: string | null = null;
      let needsInstall = false;

      if (!finalCommand) {
        packageManager = await this.detectPackageManager(cwd);
        if (!isStillCurrent()) return buildCancelledSnapshot();
        if (packageManager) {
          finalCommand = (await this.detectDevCommand(cwd, packageManager)) ?? undefined;
          if (!isStillCurrent()) return buildCancelledSnapshot();
        }
      }

      if (finalCommand) {
        packageManager = packageManager ?? (await this.detectPackageManager(cwd));
        if (!isStillCurrent()) return buildCancelledSnapshot();
        if (packageManager) {
          needsInstall = await this.needsDependencyInstall(cwd);
          if (!isStillCurrent()) return buildCancelledSnapshot();
          installCommand = needsInstall ? this.getInstallCommand(packageManager) : null;
        }
      }

      // Browser-only mode: no command available
      if (!finalCommand) {
        if (!isStillCurrent()) return buildCancelledSnapshot();
        if (process.env.CANOPY_VERBOSE) {
          console.log(
            `[DevPreview] Panel ${panelId} entering browser-only mode (no dev command found, cwd: ${cwd})`
          );
        }
        const session: DevPreviewSession = {
          sessionId,
          panelId,
          ptyId,
          projectRoot: cwd,
          status: "running",
          statusMessage: "Browser-only mode (no dev command)",
          url: null,
          packageManager: null,
          devCommand: null,
          installCommand: null,
          timestamp: Date.now(),
          unsubscribers: [],
          generation: ++this.generationCounter,
          outputBuffer: "",
          recoveryInProgress: false,
          recoveryAttempts: 0,
        };
        this.sessions.set(panelId, session);
        this.emitStatus(panelId, "running", "Browser-only mode (no dev command)", null);
        return buildSnapshot(session);
      }

      if (!isStillCurrent()) return buildCancelledSnapshot();

      let fullCommand: string;
      if (installCommand) {
        fullCommand = `${installCommand} && ${finalCommand}`;
      } else {
        fullCommand = finalCommand;
      }

      const generation = ++this.generationCounter;

      // Create session before first status emit so sessionId is available
      const session: DevPreviewSession = {
        sessionId,
        panelId,
        ptyId,
        projectRoot: cwd,
        status: needsInstall ? "installing" : "starting",
        statusMessage: needsInstall ? "Installing dependencies..." : "Starting dev server...",
        url: null,
        packageManager,
        devCommand: finalCommand,
        installCommand,
        timestamp: Date.now(),
        unsubscribers: [],
        generation,
        outputBuffer: "",
        recoveryInProgress: false,
        recoveryAttempts: 0,
      };
      this.sessions.set(panelId, session);

      // Emit initial status after session is stored so sessionId is populated
      this.emitStatus(panelId, session.status, session.statusMessage, null);

      if (process.env.CANOPY_VERBOSE) {
        console.log(`[DevPreview] Attaching to panel ${panelId} with ptyId: ${ptyId}, cwd: ${cwd}`);
      }

      // Check if PTY exists before attaching to avoid stuck sessions
      if (!this.ptyClient.hasTerminal(ptyId)) {
        if (process.env.CANOPY_VERBOSE) {
          console.log(`[DevPreview] PTY ${ptyId} does not exist, creating stopped session`);
        }
        session.status = "stopped";
        session.statusMessage = "Terminal not found";
        session.generation = ++this.generationCounter;
        this.emitStatus(panelId, "stopped", "Terminal not found", null);
        return buildSnapshot(session);
      }

      // Subscribe to the existing PTY's data and exit events
      // Capture generation to prevent stale listeners from corrupting new sessions
      const dataListener = (id: string, data: string) => {
        const currentSession = this.sessions.get(panelId);
        if (id === ptyId && currentSession && currentSession.generation === generation) {
          this.handlePtyData(panelId, data);
        }
      };

      const exitListener = (id: string, exitCode: number) => {
        const currentSession = this.sessions.get(panelId);
        if (id === ptyId && currentSession && currentSession.generation === generation) {
          this.handlePtyExit(panelId, exitCode);
        }
      };

      this.ptyClient.on("data", dataListener);
      this.ptyClient.on("exit", exitListener);

      // Enable IPC data mirroring so PTY data events reach this service
      // even when SharedArrayBuffer is active (primary data path bypasses IPC)
      this.ptyClient.setIpcDataMirror(ptyId, true);

      session.unsubscribers = [
        () => this.ptyClient.removeListener("data", dataListener),
        () => this.ptyClient.removeListener("exit", exitListener),
        () => this.ptyClient.setIpcDataMirror(ptyId, false),
      ];

      // Delay command submission to allow PTY shell to initialize
      const shouldSkipSubmit = this.shouldDedupSubmit(ptyId, fullCommand);

      if (shouldSkipSubmit) {
        if (process.env.CANOPY_VERBOSE) {
          console.log(
            `[DevPreview] Skipping duplicate dev command submit for ${ptyId}: ${fullCommand}`
          );
        }
      } else {
        // Mark early to prevent duplicate submits during rapid attach/detach cycles.
        this.markSubmit(ptyId, fullCommand);
        session.submitTimeout = setTimeout(() => {
          const currentSession = this.sessions.get(panelId);
          if (
            currentSession &&
            currentSession.generation === generation &&
            this.ptyClient.hasTerminal(ptyId)
          ) {
            this.markSubmit(ptyId, fullCommand);
            this.ptyClient.submit(ptyId, fullCommand);
          }
        }, 100);
      }

      return buildSnapshot(session);
    } finally {
      const p = this.pendingAttaches.get(panelId);
      if (p?.sessionId === sessionId) {
        this.pendingAttaches.delete(panelId);
      }
    }
  }

  /**
   * Detach from a PTY without killing it.
   * Removes listeners and cleans up session state.
   * The PTY lifecycle is managed by the standard terminal pipeline.
   */
  detach(panelId: string): void {
    // Abort any in-flight attach for this panel
    const pending = this.pendingAttaches.get(panelId);
    if (pending) pending.aborted = true;

    const session = this.sessions.get(panelId);
    if (!session) return;

    if (session.submitTimeout) {
      clearTimeout(session.submitTimeout);
      session.submitTimeout = undefined;
    }

    for (const unsubscribe of session.unsubscribers) {
      unsubscribe();
    }
    session.unsubscribers = [];

    this.lastSubmitByPty.delete(session.ptyId);
    this.sessions.delete(panelId);
  }

  setUrl(panelId: string, url: string): void {
    const session = this.sessions.get(panelId);
    if (!session) return;

    session.url = url;
    session.status = "running";
    session.statusMessage = "Running";
    session.timestamp = Date.now();

    this.emit("url", {
      panelId,
      sessionId: session.sessionId,
      url,
      worktreeId: session.worktreeId,
    });
    this.emitStatus(panelId, "running", "Running", url);
  }

  getSession(panelId: string): DevPreviewSession | undefined {
    return this.sessions.get(panelId);
  }

  pruneInactiveSessions(activePanelIds: Set<string>): number {
    for (const [panelId, pending] of this.pendingAttaches) {
      if (!activePanelIds.has(panelId)) {
        pending.aborted = true;
        this.pendingAttaches.delete(panelId);
      }
    }
    const toRemove: string[] = [];
    this.sessions.forEach((_, panelId) => {
      if (!activePanelIds.has(panelId)) {
        toRemove.push(panelId);
      }
    });
    for (const panelId of toRemove) {
      this.detach(panelId);
    }
    return toRemove.length;
  }

  private handlePtyData(panelId: string, data: string): void {
    const session = this.sessions.get(panelId);
    if (!session) return;

    session.outputBuffer = (session.outputBuffer + data).slice(-4096);

    // Try URL extraction on the current chunk first (fast path)
    let urls = extractLocalhostUrls(data);
    // Fallback: check the output buffer for URLs split across chunks or port changes
    if (urls.length === 0) {
      const bufferUrls = extractLocalhostUrls(session.outputBuffer);
      // Prefer the latest URL from the buffer (last match) to catch port changes
      if (bufferUrls.length > 0) {
        urls = [bufferUrls[bufferUrls.length - 1]];
      }
    }
    if (urls.length > 0) {
      const preferredUrl = this.selectPreferredUrl(urls);
      if (preferredUrl && preferredUrl !== session.url) {
        if (process.env.CANOPY_VERBOSE) {
          console.log(
            `[DevPreview] Panel ${panelId} (ptyId: ${session.ptyId}, gen: ${session.generation}) detected URLs:`,
            urls,
            `- setting URL to: ${preferredUrl} (cwd: ${session.projectRoot})`
          );
        }
        this.setUrl(panelId, preferredUrl);
      }
    }

    if (session.status === "installing") {
      const installCompletePatterns = [
        "added",
        "packages in",
        "dependencies installed",
        "Done in",
        "packages installed",
        "+ ",
      ];

      if (installCompletePatterns.some((pattern) => data.includes(pattern))) {
        session.status = "starting";
        this.emitStatus(panelId, "starting", "Starting dev server...", null);
      }
    }

    if (session.status === "starting" && !session.recoveryInProgress) {
      const error = detectDevServerError(session.outputBuffer);
      if (error) {
        this.handleDetectedError(panelId, error);
      }
    }
  }

  private handleDetectedError(panelId: string, error: DevServerError): void {
    const session = this.sessions.get(panelId);
    if (!session) return;

    const MAX_RECOVERY_ATTEMPTS = 2;

    if (
      isRecoverableError(error) &&
      session.packageManager &&
      session.devCommand &&
      session.recoveryAttempts < MAX_RECOVERY_ATTEMPTS
    ) {
      session.recoveryInProgress = true;
      session.recoveryAttempts += 1;
      this.attemptDependencyRecovery(panelId);
    } else {
      this.emitStatus(panelId, "error", error.message, null);
    }
  }

  /**
   * Attempt auto-recovery by killing the current PTY process and requesting
   * a restart from the renderer via the "recovery" event. The renderer will
   * use the standard terminal restart flow.
   */
  private async attemptDependencyRecovery(panelId: string): Promise<void> {
    const session = this.sessions.get(panelId);
    if (!session || !session.packageManager || !session.devCommand) return;

    const { packageManager, devCommand, ptyId } = session;
    const installCmd = this.getInstallCommand(packageManager);
    const fullCommand = `${installCmd} && ${devCommand}`;

    if (process.env.CANOPY_VERBOSE) {
      console.log(
        `[DevPreview] Panel ${panelId} recovery: requesting restart (attempt ${session.recoveryAttempts}/${2})`
      );
    }

    // Emit status before cleaning up session
    this.emitStatus(panelId, "installing", "Installing missing dependencies...", null);

    // Clean up current listeners
    for (const unsubscribe of session.unsubscribers) {
      unsubscribe();
    }
    session.unsubscribers = [];

    // Kill the failing process - the standard terminal pipeline owns the PTY,
    // but we need to kill this specific process for recovery.
    // Wait for kill to complete before restarting to avoid port conflicts.
    if (ptyId) {
      await this.ptyClient.kill(ptyId);
    }

    this.emitStatus(panelId, "installing", "Installing missing dependencies...", null);

    // Delete the session so the next attach() doesn't short-circuit
    this.sessions.delete(panelId);

    // Emit recovery event so the renderer can restart via terminal store
    this.emit("recovery", {
      panelId,
      command: fullCommand,
      attempt: session.recoveryAttempts,
    });
  }

  private handlePtyExit(panelId: string, code: number): void {
    const session = this.sessions.get(panelId);
    if (!session) return;

    if (process.env.CANOPY_VERBOSE) {
      console.log(
        `[DevPreview] Panel ${panelId} (ptyId: ${session.ptyId}) exited with code ${code}`
      );
    }

    if (session.submitTimeout) {
      clearTimeout(session.submitTimeout);
      session.submitTimeout = undefined;
    }

    for (const unsubscribe of session.unsubscribers) {
      unsubscribe();
    }
    session.unsubscribers = [];

    if (code !== 0) {
      const errorMessage =
        session.status === "error" && session.error
          ? session.error
          : `Process exited with code ${code}`;
      this.emitStatus(panelId, "error", errorMessage, null);
    } else {
      this.emitStatus(panelId, "stopped", "Dev server stopped", null);
    }

    this.lastSubmitByPty.delete(session.ptyId);
    this.sessions.delete(panelId);
  }

  private selectPreferredUrl(urls: string[]): string | null {
    if (urls.length === 0) return null;
    if (urls.length === 1) return urls[0];

    const localPattern = /localhost/i;
    const localUrls = urls.filter((url) => localPattern.test(url));
    return localUrls.length > 0 ? localUrls[0] : urls[0];
  }

  private emitStatus(
    panelId: string,
    status: DevPreviewStatus,
    message: string,
    url: string | null
  ): void {
    const session = this.sessions.get(panelId);
    if (session) {
      session.status = status;
      session.statusMessage = message;
      session.url = url;
      session.timestamp = Date.now();
      if (status === "error") {
        session.error = message;
      }
    }

    this.emit("status", {
      panelId,
      sessionId: session?.sessionId ?? "",
      status,
      message,
      timestamp: Date.now(),
      error: status === "error" ? message : undefined,
      ptyId: session?.ptyId ?? "",
      worktreeId: session?.worktreeId,
    });
  }

  async detectPackageManager(cwd: string): Promise<string | null> {
    const pkgPath = path.join(cwd, "package.json");
    if (!existsSync(pkgPath)) return null;

    if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
    if (existsSync(path.join(cwd, "bun.lockb"))) return "bun";
    return "npm";
  }

  async detectDevCommand(cwd: string, packageManager: string): Promise<string | null> {
    const pkgPath = path.join(cwd, "package.json");
    try {
      const content = await readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(content);

      if (pkg.scripts?.dev) {
        return this.formatDevCommand(packageManager, "dev");
      }
      if (pkg.scripts?.start) {
        return this.formatDevCommand(packageManager, "start");
      }

      return null;
    } catch {
      return null;
    }
  }

  private formatDevCommand(packageManager: string, script: string): string {
    if (packageManager === "yarn") return `yarn ${script}`;
    if (packageManager === "bun") return `bun run ${script}`;
    if (packageManager === "pnpm") return `pnpm run ${script}`;
    return `npm run ${script}`;
  }

  private async needsDependencyInstall(cwd: string): Promise<boolean> {
    return !existsSync(path.join(cwd, "node_modules"));
  }

  private getInstallCommand(packageManager: string): string {
    if (packageManager === "pnpm") return "pnpm install";
    if (packageManager === "yarn") return "yarn install";
    if (packageManager === "bun") return "bun install";
    return "npm install";
  }
}
