import { EventEmitter } from "events";
import { events } from "./events.js";
import type { AgentEvent } from "./AgentStateMachine.js";
import type { AgentStateChangeTrigger } from "../schemas/agent.js";
import type { PtyPool } from "./PtyPool.js";
import type { ProcessTreeCache } from "./ProcessTreeCache.js";
import { logDebug, logInfo, logWarn, logError } from "../utils/logger.js";

import {
  TerminalRegistry,
  AgentStateService,
  TerminalProcess,
  type PtySpawnOptions,
  type TerminalInfo,
  TerminalSnapshot,
  type PtyManagerEvents,
} from "./pty/index.js";
import { disposeTerminalSerializerService } from "./pty/TerminalSerializerService.js";

/**
 * PtyManager - Facade for terminal process management.
 *
 * @pattern Factory/Accessor Methods (Pattern C)
 *
 * Orchestrates the pty subsystem by delegating to specialized services:
 * - TerminalRegistry: Terminal instance management and project filtering
 * - AgentStateService: Agent state transitions and event emission
 * - TerminalProcess: Individual terminal session handling
 *
 * Why this pattern:
 * - Has explicit dispose() method to clean up terminals and listeners
 * - Shared singleton accessed dynamically via getPtyManager() from IPC handlers and services
 * - Lifecycle paired with disposePtyManager() for clean shutdown
 * - Factory function provides control over instantiation timing
 *
 * When to use Pattern C:
 * - Service manages resources that need explicit cleanup (terminals, listeners)
 * - Service is accessed from multiple places but disposal must be coordinated
 * - Factory function provides control over instantiation timing
 * - Dispose function enables clean shutdown without import-time side effects
 */
export class PtyManager extends EventEmitter {
  private registry: TerminalRegistry;
  private agentStateService: AgentStateService;
  private ptyPool: PtyPool | null = null;
  private processTreeCache: ProcessTreeCache | null = null;
  private activeProjectId: string | null = null;
  private sabModeEnabled = false;

  constructor() {
    super();
    this.registry = new TerminalRegistry();
    this.agentStateService = new AgentStateService();
  }

  setProcessTreeCache(cache: ProcessTreeCache): void {
    this.processTreeCache = cache;
  }

  /**
   * Enable SharedArrayBuffer mode for flow control.
   * SAB mode uses global backpressure in pty-host for flow control.
   * This is the default and recommended mode. Always enabled when buffers are initialized.
   * Propagates to all existing terminals.
   */
  setSabMode(enabled: boolean): void {
    this.sabModeEnabled = enabled;
    // Propagate to all existing terminals
    for (const terminal of this.registry.getAll()) {
      terminal.setSabModeEnabled(enabled);
    }
    if (process.env.CANOPY_VERBOSE) {
      logDebug(`SAB mode ${enabled ? "enabled" : "disabled"}`);
    }
  }

  /**
   * Check if SAB mode is enabled.
   */
  isSabMode(): boolean {
    return this.sabModeEnabled;
  }

  /**
   * Set the active project for IPC event filtering.
   */
  setActiveProject(projectId: string | null): void {
    const previousProjectId = this.activeProjectId;
    this.activeProjectId = projectId;

    if (process.env.CANOPY_VERBOSE) {
      logDebug(`Active project changed: ${previousProjectId || "none"} → ${projectId || "none"}`);
    }
  }

  /**
   * Get the current active project ID.
   */
  getActiveProjectId(): string | null {
    return this.activeProjectId;
  }

  /**
   * Emit terminal data with project-based filtering.
   * Accepts both string and Uint8Array data for binary optimization.
   */
  private emitData(id: string, data: string | Uint8Array): void {
    const terminalProcess = this.registry.get(id);
    if (!terminalProcess) {
      return;
    }

    if (!this.activeProjectId) {
      this.emit("data", id, data);
      return;
    }

    if (this.registry.terminalBelongsToProject(terminalProcess, this.activeProjectId)) {
      this.emit("data", id, data);
    }
  }

  /**
   * Replay recent terminal history.
   */
  replayHistory(terminalId: string, maxLines: number = 100): number {
    const terminal = this.registry.get(terminalId);
    if (!terminal) {
      return 0;
    }

    const replayed = terminal.replayHistory(maxLines);

    if (process.env.CANOPY_VERBOSE && replayed > 0) {
      logDebug(`Replayed ${replayed} lines for terminal ${terminalId}`);
    }

    return replayed;
  }

