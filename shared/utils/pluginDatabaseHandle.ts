// The `host.db` handle, shared by every place plugin code runs: the plugin
// worker, the in-process host for built-ins, and the SDK's mock host. It opens
// an already-resolved location with the runtime's own `node:sqlite`, so
// queries never cross a port. Containment is the resolver's job
// (electron/services/plugin/pluginDatabase.ts), not this module's.
//
// The data contract it serves is "agents write the file directly": an agent in
// a project terminal runs `sqlite3 <path>` while a panel holds a handle open.
// So the handle notices commits it did not make, and a file replaced
// underneath it (`git checkout`, a restore script).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  PluginDatabase,
  PluginDatabaseChangeEvent,
  PluginDatabaseLocation,
  PluginDatabaseOpenOptions,
  PluginDatabaseParams,
  PluginDatabaseRunResult,
  PluginDatabaseStatements,
} from "../types/plugin.js";
import { formatErrorMessage } from "./errorMessage.js";
import { identifierText, isInsignificant, isKeyword, lexSql } from "./sqlLexer.js";

export function databaseError(code: string, message: string): Error & { code: string } {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

// ── The handle ─────────────────────────────────────────────────────────────

interface SqliteStatement {
  readonly sourceSQL?: string;
  columns?(): Array<{
    name: string;
    table: string | null;
    column: string | null;
    type: string | null;
  }>;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  /** Node 23.4+; feature-detected. */
  iterate?(...params: unknown[]): IterableIterator<unknown> & { return?(): unknown };
  /** Node 24.0+; feature-detected. */
  setReturnArrays?(enabled: boolean): void;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  setReadBigInts?(enabled: boolean): void;
}
type SqliteAuthorizer = (
  action: number,
  arg1: string | null,
  arg2: string | null,
  dbName: string | null,
  trigger: string | null
) => number;
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
  /** Node 24.10+; feature-detected. */
  setAuthorizer?(callback: SqliteAuthorizer | null): void;
  /** Node 24.x; feature-detected. */
  limits?: { length: number };
}
type DatabaseSyncCtor = new (
  path: string,
  options?: { enableForeignKeyConstraints?: boolean; readOnly?: boolean }
) => SqliteDatabase;
interface SqliteModule {
  DatabaseSync?: DatabaseSyncCtor;
  constants?: Record<string, number>;
}

let cachedModule: (SqliteModule & { DatabaseSync: DatabaseSyncCtor }) | null = null;
function loadSqlite(): SqliteModule & { DatabaseSync: DatabaseSyncCtor } {
  if (cachedModule) return cachedModule;
  // Loaded lazily so a runtime without `node:sqlite` fails the first `open`
  // with a clear message instead of failing every import of the host.
  try {
    const sqlite = process.getBuiltinModule("node:sqlite") as SqliteModule | undefined;
    if (!sqlite?.DatabaseSync) throw new Error("node:sqlite is not built into this runtime");
    cachedModule = sqlite as SqliteModule & { DatabaseSync: DatabaseSyncCtor };
  } catch (error) {
    throw databaseError(
      "SQLITE_UNAVAILABLE",
      `this plugin runtime has no node:sqlite (${formatErrorMessage(error, "unknown error")})`
    );
  }
  return cachedModule;
}

/** Pragmas that point SQLite at a directory of its own choosing, process-wide. */
const DIRECTORY_PRAGMAS = new Set(["temp_store_directory", "data_store_directory"]);

/**
 * A plugin database is one contained file. `ATTACH` and `VACUUM INTO` would
 * open or create any other file the process can reach — `VACUUM INTO` even
 * from a readonly handle — past the resolver's containment and the write
 * consent, so they are refused; a copy goes through `backup()`, which the host
 * approves. Where the runtime has `setAuthorizer` the connection also refuses
 * them itself (see `fileAccessAuthorizer`); this scan is the check on runtimes
 * without it, and gives the same refusal a clear code on those with it.
 */
function assertNoFileAccess(sql: string, id: string): void {
  // SQLite itself rejects a non-string with its own error.
  if (typeof sql !== "string") return;
  const refuse = (what: string): never => {
    throw databaseError(
      "DB_STATEMENT_NOT_ALLOWED",
      `database "${id}": ${what} is not allowed; a plugin database cannot open other files (use backup() for a copy)`
    );
  };
  const significant = lexSql(sql).filter((token) => !isInsignificant(token));
  let start = 0;
  while (start < significant.length) {
    let end = start;
    while (end < significant.length && significant[end]!.kind !== "semicolon") end++;
    const statement = significant.slice(start, end);
    start = end + 1;
    let at = 0;
    if (isKeyword(statement[at], "EXPLAIN")) {
      at++;
      if (isKeyword(statement[at], "QUERY") && isKeyword(statement[at + 1], "PLAN")) at += 2;
    }
    const first = statement[at];
    if (isKeyword(first, "ATTACH")) refuse("ATTACH");
    if (isKeyword(first, "DETACH")) refuse("DETACH");
    if (isKeyword(first, "VACUUM") && statement.some((token) => isKeyword(token, "INTO"))) {
      refuse("VACUUM INTO");
    }
    if (isKeyword(first, "PRAGMA")) {
      const name =
        statement[at + 2]?.kind === "other" && statement[at + 2]!.text === "."
          ? statement[at + 3]
          : statement[at + 1];
      const pragma = identifierText(name);
      if (pragma !== null && DIRECTORY_PRAGMAS.has(pragma)) refuse(`PRAGMA ${pragma}`);
    }
    // No load_extension() check: telling a call from a table or CTE of that
    // name takes a parser, node:sqlite never enables extension loading, and
    // the authorizer refuses the function where it exists.
  }
}

