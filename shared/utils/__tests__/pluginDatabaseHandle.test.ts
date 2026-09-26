import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openPluginDatabase } from "../pluginDatabaseHandle.js";
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
});
