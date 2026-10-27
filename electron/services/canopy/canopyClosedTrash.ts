import type { AgentSessionRecord } from "../../../shared/types/ipc/agentSessionHistory.js";
import type { CanopyTrashEntry } from "../../../shared/types/ipc/canopy.js";
import { isBuiltInAgentId } from "../../../shared/config/agentIds.js";
import { CANOPY_TRASH_LIMIT } from "../../../shared/config/trash.js";

function newestFirst(a: CanopyTrashEntry, b: CanopyTrashEntry): number {
  return (
    b.trashedAt - a.trashedAt ||
    (a.run.runId < b.run.runId ? -1 : a.run.runId > b.run.runId ? 1 : 0)
  );
}

/**
 * A user close the journal holds, as Canopy's Trash lists it: named and placed
 * as the run's row was in its live window, so the row reads the same after it.
 * Null for a record that is no user close, was taken out of the Trash, or has
 * no project or terminal to place it by.
 */
export function endedEntryOf(
  record: AgentSessionRecord,
  worktreeRemoved: boolean
): CanopyTrashEntry | null {
  const { trash, terminal } = record;
  if (record.closedBy !== "user" || !trash || trash.removedAt !== undefined) return null;
  if (!terminal || !record.projectId) return null;
  const userTitled = trash.titleMode === "user";
  return {
    run: {
      runId: terminal.id,
      workspaceId: record.projectId,
      ...(record.worktreeId ? { worktreeId: record.worktreeId } : {}),
      ...(isBuiltInAgentId(record.agentId) ? { agentId: record.agentId } : {}),
      spawnedAt: terminal.spawnedAt,
      // The record keeps the title the pane went by: the user's own, or the
      // one the agent gave its task, which the row reads as the agent's.
      ...(record.title !== null
        ? userTitled
          ? { title: record.title }
          : { lastObservedTitle: record.title }
        : {}),
      ...(trash.titleMode !== undefined ? { titleMode: trash.titleMode } : {}),
      cwd: record.cwd ?? record.worktreeId ?? "",
      launchAgentId: record.agentId,
      everDetectedAgent: true,
      ...(trash.agentPresetColor !== undefined ? { agentPresetColor: trash.agentPresetColor } : {}),
    },
    trashedAt: trash.closedAt,
    expiresAt: trash.expiresAt,
    ended: worktreeRemoved ? { worktreeRemoved: true } : {},
  };
}

/**
 * The live trash and the journal's closes as one list: one row per run,
 * newest first, at most {@link CANOPY_TRASH_LIMIT}. The journal's close of an
 * incarnation stands for it once journaled; the trash's own entry for a newer
 * incarnation of the same terminal stands over an older close.
 */
export function mergeCanopyTrash(
  live: readonly CanopyTrashEntry[],
  ended: readonly CanopyTrashEntry[],
  limit = CANOPY_TRASH_LIMIT
): CanopyTrashEntry[] {
  const byRun = new Map<string, CanopyTrashEntry>();
  for (const entry of ended) {
    const held = byRun.get(entry.run.runId);
    if (!held || held.run.spawnedAt < entry.run.spawnedAt) byRun.set(entry.run.runId, entry);
  }
  for (const entry of live) {
    const held = byRun.get(entry.run.runId);
    if (held && held.run.spawnedAt >= entry.run.spawnedAt) continue;
    byRun.set(entry.run.runId, entry);
  }
  return [...byRun.values()].sort(newestFirst).slice(0, limit);
}

export interface CanopyClosedTrashDeps {
  /** The journal's records, retention applied. */
  readRecords: () => readonly AgentSessionRecord[];
  /** Whether a worktree's directory is gone: only a missing directory says so. */
  isWorktreeGone: (path: string) => Promise<boolean>;
  /** The list changed. */
  onChange: () => void;
}

/**
 * The ended half of Canopy's Trash: the user closes the journal holds, read
 * again only when the journal is written or the panel asks, never per
 * snapshot. Keeps each close's record for a restore to resume from; the
 * snapshot carries none of it.
 */