/**
 * The connection-level form of `assertNoFileAccess`, which SQLite consults
 * for every statement it compiles — and for the `ATTACH` that `VACUUM INTO`
 * issues internally when it runs — so no spelling of the SQL gets past it.
 * A plain `VACUUM` attaches a private temporary database named "", which is
 * the one attach allowed. Exported for its test on a runtime that has
 * `setAuthorizer`.
 */
export function fileAccessAuthorizer(constants: Record<string, number>): SqliteAuthorizer | null {
  const { SQLITE_OK, SQLITE_DENY, SQLITE_ATTACH, SQLITE_DETACH, SQLITE_FUNCTION, SQLITE_PRAGMA } =
    constants;
  if (
    SQLITE_OK === undefined ||
    SQLITE_DENY === undefined ||
    SQLITE_ATTACH === undefined ||
    SQLITE_DETACH === undefined ||
    SQLITE_FUNCTION === undefined ||
    SQLITE_PRAGMA === undefined
  ) {
    return null;
  }
  return (action, arg1, arg2) => {
    if (action === SQLITE_ATTACH) return arg1 === "" ? SQLITE_OK : SQLITE_DENY;
    if (action === SQLITE_DETACH) return SQLITE_DENY;
    if (action === SQLITE_FUNCTION && arg2?.toLowerCase() === "load_extension") return SQLITE_DENY;
    if (action === SQLITE_PRAGMA && arg1 !== null && DIRECTORY_PRAGMAS.has(arg1.toLowerCase())) {
      return SQLITE_DENY;
    }
    return SQLITE_OK;
  };
}

/** Foreign keys on, for every connection that may write — `host.db` or an agent's declared write. */
const WRITABLE_CONNECTION_OPTIONS = { enableForeignKeyConstraints: true } as const;

/** SQLite's journal mode for the one a database declares. */
function journalModeOf(location: PluginDatabaseLocation): "WAL" | "DELETE" {
  return location.journalMode === "wal" ? "WAL" : "DELETE";
}

/**
 * The policy a connection gets before its first statement runs, whoever opens
 * it, so migrations and definitions are held to it as much as the plugin's own
 * queries are, and an agent's declared write no less than either: the
 * file-access authorizer, the lock wait, and — for a writable connection — the
 * declared journal mode. That one is enforced on every open: an agent that ran
 * `PRAGMA journal_mode=WAL` would otherwise leave committed data in a -wal
 * sidecar that a commit of the .db alone silently misses.
 */
function applyConnectionPolicy(
  connection: SqliteDatabase,
  authorizer: SqliteAuthorizer | null,
  journalMode: "WAL" | "DELETE" | null
): void {
  if (authorizer && typeof connection.setAuthorizer === "function") {
    connection.setAuthorizer(authorizer);
  }
  connection.exec("PRAGMA busy_timeout = 5000");
  if (journalMode !== null) connection.prepare(`PRAGMA journal_mode = ${journalMode}`).get();
}

function rollbackQuietly(connection: SqliteDatabase): void {
  try {
    connection.exec("ROLLBACK");
  } catch {
    // SQLite already rolled the transaction back
  }
}

