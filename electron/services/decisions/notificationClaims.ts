import type { MetaStore } from "./attentionList.js";

const MAX_KEY_LENGTH = 1024;

/** The record as stored, or null when there is none or it can't be read as one. */
function parseRecord(text: string | null): Set<string> | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return new Set(
    parsed.filter(
      (key): key is string =>
        typeof key === "string" && key.length > 0 && key.length <= MAX_KEY_LENGTH
    )
  );
}

/**
 * What a desktop notifier has claimed, kept under one key of the store's own
 * meta table (#17232). Something shows only once a saved record holds its
 * claim, so it shows at most once across restarts. Ids only.
 */
export class NotificationClaims {
  /** The claims as last saved in the store. */
  private saved = new Set<string>();
  private written = "";
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: MetaStore,
    private readonly key: string,
    /** What the record is, for the warning when it can't be saved. */
    private readonly label: string
  ) {}

  /**
   * The claims as stored: null when there is no record, or one that can't be
   * read as one. Throws when the store can't be read.
   */
  async read(): Promise<Set<string> | null> {
    const record = parseRecord(await this.store.getMeta(this.key));
    this.saved = new Set(record ?? []);
    this.written = record === null ? "" : JSON.stringify([...record]);
    return record;
  }

  /** Writes `claimed` when it changed, one write at a time. */
  save(claimed: ReadonlySet<string>): void {
    const snapshot = new Set(claimed);
    const text = JSON.stringify([...snapshot]);
    if (text === this.written) return;
    this.written = text;
    this.writing = this.writing.then(async () => {
      try {
        await this.store.setMeta(this.key, text);
        this.saved = snapshot;
      } catch (error) {
        // The next change writes it again.
        if (this.written === text) this.written = "";
        console.warn(
          `[Decisions] The ${this.label} record couldn't be saved:`,
          error instanceof Error ? error.name : "error"
        );
      }
    });
  }

  /** Resolves once every claim made so far has been written, or failed to be. */
  settled(): Promise<void> {
    return this.writing;
  }

  /**
   * Whether the record as last saved holds `key`. A caller waits on
   * `settled()` until it does or no write is queued after the one it awaited:
   * a later write may save what an earlier one failed to.
   */
  isSaved(key: string): boolean {
    return this.saved.has(key);
  }
}
