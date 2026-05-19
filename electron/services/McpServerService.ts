import { randomUUID } from "node:crypto";
import { webContents as webContentsModule } from "electron";
import { store } from "../store.js";
import { CHANNELS } from "../ipc/channels.js";
import type { WindowRegistry } from "../window/WindowRegistry.js";
import { getWindowRegistry } from "../window/windowRef.js";
import { getSystemSleepService } from "./SystemSleepService.js";
import type {
  AssistantTurnRecord,
  McpAuditRecord,
  McpAuditStats,
  McpGrantLifecyclePayload,
  McpIssueGrantResult,
  McpRevokeSessionGrantsResult,
  McpRuntimeSnapshot,
  McpRuntimeState,
  TurnOutcomeClass,
} from "../../shared/types/ipc/mcpServer.js";
import { SessionStore } from "./mcp-server/sessionStore.js";
import { AuditService } from "./mcp-server/auditLog.js";
import { TurnOutcomeService } from "./mcp-server/turnOutcomeLog.js";
import { createRendererBridge } from "./mcp-server/rendererBridge.js";
import { handleWaitUntilIdle } from "./mcp-server/waitUntilIdle.js";
import { cleanupResourceSubscriptions } from "./mcp-server/sessionServer.js";
import { HttpLifecycle } from "./mcp-server/httpLifecycle.js";
import type {
  PendingRequest,
  DispatchEnvelope,
  HelpTokenValidator,
  HelpSessionWebContentsResolver,
  HelpSessionActionContextResolver,
} from "./mcp-server/shared.js";
import type { ActionManifestEntry } from "../../shared/types/actions.js";
import { events } from "./events.js";

// Re-export types for backward compatibility with existing importers.
export type { HelpTokenValidator } from "./mcp-server/shared.js";
export type McpAuthClass = import("./mcp-server/shared.js").McpAuthClass;
export type McpTier = import("./mcp-server/shared.js").McpTier;

export class McpServerService {
  // Mutable reference updated by start(); read by bridge's getActiveProjectWebContents.
  private _registry: WindowRegistry | null = null;

  private readonly sessionStore: SessionStore;
  private readonly auditService: AuditService;
  private readonly turnOutcomeService: TurnOutcomeService;
  private readonly httpLifecycle: HttpLifecycle;
  /**
   * Resolver injected by `HelpSessionService` after construction. Returns
   * the help-session id bound to a terminal id, or null when the terminal
   * isn't a help session. Held as a function so the MCP service doesn't
   * import `HelpSessionService` (which would create a cycle).
   */
  private getSessionIdForTerminal: (terminalId: string) => string | null = () => null;
  private readonly pendingManifests = new Map<string, PendingRequest<ActionManifestEntry[]>>();
  private readonly pendingDispatches = new Map<string, PendingRequest<DispatchEnvelope>>();
  private readonly cleanupListeners: Array<() => void> = [];
  /**
   * Long-lived event subscriptions (agent state, agent output, terminal
   * lifecycle) that must survive `HttpLifecycle.stop()` / restart. Kept
   * separate from `cleanupListeners` because that array is owned by
   * `HttpLifecycle` and zeroed on every stop or unexpected close —
   * placing these subscriptions there would silently disable turn-outcome
   * recording the first time the MCP server restarts.
   */
  private readonly persistentListeners: Array<() => void> = [];
  private readonly bridge;
  private readonly statusListeners = new Set<(running: boolean) => void>();
  private readonly runtimeStateListeners = new Set<(snapshot: McpRuntimeSnapshot) => void>();