  /**
   * Replay history for all terminals in a project.
   */
  replayProjectHistory(projectId: string, maxLines: number = 100): number {
    let count = 0;
    const terminalIds = this.registry.getForProject(projectId);

    for (const id of terminalIds) {
      const replayed = this.replayHistory(id, maxLines);
      if (replayed > 0) {
        count++;
      }
    }

    if (process.env.CANOPY_VERBOSE) {
      logDebug(`Replayed history for ${count} terminals in project ${projectId}`);
    }

    return count;
  }

  /**
   * Set the PTY pool for terminal reuse.
   */
  setPtyPool(pool: PtyPool): void {
    this.ptyPool = pool;
  }

  /**
   * Spawn a new terminal.
   */
  spawn(id: string, options: PtySpawnOptions): void {
    if (this.registry.has(id)) {
      const existing = this.registry.get(id);
      const existingInfo = existing?.getInfo();
      logWarn(
        `Terminal ${id} already exists (projectId: ${existingInfo?.projectId?.slice(0, 8)}), killing to respawn with new projectId`
      );
      this.kill(id);
    }
    logInfo(`Spawning terminal ${id} (kind: ${options.kind}, type: ${options.type})`);

    const terminalProcess = new TerminalProcess(
      id,
      options,
      {
        emitData: (termId, data) => this.emitData(termId, data),
        onExit: (termId, exitCode) => {
          // Guard against stale exit events from previous terminal with same ID
          if (this.registry.get(termId) !== terminalProcess) {
            return;
          }
          this.emit("exit", termId, exitCode);
          if (!terminalProcess.shouldPreserveOnExit(exitCode)) {
            this.registry.delete(termId);
          }
        },
      },
      {
        agentStateService: this.agentStateService,
        ptyPool: this.ptyPool,
        sabModeEnabled: this.sabModeEnabled,
        processTreeCache: this.processTreeCache,
      }
    );

    this.registry.add(id, terminalProcess);
  }

  /**
   * Write data to terminal stdin.
   */
  write(id: string, data: string, traceId?: string): void {
    const terminal = this.registry.get(id);
    if (!terminal) {
      logWarn(`Terminal ${id} not found, cannot write data`);
      return;
    }
    terminal.write(data, traceId);
  }

  /**
   * Submit text as a command to the terminal.
   * Handles bracketed paste and CR timing on the backend for reliable execution.
   */
  submit(id: string, text: string): void {
    const terminal = this.registry.get(id);
    if (!terminal) {
      logWarn(`Terminal ${id} not found, cannot submit`);
      return;
    }
    terminal.submit(text);
  }

  /**
   * Resize terminal.
   */
  resize(id: string, cols: number, rows: number): void {
    const terminal = this.registry.get(id);
    if (terminal) {
      terminal.resize(cols, rows);
    } else {
      logWarn(`Terminal ${id} not found, cannot resize`);
    }
  }

  /**
   * Acknowledge data processing for flow control.
   * No-op in SAB mode (which is always enabled in production).
   * Kept for backwards compatibility with IPC fallback mode.
   */
  acknowledgeData(id: string, charCount: number): void {
    const terminal = this.registry.get(id);
    if (terminal) {
      terminal.acknowledgeData(charCount);
    }
  }

  /**
   * Kill a terminal process.
   */
  kill(id: string, reason?: string): void {
    this.registry.clearTrashTimeout(id);

    const terminal = this.registry.get(id);
    if (terminal) {
      const wasExited = terminal.getInfo().isExited;
      terminal.kill(reason);
      // Note: deletion handled in onExit callback
      if (wasExited) {
        this.registry.delete(id);
      }
    }
  }

  /**
   * Move a terminal to the trash.
   */
  trash(id: string): void {
    this.registry.trash(id, (termId) => this.kill(termId, "trash-expired"));
  }

  /**
   * Restore a terminal from the trash.
   */
  restore(id: string): boolean {
    return this.registry.restore(id);
  }

  /**
   * Check if a terminal is in the trash.
   */
  isInTrash(id: string): boolean {
    return this.registry.isInTrash(id);
  }

  /**
   * Get terminal info.
   */
  getTerminal(id: string): TerminalInfo | undefined {
    const info = this.registry.get(id)?.getInfo();
    if (!info) return undefined;

    const isTrashed = this.registry.isInTrash(id);
    const trashExpiresAt = isTrashed ? this.registry.getTrashExpiresAt(id) : undefined;

    return {
      ...info,
      isTrashed,
      trashExpiresAt,
    };
  }