/** SQLite's primary result code on a `node:sqlite` error, or null. */
function sqliteResultCode(error: unknown): number | null {
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  return typeof errcode === "number" ? errcode & 0xff : null;
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_CANTOPEN = 14;

function bindArgs(params: PluginDatabaseParams | undefined): unknown[] {
  if (params === undefined) return [];
  if (Array.isArray(params)) return params as unknown[];
  if (typeof params === "object" && params !== null) return [params];
  throw databaseError("VALIDATION", "params must be an array or an object of named values");
}

function toNumberIfSafe(value: number | bigint): number | bigint {
  if (
    typeof value === "bigint" &&
    value <= BigInt(Number.MAX_SAFE_INTEGER) &&
    value >= BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  return value;
}

/**
 * A plain, structured-clone-safe copy of a row (node:sqlite rows have a null
 * prototype). Integers are read as BigInt so a value past 2^53 is never
 * silently rounded; every one that fits comes back as a plain number.
 */
function plainRow<T>(row: unknown): T {
  if (!row || typeof row !== "object") return row as T;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    copy[key] = typeof value === "bigint" ? toNumberIfSafe(value) : value;
  }
  return copy as T;
}

/**
 * `prepare` compiles only the first statement and silently drops the rest, so
 * `query("SELECT 1; DELETE FROM t")` would quietly ignore the DELETE. Anything
 * but whitespace, semicolons and comments after the first statement is refused.
 */
function assertSingleStatement(sql: string, statement: SqliteStatement, id: string): void {
  const source = statement.sourceSQL;
  if (typeof source !== "string") return;
  const start = sql.indexOf(source);
  if (start < 0) return;
  const hidesStatement = lexSql(sql.slice(start + source.length)).some(
    (token) =>
      !(token.kind === "space" || token.kind === "semicolon") &&
      // SQLite runs a line comment on past a bare \r, but most editors break
      // the line there, so text after one reads as a statement SQLite skips.
      !(token.kind === "comment" && !(token.text.startsWith("--") && /\r\s*\S/.test(token.text)))
  );
  if (hidesStatement) {
    throw databaseError(
      "DB_MULTIPLE_STATEMENTS",
      `database "${id}": only one statement is allowed here; use exec() for a batch`
    );
  }
}

interface FileIdentity {
  dev: number;
  ino: number;
}

function readIdentity(filePath: string): FileIdentity | null {
  try {
    const s = fs.statSync(filePath);
    return { dev: s.dev, ino: s.ino };
  } catch {
    return null;
  }
}

const sameIdentity = (a: FileIdentity | null, b: FileIdentity | null): boolean =>
  a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;

/** Files SQLite pairs with a database by name, and replays into it on open. */
export const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

export type BackupDestinationProblem =
  | { kind: "source" }
  | { kind: "symlink" }
  | { kind: "not-file" }
  | { kind: "journal-name" }
  | { kind: "journal"; path: string };

/**
 * Why `target` cannot receive a snapshot of the database at `sourcePath`, or
 * null. Both writers of a backup — `PluginDatabase.backup` and the panel menu's
 * "Back up data…" — ask this before snapshotting and again just before
 * publishing, with `target`'s directory already canonical.
 *
 * - The source and its own journals, by name and by identity: writing over a
 *   live `-wal` or `-journal` destroys the recovery data of the database
 *   itself. Names are compared case-insensitively, since the common desktop
 *   disks are, and a journal that does not exist yet has no identity to test.
 * - A journal already beside the target belongs to whatever database was
 *   there before; SQLite would replay it into the snapshot the next time the
 *   copy is opened.
 */
export async function backupDestinationProblem(
  target: string,
  sourcePath: string
): Promise<BackupDestinationProblem | null> {
  const sourceFiles = [sourcePath, ...SQLITE_SIDECAR_SUFFIXES.map((s) => `${sourcePath}${s}`)];
  const targetName = path.resolve(target).toLowerCase();
  if (sourceFiles.some((file) => path.resolve(file).toLowerCase() === targetName)) {
    return { kind: "source" };
  }
  // A name SQLite reserves for some database's journal: writing a snapshot
  // there would replace another live database's recovery data.
  if (SQLITE_SIDECAR_SUFFIXES.some((suffix) => targetName.endsWith(suffix))) {
    return { kind: "journal-name" };
  }
  const leaf = await fs.promises.lstat(target).catch(() => null);
  if (leaf) {
    if (leaf.isSymbolicLink()) return { kind: "symlink" };
    if (!leaf.isFile()) return { kind: "not-file" };
    for (const file of sourceFiles) {
      const stat = await fs.promises.stat(file).catch(() => null);
      if (stat && sameIdentity(stat, leaf)) return { kind: "source" };
    }
  }
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const journal = `${target}${suffix}`;
    const present = await fs.promises.lstat(journal).catch(() => null);
    if (present) return { kind: "journal", path: journal };
  }
  return null;
}

const POLL_INTERVAL_MS = 1000;
/** Host-owned bookkeeping inside a plugin database; created only when `definitions` is used. */
const META_TABLE = "_daintree_meta";
const WATCH_SETTLE_MS = 75;
/** Window within which changes are delivered as one `onDidChange` event. */
const CHANGE_COALESCE_MS = 50;

export interface OpenPluginDatabaseOptions extends PluginDatabaseOpenOptions {
  /** Test seam: poll cadence for external-change detection. */
  pollIntervalMs?: number;
  /** Test seam: the window `onDidChange` coalesces changes within. */
  changeCoalesceMs?: number;
  /**
   * Re-prove the location before reopening a replaced file. The host passes
   * its resolver, so a checkout that swapped a directory on the path for a
   * symlink is refused on reopen exactly as it would be on first open.
   */
  revalidate?: () => Promise<PluginDatabaseLocation>;
  /** Called once when the handle closes, so an owner can stop tracking it. */
  onClosed?: () => void;
  /**
   * Approve a backup destination and return the absolute path to write. The
   * host passes its `host.fs` write gate (containment, capability, consent,
   * symlink refusal, audit); without it `backup` is unavailable.
   */
  prepareBackup?: (destPath: string) => Promise<string>;
}

/** Largest string or blob a {@link readPluginDatabaseRows} statement may produce. */
export const READ_MAX_VALUE_BYTES = 16 * 1024 * 1024;

/**
 * What an agent's connection proves before it opens: the file exists, since an
 * agent never creates a database (the plugin's own open does, under the
 * user's consent); it is not a link; and the directory the resolver proved
 * canonical has not been swapped for one since.
 */
function assertAgentOpenable(location: PluginDatabaseLocation): void {
  const leaf = fs.lstatSync(location.path, { throwIfNoEntry: false });
  if (leaf?.isSymbolicLink()) {
    throw databaseError("TARGET_IS_SYMLINK", `database "${location.id}" file is a symlink`);
  }
  if (!leaf) {
    throw databaseError("DB_NOT_FOUND", `database "${location.id}" does not exist yet`);
  }
  const dir = path.dirname(location.path);
  if (fs.realpathSync(dir) !== dir) {
    throw databaseError(
      "PATH_NOT_ALLOWED",
      `database "${location.id}" moved after it was resolved`
    );
  }
}

/**
 * Run one row-returning statement on a fresh readonly connection and hand each
 * row to `onRow` as an array aligned with the returned column names, until the
 * rows run out or `onRow` returns false. Rows are streamed rather than
 * collected, so a caller with a budget never materialises more than it keeps.
 *
 * For agents reading a plugin's database: the same file-access refusals and
 * single-statement rule as the handle, on a connection SQLite itself holds
 * readonly, and a statement that returns no rows is refused before it runs.
 * Integers come back as BigInt; the caller decides how to encode them.
 */
