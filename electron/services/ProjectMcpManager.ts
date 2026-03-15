import { spawn, type ChildProcess } from "child_process";
import type { BrowserWindow } from "electron";
import type { ProjectMcpServerConfig } from "../../shared/types/domain.js";
import type { ProjectMcpServerRunState } from "../../shared/types/ipc/project.js";
import { CHANNELS } from "../ipc/channels.js";
import { sendToRenderer } from "../ipc/utils.js";

const SIGKILL_TIMEOUT_MS = 3000;

export class ProjectMcpManager {
  private processes = new Map<string, ChildProcess>();
  private statuses = new Map<string, ProjectMcpServerRunState>();
  private mainWindow: BrowserWindow;

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
  }

  async startForProject(
    projectId: string,
    projectPath: string,
    servers: Record<string, ProjectMcpServerConfig>
  ): Promise<void> {
    const entries = Object.entries(servers);
    if (entries.length === 0) return;

    for (const [name, config] of entries) {
      this.startServer(projectId, projectPath, name, config);
    }
  }

  private startServer(
    projectId: string,
    projectPath: string,
    name: string,
    config: ProjectMcpServerConfig
  ): void {
    const key = `${projectId}:${name}`;

    this.setStatus(projectId, name, { name, status: "starting" });

    try {
      const child = spawn(config.command, config.args ?? [], {
        cwd: config.cwd ?? projectPath,
        env: { ...process.env, ...config.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: false,
      });

      this.processes.set(key, child);

      child.on("spawn", () => {
        this.setStatus(projectId, name, {
          name,
          status: "running",
          pid: child.pid,
        });
      });

      child.stdout?.on("data", () => {
        // Consume stdout to prevent pipe buffer from filling
      });

      child.stderr?.on("data", () => {
        // Consume stderr to prevent pipe buffer from filling
      });

      child.on("error", (err) => {
        this.processes.delete(key);
        this.setStatus(projectId, name, {
          name,
          status: "error",
          error: err.message,
        });
      });

      child.on("exit", (code) => {
        this.processes.delete(key);
        const currentStatus = this.statuses.get(key);
        if (currentStatus?.status !== "stopped") {
          this.setStatus(projectId, name, {
            name,
            status: "error",
            error: `Process exited with code ${code}`,
          });
        }
      });
    } catch (err) {
      this.setStatus(projectId, name, {
        name,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async stopForProject(projectId: string): Promise<void> {
    const keysToStop = [...this.processes.keys()].filter((k) => k.startsWith(`${projectId}:`));
    await Promise.allSettled(keysToStop.map((key) => this.stopProcess(key)));
  }

  async stopAll(): Promise<void> {
    const keys = [...this.processes.keys()];
    await Promise.allSettled(keys.map((key) => this.stopProcess(key)));
  }

  private stopProcess(key: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const child = this.processes.get(key);
      if (!child) {
        resolve();
        return;
      }

      const [projectId, name] = this.parseKey(key);
      this.setStatus(projectId, name, { name, status: "stopped" });
      this.processes.delete(key);

      if (child.exitCode !== null) {
        resolve();
        return;
      }

      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already dead
        }
        resolve();
      }, SIGKILL_TIMEOUT_MS);

      child.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });

      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });
  }

  getStatuses(projectId: string): ProjectMcpServerRunState[] {
    const result: ProjectMcpServerRunState[] = [];
    for (const [key, status] of this.statuses) {
      if (key.startsWith(`${projectId}:`)) {
        result.push(status);
      }
    }
    return result;
  }

  private setStatus(projectId: string, name: string, state: ProjectMcpServerRunState): void {
    const key = `${projectId}:${name}`;
    this.statuses.set(key, state);
    sendToRenderer(this.mainWindow, CHANNELS.PROJECT_MCP_STATUS_CHANGED, {
      projectId,
      servers: this.getStatuses(projectId),
    });
  }

  private parseKey(key: string): [string, string] {
    const colonIndex = key.indexOf(":");
    return [key.slice(0, colonIndex), key.slice(colonIndex + 1)];
  }
}
