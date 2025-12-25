import crypto from "crypto";
import { EventEmitter } from "events";
import path from "path";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import type { PtyClient } from "./PtyClient.js";
import { extractLocalhostUrls } from "../../shared/utils/urlUtils.js";

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
}

export interface DevPreviewStartOptions {
  panelId: string;
  cwd: string;
  cols: number;
  rows: number;
}

export class DevPreviewService extends EventEmitter {
  private sessions = new Map<string, DevPreviewSession>();

  constructor(private ptyClient: PtyClient) {
    super();
  }

  async start(options: DevPreviewStartOptions): Promise<void> {
    const { panelId, cwd, cols, rows } = options;

    const packageManager = await this.detectPackageManager(cwd);
    if (!packageManager) {
      this.emitStatus(panelId, "error", "No package.json found", null);
      return;
    }

    const devCommand = await this.detectDevCommand(cwd, packageManager);
    if (!devCommand) {
      this.emitStatus(panelId, "error", "No dev script found in package.json", null);
      return;
    }

    const needsInstall = await this.needsDependencyInstall(cwd);
    const installCommand = needsInstall ? this.getInstallCommand(packageManager) : null;

    let fullCommand: string;
    if (installCommand) {
      fullCommand = `${installCommand} && ${devCommand}`;
      this.emitStatus(panelId, "installing", "Installing dependencies...", null);
    } else {
      fullCommand = devCommand;
      this.emitStatus(panelId, "starting", "Starting dev server...", null);
    }

    const ptyId = crypto.randomUUID();
    this.ptyClient.spawn(ptyId, {
      cwd,
      cols,
      rows,
    });
    setTimeout(() => {
      if (this.ptyClient.hasTerminal(ptyId)) {
        this.ptyClient.submit(ptyId, fullCommand);
      }
    }, 100);

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
      devCommand,
      installCommand,
      timestamp: Date.now(),
    };

    this.sessions.set(panelId, session);

    this.ptyClient.on("data", (data) => {
      if (data.id === ptyId) {
        this.handlePtyData(panelId, data.data);
      }
    });

    this.ptyClient.on("exit", (data) => {
      if (data.id === ptyId) {
        this.handlePtyExit(panelId, data.code);
      }
    });
  }

  async stop(panelId: string): Promise<void> {
    const session = this.sessions.get(panelId);
    if (!session) return;

    await this.ptyClient.kill(session.ptyId);
    this.sessions.delete(panelId);
    this.emitStatus(panelId, "stopped", "Dev server stopped", null);
  }

  async restart(panelId: string): Promise<void> {
    const session = this.sessions.get(panelId);
    if (!session) return;

    const { projectRoot, cols, rows } = session;

    await this.stop(panelId);

    await this.start({
      panelId,
      cwd: projectRoot,
      cols: cols || 80,
      rows: rows || 24,
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

    const urls = extractLocalhostUrls(data);
    if (urls.length > 0) {
      const preferredUrl = this.selectPreferredUrl(urls);
      if (preferredUrl && preferredUrl !== session.url) {
        this.setUrl(panelId, preferredUrl);
      }
    }

    if (session.status === "installing") {
      if (data.includes("added") || data.includes("packages in")) {
        this.emitStatus(panelId, "starting", "Starting dev server...", null);
      }
    }
  }

  private handlePtyExit(panelId: string, code: number): void {
    const session = this.sessions.get(panelId);
    if (!session) return;

    if (code !== 0) {
      this.emitStatus(panelId, "error", `Process exited with code ${code}`, null);
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
