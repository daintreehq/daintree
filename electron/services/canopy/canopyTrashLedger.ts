import type { CanopyTrashEntry } from "../../../shared/types/ipc/canopy.js";
import type { FleetRunRow } from "../../../shared/types/ipc/fleet.js";
import type { PanelKind, PanelTitleMode } from "../../../shared/types/panel.js";
import type { AgentState } from "../../../shared/types/agent.js";
import type { BuiltInAgentId } from "../../../shared/config/agentIds.js";
import { classifyRun } from "../projectAgentCounts.js";

/** What the ledger reads off the host's record of a terminal it heard trashed. */
export interface TrashedTerminalRecord {
  projectId?: string;
  kind?: PanelKind;
  isAssistantTerminal?: boolean;
  title?: string;
  titleMode?: PanelTitleMode;
  lastObservedTitle?: string;
  cwd: string;
  worktreeId?: string;
  spawnedAt: number;
  isTrashed?: boolean;
  trashExpiresAt?: number;
  hasPty?: boolean;
  agentState?: AgentState;
  lastStateChange?: number;
  detectedAgentId?: BuiltInAgentId;
  launchAgentId?: string;
  everDetectedAgent?: boolean;
  agentPresetColor?: string;
}

export interface CanopyTrashLedgerDeps {
  /** The host's record of a terminal, or null once it has none. */
  readTerminal: (id: string) => Promise<TrashedTerminalRecord | null>;
  isHelpTerminal: (id: string) => boolean;
  /** The list changed: Canopy's snapshot carries it. */
  onChange: () => void;
  /**
   * The trash let a run go: once as it does, and again if no close of it
   * reached the journal in the time one takes to land. The caller may keep it
   * some other way (a session the journal held from before the close); after
   * the second, the run leaves the ledger either way.
   */
  onSettle?: (entry: CanopyTrashEntry) => Promise<boolean> | boolean;
  /** The user took this run out of Canopy's Trash: when the trash lets it go, it goes. */
  isRemoved?: (entry: CanopyTrashEntry) => boolean;
  now?: () => number;
}

/** Long enough for a close to land: a graceful quit's budget, the branch lookup and the queued write. */
export const CANOPY_TRASH_SETTLE_MS = 15_000;

/**
 * Every agent run this host's trash holds, whichever project it is in and
 * however it got there: the live half of Canopy's Trash, across projects. A
 * trashed run has left the fleet, so the run is kept as the host had it when
 * it was trashed — its name, agent and place, never its state. An entry leaves
 * when the host restores the terminal. When the trash lets it go (removed, or
 * expired), or at its deadline should neither be heard, it is ended and kept
 * while its close lands in the journal, which holds it from then on.
 */
export class CanopyTrashLedger {
  private readonly entries = new Map<string, CanopyTrashEntry>();
  /** Bumped by every trash, restore or clear of a run: a read answered after one adds nothing. */
  private readonly turns = new Map<string, number>();
  /** The trash of each run a read is in flight for, by its deadline. */
  private readonly pending = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(private readonly deps: CanopyTrashLedgerDeps) {}

  /** Newest first. */
  list(): CanopyTrashEntry[] {
    return [...this.entries.values()].sort(
      (a, b) =>
        b.trashedAt - a.trashedAt ||
        (a.run.runId < b.run.runId ? -1 : a.run.runId > b.run.runId ? 1 : 0)
    );
  }

  get(runId: string): CanopyTrashEntry | undefined {
    return this.entries.get(runId);
  }

  /**
   * The host trashed a terminal. Its record says whether it is an agent run
   * Canopy lists, and which incarnation: read once, and dropped if anything
   * happened to the run while the host answered.
   */
  onTrashed(id: string, expiresAt: number): void {
    if (this.disposed) return;
    const turn = this.bump(id);
    if (this.drop(id)) this.deps.onChange();
    this.pending.set(id, expiresAt);
    const trashedAt = this.now();
    this.deps.readTerminal(id).then(
      (record) => {
        if (this.disposed || this.turns.get(id) !== turn) return;
        this.pending.delete(id);
        if (!record || record.isTrashed !== true || record.trashExpiresAt !== expiresAt) return;
        if (!record.projectId) return;
        if (classifyRun({ ...record, id, isTrashed: false }, this.deps.isHelpTerminal) !== null) {
          return;
        }
        this.entries.set(id, { run: runOf(id, record, record.projectId), trashedAt, expiresAt });
        // A backstop for a clear never heard: the entry goes at its deadline.
        const timer = setTimeout(
          () => this.onCleared(id, expiresAt),
          Math.max(0, expiresAt - this.now())
        );
        timer.unref?.();
        this.timers.set(id, timer);
        this.deps.onChange();
      },
      () => {}
    );
  }