  /**
   * Get all active terminal IDs.
   */
  getActiveTerminalIds(): string[] {
    return this.registry.getAllIds();
  }

  /**
   * Get all active terminals.
   */
  getAll(): TerminalInfo[] {
    return this.registry.getAll().map((t) => t.getInfo());
  }

  /**
   * Check if a terminal exists.
   */
  hasTerminal(id: string): boolean {
    return this.registry.has(id);
  }

  /**
   * Get terminal snapshot for external analysis.
   */
  getTerminalSnapshot(id: string): TerminalSnapshot | null {
    return this.registry.getSnapshot(id);
  }

  /**
   * Get snapshots for all active terminals.
   */
  getAllTerminalSnapshots(): TerminalSnapshot[] {
    return this.registry.getAllSnapshots();
  }

  /**
   * Get serialized terminal state (synchronous).
   */
  getSerializedState(id: string): string | null {
    const terminal = this.registry.get(id);
    if (!terminal) {
      return null;
    }
    return terminal.getSerializedState();
  }

  /**
   * Get serialized terminal state (async, uses worker for large terminals).
   */
  async getSerializedStateAsync(id: string): Promise<string | null> {
    const terminal = this.registry.get(id);
    if (!terminal) {
      return null;
    }
    return terminal.getSerializedStateAsync();
  }

  /**
   * Get terminal information for diagnostic display.
   */
  getTerminalInfo(id: string): import("../../shared/types/ipc.js").TerminalInfoPayload | null {
    const terminal = this.registry.get(id);
    if (!terminal) {
      return null;
    }
    const terminalInfo = terminal.getInfo();

    return {
      id: terminalInfo.id,
      projectId: terminalInfo.projectId,
      type: terminalInfo.type,
      title: terminalInfo.title,
      cwd: terminalInfo.cwd,
      worktreeId: terminalInfo.worktreeId,
      agentState: terminalInfo.agentState,
      spawnedAt: terminalInfo.spawnedAt,
      lastInputTime: terminalInfo.lastInputTime,
      lastOutputTime: terminalInfo.lastOutputTime,
      lastStateChange: terminalInfo.lastStateChange,
      activityTier: terminal.getActivityTier() as "focused" | "visible" | "background",
      outputBufferSize: terminalInfo.outputBuffer.length,
      semanticBufferLines: terminalInfo.semanticBuffer.length,
      restartCount: terminalInfo.restartCount,
    };
  }

  /**
   * Mark terminal's check time.
   */
  markChecked(id: string): void {
    this.registry.markChecked(id);
  }

  /**
   * Enable or disable semantic analysis for a terminal.
   */
  setAnalysisEnabled(id: string, enabled: boolean): void {
    const terminal = this.registry.get(id);
    if (terminal) {
      terminal.setAnalysisEnabled(enabled);
    }
  }

  /**
   * Transition agent state from external observer.
   */
  transitionState(
    id: string,
    event: AgentEvent,
    trigger: AgentStateChangeTrigger,
    confidence: number,
    spawnedAt?: number
  ): boolean {
    const terminal = this.registry.get(id);
    if (!terminal) {
      return false;
    }
    // AgentStateService usually expects TerminalInfo.
    // Let's check if agentStateService can take TerminalProcess or we need to pass info.
    // Looking at the imports in PtyManager, AgentStateService is imported.
    // I need to check AgentStateService definition, but likely it takes TerminalInfo.
    return this.agentStateService.transitionState(
      terminal.getInfo(),
      event,
      trigger,
      confidence,
      spawnedAt
    );
  }

  /**
   * Get terminals for a specific project.
   */
  getTerminalsForProject(projectId: string): string[] {
    return this.registry.getForProject(projectId);
  }

  /**
   * Get available terminals (idle or waiting for user input).
   * These terminals can potentially be reused for new tasks.
   * Excludes trashed terminals and terminals without active PTY processes.
   */
  getAvailableTerminals(): TerminalInfo[] {
    return this.registry
      .getAll()
      .filter((t) => {
        const info = t.getInfo();
        const isAvailableState = info.agentState === "idle" || info.agentState === "waiting";
        const hasActivePty = !info.wasKilled && !info.isExited;
        const notTrashed = !info.isTrashed;
        return isAvailableState && hasActivePty && notTrashed;
      })
      .map((t) => t.getInfo());
  }

  /**
   * Get terminals filtered by agent state.
   */
  getTerminalsByState(state: import("../../shared/types/domain.js").AgentState): TerminalInfo[] {
    return this.registry
      .getAll()
      .filter((t) => t.getInfo().agentState === state)
      .map((t) => t.getInfo());
  }