export function readPluginDatabaseRows(
  location: PluginDatabaseLocation,
  sql: string,
  params: PluginDatabaseParams | undefined,
  onRow: (row: unknown[]) => boolean
): { columns: string[] } {
  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw databaseError("VALIDATION", "sql must be a non-empty string");
  }
  assertNoFileAccess(sql, location.id);
  const args = bindArgs(params);
  const sqlite = loadSqlite();
  assertAgentOpenable(location);
  const connection = new sqlite.DatabaseSync(location.path, { readOnly: true });
  try {
    applyConnectionPolicy(
      connection,
      sqlite.constants ? fileAccessAuthorizer(sqlite.constants) : null,
      null
    );
    // A caller's row budget is checked only after SQLite has built a value, so
    // cap what it may build: `zeroblob(1e9)` fails instead of allocating.
    if (connection.limits) connection.limits.length = READ_MAX_VALUE_BYTES;
    const statement = connection.prepare(sql);
    assertSingleStatement(sql, statement, location.id);
    if (
      typeof statement.columns !== "function" ||
      typeof statement.iterate !== "function" ||
      typeof statement.setReturnArrays !== "function"
    ) {
      throw databaseError(
        "DB_UNSUPPORTED",
        "reading rows needs a runtime whose node:sqlite has StatementSync.iterate and setReturnArrays"
      );
    }
    const columns = statement.columns().map((c) => c.name);
    if (columns.length === 0) {
      throw databaseError(
        "DB_NOT_A_QUERY",
        `database "${location.id}": only statements that return rows can run here`
      );
    }
    statement.setReadBigInts?.(true);
    statement.setReturnArrays(true);
    const rows = statement.iterate(...args);
    try {
      for (const row of rows) {
        if (!onRow(row as unknown[])) break;
      }
    } finally {
      rows.return?.();
    }
    return { columns };
  } finally {
    connection.close();
  }
}

/**
 * The URI a declared write opens its file by: `mode=rw` opens read-write and
 * never creates. A UNC path's server goes into the path behind an empty
 * authority (`file:////server/share/…`), since SQLite refuses any authority
 * but `localhost`. URL parsing drops a `localhost` server altogether, which
 * would leave the path naming the local drive, so that one is put back from
 * the path itself. Exported for its test on either platform's paths.
 */
export function writableOpenUri(
  filePath: string,
  windows: boolean = process.platform === "win32"
): string {
  const url = pathToFileURL(filePath, { windows });
  const server =
    url.host !== ""
      ? url.host
      : windows && /^[\\/]{2}localhost[\\/]/i.test(filePath)
        ? "localhost"
        : "";
  return `file://${server === "" ? "" : `//${server}`}${url.pathname}?mode=rw`;
}

/**
 * Run one data-changing statement for an agent — a declared write query, the
 * SQL fixed by the manifest and only the values the agent's — and report what
 * it changed. Each row a `RETURNING` clause yields goes to `onRow`; every one
 * is stepped through, kept or not, so the statement always finishes.
 *
 * The connection gets the policy a writable `host.db` open applies, and the
 * statement runs in a transaction of its own, so a failure anywhere leaves
 * nothing behind. It opens only a file that exists. Being a connection of its
 * own, a `host.db` handle sees its commit as `origin: "external"`.
 */
export function runPluginDatabaseWrite(
  location: PluginDatabaseLocation,
  sql: string,
  params: PluginDatabaseParams | undefined,
  onRow: (row: unknown[]) => void
): { columns: string[]; changes: number; lastInsertRowid: number | bigint } {
  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw databaseError("VALIDATION", "sql must be a non-empty string");
  }
  assertNoFileAccess(sql, location.id);
  const args = bindArgs(params);
  const sqlite = loadSqlite();
  assertAgentOpenable(location);
  let connection: SqliteDatabase;
  try {
    // Opened without ever creating, so a file removed since the check above is
    // reported missing rather than brought back empty.
    connection = new sqlite.DatabaseSync(
      writableOpenUri(location.path),
      WRITABLE_CONNECTION_OPTIONS
    );
  } catch (error) {
    // An unreadable file or a directory fails the same way; only a file that
    // is not there is one the plugin has yet to create.
    if (
      sqliteResultCode(error) !== SQLITE_CANTOPEN ||
      fs.lstatSync(location.path, { throwIfNoEntry: false })
    ) {
      throw error;
    }
    throw databaseError("DB_NOT_FOUND", `database "${location.id}" does not exist yet`);
  }
  try {
    applyConnectionPolicy(
      connection,
      sqlite.constants ? fileAccessAuthorizer(sqlite.constants) : null,
      journalModeOf(location)
    );
    connection.exec("BEGIN IMMEDIATE");
    try {
      const statement = connection.prepare(sql);
      assertSingleStatement(sql, statement, location.id);
      if (
        typeof statement.columns !== "function" ||
        typeof statement.iterate !== "function" ||
        typeof statement.setReturnArrays !== "function"
      ) {
        throw databaseError(
          "DB_UNSUPPORTED",
          "writing needs a runtime whose node:sqlite has StatementSync.iterate and setReturnArrays"
        );
      }
      const columns = statement.columns().map((c) => c.name);
      statement.setReadBigInts?.(true);
      if (columns.length > 0) {
        statement.setReturnArrays(true);
        for (const row of statement.iterate(...args)) onRow(row as unknown[]);
      } else {
        statement.run(...args);
      }
      const counts = connection.prepare(
        "SELECT changes() AS changes, last_insert_rowid() AS rowid"
      );
      counts.setReadBigInts?.(true);
      const { changes, rowid } = counts.get() as {
        changes: number | bigint;
        rowid: number | bigint;
      };
      connection.exec("COMMIT");
      return { columns, changes: Number(changes), lastInsertRowid: toNumberIfSafe(rowid) };
    } catch (error) {
      rollbackQuietly(connection);
      throw error;
    }
  } catch (error) {
    const code = sqliteResultCode(error);
    if (code === SQLITE_BUSY || code === SQLITE_LOCKED) {
      throw databaseError(
        "DB_LOCKED",
        `database "${location.id}" is locked by another connection; nothing was written, so it is safe to try again`
      );
    }
    throw error;
  } finally {
    connection.close();
  }
}

