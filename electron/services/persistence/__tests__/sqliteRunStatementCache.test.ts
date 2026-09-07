import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installSqliteRunStatementCache } from "../sqliteRunStatementCache.js";

class FakeStatement {
  busy = false;
  readonly = false;
  reader = false;
  source: string;
  database: FakeDatabase;
  configured = false;
  runs = 0;

  constructor(database: FakeDatabase, source: string) {
    this.database = database;
    this.source = source;
  }

  run(): Database.RunResult {
    this.runs += 1;
    return { changes: 1, lastInsertRowid: this.runs };
  }

  raw(): this {
    this.configured = true;
    return this;
  }
}

class FakeDatabase {
  prepared: FakeStatement[] = [];

  prepare(source: string): FakeStatement {
    if (source === "invalid") throw new Error("invalid SQL");
    const statement = new FakeStatement(this, source);
    this.prepared.push(statement);
    return statement;
  }
}

const distinctSql = (n: number) => `insert into t${n} values (?)`;

installSqliteRunStatementCache(FakeDatabase as unknown as typeof Database);
installSqliteRunStatementCache(Database);

describe("SQLite run statement cache", () => {
  it("compiles identical direct run statements once", () => {
    const db = new FakeDatabase();

    db.prepare("insert into projects values (?)").run();
    db.prepare("insert into projects values (?)").run();

    expect(db.prepared).toHaveLength(1);
    expect(db.prepared[0].runs).toBe(2);
  });

  it("isolates configured statements from the cached run statement", () => {
    const db = new FakeDatabase();
    db.prepare("update projects set name = ?").run();

    const configured = db.prepare("update projects set name = ?").raw();
    configured.run();
    db.prepare("update projects set name = ?").run();

    expect(db.prepared).toHaveLength(2);
    expect(db.prepared[0].configured).toBe(false);
    expect(db.prepared[0].runs).toBe(2);
    expect(db.prepared[1].configured).toBe(true);
    expect(db.prepared[1].runs).toBe(1);
  });

  it("does not share a statement until its first direct run", () => {
    const db = new FakeDatabase();
    const configured = db.prepare("insert into projects values (?)");
    const direct = db.prepare("insert into projects values (?)");

    configured.raw().run();
    direct.run();

    expect(db.prepared).toHaveLength(2);
    expect(db.prepared[0].configured).toBe(true);
    expect(db.prepared[0].runs).toBe(1);
    expect(db.prepared[1].configured).toBe(false);
    expect(db.prepared[1].runs).toBe(1);
  });

  it("isolates configuration added after a statement has entered the cache", () => {
    const db = new FakeDatabase();
    const first = db.prepare("update projects set name = ?");
    first.run();
    const second = db.prepare("update projects set name = ?");

    first.raw().run();
    second.run();

    expect(db.prepared).toHaveLength(2);
    expect(db.prepared[0].configured).toBe(false);
    expect(db.prepared[0].runs).toBe(2);
    expect(db.prepared[1].configured).toBe(true);
    expect(db.prepared[1].runs).toBe(1);
  });

  it("uses a fresh statement when the cached one is busy", () => {
    const db = new FakeDatabase();
    db.prepare("delete from projects where id = ?").run();
    db.prepared[0].busy = true;

    db.prepare("delete from projects where id = ?").run();

    expect(db.prepared).toHaveLength(2);
    expect(db.prepared[0].runs).toBe(1);
    expect(db.prepared[1].runs).toBe(1);
  });

  it("still validates new SQL during prepare", () => {
    const db = new FakeDatabase();
    expect(() => db.prepare("invalid")).toThrow("invalid SQL");
  });

  it("holds exactly 128 statements per connection", () => {
    const db = new FakeDatabase();
    for (let i = 0; i < 128; i += 1) db.prepare(distinctSql(i)).run();
    expect(db.prepared).toHaveLength(128);

    // Replaying all 128 compiles nothing new, so none of them was evicted early.
    for (let i = 0; i < 128; i += 1) db.prepare(distinctSql(i)).run();
    expect(db.prepared).toHaveLength(128);

    // The 129th pushes the cache over the bound and drops the oldest entry.
    db.prepare(distinctSql(128)).run();
    expect(db.prepared).toHaveLength(129);

    db.prepare(distinctSql(1)).run();
    expect(db.prepared).toHaveLength(129);

    db.prepare(distinctSql(0)).run();
    expect(db.prepared).toHaveLength(130);
  });

  it("evicts the least recently run statement, not the oldest compiled one", () => {
    const db = new FakeDatabase();
    for (let i = 0; i < 128; i += 1) db.prepare(distinctSql(i)).run();

    // Reuse promotes the first statement, so overflowing must drop the second.
    db.prepare(distinctSql(0)).run();
    db.prepare(distinctSql(128)).run();
    expect(db.prepared).toHaveLength(129);

    db.prepare(distinctSql(0)).run();
    expect(db.prepared).toHaveLength(129);

    db.prepare(distinctSql(1)).run();
    expect(db.prepared).toHaveLength(130);
  });
});

