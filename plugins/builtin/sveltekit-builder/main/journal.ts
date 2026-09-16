import type { SourceRange } from "../shared/model.js";

/**
 * The in-memory undo journal of one workspace session.
 *
 * Each entry holds the whole file before and after, not a patch: a patch stops
 * applying the moment anything else moves, and undo is only ever allowed while
 * the file still hashes to `afterRevision` — at which point the before-bytes
 * are exactly right.
 *
 * Bounded twice, oldest evicted first: at most `JOURNAL_MAX_ENTRIES` entries
 * and at most `JOURNAL_MAX_CHARS` UTF-16 code units of before+after text
 * (≈16 MiB of heap). With `MAX_SOURCE_BYTES` at 1 MiB a single entry always
 * fits. An evicted transaction answers undo with an error, never a guess.
 *
 * Nothing is persisted. A crash loses the journal, which can only make undo
 * unavailable — it can never make it claim a write that did not happen,
 * because entries are recorded after the write resolves.
 */
export const JOURNAL_MAX_ENTRIES = 100;
export const JOURNAL_MAX_CHARS = 8 * 1024 * 1024;

export interface JournalEntry {
  transactionId: string;
  absolutePath: string;
  worktreeRelative: string;
  /**
   * Where `absolutePath` resolved on disk when the edit was applied. Undo
   * refuses unless it still resolves there: a directory swapped for a symlink
   * would otherwise redirect the reversal to a different file.
   */
  realPath: string;
  /** `before`/`after` are BOM-free model text; the file's bytes carry a BOM when set. */
  bom: boolean;
  before: string;
  after: string;
  beforeRevision: string;
  afterRevision: string;
  affectedOccurrences: number;
}

export class EditJournal {
  private readonly entries = new Map<string, JournalEntry>();
  private chars = 0;

  record(entry: JournalEntry): void {
    this.entries.set(entry.transactionId, entry);
    this.chars += entry.before.length + entry.after.length;
    for (const [id, oldest] of this.entries) {
      if (this.entries.size <= JOURNAL_MAX_ENTRIES && this.chars <= JOURNAL_MAX_CHARS) break;
      if (id === entry.transactionId) break;
      this.remove(id, oldest);
    }
  }

  get(transactionId: string): JournalEntry | undefined {
    return this.entries.get(transactionId);
  }

  delete(transactionId: string): void {
    const entry = this.entries.get(transactionId);
    if (entry) this.remove(transactionId, entry);
  }

  clear(): void {
    this.entries.clear();
    this.chars = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  private remove(transactionId: string, entry: JournalEntry): void {
    this.entries.delete(transactionId);
    this.chars -= entry.before.length + entry.after.length;
  }
}

/**
 * The span that differs between two versions of a file, in `after`'s
 * coordinates. Derived from the strings rather than the plan so that an undo
 * receipt, which has no plan, reports its range the same way.
 */
export function changedRange(before: string, after: string): SourceRange {
  let start = 0;
  const limit = Math.min(before.length, after.length);
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let suffix = 0;
  while (
    suffix < limit - start &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix++;
  }
  return { start, end: after.length - suffix };
}

/** Serialises read-plan-write per file, so journal order is disk order. */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
