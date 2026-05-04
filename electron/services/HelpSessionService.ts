import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type { WindowRegistry } from "../window/WindowRegistry.js";
import { store } from "../store.js";
import { getHelpFolderPath } from "./HelpService.js";
import { resilientAtomicWriteFile } from "../utils/fs.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import type { HelpAssistantTier } from "../../shared/types/ipc/maps.js";

const SESSIONS_DIR_NAME = "help-sessions";
const META_FILE_NAME = "meta.json";
const SESSION_TOKEN_BYTES = 32;
// SHA-256 → 16-char hex slice. Stable per absolute project path; collisions
// in 64 bits of project-path-derived entropy are not a real concern for a
// machine-local set of projects.
const PROJECT_HASH_LEN = 16;

const DEFAULT_TIER: HelpAssistantTier = "action";
const DEFAULT_DAINTREE_CONTROL = true;
const DEFAULT_DOC_SEARCH = true;
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
  mcpUrl: string | null;
  windowId: number;
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
  revoked: boolean;
}

interface SessionMeta {
  projectId: string;
  projectPath: string;
  lastUsedAt: number;
}

interface BundledClaudeSettings {
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  defaultMode?: string;
  enableAllProjectMcpServers?: boolean;
  [key: string]: unknown;
}

function deepClonePlainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function projectPathHash(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, PROJECT_HASH_LEN);
}

/**
 * Typed provision failure surfaced through the IPC layer with a structured
 * code so the renderer can match-and-display without parsing prose. Today
 * the only non-validation code is `MCP_NOT_READY` — used when Daintree
 * control is enabled but the in-process MCP server cannot be made ready,
 * which would otherwise launch the assistant with a broken MCP wiring.
 */
export class HelpSessionError extends Error {
  readonly code: "MCP_NOT_READY";
  constructor(code: "MCP_NOT_READY", message: string) {
    super(message);
    this.name = "HelpSessionError";
    this.code = code;
  }
}

