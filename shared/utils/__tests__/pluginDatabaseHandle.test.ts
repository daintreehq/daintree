import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileAccessAuthorizer, openPluginDatabase } from "../pluginDatabaseHandle.js";
import type { PluginDatabase, PluginDatabaseLocation } from "../../types/plugin.js";

// A second connection standing in for an agent's `sqlite3` session: a separate
// connection in the same process is enough to advance `data_version`.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const SQLITE3_CLI = (() => {
  try {
    return execFileSync("which", ["sqlite3"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
})();

let dir: string;
let location: PluginDatabaseLocation;
const handles: PluginDatabase[] = [];

async function open(options?: Parameters<typeof openPluginDatabase>[1]) {
  const db = await openPluginDatabase(location, { pollIntervalMs: 25, ...options });
  handles.push(db);
  return db;
}

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-db-"));
  location = {
    id: "ledger",
    location: "local",
    path: path.join(dir, "ledger.db"),
    projectRelativePath: null,
    journalMode: "delete",
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) await handle.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("openPluginDatabase", () => {
  it("applies migrations once and records the schema version", async () => {
    const migrations = [
      "CREATE TABLE tx (id INTEGER PRIMARY KEY, cents INTEGER NOT NULL)",
      "ALTER TABLE tx ADD COLUMN memo TEXT",
    ];
    const first = await open({ migrations });
    await first.run("INSERT INTO tx (cents, memo) VALUES (?, ?)", [-4250, "lunch"]);
    await first.close();

    const second = await open({ migrations });
    expect(await second.get("PRAGMA user_version")).toEqual({ user_version: 2 });
    expect(await second.query("SELECT cents, memo FROM tx")).toEqual([
      { cents: -4250, memo: "lunch" },
    ]);
  });

  it("refuses a file written by a newer schema", async () => {
    const db = await open({ migrations: ["CREATE TABLE a (x)", "CREATE TABLE b (x)"] });
    await db.close();
    await expect(open({ migrations: ["CREATE TABLE a (x)"] })).rejects.toMatchObject({
      code: "DB_SCHEMA_TOO_NEW",
    });
  });

  it("rolls a failed migration back and names it", async () => {
    await expect(
      open({ migrations: ["CREATE TABLE ok (x)", "CREATE TABLE broken ("] })
    ).rejects.toMatchObject({ code: "DB_MIGRATION_FAILED" });
    const db = await open({ migrations: ["CREATE TABLE ok (x)"] });
    expect(await db.get("PRAGMA user_version")).toEqual({ user_version: 1 });
  });

  it("re-applies definitions on every open so a view can change without a migration", async () => {
    const migrations = ["CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2)"];
    const first = await open({
      migrations,
      definitions: "DROP VIEW IF EXISTS total; CREATE VIEW total AS SELECT sum(x) AS n FROM t",
    });
    expect(await first.get("SELECT n FROM total")).toEqual({ n: 3 });
    await first.close();
    const second = await open({
      migrations,
      definitions: "DROP VIEW IF EXISTS total; CREATE VIEW total AS SELECT max(x) AS n FROM t",
    });
    expect(await second.get("SELECT n FROM total")).toEqual({ n: 2 });
    await expect(open({ migrations, definitions: "CREATE VIEW (" })).rejects.toMatchObject({
      code: "DB_DEFINITIONS_FAILED",
    });
  });

  it("leaves the file untouched when the definitions have not changed", async () => {
    const options = {
      migrations: ["CREATE TABLE t (x INTEGER)"],
      definitions: "DROP VIEW IF EXISTS v; CREATE VIEW v AS SELECT x FROM t",
    };
    await (await open(options)).close();
    const before = fs.readFileSync(location.path);
    await (await open(options)).close();
    expect(fs.readFileSync(location.path).equals(before)).toBe(true);
  });

  it("restores triggers a later migration dropped by recreating their table", async () => {
    const definitions =
      "CREATE TRIGGER IF NOT EXISTS no_negatives BEFORE INSERT ON t WHEN NEW.x < 0 BEGIN SELECT RAISE(ABORT, 'x must be >= 0'); END";
    await (await open({ migrations: ["CREATE TABLE t (x INTEGER)"], definitions })).close();
    const db = await open({
      migrations: [
        "CREATE TABLE t (x INTEGER)",
        "DROP TABLE t; CREATE TABLE t (x INTEGER, memo TEXT)",
      ],
      definitions,
    });
    await expect(db.run("INSERT INTO t (x) VALUES (-1)")).rejects.toThrow(/x must be >= 0/);
  });

  it("enforces foreign keys and the declared journal mode", async () => {
    const db = await open({
      migrations: [
        "CREATE TABLE cat (id TEXT PRIMARY KEY); CREATE TABLE tx (cat TEXT REFERENCES cat(id))",
      ],
    });
    await expect(db.run("INSERT INTO tx (cat) VALUES ('nope')")).rejects.toThrow(/FOREIGN KEY/);
    expect(await db.get("PRAGMA journal_mode")).toEqual({ journal_mode: "delete" });
  });

  it("switches a file an agent left in WAL back to the declared mode", async () => {
    const agent = new DatabaseSync(location.path);
    agent.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x)");
    agent.close();
    const db = await open();
    expect(await db.get("PRAGMA journal_mode")).toEqual({ journal_mode: "delete" });
  });

  it("commits a transaction atomically and rolls back on throw", async () => {
    const db = await open({ migrations: ["CREATE TABLE t (x INTEGER)"] });
    await db.transaction(async (tx) => {
      await tx.run("INSERT INTO t VALUES (1)");
      await tx.run("INSERT INTO t VALUES (2)");
    });
    await expect(
      db.transaction(async (tx) => {
        await tx.run("INSERT INTO t VALUES (3)");
        throw new Error("abort");
      })
    ).rejects.toThrow("abort");
    expect(await db.query("SELECT x FROM t ORDER BY x")).toEqual([{ x: 1 }, { x: 2 }]);
  });

  it("serialises outer calls behind a running transaction", async () => {
    const db = await open({ migrations: ["CREATE TABLE t (x INTEGER)"] });
    const order: string[] = [];
    const tx = db.transaction(async (t) => {
      await t.run("INSERT INTO t VALUES (1)");
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("tx");
    });
    const read = db.query("SELECT count(*) AS n FROM t").then((rows) => {
      order.push("read");
      return rows;
    });
    await tx;
    expect(await read).toEqual([{ n: 1 }]);
    expect(order).toEqual(["tx", "read"]);
  });

  it("reports its own writes as self", async () => {
    const db = await open({ migrations: ["CREATE TABLE t (x INTEGER)"] });
    const events: string[] = [];
    const dispose = db.onDidChange((event) => events.push(event.origin));
    await db.run("INSERT INTO t VALUES (1)");
    await waitFor(() => events.length > 0);
    expect(events).toEqual(["self"]);
    dispose();
  });

  it("notices a commit from another connection, as an agent's sqlite3 would make", async () => {
    const db = await open({ migrations: ["CREATE TABLE t (x INTEGER)"] });
    const events: string[] = [];
    db.onDidChange((event) => events.push(event.origin));
    const agent = new DatabaseSync(location.path);
    agent.exec("INSERT INTO t VALUES (42)");
    agent.close();
    await waitFor(() => events.includes("external"));
    expect(await db.query("SELECT x FROM t")).toEqual([{ x: 42 }]);
  });

  it.skipIf(!SQLITE3_CLI)("notices a sqlite3 CLI write from another process", async () => {
    const cli = SQLITE3_CLI!;
    const db = await open({ migrations: ["CREATE TABLE t (x INTEGER)"] });
    const events: string[] = [];
    db.onDidChange((event) => events.push(event.origin));
    execFileSync(cli, [location.path, "INSERT INTO t VALUES (7)"]);
    await waitFor(() => events.includes("external"));
    expect(await db.query("SELECT x FROM t")).toEqual([{ x: 7 }]);
  });

  it("reopens when the file is replaced underneath it", async () => {
    const db = await open({ migrations: ["CREATE TABLE t (x INTEGER)"] });
    await db.run("INSERT INTO t VALUES (1)");
    // What `git checkout -- data.db` or a reset script does: a new inode.
    const replacement = path.join(dir, "replacement.db");
    const other = new DatabaseSync(replacement);
    other.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (99); PRAGMA user_version = 1");
    other.close();
    fs.renameSync(replacement, location.path);
    expect(await db.query("SELECT x FROM t")).toEqual([{ x: 99 }]);
  });

  it("migrates a file swapped in at an older schema version", async () => {
    const migrations = ["CREATE TABLE t (x INTEGER)", "ALTER TABLE t ADD COLUMN memo TEXT"];
    const db = await open({ migrations });
    // An older checkout of the database: schema version 1, no memo column.
    const older = path.join(dir, "older.db");
    const other = new DatabaseSync(older);
    other.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (5); PRAGMA user_version = 1");
    other.close();
    fs.renameSync(older, location.path);
    await db.run("UPDATE t SET memo = 'migrated' WHERE x = 5");
    expect(await db.get("SELECT x, memo FROM t")).toEqual({ x: 5, memo: "migrated" });
    expect(await db.get("PRAGMA user_version")).toEqual({ user_version: 2 });
  });

  it("refuses a file swapped in from a newer schema instead of writing to it", async () => {
    const db = await open({ migrations: ["CREATE TABLE t (x INTEGER)"] });
    const newer = path.join(dir, "newer.db");
    const other = new DatabaseSync(newer);
    other.exec("CREATE TABLE t (x INTEGER); PRAGMA user_version = 7");
    other.close();
    fs.renameSync(newer, location.path);
    await expect(db.run("INSERT INTO t VALUES (1)")).rejects.toMatchObject({
      code: "DB_SCHEMA_TOO_NEW",
    });
  });

  it("re-proves the location through revalidate before reopening", async () => {
    let calls = 0;
    const db = await open({
      migrations: ["CREATE TABLE t (x INTEGER)"],
      revalidate: async () => {
        calls++;
        throw Object.assign(new Error("PATH_NOT_ALLOWED: escaped"), { code: "PATH_NOT_ALLOWED" });
      },
    });
    const replacement = path.join(dir, "r.db");
    new DatabaseSync(replacement).close();
    fs.renameSync(replacement, location.path);
    await expect(db.query("SELECT 1")).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    expect(calls).toBe(1);
  });

  it("recreates and migrates a database deleted underneath it", async () => {
    const db = await open({ migrations: ["CREATE TABLE t (x INTEGER)"] });
    await db.run("INSERT INTO t VALUES (1)");
    fs.rmSync(location.path);
    expect(await db.query("SELECT x FROM t")).toEqual([]);
    expect(fs.existsSync(location.path)).toBe(true);
  });

  it("keeps integers past 2^53 exact", async () => {
    const db = await open({ migrations: ["CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)"] });
    const big = 9007199254740993n;
    const result = await db.run("INSERT INTO t (id, n) VALUES (?, ?)", [big, 42]);
    expect(result.lastInsertRowid).toBe(big);
    expect(await db.get("SELECT id, n FROM t")).toEqual({ id: big, n: 42 });
  });

  it("announces a write made through query as self", async () => {
    const db = await open({ migrations: ["CREATE TABLE t (x INTEGER)"] });
    const events: string[] = [];
    db.onDidChange((event) => events.push(event.origin));
    await db.query("INSERT INTO t VALUES (1) RETURNING x");
    await waitFor(() => events.length > 0);
    expect(events).toEqual(["self"]);
  });

  it("announces nothing for a transaction that rolled back", async () => {
    const db = await open({ migrations: ["CREATE TABLE t (x INTEGER)"] });
    const events: string[] = [];
    db.onDidChange((event) => events.push(event.origin));
    await expect(
      db.transaction(async (tx) => {
        await tx.run("INSERT INTO t VALUES (1)");
        throw new Error("abort");
      })
    ).rejects.toThrow("abort");
    await db.run("UPDATE t SET x = 2 WHERE x = 99");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events).toEqual([]);
  });

  it("opens readonly: refuses writes, still sees an agent's commits", async () => {
    await (await open({ migrations: ["CREATE TABLE t (x INTEGER)"] })).close();
    const db = await open({ readonly: true });
    expect(db.readonly).toBe(true);
    await expect(db.run("INSERT INTO t VALUES (1)")).rejects.toMatchObject({ code: "DB_READONLY" });
    await expect(db.exec("DELETE FROM t")).rejects.toMatchObject({ code: "DB_READONLY" });
    await expect(db.transaction(async () => undefined)).rejects.toMatchObject({
      code: "DB_READONLY",
    });
    await expect(db.query("INSERT INTO t VALUES (2) RETURNING x")).rejects.toThrow(/readonly/i);
    const events: string[] = [];
    db.onDidChange((event) => events.push(event.origin));
    const agent = new DatabaseSync(location.path);
    agent.exec("INSERT INTO t VALUES (9)");
    agent.close();
    await waitFor(() => events.includes("external"));
    expect(await db.query("SELECT x FROM t")).toEqual([{ x: 9 }]);
  });

  it("refuses a readonly open of a missing file, or with a schema to apply", async () => {
    await expect(open({ readonly: true })).rejects.toMatchObject({ code: "DB_NOT_FOUND" });
    expect(fs.existsSync(location.path)).toBe(false);
    await expect(
      open({ readonly: true, migrations: ["CREATE TABLE t (x)"] })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(open({ readonly: true, migrations: [] })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("refuses SQL after the first statement instead of dropping it", async () => {
    const db = await open({ migrations: ["CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1)"] });
    await expect(db.query("SELECT x FROM t; DELETE FROM t")).rejects.toMatchObject({
      code: "DB_MULTIPLE_STATEMENTS",
    });
    expect(await db.query("SELECT x FROM t;  -- trailing comment\n")).toEqual([{ x: 1 }]);
    await expect(db.query("SELECT x FROM t; -- comment\rDELETE FROM t")).rejects.toMatchObject({
      code: "DB_MULTIPLE_STATEMENTS",
    });
    expect(await db.get("SELECT count(*) AS n FROM t")).toEqual({ n: 1 });
  });

  it("describes result columns for a query with no rows", async () => {
    const db = await open({ migrations: ["CREATE TABLE t (x INTEGER, label TEXT)"] });
    expect(await db.query("SELECT x, label AS name, 1 + 1 AS two FROM t")).toEqual([]);
    expect(await db.columns("SELECT x, label AS name, 1 + 1 AS two FROM t")).toEqual([
      { name: "x", table: "t", column: "x", type: "INTEGER" },
      { name: "name", table: "t", column: "label", type: "TEXT" },
      { name: "two", table: null, column: null, type: null },
    ]);
  });

  it("backs up a consistent snapshot to an approved destination", async () => {
    const approved: string[] = [];
    const db = await open({
      migrations: ["CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2)"],
      // The host hands back the realpath form, which the handle re-verifies.
      prepareBackup: async (destPath) => {
        approved.push(destPath);
        return path.join(fs.realpathSync(path.dirname(destPath)), path.basename(destPath));
      },
    });
    const dest = path.join(dir, "backups", "ledger-2026-09-26.db");
    fs.mkdirSync(path.dirname(dest));
    const result = await db.backup(dest);
    expect(approved).toEqual([dest]);
    expect(result).toEqual({ path: fs.realpathSync(dest), bytes: fs.statSync(dest).size });
    const copy = new DatabaseSync(dest);
    expect(copy.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 2 });
    copy.close();
    expect(fs.readdirSync(path.dirname(dest))).toEqual(["ledger-2026-09-26.db"]);
  });

  it("refuses a backup without an approval hook or onto itself", async () => {
    const plain = await open({ migrations: ["CREATE TABLE t (x)"] });
    await expect(plain.backup(path.join(dir, "b.db"))).rejects.toMatchObject({
      code: "DB_UNSUPPORTED",
    });
    await plain.close();
    const db = await open({
      migrations: ["CREATE TABLE t (x)"],
      prepareBackup: async (destPath) => destPath,
    });
    await expect(db.backup(location.path)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("tells its owner when it closes", async () => {
    let closedCount = 0;
    const db = await open({ onClosed: () => closedCount++ });
    await db.close();
    await db.close();
    expect(closedCount).toBe(1);
  });

  it("refuses a symlinked database file", async () => {
    const real = path.join(dir, "real.db");
    new DatabaseSync(real).close();
    fs.symlinkSync(real, location.path);
    await expect(open()).rejects.toMatchObject({ code: "TARGET_IS_SYMLINK" });
  });

  it("returns plain rows and rejects calls after close", async () => {
    const db = await open({ migrations: ["CREATE TABLE t (x INTEGER)"] });
    await db.run("INSERT INTO t VALUES (?)", [5]);
    const row = await db.get<{ x: number }>("SELECT x FROM t WHERE x = :x", { x: 5 });
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    await db.close();
    await expect(db.query("SELECT 1")).rejects.toMatchObject({ code: "DB_CLOSED" });
  });

  it("does not let a line comment's /* hide a second statement", async () => {
    const db = await open({ migrations: ["CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1)"] });
    await expect(db.query("SELECT 1; -- /*\nDELETE FROM t; -- */")).rejects.toMatchObject({
      code: "DB_MULTIPLE_STATEMENTS",
    });
    expect(await db.query("SELECT x FROM t /* a ; inside */ ; -- ; trailing")).toEqual([{ x: 1 }]);
  });

  it("announces DDL as self, through run and through a transaction", async () => {
    const db = await open({ migrations: ["CREATE TABLE t (x INTEGER)"] });
    const events: string[] = [];
    db.onDidChange((event) => events.push(event.origin));
    await db.run("CREATE VIEW v AS SELECT x FROM t");
    await waitFor(() => events.length === 1);
    await db.transaction(async (tx) => {
      await tx.run("CREATE INDEX t_x ON t (x)");
    });
    await waitFor(() => events.length === 2);
    expect(events).toEqual(["self", "self"]);
  });

  it("re-applies definitions after a migration committed without them, as a crash would leave it", async () => {
    const definitions =
      "CREATE TRIGGER IF NOT EXISTS no_negatives BEFORE INSERT ON t WHEN NEW.x < 0 BEGIN SELECT RAISE(ABORT, 'x must be >= 0'); END";
    const migrations = ["CREATE TABLE t (x INTEGER)"];
    await (await open({ migrations, definitions })).close();
    // Migration 2 committed by a process that stopped before re-applying the
    // definitions: the trigger is gone, the recorded hash is untouched.
    const crashed = new DatabaseSync(location.path);
    crashed.exec(
      "BEGIN; DROP TABLE t; CREATE TABLE t (x INTEGER, memo TEXT); PRAGMA user_version = 2; COMMIT"
    );
    crashed.close();
    const db = await open({
      migrations: [...migrations, "DROP TABLE t; CREATE TABLE t (x INTEGER, memo TEXT)"],
      definitions,
    });
    await expect(db.run("INSERT INTO t (x) VALUES (-1)")).rejects.toThrow(/x must be >= 0/);
  });

  it("follows a file replaced while a readonly open is under way", async () => {
    await (
      await open({ migrations: ["CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1)"] })
    ).close();
    const replacement = path.join(dir, "replacement.db");
    const other = new DatabaseSync(replacement);
    other.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (2)");
    other.close();
    // Swapped in after the connection opened the original but before the
    // handle recorded which file it has.
    const realStat = fs.statSync;
    let reads = 0;
    vi.spyOn(fs, "statSync").mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
      if (file === location.path && ++reads === 2) fs.renameSync(replacement, location.path);
      return (realStat as (...args: unknown[]) => fs.Stats)(file, ...rest);
    }) as typeof fs.statSync);
    const db = await open({ readonly: true });
    vi.restoreAllMocks();
    expect(await db.query("SELECT x FROM t")).toEqual([{ x: 2 }]);
  });

  it("refuses to open a file that keeps being replaced rather than track the wrong one", async () => {
    await (await open({ migrations: ["CREATE TABLE t (x INTEGER)"] })).close();
    const realStat = fs.statSync;
    let swaps = 0;
    let reads = 0;
    vi.spyOn(fs, "statSync").mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
      // The second identity read of each attempt, right after the open.
      if (file === location.path && ++reads % 3 === 2) {
        const next = path.join(dir, `swap-${++swaps}.db`);
        fs.copyFileSync(location.path, next);
        fs.renameSync(next, location.path);
      }
      return (realStat as (...args: unknown[]) => fs.Stats)(file, ...rest);
    }) as typeof fs.statSync);
    await expect(open({ migrations: ["CREATE TABLE t (x INTEGER)"] })).rejects.toMatchObject({
      code: "TARGET_UNAVAILABLE",
    });
    expect(swaps).toBe(3);
  });

  it("does not trust the file it created until it has reopened it as an existing file", async () => {
    const replacement = path.join(dir, "replacement.db");
    const other = new DatabaseSync(replacement);
    other.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (2); PRAGMA user_version = 1");
    other.close();
    // The path is empty; SQLite creates a file, and it is replaced before
    // the handle reads which file it has.
    const realStat = fs.statSync;
    let reads = 0;
    vi.spyOn(fs, "statSync").mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
      if (file === location.path && ++reads === 2) fs.renameSync(replacement, location.path);
      return (realStat as (...args: unknown[]) => fs.Stats)(file, ...rest);
    }) as typeof fs.statSync);
    const db = await open({ migrations: ["CREATE TABLE t (x INTEGER)"] });
    vi.restoreAllMocks();
    expect(await db.query("SELECT x FROM t")).toEqual([{ x: 2 }]);
  });

  it("runs the migrations it checked, not what the caller's array holds later", async () => {
    const outsideFile = path.join(dir, "mutated-outside.db");
    const migrations = ["CREATE TABLE t (x INTEGER)"];
    const db = await open({ migrations });
    migrations.push(`ATTACH '${outsideFile}' AS o`);
    // An older copy swapped in makes the handle reopen and migrate again.
    const older = path.join(dir, "older.db");
    new DatabaseSync(older).close();
    fs.renameSync(older, location.path);
    expect(await db.query("SELECT count(*) AS n FROM t")).toEqual([{ n: 0 }]);
    expect(await db.get("PRAGMA user_version")).toEqual({ user_version: 1 });
    expect(fs.existsSync(outsideFile)).toBe(false);
  });
});

