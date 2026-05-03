import { ipcMain } from "electron";
import type { WindowRegistry } from "../window/WindowRegistry.js";
import { getProjectViewManager } from "../window/windowRef.js";
import http from "node:http";
import net from "node:net";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ActionManifestEntry, ActionDispatchResult } from "../../shared/types/actions.js";
import {
  type McpAuditRecord,
  type McpAuditResult,
  type McpConfirmationDecision,
  MCP_AUDIT_DEFAULT_MAX_RECORDS,
  MCP_AUDIT_MAX_RECORDS,
  MCP_AUDIT_MIN_RECORDS,
} from "../../shared/types/ipc/mcpServer.js";
import type { HelpAssistantTier } from "../../shared/types/ipc/maps.js";

export type McpAuthClass = "external" | HelpAssistantTier;
export type HelpTokenValidator = (token: string) => HelpAssistantTier | false;
import { store } from "../store.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { summarizeMcpArgs } from "../../shared/utils/mcpArgsSummary.js";
import { mcpPaneConfigService } from "./McpPaneConfigService.js";

const MCP_SERVER_KEY = "daintree";

const DEFAULT_PORT = 45454;
const MAX_PORT_RETRIES = 10;
const MCP_SSE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

const AUDIT_FLUSH_DEBOUNCE_MS = 2000;
const CONFIRMATION_REQUIRED_CODE = "CONFIRMATION_REQUIRED";
const USER_REJECTED_CODE = "USER_REJECTED";
const CONFIRMATION_TIMEOUT_CODE = "CONFIRMATION_TIMEOUT";

const OPEN_WORLD_CATEGORIES: ReadonlySet<string> = new Set([
  "browser",
  "devServer",
  "github",
  "portal",
  "voice",
  "system",
]);

/**
 * Source-tier classification for an authenticated MCP connection. Each
 * connection is stamped with a tier at session-creation time and that tier
 * gates every `CallTool` and `ListTools` request for the session's
 * lifetime. Tiers are strictly nested: `workbench ⊂ action ⊂ system`, with
 * `external` carrying its own legacy curated allowlist for backward
 * compatibility with the pre-tier user-facing server.
 *
 * - `workbench` — read-only Daintree introspection (queries, file/diff
 *   reads, listings). The default for project agents that opt in.
 * - `action` — workbench plus non-destructive mutations (create worktree,
 *   run recipe, inject text into a terminal, panel manipulation). Default
 *   for the help assistant.
 * - `system` — action plus destructive operations (delete worktree, send
 *   raw terminal commands, git mutations, agent.launch). Reserved for
 *   "skip permissions" or explicitly-elevated external clients.
 * - `external` — today's curated allowlist, tied to the global apiKey.
 */
export type McpTier = "workbench" | "action" | "system" | "external";

/**
 * Workbench tier — read-only introspection and queries. No mutations, no
 * external network side effects. Walks of the action manifest filtered by
 * `kind: "query"` plus a small set of safe-to-read commands.
 */
const WORKBENCH_TOOLS: ReadonlySet<string> = new Set([
  "actions.list",
  "actions.getContext",

  "project.getAll",
  "project.getCurrent",
  "project.getSettings",
  "project.getStats",
  "project.detectRunners",

  "worktree.list",
  "worktree.getCurrent",
  "worktree.listBranches",
  "worktree.getDefaultPath",
  "worktree.getAvailableBranch",
  "worktree.resource.status",

  "files.search",
  "file.view",

  "copyTree.isAvailable",
  "copyTree.generate",

  "terminal.list",
  "terminal.getOutput",

  "slashCommands.list",

  "git.getProjectPulse",
  "git.getFileDiff",
  "git.listCommits",
  "git.getStagingStatus",
  "git.snapshotGet",
  "git.snapshotList",

  "github.checkCli",
  "github.getRepoStats",
  "github.listIssues",
  "github.listPullRequests",

  "system.checkCommand",
  "system.checkDirectory",
]);

/**
 * Action tier additions — non-destructive mutations layered on top of
 * workbench. Creates resources, spawns terminals/agents, drives those
 * terminals via injected context or sent commands, and trashes terminals
 * (which the user can restore from the dock). Does not permanently kill
 * terminals, delete worktrees, commit/push git state, or open external
 * GitHub URLs.
 */
const ACTION_TIER_ADDONS: ReadonlySet<string> = new Set([
  "worktree.create",
  "worktree.createWithRecipe",
  "worktree.setActive",
  "worktree.refresh",

  "terminal.inject",
  "terminal.new",
  "terminal.sendCommand",
  "terminal.bulkCommand",
  "terminal.close",
  "terminal.closeAll",

  "recipe.list",
  "recipe.run",

  "copyTree.injectToTerminal",
  "copyTree.generateAndCopyFile",

  "file.openInEditor",

  "agent.launch",
  "agent.terminal",
  "agent.focusNextWaiting",
  "agent.focusNextWorking",
]);

/**
 * System tier additions — destructive or externally-visible operations layered
 * on top of action. Includes permanently killing terminals (cannot be undone),
 * deleting worktrees, mutating git state, and opening external GitHub URLs.
 */
const SYSTEM_TIER_ADDONS: ReadonlySet<string> = new Set([
  "worktree.delete",

  "terminal.kill",
  "terminal.killAll",

  "git.stageFile",
  "git.unstageFile",
  "git.stageAll",
  "git.unstageAll",
  "git.commit",
  "git.push",
  "git.snapshotRevert",
  "git.snapshotDelete",

  "github.openIssue",
  "github.openPR",
]);

function unionSet(...sets: ReadonlySet<string>[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const set of sets) {
    for (const value of set) out.add(value);
  }
  return out;
}