describe("SQLite run statement cache native compatibility", () => {
  it("never lends one connection's cached statement to another", () => {
    const first = new Database(":memory:");
    const second = new Database(":memory:");
    try {
      for (const db of [first, second]) {
        db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, tag TEXT NOT NULL)");
      }

      const insert = "INSERT INTO items (id, tag) VALUES (?, ?)";
      first.prepare(insert).run(1, "first");
      second.prepare(insert).run(2, "second");

      expect(first.prepare("SELECT id, tag FROM items").raw().all()).toEqual([[1, "first"]]);
      expect(second.prepare("SELECT id, tag FROM items").raw().all()).toEqual([[2, "second"]]);
    } finally {
      first.close();
      second.close();
    }
  });

  it("keys the cache by handle even when two handles share one file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-run-statement-cache-"));
    const first = new Database(path.join(dir, "shared.db"));
    const second = new Database(path.join(dir, "shared.db"));
    try {
      // A temp table is private to its connection, so a statement that leaked
      // across handles writes into the wrong database and shows up here.
      for (const db of [first, second]) {
        db.exec("CREATE TEMP TABLE staged (tag TEXT NOT NULL)");
      }

      const insert = "INSERT INTO staged (tag) VALUES (?)";
      first.prepare(insert).run("first");
      second.prepare(insert).run("second");

      expect(first.prepare("SELECT tag FROM staged").pluck().all()).toEqual(["first"]);
      expect(second.prepare("SELECT tag FROM staged").pluck().all()).toEqual(["second"]);
    } finally {
      first.close();
      second.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still writes correctly once distinct SQL overflows the cache", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, tag TEXT NOT NULL)");
      for (let i = 0; i < 200; i += 1) {
        db.prepare(`INSERT INTO items (id, tag) VALUES (?, 'tag-${i}')`).run(i);
      }

      expect(db.prepare("SELECT COUNT(*) FROM items").pluck().get()).toBe(200);
      expect(db.prepare("SELECT tag FROM items WHERE id = 0").pluck().get()).toBe("tag-0");
      expect(db.prepare("SELECT tag FROM items WHERE id = 199").pluck().get()).toBe("tag-199");
    } finally {
      db.close();
    }
  });

  it("keeps late binding isolated from an already cached statement", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
      const first = db.prepare("INSERT INTO items (id, name) VALUES (?, ?)");
      first.run(1, "first");
      const cached = db.prepare("INSERT INTO items (id, name) VALUES (?, ?)");

      first.bind(2, "second").run();
      cached.run(3, "third");

      expect(db.prepare("SELECT id, name FROM items ORDER BY id").raw().all()).toEqual([
        [1, "first"],
        [2, "second"],
        [3, "third"],
      ]);
    } finally {
      db.close();
    }
  });
});