describe("openPluginDatabase file containment", () => {
  const BOM = String.fromCharCode(0xfeff);
  const outside = () => path.join(dir, "outside", "copy.db");
  beforeEach(() => fs.mkdirSync(path.join(dir, "outside")));

  it("refuses VACUUM INTO from a readonly handle", async () => {
    await (await open({ migrations: ["CREATE TABLE t (x INTEGER)"] })).close();
    const db = await open({ readonly: true });
    await expect(db.query(`VACUUM INTO '${outside()}'`)).rejects.toMatchObject({
      code: "DB_STATEMENT_NOT_ALLOWED",
    });
    await expect(db.get(`vacuum main into ?`, [outside()])).rejects.toMatchObject({
      code: "DB_STATEMENT_NOT_ALLOWED",
    });
    await expect(db.query(`${BOM}VACUUM INTO '${outside()}'`)).rejects.toMatchObject({
      code: "DB_STATEMENT_NOT_ALLOWED",
    });
    expect(fs.existsSync(outside())).toBe(false);
  });

  it("refuses ATTACH and DETACH however they are written", async () => {
    const db = await open({ migrations: ["CREATE TABLE t (x INTEGER)"] });
    const attempts = [
      `ATTACH '${outside()}' AS o`,
      `/* note */ attach database '${outside()}' as o`,
      `SELECT 1; -- line\nATTACH '${outside()}' AS o`,
      `EXPLAIN ATTACH '${outside()}' AS o`,
      // SQLite reads `$a(');` as one Tcl-style parameter, so the ATTACH after
      // it is a real statement even though a naive scan sees it inside a string.
      `SELECT $a(');ATTACH/**/'${outside()}'/**/AS/**/o;--'`,
      // SQLite reads a byte-order mark that starts a token as whitespace.
      `SELECT 1;${BOM}ATTACH '${outside()}' AS o`,
      "DETACH o",
    ];
    for (const sql of attempts) {
      await expect(db.exec(sql), sql).rejects.toMatchObject({ code: "DB_STATEMENT_NOT_ALLOWED" });
    }
    await expect(db.run(`ATTACH '${outside()}' AS o`)).rejects.toMatchObject({
      code: "DB_STATEMENT_NOT_ALLOWED",
    });
    expect(fs.existsSync(outside())).toBe(false);
  });

  it("refuses file access in migrations and definitions before opening anything", async () => {
    await expect(
      open({ migrations: ["CREATE TABLE t (x)", `VACUUM INTO '${outside()}'`] })
    ).rejects.toMatchObject({ code: "DB_STATEMENT_NOT_ALLOWED" });
    await expect(open({ definitions: `ATTACH '${outside()}' AS o` })).rejects.toMatchObject({
      code: "DB_STATEMENT_NOT_ALLOWED",
    });
    expect(fs.existsSync(location.path)).toBe(false);
    expect(fs.existsSync(outside())).toBe(false);
  });

  it("refuses directory pragmas and load_extension, and allows the words in data", async () => {
    const db = await open({ migrations: ["CREATE TABLE t (note TEXT)"] });
    for (const name of [
      "temp_store_directory",
      "'temp_store_directory'",
      'main."TEMP_STORE_DIRECTORY"',
    ]) {
      await expect(
        db.exec(`PRAGMA ${name} = '${path.join(dir, "outside")}'`),
        name
      ).rejects.toMatchObject({ code: "DB_STATEMENT_NOT_ALLOWED" });
    }
    await expect(db.query(`SELECT load_extension('x')`)).rejects.toMatchObject({
      code: "DB_STATEMENT_NOT_ALLOWED",
    });
    await db.run("INSERT INTO t VALUES ('please attach the receipt; then VACUUM INTO nothing')");
    expect(await db.query(`SELECT note AS "attach" FROM t`)).toHaveLength(1);
    await db.exec("VACUUM");
  });

  const { setAuthorizer } = DatabaseSync.prototype as { setAuthorizer?: unknown };
  it.skipIf(typeof setAuthorizer !== "function")(
    "installs an authorizer that refuses file access however the SQL is spelled",
    () => {
      const { constants } = process.getBuiltinModule("node:sqlite") as unknown as {
        constants: Record<string, number>;
      };
      const raw = new DatabaseSync(location.path) as InstanceType<typeof DatabaseSync> & {
        setAuthorizer(cb: unknown): void;
      };
      try {
        raw.setAuthorizer(fileAccessAuthorizer(constants));
        raw.exec("CREATE TABLE t (x)");
        raw.exec("VACUUM");
        expect(() => raw.exec(`VACUUM INTO '${outside()}'`)).toThrow(/authoriz/);
        expect(() => raw.exec(`ATTACH '${outside()}' AS o`)).toThrow(/authoriz/);
        expect(fs.existsSync(outside())).toBe(false);
      } finally {
        raw.close();
      }
    }
  );

  it.skipIf(typeof setAuthorizer !== "function")(
    "installs the authorizer on a handle's connection before any statement runs",
    async () => {
      const calls: string[] = [];
      let installed: ((action: number, arg1: string | null) => number) | null = null;
      const proto = DatabaseSync.prototype as unknown as {
        setAuthorizer(cb: typeof installed): void;
        exec(sql: string): void;
      };
      const realSet = proto.setAuthorizer;
      const realExec = proto.exec;
      vi.spyOn(proto, "setAuthorizer").mockImplementation(function (this: unknown, cb) {
        calls.push("setAuthorizer");
        installed = cb;
        return realSet.call(this, cb);
      });
      vi.spyOn(proto, "exec").mockImplementation(function (this: unknown, sql: string) {
        calls.push("exec");
        return realExec.call(this, sql);
      });
      await (await open({ migrations: ["CREATE TABLE t (x)"] })).close();
      expect(calls[0]).toBe("setAuthorizer");
      const { constants } = process.getBuiltinModule("node:sqlite") as unknown as {
        constants: Record<string, number>;
      };
      expect(installed!(constants.SQLITE_ATTACH!, outside())).toBe(constants.SQLITE_DENY);
    }
  );
});

