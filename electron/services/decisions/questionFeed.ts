import type { LocalStore, QuestionRow } from "@daintreehq/decisions-client";

/** The store calls that change a question row. */
const QUESTION_WRITES: ReadonlySet<PropertyKey> = new Set([
  "commitNewQuestion",
  "updateQuestion",
  "settleIntent",
]);

/**
 * `store`, telling `onWrite` after each call that changed a question row has
 * committed: an ask, a cancel, a publish, an answer received or delivered. A
 * call that fails tells nothing.
 */
export function observeQuestionWrites<T extends LocalStore>(store: T, onWrite: () => void): T {
  return new Proxy(store, {
    get(object, property) {
      const value: unknown = Reflect.get(object, property, object);
      if (typeof value !== "function") return value;
      const call = value as (...args: unknown[]) => unknown;
      if (!QUESTION_WRITES.has(property)) return call.bind(object);
      return async (...args: unknown[]) => {
        const result = await call.apply(object, args);
        onWrite();
        return result;
      };
    },
  });
}

/**
 * Feeds every question row to the panes' state (#16016) whenever asked, one
 * read at a time: asks that come while a read is out are served by one more
 * read after it, never by one each. Nothing is fed once stopped, so a read
 * that lands after its lifetime ended changes nothing.
 */
export class QuestionRowsFeed {
  private reading = false;
  private again = false;
  private stopped = false;

  constructor(
    private readonly read: () => Promise<readonly QuestionRow[]>,
    private readonly apply: (rows: readonly QuestionRow[]) => void
  ) {}

  refresh(): void {
    if (this.stopped) return;
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    void this.run();
  }

  stop(): void {
    this.stopped = true;
  }

  private async run(): Promise<void> {
    try {
      do {
        this.again = false;
        let rows: readonly QuestionRow[];
        try {
          rows = await this.read();
        } catch {
          // The panes keep what they last showed; the next write reads again.
          continue;
        }
        if (this.stopped) return;
        this.apply(rows);
      } while (this.again && !this.stopped);
    } finally {
      this.reading = false;
    }
  }
}
