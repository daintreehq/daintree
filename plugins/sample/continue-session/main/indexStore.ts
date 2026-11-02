import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { FragmentKind } from "./sessionRecords.js";

/**
 * One SQLite file per converted session, under the plugin's own data
 * directory. One file each makes a session's size what it costs on disk and
 * deleting it a plain unlink, and nothing here is declared in
 * `contributes.databases`: the host would serve declared databases to agents
 * through its generic query tools, which can't honour the per-terminal scope
 * the search tool enforces.
 */
export class IndexStore {
  constructor(private readonly root: string) {}

  pathOf(id: string): string {
    return join(this.root, `${checkId(id)}.db`);
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  /** Builds into a temporary file that becomes the index only once it is complete. */
  async createBuilder(id: string): Promise<IndexBuilder> {
    await this.ensureRoot();
    const finalPath = this.pathOf(id);
    const partialPath = `${finalPath}.partial`;
    await rm(partialPath, { force: true });
    return new IndexBuilder(partialPath, finalPath);
  }

  async sizeOf(id: string): Promise<number | null> {
    try {
      return (await stat(this.pathOf(id))).size;
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<void> {
    const base = this.pathOf(id);
    await Promise.all(
      ["", "-journal", "-wal", "-shm", ".partial"].map((suffix) =>
        rm(`${base}${suffix}`, { force: true })
      )
    );
  }

  /**
   * Removes what an interrupted build left behind. A complete index the
   * catalog doesn't list is left alone: a catalog that failed to read must
   * never cost the user their indexes.
   */
  async sweepPartials(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return;
    }
    await Promise.all(
      names
        .filter((name) => /^[A-Za-z0-9-]+\.db\.partial$/.test(name))
        .map((name) => rm(join(this.root, name), { force: true }))
    );
  }

  /** Kept in the index, not in plugin storage, so the session's words live in one place. */
  async writeHandoff(id: string, prompt: string): Promise<void> {
    const db = new DatabaseSync(this.pathOf(id));
    try {
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('handoff', ?)").run(prompt);
    } finally {
      db.close();
    }
  }

  async readHandoff(id: string): Promise<string | null> {
    const db = new DatabaseSync(this.pathOf(id), { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'handoff'").get();
      return typeof row?.value === "string" ? row.value : null;
    } finally {
      db.close();
    }
  }

  search(id: string, match: string, limit: number): SearchHit[] {
    const db = new DatabaseSync(this.pathOf(id), { readOnly: true });
    try {
      const rows = db
        .prepare(
          `SELECT f.kind AS kind, f.line AS line, f.byte_offset AS byteOffset,
                  f.timestamp AS timestamp, f.char_offset AS charOffset,
                  snippet(fragments_fts, 0, '[', ']', '…', 48) AS excerpt
             FROM fragments_fts JOIN fragments f ON f.id = fragments_fts.rowid
            WHERE fragments_fts MATCH ?
            ORDER BY bm25(fragments_fts)
            LIMIT ?`
        )
        .all(match, limit);
      return rows.map((row) => ({
        kind: String(row.kind) as FragmentKind,
        line: Number(row.line),
        byteOffset: Number(row.byteOffset),
        charOffset: Number(row.charOffset),
        timestamp: typeof row.timestamp === "string" ? row.timestamp : null,
        excerpt: clipExcerpt(String(row.excerpt)),
      }));
    } finally {
      db.close();
    }
  }
}

export interface SearchHit {
  readonly kind: FragmentKind;
  /** 1-based line of the record in the session file. */
  readonly line: number;
  /** Byte offset of that record's line in the session file. */
  readonly byteOffset: number;
  /** Where the excerpt's chunk starts in the record's decoded text, in characters. */
  readonly charOffset: number;
  readonly timestamp: string | null;
  readonly excerpt: string;
}

/** Long texts are split so a snippet comes from near the match, not from a whole log. */
const CHUNK_CHARS = 4_000;
const BATCH_ROWS = 2_000;

export class IndexBuilder {
  private readonly db: DatabaseSync;
  private readonly insertFragment: StatementSync;
  private readonly insertText: StatementSync;
  private rowsInBatch = 0;
  private closed = false;
  fragments = 0;

  constructor(
    private readonly partialPath: string,
    private readonly finalPath: string
  ) {
    this.db = new DatabaseSync(partialPath);
    // The file is rebuilt from the session on any failure, so durability
    // during the build buys nothing.
    this.db.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      CREATE TABLE fragments (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        line INTEGER NOT NULL,
        byte_offset INTEGER NOT NULL,
        char_offset INTEGER NOT NULL,
        timestamp TEXT
      );
      CREATE VIRTUAL TABLE fragments_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2');
      BEGIN;
    `);
    this.insertFragment = this.db.prepare(
      "INSERT INTO fragments (kind, line, byte_offset, char_offset, timestamp) VALUES (?, ?, ?, ?, ?)"
    );
    this.insertText = this.db.prepare("INSERT INTO fragments_fts (rowid, text) VALUES (?, ?)");
  }

  add(
    kind: FragmentKind,
    text: string,
    position: { line: number; byteOffset: number; timestamp: string | null }
  ): void {
    for (const [charOffset, chunk] of chunks(text)) {
      const { lastInsertRowid } = this.insertFragment.run(
        kind,
        position.line,
        position.byteOffset,
        charOffset,
        position.timestamp
      );
      this.insertText.run(lastInsertRowid, chunk);
      this.fragments += 1;
      this.rowsInBatch += 1;
    }
    if (this.rowsInBatch >= BATCH_ROWS) {
      this.db.exec("COMMIT; BEGIN;");
      this.rowsInBatch = 0;
    }
  }

  /** Commits, compacts the full-text index and moves the file into place. */
  async finish(): Promise<void> {
    this.db.exec("COMMIT; INSERT INTO fragments_fts(fragments_fts) VALUES ('optimize');");
    this.close();
    await chmod(this.partialPath, 0o600);
    await rename(this.partialPath, this.finalPath);
  }

  async abandon(): Promise<void> {
    this.close();
    await rm(this.partialPath, { force: true });
  }

  /** Synchronous so an unloading plugin can release the file without awaiting. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // Already closed by a failed statement; nothing left to release.
    }
  }
}

function* chunks(text: string): Generator<[number, string]> {
  if (text.length <= CHUNK_CHARS) {
    yield [0, text];
    return;
  }
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_CHARS, text.length);
    if (end < text.length) {
      const space = text.lastIndexOf(" ", end);
      if (space > start + CHUNK_CHARS / 2) end = space;
      // Never split a surrogate pair.
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    yield [start, text.slice(start, end)];
    start = end;
  }
}

/** A snippet is a few dozen tokens, but one token can be a long unbroken blob. */
const EXCERPT_MAX_CHARS = 1_000;

function clipExcerpt(excerpt: string): string {
  return excerpt.length > EXCERPT_MAX_CHARS ? `${excerpt.slice(0, EXCERPT_MAX_CHARS)}…` : excerpt;
}

function checkId(id: string): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new Error("Invalid converted session id.");
  return id;
}
