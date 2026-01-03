import { createHash } from "crypto";
import fs from "node:fs";
import path from "node:path";
import { events } from "../events.js";
import type { TerminalSnapshot } from "./types.js";
import { TRASH_TTL_MS } from "./types.js";
import type { TerminalProcess } from "./TerminalProcess.js";

type ProjectIdCandidates = {
  mainProjectId: string | null;
  worktreeProjectId: string | null;
};

/**
 * Manages the Map of terminal instances, trash/restore functionality, and project filtering.
 */
export class TerminalRegistry {
  private terminals: Map<string, TerminalProcess> = new Map();
  private trashTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private lastKnownProjectId: string | null = null;
  private projectIdCandidatesByTerminalId: Map<string, ProjectIdCandidates> = new Map();

  constructor(private readonly trashTtlMs: number = TRASH_TTL_MS) {}

  add(id: string, terminal: TerminalProcess): void {
    this.terminals.set(id, terminal);
  }

  get(id: string): TerminalProcess | undefined {
    return this.terminals.get(id);
  }

  delete(id: string): void {
    this.terminals.delete(id);
    this.projectIdCandidatesByTerminalId.delete(id);
  }

  has(id: string): boolean {
    return this.terminals.has(id);
  }

  getAll(): TerminalProcess[] {
    return Array.from(this.terminals.values());
  }

  getAllIds(): string[] {
    return Array.from(this.terminals.keys());
  }

  size(): number {
    return this.terminals.size;
  }

