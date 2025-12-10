import { events } from "../events.js";
import type { TerminalInfo, TerminalSnapshot } from "./types.js";
import { TRASH_TTL_MS } from "./types.js";

/**
 * Manages the Map of terminal instances, trash/restore functionality, and project filtering.
 */
export class TerminalRegistry {
  private terminals: Map<string, TerminalInfo> = new Map();
  private trashTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private lastKnownProjectId: string | null = null;

  constructor(private readonly trashTtlMs: number = TRASH_TTL_MS) {}

  /**
   * Add a terminal to the registry.
   */
  add(id: string, terminal: TerminalInfo): void {
    this.terminals.set(id, terminal);
  }

  /**
   * Get a terminal by ID.
   */
  get(id: string): TerminalInfo | undefined {
    return this.terminals.get(id);
  }

  /**
   * Remove a terminal from the registry.
   */
  delete(id: string): void {
    this.terminals.delete(id);
  }

  /**
   * Check if a terminal exists.
   */
  has(id: string): boolean {
    return this.terminals.has(id);
  }

  /**
   * Get all terminals as an array.
   */
  getAll(): TerminalInfo[] {
    return Array.from(this.terminals.values());
  }

  /**
   * Get all terminal IDs.
   */
  getAllIds(): string[] {
    return Array.from(this.terminals.keys());
  }

  /**
   * Get the number of terminals.
   */
  size(): number {
    return this.terminals.size;
  }

  /**
   * Iterate over all terminals.
   */
  entries(): IterableIterator<[string, TerminalInfo]> {
    return this.terminals.entries();
  }

  /**
   * Move a terminal to the trash with TTL.
   * Idempotent - calling multiple times has no effect.
   */
  trash(id: string, onExpire: (id: string) => void): void {
    if (this.trashTimeouts.has(id)) {
      return;
    }

    if (!this.terminals.has(id)) {
      console.warn(`[TerminalRegistry] Cannot trash non-existent terminal: ${id}`);
      return;
    }

    const timeout = setTimeout(() => {
      console.log(`[TerminalRegistry] Auto-killing trashed terminal after TTL: ${id}`);
      onExpire(id);
      this.trashTimeouts.delete(id);
    }, this.trashTtlMs);

    this.trashTimeouts.set(id, timeout);
    events.emit("terminal:trashed", { id, expiresAt: Date.now() + this.trashTtlMs });
  }

  /**
   * Restore a terminal from the trash.
   * Returns true if terminal was in trash and restored.
   */
  restore(id: string): boolean {
    const timeout = this.trashTimeouts.get(id);

    if (timeout) {
      clearTimeout(timeout);
      this.trashTimeouts.delete(id);

      if (this.terminals.has(id)) {
        console.log(`[TerminalRegistry] Restored terminal from trash: ${id}`);
        events.emit("terminal:restored", { id });
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a terminal is in the trash.
   */
  isInTrash(id: string): boolean {
    return this.trashTimeouts.has(id);
  }

  /**
   * Clear a trash timeout (called during kill).
   */
  clearTrashTimeout(id: string): void {
    const timeout = this.trashTimeouts.get(id);
    if (timeout) {
      clearTimeout(timeout);
      this.trashTimeouts.delete(id);
    }
  }

  /**
   * Get terminals for a specific project.
   */
  getForProject(projectId: string): string[] {
    const result: string[] = [];
    for (const [id, terminal] of this.terminals) {
      const terminalProjectId = terminal.projectId || this.lastKnownProjectId;
      if (terminalProjectId === projectId) {
        result.push(id);
      }
    }
    return result;
  }

  /**
   * Get statistics about processes for a project.
   */
  getProjectStats(projectId: string): {
    terminalCount: number;
    processIds: number[];
    terminalTypes: Record<string, number>;
  } {
    const projectTerminals = Array.from(this.terminals.values()).filter((t) => {
      const terminalProjectId = t.projectId || this.lastKnownProjectId;
      return terminalProjectId === projectId;
    });

    const processIds = projectTerminals
      .map((t) => t.ptyProcess.pid)
      .filter((pid): pid is number => pid !== undefined);

    const terminalTypes = projectTerminals.reduce(
      (acc, t) => {
        const type = t.type || "terminal";
        acc[type] = (acc[type] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    return {
      terminalCount: projectTerminals.length,
      processIds,
      terminalTypes,
    };
  }

  /**
   * Get snapshot of terminal state for AI/heuristic analysis.
   */
  getSnapshot(id: string): TerminalSnapshot | null {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      return null;
    }

    return {
      id: terminal.id,
      lines: [...terminal.semanticBuffer],
      lastInputTime: terminal.lastInputTime,
      lastOutputTime: terminal.lastOutputTime,
      lastCheckTime: terminal.lastCheckTime,
      type: terminal.type,
      worktreeId: terminal.worktreeId,
      agentId: terminal.agentId,
      agentState: terminal.agentState,
      lastStateChange: terminal.lastStateChange,
      error: terminal.error,
      spawnedAt: terminal.spawnedAt,
    };
  }

  /**
   * Get snapshots for all active terminals.
   */
  getAllSnapshots(): TerminalSnapshot[] {
    return Array.from(this.terminals.keys())
      .map((id) => this.getSnapshot(id))
      .filter((snapshot): snapshot is TerminalSnapshot => snapshot !== null);
  }

  /**
   * Mark a terminal's check time.
   */
  markChecked(id: string): void {
    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.lastCheckTime = Date.now();
    }
  }

  /**
   * Set the last known project ID for legacy terminal handling.
   */
  setLastKnownProjectId(projectId: string): void {
    this.lastKnownProjectId = projectId;
  }

  /**
   * Get the last known project ID.
   */
  getLastKnownProjectId(): string | null {
    return this.lastKnownProjectId;
  }

  /**
   * Check if terminal belongs to a project (using fallback logic).
   */
  terminalBelongsToProject(terminal: TerminalInfo, projectId: string): boolean {
    const terminalProjectId = terminal.projectId || this.lastKnownProjectId;
    return terminalProjectId === projectId;
  }

  /**
   * Clean up all resources.
   */
  dispose(): void {
    for (const timeout of this.trashTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.trashTimeouts.clear();
    this.terminals.clear();
  }
}
