import { EventEmitter } from "events";
import { events } from "./events.js";
import type { AgentEvent } from "./AgentStateMachine.js";
import type { AgentStateChangeTrigger } from "../schemas/agent.js";
import type { PtyPool } from "./PtyPool.js";
import type { ActivityTier } from "../../shared/types/pty-host.js";
export type { ActivityTier } from "../../shared/types/pty-host.js";

import {
  TerminalRegistry,
  AgentStateService,
  TerminalProcess,
  type PtySpawnOptions,
  type TerminalInfo,
  type TerminalSnapshot,
  type PtyManagerEvents,
} from "./pty/index.js";

/**
 * PtyManager - Facade for terminal process management.
 *
 * Orchestrates the pty subsystem by delegating to specialized services:
 * - TerminalRegistry: Terminal instance management and project filtering
 * - AgentStateService: Agent state transitions and event emission
 * - TerminalProcess: Individual terminal session handling
 */
export class PtyManager extends EventEmitter {
  private registry: TerminalRegistry;
  private agentStateService: AgentStateService;
  private terminals: Map<string, TerminalProcess> = new Map();
  private ptyPool: PtyPool | null = null;
  private activeProjectId: string | null = null;

  constructor() {
    super();
    this.registry = new TerminalRegistry();
    this.agentStateService = new AgentStateService();
  }

  /**
   * Set the active project for IPC event filtering.
   */
  setActiveProject(projectId: string | null): void {
    const previousProjectId = this.activeProjectId;
    this.activeProjectId = projectId;

    if (process.env.CANOPY_VERBOSE) {
      console.log(
        `[PtyManager] Active project changed: ${previousProjectId || "none"} → ${projectId || "none"}`
      );
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
    const terminalInfo = this.registry.get(id);
    if (!terminalInfo) {
      return;
    }

    if (!this.activeProjectId) {
      this.emit("data", id, data);
      return;
    }

    if (this.registry.terminalBelongsToProject(terminalInfo, this.activeProjectId)) {
      this.emit("data", id, data);
    }
  }

  /**
   * Replay recent terminal history.
   */
  replayHistory(terminalId: string, maxLines: number = 100): number {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      return 0;
    }

    const replayed = terminal.replayHistory(maxLines);

    if (process.env.CANOPY_VERBOSE && replayed > 0) {
      console.log(`[PtyManager] Replayed ${replayed} lines for terminal ${terminalId}`);
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
      console.log(`[PtyManager] Replayed history for ${count} terminals in project ${projectId}`);
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
    if (this.terminals.has(id)) {
      console.warn(`Terminal with id ${id} already exists, killing existing instance`);
      this.kill(id);
    }

    const terminalProcess = new TerminalProcess(
      id,
      options,
      {
        emitData: (termId, data) => this.emitData(termId, data),
        onExit: (termId, exitCode) => {
          // Guard against stale exit events from previous terminal with same ID
          if (this.terminals.get(termId) !== terminalProcess) {
            return;
          }
          this.emit("exit", termId, exitCode);
          this.registry.delete(termId);
          this.terminals.delete(termId);
        },
      },
      {
        agentStateService: this.agentStateService,
        ptyPool: this.ptyPool,
      }
    );

    this.terminals.set(id, terminalProcess);
    this.registry.add(id, terminalProcess.getInfo());
  }

  /**
   * Write data to terminal stdin.
   */
  write(id: string, data: string, traceId?: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      console.warn(`Terminal ${id} not found, cannot write data`);
      return;
    }
    terminal.write(data, traceId);
  }

