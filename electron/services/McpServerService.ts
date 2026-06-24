// eager-import-allow: reads MCP server settings via store.get synchronously during service init
import { randomUUID } from "node:crypto";
import { webContents as webContentsModule } from "electron";
import { store } from "../store.js";
import { CHANNELS } from "../ipc/channels.js";
import type { WindowRegistry } from "../window/WindowRegistry.js";
import { getWindowRegistry } from "../window/windowRef.js";
import { getSystemSleepService } from "./SystemSleepService.js";
import type {
  ActiveBearerRecord,
  AssistantTurnRecord,
  DisconnectBearerResult,
  HelpSessionBearerRecord,
  McpAuditRecord,
  McpAuditStats,
  McpGrantLifecyclePayload,
  McpIssueGrantResult,
  McpIssueNativeGrantResult,
  McpLogRecord,
  McpRevokeNativeGrantResult,
  McpRevokeSessionGrantsResult,
  McpRuntimeSnapshot,
  McpRuntimeState,
  TurnOutcomeClass,
} from "../../shared/types/ipc/mcpServer.js";
import { SessionStore } from "./mcp-server/sessionStore.js";
import { AuditService } from "./mcp-server/auditLog.js";
import { TurnOutcomeService } from "./mcp-server/turnOutcomeLog.js";
import { createRendererBridge } from "./mcp-server/rendererBridge.js";
import { handleWaitUntilIdle, handleWaitUntilIdleBatch } from "./mcp-server/waitUntilIdle.js";
import { cleanupResourceSubscriptions } from "./mcp-server/sessionServer.js";
import { HttpLifecycle } from "./mcp-server/httpLifecycle.js";
import { AbusePolicy } from "./mcp-server/abusePolicy.js";
import type {
  PendingRequest,
  DispatchEnvelope,
  HelpTokenValidator,
  HelpSessionWebContentsResolver,
  HelpSessionActionContextResolver,
  HelpSessionIdResolver,
  AssistantPaneWebContentsResolver,
  AssistantPaneActionContextResolver,
} from "./mcp-server/shared.js";
import type { ActionManifestEntry } from "../../shared/types/actions.js";
import { events } from "./events.js";
import { wireMcpServerToConnectivityRegistry } from "./connectivity/index.js";

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

    // AbusePolicy must be constructed BEFORE SessionStore so the
    // store can call into it on every per-session cleanup hook. The
    // `dropAbuseState` callback ties the policy's denial counter map
    // to the same lifecycle as the rest of the per-session state.
    const abusePolicy = new AbusePolicy({
      readConfig: () => this.getConfig(),
    });

    this.sessionStore = new SessionStore(
      (sessionId) => {
        cleanupResourceSubscriptions(sessionId, this.sessionStore);
      },
      {
        emitGrantLifecycle: (sessionId, payload) => this.emitGrantLifecycle(sessionId, payload),
        dropAbuseState: (sessionId) => abusePolicy.dropSession(sessionId),
        // The live bearer register is owned by `httpLifecycle` (created
        // below). The closure defers the reference until teardown time, by
        // which point the field is assigned. Mirrors `dropAbuseState`.
        dropBearerState: (sessionId) => this.httpLifecycle.detachBearerSession(sessionId),
        onTierDecayed: (sessionId, previousTier, newTier) => {
          // Tier just decayed to the workbench baseline (#8462). Push a
          // tools/list_changed so the model re-fetches the now-narrowed
          // manifest instead of calling a tool it no longer has. The
          // session map is the freshness check — a transport closing
          // between the lookup and the send rejects harmlessly.
          const session =
            this.sessionStore.httpSessions.get(sessionId) ??
            this.sessionStore.sessions.get(sessionId);
          session?.server.sendToolListChanged().catch(() => {
            // Transport already closing/closed — the model will see the
            // narrowed surface on its next list call regardless.
          });
          // Positive audit trail for the decay (#9151): the elevation window
          // closed and access narrowed back to the baseline. Best-effort —
          // an audit-write failure must never block the tier rollback.
          try {
            this.auditService.appendGrantRecord({
              type: "tier.decayed",
              sessionId,
              toolId: "*",
              ttlMs: 0,
              previousTier,
              tier: newTier,
            });
          } catch (err) {
            console.error("[MCP] Failed to append tier.decayed audit record:", err);
          }
        },
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
      abusePolicy,
      requestManifest: () => this.bridge.requestManifest(),
      dispatchAction: (actionId, args, confirmed, callerInfo) =>
        this.bridge.dispatchAction(actionId, args, confirmed, callerInfo),
      requestManifestForWebContents: (id) => this.bridge.requestManifestForWebContents(id),
      dispatchActionForWebContents: (id, actionId, args, confirmed, contextOverride) =>
        this.bridge.dispatchActionForWebContents(id, actionId, args, confirmed, contextOverride),
      handleWaitUntilIdle: (rawArgs, signal, options) =>
        handleWaitUntilIdle(rawArgs, signal, options),
      handleWaitUntilIdleBatch: (rawArgs, signal, options) =>
        handleWaitUntilIdleBatch(rawArgs, signal, options),
      getCachedManifest: () => this.bridge.getCachedManifest(),
      getCachedManifestForWebContents: (id) => this.bridge.getCachedManifestForWebContents(id),
      clearCachedManifest: () => this.bridge.clearCache(),
      cleanupListeners: this.cleanupListeners,
      pendingManifests: this.pendingManifests,
      pendingDispatches: this.pendingDispatches,
      setupIpcListeners: () => this.bridge.setupListeners(this.cleanupListeners),
      emitStatusChange: () => this.emitStatusChange(),
      emitRuntimeStateChange: () => this.emitRuntimeStateChange(),
      setConfig: (patch) => this.persistConfig(patch),
    });

    // Wire the live turn-outcome alert push now that both collaborators exist
    // (#10018). The service classifies `agent-stuck` / `reasoning-loop` and
    // hands the help-session id to httpLifecycle, which resolves the pinned
    // WebContents and sends. Set after construction because the send path
    // lives on httpLifecycle, built just above.
    this.turnOutcomeService.setNotifyTurnOutcomeAlert((outcome, helpSessionId, turnId) => {
      this.httpLifecycle.notifyTurnOutcomeAlert({
        helpSessionId,
        outcome,
        ...(turnId !== undefined ? { turnId } : {}),
      });
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

  setHelpSessionIdResolver(resolver: HelpSessionIdResolver | null): void {
    this.httpLifecycle.setHelpSessionIdResolver(resolver);
  }

  setAssistantPaneWebContentsResolver(resolver: AssistantPaneWebContentsResolver | null): void {
    this.httpLifecycle.setAssistantPaneWebContentsResolver(resolver);
  }

  setAssistantPaneActionContextResolver(resolver: AssistantPaneActionContextResolver | null): void {
    this.httpLifecycle.setAssistantPaneActionContextResolver(resolver);
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
    // The deprecated auditLog/turnOutcomeLog config.json keys ride along via
    // the spread only while migration 022 hasn't stripped them; never re-add
    // them explicitly or settings writes resurrect the rings in config.json.
    const current = this.getConfig();
    store.set("mcpServer", {
      ...current,
      ...patch,
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
    } else if (!enabled && (this.isRunning || this.httpLifecycle.isStartInFlight)) {
      // `stop()` awaits any in-flight `start()` before closing, so a disable
      // that races a slow start still tears the server down instead of
      // leaving it listening after the user turned it off.
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

  listActiveClients(): import("../../shared/types/ipc/mcpServer.js").McpActiveClientInfo[] {
    return this.httpLifecycle.listActiveClients();
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

  /**
   * Newest-first view of the full union (dispatch + grant lifecycle
   * records). Reserved for the audit-log viewer, NDJSON export, and any
   * other surface that handles the discriminated union — dispatch-only
   * consumers (latency table, recent-calls popover, activity strip) keep
   * using {@link getAuditRecords} so their `result`/`durationMs` reads
   * stay type-safe.
   */
  getLogRecords(): McpLogRecord[] {
    return this.auditService.getLogRecords();
  }

  getAuditConfig(): { enabled: boolean; maxRecords: number } {
    return this.auditService.getAuditConfig();
  }

  getAuditStats(markSeen = true): McpAuditStats {
    return this.auditService.getAuditStats(markSeen);
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
   * Reset a session's denial counters without dropping its grants. Backs the
   * tier-mismatch banner's Cancel path so a dismissed banner re-arms on the
   * next out-of-tier call. Caller-pin checked.
   */
  resetDenialCounts(sessionId: string, callerWcId?: number): void {
    this.httpLifecycle.resetDenialCounts(sessionId, callerWcId);
  }

  /**
   * Live tier + per-tool grants for the help session a renderer owns, keyed
   * by its public help-session id (the one in `helpPanelStore`). Caller-pinned
   * against the WebContents the session was pinned to at handshake. Returns
   * `null` when there is no live session for that renderer — the IPC handler
   * maps that to a safe "not connected" snapshot. Delegates to
   * {@link SessionStore.getLiveStatusForHelpSession} for the transport-id
   * reverse-lookup the maps require.
   */
  getHelpSessionLiveStatus(
    helpSessionId: string,
    callerWcId: number
  ): ReturnType<SessionStore["getLiveStatusForHelpSession"]> {
    return this.sessionStore.getLiveStatusForHelpSession(helpSessionId, callerWcId);
  }

  /**
   * Approve a native session-scoped automation grant (#10648) for the help
   * session a renderer owns, addressed by its public help-session id. The
   * grant authorizes the named tools for a bounded number of uses without a
   * per-call modal. Caller-pinned against the WebContents the session was
   * pinned to at handshake. Returns the minted grant's id and scope so the
   * renderer can render its card without polling.
   */
  issueNativeGrant(
    helpSessionId: string,
    params: { allowedTools: string[]; maxUses?: number; ttlMs?: number },
    callerWcId?: number
  ): McpIssueNativeGrantResult {
    return this.httpLifecycle.issueNativeGrant(helpSessionId, params, callerWcId);
  }

  /**
   * Revoke a single native automation grant by id. Caller-pinned against the
   * session the grant belongs to. Idempotent — a grant already gone (exhausted,
   * expired, or torn down with its session) reports `revoked: false`.
   */
  revokeNativeGrant(grantId: string, callerWcId?: number): McpRevokeNativeGrantResult {
    return this.httpLifecycle.revokeNativeGrant(grantId, callerWcId);
  }

  /**
   * Snapshot of the bearers currently connected to the local MCP server for
   * the settings tab. Raw tokens are never returned — only the display suffix
   * and the hash used to target {@link disconnectBearer}.
   */
  listActiveBearers(): ActiveBearerRecord[] {
    return this.httpLifecycle.listActiveBearers();
  }

  /**
   * Read-only inventory of the renderer-pinned help-session bearers (the
   * Daintree Assistant's own internal MCP connections) for the separate
   * "Daintree Assistant connections" settings row (#10036). Display fields
   * only — no tokens or hashes cross IPC, and there is no disconnect action.
   */
  listHelpSessionBearers(): HelpSessionBearerRecord[] {
    return this.httpLifecycle.listHelpSessionBearers();
  }

  /**
   * Disconnect a single bearer: revoke every session it owns and evict it
   * from the live register, then push a runtime-state change so the settings
   * tab refreshes. Targets one token only — key rotation (revoke-all) stays a
   * separate D3 action.
   */
  disconnectBearer(tokenHash: string): DisconnectBearerResult {
    const sessionIds = this.httpLifecycle.getBearerSessionIds(tokenHash);
    if (sessionIds === null) {
      return { tokenHash, disconnected: false };
    }
    for (const sessionId of sessionIds) {
      this.sessionStore.revokeSession(sessionId);
    }
    // Clear any residual entry — `revokeSession` already detaches each
    // session via the `dropBearerState` callback, but a stale entry with no
    // live sessions (client dropped the socket) wouldn't be covered.
    this.httpLifecycle.clearBearer(tokenHash);
    this.emitRuntimeStateChange();
    return { tokenHash, disconnected: true };
  }

  /**
   * Eagerly tear down the live MCP session(s) a help-session bearer owns
   * when the help session is revoked (#9151). Resolves the raw help token to
   * its register key, then reuses {@link disconnectBearer} so tier, grants,
   * and pin drop immediately instead of lingering until the 30-minute idle
   * reaper. A no-op when the agent never connected (or already disconnected)
   * — the token won't be tracked. Wired in via
   * `HelpSessionService.setOnMcpSessionRevoked`.
   */
  disconnectHelpBearer(rawToken: string): void {
    const tokenHash = this.httpLifecycle.findHelpBearerHash(rawToken);
    if (tokenHash === null) return;
    this.disconnectBearer(tokenHash);
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
        grantId: payload.grantId,
        maxUses: payload.maxUses,
        remainingUses: payload.remainingUses,
        actorId: payload.actorId,
        actorType: payload.actorType,
        allowedTools: payload.allowedTools,
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

// The connectivity registry deliberately never imports this module (it sits on
// the eager boot path; this stack does not). Wiring here, at module scope,
// covers every load path — deferred boot task, help-session provision,
// agent-spawn `ensureReady`, settings IPC — before any caller can `start()`
// the server, so the registry's onStatusChange subscription always lands
// before the first status event.
wireMcpServerToConnectivityRegistry(mcpServerService);
