import crypto from "crypto";
import { EventEmitter } from "events";
import path from "path";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import type { PtyClient } from "./PtyClient.js";
import { extractLocalhostUrls } from "../../shared/utils/urlUtils.js";
import {
  detectDevServerError,
  isRecoverableError,
  type DevServerError,
} from "../../shared/utils/devServerErrors.js";

export type DevPreviewStatus = "installing" | "starting" | "running" | "error" | "stopped";

export interface DevPreviewSession {
  panelId: string;
  ptyId: string;
  projectRoot: string;
  cols: number;
  rows: number;
  status: DevPreviewStatus;
  statusMessage: string;
  url: string | null;
  packageManager: string | null;
  devCommand: string | null;
  installCommand: string | null;
  error?: string;
  timestamp: number;
  /** Cleanup functions for event listeners to prevent memory leaks */
  unsubscribers: (() => void)[];
  /** Generation token to prevent race conditions from concurrent start/stop */
  generation: number;
  /** Timeout handle for delayed command submission */
  submitTimeout?: NodeJS.Timeout;
  /** Buffer for accumulating PTY output for error detection */
  outputBuffer: string;
  /** Whether auto-recovery is currently in progress */
  recoveryInProgress: boolean;
  /** Count of recovery attempts for this session */
  recoveryAttempts: number;
}

export interface DevPreviewStartOptions {
  panelId: string;
  cwd: string;
  cols: number;
  rows: number;
  /** Optional command override. Falls back to auto-detection if not provided. */
  devCommand?: string;
}

export class DevPreviewService extends EventEmitter {
  private sessions = new Map<string, DevPreviewSession>();
  private generationCounter = 0;

  constructor(private ptyClient: PtyClient) {
    super();
  }

  async start(options: DevPreviewStartOptions): Promise<void> {
    const { panelId, cwd, cols, rows, devCommand: providedCommand } = options;

    const normalizedCommand = providedCommand?.trim() || undefined;
    const existingSession = this.sessions.get(panelId);

    if (existingSession) {
      const ptyActive = existingSession.ptyId
        ? this.ptyClient.hasTerminal(existingSession.ptyId)
        : true;
      const cwdMatches = existingSession.projectRoot === cwd;
      const commandMatches =
        normalizedCommand === undefined || existingSession.devCommand === normalizedCommand;

      if (ptyActive && cwdMatches && commandMatches) {
        existingSession.cols = cols;
        existingSession.rows = rows;
        existingSession.timestamp = Date.now();
        this.emitStatus(
          panelId,
          existingSession.status,
          existingSession.statusMessage,
          existingSession.url
        );
        if (existingSession.url) {
          this.emit("url", { panelId, url: existingSession.url });
        }
        return;
      }

      // Stop any existing session for this panel to prevent orphaned PTY processes and listener leaks
      await this.stop(panelId);
    }

    // Fallback chain: provided command → auto-detect → browser-only mode
    let finalCommand = normalizedCommand;
    let packageManager: string | null = null;
    let installCommand: string | null = null;
    let needsInstall = false;

    if (!finalCommand) {
      // Try auto-detection from package.json
      packageManager = await this.detectPackageManager(cwd);
      if (packageManager) {
        finalCommand = (await this.detectDevCommand(cwd, packageManager)) ?? undefined;
      }
    }

    // If we have a command, check if we need to install dependencies
    // Check for missing dependencies whether command was auto-detected or user-provided
    if (finalCommand) {
      packageManager = packageManager ?? (await this.detectPackageManager(cwd));
      if (packageManager) {
        needsInstall = await this.needsDependencyInstall(cwd);
        installCommand = needsInstall ? this.getInstallCommand(packageManager) : null;
      }
    }

    // Browser-only mode: no command available
    if (!finalCommand) {
      const session: DevPreviewSession = {
        panelId,
        ptyId: "", // No PTY in browser-only mode
        projectRoot: cwd,
        cols,
        rows,
        status: "running",
        statusMessage: "Browser-only mode (no dev command)",
        url: null,
        packageManager: null,
        devCommand: null,
        installCommand: null,
        timestamp: Date.now(),
        unsubscribers: [], // No listeners in browser-only mode
        generation: ++this.generationCounter,
        outputBuffer: "",
        recoveryInProgress: false,
        recoveryAttempts: 0,
      };
      this.sessions.set(panelId, session);
      this.emitStatus(panelId, "running", "Browser-only mode (no dev command)", null);
      return;
    }

    let fullCommand: string;
    if (installCommand) {
      fullCommand = `${installCommand} && ${finalCommand}`;
      this.emitStatus(panelId, "installing", "Installing dependencies...", null);
    } else {
      fullCommand = finalCommand;
      this.emitStatus(panelId, "starting", "Starting dev server...", null);
    }

    const ptyId = crypto.randomUUID();
    const generation = ++this.generationCounter;

    this.ptyClient.spawn(ptyId, {
      cwd,
      cols,
      rows,
      kind: "dev-preview",
    });

    // Delay command submission to allow PTY to fully initialize
    const submitTimeout = setTimeout(() => {
      // Check generation to ensure this session wasn't stopped/replaced during delay
      const currentSession = this.sessions.get(panelId);
      if (
        currentSession &&
        currentSession.generation === generation &&
        this.ptyClient.hasTerminal(ptyId)
      ) {
        this.ptyClient.submit(ptyId, fullCommand);
      }
    }, 100);

    // Create named listener functions so they can be removed later
    const dataListener = (id: string, data: string) => {
      if (id === ptyId) {
        this.handlePtyData(panelId, data);
      }
    };

    const exitListener = (id: string, exitCode: number) => {
      if (id === ptyId) {
        this.handlePtyExit(panelId, exitCode);
      }
    };

    // Register listeners - use on() not once() because PtyClient is shared across all terminals
    // Using once() would remove ALL exit listeners when the first terminal exits
    this.ptyClient.on("data", dataListener);
    this.ptyClient.on("exit", exitListener);

    // Create unsubscribe functions for cleanup
    const unsubscribers: (() => void)[] = [
      () => this.ptyClient.removeListener("data", dataListener),
      () => this.ptyClient.removeListener("exit", exitListener),
    ];

    const session: DevPreviewSession = {
      panelId,
      ptyId,
      projectRoot: cwd,
      cols,
      rows,
      status: needsInstall ? "installing" : "starting",
      statusMessage: needsInstall ? "Installing dependencies..." : "Starting dev server...",
      url: null,
      packageManager,
      devCommand: finalCommand,
      installCommand,
      timestamp: Date.now(),
      unsubscribers,
      generation,
      submitTimeout,
      outputBuffer: "",
      recoveryInProgress: false,
      recoveryAttempts: 0,
    };

    this.sessions.set(panelId, session);
  }

