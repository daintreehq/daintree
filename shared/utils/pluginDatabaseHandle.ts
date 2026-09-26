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
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  setReadBigInts?(enabled: boolean): void;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type DatabaseSyncCtor = new (
  path: string,
  options?: { enableForeignKeyConstraints?: boolean; readOnly?: boolean }
) => SqliteDatabase;

let cachedCtor: DatabaseSyncCtor | null = null;
function loadDatabaseSync(): DatabaseSyncCtor {
  if (cachedCtor) return cachedCtor;
  // Loaded lazily so a runtime without `node:sqlite` fails the first `open`
  // with a clear message instead of failing every import of the host.
  try {
    const sqlite = process.getBuiltinModule("node:sqlite") as
      { DatabaseSync?: DatabaseSyncCtor } | undefined;
    if (!sqlite?.DatabaseSync) throw new Error("node:sqlite is not built into this runtime");
    cachedCtor = sqlite.DatabaseSync;
  } catch (error) {
    throw databaseError(
      "SQLITE_UNAVAILABLE",
      `this plugin runtime has no node:sqlite (${formatErrorMessage(error, "unknown error")})`
    );
  }
  return cachedCtor;
}

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
  const tail = sql
    .slice(start + source.length)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // SQLite ends a line comment at \n or \r, so a \r must not hide a statement.
    .replace(/--[^\r\n]*/g, "")
    .replace(/[\s;]+/g, "");
  if (tail.length > 0) {
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

const POLL_INTERVAL_MS = 1000;
/** Host-owned bookkeeping inside a plugin database; created only when `definitions` is used. */
const META_TABLE = "_daintree_meta";
const WATCH_SETTLE_MS = 75;

export interface OpenPluginDatabaseOptions extends PluginDatabaseOpenOptions {
  /** Test seam: poll cadence for external-change detection. */
  pollIntervalMs?: number;
  /**
   * Re-prove the location before reopening a replaced file. The host passes
   * its resolver, so a checkout that swapped a directory on the path for a
   * symlink is refused on reopen exactly as it would be on first open.
   */
  revalidate?: () => Promise<PluginDatabaseLocation>;
  /** Called once when the handle closes, so an owner can stop tracking it. */
  onClosed?: () => void;
}

/**
 * Open a resolved database. The location must come from
 * `resolvePluginDatabaseLocation` (directly in main, or relayed to the worker);
 * this function refuses a symlinked leaf itself and relies on `revalidate` to
 * re-prove the directories when it has to reopen.
 */
export async function openPluginDatabase(
  location: PluginDatabaseLocation,
  options: OpenPluginDatabaseOptions = {}
): Promise<PluginDatabase> {
  const migrations = options.migrations ?? [];
  if (!Array.isArray(migrations) || migrations.some((m) => typeof m !== "string")) {
    throw databaseError("VALIDATION", "migrations must be an array of SQL strings");
  }
  if (options.definitions !== undefined && typeof options.definitions !== "string") {
    throw databaseError("VALIDATION", "definitions must be a SQL string");
  }
  const readonly = options.readonly === true;
  if (readonly && (options.migrations !== undefined || options.definitions !== undefined)) {
    throw databaseError(
      "VALIDATION",
      "a readonly open cannot apply migrations or definitions; open it writable once to set the schema up"
    );
  }
  const DatabaseSync = loadDatabaseSync();
  const filePath = location.path;
  const journalMode = location.journalMode === "wal" ? "WAL" : "DELETE";

  const rollbackQuietly = (connection: SqliteDatabase): void => {
    try {
      connection.exec("ROLLBACK");
    } catch {
      // SQLite already rolled the transaction back
    }
  };

  // The version is read under the write lock, so two processes opening the
  // same file at once cannot both run migration n.
  /** Returns whether any migration ran. */
  const migrate = (connection: SqliteDatabase): boolean => {
    let advanced = false;
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
        return advanced;
      }
      try {
        connection.exec(migrations[version]!);
        connection.exec(`PRAGMA user_version = ${version + 1}`);
        connection.exec("COMMIT");
        advanced = true;
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
  const definitionsHash =
    options.definitions === undefined
      ? null
      : createHash("sha256").update(options.definitions).digest("hex");
  // `force` after a migration ran: recreating a table drops its triggers, so
  // an unchanged hash no longer proves the definitions are in place.
  const applyDefinitions = (connection: SqliteDatabase, force: boolean): void => {
    if (options.definitions === undefined || definitionsHash === null) return;
    connection.exec("BEGIN IMMEDIATE");
    try {
      const table = connection
        .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get(META_TABLE);
      const recorded = table
        ? (connection
            .prepare(`SELECT value FROM ${META_TABLE} WHERE key = 'definitions_sha256'`)
            .get() as { value?: string } | undefined)
        : undefined;
      if (!force && recorded?.value === definitionsHash) {
        connection.exec("COMMIT");
        return;
      }
      connection.exec(options.definitions);
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
        enableForeignKeyConstraints: true,
        ...(readonly && { readOnly: true }),
      });
      connection.exec("PRAGMA busy_timeout = 5000");
      if (readonly) return { connection, identity: readIdentity(filePath), stable: true };
      // Enforced on every open: an agent that ran `PRAGMA journal_mode=WAL`
      // would otherwise leave committed data in a -wal sidecar that a commit
      // of the .db alone silently misses.
      connection.prepare(`PRAGMA journal_mode = ${journalMode}`).get();
      const migrated = migrate(connection);
      applyDefinitions(connection, migrated);
      const after = readIdentity(filePath);
      // A file created by this open has no `before`; otherwise the path must
      // still name the file the connection opened, or the recorded identity
      // would belong to a replacement the connection never saw.
      const stable =
        after !== null &&
        (before === null || (before.dev === after.dev && before.ino === after.ino));
      return { connection, identity: after, stable };
    } catch (error) {
      try {
        connection?.close();
      } catch {
        // never opened
      }
      throw error;
    }
  };

  // One procedure for the first open and every reopen, so a file swapped in
  // by `git checkout` gets the same policy, version check and migrations as
  // the one the plugin started with.
  const initialize = (): { connection: SqliteDatabase; identity: FileIdentity | null } => {
    for (let attempt = 0; ; attempt++) {
      const result = initializeOnce();
      if (result.stable || attempt >= 2) return result;
      try {
        result.connection.close();
      } catch {
        // already closed
      }
    }
  };

  let { connection: db, identity } = initialize();
  let closed = false;

  const readDataVersion = (): number => {
    const row = db.prepare("PRAGMA data_version").get() as
      { data_version?: number | bigint } | undefined;
    return Number(row?.data_version ?? 0);
  };
  // Counts this connection's own row changes. Our commits never advance
  // `data_version` (it counts OTHER connections), so this is how a write made
  // through query/get (`INSERT … RETURNING`) is still announced.
  const readTotalChanges = (): number => {
    const row = db.prepare("SELECT total_changes() AS n").get() as
      { n?: number | bigint } | undefined;
    return Number(row?.n ?? 0);
  };

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

  const emit = (origin: PluginDatabaseChangeEvent["origin"]): void => {
    queueMicrotask(() => {
      for (const listener of [...listeners]) {
        try {
          listener(Object.freeze({ origin }));
        } catch (error) {
          console.error(`[plugin-db:${location.id}] change listener threw:`, error);
        }
      }
    });
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
      const before = readTotalChanges();
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
          changed ||= readTotalChanges() !== before;
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
        if (listeners.size === 0) stopWatching();
      };
    },
    close: async () => {
      if (closed) return;
      await queue;
      if (closed) return;
      closed = true;
      stopWatching();
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