// External tier — curated set of action IDs advertised over MCP for the
// legacy user-facing server. Keeps the tool surface small enough for
// `tool_choice: "auto"` reliability and bounded token cost while still
// covering the agent-facing introspection, query, and command actions.
// Power users opt into the full surface via `mcpServer.fullToolSurface =
// true`. Tier-gated dispatch enforces this list at CallTool time — a
// caller that knows an action ID outside this set will receive a
// `TIER_NOT_PERMITTED` rejection.
const MCP_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  "actions.list",
  "actions.getContext",

  "agent.launch",
  "agent.terminal",
  "agent.focusNextWaiting",
  "agent.focusNextWorking",

  "git.getProjectPulse",
  "git.getFileDiff",
  "git.listCommits",
  "git.getStagingStatus",
  "git.stageFile",
  "git.unstageFile",
  "git.stageAll",
  "git.unstageAll",
  "git.commit",
  "git.push",
  "git.snapshotGet",
  "git.snapshotList",

  "github.checkCli",
  "github.getRepoStats",
  "github.listIssues",
  "github.listPullRequests",
  "github.openIssue",
  "github.openPR",

  "terminal.list",
  "terminal.getOutput",
  "terminal.sendCommand",
  "terminal.bulkCommand",
  "terminal.inject",
  "terminal.new",

  "worktree.list",
  "worktree.getCurrent",
  "worktree.refresh",
  "worktree.create",
  "worktree.createWithRecipe",
  "worktree.listBranches",
  "worktree.getDefaultPath",
  "worktree.getAvailableBranch",
  "worktree.delete",
  "worktree.setActive",
  "worktree.resource.status",

  "files.search",
  "file.view",
  "file.openInEditor",

  "copyTree.isAvailable",
  "copyTree.generate",
  "copyTree.generateAndCopyFile",
  "copyTree.injectToTerminal",

  "slashCommands.list",

  "project.getAll",
  "project.getCurrent",
  "project.getSettings",
  "project.getStats",
  "project.detectRunners",

  "recipe.list",
  "recipe.run",

  "system.checkCommand",
  "system.checkDirectory",
]);

/**
 * Per-tier allowlist of action IDs. Tiers are additive: `action` is the
 * union of `workbench` plus its addons; `system` adds further on top of
 * `action`. Callers should treat these as the authoritative gate for both
 * `ListTools` filtering and `CallTool` dispatch. `external` is intentionally
 * NOT a superset of `system` — it tracks the legacy curated allowlist so
 * existing apiKey clients keep seeing the same tools they always have.
 */
const TIER_ALLOWLISTS: Readonly<Record<McpTier, ReadonlySet<string>>> = {
  workbench: WORKBENCH_TOOLS,
  action: unionSet(WORKBENCH_TOOLS, ACTION_TIER_ADDONS),
  system: unionSet(WORKBENCH_TOOLS, ACTION_TIER_ADDONS, SYSTEM_TIER_ADDONS),
  external: MCP_TOOL_ALLOWLIST,
};

const TIER_NOT_PERMITTED_CODE = "TIER_NOT_PERMITTED";

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  webContentsId: number;
  destroyedCleanup?: () => void;
}

/**
 * Renderer-supplied envelope for dispatch responses. Wraps the canonical
 * `ActionDispatchResult` and carries an optional `confirmationDecision`
 * when the renderer surfaced a `danger: "confirm"` modal — this lets the
 * audit log capture per-decision outcomes without main having to inspect
 * action metadata it does not own.
 */
interface DispatchEnvelope {
  result: ActionDispatchResult;
  confirmationDecision?: McpConfirmationDecision;
}

interface McpSseSession {
  transport: SSEServerTransport;
  idleTimer: ReturnType<typeof setTimeout>;
}

interface McpHttpSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  idleTimer: ReturnType<typeof setTimeout>;
}