export class CanopyClosedTrash {
  private entries: CanopyTrashEntry[] = [];
  private records = new Map<string, AgentSessionRecord>();
  /** The journal as last read. */
  private journal: readonly AgentSessionRecord[] = [];
  /** Each worktree checked, and whether it was gone; unchecked reads as present. */
  private readonly worktreesGone = new Map<string, boolean>();
  private read = false;
  private disposed = false;

  constructor(private readonly deps: CanopyClosedTrashDeps) {}

  /** Read from the journal the first time it is asked for, so a start that never shows it reads nothing. */
  list(): readonly CanopyTrashEntry[] {
    if (!this.read && !this.disposed) {
      this.read = true;
      this.rebuild(true);
      this.checkUnseenWorktrees();
    }
    return this.entries;
  }

  /** The close a row shows, while it still shows it: that trash of that incarnation. */
  find(
    runId: string,
    target: { spawnedAt: number; expiresAt: number }
  ): { entry: CanopyTrashEntry; record: AgentSessionRecord } | undefined {
    const entry = this.list().find((candidate) => candidate.run.runId === runId);
    const record = this.records.get(runId);
    if (
      !entry ||
      !record ||
      entry.run.spawnedAt !== target.spawnedAt ||
      entry.expiresAt !== target.expiresAt
    ) {
      return undefined;
    }
    return { entry, record };
  }

  /** Read the journal again; says so when the list changed. Checks worktrees it has not seen. */
  refresh(): void {
    if (this.disposed) return;
    this.read = true;
    if (this.rebuild(true)) this.deps.onChange();
    this.checkUnseenWorktrees();
  }

  /** Look again at every listed close's worktree: one may have been deleted since. */
  recheckWorktrees(): void {
    if (this.disposed) return;
    const paths = [...this.records.values()]
      .map((record) => record.worktreeId)
      .filter((path): path is string => !!path);
    if (paths.length > 0) this.checkWorktrees(paths);
  }

  dispose(): void {
    this.disposed = true;
    this.journal = [];
    this.entries = [];
    this.records.clear();
    this.worktreesGone.clear();
  }

  private checkUnseenWorktrees(): void {
    const unchecked = [...this.records.values()]
      .map((record) => record.worktreeId)
      .filter((path): path is string => !!path && !this.worktreesGone.has(path));
    if (unchecked.length > 0) this.checkWorktrees(unchecked);
  }

  private checkWorktrees(paths: readonly string[]): void {
    const unique = [...new Set(paths)];
    void Promise.all(
      unique.map((path) =>
        this.deps.isWorktreeGone(path).then(
          (gone) => [path, gone] as const,
          () => [path, false] as const
        )
      )
    ).then((checked) => {
      if (this.disposed) return;
      for (const [path, gone] of checked) this.worktreesGone.set(path, gone);
      // The same records, placed again: a worktree check reads no journal.
      if (this.rebuild(false)) this.deps.onChange();
    });
  }

  private rebuild(readJournal: boolean): boolean {
    if (readJournal) this.journal = this.deps.readRecords();
    const records = new Map<string, AgentSessionRecord>();
    const entries = new Map<string, CanopyTrashEntry>();
    for (const record of this.journal) {
      const gone = record.worktreeId ? this.worktreesGone.get(record.worktreeId) === true : false;
      const entry = endedEntryOf(record, gone);
      if (!entry) continue;
      const held = entries.get(entry.run.runId);
      if (held && held.run.spawnedAt >= entry.run.spawnedAt) continue;
      entries.set(entry.run.runId, entry);
      records.set(entry.run.runId, record);
    }
    const next = [...entries.values()].sort(newestFirst).slice(0, CANOPY_TRASH_LIMIT);
    const kept = new Set(next.map((entry) => entry.run.runId));
    for (const runId of records.keys()) if (!kept.has(runId)) records.delete(runId);
    const changed = JSON.stringify(next) !== JSON.stringify(this.entries);
    this.entries = next;
    this.records = records;
    return changed;
  }
}
