import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const TURN_OUTCOME_RING = "mcpTurnOutcomeLog";

const SQLITE_HEADER = "SQLite format 3\0";
const EXPECTED_SOURCE = "a Daintree profile directory or its daintree.db";

export type TurnOutcomeSourceErrorKind = "missing" | "unsupported" | "no-table" | "unreadable";

export class TurnOutcomeSourceError extends Error {
  constructor(
    readonly kind: TurnOutcomeSourceErrorKind,
    readonly sourcePath: string,
    message: string
  ) {
    super(message);
    this.name = "TurnOutcomeSourceError";
  }
}

export interface TurnOutcomeRingRead {
  /** Parsed records in ring order (oldest first); unparseable rows are left out. */
  rows: unknown[];
  /** Total rows in the ring, parseable or not. */
  rowCount: number;
  warnings: string[];
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type DatabaseSyncCtor = new (
  location: string,
  options?: { readOnly?: boolean; timeout?: number }
) => SqliteDatabase;

function loadDatabaseSync(): DatabaseSyncCtor {
  // getBuiltinModule keeps the bundler and vitest out of the resolution, and
  // node:sqlite avoids better-sqlite3, whose binary is built for Electron's ABI.
  const sqlite = process.getBuiltinModule("node:sqlite") as
    { DatabaseSync?: DatabaseSyncCtor } | undefined;
  if (!sqlite?.DatabaseSync) {
    throw new Error("node:sqlite is not available in this Node runtime (Node 22.13+ is required)");
  }
  return sqlite.DatabaseSync;
}

interface FileIdentity {
  ino: number;
  size: number;
  mtimeMs: number;
}

function identityOf(file: string): FileIdentity | null {
  try {
    const stat = fs.statSync(file);
    return { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function sameIdentity(a: FileIdentity | null, b: FileIdentity | null): boolean {
  return !!a && !!b && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function readHeader(dbPath: string): string {
  const fd = fs.openSync(dbPath, "r");
  try {
    const buffer = Buffer.alloc(SQLITE_HEADER.length);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString("latin1");
  } finally {
    fs.closeSync(fd);
  }
}

function assertSqliteSource(dbPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dbPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TurnOutcomeSourceError(
        "missing",
        dbPath,
        `No Daintree database at ${dbPath}. Expected ${EXPECTED_SOURCE}.`
      );
    }
    throw new TurnOutcomeSourceError(
      "unreadable",
      dbPath,
      `Cannot read ${dbPath}: ${(error as Error).message}`
    );
  }
  if (!stat.isFile()) {
    throw new TurnOutcomeSourceError(
      "unsupported",
      dbPath,
      `${dbPath} is not a file. Expected ${EXPECTED_SOURCE}.`
    );
  }
  let header: string;
  try {
    header = readHeader(dbPath);
  } catch (error) {
    throw new TurnOutcomeSourceError(
      "unreadable",
      dbPath,
      `Cannot read ${dbPath}: ${(error as Error).message}`
    );
  }
  if (header !== SQLITE_HEADER) {
    const legacy = dbPath.toLowerCase().endsWith(".json")
      ? " Turn outcomes are no longer stored in config.json; point at the profile directory instead."
      : "";
    throw new TurnOutcomeSourceError(
      "unsupported",
      dbPath,
      `${dbPath} is not a SQLite database. Expected ${EXPECTED_SOURCE}.${legacy}`
    );
  }
}

function queryRing(db: SqliteDatabase, dbPath: string): TurnOutcomeRingRead {
  const table = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'audit_rings'")
    .get();
  if (!table) {
    throw new TurnOutcomeSourceError(
      "no-table",
      dbPath,
      `${dbPath} has no audit_rings table. Expected ${EXPECTED_SOURCE} written by a Daintree build that stores turn outcomes in SQLite.`
    );
  }
  const raw = db
    .prepare("SELECT id, record FROM audit_rings WHERE ring = ? ORDER BY id ASC")
    .all(TURN_OUTCOME_RING) as Array<{ id: number | bigint; record: unknown }>;
  const rows: unknown[] = [];
  const warnings: string[] = [];
  for (const row of raw) {
    if (typeof row.record !== "string") {
      warnings.push(`audit_rings row ${String(row.id)}: record is not text, skipping`);
      continue;
    }
    try {
      rows.push(JSON.parse(row.record));
    } catch {
      warnings.push(`audit_rings row ${String(row.id)}: record is not valid JSON, skipping`);
    }
  }
  return { rows, rowCount: raw.length, warnings };
}

// Long enough to ride out the app's WAL recovery or a checkpoint, short
// enough that a stuck lock fails the run instead of hanging it.
const BUSY_TIMEOUT_MS = 2000;

function withConnection<T>(location: string, read: (db: SqliteDatabase) => T): T {
  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(location, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/**
 * Read the turn-outcome ring from a profile's daintree.db without writing to
 * the profile.
 *
 * A read-only connection to a WAL database creates an empty -wal and a -shm
 * when they are missing, which is what an idle profile looks like. So with no
 * -wal present the file is read as immutable, which opens no sidecars. That is
 * only sound while nothing writes the file: in WAL mode the main file changes
 * only through a checkpoint, which needs an open -wal, so "no -wal before or
 * after, same inode, size and mtime" proves the read saw a file at rest.
 * Anything else means the app started meanwhile, and the read is redone on a
 * read-only WAL connection, which sees one consistent snapshot, never blocks
 * the app's writers, and never checkpoints (it cannot take the write lock).
 */
export function readTurnOutcomeRing(dbPath: string): TurnOutcomeRingRead {
  assertSqliteSource(dbPath);
  const walPath = `${dbPath}-wal`;
  try {
    if (!fs.existsSync(walPath)) {
      const before = identityOf(dbPath);
      const unchanged = () => !fs.existsSync(walPath) && sameIdentity(before, identityOf(dbPath));
      let result: TurnOutcomeRingRead;
      try {
        result = withConnection(`${pathToFileURL(dbPath).href}?immutable=1`, (db) =>
          queryRing(db, dbPath)
        );
      } catch (error) {
        // A page torn by a checkpoint mid-read surfaces as an error; only a
        // file that stayed put makes the error the database's own.
        if (unchanged()) throw error;
        return withConnection(dbPath, (db) => queryRing(db, dbPath));
      }
      if (unchanged()) return result;
    }
    return withConnection(dbPath, (db) => queryRing(db, dbPath));
  } catch (error) {
    if (error instanceof TurnOutcomeSourceError) throw error;
    throw new TurnOutcomeSourceError(
      "unreadable",
      dbPath,
      `Cannot read turn outcomes from ${dbPath}: ${(error as Error).message}`
    );
  }
}
