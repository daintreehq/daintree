import type { HostWorktreeEntry } from "../../../shared/types/ipc/hostMetrics.js";

/**
 * How long a burst of worktree and agent changes is gathered before the list is
 * read again: a worktree's own updates arrive many times a second.
 */
export const WORKTREES_CHANGED_DELAY_MS = 500;

/**
 * What a sidebar shows of the list, and nothing else: change counts and
 * activity times move constantly and never warrant a re-read.
 */
export function worktreesSignature(entries: readonly HostWorktreeEntry[]): string {
  return entries
    .map((entry) =>
      [
        entry.projectId,
        entry.worktreeId,
        entry.name,
        entry.branch ?? "",
        entry.isMainWorktree ? "main" : "",
        entry.observed?.band ?? "",
        entry.observed?.agentState ?? "",
        (entry.runs ?? [])
          .map((run) => `${run.terminalId}:${run.band}:${run.agentState ?? ""}`)
          .join(","),
      ].join("\t")
    )
    .join("\n");
}

export interface WorktreeChangeWatchOptions {
  list(): Promise<HostWorktreeEntry[]>;
  /** Whether anyone would hear a change now; while nobody would, nothing is read. */
  active(): boolean;
  /** What the list shows moved since it was last read. */
  changed(): void;
  delayMs?: number;
}

/**
 * Turns "something may have changed" into "the list shows something else",
 * one read per burst. Only one read runs at a time; a poke during it reads
 * once more after.
 */
export class WorktreeChangeWatch {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reading = false;
  private again = false;
  private last: string | null = null;
  private disposed = false;

  constructor(private readonly options: WorktreeChangeWatchOptions) {}

  poke(): void {
    if (this.disposed || this.timer !== null) return;
    if (this.reading) {
      this.again = true;
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.read();
    }, this.options.delayMs ?? WORKTREES_CHANGED_DELAY_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.again = false;
  }

  private async read(): Promise<void> {
    if (!this.options.active()) {
      // Nobody to tell; whoever listens next reads the list fresh.
      this.last = null;
      return;
    }
    this.reading = true;
    let signature: string | null = null;
    try {
      signature = worktreesSignature(await this.options.list());
    } catch (error) {
      console.warn("[HostMetrics] Couldn't read worktrees:", error);
    }
    this.reading = false;
    if (this.disposed) return;
    if (signature !== null && signature !== this.last) {
      this.last = signature;
      this.options.changed();
    }
    if (this.again) {
      this.again = false;
      this.poke();
    }
  }
}