/**
 * Open a resolved database. The location must come from
 * `resolvePluginDatabaseLocation` (directly in main, or relayed to the worker);
 * this function refuses a symlinked leaf itself and relies on `revalidate` to
 * re-prove the directories when it has to reopen.
 */
/**
 * Check the schema options of a `db.open` without touching any file. The host
 * runs it before resolving the location, so a malformed call is refused before
 * the project-write consent prompt can bank a grant for it (#10524).
 */
export function validatePluginDatabaseOpenOptions(
  id: string,
  options: PluginDatabaseOpenOptions = {}
): { migrations: readonly string[]; definitions: string | undefined; readonly: boolean } {
  if (options.migrations !== undefined && !Array.isArray(options.migrations)) {
    throw databaseError("VALIDATION", "migrations must be an array of SQL strings");
  }
  // A private copy: a reopen runs these again, and the array checked here must
  // be the one that runs, whatever the caller does to theirs afterwards.
  const migrations: readonly string[] = Object.freeze([...(options.migrations ?? [])]);
  if (migrations.some((m) => typeof m !== "string")) {
    throw databaseError("VALIDATION", "migrations must be an array of SQL strings");
  }
  const definitions = options.definitions;
  if (definitions !== undefined && typeof definitions !== "string") {
    throw databaseError("VALIDATION", "definitions must be a SQL string");
  }
  const readonly = options.readonly === true;
  if (readonly && (options.migrations !== undefined || definitions !== undefined)) {
    throw databaseError(
      "VALIDATION",
      "a readonly open cannot apply migrations or definitions; open it writable once to set the schema up"
    );
  }
  for (const sql of migrations) assertNoFileAccess(sql, id);
  if (definitions !== undefined) assertNoFileAccess(definitions, id);
  return { migrations, definitions, readonly };
}