  entries(): IterableIterator<[string, TerminalProcess]> {
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

  getForProject(projectId: string): string[] {
    const result: string[] = [];
    for (const [id, terminal] of this.terminals) {
      if (this.terminalMatchesProject(terminal, projectId)) {
        result.push(id);
      }
    }
    return result;
  }

  getProjectStats(projectId: string): {
    terminalCount: number;
    processIds: number[];
    terminalTypes: Record<string, number>;
  } {
    // Debug: log all terminals and their projectIds
    const allTerminals = Array.from(this.terminals.values());
    if (process.env.CANOPY_VERBOSE) {
      console.log(`[TerminalRegistry] getProjectStats for ${projectId.slice(0, 8)}:`, {
        totalTerminals: allTerminals.length,
        terminalProjectIds: allTerminals.map((t) => {
          const info = t.getInfo();
          return {
            id: info.id.slice(0, 8),
            projectId: info.projectId?.slice(0, 8) ?? "undefined",
            type: info.type,
          };
        }),
      });
    }

    const projectTerminals = allTerminals.filter((t) => {
      return this.terminalMatchesProject(t, projectId);
    });

    const processIds = projectTerminals
      .map((t) => t.getPtyProcess().pid)
      .filter((pid): pid is number => pid !== undefined);

    const terminalTypes = projectTerminals.reduce(
      (acc, t) => {
        const info = t.getInfo();
        const type = info.type || "terminal";
        acc[type] = (acc[type] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    if (process.env.CANOPY_VERBOSE) {
      console.log(`[TerminalRegistry] Stats result for ${projectId.slice(0, 8)}:`, {
        matchingTerminals: projectTerminals.length,
        terminalTypes,
      });
    }

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
    return terminal.getSnapshot();
  }

  getAllSnapshots(): TerminalSnapshot[] {
    return Array.from(this.terminals.keys())
      .map((id) => this.getSnapshot(id))
      .filter((snapshot): snapshot is TerminalSnapshot => snapshot !== null);
  }

  markChecked(id: string): void {
    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.markChecked();
    }
  }

  /**
   * Set the last known project ID for legacy terminal handling.
   */
  setLastKnownProjectId(projectId: string): void {
    this.lastKnownProjectId = projectId;
  }

  getLastKnownProjectId(): string | null {
    return this.lastKnownProjectId;
  }

  /**
   * Check if terminal belongs to a project (using fallback logic).
   */
  terminalBelongsToProject(terminal: TerminalProcess, projectId: string): boolean {
    const info = terminal.getInfo();
    if (info.projectId) {
      return info.projectId === projectId;
    }

    const candidates = this.getProjectIdCandidates(terminal);
    const matches =
      candidates.mainProjectId === projectId || candidates.worktreeProjectId === projectId;

    if (matches) {
      info.projectId = projectId;
      return true;
    }

    // Only fallback to lastKnownProjectId if we couldn't infer anything from the filesystem.
    if (!candidates.mainProjectId && !candidates.worktreeProjectId) {
      return this.lastKnownProjectId === projectId;
    }

    return false;
  }

  dispose(): void {
    for (const timeout of this.trashTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.trashTimeouts.clear();
    this.terminals.clear();
    this.projectIdCandidatesByTerminalId.clear();
  }

  private hashProjectId(projectRootPath: string): string {
    let canonical = projectRootPath;
    try {
      canonical = fs.realpathSync(projectRootPath);
    } catch {
      // Best-effort: fall back to the provided path (still stable enough for hashing).
    }
    const normalized = path.normalize(canonical);
    return createHash("sha256").update(normalized).digest("hex");
  }

  private findGitWorktreeRoot(startPath: string): string | null {
    if (!startPath || typeof startPath !== "string") return null;

    let current: string;
    try {
      const stats = fs.statSync(startPath);
      current = stats.isDirectory() ? startPath : path.dirname(startPath);
    } catch {
      current = path.dirname(startPath);
    }

    if (!path.isAbsolute(current)) {
      return null;
    }

    while (true) {
      const gitEntryPath = path.join(current, ".git");
      if (fs.existsSync(gitEntryPath)) {
        return current;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }

  private inferProjectIdCandidatesFromGitRoot(worktreeRoot: string): ProjectIdCandidates | null {
    const gitEntryPath = path.join(worktreeRoot, ".git");
    try {
      const stats = fs.statSync(gitEntryPath);

      // Standard main worktree (.git is a directory)
      if (stats.isDirectory()) {
        const id = this.hashProjectId(worktreeRoot);
        return { mainProjectId: id, worktreeProjectId: id };
      }

      if (!stats.isFile()) {
        return null;
      }

      // Linked worktree/submodule/etc (.git is a file pointing to the real gitdir)
      const gitFile = fs.readFileSync(gitEntryPath, "utf8");
      const firstLine = gitFile.split(/\r?\n/)[0] ?? "";
      const match = firstLine.match(/^\s*gitdir:\s*(.+)\s*$/i);
      if (!match) {
        // Unknown .git file format; treat as unresolvable.
        return null;
      }

      const rawGitDir = match[1];
      const gitDir = path.isAbsolute(rawGitDir) ? rawGitDir : path.resolve(worktreeRoot, rawGitDir);

      // If we can resolve commondir, this is likely a linked worktree. Use the main worktree
      // root (parent of common .git dir) as the canonical project identity, but keep the
      // worktree-root-derived ID as a fallback for legacy projects created from linked worktrees.
      const commondirPath = path.join(gitDir, "commondir");
      if (!fs.existsSync(commondirPath)) {
        const id = this.hashProjectId(worktreeRoot);
        return { mainProjectId: id, worktreeProjectId: id };
      }

      const commondirRaw = fs.readFileSync(commondirPath, "utf8").trim();
      const commonGitDir = path.isAbsolute(commondirRaw)
        ? commondirRaw
        : path.resolve(gitDir, commondirRaw);
      const mainRoot = path.dirname(commonGitDir);

      return {
        mainProjectId: this.hashProjectId(mainRoot),
        worktreeProjectId: this.hashProjectId(worktreeRoot),
      };
    } catch {
      return null;
    }
  }

  private getProjectIdCandidates(terminal: TerminalProcess): ProjectIdCandidates {
    const info = terminal.getInfo();
    const cached = this.projectIdCandidatesByTerminalId.get(info.id);
    if (cached) {
      return cached;
    }

    const startPaths: string[] = [];
    if (typeof info.worktreeId === "string" && info.worktreeId.trim()) {
      startPaths.push(info.worktreeId);
    }
    if (typeof info.cwd === "string" && info.cwd.trim()) {
      startPaths.push(info.cwd);
    }

    for (const startPath of startPaths) {
      const worktreeRoot = this.findGitWorktreeRoot(startPath);
      if (!worktreeRoot) continue;

      const inferred = this.inferProjectIdCandidatesFromGitRoot(worktreeRoot);
      if (!inferred) continue;

      this.projectIdCandidatesByTerminalId.set(info.id, inferred);
      return inferred;
    }

    const empty = { mainProjectId: null, worktreeProjectId: null };
    this.projectIdCandidatesByTerminalId.set(info.id, empty);
    return empty;
  }

  private terminalMatchesProject(terminal: TerminalProcess, projectId: string): boolean {
    const info = terminal.getInfo();
    if (info.projectId) {
      return info.projectId === projectId;
    }

    const candidates = this.getProjectIdCandidates(terminal);
    const matches =
      candidates.mainProjectId === projectId || candidates.worktreeProjectId === projectId;

    if (matches) {
      info.projectId = projectId;
      return true;
    }

    return false;
  }
}