  onRestored(id: string): void {
    if (this.disposed) return;
    this.bump(id);
    this.pending.delete(id);
    if (this.drop(id)) this.deps.onChange();
  }

  /**
   * The trash let the terminal go: removed, or expired. Names which trash it
   * was, so a late word about an earlier one leaves a newer trash be. The run
   * stays, ended, while its close is journaled.
   */
  onCleared(id: string, expiresAt: number): void {
    if (this.disposed) return;
    if (this.pending.get(id) === expiresAt) {
      this.bump(id);
      this.pending.delete(id);
    }
    const entry = this.entries.get(id);
    if (entry?.expiresAt !== expiresAt || entry.ended) return;
    if (this.deps.isRemoved?.(entry)) {
      this.drop(id);
      this.deps.onChange();
      return;
    }
    const ended: CanopyTrashEntry = { ...entry, ended: {} };
    this.entries.set(id, ended);
    this.clearTimer(id);
    const timer = setTimeout(() => this.settle(id, ended), CANOPY_TRASH_SETTLE_MS);
    timer.unref?.();
    this.timers.set(id, timer);
    this.deps.onChange();
    void Promise.resolve()
      .then(() => this.deps.onSettle?.(ended))
      .catch(() => {});
  }

  /**
   * The journal holds the close of this incarnation now, and Canopy lists it
   * from there: the ended entry goes without a word, as nothing on screen
   * changes. Returns whether one went.
   */
  onJournaled(id: string, spawnedAt: number): boolean {
    const entry = this.entries.get(id);
    if (!entry?.ended || entry.run.spawnedAt !== spawnedAt) return false;
    return this.drop(id);
  }

  /** The user took the run out of Canopy's Trash. */
  remove(id: string): void {
    if (this.disposed) return;
    this.bump(id);
    this.pending.delete(id);
    if (this.drop(id)) this.deps.onChange();
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.entries.clear();
    this.turns.clear();
    this.pending.clear();
  }

  private settle(id: string, entry: CanopyTrashEntry): void {
    this.timers.delete(id);
    if (this.disposed || this.entries.get(id) !== entry) return;
    const leave = () => {
      if (this.disposed || this.entries.get(id) !== entry) return;
      this.drop(id);
      this.deps.onChange();
    };
    void Promise.resolve()
      .then(() => this.deps.onSettle?.(entry) ?? false)
      .then(leave, leave);
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
  }

  private bump(id: string): number {
    const turn = (this.turns.get(id) ?? 0) + 1;
    this.turns.set(id, turn);
    return turn;
  }

  private drop(id: string): boolean {
    this.clearTimer(id);
    return this.entries.delete(id);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

/** The run as Canopy names and places it: who, where and which incarnation, never its state. */
function runOf(runId: string, record: TrashedTerminalRecord, workspaceId: string): FleetRunRow {
  return {
    runId,
    workspaceId,
    ...(record.worktreeId !== undefined ? { worktreeId: record.worktreeId } : {}),
    ...(record.detectedAgentId !== undefined ? { agentId: record.detectedAgentId } : {}),
    spawnedAt: record.spawnedAt,
    ...(record.title !== undefined ? { title: record.title } : {}),
    ...(record.lastObservedTitle !== undefined
      ? { lastObservedTitle: record.lastObservedTitle }
      : {}),
    ...(record.titleMode !== undefined ? { titleMode: record.titleMode } : {}),
    cwd: record.cwd,
    ...(record.launchAgentId !== undefined ? { launchAgentId: record.launchAgentId } : {}),
    ...(record.everDetectedAgent !== undefined
      ? { everDetectedAgent: record.everDetectedAgent }
      : {}),
    ...(record.agentPresetColor !== undefined ? { agentPresetColor: record.agentPresetColor } : {}),
  };
}