  async stop(panelId: string): Promise<void> {
    const session = this.sessions.get(panelId);
    if (!session) return;

    try {
      // Clear any pending command submission timeout
      if (session.submitTimeout) {
        clearTimeout(session.submitTimeout);
        session.submitTimeout = undefined;
      }

      // Remove all event listeners before killing PTY to prevent stale callbacks
      for (const unsubscribe of session.unsubscribers) {
        unsubscribe();
      }
      session.unsubscribers = [];

      // Only kill PTY if there is one (browser-only sessions have empty ptyId)
      if (session.ptyId) {
        await this.ptyClient.kill(session.ptyId);
      }
    } finally {
      // Always clean up session and emit status, even if kill fails
      this.sessions.delete(panelId);
      this.emitStatus(panelId, "stopped", "Dev server stopped", null);
    }
  }

  async restart(panelId: string): Promise<void> {
    const session = this.sessions.get(panelId);
    if (!session) return;

    const { projectRoot, cols, rows, devCommand } = session;

    await this.stop(panelId);

    await this.start({
      panelId,
      cwd: projectRoot,
      cols: cols || 80,
      rows: rows || 24,
      devCommand: devCommand ?? undefined,
    });
  }

  setUrl(panelId: string, url: string): void {
    const session = this.sessions.get(panelId);
    if (!session) return;

    session.url = url;
    session.status = "running";
    session.statusMessage = "Running";
    session.timestamp = Date.now();

    this.emit("url", { panelId, url });
    this.emitStatus(panelId, "running", "Running", url);
  }

  getSession(panelId: string): DevPreviewSession | undefined {
    return this.sessions.get(panelId);
  }

  private handlePtyData(panelId: string, data: string): void {
    const session = this.sessions.get(panelId);
    if (!session) return;

    // Accumulate output for error detection (keep last 4KB to limit memory)
    session.outputBuffer = (session.outputBuffer + data).slice(-4096);

    const urls = extractLocalhostUrls(data);
    if (urls.length > 0) {
      const preferredUrl = this.selectPreferredUrl(urls);
      if (preferredUrl && preferredUrl !== session.url) {
        this.setUrl(panelId, preferredUrl);
      }
    }

    if (session.status === "installing") {
      // Detect installation completion across different package managers
      const installCompletePatterns = [
        "added", // npm
        "packages in", // npm
        "dependencies installed", // pnpm
        "Done in", // yarn
        "packages installed", // bun
        "+ ", // pnpm/yarn adding packages
      ];

      if (installCompletePatterns.some((pattern) => data.includes(pattern))) {
        session.status = "starting";
        this.emitStatus(panelId, "starting", "Starting dev server...", null);
      }
    }

    // Only check for errors if we're starting (not already running, in error state, or recovering)
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

    // Limit recovery attempts to prevent infinite loops
    const MAX_RECOVERY_ATTEMPTS = 2;

    if (
      isRecoverableError(error) &&
      session.packageManager &&
      session.devCommand &&
      session.recoveryAttempts < MAX_RECOVERY_ATTEMPTS
    ) {
      // Attempt automatic recovery for missing dependencies
      session.recoveryInProgress = true;
      session.recoveryAttempts += 1;
      this.attemptDependencyRecovery(panelId);
    } else {
      // Non-recoverable error or max attempts reached - emit error status with actionable message
      this.emitStatus(panelId, "error", error.message, null);
    }
  }