export class HelpSessionService {
  private readonly sessionsByToken = new Map<string, HelpSessionRecord>();
  private readonly sessionsById = new Map<string, HelpSessionRecord>();
  // Per-project-path serialization — concurrent provisions for the same
  // project (e.g. two windows opening the assistant simultaneously) would
  // otherwise race the .mcp.json overwrite, producing a Claude instance
  // authenticating with the wrong session record.
  private readonly provisionLocks = new Map<string, Promise<void>>();
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
    return record.tier;
  }

  /**
   * Provisions the per-project session directory for the Daintree Assistant
   * under userData/help-sessions/<projectPathHash>/. The dir is reused across
   * launches so Claude Code's per-folder workspace-trust prompt only fires
   * once per project; the .mcp.json bearer is rotated on every provision.
   *
   * On every call:
   *   1. Copy the bundled help/ template into the dir (overwrites — picks up
   *      bundled-asset updates without losing the trust acceptance).
   *   2. Overwrite .mcp.json with a fresh literal-token Authorization header.
   *   3. Overlay .claude/settings.json with current `helpAssistant` settings.
   *   4. Stamp meta.json with the project identity for GC.
   */
  async provisionSession(input: ProvisionInput): Promise<ProvisionResult | null> {
    if (this.disposed) return null;
    this.validateProvisionInput(input);

    const helpFolder = getHelpFolderPath();
    if (!helpFolder) {
      console.warn("[HelpSessionService] Bundled help folder unavailable — cannot provision");
      return null;
    }

    const pathHash = projectPathHash(input.projectPath);
    const previous = this.provisionLocks.get(pathHash);
    let resolveLock!: () => void;
    const next = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    this.provisionLocks.set(
      pathHash,
      (previous ?? Promise.resolve()).then(() => next)
    );
    if (previous) await previous;

    try {
      return await this.doProvision(input, helpFolder, pathHash);
    } finally {
      resolveLock();
      // Drop the lock entry once it resolves so the map doesn't grow without
      // bound. Anyone awaiting `previous` already has the resolved promise.
      if (this.provisionLocks.get(pathHash) === next) {
        this.provisionLocks.delete(pathHash);
      }
    }
  }

  private async doProvision(
    input: ProvisionInput,
    helpFolder: string,
    pathHash: string
  ): Promise<ProvisionResult | null> {
    const settings = this.readSettings();
    const tier = this.resolveTier(settings.skipPermissions);
    const sessionId = randomUUID();
    const token = randomBytes(SESSION_TOKEN_BYTES).toString("hex");
    const sessionsRoot = this.getSessionsRoot();
    const sessionPath = path.join(sessionsRoot, pathHash);

    if (settings.daintreeControl) {
      try {
        await this.ensureMcpServerReady();
      } catch (err) {
        // Surface as a typed error the renderer can display verbatim. The
        // alternative (silently writing a `.mcp.json` without the daintree
        // entry and launching anyway) is exactly the silent-degrade path
        // the user observed and asked us to fix.
        const reason = formatErrorMessage(err, "in-process MCP server isn't ready");
        throw new HelpSessionError(
          "MCP_NOT_READY",
          `Daintree Assistant needs the in-process MCP server, but it isn't ready: ${reason}`
        );
      }
    }

    await fs.mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(sessionsRoot, 0o700).catch(() => {});
    // `force: true` is the default — overwrites existing files in the dir
    // with the bundled template, picking up any updates to CLAUDE.md /
    // settings baseline / etc. without losing Claude Code's per-folder trust
    // acceptance (which lives in ~/.claude.json, not here).
    await fs.cp(helpFolder, sessionPath, { recursive: true });
    await fs.chmod(sessionPath, 0o700).catch(() => {});

    const port = await this.getMcpPort(settings.daintreeControl);
    await this.writeMcpConfig(sessionPath, settings, port, token);
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
      revoked: false,
    };

    await this.writeSessionMeta(sessionPath, {
      projectId: input.projectId,
      projectPath: input.projectPath,
      lastUsedAt: now,
    });

    this.sessionsByToken.set(token, record);
    this.sessionsById.set(sessionId, record);

    const mcpUrl = settings.daintreeControl && port ? `http://127.0.0.1:${port}/sse` : null;
    return { sessionId, sessionPath, token, tier, mcpUrl, windowId: input.windowId };
  }

  /**
   * Invalidates the in-memory bearer for this session. The on-disk dir is
   * intentionally preserved across launches so the user's one-time Claude
   * Code workspace-trust acceptance for this project carries over to the
   * next assistant open — but the literal bearer is stripped from
   * `.mcp.json` so a `claude` started outside the help-panel flow (e.g. a
   * stray terminal `cd`-ed into the session dir) can't keep authenticating
   * against the now-revoked record. The next provision rewrites a fresh
   * entry into the same file.
   */
  async revokeSession(sessionId: string): Promise<void> {
    const record = this.sessionsById.get(sessionId);
    if (!record || record.revoked) return;
    record.revoked = true;
    this.sessionsById.delete(sessionId);
    this.sessionsByToken.delete(record.token);
    await this.stripStaleDaintreeMcpEntry(record.sessionPath);
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
   * Sweeps legacy per-launch session dirs left over from the old model
   * (UUID-named — no longer match the per-project path-hash naming). The
   * current per-project dirs persist indefinitely so the user's workspace-
   * trust acceptance carries across launches; we'll add a project-deletion
   * hook later when projects can be removed from Daintree.
   *
   * Project-hash dirs are kept, but their `.mcp.json` is checked for a
   * `daintree` entry whose Bearer token isn't in `sessionsByToken`. Tokens
   * never rehydrate across restarts, so any literal token left from a
   * previous boot is dead — strip it before a `claude` started in that
   * cwd (outside the help-panel flow) reads it and 401s.
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

    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(sessionsRoot, entry);
        if (this.isProjectHashDirName(entry)) {
          await this.stripStaleDaintreeMcpEntry(entryPath);
          return;
        }
        await this.removeSessionDir(entryPath);
      })
    );
  }

  dispose(): void {
    this.disposed = true;
    void this.revokeAll();
  }

  private isProjectHashDirName(name: string): boolean {
    return name.length === PROJECT_HASH_LEN && /^[0-9a-f]+$/.test(name);
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
    if (!path.isAbsolute(input.projectPath)) {
      throw new Error("projectPath must be absolute");
    }
    if (!Number.isInteger(input.windowId) || input.windowId < 0) {
      throw new Error("windowId must be a non-negative integer");
    }
    if (!Number.isInteger(input.projectViewWebContentsId) || input.projectViewWebContentsId < 0) {
      throw new Error("projectViewWebContentsId must be a non-negative integer");
    }
  }

  private readSettings(): {
    daintreeControl: boolean;
    docSearch: boolean;
    skipPermissions: boolean;
  } {
    const stored = (store.get("helpAssistant") as Record<string, unknown> | undefined) ?? {};
    return {
      daintreeControl:
        typeof stored.daintreeControl === "boolean"
          ? stored.daintreeControl
          : DEFAULT_DAINTREE_CONTROL,
      docSearch: typeof stored.docSearch === "boolean" ? stored.docSearch : DEFAULT_DOC_SEARCH,
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

  /**
   * Resolves once the in-process MCP server is bound and listening, OR
   * throws if it cannot be made ready. Daintree control on the assistant is
   * meaningless without a live MCP server, so we treat unreachable as a
   * hard launch failure rather than silently degrading the session.
   *
   * Defense-in-depth:
   *
   * - Force-enables the persisted `mcpServer.enabled` flag if it's off. The
   *   shipped defaults can ship `daintreeControl: true` alongside
   *   `mcpServer.enabled: false`, so a fresh install would otherwise hit
   *   this path with the server disabled and `start()` would silently
   *   no-op (`McpServerService.start()` early-returns when `!isEnabled()`).
   *   The IPC handler for `helpAssistant.setSettings` couples the toggle
   *   going forward; this handles boot.
   * - Wires the help-token validator on `McpServerService`. The deferred
   *   `mcp-server` task in `windowServices.ts` also wires this — but the
   *   renderer can call `provisionSession` before that task drains, so we
   *   register here too. The setter is idempotent.
   */
  private async ensureMcpServerReady(): Promise<void> {
    if (!this.mcpRegistry) {
      throw new Error("MCP registry not yet wired (app still initializing)");
    }
    const { mcpServerService } = await import("./McpServerService.js");
    mcpServerService.setHelpTokenValidator((token) => this.validateToken(token));
    if (!mcpServerService.isEnabled()) {
      // setEnabled() will only call start() internally if it has its own
      // `registry` already set — which it doesn't on cold boot if the
      // deferred `mcp-server` task hasn't drained yet. So we just persist
      // the enabled flag here and rely on the explicit start() below to
      // bind the server with our `mcpRegistry`.
      await mcpServerService.setEnabled(true);
    }
    if (!mcpServerService.isRunning) {
      await mcpServerService.start(this.mcpRegistry);
    }
    if (!mcpServerService.isRunning) {
      const snapshot = mcpServerService.getRuntimeState();
      throw new Error(
        snapshot.lastError ?? "MCP server is not running (state: " + snapshot.state + ")"
      );
    }
  }

  private async getMcpPort(daintreeControl: boolean): Promise<number | null> {
    if (!daintreeControl) return null;
    try {
      const { mcpServerService } = await import("./McpServerService.js");
      return mcpServerService.currentPort;
    } catch {
      return null;
    }
  }

  private async writeMcpConfig(
    sessionPath: string,
    settings: { daintreeControl: boolean; docSearch: boolean },
    port: number | null,
    token: string
  ): Promise<void> {
    const mcpServers: Record<string, unknown> = {};
    if (settings.docSearch) {
      mcpServers["daintree-docs"] = {
        type: "http",
        url: "https://daintree.org/api/mcp",
      };
    }
    if (settings.daintreeControl && port) {
      // Bake the literal token into the file rather than `${DAINTREE_MCP_TOKEN}`
      // substitution. Claude Code's env substitution in `headers` is broken
      // (sends the literal placeholder, gets 401). Same reason as
      // McpPaneConfigService.ts. The session dir is 0o700 and the file is
      // 0o600. Token rotates on every provision; the in-memory map is the
      // auth boundary, so the literal on disk is dead the moment its session
      // is revoked.
      mcpServers["daintree"] = {
        type: "sse",
        url: `http://127.0.0.1:${port}/sse`,
        headers: { Authorization: `Bearer ${token}` },
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
    settings: { daintreeControl: boolean; skipPermissions: boolean }
  ): Promise<void> {
    const bundledSettingsPath = path.join(bundledHelpFolder, ".claude", "settings.json");
    const baseline = await this.readBundledSettings(bundledSettingsPath);

    const merged = deepClonePlainJson(baseline);
    if (!merged.permissions) merged.permissions = {};
    if (!Array.isArray(merged.permissions.allow)) merged.permissions.allow = [];

    if (settings.daintreeControl && !merged.permissions.allow.includes("mcp__daintree__*")) {
      merged.permissions.allow.push("mcp__daintree__*");
    }

    // Auto-trust the project-scoped MCP servers we wrote into the session-dir
    // .mcp.json. Without this, Claude Code prompts the user to approve each
    // server interactively on first launch, which would block the assistant.
    merged.enableAllProjectMcpServers = true;

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

  private async writeSessionMeta(sessionPath: string, meta: SessionMeta): Promise<void> {
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

  /**
   * Removes the `daintree` MCP entry from `<sessionPath>/.mcp.json` if its
   * Bearer token isn't in `sessionsByToken`. Race-safe against a concurrent
   * provision: a fresh provision writes a *different* token which IS in
   * the map, so the "missing from map" check skips it.
   */
  private async stripStaleDaintreeMcpEntry(sessionPath: string): Promise<void> {
    const target = path.join(sessionPath, ".mcp.json");
    let raw: string;
    try {
      raw = await fs.readFile(target, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      console.warn(
        "[HelpSessionService] Failed to read .mcp.json for stale-token strip:",
        target,
        err
      );
      return;
    }
    let parsed: { mcpServers?: Record<string, unknown> };
    try {
      parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    } catch {
      return;
    }
    const servers = parsed.mcpServers;
    if (!servers || typeof servers !== "object") return;
    const entry = servers["daintree"] as { headers?: { Authorization?: string } } | undefined;
    if (!entry) return;
    const auth = entry.headers?.Authorization ?? "";
    const match = /^Bearer\s+(.+)$/.exec(auth);
    const token = match?.[1]?.trim();
    if (token && this.sessionsByToken.has(token)) return;

    delete servers["daintree"];
    try {
      await resilientAtomicWriteFile(target, JSON.stringify(parsed, null, 2) + "\n", "utf-8", {
        mode: 0o600,
      });
    } catch (err) {
      console.warn(
        "[HelpSessionService] Failed to strip stale daintree entry from .mcp.json:",
        target,
        err
      );
    }
  }
}

export const helpSessionService = new HelpSessionService();
