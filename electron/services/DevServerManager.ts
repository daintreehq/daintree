import { execa } from "execa";
import type { ResultPromise, Result } from "execa";
import type { BrowserWindow } from "electron";
import { DevServerState, DevServerStatus } from "../types/index.js";
import { events } from "./events.js";
import { projectStore } from "./ProjectStore.js";
import { DevServerParser } from "./devserver/DevServerParser.js";
import { CommandDetector } from "./devserver/CommandDetector.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";

const FORCE_KILL_TIMEOUT_MS = 5000;
const MAX_LOG_LINES = 100;
const RESTART_COOLDOWN_MS = 60000; // Prevent restart loops

/**
 * DevServerManager - Manages dev server processes for worktrees.
 *
 * @pattern Dependency Injection via main.ts (Pattern B)
 *
 * State changes emitted via event bus (server:update, server:error).
 *
 * Why this pattern:
 * - Manages multiple child processes (dev server per worktree) via execa
 * - Needs WorkspaceClient reference for URL parsing (cross-service dependency)
 * - Lifecycle tied to app: servers must be stopped on app quit
 * - Created in main.ts composition root, injected into IPC handlers
 *
 * When to use Pattern B:
 * - Service spawns/manages external processes
 * - Service has runtime dependencies on other services (setWorkspaceClient)
 * - Explicit cleanup required on application shutdown
 * - Service state must be coordinated with window lifecycle
 */
export class DevServerManager {
  private servers = new Map<string, ResultPromise>();
  private states = new Map<string, DevServerState>();
  private logBuffers = new Map<string, string[]>();
  private commandDetector = new CommandDetector();
  private lastKnownProjectId: string | null = null;
  private activeProjectId: string | null = null; // Filter IPC events by this project
  private lastRestartAttempt = new Map<string, number>(); // Track restart times to prevent loops
  private worktreePaths = new Map<string, string>(); // Cache worktree paths for restart
  private resumeInProgress = false; // Prevent overlapping resume operations
  private workspaceClient: WorkspaceClient | null = null; // For offloading URL parsing to workspace-host

  /**
   * Set the active project for IPC event filtering.
   * Only servers belonging to the active project will emit update events to the renderer.
   */
  public setActiveProject(projectId: string | null): void {
    const previousProjectId = this.activeProjectId;
    this.activeProjectId = projectId;

    if (process.env.CANOPY_VERBOSE) {
      console.log(
        `[DevServerManager] Active project changed: ${previousProjectId || "none"} → ${projectId || "none"}`
      );
    }
  }

  /**
   * Get the current active project ID.
   */
  public getActiveProjectId(): string | null {
    return this.activeProjectId;
  }

  /**
   * Set the WorkspaceClient reference for offloading URL parsing to workspace-host.
   * This enables CPU-intensive regex parsing to run in a UtilityProcess instead of Main.
   */
  public setWorkspaceClient(client: WorkspaceClient): void {
    this.workspaceClient = client;
  }

  public initialize(
    _mainWindow: BrowserWindow,
    _sendToRenderer: (channel: string, ...args: unknown[]) => void
  ): void {}

  public getState(worktreeId: string): DevServerState {
    return (
      this.states.get(worktreeId) ?? {
        worktreeId,
        status: "stopped",
      }
    );
  }

  public getAllStates(): Map<string, DevServerState> {
    return new Map(this.states);
  }

  public isRunning(worktreeId: string): boolean {
    const state = this.states.get(worktreeId);
    return state?.status === "running" || state?.status === "starting";
  }