  /**
   * Get project statistics.
   */
  getProjectStats(projectId: string): {
    terminalCount: number;
    processIds: number[];
    terminalTypes: Record<string, number>;
  } {
    return this.registry.getProjectStats(projectId);
  }

  /**
   * Kill all terminals for a project.
   */
  killByProject(projectId: string): number {
    const terminalIds = this.registry.getForProject(projectId);

    if (terminalIds.length === 0) {
      logDebug(`No terminals to kill for project ${projectId}`);
      return 0;
    }

    logInfo(`Killing ${terminalIds.length} terminal(s) for project ${projectId}`);

    let killed = 0;
    for (const terminalId of terminalIds) {
      try {
        this.kill(terminalId, "project-closed");
        killed++;
      } catch (error) {
        logError(`Failed to kill terminal ${terminalId}`, error);
      }
    }

    logInfo(`Killed ${killed}/${terminalIds.length} terminals`);
    return killed;
  }

  /**
   * Handle project switch.
   * Uses tiered monitoring: active terminals poll at 50ms, background at 500ms.
   * This keeps agent state accurate across all projects while reducing CPU for background terminals.
   */
  onProjectSwitch(
    newProjectId: string,
    onTierChange?: (id: string, tier: "active" | "background") => void
  ): void {
    logInfo(`Switching to project: ${newProjectId}`);

    let backgrounded = 0;
    let foregrounded = 0;

    const ACTIVE_POLLING_MS = 50;
    const BACKGROUND_POLLING_MS = 500;

    for (const [id, terminalProcess] of this.registry.entries()) {
      const terminalInfo = terminalProcess.getInfo();
      const belongsToProject = this.registry.terminalBelongsToProject(
        terminalProcess,
        newProjectId
      );

      if (!belongsToProject) {
        backgrounded++;
        events.emit("terminal:backgrounded", {
          id,
          projectId: terminalInfo.projectId || "unknown",
          timestamp: Date.now(),
        });

        // Keep monitors running but reduce polling frequency for background terminals
        terminalProcess.setActivityMonitorTier(BACKGROUND_POLLING_MS);
        // Notify caller to sync backpressure tier
        onTierChange?.(id, "background");
        // Process detector remains active to detect new agents
      } else {
        foregrounded++;
        events.emit("terminal:foregrounded", {
          id,
          projectId: terminalInfo.projectId || newProjectId,
          timestamp: Date.now(),
        });

        // Active terminals get full-speed polling
        terminalProcess.setActivityMonitorTier(ACTIVE_POLLING_MS);
        // Notify caller to sync backpressure tier
        onTierChange?.(id, "active");
        // Ensure process detector is running
        terminalProcess.startProcessDetector();
      }
    }

    this.registry.setLastKnownProjectId(newProjectId);

    logInfo(`Project switch complete: ${foregrounded} foregrounded, ${backgrounded} backgrounded`);
  }

  /**
   * Set activity monitoring tier (active vs background).
   */
  setActivityMonitorTier(id: string, interval: number): void {
    const terminal = this.registry.get(id);
    if (terminal) {
      terminal.setActivityMonitorTier(interval);
    }
  }

  /**
   * Get the current activity tier for a terminal.
   */
  getActivityTier(id: string): "active" | "background" | undefined {
    const terminal = this.registry.get(id);
    return terminal?.getActivityTier();
  }

  /**
   * Clean up all terminals.
   */
  dispose(): void {
    for (const [_id, terminal] of this.registry.entries()) {
      const terminalInfo = terminal.getInfo();
      if (terminalInfo.agentId) {
        this.agentStateService.emitAgentKilled(terminalInfo, "cleanup");
      }
      terminal.dispose();
    }

    this.registry.dispose();
    this.removeAllListeners();

    disposeTerminalSerializerService();
  }
}

// Export singleton instance
let ptyManagerInstance: PtyManager | null = null;

export function getPtyManager(): PtyManager {
  if (!ptyManagerInstance) {
    ptyManagerInstance = new PtyManager();
  }
  return ptyManagerInstance;
}

export function disposePtyManager(): void {
  if (ptyManagerInstance) {
    ptyManagerInstance.dispose();
    ptyManagerInstance = null;
  }
}

// Re-export types for external consumers
export type { PtySpawnOptions, TerminalInfo, TerminalSnapshot, PtyManagerEvents };
