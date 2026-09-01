import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
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
});

describe("SQLite run statement cache native compatibility", () => {
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