  /**
   * Resize terminal.
   */
  resize(id: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.resize(cols, rows);
    } else {
      console.warn(`Terminal ${id} not found, cannot resize`);
    }
  }

  /**
   * Acknowledge data processing for flow control.
   */
  acknowledgeData(id: string, charCount: number): void {
    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.acknowledgeData(charCount);
    }
  }

  /**
   * Set buffering mode for a terminal.
   */
  setBuffering(id: string, enabled: boolean): void {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      console.warn(`[PtyManager] Cannot set buffering: terminal ${id} not found`);
      return;
    }
    terminal.setBuffering(enabled);

    if (process.env.CANOPY_VERBOSE) {
      console.log(`[PtyManager] Buffering ${enabled ? "enabled" : "disabled"} for ${id}`);
    }
  }

  /**
   * Flush buffered output for a terminal.
   */
  flushBuffer(id: string): void {
    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.flushBuffer();
    }
  }

  /**
   * Set activity tier for IPC batching.
   */
  setActivityTier(id: string, tier: ActivityTier): void {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      if (process.env.CANOPY_VERBOSE) {
        console.warn(`[PtyManager] Cannot set activity tier: terminal ${id} not found`);
      }
      return;
    }
    terminal.setActivityTier(tier);

    if (process.env.CANOPY_VERBOSE) {
      console.log(`[PtyManager] Activity tier for ${id}: ${tier}`);
    }
  }

  /**
   * Get activity tier for a terminal.
   */
  getActivityTier(id: string): ActivityTier | undefined {
    return this.terminals.get(id)?.getActivityTier();
  }

  /**
   * Kill a terminal process.
   */
  kill(id: string, reason?: string): void {
    this.registry.clearTrashTimeout(id);

    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.kill(reason);
      // Note: deletion handled in onExit callback
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
    return this.registry.get(id);
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
    return this.registry.getAll();
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
   * Get serialized terminal state.
   */
  getSerializedState(id: string): string | null {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      return null;
    }
    return terminal.getSerializedState();
  }

  /**
   * Get terminal information for diagnostic display.
   */
  getTerminalInfo(id: string): import("../../shared/types/ipc.js").TerminalInfoPayload | null {
    const terminalInfo = this.registry.get(id);
    if (!terminalInfo) {
      return null;
    }

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
      activityTier: "focused",
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
   * Transition agent state from external observer.
   */
  transitionState(
    id: string,
    event: AgentEvent,
    trigger: AgentStateChangeTrigger,
    confidence: number,
    spawnedAt?: number
  ): boolean {
    const terminalInfo = this.registry.get(id);
    if (!terminalInfo) {
      return false;
    }

    return this.agentStateService.transitionState(
      terminalInfo,
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
      console.log(`[PtyManager] No terminals to kill for project ${projectId}`);
      return 0;
    }

    console.log(`[PtyManager] Killing ${terminalIds.length} terminal(s) for project ${projectId}`);

    let killed = 0;
    for (const terminalId of terminalIds) {
      try {
        this.kill(terminalId, "project-closed");
        killed++;
      } catch (error) {
        console.error(`[PtyManager] Failed to kill terminal ${terminalId}:`, error);
      }
    }

    console.log(`[PtyManager] Killed ${killed}/${terminalIds.length} terminals`);
    return killed;
  }

  /**
   * Handle project switch.
   */
  onProjectSwitch(newProjectId: string): void {
    console.log(`[PtyManager] Switching to project: ${newProjectId}`);

    let backgrounded = 0;
    let foregrounded = 0;

    for (const [id, terminalProcess] of this.terminals) {
      const terminalInfo = terminalProcess.getInfo();
      const belongsToProject = this.registry.terminalBelongsToProject(terminalInfo, newProjectId);

      if (!belongsToProject) {
        backgrounded++;
        events.emit("terminal:backgrounded", {
          id,
          projectId: terminalInfo.projectId || "unknown",
          timestamp: Date.now(),
        });

        terminalProcess.setBuffering(true);
        terminalProcess.stopProcessDetector();
        terminalProcess.stopActivityMonitor();
      } else {
        foregrounded++;
        events.emit("terminal:foregrounded", {
          id,
          projectId: terminalInfo.projectId || newProjectId,
          timestamp: Date.now(),
        });

        terminalProcess.setBuffering(false);
        terminalProcess.flushBuffer();
        terminalProcess.startProcessDetector();
        terminalProcess.startActivityMonitor();
      }
    }

    this.registry.setLastKnownProjectId(newProjectId);

    console.log(
      `[PtyManager] Project switch complete: ${foregrounded} foregrounded, ${backgrounded} backgrounded`
    );
  }

  /**
   * Clean up all terminals.
   */
  dispose(): void {
    for (const [_id, terminal] of this.terminals) {
      const terminalInfo = terminal.getInfo();
      if (terminalInfo.agentId) {
        this.agentStateService.emitAgentKilled(terminalInfo, "cleanup");
      }
      terminal.dispose();
    }

    this.terminals.clear();
    this.registry.dispose();
    this.removeAllListeners();
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
