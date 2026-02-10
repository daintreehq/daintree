/**
 * SemanticAnalysisService - Manages Web Worker lifecycle for terminal semantic analysis.
 *
 * This service initializes a Web Worker that polls a SharedArrayBuffer for terminal
 * output and performs artifact extraction and agent state detection off the main thread.
 */

import type { AgentState } from "../../shared/types/domain.js";
import type { Artifact } from "../../shared/types/ipc.js";
import type {
  WorkerOutboundMessage,
  WorkerInboundMessage,
} from "../../shared/types/worker-messages.js";

/** Event handlers for semantic analysis events */
export interface SemanticAnalysisEventHandlers {
  onArtifactDetected?: (terminalId: string, artifacts: Artifact[]) => void;
  onStateChanged?: (data: {
    terminalId: string;
    agentId: string;
    state: AgentState;
    previousState: AgentState;
    timestamp: number;
    trigger: string;
    confidence: number;
    worktreeId?: string;
    traceId?: string;
  }) => void;
  onError?: (error: string, context?: string) => void;
  onReady?: () => void;
}

class SemanticAnalysisService {
  private worker: Worker | null = null;
  private isInitialized = false;
  private handlers: SemanticAnalysisEventHandlers = {};
  private initPromise: Promise<void> | null = null;
  private registeredTerminals = new Map<
    string,
    { agentId?: string; worktreeId?: string; traceId?: string; initialState?: AgentState }
  >();

