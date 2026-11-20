import type { QuestionRow } from "@daintreehq/decisions-client";

/** Where a feed reads question rows from. */
export interface QuestionRowsSource {
  /** Every row, in alias order. */
  all(): Promise<readonly QuestionRow[]>;
  /** The rows of the questions `ids` names that are stored; a question missing has gone. */
  some(ids: readonly string[]): Promise<readonly QuestionRow[]>;
}

/**
 * Feeds every question row to the panes' state (#16016) whenever asked, one
 * read at a time: asks that come while a read is out are served by one more
 * read after it, never by one each. Every row is read once; after that only
 * the questions an ask names are read again (#18033), and the rest are fed
 * as held, the same objects, so settled history isn't read on every change.
 * Nothing is fed once stopped, so a read that lands after its lifetime ended
 * changes nothing.
 */
export class QuestionRowsFeed {
  private reading: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  /** Every stored row by question id, in alias order; null until every row has been read. */
  private held: Map<string, QuestionRow> | null = null;
  private readAll = true;
  private readonly changed = new Set<string>();

  constructor(
    private readonly source: QuestionRowsSource,
    private readonly apply: (rows: readonly QuestionRow[]) => void
  ) {}

  /**
   * Resolves once a read begun after this ask has been fed, or at once when
   * stopped. `changed` names the questions written since; without it every
   * row is read again. An empty list reads no row and feeds what is held,
   * for a change outside the rows (what the person marked handled).
   */
  refresh(changed?: Iterable<string>): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (changed === undefined) this.readAll = true;
    else for (const id of changed) this.changed.add(id);
    if (this.reading) {
      this.again = true;
      return this.reading;
    }
    this.reading = this.run();
    return this.reading;
  }

  stop(): void {
    this.stopped = true;
    this.held = null;
    this.changed.clear();
  }

  private async run(): Promise<void> {
    try {
      do {
        this.again = false;
        const all = this.readAll || this.held === null;
        const ids = [...this.changed];
        this.readAll = false;
        this.changed.clear();
        let rows: readonly QuestionRow[];
        try {
          rows = all ? await this.source.all() : await this.source.some(ids);
        } catch {
          // The panes keep what they last showed; the next write reads this again.
          if (all) this.readAll = true;
          else for (const id of ids) this.changed.add(id);
          continue;
        }
        if (this.stopped) return;
        this.apply(all ? this.replaceAll(rows) : this.replaceSome(ids, rows));
      } while (this.again && !this.stopped);
    } finally {
      this.reading = null;
    }
  }

  private replaceAll(rows: readonly QuestionRow[]): QuestionRow[] {
    this.held = new Map(rows.map((row) => [row.question_id, row]));
    return [...rows];
  }

  private replaceSome(ids: readonly string[], rows: readonly QuestionRow[]): QuestionRow[] {
    const held = this.held!;
    const found = new Map(rows.map((row) => [row.question_id, row]));
    for (const id of ids) {
      const row = found.get(id);
      if (row === undefined) held.delete(id);
      else held.set(id, row);
    }
    const next = [...held.values()];
    // A new question is appended, which keeps alias order unless it was given an older alias.
    if (next.every((row, i) => i === 0 || byAlias(next[i - 1], row) < 0)) return next;
    next.sort(byAlias);
    this.held = new Map(next.map((row) => [row.question_id, row]));
    return next;
  }
}

function byAlias(a: QuestionRow, b: QuestionRow): number {
  return a.alias - b.alias || (a.question_id < b.question_id ? -1 : 1);
}