export async function openPluginDatabase(
  location: PluginDatabaseLocation,
  options: OpenPluginDatabaseOptions = {}
): Promise<PluginDatabase> {
  const { migrations, definitions, readonly } = validatePluginDatabaseOpenOptions(
    location.id,
    options
  );
  const sqlite = loadSqlite();
  const DatabaseSync = sqlite.DatabaseSync;
  const authorizer = sqlite.constants ? fileAccessAuthorizer(sqlite.constants) : null;
  const filePath = location.path;
  const journalMode = journalModeOf(location);

  // The version is read under the write lock, so two processes opening the
  // same file at once cannot both run migration n.
  const migrate = (connection: SqliteDatabase): void => {
    for (;;) {
      connection.exec("BEGIN IMMEDIATE");
      let version: number;
      try {
        const row = connection.prepare("PRAGMA user_version").get() as
          { user_version?: number | bigint } | undefined;
        version = Number(row?.user_version ?? 0);
      } catch (error) {
        rollbackQuietly(connection);
        throw error;
      }
      if (version > migrations.length) {
        rollbackQuietly(connection);
        throw databaseError(
          "DB_SCHEMA_TOO_NEW",
          `database "${location.id}" is at schema version ${version}, but this plugin only knows ${migrations.length} migration(s)`
        );
      }
      if (version === migrations.length) {
        connection.exec("COMMIT");
        return;
      }
      try {
        connection.exec(migrations[version]!);
        connection.exec(`PRAGMA user_version = ${version + 1}`);
        connection.exec("COMMIT");
      } catch (error) {
        rollbackQuietly(connection);
        throw databaseError(
          "DB_MIGRATION_FAILED",
          `database "${location.id}" migration ${version + 1} failed: ${formatErrorMessage(error, "unknown error")}`
        );
      }
    }
  };

  // Re-applied only when the text changes. Rewriting unchanged views on every
  // open would modify the file each time a panel opens, so a committed
  // database would always show as changed in git. The hash lives in a small
  // host-owned table inside the database, read and written under the lock.
  //
  // The hash covers the schema version too. A migration that recreates a
  // table drops its triggers, so definitions applied at an older version prove
  // nothing — including when the process stopped between committing that
  // migration and re-applying them, which a flag held in memory would miss.
  const applyDefinitions = (connection: SqliteDatabase): void => {
    if (definitions === undefined) return;
    connection.exec("BEGIN IMMEDIATE");
    try {
      const versionRow = connection.prepare("PRAGMA user_version").get() as
        { user_version?: number | bigint } | undefined;
      const definitionsHash = createHash("sha256")
        .update(`${Number(versionRow?.user_version ?? 0)}\0${definitions}`)
        .digest("hex");
      const table = connection
        .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get(META_TABLE);
      const recorded = table
        ? (connection
            .prepare(`SELECT value FROM ${META_TABLE} WHERE key = 'definitions_sha256'`)
            .get() as { value?: string } | undefined)
        : undefined;
      if (recorded?.value === definitionsHash) {
        connection.exec("COMMIT");
        return;
      }
      connection.exec(definitions);
      connection.exec(
        `CREATE TABLE IF NOT EXISTS ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`
      );
      connection
        .prepare(
          `INSERT INTO ${META_TABLE} (key, value) VALUES ('definitions_sha256', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        )
        .run(definitionsHash);
      connection.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(connection);
      throw databaseError(
        "DB_DEFINITIONS_FAILED",
        `database "${location.id}" definitions failed: ${formatErrorMessage(error, "unknown error")}`
      );
    }
  };

  // One procedure for the first open and every reopen, so a file swapped in
  // by `git checkout` gets the same policy, version check and migrations as
  // the one the plugin started with.
  const initializeOnce = (): {
    connection: SqliteDatabase;
    identity: FileIdentity | null;
    stable: boolean;
    created: boolean;
  } => {
    const leaf = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (leaf?.isSymbolicLink()) {
      throw databaseError("TARGET_IS_SYMLINK", `database "${location.id}" file is a symlink`);
    }
    const before = readIdentity(filePath);
    let connection: SqliteDatabase | null = null;
    try {
      if (readonly && !leaf) {
        throw databaseError("DB_NOT_FOUND", `database "${location.id}" does not exist yet`);
      }
      connection = new DatabaseSync(filePath, {
        ...WRITABLE_CONNECTION_OPTIONS,
        ...(readonly && { readOnly: true }),
      });
      const opened = readIdentity(filePath);
      applyConnectionPolicy(connection, authorizer, readonly ? null : journalMode);
      if (!readonly) {
        migrate(connection);
        applyDefinitions(connection);
      }
      const after = readIdentity(filePath);
      // The path must name one file from before the open to after it, or the
      // recorded identity could belong to a replacement the connection never
      // saw — and it would then never notice the next one. A file this open
      // created has no `before` to prove that with, so it is never trusted:
      // the next attempt opens it as an existing file.
      const stable = sameIdentity(before, opened) && sameIdentity(opened, after);
      return { connection, identity: after, stable, created: before === null };
    } catch (error) {
      try {
        connection?.close();
      } catch {
        // never opened
      }
      throw error;
    }
  };

  const initialize = (): { connection: SqliteDatabase; identity: FileIdentity | null } => {
    // Three unstable opens of an existing file give up; a creating open is
    // always followed by one more and does not count, within a hard cap.
    for (let attempt = 0, unstable = 0; attempt < 6 && unstable < 3; attempt++) {
      const result = initializeOnce();
      if (result.stable) return result;
      if (!result.created) unstable++;
      try {
        result.connection.close();
      } catch {
        // already closed
      }
    }
    throw databaseError(
      "TARGET_UNAVAILABLE",
      `database "${location.id}" kept being replaced while it was opening`
    );
  };

  let { connection: db, identity } = initialize();
  let closed = false;

  const readDataVersion = (): number => {
    const row = db.prepare("PRAGMA data_version").get() as
      { data_version?: number | bigint } | undefined;
    return Number(row?.data_version ?? 0);
  };
  // This connection's own writes. Our commits never advance `data_version`
  // (it counts OTHER connections), so `total_changes()` is how a write made
  // through query/get (`INSERT … RETURNING`) is still announced — and
  // `schema_version` how DDL is, which changes no rows.
  interface WriteMarks {
    changes: number;
    schema: number;
    dataVersion: number;
  }
  const readWriteMarks = (): WriteMarks => {
    const changes = db.prepare("SELECT total_changes() AS n").get() as
      { n?: number | bigint } | undefined;
    const schema = db.prepare("PRAGMA schema_version").get() as
      { schema_version?: number | bigint } | undefined;
    return {
      changes: Number(changes?.n ?? 0),
      schema: Number(schema?.schema_version ?? 0),
      dataVersion: readDataVersion(),
    };
  };
  // `schema_version` is the file's, not this connection's: a schema change
  // counts as ours only when no other connection committed in between, so
  // an agent's `CREATE VIEW` is left for the external check to announce.
  const wroteSince = (before: WriteMarks, after: WriteMarks): boolean =>
    after.changes !== before.changes ||
    (after.schema !== before.schema && after.dataVersion === before.dataVersion);

  let lastDataVersion = readDataVersion();

  // A replaced file (new device/inode) is invisible to an open connection,
  // which keeps reading the unlinked one. A deleted file is treated the same:
  // reopening recreates it and runs the migrations.
  const needsReopen = (): boolean => {
    const now = readIdentity(filePath);
    if (now === null || identity === null) return true;
    return now.dev !== identity.dev || now.ino !== identity.ino;
  };

  const reopen = async (): Promise<void> => {
    if (options.revalidate) {
      const revalidated = await options.revalidate();
      if (revalidated.path !== filePath) {
        throw databaseError(
          "TARGET_UNAVAILABLE",
          `database "${location.id}" no longer resolves to ${filePath}`
        );
      }
    }
    try {
      db.close();
    } catch {
      // already closed by a failed reopen
    }
    // If this throws, the old connection stays closed and the identity stays
    // stale, so the next call tries the reopen again rather than reading the
    // unlinked file.
    const next = initialize();
    db = next.connection;
    identity = next.identity;
    lastDataVersion = readDataVersion();
  };

  // ── change detection ──
  const listeners = new Set<(event: PluginDatabaseChangeEvent) => void>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let watcher: fs.FSWatcher | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  // One event per window, not per commit: a plugin that refetches on change
  // would otherwise refetch once per awaited insert. Fixed from the first
  // change rather than trailing, so a steady stream of writes still reports
  // within one window.
  let pendingOrigin: PluginDatabaseChangeEvent["origin"] | null = null;
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  const flushChanges = (): void => {
    coalesceTimer = null;
    const origin = pendingOrigin;
    pendingOrigin = null;
    if (origin === null || closed) return;
    for (const listener of [...listeners]) {
      try {
        listener(Object.freeze({ origin }));
      } catch (error) {
        console.error(`[plugin-db:${location.id}] change listener threw:`, error);
      }
    }
  };
  const emit = (origin: PluginDatabaseChangeEvent["origin"]): void => {
    // An external change anywhere in the window wins: a listener that skips
    // its own writes must still see what someone else wrote.
    if (pendingOrigin !== "external") pendingOrigin = origin;
    if (coalesceTimer) return;
    coalesceTimer = setTimeout(flushChanges, options.changeCoalesceMs ?? CHANGE_COALESCE_MS);
    coalesceTimer.unref?.();
  };
  const cancelPendingChanges = (): void => {
    if (coalesceTimer) clearTimeout(coalesceTimer);
    coalesceTimer = null;
    pendingOrigin = null;
  };

  // ── serialisation ──
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T> | T): Promise<T> => {
    const next = queue.then(async () => {
      if (closed) throw databaseError("DB_CLOSED", `database "${location.id}" is closed`);
      return await work();
    });
    queue = next.catch(() => undefined);
    return next;
  };

  let checking = false;
  const checkExternal = (): void => {
    if (closed || checking) return;
    checking = true;
    // Through the queue, like every statement, so a reopen can never land in
    // the middle of a transaction.
    serialize(async () => {
      if (needsReopen()) {
        await reopen();
        emit("external");
        return;
      }
      const version = readDataVersion();
      if (version !== lastDataVersion) {
        lastDataVersion = version;
        emit("external");
      }
    })
      .catch((error: unknown) => {
        // A file mid-replace or briefly locked; the next tick tries again.
        if (process.env.DAINTREE_VERBOSE) {
          console.warn(`[plugin-db:${location.id}] change check failed:`, error);
        }
      })
      .finally(() => {
        checking = false;
      });
  };

  const startWatching = (): void => {
    if (pollTimer || closed) return;
    pollTimer = setInterval(checkExternal, options.pollIntervalMs ?? POLL_INTERVAL_MS);
    pollTimer.unref?.();
    try {
      const base = path.basename(filePath);
      watcher = fs.watch(path.dirname(filePath), (_event, name) => {
        if (name && !String(name).startsWith(base)) return;
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(checkExternal, WATCH_SETTLE_MS);
      });
      watcher.on("error", () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      // The poll alone still detects changes, just more slowly.
      watcher = null;
    }
  };

  const stopWatching = (): void => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
    watcher?.close();
    watcher = null;
  };

  const prepare = (sql: string): SqliteStatement => {
    assertNoFileAccess(sql, location.id);
    const statement = db.prepare(sql);
    assertSingleStatement(sql, statement, location.id);
    statement.setReadBigInts?.(true);
    return statement;
  };
  const assertWritable = (op: string): void => {
    if (readonly) {
      throw databaseError(
        "DB_READONLY",
        `database "${location.id}" is open readonly; ${op} is refused`
      );
    }
  };

  // `markWrite` flags a batch that may have written without moving
  // `total_changes()` — DDL, or statements before the one that failed.
  const statements = (markWrite: () => void): PluginDatabaseStatements => ({
    query: async <T>(sql: string, params?: PluginDatabaseParams) =>
      prepare(sql)
        .all(...bindArgs(params))
        .map((row) => plainRow<T>(row)),
    get: async <T>(sql: string, params?: PluginDatabaseParams) => {
      const row = prepare(sql).get(...bindArgs(params));
      return row === undefined ? undefined : plainRow<T>(row);
    },
    columns: async (sql: string) => {
      const statement = prepare(sql);
      // Reporting [] would read as "no columns"; say the runtime cannot tell.
      if (typeof statement.columns !== "function") {
        throw databaseError(
          "DB_UNSUPPORTED",
          "columns() needs a runtime whose node:sqlite has StatementSync.columns (Node 22.16+)"
        );
      }
      return statement.columns().map((c) => ({
        name: c.name,
        table: c.table ?? null,
        column: c.column ?? null,
        type: c.type ?? null,
      }));
    },
    run: async (sql: string, params?: PluginDatabaseParams): Promise<PluginDatabaseRunResult> => {
      assertWritable("run");
      const result = prepare(sql).run(...bindArgs(params));
      return {
        changes: Number(result.changes),
        lastInsertRowid: toNumberIfSafe(result.lastInsertRowid),
      };
    },
    exec: async (sql: string) => {
      assertWritable("exec");
      assertNoFileAccess(sql, location.id);
      try {
        db.exec(sql);
      } finally {
        markWrite();
      }
    },
  });

  interface WriteTracker {
    /** A statement that may have written without moving `total_changes()`. */
    markWrite(): void;
    /** The work rolled back; nothing it did happened. */
    markRolledBack(): void;
  }

  // Every public call: reopen a replaced file first, run, then announce a
  // write if one happened. `total_changes()` also counts rows a rollback
  // undid, so a rolled-back transaction announces nothing.
  const run = <R>(work: (tracker: WriteTracker) => Promise<R>): Promise<R> =>
    serialize(async () => {
      if (needsReopen()) {
        await reopen();
        emit("external");
      }
      const before = readWriteMarks();
      let wrote = false;
      let rolledBack = false;
      try {
        return await work({
          markWrite: () => {
            wrote = true;
          },
          markRolledBack: () => {
            rolledBack = true;
          },
        });
      } finally {
        let changed = wrote;
        try {
          changed ||= wroteSince(before, readWriteMarks());
        } catch {
          // the connection is gone; nothing to announce
        }
        if (changed && !rolledBack) emit("self");
      }
    });

  const handle: PluginDatabase = {
    id: location.id,
    location: Object.freeze({ ...location }),
    readonly,
    query: ((sql: string, params?: PluginDatabaseParams) =>
      run((t) => statements(t.markWrite).query(sql, params))) as PluginDatabase["query"],
    get: ((sql: string, params?: PluginDatabaseParams) =>
      run((t) => statements(t.markWrite).get(sql, params))) as PluginDatabase["get"],
    run: (sql, params) => run((t) => statements(t.markWrite).run(sql, params)),
    exec: (sql) => run((t) => statements(t.markWrite).exec(sql)),
    columns: (sql) => run((t) => statements(t.markWrite).columns(sql)),
    transaction: <T>(fn: (tx: PluginDatabaseStatements) => Promise<T> | T) =>
      run(async (t) => {
        assertWritable("transaction");
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = await fn(statements(t.markWrite));
          db.exec("COMMIT");
          return result;
        } catch (error) {
          rollbackQuietly(db);
          t.markRolledBack();
          throw error;
        }
      }),
    onDidChange: (callback) => {
      if (typeof callback !== "function") {
        throw databaseError("VALIDATION", "onDidChange requires a callback function");
      }
      listeners.add(callback);
      startWatching();
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        listeners.delete(callback);
        if (listeners.size === 0) {
          stopWatching();
          cancelPendingChanges();
        }
      };
    },
    backup: async (destPath: string) => {
      if (typeof destPath !== "string" || destPath.length === 0) {
        throw databaseError("VALIDATION", "backup requires a destination path");
      }
      if (!options.prepareBackup) {
        throw databaseError("DB_UNSUPPORTED", "this host cannot approve a backup destination");
      }
      const target = await options.prepareBackup(destPath);
      const assertDestination = async (): Promise<void> => {
        const problem = await backupDestinationProblem(target, filePath);
        if (problem?.kind === "source") {
          throw databaseError(
            "VALIDATION",
            "a backup cannot overwrite the database itself or its journal"
          );
        }
        if (problem?.kind === "symlink") {
          throw databaseError("TARGET_IS_SYMLINK", "refusing to replace a symlink with a backup");
        }
        if (problem?.kind === "not-file") {
          throw databaseError("TARGET_UNAVAILABLE", "the backup destination is not a regular file");
        }
        if (problem?.kind === "journal-name") {
          throw databaseError(
            "VALIDATION",
            "a backup cannot be named like a database journal (-wal, -shm, -journal)"
          );
        }
        if (problem?.kind === "journal") {
          throw databaseError(
            "DESTINATION_HAS_JOURNAL",
            `${path.basename(problem.path)} is beside the destination, and SQLite would replay it into the copy`
          );
        }
      };
      await assertDestination();
      const sqlite = process.getBuiltinModule("node:sqlite") as
        { backup?: (db: unknown, dest: string) => Promise<number> } | undefined;
      if (typeof sqlite?.backup !== "function") {
        throw databaseError("DB_UNSUPPORTED", "this runtime's node:sqlite has no backup()");
      }
      // Snapshot into a directory created exclusively beside the destination
      // (nothing can be waiting at its name), then rename, so a reader or a
      // sync client never sees a half-written copy.
      const parent = path.dirname(target);
      const assertParentUnmoved = (): void => {
        // The host approved `parent` as a realpath; a directory on the way
        // swapped for a link since would resolve somewhere else now.
        if (fs.realpathSync(parent) !== parent) {
          throw databaseError(
            "TARGET_UNAVAILABLE",
            "the backup destination moved after it was approved"
          );
        }
      };
      return serialize(async () => {
        if (needsReopen()) await reopen();
        assertParentUnmoved();
        const stage = fs.mkdtempSync(path.join(parent, ".daintree-backup-"));
        const temp = path.join(stage, "snapshot.db");
        try {
          await sqlite.backup!(db, temp);
          // Again at the last moment: the snapshot can take long enough for
          // another process to open a database at the destination. The parent
          // is checked after the awaited leaf check so nothing async separates
          // it from the rename.
          await assertDestination();
          assertParentUnmoved();
          fs.renameSync(temp, target);
        } finally {
          fs.rmSync(stage, { recursive: true, force: true });
        }
        return { path: target, bytes: fs.statSync(target).size };
      });
    },
    close: async () => {
      if (closed) return;
      await queue;
      if (closed) return;
      // The last change is always delivered, even when the handle closes
      // inside its window.
      if (coalesceTimer) {
        clearTimeout(coalesceTimer);
        flushChanges();
      }
      closed = true;
      stopWatching();
      cancelPendingChanges();
      listeners.clear();
      try {
        db.close();
      } catch {
        // already closed
      }
      options.onClosed?.();
    },
  };
  return handle;
}