  /**
   * Initialize the semantic analysis worker.
   * Call this once when the app starts.
   */
  async initialize(handlers?: SemanticAnalysisEventHandlers): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize(handlers);
    return this.initPromise;
  }

  private async doInitialize(handlers?: SemanticAnalysisEventHandlers): Promise<void> {
    if (this.isInitialized) {
      console.warn("[SemanticAnalysisService] Already initialized");
      return;
    }

    if (handlers) {
      this.handlers = handlers;
    }

    // Create worker using Vite's worker import syntax
    this.worker = new Worker(new URL("../workers/semantic.worker.ts", import.meta.url), {
      type: "module",
    });

    this.setupMessageHandler();
    this.setupErrorHandler();

    // Get the analysis buffer from the main process
    try {
      const analysisBuffer = await window.electron.terminal.getAnalysisBuffer();
      if (!analysisBuffer) {
        const errorMsg =
          "No analysis buffer available - semantic analysis disabled (SharedArrayBuffer may not be supported)";
        console.warn(`[SemanticAnalysisService] ${errorMsg}`);
        this.handlers.onError?.(errorMsg, "initialization");

        // Clean up worker and reset state so re-init is possible
        if (this.worker) {
          this.worker.terminate();
          this.worker = null;
        }
        this.isInitialized = false;
        this.initPromise = null;
        return;
      }

      // Send buffer to worker to start polling
      this.postMessage({
        type: "INIT_BUFFER",
        buffer: analysisBuffer,
      });

      console.log("[SemanticAnalysisService] Worker initialized with analysis buffer");
    } catch (error) {
      console.error("[SemanticAnalysisService] Failed to get analysis buffer:", error);
      this.handlers.onError?.(
        error instanceof Error ? error.message : String(error),
        "initialization"
      );

      // Clean up on initialization failure
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
      }
      this.isInitialized = false;
      this.initPromise = null;
      throw error;
    }
  }

  private setupMessageHandler(): void {
    if (!this.worker) return;

    this.worker.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => {
      const message = event.data;

      switch (message.type) {
        case "READY":
          this.isInitialized = true;
          this.handlers.onReady?.();
          console.log("[SemanticAnalysisService] Worker ready");
          break;

        case "ARTIFACT_DETECTED":
          this.handlers.onArtifactDetected?.(message.terminalId, message.artifacts);
          break;

        case "STATE_CHANGED":
          this.handlers.onStateChanged?.({
            terminalId: message.terminalId,
            agentId: message.agentId,
            state: message.state,
            previousState: message.previousState,
            timestamp: message.timestamp,
            trigger: message.trigger,
            confidence: message.confidence,
            worktreeId: message.worktreeId,
            traceId: message.traceId,
          });
          break;

        case "ERROR":
          console.error(
            `[SemanticAnalysisService] Worker error: ${message.error}`,
            message.context
          );
          this.handlers.onError?.(message.error, message.context);
          break;

        case "PONG":
          // Health check response - could be used for monitoring
          break;
      }
    };
  }

  private setupErrorHandler(): void {
    if (!this.worker) return;

    this.worker.onerror = (event: ErrorEvent) => {
      console.error("[SemanticAnalysisService] Worker error:", event.message);
      this.handlers.onError?.(event.message, "worker crash");

      // Attempt to restart worker
      void this.restartWorker();
    };
  }

  private async restartWorker(): Promise<void> {
    console.log("[SemanticAnalysisService] Attempting to restart worker...");

    // Clean up old worker
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    this.isInitialized = false;
    this.initPromise = null;

    // Wait a bit before restarting to avoid rapid restart loops
    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      await this.initialize(this.handlers);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[SemanticAnalysisService] Worker restart failed:", message);
      this.handlers.onError?.(message, "restart");
      return;
    }

    // Re-register all previously registered terminals
    for (const [terminalId, metadata] of this.registeredTerminals.entries()) {
      this.postMessage({
        type: "REGISTER_TERMINAL",
        terminalId,
        agentId: metadata.agentId,
        worktreeId: metadata.worktreeId,
        traceId: metadata.traceId,
        initialState: metadata.initialState,
      });
    }

    console.log(
      `[SemanticAnalysisService] Re-registered ${this.registeredTerminals.size} terminals after restart`
    );
  }

  /**
   * Post a message to the worker.
   */
  private postMessage(message: WorkerInboundMessage): void {
    if (!this.worker) {
      console.warn("[SemanticAnalysisService] Cannot post message - worker not initialized");
      return;
    }
    this.worker.postMessage(message);
  }

  /**
   * Register a terminal for agent state tracking.
   */
  registerTerminal(
    terminalId: string,
    agentId?: string,
    worktreeId?: string,
    traceId?: string,
    initialState?: AgentState
  ): void {
    // Cache registration for worker restart recovery
    this.registeredTerminals.set(terminalId, { agentId, worktreeId, traceId, initialState });

    this.postMessage({
      type: "REGISTER_TERMINAL",
      terminalId,
      agentId,
      worktreeId,
      traceId,
      initialState,
    });
  }

  /**
   * Unregister a terminal from state tracking.
   */
  unregisterTerminal(terminalId: string): void {
    // Remove from cache
    this.registeredTerminals.delete(terminalId);

    this.postMessage({
      type: "UNREGISTER_TERMINAL",
      terminalId,
    });
  }

  /**
   * Update terminal metadata (e.g., when agent spawns).
   */
  updateTerminal(
    terminalId: string,
    agentId?: string,
    worktreeId?: string,
    traceId?: string
  ): void {
    // Update cache
    const existing = this.registeredTerminals.get(terminalId);
    if (existing) {
      if (agentId !== undefined) existing.agentId = agentId;
      if (worktreeId !== undefined) existing.worktreeId = worktreeId;
      if (traceId !== undefined) existing.traceId = traceId;
    }

    this.postMessage({
      type: "UPDATE_TERMINAL",
      terminalId,
      agentId,
      worktreeId,
      traceId,
    });
  }

  /**
   * Reset worker state (e.g., on project switch).
   */
  reset(): void {
    this.postMessage({ type: "RESET" });
  }

  /**
   * Send health check ping to worker.
   */
  ping(): void {
    this.postMessage({ type: "PING" });
  }

  /**
   * Update event handlers.
   */
  setHandlers(handlers: SemanticAnalysisEventHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  /**
   * Check if worker is initialized and ready.
   */
  isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * Dispose of the service and terminate the worker.
   */
  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.isInitialized = false;
    this.initPromise = null;
    this.handlers = {};
    this.registeredTerminals.clear();
    console.log("[SemanticAnalysisService] Disposed");
  }
}

// Export singleton instance
export const semanticAnalysisService = new SemanticAnalysisService();
