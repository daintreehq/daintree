// eager-import-allow: reads/writes the terminal registry via sync fs
import { createHash } from "crypto";
import fs from "node:fs";
import path from "node:path";
import { events } from "../events.js";
import type { TerminalSnapshot } from "./types.js";
import {
  TRASH_TTL_MS,
  MAX_PRESERVED_TERMINAL_SNAPSHOTS,
  PRESERVED_SNAPSHOT_RECENT_ACCESS_GUARD_MS,
} from "./types.js";
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
  private trashExpiryTimes: Map<string, number> = new Map();
  private projectIdCandidatesByTerminalId: Map<string, ProjectIdCandidates> = new Map();

  constructor(private readonly trashTtlMs: number = TRASH_TTL_MS) {}

  add(id: string, terminal: TerminalProcess): void {
    this.terminals.set(id, terminal);
  }

  get(id: string): TerminalProcess | undefined {
    return this.terminals.get(id);
  }

  delete(id: string): void {
    this.clearTrashTimeout(id);
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

    const expiresAt = Date.now() + this.trashTtlMs;
    const timeout = setTimeout(() => {
      console.log(`[TerminalRegistry] Auto-killing trashed terminal after TTL: ${id}`);
      onExpire(id);
      this.trashTimeouts.delete(id);
      this.trashExpiryTimes.delete(id);
    }, this.trashTtlMs);
    // Unref so the pending TTL never holds the Electron event loop alive after
    // app.quit. The default TRASH_TTL_MS is 20s, but trashTtlMs is constructor-
    // injected and can be any duration — keeping shutdown unblocked regardless.
    timeout.unref?.();

    this.trashTimeouts.set(id, timeout);
    this.trashExpiryTimes.set(id, expiresAt);
    events.emit("terminal:trashed", { id, expiresAt });
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
      this.trashExpiryTimes.delete(id);

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
      this.trashExpiryTimes.delete(id);
    }
  }

  getTrashExpiresAt(id: string): number | undefined {
    return this.trashExpiryTimes.get(id);
  }

  getForProject(projectId: string): string[] {
    const result: string[] = [];
    for (const [id, terminal] of this.terminals.entries()) {
      if (this.terminalMatchesProject(terminal, projectId) && !this.isInTrash(id)) {
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
    if (process.env.DAINTREE_VERBOSE) {
      console.log(`[TerminalRegistry] getProjectStats for ${projectId.slice(0, 8)}:`, {
        totalTerminals: allTerminals.length,
        terminalProjectIds: allTerminals.map((t) => {
          const info = t.getInfo();
          return {
            id: info.id.slice(0, 8),
            projectId: info.projectId?.slice(0, 8) ?? "undefined",
            launchAgentId: info.launchAgentId,
          };
        }),
      });
    }

    const projectTerminals = allTerminals.filter((t) => {
      const info = t.getInfo();
      if (info.isExited) {
        return false;
      }
      return this.terminalMatchesProject(t, projectId) && !this.isInTrash(info.id);
    });

    const processIds = projectTerminals
      .map((t) => t.getPtyProcess().pid)
      // Exclude the transient Windows ConPTY `pid: 0` (#10787) so it never
      // leaks into project stats consumers.
      .filter((pid): pid is number => Number.isInteger(pid) && pid > 0);

    const terminalTypes = projectTerminals.reduce(
      (acc, t) => {
        const info = t.getInfo();
        const type = info.launchAgentId || "terminal";
        acc[type] = (acc[type] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    if (process.env.DAINTREE_VERBOSE) {
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
   * Enumerate live terminals as {terminalId, projectId, rootPid} tuples for
   * memory attribution. Excludes exited and trashed terminals and the transient
   * Windows ConPTY `pid: 0` (#10787). projectId is the explicit terminal
   * project when set, else the cwd-inferred main project, else null
   * (unattributable). rootPid is the shell PID — descendant walking is the
   * caller's job.
   *
   * Resolution mirrors getProjectStats/terminalMatchesProject: both honour an
   * already-set `info.projectId` first. The bulk-stats caller runs
   * getProjectStats() for every requested project BEFORE this rollup in the same
   * Promise.all (the host processes those messages first, FIFO), so any
   * cwd-inferred terminal has already had `info.projectId` back-filled to the
   * matched requested id — keeping the rollup's keys consistent with the
   * per-project stats it's merged into. We deliberately don't re-run the
   * mutating matcher here to avoid a side effect on a read path.
   */
  getLiveTerminalRoots(): Array<{
    terminalId: string;
    projectId: string | null;
    rootPid: number;
  }> {
    const roots: Array<{ terminalId: string; projectId: string | null; rootPid: number }> = [];
    for (const [id, terminal] of this.terminals.entries()) {
      const info = terminal.getInfo();
      if (info.isExited || this.isInTrash(id)) {
        continue;
      }
      const rootPid = terminal.getPtyProcess().pid;
      if (!Number.isInteger(rootPid) || rootPid <= 0) {
        continue;
      }
      const projectId = info.projectId ?? this.getProjectIdCandidates(terminal).mainProjectId;
      roots.push({ terminalId: id, projectId: projectId ?? null, rootPid });
    }
    return roots;
  }

  /**
   * Bound the number of in-memory preserved-snapshot terminals (issue #10839).
   *
   * Agent terminals that exit cleanly retain their full serialized scrollback
   * (~1–4MB each) in memory and are otherwise removed only on explicit
   * trash/kill or project close — within an open project they accumulate
   * without bound. Walk preserved terminals oldest-first (by `preservedAt`) and
   * evict until the count is back at `max`, but never evict `skipId` (the
   * just-preserved terminal, kept as the newest entry) nor any snapshot served
   * within the recent-access guard window (currently-viewed). When too many of
   * the oldest entries are guarded to reach `max`, over-cap is tolerated rather
   * than dropping a snapshot the user is actively inspecting.
   *
   * `now` is injectable for deterministic tests; callers use the default.
   */
  evictPreservedSnapshots(
    max: number = MAX_PRESERVED_TERMINAL_SNAPSHOTS,
    skipId?: string,
    now: number = Date.now()
  ): void {
    const preserved: Array<{ id: string; preservedAt: number; lastAccessedAt: number }> = [];
    for (const [id, terminal] of this.terminals.entries()) {
      const info = terminal.getInfo();
      if (info.preservedSnapshot === undefined) {
        continue;
      }
      preserved.push({
        id,
        preservedAt: info.preservedAt ?? 0,
        lastAccessedAt: info.preservedSnapshotLastAccessedAt ?? 0,
      });
    }

    let excess = preserved.length - max;
    if (excess <= 0) {
      return;
    }

    // Oldest first — evict the oldest evictable entries until back at the cap.
    preserved.sort((a, b) => a.preservedAt - b.preservedAt);
    for (const entry of preserved) {
      if (excess <= 0) {
        break;
      }
      if (entry.id === skipId) {
        continue;
      }
      if (now - entry.lastAccessedAt < PRESERVED_SNAPSHOT_RECENT_ACCESS_GUARD_MS) {
        continue;
      }
      this.delete(entry.id);
      excess--;
    }
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
   * Check if terminal belongs to a project via explicit projectId or filesystem inference.
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

    return false;
  }

  dispose(): void {
    for (const timeout of this.trashTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.trashTimeouts.clear();
    this.trashExpiryTimes.clear();
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