function safeSerializeToolResult(value: unknown): string {
  const seen = new WeakSet<object>();

  try {
    const serialized = JSON.stringify(
      value,
      (_key, currentValue) => {
        if (typeof currentValue === "bigint") {
          return currentValue.toString();
        }
        if (typeof currentValue === "symbol") {
          return currentValue.toString();
        }
        if (typeof currentValue === "function") {
          return `[Function: ${currentValue.name || "anonymous"}]`;
        }
        if (currentValue instanceof Error) {
          return {
            name: currentValue.name,
            message: currentValue.message,
            stack: currentValue.stack,
          };
        }
        if (currentValue !== null && typeof currentValue === "object") {
          if (seen.has(currentValue)) {
            return "[Circular]";
          }
          seen.add(currentValue);
        }
        return currentValue;
      },
      2
    );

    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Fall through to string coercion.
  }

  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

export class McpServerService {
  private httpServer: http.Server | null = null;
  private port: number | null = null;
  private registry: WindowRegistry | null = null;
  private startPromise: Promise<void> | null = null;
  private sessions = new Map<string, McpSseSession>();
  private httpSessions = new Map<string, McpHttpSession>();
  /**
   * Authoritative session-id → tier map used by both transports. Written
   * when a new SSE or HTTP session is created (after the request has
   * already passed `isAuthorized`) and read inside the `CallTool` /
   * `ListTools` handlers via `getSessionTier`. Cleared in the matching
   * `transport.onclose` and idle-eviction paths.
   */
  private sessionTierMap = new Map<string, McpTier>();
  private pendingManifests = new Map<string, PendingRequest<ActionManifestEntry[]>>();
  private pendingDispatches = new Map<string, PendingRequest<DispatchEnvelope>>();
  private cleanupListeners: Array<() => void> = [];
  private statusListeners = new Set<(running: boolean) => void>();
  private auditRecords: McpAuditRecord[] = [];
  private auditFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private auditHydrated = false;
  /**
   * Bearer token for the global MCP server. Persisted in electron-store under
   * `mcpServer.apiKey`. Initialized in `start()` (hydrate-from-store or
   * generate-fresh-and-persist) and replaced by `rotateApiKey()`. Always
   * non-empty once the server is running.
   */
  private apiKey: string | null = null;
  /**
   * Single-flight guard for `rotateApiKey()`. Without it, two parallel calls
   * could each capture the same `previousKey`, both overwrite `this.apiKey`,
   * and the first caller would receive a key that has already been
   * superseded — so the UI would show a key that doesn't authenticate.
   */
  private rotateInFlight: Promise<string> | null = null;
  private helpTokenValidator: HelpTokenValidator | null = null;

  get isRunning(): boolean {
    return this.httpServer !== null && this.port !== null;
  }

  /**
   * Register a subscriber that fires whenever the server transitions between
   * running and stopped. Used by `ServiceConnectivityRegistry` to surface MCP
   * reachability without polling.
   */
  onStatusChange(listener: (running: boolean) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /**
   * Register a callback that resolves help-session bearer tokens to a tier.
   * Wired by `HelpSessionService` so requests carrying a Daintree-issued
   * per-session token authenticate alongside the long-lived external API key.
   */
  setHelpTokenValidator(validator: HelpTokenValidator | null): void {
    this.helpTokenValidator = validator;
  }

  private emitStatusChange(): void {
    const running = this.isRunning;
    for (const listener of this.statusListeners) {
      try {
        listener(running);
      } catch (err) {
        console.error("[MCP] Status change listener threw:", err);
      }
    }
  }

  get currentPort(): number | null {
    return this.port;
  }

  private getConfig() {
    return store.get("mcpServer");
  }

  /**
   * Persist a config patch without dropping the in-memory audit log. Every
   * config-mutation method must route through here so `setEnabled`,
   * `setPort`, etc. don't clobber `auditLog` on disk by writing back a
   * spread of the live config minus the in-memory ring buffer.
   */
  private persistConfig(patch: Partial<ReturnType<typeof this.getConfig>>): void {
    const current = this.getConfig();
    store.set("mcpServer", {
      ...current,
      ...patch,
      auditLog: this.auditHydrated ? this.auditRecords : current.auditLog,
    });
  }

  isEnabled(): boolean {
    return this.getConfig().enabled;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.persistConfig({ enabled });
    if (enabled && this.registry && !this.isRunning) {
      await this.start(this.registry);
    } else if (!enabled && this.isRunning) {
      await this.stop();
    }
  }

  async setPort(port: number | null): Promise<void> {
    const wasEnabled = this.getConfig().enabled;
    this.persistConfig({ port });
    if (wasEnabled && this.isRunning) {
      await this.stop();
      if (this.registry) await this.start(this.registry);
    }
  }

  /**
   * Mint a fresh bearer token and persist it to electron-store. On store-write
   * failure the in-memory key is rolled back so the previous bearer remains
   * authoritative for in-flight requests. Local-loopback only — clients use
   * the new key on their next request; no server restart needed. External
   * clients holding the old key in their own config break and must re-paste
   * the new bearer from Settings. Single-flight: parallel callers share the
   * same in-flight promise and receive the same returned key.
   */
  async rotateApiKey(): Promise<string> {
    if (this.rotateInFlight) return this.rotateInFlight;
    const promise = (async (): Promise<string> => {
      const newKey = `daintree_${randomUUID().replace(/-/g, "")}`;
      const previousKey = this.apiKey;
      this.apiKey = newKey;
      try {
        this.persistConfig({ apiKey: newKey });
      } catch (err) {
        this.apiKey = previousKey;
        throw err;
      }
      return newKey;
    })();
    this.rotateInFlight = promise;
    try {
      return await promise;
    } finally {
      this.rotateInFlight = null;
    }
  }

  /**
   * Hydrate the in-memory ring buffer from the persisted store. Idempotent —
   * subsequent calls are no-ops so tests and callers can invoke it freely.
   * Trims to the current `auditMaxRecords` cap on load so a shrunk cap takes
   * effect immediately.
   */
  private hydrateAuditLog(): void {
    if (this.auditHydrated) return;
    const config = this.getConfig();
    const persisted = Array.isArray(config.auditLog) ? config.auditLog : [];
    const cap = this.normalizeAuditMaxRecords(config.auditMaxRecords);
    this.auditRecords =
      persisted.length > cap ? persisted.slice(persisted.length - cap) : [...persisted];
    this.auditHydrated = true;
  }

  private normalizeAuditMaxRecords(value: unknown): number {
    const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : NaN;
    if (!Number.isFinite(n)) return MCP_AUDIT_DEFAULT_MAX_RECORDS;
    if (n < MCP_AUDIT_MIN_RECORDS) return MCP_AUDIT_MIN_RECORDS;
    if (n > MCP_AUDIT_MAX_RECORDS) return MCP_AUDIT_MAX_RECORDS;
    return n;
  }

  private classifyDispatchResult(
    outcome:
      | { kind: "result"; value: ActionDispatchResult }
      | { kind: "throw"; error: unknown }
      | { kind: "unauthorized" }
  ): { result: McpAuditResult; errorCode?: string } {
    if (outcome.kind === "throw") {
      return { result: "error", errorCode: "DISPATCH_THREW" };
    }
    if (outcome.kind === "unauthorized") {
      return { result: "unauthorized", errorCode: TIER_NOT_PERMITTED_CODE };
    }
    const value = outcome.value;
    if (value.ok) return { result: "success" };
    if (value.error.code === CONFIRMATION_REQUIRED_CODE) {
      return { result: "confirmation-pending", errorCode: value.error.code };
    }
    return { result: "error", errorCode: value.error.code };
  }

  /**
   * Resolve the confirmation decision stored alongside an audit record.
   * Trusts the renderer-supplied hint for `"approved"` (the only case main
   * cannot infer — a successful dispatch may be a directly-authorized agent
   * call or a modal-approved one), but always derives `"rejected"` and
   * `"timeout"` from the canonical error codes so a renderer that forgets
   * to set the hint still gets the right outcome recorded.
   */
  private deriveConfirmationDecision(
    outcome:
      | { kind: "result"; value: ActionDispatchResult }
      | { kind: "throw"; error: unknown }
      | { kind: "unauthorized" },
    hint: McpConfirmationDecision | undefined
  ): McpConfirmationDecision | undefined {
    if (outcome.kind === "result" && !outcome.value.ok) {
      if (outcome.value.error.code === USER_REJECTED_CODE) return "rejected";
      if (outcome.value.error.code === CONFIRMATION_TIMEOUT_CODE) return "timeout";
    }
    if (hint === "approved" && outcome.kind === "result" && outcome.value.ok) {
      return "approved";
    }
    return undefined;
  }

  private appendAuditRecord(input: {
    toolId: string;
    sessionId: string;
    tier: McpTier;
    args: unknown;
    durationMs: number;
    outcome:
      | { kind: "result"; value: ActionDispatchResult }
      | { kind: "throw"; error: unknown }
      | { kind: "unauthorized" };
    confirmationDecision?: McpConfirmationDecision;
  }): void {
    // `=== false` so legacy persisted configs (undefined) default to enabled,
    // matching `getAuditConfig()`. A bare `!auditEnabled` would silently drop
    // every record for any user whose store predates this feature.
    if (this.getConfig().auditEnabled === false) return;
    this.hydrateAuditLog();

    const classification = this.classifyDispatchResult(input.outcome);
    const decision = this.deriveConfirmationDecision(input.outcome, input.confirmationDecision);
    const record: McpAuditRecord = {
      id: randomUUID(),
      timestamp: Date.now(),
      toolId: input.toolId,
      sessionId: input.sessionId,
      tier: input.tier,
      argsSummary: summarizeMcpArgs(input.args),
      result: classification.result,
      durationMs: Math.max(0, Math.round(input.durationMs)),
    };
    if (classification.errorCode !== undefined) {
      record.errorCode = classification.errorCode;
    }
    if (decision !== undefined) {
      record.confirmationDecision = decision;
    }

    this.auditRecords.push(record);
    const cap = this.normalizeAuditMaxRecords(this.getConfig().auditMaxRecords);
    if (this.auditRecords.length > cap) {
      this.auditRecords.splice(0, this.auditRecords.length - cap);
    }
    this.scheduleAuditFlush();
  }

  private scheduleAuditFlush(): void {
    if (this.auditFlushTimer) return;
    this.auditFlushTimer = setTimeout(() => {
      this.auditFlushTimer = null;
      this.flushAuditLog();
    }, AUDIT_FLUSH_DEBOUNCE_MS);
    this.auditFlushTimer.unref?.();
  }

  private flushAuditLog(): void {
    if (!this.auditHydrated) return;
    try {
      this.persistConfig({});
    } catch (err) {
      console.error("[MCP] Failed to flush audit log:", err);
    }
  }

  /** Cancel any pending debounce and persist the buffer immediately. */
  private flushAuditLogNow(): void {
    if (this.auditFlushTimer) {
      clearTimeout(this.auditFlushTimer);
      this.auditFlushTimer = null;
    }
    this.flushAuditLog();
  }

  /** Read the persisted ring buffer (newest first). */
  getAuditRecords(): McpAuditRecord[] {
    this.hydrateAuditLog();
    return [...this.auditRecords].reverse();
  }

  /** Read the persisted audit-log configuration as the renderer sees it. */
  getAuditConfig(): { enabled: boolean; maxRecords: number } {
    const config = this.getConfig();
    return {
      enabled: config.auditEnabled !== false,
      maxRecords: this.normalizeAuditMaxRecords(config.auditMaxRecords),
    };
  }

  /** Empty the buffer and persist the change synchronously. */
  clearAuditLog(): void {
    this.hydrateAuditLog();
    this.auditRecords = [];
    this.flushAuditLogNow();
  }

  /** Toggle capture without dropping existing records. */
  setAuditEnabled(enabled: boolean): { enabled: boolean; maxRecords: number } {
    this.hydrateAuditLog();
    this.persistConfig({ auditEnabled: enabled });
    return this.getAuditConfig();
  }

  /** Update the ring-buffer cap; trims and flushes immediately if it shrunk. */
  setAuditMaxRecords(max: number): { enabled: boolean; maxRecords: number } {
    this.hydrateAuditLog();
    const normalized = this.normalizeAuditMaxRecords(max);
    if (this.auditRecords.length > normalized) {
      this.auditRecords.splice(0, this.auditRecords.length - normalized);
    }
    this.persistConfig({ auditMaxRecords: normalized });
    this.flushAuditLogNow();
    return this.getAuditConfig();
  }

  async start(registry: WindowRegistry): Promise<void> {
    this.registry = registry;

    if (this.httpServer) {
      return;
    }

    // Single-flight: concurrent `start()` callers (e.g., the deferred startup
    // task and a help-session provision that races it) must await the same
    // bind so subsequent reads of `currentPort` see the bound value rather
    // than the pre-bind `null`. Without this, a second provision called while
    // the first is mid-bind would early-return and bake `port: null` into its
    // .mcp.json, silently dropping the daintree MCP server from that session.
    if (this.startPromise) {
      return this.startPromise;
    }

    if (!this.isEnabled()) {
      console.log("[MCP] Server disabled — skipping start");
      return;
    }

    this.startPromise = (async () => {
      try {
        if (!this.apiKey) {
          const persisted = this.getConfig().apiKey;
          if (persisted && persisted.length > 0) {
            this.apiKey = persisted;
          } else {
            this.apiKey = `daintree_${randomUUID().replace(/-/g, "")}`;
            this.persistConfig({ apiKey: this.apiKey });
          }
        }

        this.hydrateAuditLog();
        this.setupIpcListeners();

        const server = http.createServer((req, res) => {
          this.handleRequest(req, res).catch((err) => {
            console.error("[MCP] Request handler error:", err);
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "text/plain" });
              res.end("Internal server error");
            }
          });
        });

        const configuredPort = this.getConfig().port ?? DEFAULT_PORT;
        const boundPort = await this.listenWithRetry(server, configuredPort);

        if (boundPort === null) {
          for (const cleanup of this.cleanupListeners) {
            cleanup();
          }
          this.cleanupListeners = [];
          throw new Error(
            `Failed to bind MCP server: ports ${configuredPort}–${configuredPort + MAX_PORT_RETRIES} all in use`
          );
        }

        this.port = boundPort;
        this.httpServer = server;
        console.log(
          `[MCP] Server started on http://127.0.0.1:${this.port}/mcp (Streamable HTTP) and /sse (legacy SSE)`
        );
        this.emitStatusChange();
      } finally {
        this.startPromise = null;
      }
    })();

    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.flushAuditLogNow();

    for (const session of this.sessions.values()) {
      clearTimeout(session.idleTimer);
      try {
        await session.transport.close();
      } catch {
        // ignore close errors during shutdown
      }
    }
    this.sessions.clear();

    for (const session of this.httpSessions.values()) {
      clearTimeout(session.idleTimer);
      try {
        await session.transport.close();
      } catch {
        // ignore close errors during shutdown
      }
    }
    this.httpSessions.clear();
    this.sessionTierMap.clear();

    for (const cleanup of this.cleanupListeners) {
      cleanup();
    }
    this.cleanupListeners = [];

    for (const [id, pending] of this.pendingManifests) {
      clearTimeout(pending.timer);
      pending.destroyedCleanup?.();
      pending.reject(new Error("MCP server stopped"));
      this.pendingManifests.delete(id);
    }
    for (const [id, pending] of this.pendingDispatches) {
      clearTimeout(pending.timer);
      pending.destroyedCleanup?.();
      pending.reject(new Error("MCP server stopped"));
      this.pendingDispatches.delete(id);
    }

    let wasRunning = false;
    if (this.httpServer) {
      wasRunning = true;
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
      this.port = null;
    }

    console.log("[MCP] Server stopped");
    if (wasRunning) {
      this.emitStatusChange();
    }
  }

  getStatus(): {
    enabled: boolean;
    port: number | null;
    configuredPort: number | null;
    apiKey: string;
  } {
    const config = this.getConfig();
    return {
      enabled: config.enabled,
      port: this.port,
      configuredPort: config.port,
      apiKey: this.apiKey ?? "",
    };
  }

  getConfigSnippet(): string {
    const url = this.port ? `http://127.0.0.1:${this.port}/mcp` : "http://127.0.0.1:<port>/mcp";
    const entry: Record<string, unknown> = { type: "http", url };
    if (this.apiKey) {
      entry.headers = { Authorization: `Bearer ${this.apiKey}` };
    }
    return JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: entry } }, null, 2);
  }

  private async listenWithRetry(server: http.Server, startPort: number): Promise<number | null> {
    for (let attempt = 0; attempt <= MAX_PORT_RETRIES; attempt++) {
      const port = startPort + attempt;
      if (port > 65535) break;

      const available = await this.isPortAvailable(port);
      if (!available) {
        console.log(`[MCP] Port ${port} in use, trying next…`);
        continue;
      }

      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error) => {
            server.removeListener("error", onError);
            reject(err);
          };
          server.on("error", onError);
          server.listen(port, "127.0.0.1", () => {
            server.removeListener("error", onError);
            resolve();
          });
        });
        const addr = server.address() as AddressInfo | null;
        return addr?.port ?? null;
      } catch {
        console.log(`[MCP] Port ${port} bind failed, trying next…`);
        continue;
      }
    }
    return null;
  }

  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const tester = net.createServer();
      tester.once("error", () => resolve(false));
      tester.listen(port, "127.0.0.1", () => {
        tester.close(() => resolve(true));
      });
    });
  }

  private setupIpcListeners(): void {
    const manifestHandler = (
      event: Electron.IpcMainEvent,
      payload: { requestId: string; manifest: unknown }
    ) => {
      if (!payload || typeof payload.requestId !== "string") return;
      const pending = this.pendingManifests.get(payload.requestId);
      if (!pending) return;
      if (event.sender.id !== pending.webContentsId) {
        console.warn(
          `[MCP] Ignoring manifest response from unexpected sender ${event.sender.id} (expected ${pending.webContentsId}, requestId=${payload.requestId})`
        );
        return;
      }
      clearTimeout(pending.timer);
      pending.destroyedCleanup?.();
      this.pendingManifests.delete(payload.requestId);
      pending.resolve(
        Array.isArray(payload.manifest) ? (payload.manifest as ActionManifestEntry[]) : []
      );
    };

    const dispatchHandler = (
      event: Electron.IpcMainEvent,
      payload: {
        requestId: string;
        result: ActionDispatchResult;
        confirmationDecision?: McpConfirmationDecision;
      }
    ) => {
      if (!payload || typeof payload.requestId !== "string") return;
      const pending = this.pendingDispatches.get(payload.requestId);
      if (!pending) return;
      if (event.sender.id !== pending.webContentsId) {
        console.warn(
          `[MCP] Ignoring dispatch response from unexpected sender ${event.sender.id} (expected ${pending.webContentsId}, requestId=${payload.requestId})`
        );
        return;
      }
      clearTimeout(pending.timer);
      pending.destroyedCleanup?.();
      this.pendingDispatches.delete(payload.requestId);
      pending.resolve({
        result: payload.result,
        confirmationDecision: payload.confirmationDecision,
      });
    };

    ipcMain.on("mcp:get-manifest-response", manifestHandler);
    ipcMain.on("mcp:dispatch-action-response", dispatchHandler);

    this.cleanupListeners.push(
      () => ipcMain.removeListener("mcp:get-manifest-response", manifestHandler),
      () => ipcMain.removeListener("mcp:dispatch-action-response", dispatchHandler)
    );
  }

  private requestManifest(): Promise<ActionManifestEntry[]> {
    return new Promise((resolve, reject) => {
      let webContents: Electron.WebContents;
      try {
        webContents = this.getActiveProjectWebContents();
      } catch (err) {
        reject(this.normalizeError(err, "MCP renderer bridge unavailable"));
        return;
      }

      const requestId = randomUUID();
      const webContentsId = webContents.id;
      const timer = setTimeout(() => {
        const pending = this.pendingManifests.get(requestId);
        pending?.destroyedCleanup?.();
        this.pendingManifests.delete(requestId);
        reject(new Error("Manifest request timed out"));
      }, 5000);

      const onDestroyed = () => {
        const pending = this.pendingManifests.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingManifests.delete(requestId);
        pending.reject(new Error("MCP renderer bridge destroyed"));
      };
      webContents.once("destroyed", onDestroyed);
      const destroyedCleanup = () => {
        try {
          webContents.removeListener("destroyed", onDestroyed);
        } catch {
          // best-effort cleanup; webContents may already be gone
        }
      };

      this.pendingManifests.set(requestId, {
        resolve,
        reject,
        timer,
        webContentsId,
        destroyedCleanup,
      });

      try {
        webContents.send("mcp:get-manifest-request", { requestId });
      } catch (err) {
        clearTimeout(timer);
        destroyedCleanup();
        this.pendingManifests.delete(requestId);
        reject(this.normalizeError(err, "Failed to request action manifest"));
      }
    });
  }

  private dispatchAction(
    actionId: string,
    args: unknown,
    confirmed = false
  ): Promise<DispatchEnvelope> {
    return new Promise((resolve, reject) => {
      let webContents: Electron.WebContents;
      try {
        webContents = this.getActiveProjectWebContents();
      } catch (err) {
        reject(this.normalizeError(err, "MCP renderer bridge unavailable"));
        return;
      }

      const requestId = randomUUID();
      const webContentsId = webContents.id;
      const timer = setTimeout(() => {
        const pending = this.pendingDispatches.get(requestId);
        pending?.destroyedCleanup?.();
        this.pendingDispatches.delete(requestId);
        reject(new Error(`Action dispatch timed out: ${actionId}`));
      }, 30000);

      const onDestroyed = () => {
        const pending = this.pendingDispatches.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingDispatches.delete(requestId);
        pending.reject(new Error("MCP renderer bridge destroyed"));
      };
      webContents.once("destroyed", onDestroyed);
      const destroyedCleanup = () => {
        try {
          webContents.removeListener("destroyed", onDestroyed);
        } catch {
          // best-effort cleanup; webContents may already be gone
        }
      };

      this.pendingDispatches.set(requestId, {
        resolve,
        reject,
        timer,
        webContentsId,
        destroyedCleanup,
      });

      try {
        webContents.send("mcp:dispatch-action-request", {
          requestId,
          actionId,
          args,
          confirmed,
        });
      } catch (err) {
        clearTimeout(timer);
        destroyedCleanup();
        this.pendingDispatches.delete(requestId);
        reject(this.normalizeError(err, `Failed to dispatch action: ${actionId}`));
      }
    });
  }

  private createSessionServer(sessionId: string): Server {
    const server = new Server(
      { name: "Daintree", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const manifest = await this.requestManifest();
      const tier = this.getSessionTier(sessionId);
      return {
        tools: manifest
          .filter((entry) => this.shouldExposeTool(entry, tier))
          .map((entry) => ({
            name: entry.id,
            description: this.buildToolDescription(entry),
            inputSchema: this.buildToolInputSchema(entry),
            annotations: this.buildAnnotations(entry),
          })),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const actionId = request.params.name;
      const { args, confirmed } = this.parseToolArguments(request.params.arguments);
      const startedAt = Date.now();
      const tier = this.getSessionTier(sessionId);

      if (!this.isTierPermitted(tier, actionId)) {
        try {
          this.appendAuditRecord({
            toolId: actionId,
            sessionId,
            tier,
            args,
            durationMs: Date.now() - startedAt,
            outcome: { kind: "unauthorized" },
          });
        } catch (err) {
          console.error("[MCP] Failed to append audit record:", err);
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Error [${TIER_NOT_PERMITTED_CODE}]: action '${actionId}' is not permitted for the '${tier}' tier.`,
            },
          ],
          isError: true,
        };
      }

      let outcome:
        | { kind: "result"; value: ActionDispatchResult }
        | { kind: "throw"; error: unknown };
      let confirmationDecision: McpConfirmationDecision | undefined;

      try {
        try {
          const envelope = await this.dispatchAction(actionId, args, confirmed);
          outcome = { kind: "result", value: envelope.result };
          confirmationDecision = envelope.confirmationDecision;
        } catch (err) {
          outcome = { kind: "throw", error: err };
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: ${formatErrorMessage(err, "Action dispatch failed")}`,
              },
            ],
            isError: true,
          };
        }

        if (outcome.value.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  outcome.value.result !== undefined && outcome.value.result !== null
                    ? safeSerializeToolResult(outcome.value.result)
                    : "OK",
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Error [${outcome.value.error.code}]: ${outcome.value.error.message}`,
            },
          ],
          isError: true,
        };
      } finally {
        try {
          this.appendAuditRecord({
            toolId: actionId,
            sessionId,
            tier,
            args,
            durationMs: Date.now() - startedAt,
            outcome: outcome!,
            confirmationDecision,
          });
        } catch (err) {
          console.error("[MCP] Failed to append audit record:", err);
        }
      }
    });

    return server;
  }

  private isValidHost(req: http.IncomingMessage): boolean {
    const host = req.headers.host ?? "";
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const apiKey = this.apiKey;
    const auth = req.headers.authorization ?? "";

    if (apiKey) {
      const expected = `Bearer ${apiKey}`;
      const actualHash = createHash("sha256").update(auth).digest();
      const expectedHash = createHash("sha256").update(expected).digest();
      if (timingSafeEqual(actualHash, expectedHash)) return true;
    } else if (auth.length === 0) {
      // No global key configured and no Authorization header sent — legacy permissive path.
      return true;
    }

    // Per-pane bearer token (minted at PTY spawn, revoked on exit).
    if (auth.startsWith("Bearer ")) {
      const token = auth.slice("Bearer ".length);
      if (mcpPaneConfigService.isValidPaneToken(token)) return true;
    }

    // Help-session bearer token (minted at provisioning, revoked on panel close / app shutdown).
    if (this.helpTokenValidator) {
      const match = /^Bearer\s+(.+)$/.exec(auth);
      const token = match?.[1]?.trim();
      if (token) {
        const tier = this.helpTokenValidator(token);
        if (tier) return true;
      }
    }

    return false;
  }

  private isValidOrigin(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    return origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}`;
  }

  /**
   * Returns true if the entry should be advertised to a session at the
   * given tier. `restricted` actions are never advertised regardless of
   * tier. `fullToolSurface` widens the surface only for the `external`
   * tier — tier allowlists are security boundaries for the other tiers,
   * not convenience filters that can be opted out of.
   */
  private shouldExposeTool(entry: ActionManifestEntry, tier: McpTier): boolean {
    if (entry.danger === "restricted") {
      return false;
    }
    if (tier === "external" && this.getConfig().fullToolSurface === true) {
      return true;
    }
    return TIER_ALLOWLISTS[tier].has(entry.id);
  }

  /**
   * Hard gate consulted before every CallTool dispatch. Mirrors
   * `shouldExposeTool` so a tool that appears in `ListTools` is always
   * callable — `fullToolSurface=true` widens the external tier for both
   * listing and dispatch in lockstep. The non-external tiers ignore the
   * flag because their allowlists are security boundaries.
   */
  private isTierPermitted(tier: McpTier, actionId: string): boolean {
    if (tier === "external" && this.getConfig().fullToolSurface === true) {
      return true;
    }
    return TIER_ALLOWLISTS[tier].has(actionId);
  }

  /**
   * Read the tier stamped on the session by the connection-time auth
   * resolver. Falls back to `"workbench"` — the most restrictive tier — so
   * a session that somehow escaped tier stamping cannot elevate access by
   * default.
   */
  private getSessionTier(sessionId: string): McpTier {
    return this.sessionTierMap.get(sessionId) ?? "workbench";
  }

  /**
   * Resolve the source-tier classification for an authenticated request.
   * Mirrors the branches of `isAuthorized`:
   *   1. Bearer matches the global apiKey → `"external"` (legacy server).
   *   2. Bearer matches a per-pane token → the per-pane configured tier
   *      (`"workbench"`, `"action"`, or `"system"` from the project's
   *      `daintreeMcpTier` setting). Pane configs with tier `"off"` are
   *      never written, so this branch returns one of the active tiers.
   *   3. Bearer matches a help-session token → the tier bound at provisioning.
   *   4. No `Authorization` header and no apiKey configured → `"external"`
   *      (legacy permissive path; preserves pre-auth behavior).
   * Falls back to `"workbench"` for anything that slipped through but
   * isn't recognized.
   */
  private resolveTokenTier(req: http.IncomingMessage): McpTier {
    const apiKey = this.apiKey;
    const auth = req.headers.authorization ?? "";

    if (apiKey) {
      const expected = `Bearer ${apiKey}`;
      const actualHash = createHash("sha256").update(auth).digest();
      const expectedHash = createHash("sha256").update(expected).digest();
      if (timingSafeEqual(actualHash, expectedHash)) return "external";
    } else if (auth.length === 0) {
      return "external";
    }

    if (auth.startsWith("Bearer ")) {
      const token = auth.slice("Bearer ".length);
      const paneTier = mcpPaneConfigService.getTierForToken(token);
      if (paneTier === "workbench" || paneTier === "action" || paneTier === "system") {
        return paneTier;
      }
      if (this.helpTokenValidator) {
        const helpTier = this.helpTokenValidator(token);
        if (helpTier) return helpTier;
      }
    }

    return "workbench";
  }

  private buildToolDescription(entry: ActionManifestEntry): string {
    let description = `[${entry.category}] ${entry.title}: ${entry.description}`;
    if (entry.danger === "confirm") {
      description += " Requires explicit confirmation via _meta.confirmed=true.";
    }
    return description;
  }

  private buildToolInputSchema(entry: ActionManifestEntry): Record<string, unknown> {
    const baseSchema =
      entry.inputSchema &&
      typeof entry.inputSchema === "object" &&
      !Array.isArray(entry.inputSchema) &&
      entry.inputSchema["type"] === "object"
        ? ({ ...entry.inputSchema } as Record<string, unknown>)
        : {
            type: "object",
            properties: {},
          };

    if (entry.danger !== "confirm") {
      return baseSchema;
    }

    const properties =
      baseSchema["properties"] &&
      typeof baseSchema["properties"] === "object" &&
      !Array.isArray(baseSchema["properties"])
        ? { ...(baseSchema["properties"] as Record<string, unknown>) }
        : {};

    properties["_meta"] = {
      type: "object",
      description: "Reserved Daintree MCP metadata.",
      properties: {
        confirmed: {
          type: "boolean",
          description: "Must be true to execute this destructive action.",
        },
      },
      additionalProperties: false,
    };

    return {
      ...baseSchema,
      properties,
    };
  }

  private buildAnnotations(entry: ActionManifestEntry): ToolAnnotations {
    return {
      title: entry.title,
      readOnlyHint: entry.kind === "query",
      idempotentHint: entry.kind === "query",
      destructiveHint: entry.danger === "confirm",
      openWorldHint: OPEN_WORLD_CATEGORIES.has(entry.category),
    };
  }

  private parseToolArguments(rawArgs: unknown): { args: unknown; confirmed: boolean } {
    if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
      return {
        args: rawArgs ?? {},
        confirmed: false,
      };
    }

    const argsRecord = rawArgs as Record<string, unknown>;
    const meta = argsRecord["_meta"];
    const metaRecord =
      meta !== null && typeof meta === "object" && !Array.isArray(meta)
        ? (meta as Record<string, unknown>)
        : null;
    const confirmed = metaRecord?.["confirmed"] === true;

    if (!("_meta" in argsRecord)) {
      return {
        args: rawArgs,
        confirmed,
      };
    }

    const { _meta: _ignored, ...actionArgs } = argsRecord;
    return {
      args: Object.keys(actionArgs).length > 0 ? actionArgs : {},
      confirmed,
    };
  }

  private getActiveProjectWebContents(): Electron.WebContents {
    if (this.registry) {
      for (const ctx of this.registry.all()) {
        if (ctx.browserWindow.isDestroyed()) continue;
        const view = ctx.services.projectViewManager?.getActiveView();
        const webContents = view?.webContents;
        if (webContents && !webContents.isDestroyed()) {
          return webContents;
        }
      }
    }

    const fallback = getProjectViewManager()?.getActiveView()?.webContents;
    if (fallback && !fallback.isDestroyed()) {
      return fallback;
    }

    throw new Error("MCP renderer bridge unavailable");
  }

  private normalizeError(err: unknown, fallback: string): Error {
    return err instanceof Error ? err : new Error(fallback);
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.isValidHost(req)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    if (!this.isValidOrigin(req)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    const authClass = this.isAuthorized(req);
    if (!authClass) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
      return;
    }
    // The tier classification (external vs help-session workbench/action/system)
    // will gate the exposed tool surface once #6517 lands. Authenticated for now.
    void authClass;

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);

    if (req.method === "GET" && url.pathname === "/sse") {
      const allowedHosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
      const allowedOrigins = [`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`];
      const transport = new SSEServerTransport("/messages", res, {
        enableDnsRebindingProtection: true,
        allowedHosts,
        allowedOrigins,
      });
      const sessionId = transport.sessionId;
      const tier = this.resolveTokenTier(req);
      this.sessionTierMap.set(sessionId, tier);
      const server = this.createSessionServer(sessionId);

      const idleTimer = this.createIdleTimer(sessionId);
      this.sessions.set(sessionId, { transport, idleTimer });
      transport.onclose = () => {
        const session = this.sessions.get(sessionId);
        if (session) {
          clearTimeout(session.idleTimer);
          this.sessions.delete(sessionId);
        }
        this.sessionTierMap.delete(sessionId);
      };

      await server.connect(transport);
    } else if (req.method === "POST" && url.pathname === "/messages") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const session = this.sessions.get(sessionId);

      if (session) {
        this.resetIdleTimer(sessionId);
        await session.transport.handlePostMessage(req, res);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Session not found");
      }
    } else if (url.pathname === "/mcp") {
      if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
        res.writeHead(405, {
          Allow: "GET, POST, DELETE",
          "Content-Type": "text/plain",
        });
        res.end("Method not allowed");
        return;
      }
      await this.handleStreamableHttpRequest(req, res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  }

  private async handleStreamableHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const headerValue = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    if (sessionId !== undefined && sessionId !== "") {
      const session = this.httpSessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          })
        );
        return;
      }
      this.resetHttpIdleTimer(sessionId);
      await session.transport.handleRequest(req, res);
      return;
    }

    // Pre-generate the sessionId so `createSessionServer` can stamp it onto
    // every audit record for this transport. The transport reuses the same
    // id via `sessionIdGenerator`, keeping the audit log keyed consistently
    // with the entry in `httpSessions`.
    const newSessionId = randomUUID();
    // Resolve the tier from the initialize request's Authorization header
    // and stamp it eagerly. The token is stable for the lifetime of the
    // transport, so resolving once at connection time avoids re-hashing
    // on every CallTool.
    const tier = this.resolveTokenTier(req);
    this.sessionTierMap.set(newSessionId, tier);
    const server = this.createSessionServer(newSessionId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      onsessioninitialized: (initializedSessionId) => {
        const idleTimer = this.createHttpIdleTimer(initializedSessionId);
        this.httpSessions.set(initializedSessionId, { transport, server, idleTimer });
      },
    });

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id === undefined) return;
      const session = this.httpSessions.get(id);
      if (session) {
        clearTimeout(session.idleTimer);
        this.httpSessions.delete(id);
      }
      this.sessionTierMap.delete(id);
    };

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[MCP] Streamable HTTP request failed:", err);
      const id = transport.sessionId;
      if (id !== undefined) {
        const session = this.httpSessions.get(id);
        if (session) {
          clearTimeout(session.idleTimer);
          this.httpSessions.delete(id);
        }
        this.sessionTierMap.delete(id);
      } else {
        this.sessionTierMap.delete(newSessionId);
      }
      await transport.close().catch(() => {});
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal server error");
      }
    }
  }

  private createHttpIdleTimer(sessionId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const session = this.httpSessions.get(sessionId);
      if (!session) return;
      this.httpSessions.delete(sessionId);
      this.sessionTierMap.delete(sessionId);
      session.transport.close().catch(() => {
        // ignore close errors during idle timeout cleanup
      });
    }, MCP_SSE_IDLE_TIMEOUT_MS);
    timer.unref?.();
    return timer;
  }

  private resetHttpIdleTimer(sessionId: string): void {
    const session = this.httpSessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = this.createHttpIdleTimer(sessionId);
  }

  private createIdleTimer(sessionId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      this.sessions.delete(sessionId);
      this.sessionTierMap.delete(sessionId);
      session.transport.close().catch(() => {
        // ignore close errors during idle timeout cleanup
      });
    }, MCP_SSE_IDLE_TIMEOUT_MS);
    timer.unref?.();
    return timer;
  }

  private resetIdleTimer(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = this.createIdleTimer(sessionId);
  }
}

export const mcpServerService = new McpServerService();