describe("openPluginDatabase backup destinations", () => {
  const approveAny = { prepareBackup: async (destPath: string) => destPath };

  it("refuses the database's own journal names as a destination", async () => {
    const db = await open({ migrations: ["CREATE TABLE t (x)"], ...approveAny });
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      await expect(db.backup(`${location.path}${suffix}`)).rejects.toMatchObject({
        code: "VALIDATION",
      });
    }
    await expect(db.backup(path.join(dir, "LEDGER.db-WAL"))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(fs.readdirSync(dir)).toEqual(["ledger.db"]);
  });

  it("refuses another database's live WAL as a destination", async () => {
    const db = await open({ migrations: ["CREATE TABLE t (x)"], ...approveAny });
    const other = path.join(dir, "other.db");
    const writer = new DatabaseSync(other);
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
      writer.exec("CREATE TABLE notes (s TEXT); INSERT INTO notes VALUES ('uncheckpointed')");
      const wal = fs.readFileSync(`${other}-wal`);
      await expect(db.backup(`${other}-wal`)).rejects.toMatchObject({ code: "VALIDATION" });
      expect(fs.readFileSync(`${other}-wal`).equals(wal)).toBe(true);
    } finally {
      writer.close();
    }
  });

  it("checks the destination again after the snapshot, before replacing anything", async () => {
    const db = await open({ migrations: ["CREATE TABLE t (x)"], ...approveAny });
    // Canonical, as the host approves it.
    const dest = path.join(fs.realpathSync(dir), "copy.db");
    const sqlite = process.getBuiltinModule("node:sqlite") as unknown as {
      backup: (source: unknown, target: string) => Promise<number>;
    };
    const realBackup = sqlite.backup;
    vi.spyOn(sqlite, "backup").mockImplementation(async (source, target) => {
      const pages = await realBackup(source, target);
      // Another process starts a WAL database at the destination meanwhile.
      fs.writeFileSync(dest, "");
      fs.writeFileSync(`${dest}-wal`, "live log");
      return pages;
    });
    await expect(db.backup(dest)).rejects.toMatchObject({ code: "DESTINATION_HAS_JOURNAL" });
    expect(fs.readFileSync(dest, "utf8")).toBe("");
  });

  it("refuses a destination whose live WAL SQLite would replay into the copy", async () => {
    const db = await open({
      migrations: ["CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1)"],
      ...approveAny,
    });
    const dest = path.join(dir, "other.db");
    const other = new DatabaseSync(dest);
    try {
      other.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
      other.exec("CREATE TABLE notes (s TEXT); INSERT INTO notes VALUES ('keep me')");
      expect(fs.statSync(`${dest}-wal`).size).toBeGreaterThan(0);
      await expect(db.backup(dest)).rejects.toMatchObject({ code: "DESTINATION_HAS_JOURNAL" });
      expect(other.prepare("SELECT s FROM notes").all()).toEqual([{ s: "keep me" }]);
    } finally {
      other.close();
    }
    expect(fs.readdirSync(dir).filter((name) => name.startsWith(".daintree-backup-"))).toEqual([]);
  });

  it("refuses a hard link to the database", async () => {
    const db = await open({ migrations: ["CREATE TABLE t (x)"], ...approveAny });
    const alias = path.join(dir, "alias.db");
    fs.linkSync(location.path, alias);
    await expect(db.backup(alias)).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