  constructor() {
    this.auditService = new AuditService(
      (patch) => this.persistConfig(patch),
      () => this.getConfig()
    );

    this.sessionStore = new SessionStore(
      (sessionId) => {
        cleanupResourceSubscriptions(sessionId, this.sessionStore);
      },
      {
        emitGrantLifecycle: (sessionId, payload) => this.emitGrantLifecycle(sessionId, payload),
      }
    );

    this.turnOutcomeService = new TurnOutcomeService({
      saveConfig: (patch) => this.persistConfig(patch),
      readConfig: () => this.getConfig(),
      getSessionIdForTerminal: (terminalId) => this.getSessionIdForTerminal(terminalId),
      getRecentAuditRecords: () => this.auditService.getRecords(),
    });

    const offStateChanged = events.on("agent:state-changed", (payload) => {
      const terminalId = payload.terminalId;
      if (!terminalId) return;
      this.turnOutcomeService.handleTransition({
        terminalId,
        state: payload.state,
        previousState: payload.previousState,
        trigger: payload.trigger,
        timestamp: payload.timestamp,
      });
    });
    this.persistentListeners.push(offStateChanged);

    const offOutput = events.on("agent:output", (payload) => {
      if (!payload.terminalId) return;
      this.turnOutcomeService.appendOutput(payload.terminalId, payload.data);
    });
    this.persistentListeners.push(offOutput);

    const offTrashed = events.on("terminal:trashed", (payload) => {
      this.turnOutcomeService.dropTerminal(payload.id);
    });
    this.persistentListeners.push(offTrashed);

    const offExited = events.on("terminal:exited", (payload) => {
      this.turnOutcomeService.dropTerminal(payload.terminalId);
    });
    this.persistentListeners.push(offExited);

    try {
      getSystemSleepService().onWake(() => {
        this.sessionStore.recomputeIdleTimers();
      });
    } catch {
      // SystemSleepService may not be initialized yet at early startup.
    }

    this.bridge = createRendererBridge(
      this.pendingManifests,
      this.pendingDispatches,
      () => this._registry
    );

    this.httpLifecycle = new HttpLifecycle({
      sessionStore: this.sessionStore,
      auditService: this.auditService,
      turnOutcomeService: this.turnOutcomeService,
      requestManifest: () => this.bridge.requestManifest(),
      dispatchAction: (actionId, args, confirmed) =>
        this.bridge.dispatchAction(actionId, args, confirmed),
      requestManifestForWebContents: (id) => this.bridge.requestManifestForWebContents(id),
      dispatchActionForWebContents: (id, actionId, args, confirmed, contextOverride) =>
        this.bridge.dispatchActionForWebContents(id, actionId, args, confirmed, contextOverride),
      handleWaitUntilIdle: (rawArgs, signal) => handleWaitUntilIdle(rawArgs, signal),
      getCachedManifest: () => this.bridge.getCachedManifest(),
      clearCachedManifest: () => this.bridge.clearCache(),
      cleanupListeners: this.cleanupListeners,
      pendingManifests: this.pendingManifests,
      pendingDispatches: this.pendingDispatches,
      setupIpcListeners: () => this.bridge.setupListeners(this.cleanupListeners),
      emitStatusChange: () => this.emitStatusChange(),
      emitRuntimeStateChange: () => this.emitRuntimeStateChange(),
      setConfig: (patch) => this.persistConfig(patch),
    });
  }

  get isRunning(): boolean {
    return this.httpLifecycle.isRunning;
  }

  get currentPort(): number | null {
    return this.httpLifecycle.currentPort;
  }

  get currentApiKey(): string | null {
    return this.httpLifecycle.currentApiKey;
  }