  public async start(
    worktreeId: string,
    worktreePath: string,
    command?: string,
    projectId?: string // Which project owns this server (for multi-tenancy)
  ): Promise<void> {
    if (this.isRunning(worktreeId)) {
      console.warn("Dev server already running for worktree", worktreeId);
      return;
    }

    const resolvedCommand = command ?? (await this.detectDevCommandAsync(worktreePath));

    if (!resolvedCommand) {
      this.updateState(worktreeId, {
        status: "error",
        errorMessage: "No dev script found in package.json",
        projectId, // Store project ID even for errors
      });
      this.emitError(worktreeId, "No dev script found in package.json");
      return;
    }

    console.log("Starting dev server", { worktreeId, projectId, command: resolvedCommand });

    // Cache worktree path for potential restart after sleep
    this.worktreePaths.set(worktreeId, worktreePath);

    this.updateState(worktreeId, { status: "starting", errorMessage: undefined, projectId });

    this.logBuffers.set(worktreeId, []);

    try {
      const parsed = this.commandDetector.parseCommand(resolvedCommand);
      const proc = execa(parsed.executable, parsed.args, {
        cwd: worktreePath,
        env: parsed.env ? { ...process.env, ...parsed.env } : undefined,
        buffer: false,
        cleanup: true,
        reject: false,
      });

      this.servers.set(worktreeId, proc);
      const serverPid = proc.pid;
      this.updateState(worktreeId, { pid: serverPid });

      if (proc.stdout) {
        proc.stdout.on("data", (data: Buffer) => {
          const output = data.toString();
          this.appendLog(worktreeId, output);
          this.detectUrl(worktreeId, output);
        });
      }

      if (proc.stderr) {
        proc.stderr.on("data", (data: Buffer) => {
          const output = data.toString();
          this.appendLog(worktreeId, output);
          this.detectUrl(worktreeId, output);
        });
      }

      proc
        .then((result: Result) => {
          console.log("Dev server exited", {
            worktreeId,
            exitCode: result.exitCode,
            signal: result.signal,
          });
          this.servers.delete(worktreeId);

          const currentState = this.states.get(worktreeId);

          // Ignore stale promise if PID doesn't match (server was restarted)
          if (currentState?.pid && currentState.pid !== serverPid) {
            console.log("[DevServerManager] Ignoring stale exit for restarted server", {
              worktreeId,
              stalePid: serverPid,
              currentPid: currentState.pid,
            });
            return;
          }

          if (currentState?.status !== "error") {
            const exitCode = result.exitCode ?? null;
            const signal = result.signal ?? null;

            if (
              exitCode !== 0 &&
              exitCode !== null &&
              signal !== "SIGTERM" &&
              signal !== "SIGKILL"
            ) {
              const errorMessage = `Process exited with code ${exitCode}`;
              this.updateState(worktreeId, {
                status: "error",
                errorMessage,
              });
              this.emitError(worktreeId, errorMessage);
            } else {
              this.updateState(worktreeId, {
                status: "stopped",
                url: undefined,
                port: undefined,
                pid: undefined,
                errorMessage: undefined,
              });
            }
          }
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Unknown error";
          console.error("Dev server process error", { worktreeId, error: message });
          this.servers.delete(worktreeId);
          this.updateState(worktreeId, {
            status: "error",
            errorMessage: message,
          });
          this.emitError(worktreeId, message);
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to start dev server", { worktreeId, error: message });
      this.updateState(worktreeId, {
        status: "error",
        errorMessage: message,
      });
      this.emitError(worktreeId, message);
    }
  }

  public async stop(worktreeId: string): Promise<void> {
    const proc = this.servers.get(worktreeId);

    if (!proc) {
      this.updateState(worktreeId, {
        status: "stopped",
        url: undefined,
        port: undefined,
        pid: undefined,
        errorMessage: undefined,
      });
      // Clean up cached path when server stops
      this.worktreePaths.delete(worktreeId);
      return;
    }

    console.log("Stopping dev server", { worktreeId, pid: proc.pid });

    return new Promise((resolve) => {
      const forceKillTimer = setTimeout(() => {
        console.warn("Force killing dev server", { worktreeId });
        try {
          proc.kill("SIGKILL");
        } catch {
          // Ignore error if process already dead
        }
      }, FORCE_KILL_TIMEOUT_MS);

      proc.finally(() => {
        clearTimeout(forceKillTimer);
        this.servers.delete(worktreeId);
        this.worktreePaths.delete(worktreeId);
        this.updateState(worktreeId, {
          status: "stopped",
          url: undefined,
          port: undefined,
          pid: undefined,
        });
        resolve();
      });

      try {
        proc.kill("SIGTERM");
      } catch {
        clearTimeout(forceKillTimer);
        resolve();
      }
    });
  }

  public async toggle(
    worktreeId: string,
    worktreePath: string,
    command?: string,
    projectId?: string
  ): Promise<void> {
    const state = this.getState(worktreeId);

    if (state.status === "stopped" || state.status === "error") {
      await this.start(worktreeId, worktreePath, command, projectId);
    } else {
      await this.stop(worktreeId);
    }
  }

  public async stopAll(): Promise<void> {
    console.log("Stopping all dev servers", { count: this.servers.size });

    const promises = Array.from(this.servers.keys()).map((worktreeId) => this.stop(worktreeId));

    await Promise.all(promises);
    this.servers.clear();
    this.states.clear();
    this.logBuffers.clear();
    this.worktreePaths.clear();
  }

  /**
   * Handle system resume from sleep. Check if dev server processes are still alive
   * and mark dead ones appropriately. Optionally auto-restart if project has autoStart enabled.
   */
  public async onSystemResume(): Promise<void> {
    // Prevent overlapping resume operations
    if (this.resumeInProgress) {
      console.log("[DevServerManager] Resume already in progress, skipping");
      return;
    }

    this.resumeInProgress = true;
    try {
      console.log("[DevServerManager] Handling system resume");

      const deadServers: Array<{ worktreeId: string; projectId?: string; pid: number }> = [];

      for (const [worktreeId, state] of this.states.entries()) {
        // Check servers that are running or starting with a pid
        if ((state.status !== "running" && state.status !== "starting") || !state.pid) continue;

        // Re-read current state to avoid racing with manual stop operations
        const currentState = this.states.get(worktreeId);
        if (!currentState || currentState.status === "stopped" || !currentState.pid) continue;

        const serverPid = currentState.pid;
        const serverProc = this.servers.get(worktreeId);

        let alive = true;
        try {
          // Signal 0 tests if process exists without killing it
          process.kill(serverPid, 0);

          // Verify the process is actually our child by checking if it matches the tracked promise
          if (serverProc && serverProc.pid !== serverPid) {
            // PID was reused by a different process
            alive = false;
          }
        } catch (error: unknown) {
          const errorCode =
            error && typeof error === "object" && "code" in error ? error.code : null;
          // ESRCH means process doesn't exist (dead)
          // EPERM means process exists but we can't signal it (treat as alive for our own children)
          if (errorCode === "ESRCH") {
            alive = false;
          }
        }

        if (!alive) {
          console.warn("[DevServerManager] Dev server died during sleep", {
            worktreeId,
            pid: serverPid,
            url: currentState.url,
          });

          // Remove from servers map since process is dead
          this.servers.delete(worktreeId);

          this.updateState(worktreeId, {
            status: "error",
            errorMessage: "Dev server stopped while system was asleep",
            pid: undefined,
            url: undefined,
            port: undefined,
          });

          this.emitError(worktreeId, "Dev server stopped while system was asleep");
          deadServers.push({ worktreeId, projectId: currentState.projectId, pid: serverPid });
        }
      }

      if (deadServers.length === 0) {
        console.log("[DevServerManager] All dev servers survived sleep");
        return;
      }

      console.log(`[DevServerManager] ${deadServers.length} dev server(s) died during sleep`);

      // Auto-restart servers if their project has autoStart enabled
      for (const { worktreeId, projectId } of deadServers) {
        try {
          const shouldRestart = await this.shouldAutoRestart(worktreeId, projectId);
          if (shouldRestart) {
            const worktreePath = this.worktreePaths.get(worktreeId);
            if (worktreePath) {
              console.log("[DevServerManager] Auto-restarting dev server", { worktreeId });
              await this.start(worktreeId, worktreePath, undefined, projectId);
              // Mark restart time after successful start
              this.lastRestartAttempt.set(worktreeId, Date.now());
            } else {
              console.warn("[DevServerManager] Cannot auto-restart: worktree path not cached", {
                worktreeId,
              });
            }
          }
        } catch (error) {
          console.error("[DevServerManager] Auto-restart failed", { worktreeId, error });
          // Continue processing other dead servers
        }
      }
    } finally {
      this.resumeInProgress = false;
    }
  }

  /**
   * Check if a dev server should auto-restart after sleep.
   * Requires project autoStart setting and respects cooldown.
   */
  private async shouldAutoRestart(
    worktreeId: string,
    projectId: string | undefined
  ): Promise<boolean> {
    if (!projectId) return false;

    // Check cooldown to prevent restart loops
    const lastAttempt = this.lastRestartAttempt.get(worktreeId);
    if (lastAttempt && Date.now() - lastAttempt < RESTART_COOLDOWN_MS) {
      console.log("[DevServerManager] Skipping auto-restart (cooldown)", { worktreeId });
      return false;
    }

    try {
      const settings = await projectStore.getProjectSettings(projectId);
      return settings.devServer?.autoStart ?? false;
    } catch (error) {
      console.error("[DevServerManager] Failed to check project settings", { projectId, error });
      return false;
    }
  }

  /**
   * Handle project switch - filter servers by project instead of stopping.
   * Servers from other projects are "backgrounded" (kept running but hidden from UI).
   * @param newProjectId - The ID of the project being switched to
   */
  public async onProjectSwitch(newProjectId: string): Promise<void> {
    console.log(`[DevServerManager] Switching to project: ${newProjectId}`);

    let backgrounded = 0;
    let foregrounded = 0;

    // Do NOT stop servers - just emit state changes for UI filtering
    for (const [worktreeId, state] of this.states) {
      // For legacy servers without projectId, use lastKnownProjectId (not newProjectId)
      // This prevents legacy servers from appearing in every project they don't belong to
      const serverProjectId = state.projectId || this.lastKnownProjectId;

      // If still no projectId (very first switch), background the server to be safe
      if (!serverProjectId || serverProjectId !== newProjectId) {
        // Server belongs to different project (or unknown) - background it
        backgrounded++;
        events.emit("server:backgrounded", {
          worktreeId,
          projectId: serverProjectId || "unknown",
          timestamp: Date.now(),
        });
      } else {
        // Server belongs to current project - foreground it
        foregrounded++;
        events.emit("server:foregrounded", {
          worktreeId,
          projectId: serverProjectId,
          timestamp: Date.now(),
        });
      }
    }

    // Update lastKnownProjectId for future legacy servers
    this.lastKnownProjectId = newProjectId;

    // Clear cache since different projects may have different package.json files
    this.commandDetector.clearCache();

    console.log(
      `[DevServerManager] Project switch complete: ${foregrounded} foregrounded, ${backgrounded} backgrounded`
    );
  }

  /**
   * Get servers for a specific project.
   * Uses same classification logic as onProjectSwitch for consistency.
   * @param projectId - The project ID to filter by
   * @returns Array of worktree IDs with servers belonging to the project
   */
  public getServersForProject(projectId: string): string[] {
    const result: string[] = [];
    for (const [worktreeId, state] of this.states) {
      // Use same fallback logic as onProjectSwitch
      const serverProjectId = state.projectId || this.lastKnownProjectId;
      if (serverProjectId === projectId) {
        result.push(worktreeId);
      }
    }
    return result;
  }

  /**
   * Stop all dev servers for a specific project.
   * Used when explicitly closing a project to free resources.
   * @param projectId - Project ID to stop servers for
   * @returns Number of servers stopped
   */
  public async stopByProject(projectId: string): Promise<number> {
    const serversToStop: string[] = [];

    for (const [worktreeId, state] of this.states.entries()) {
      const serverProjectId = state.projectId || this.lastKnownProjectId;
      if (serverProjectId === projectId && this.servers.has(worktreeId)) {
        serversToStop.push(worktreeId);
      }
    }

    if (serversToStop.length === 0) {
      console.log(`[DevServerManager] No servers to stop for project ${projectId}`);
      return 0;
    }

    console.log(
      `[DevServerManager] Stopping ${serversToStop.length} server(s) for project ${projectId}`
    );

    const results = await Promise.allSettled(serversToStop.map((id) => this.stop(id)));
    const stopped = results.filter((r) => r.status === "fulfilled").length;

    console.log(`[DevServerManager] Stopped ${stopped}/${serversToStop.length} servers`);
    return stopped;
  }

  /**
   * Get dev server count for a project.
   * @param projectId - Project ID to count servers for
   * @returns Number of running servers for this project
   */
  public getProjectServerCount(projectId: string): number {
    let count = 0;
    for (const [worktreeId, state] of this.states.entries()) {
      const serverProjectId = state.projectId || this.lastKnownProjectId;
      if (
        serverProjectId === projectId &&
        (state.status === "running" || state.status === "starting") &&
        this.servers.has(worktreeId)
      ) {
        count++;
      }
    }
    return count;
  }

  public getLogs(worktreeId: string): string[] {
    return this.logBuffers.get(worktreeId) ?? [];
  }

  public async detectDevCommandAsync(worktreePath: string): Promise<string | null> {
    return this.commandDetector.detectDevCommand(worktreePath);
  }

  public async hasDevScriptAsync(worktreePath: string): Promise<boolean> {
    return this.commandDetector.hasDevScript(worktreePath);
  }

  public invalidateCache(worktreePath: string): void {
    this.commandDetector.invalidateCache(worktreePath);
  }

  public clearCache(): void {
    this.commandDetector.clearCache();
  }

  public async warmCache(worktreePaths: string[]): Promise<void> {
    await this.commandDetector.warmCache(worktreePaths);
  }

  private updateState(
    worktreeId: string,
    updates: Partial<Omit<DevServerState, "worktreeId">>
  ): void {
    const current = this.states.get(worktreeId) ?? {
      worktreeId,
      status: "stopped" as DevServerStatus,
    };
    const next: DevServerState = { ...current, ...updates };

    const hasChanged =
      current.status !== next.status ||
      current.url !== next.url ||
      current.port !== next.port ||
      current.pid !== next.pid ||
      current.projectId !== next.projectId ||
      current.errorMessage !== next.errorMessage;

    if (hasChanged) {
      this.states.set(worktreeId, next);
      this.emitUpdate(next);
    }
  }

  private emitUpdate(state: DevServerState): void {
    // No active project filter → emit all
    if (!this.activeProjectId) {
      events.emit("server:update", {
        ...state,
        timestamp: Date.now(),
      });
      return;
    }

    // Use same classification logic as onProjectSwitch for consistency
    const serverProjectId = state.projectId || this.lastKnownProjectId;

    // Only emit if server belongs to active project
    // Servers without any projectId (even after fallback) are backgrounded to be safe
    if (serverProjectId && serverProjectId === this.activeProjectId) {
      events.emit("server:update", {
        ...state,
        timestamp: Date.now(),
      });
    }
    // Else: server belongs to backgrounded project - suppress IPC event
  }

  private emitError(worktreeId: string, error: string): void {
    // Include projectId in error event for proper correlation
    const state = this.states.get(worktreeId);
    events.emit("server:error", {
      worktreeId,
      projectId: state?.projectId,
      error,
      timestamp: Date.now(),
    });
  }

  private appendLog(worktreeId: string, output: string): void {
    const logs = this.logBuffers.get(worktreeId) ?? [];

    const lines = output.split("\n").filter((line) => line.trim());
    logs.push(...lines);

    if (logs.length > MAX_LOG_LINES) {
      logs.splice(0, logs.length - MAX_LOG_LINES);
    }

    this.logBuffers.set(worktreeId, logs);

    const current = this.states.get(worktreeId);
    if (current) {
      this.states.set(worktreeId, { ...current, logs });
    }
  }

  private detectUrl(worktreeId: string, output: string): void {
    const currentState = this.states.get(worktreeId);

    if (currentState?.status !== "starting") {
      return;
    }

    // Use workspace-host for parsing if available (offloads regex work from Main thread)
    if (this.workspaceClient?.isReady()) {
      void this.detectUrlViaWorkspaceHost(worktreeId, output);
    } else {
      // Fallback to direct parsing if workspace-host not available
      const detected = DevServerParser.detectUrl(output);
      if (detected) {
        console.log("Detected dev server URL", { worktreeId, ...detected });
        this.updateState(worktreeId, {
          status: "running",
          url: detected.url,
          port: detected.port,
          errorMessage: undefined,
        });
      }
    }
  }

  /**
   * Delegates URL detection to the workspace-host utility process.
   * Includes protection against race conditions where the server might have restarted
   * while the async parsing was in progress.
   */
  private async detectUrlViaWorkspaceHost(worktreeId: string, output: string): Promise<void> {
    const currentState = this.states.get(worktreeId);
    if (!currentState) return;

    const serverPid = currentState.pid;

    try {
      const detected = await this.workspaceClient!.parseDevOutput(worktreeId, output);

      // If no URL detected by workspace-host, try local parser as fallback
      if (!detected?.url) {
        const localDetected = DevServerParser.detectUrl(output);
        if (localDetected) {
          const state = this.states.get(worktreeId);
          if (state?.status === "starting" && state.pid === serverPid) {
            console.log("Detected dev server URL (local fallback)", {
              worktreeId,
              ...localDetected,
            });
            this.updateState(worktreeId, {
              status: "running",
              url: localDetected.url,
              port: localDetected.port,
              errorMessage: undefined,
            });
          }
        }
        return;
      }

      // Verify state and PID haven't changed during async operation
      const state = this.states.get(worktreeId);
      if (state?.status === "starting" && state.pid === serverPid) {
        console.log("Detected dev server URL via workspace-host", { worktreeId, ...detected });
        this.updateState(worktreeId, {
          status: "running",
          url: detected.url,
          port: detected.port,
          errorMessage: undefined,
        });
      }
    } catch (error) {
      console.warn("[DevServerManager] Workspace-host parse failed, using local fallback:", error);
      // Fallback to direct parsing if workspace-host call fails
      const detected = DevServerParser.detectUrl(output);
      if (detected) {
        const state = this.states.get(worktreeId);
        if (state?.status === "starting" && state.pid === serverPid) {
          console.log("Detected dev server URL (error fallback)", { worktreeId, ...detected });
          this.updateState(worktreeId, {
            status: "running",
            url: detected.url,
            port: detected.port,
            errorMessage: undefined,
          });
        }
      }
    }
  }
}
