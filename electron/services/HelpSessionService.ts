import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type { WindowRegistry } from "../window/WindowRegistry.js";
import { store } from "../store.js";
import { getHelpFolderPath } from "./HelpService.js";
import { resilientAtomicWriteFile } from "../utils/fs.js";
import type { HelpAssistantTier } from "../../shared/types/ipc/maps.js";

const SESSIONS_DIR_NAME = "help-sessions";
const META_FILE_NAME = "meta.json";
const GC_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TOKEN_BYTES = 32;

const DEFAULT_TIER: HelpAssistantTier = "action";
const DEFAULT_LOCAL_MCP_ENABLED = true;
const DEFAULT_DOCS_SERVER_ENABLED = true;
const DEFAULT_SKIP_PERMISSIONS = false;

interface ProvisionInput {
  projectId: string;
  projectPath: string;
  windowId: number;
  projectViewWebContentsId: number;
}

export interface ProvisionResult {
  sessionId: string;
  sessionPath: string;
  token: string;
  tier: HelpAssistantTier;
}

interface HelpSessionRecord {
  sessionId: string;
  token: string;
  windowId: number;
  projectViewWebContentsId: number;
  projectId: string;
  projectPath: string;
  sessionPath: string;
  tier: HelpAssistantTier;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
}

interface SessionMeta {
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  windowId: number;
  projectId: string;
}

interface BundledClaudeSettings {
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  defaultMode?: string;
  [key: string]: unknown;
}

function deepClonePlainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class HelpSessionService {
  private readonly sessionsByToken = new Map<string, HelpSessionRecord>();
  private readonly sessionsById = new Map<string, HelpSessionRecord>();
  private mcpRegistry: WindowRegistry | null = null;
  private disposed = false;

  setMcpRegistry(registry: WindowRegistry): void {
    this.mcpRegistry = registry;
  }

  validateToken(token: string): HelpAssistantTier | false {
    if (!token) return false;
    const record = this.sessionsByToken.get(token);
    if (!record) return false;
    if (record.revoked) return false;
    if (Date.now() > record.expiresAt) return false;
    return record.tier;
  }

  /**
   * Provisions a new help-session directory under userData/help-sessions/<sessionId>/
   * containing a generated .mcp.json (with `Bearer ${DAINTREE_MCP_TOKEN}`) and an
   * extended .claude/settings.json. Returns the token to inject as DAINTREE_MCP_TOKEN
   * in the spawned terminal's environment.
   */
  async provisionSession(input: ProvisionInput): Promise<ProvisionResult | null> {
    if (this.disposed) return null;
    this.validateProvisionInput(input);

    const helpFolder = getHelpFolderPath();
    if (!helpFolder) {
      console.warn("[HelpSessionService] Bundled help folder unavailable — cannot provision");
      return null;
    }

    const settings = this.readSettings();
    const tier = this.resolveTier(settings.skipPermissions);
    const sessionId = randomUUID();
    const token = randomBytes(SESSION_TOKEN_BYTES).toString("hex");
    const sessionsRoot = this.getSessionsRoot();
    const sessionPath = path.join(sessionsRoot, sessionId);

    if (settings.localMcpEnabled) {
      await this.ensureMcpServerRunning();
    }

    await fs.mkdir(sessionsRoot, { recursive: true });
    await fs.cp(helpFolder, sessionPath, { recursive: true });

    const port = await this.getMcpPort(settings.localMcpEnabled);
    await this.writeMcpConfig(sessionPath, settings, port);
    await this.writeClaudeSettings(sessionPath, helpFolder, settings);

    const now = Date.now();
    const record: HelpSessionRecord = {
      sessionId,
      token,
      windowId: input.windowId,
      projectViewWebContentsId: input.projectViewWebContentsId,
      projectId: input.projectId,
      projectPath: input.projectPath,
      sessionPath,
      tier,
      createdAt: now,
      expiresAt: now + GC_THRESHOLD_MS,
      revoked: false,
    };

    await this.writeSessionMeta(sessionPath, record);

    this.sessionsByToken.set(token, record);
    this.sessionsById.set(sessionId, record);

    return { sessionId, sessionPath, token, tier };
  }

  async revokeSession(sessionId: string): Promise<void> {
    const record = this.sessionsById.get(sessionId);
    if (!record || record.revoked) return;
    record.revoked = true;
    this.sessionsById.delete(sessionId);
    this.sessionsByToken.delete(record.token);
    await this.removeSessionDir(record.sessionPath);
  }

  async revokeByWebContentsId(webContentsId: number): Promise<void> {
    const targets = [...this.sessionsById.values()].filter(
      (record) => record.projectViewWebContentsId === webContentsId
    );
    await Promise.all(targets.map((record) => this.revokeSession(record.sessionId)));
  }

  async revokeByWindowId(windowId: number): Promise<void> {
    const targets = [...this.sessionsById.values()].filter(
      (record) => record.windowId === windowId
    );
    await Promise.all(targets.map((record) => this.revokeSession(record.sessionId)));
  }

  async revokeAll(): Promise<void> {
    const targets = [...this.sessionsById.values()];
    await Promise.all(targets.map((record) => this.revokeSession(record.sessionId)));
  }

  /**
   * Sweeps stale session dirs left over from a crash. Reads each meta.json and
   * deletes dirs whose `expiresAt` is in the past or whose meta is missing /
   * unreadable. Live sessions are protected by their in-memory record.
   */
  async gcStaleSessions(): Promise<void> {
    const sessionsRoot = this.getSessionsRoot();
    let entries: string[];
    try {
      entries = await fs.readdir(sessionsRoot);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      console.warn("[HelpSessionService] Failed to read sessions root for GC:", err);
      return;
    }

    const liveSessionIds = new Set(this.sessionsById.keys());
    const now = Date.now();

    await Promise.all(
      entries.map(async (entry) => {
        if (liveSessionIds.has(entry)) return;
        const dir = path.join(sessionsRoot, entry);
        const metaPath = path.join(dir, META_FILE_NAME);
        let stale = true;
        try {
          const raw = await fs.readFile(metaPath, "utf-8");
          const meta = JSON.parse(raw) as Partial<SessionMeta>;
          if (typeof meta?.expiresAt === "number" && meta.expiresAt > now) {
            stale = false;
          }
        } catch {
          stale = true;
        }
        if (stale) {
          await this.removeSessionDir(dir);
        }
      })
    );
  }

  dispose(): void {
    this.disposed = true;
    void this.revokeAll();
  }

  private validateProvisionInput(input: ProvisionInput): void {
    if (!input || typeof input !== "object") {
      throw new Error("Invalid provision input");
    }
    if (typeof input.projectId !== "string" || !input.projectId.trim()) {
      throw new Error("projectId is required");
    }
    if (typeof input.projectPath !== "string" || !input.projectPath.trim()) {
      throw new Error("projectPath is required");
    }
    if (!Number.isInteger(input.windowId) || input.windowId < 0) {
      throw new Error("windowId must be a non-negative integer");
    }
    if (!Number.isInteger(input.projectViewWebContentsId) || input.projectViewWebContentsId < 0) {
      throw new Error("projectViewWebContentsId must be a non-negative integer");
    }
  }

  private readSettings(): {
    localMcpEnabled: boolean;
    docsServerEnabled: boolean;
    skipPermissions: boolean;
  } {
    const stored = (store.get("helpAssistant") as Record<string, unknown> | undefined) ?? {};
    return {
      localMcpEnabled:
        typeof stored.localMcpEnabled === "boolean"
          ? stored.localMcpEnabled
          : DEFAULT_LOCAL_MCP_ENABLED,
      docsServerEnabled:
        typeof stored.docsServerEnabled === "boolean"
          ? stored.docsServerEnabled
          : DEFAULT_DOCS_SERVER_ENABLED,
      skipPermissions:
        typeof stored.skipPermissions === "boolean"
          ? stored.skipPermissions
          : DEFAULT_SKIP_PERMISSIONS,
    };
  }

  private resolveTier(skipPermissions: boolean): HelpAssistantTier {
    return skipPermissions ? "system" : DEFAULT_TIER;
  }

  private getSessionsRoot(): string {
    return path.join(app.getPath("userData"), SESSIONS_DIR_NAME);
  }

  private async ensureMcpServerRunning(): Promise<void> {
    if (!this.mcpRegistry) return;
    try {
      const { mcpServerService } = await import("./McpServerService.js");
      if (!mcpServerService.isRunning) {
        await mcpServerService.start(this.mcpRegistry);
      }
    } catch (err) {
      console.warn("[HelpSessionService] Failed to start MCP server for help session:", err);
    }
  }

  private async getMcpPort(localMcpEnabled: boolean): Promise<number | null> {
    if (!localMcpEnabled) return null;
    try {
      const { mcpServerService } = await import("./McpServerService.js");
      return mcpServerService.currentPort;
    } catch {
      return null;
    }
  }

  private async writeMcpConfig(
    sessionPath: string,
    settings: { localMcpEnabled: boolean; docsServerEnabled: boolean },
    port: number | null
  ): Promise<void> {
    const mcpServers: Record<string, unknown> = {};
    if (settings.docsServerEnabled) {
      mcpServers["daintree-docs"] = {
        type: "http",
        url: "https://daintree.org/api/mcp",
      };
    }
    if (settings.localMcpEnabled && port) {
      mcpServers["daintree"] = {
        type: "sse",
        url: `http://127.0.0.1:${port}/sse`,
        headers: { Authorization: "Bearer ${DAINTREE_MCP_TOKEN}" },
      };
    }
    const target = path.join(sessionPath, ".mcp.json");
    await resilientAtomicWriteFile(
      target,
      JSON.stringify({ mcpServers }, null, 2) + "\n",
      "utf-8",
      { mode: 0o600 }
    );
  }

  private async writeClaudeSettings(
    sessionPath: string,
    bundledHelpFolder: string,
    settings: { localMcpEnabled: boolean; skipPermissions: boolean }
  ): Promise<void> {
    const bundledSettingsPath = path.join(bundledHelpFolder, ".claude", "settings.json");
    const baseline = await this.readBundledSettings(bundledSettingsPath);

    const merged = deepClonePlainJson(baseline);
    if (!merged.permissions) merged.permissions = {};
    if (!Array.isArray(merged.permissions.allow)) merged.permissions.allow = [];

    if (settings.localMcpEnabled && !merged.permissions.allow.includes("mcp__daintree__*")) {
      merged.permissions.allow.push("mcp__daintree__*");
    }

    if (settings.skipPermissions) {
      merged.defaultMode = "bypassPermissions";
    }

    const target = path.join(sessionPath, ".claude", "settings.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await resilientAtomicWriteFile(target, JSON.stringify(merged, null, 2) + "\n", "utf-8", {
      mode: 0o600,
    });
  }

  private async readBundledSettings(settingsPath: string): Promise<BundledClaudeSettings> {
    try {
      const raw = await fs.readFile(settingsPath, "utf-8");
      const parsed = JSON.parse(raw) as BundledClaudeSettings;
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // fall through to baseline
    }
    return {
      permissions: {
        allow: ["Read(**)", "Glob(**)", "Grep(**)", "LS(**)", "WebFetch"],
        deny: ["Write(**)", "Edit(**)", "MultiEdit(**)", "Bash(**)"],
      },
    };
  }

  private async writeSessionMeta(sessionPath: string, record: HelpSessionRecord): Promise<void> {
    const meta: SessionMeta = {
      sessionId: record.sessionId,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      windowId: record.windowId,
      projectId: record.projectId,
    };
    const target = path.join(sessionPath, META_FILE_NAME);
    await resilientAtomicWriteFile(target, JSON.stringify(meta, null, 2) + "\n", "utf-8", {
      mode: 0o600,
    });
  }

  private async removeSessionDir(sessionPath: string): Promise<void> {
    try {
      await fs.rm(sessionPath, { recursive: true, force: true });
    } catch (err) {
      console.warn("[HelpSessionService] Failed to remove session dir:", sessionPath, err);
    }
  }
}

export const helpSessionService = new HelpSessionService();
