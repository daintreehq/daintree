import { randomUUID } from "node:crypto";
import { store } from "../store.js";
import type { WindowRegistry } from "../window/WindowRegistry.js";
import type {
  McpRuntimeSnapshot,
  McpRuntimeState,
  McpAuditRecord,
} from "../../shared/types/ipc/mcpServer.js";
import { SessionStore } from "./mcp-server/sessionStore.js";
import { AuditService } from "./mcp-server/auditLog.js";
import { createRendererBridge } from "./mcp-server/rendererBridge.js";
import { handleWaitUntilIdle } from "./mcp-server/waitUntilIdle.js";
import { cleanupResourceSubscriptions } from "./mcp-server/sessionServer.js";
import { HttpLifecycle } from "./mcp-server/httpLifecycle.js";
import type { PendingRequest, DispatchEnvelope, HelpTokenValidator } from "./mcp-server/shared.js";
import type { ActionManifestEntry } from "../../shared/types/actions.js";

// Re-export types for backward compatibility with existing importers.
export type { HelpTokenValidator } from "./mcp-server/shared.js";
export type McpAuthClass = import("./mcp-server/shared.js").McpAuthClass;
export type McpTier = import("./mcp-server/shared.js").McpTier;

export class McpServerService {
  // Mutable reference updated by start(); read by bridge's getActiveProjectWebContents.
  private _registry: WindowRegistry | null = null;

  private readonly sessionStore: SessionStore;
  private readonly auditService: AuditService;
  private readonly httpLifecycle: HttpLifecycle;
  private readonly pendingManifests = new Map<string, PendingRequest<ActionManifestEntry[]>>();
  private readonly pendingDispatches = new Map<string, PendingRequest<DispatchEnvelope>>();
  private readonly cleanupListeners: Array<() => void> = [];
  private readonly bridge;
  private readonly statusListeners = new Set<(running: boolean) => void>();
  private readonly runtimeStateListeners = new Set<(snapshot: McpRuntimeSnapshot) => void>();

  constructor() {
    this.sessionStore = new SessionStore((sessionId) => {
      cleanupResourceSubscriptions(sessionId, this.sessionStore);
    });

    this.auditService = new AuditService(
      (patch) => this.persistConfig(patch),
      () => this.getConfig()
    );

    this.bridge = createRendererBridge(
      this.pendingManifests,
      this.pendingDispatches,
      () => this._registry
    );

    this.httpLifecycle = new HttpLifecycle({
      sessionStore: this.sessionStore,
      auditService: this.auditService,
      requestManifest: () => this.bridge.requestManifest(),
      dispatchAction: (actionId, args, confirmed) =>
        this.bridge.dispatchAction(actionId, args, confirmed),
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

  clearAuditLog(): void {
    this.auditService.clear();
  }

  setAuditEnabled(enabled: boolean): { enabled: boolean; maxRecords: number } {
    return this.auditService.setEnabled(enabled);
  }

  setAuditMaxRecords(max: number): { enabled: boolean; maxRecords: number } {
    return this.auditService.setMaxRecords(max);
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