  onStatusChange(listener: (running: boolean) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onRuntimeStateChange(listener: (snapshot: McpRuntimeSnapshot) => void): () => void {
    this.runtimeStateListeners.add(listener);
    return () => {
      this.runtimeStateListeners.delete(listener);
    };
  }

  setHelpTokenValidator(validator: HelpTokenValidator | null): void {
    this.httpLifecycle.setHelpTokenValidator(validator);
  }

  setHelpSessionWebContentsResolver(resolver: HelpSessionWebContentsResolver | null): void {
    this.httpLifecycle.setHelpSessionWebContentsResolver(resolver);
  }

  setHelpSessionActionContextResolver(resolver: HelpSessionActionContextResolver | null): void {
    this.httpLifecycle.setHelpSessionActionContextResolver(resolver);
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
    this.emitRuntimeStateChange();
  }

  private emitRuntimeStateChange(): void {
    const snapshot = this.getRuntimeState();
    for (const listener of this.runtimeStateListeners) {
      try {
        listener(snapshot);
      } catch (err) {
        console.error("[MCP] Runtime-state listener threw:", err);
      }
    }
  }

  getRuntimeState(): McpRuntimeSnapshot {
    const enabled = this.isEnabled();
    let state: McpRuntimeState;
    if (!enabled) {
      state = "disabled";
    } else if (this.isRunning) {
      state = "ready";
    } else if (this.httpLifecycle.lastErrorState) {
      state = "failed";
    } else {
      state = "starting";
    }
    return {
      enabled,
      state,
      port: this.currentPort,
      lastError: this.httpLifecycle.lastErrorState,
    };
  }

  private getConfig() {
    return store.get("mcpServer");
  }

  private persistConfig(patch: Record<string, unknown>): void {
    const current = this.getConfig();
    store.set("mcpServer", {
      ...current,
      ...patch,
      auditLog: "auditLog" in patch ? patch.auditLog : current.auditLog,
      turnOutcomeLog: "turnOutcomeLog" in patch ? patch.turnOutcomeLog : current.turnOutcomeLog,
    });
  }

  isEnabled(): boolean {
    return this.getConfig().enabled;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const wasEnabled = this.isEnabled();
    this.persistConfig({ enabled });
    if (enabled && this._registry && !this.isRunning) {
      await this.httpLifecycle.start(this._registry);
    } else if (!enabled && this.isRunning) {
      await this.httpLifecycle.stop();
    } else if (wasEnabled !== enabled) {
      if (!enabled) this.httpLifecycle.setLastError(null);
      this.emitRuntimeStateChange();
    }
  }

  async setPort(port: number | null): Promise<void> {
    const wasEnabled = this.getConfig().enabled;
    this.persistConfig({ port });
    if (wasEnabled && this.isRunning) {
      await this.httpLifecycle.stop();
      if (this._registry) await this.httpLifecycle.start(this._registry);
    }
  }

  private rotateInFlight: Promise<string> | null = null;

  async rotateApiKey(): Promise<string> {
    if (this.rotateInFlight) return this.rotateInFlight;
    const promise = (async (): Promise<string> => {
      const newKey = `daintree_${randomUUID().replace(/-/g, "")}`;
      const previousKey = this.httpLifecycle.currentApiKey;
      this.httpLifecycle.setApiKey(newKey);
      try {
        this.persistConfig({ apiKey: newKey });
      } catch (err) {
        this.httpLifecycle.setApiKey(previousKey);
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

  async start(registry: WindowRegistry): Promise<void> {
    this._registry = registry;
    await this.httpLifecycle.start(registry);
  }

  async ensureReady(): Promise<boolean> {
    if (!this.isEnabled()) {
      return false;
    }

    if (this.isRunning) {
      return true;
    }

    const registry = this._registry ?? getWindowRegistry();
    if (!registry) {
      return false;
    }

    await this.start(registry);
    return this.isRunning;
  }

  async stop(): Promise<void> {
    await this.httpLifecycle.stop();
  }

  getStatus(): {
    enabled: boolean;
    port: number | null;
    configuredPort: number | null;
    apiKey: string;
  } {
    return this.httpLifecycle.getStatus();
  }

  getConfigSnippet(): string {
    return this.httpLifecycle.getConfigSnippet();
  }

  getAuditRecords(): McpAuditRecord[] {
    return this.auditService.getRecords();
  }

  getAuditConfig(): { enabled: boolean; maxRecords: number } {
    return this.auditService.getAuditConfig();
  }

  getAuditStats(): McpAuditStats {
    return this.auditService.getAuditStats();
  }

  clearAuditLog(): void {
    this.auditService.clear();
  }

  setAuditEnabled(enabled: boolean): { enabled: boolean; maxRecords: number } {
    return this.auditService.setEnabled(enabled);
  }

  setAuditMaxRecords(max: number): { enabled: boolean; maxRecords: number } {
    return this.auditService.setMaxRecords(max);
  }

  getTurnOutcomeRecords(): AssistantTurnRecord[] {
    return this.turnOutcomeService.getRecords();
  }

  clearTurnOutcomeLog(): void {
    this.turnOutcomeService.clear();
  }

  recordTurnOutcome(input: {
    outcome: TurnOutcomeClass;
    terminalId?: string | null;
    sessionId?: string | null;
    detail?: string;
  }): void {
    this.turnOutcomeService.recordDirectOutcome(input);
  }

  /**
   * Wires the help-session terminal↔session resolver. Called by
   * `HelpSessionService.ensureMcpServerReady()` (and equivalent sites) so
   * the turn-outcome classifier can correlate FSM transitions with the
   * help-session record without a circular import.
   */
  setSessionIdResolver(resolver: (terminalId: string) => string | null): void {
    this.getSessionIdForTerminal = resolver;
  }

  setSessionTier(
    sessionId: string,
    tier: "workbench" | "action" | "system",
    callerWcId?: number
  ): { sessionId: string; tier: McpTier } {
    return this.httpLifecycle.setSessionTier(sessionId, tier, callerWcId);
  }

  /**
   * Mint a per-`(sessionId, toolId)` grant for the named tool (Approve
   * once). Validates caller pin against the WebContents the session was
   * minted in — only that renderer can issue grants on its behalf.
   * Returns the grant metadata so the renderer can render a countdown.
   */
  issueGrant(sessionId: string, toolId: string, callerWcId?: number): McpIssueGrantResult {
    return this.httpLifecycle.issueGrant(sessionId, toolId, callerWcId);
  }

  /**
   * Revoke every grant for a session in one call. Caller-pin checked
   * identically to {@link issueGrant}. Returns the count of grants
   * dropped so the renderer can show a confirmation toast.
   */
  revokeSessionGrants(sessionId: string, callerWcId?: number): McpRevokeSessionGrantsResult {
    return this.httpLifecycle.revokeSessionGrants(sessionId, callerWcId);
  }

  /**
   * Emitter wired into the {@link SessionStore}'s `GrantCache` at
   * construction time. Writes an audit-log entry and pushes a targeted
   * lifecycle event to the renderer pinned at session handshake. Send
   * is always targeted — grant state is session-scoped and broadcasting
   * to every WebContents would leak security state to other windows.
   */
  private emitGrantLifecycle(sessionId: string, payload: McpGrantLifecyclePayload): void {
    try {
      this.auditService.appendGrantRecord({
        type: payload.type,
        sessionId: payload.sessionId,
        toolId: payload.toolId,
        ttlMs: payload.ttlMs,
        expiresAt: payload.expiresAt,
        revokedReason: payload.revokedReason,
      });
    } catch (err) {
      console.error("[MCP] Failed to append grant audit record:", err);
    }

    const id = this.sessionStore.sessionWebContentsMap.get(sessionId);
    if (id === undefined) return;
    const wc = webContentsModule.fromId(id);
    if (!wc || wc.isDestroyed()) return;
    try {
      wc.send(CHANNELS.MCP_GRANT_LIFECYCLE, payload);
    } catch (err) {
      console.error("[MCP] grant lifecycle send failed:", err);
    }
  }

  // Delegates for test access — tests call .bind(service) on these.
  requestManifest(...args: Parameters<typeof this.bridge.requestManifest>) {
    return this.bridge.requestManifest(...args);
  }
  dispatchAction(...args: Parameters<typeof this.bridge.dispatchAction>) {
    return this.bridge.dispatchAction(...args);
  }
  createIdleTimer(sessionId: string) {
    return this.sessionStore.createIdleTimer(sessionId);
  }
  resetIdleTimer(sessionId: string) {
    return this.sessionStore.resetIdleTimer(sessionId);
  }
  createHttpIdleTimer(sessionId: string) {
    return this.sessionStore.createHttpIdleTimer(sessionId);
  }
  resetHttpIdleTimer(sessionId: string) {
    return this.sessionStore.resetHttpIdleTimer(sessionId);
  }
  handleRequest(...args: Parameters<(typeof this.httpLifecycle)["handleRequest"]>) {
    // Use explicit type to bridge private method access
    return (this.httpLifecycle as any).handleRequest?.(...args);
  }

  // Exposed for test access to internals that moved to sub-modules.
  get _sessions() {
    return this.sessionStore.sessions;
  }
  get _httpSessions() {
    return this.sessionStore.httpSessions;
  }
  get _sessionTierMap() {
    return this.sessionStore.sessionTierMap;
  }
  get _resourceSubscriptions() {
    return this.sessionStore.resourceSubscriptions;
  }
  get _pendingManifests() {
    return this.pendingManifests;
  }
  get _pendingDispatches() {
    return this.pendingDispatches;
  }
  get _auditService() {
    return this.auditService;
  }
  get _turnOutcomeService() {
    return this.turnOutcomeService;
  }
  get _sessionStore() {
    return this.sessionStore;
  }
  get _httpLifecycle() {
    return this.httpLifecycle;
  }
  get _bridge() {
    return this.bridge;
  }
}

export const mcpServerService = new McpServerService();