  private attemptDependencyRecovery(panelId: string): void {
    const session = this.sessions.get(panelId);
    if (!session || !session.packageManager || !session.devCommand) return;

    const { projectRoot, cols, rows, packageManager, devCommand } = session;
    const newGeneration = ++this.generationCounter;

    // Kill the failing process
    if (session.ptyId) {
      // Clean up listeners before killing
      for (const unsubscribe of session.unsubscribers) {
        unsubscribe();
      }
      session.unsubscribers = [];

      this.ptyClient.kill(session.ptyId);
    }

    // Re-check session still exists after kill (stop/restart could have removed it)
    const sessionAfterKill = this.sessions.get(panelId);
    if (!sessionAfterKill) {
      // Session was removed during kill - abort recovery
      return;
    }

    // Start install process with chained dev command
    const installCmd = this.getInstallCommand(packageManager);
    const fullCommand = `${installCmd} && ${devCommand}`;
    const newPtyId = crypto.randomUUID();

    this.ptyClient.spawn(newPtyId, {
      cwd: projectRoot,
      cols,
      rows,
      kind: "dev-preview",
    });

    // Create new listeners for the recovery PTY
    const dataListener = (id: string, data: string) => {
      if (id === newPtyId) {
        this.handlePtyData(panelId, data);
      }
    };

    const exitListener = (id: string, exitCode: number) => {
      if (id === newPtyId) {
        this.handlePtyExit(panelId, exitCode);
      }
    };

    this.ptyClient.on("data", dataListener);
    this.ptyClient.on("exit", exitListener);

    const unsubscribers: (() => void)[] = [
      () => this.ptyClient.removeListener("data", dataListener),
      () => this.ptyClient.removeListener("exit", exitListener),
    ];

    // Delay command submission to allow PTY to fully initialize
    const submitTimeout = setTimeout(() => {
      const currentSession = this.sessions.get(panelId);
      if (
        currentSession &&
        currentSession.generation === newGeneration &&
        this.ptyClient.hasTerminal(newPtyId)
      ) {
        this.ptyClient.submit(newPtyId, fullCommand);
      } else if (!currentSession) {
        // Session was removed - clean up orphaned PTY
        this.ptyClient.kill(newPtyId);
        unsubscribers.forEach((unsub) => unsub());
      }
    }, 100);

    // Final check - session still exists before updating
    const sessionBeforeUpdate = this.sessions.get(panelId);
    if (!sessionBeforeUpdate) {
      // Session was removed - clean up
      clearTimeout(submitTimeout);
      this.ptyClient.kill(newPtyId);
      unsubscribers.forEach((unsub) => unsub());
      return;
    }

    // Update session with new PTY and generation
    sessionBeforeUpdate.ptyId = newPtyId;
    sessionBeforeUpdate.generation = newGeneration;
    sessionBeforeUpdate.status = "installing";
    sessionBeforeUpdate.statusMessage = "Installing missing dependencies...";
    sessionBeforeUpdate.unsubscribers = unsubscribers;
    sessionBeforeUpdate.submitTimeout = submitTimeout;
    sessionBeforeUpdate.outputBuffer = "";
    sessionBeforeUpdate.recoveryInProgress = false; // Reset flag to allow error detection to continue

    this.emitStatus(panelId, "installing", "Installing missing dependencies...", null);
  }

  private handlePtyExit(panelId: string, code: number): void {
    const session = this.sessions.get(panelId);
    if (!session) return;

    // Clear any pending command submission timeout
    if (session.submitTimeout) {
      clearTimeout(session.submitTimeout);
      session.submitTimeout = undefined;
    }

    // Clean up all listeners
    for (const unsubscribe of session.unsubscribers) {
      unsubscribe();
    }
    session.unsubscribers = [];

    if (code !== 0) {
      // Preserve existing error message if one was detected, otherwise show generic exit code
      const errorMessage =
        session.status === "error" && session.error
          ? session.error
          : `Process exited with code ${code}`;
      this.emitStatus(panelId, "error", errorMessage, null);
    } else {
      this.emitStatus(panelId, "stopped", "Dev server stopped", null);
    }

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
      status,
      message,
      timestamp: Date.now(),
      error: status === "error" ? message : undefined,
      ptyId: session?.ptyId ?? "",
    });
  }

  private async detectPackageManager(cwd: string): Promise<string | null> {
    const pkgPath = path.join(cwd, "package.json");
    if (!existsSync(pkgPath)) return null;

    if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
    if (existsSync(path.join(cwd, "bun.lockb"))) return "bun";
    return "npm";
  }

  private async detectDevCommand(cwd: string, packageManager: string): Promise<string | null> {
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
