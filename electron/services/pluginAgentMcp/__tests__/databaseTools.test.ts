import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DATABASE_QUERY_TOOL,
  DATABASE_SCHEMA_TOOL,
  DATABASE_TOOL_DESCRIPTORS,
  encodeCell,
  runDatabaseQuery,
  runDatabaseSchema,
  runDatabaseTool,
  type DatabaseTarget,
} from "../databaseTools.js";
import { validateAgentMcpTools } from "../validateTools.js";
import { RESERVED_AGENT_MCP_TOOL_NAMES } from "../types.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plugin-db-tools-")));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function target(id: string, sql?: string): DatabaseTarget {
  const file = path.join(dir, `${id}.db`);
  if (sql !== undefined) {
    const raw = new DatabaseSync(file);
    raw.exec(sql);
    raw.close();
  }
  return {
    id,
    location: "local",
    resolved: {
      id,
      location: "local",
      path: file,
      projectRelativePath: null,
      journalMode: "delete",
    },
    problem: null,
  };
}

function missing(id: string): DatabaseTarget {
  return {
    id,
    location: "local",
    resolved: null,
    problem: { code: "DB_NOT_FOUND", message: `DB_NOT_FOUND: database "${id}" does not exist yet` },
  };
}

function query(
  t: DatabaseTarget,
  sql: string,
  extra: { params?: (string | number | null)[]; rowLimit?: number } = {}
) {
  return runDatabaseQuery({ tool: DATABASE_QUERY_TOOL, target: t, sql, ...extra });
}

describe("database tool descriptors", () => {
  it("are the names no plugin roster may take", () => {
    expect([...RESERVED_AGENT_MCP_TOOL_NAMES]).toEqual(
      DATABASE_TOOL_DESCRIPTORS.map((d) => d.name)
    );
    const roster = Object.fromEntries(
      DATABASE_TOOL_DESCRIPTORS.map(({ readOnly: _readOnly, ...d }) => [
        d.name,
        { ...d, execute: () => null },
      ])
    );
    expect(() => validateAgentMcpTools(roster)).toThrow(/reserved/);
  });

  it("pass the same roster validation plugin tools do", () => {
    // Renamed, since the real names are reserved for the host.
    const roster = Object.fromEntries(
      DATABASE_TOOL_DESCRIPTORS.map(({ readOnly: _readOnly, ...d }) => [
        `host_${d.name}`,
        { ...d, execute: () => null },
      ])
    );
    const tools = validateAgentMcpTools(roster);
    expect(tools.map((t) => t.name)).toEqual([
      `host_${DATABASE_SCHEMA_TOOL}`,
      `host_${DATABASE_QUERY_TOOL}`,
    ]);
    const queryTool = tools[1]!;
    expect(queryTool.checkInput({ databaseId: "ledger", sql: "SELECT 1" })).toBeNull();
    expect(queryTool.checkInput({ databaseId: "ledger", sql: "SELECT ?", params: [1] })).toBeNull();
    for (const params of [{ ":a": 1 }, { a: 1 }, { $a: "x" }]) {
      expect(queryTool.checkInput({ databaseId: "ledger", sql: "SELECT :a", params })).toBeNull();
    }
    expect(
      queryTool.checkInput({ databaseId: "ledger", sql: "x", params: { "a-b": 1 } })
    ).not.toBeNull();
    expect(queryTool.checkInput({ databaseId: "../x", sql: "SELECT 1" })).not.toBeNull();
    expect(queryTool.checkInput({ databaseId: "ledger", sql: "x", rowLimit: 5000 })).not.toBeNull();
  });
});

describe("encodeCell", () => {
  it("keeps JSON-safe values and tags the rest", () => {
    expect(encodeCell(5n)).toBe(5);
    expect(encodeCell(9007199254740993n)).toBe("9007199254740993");
    expect(encodeCell(2.5)).toBe(2.5);
    expect(encodeCell(Infinity)).toBe("Infinity");
    expect(encodeCell(null)).toBeNull();
    expect(encodeCell("x")).toBe("x");
    expect(encodeCell(new Uint8Array([0, 255]))).toEqual({ blob: "AP8=" });
  });
});

describe("runDatabaseSchema", () => {
  it("lists each declared database's DDL and reports a missing one without creating it", () => {
    const ledger = target(
      "ledger",
      "CREATE TABLE entries (id INTEGER PRIMARY KEY, amount REAL); CREATE INDEX by_amount ON entries(amount); CREATE VIEW big AS SELECT * FROM entries WHERE amount > 100;"
    );
    const result = runDatabaseSchema([ledger, missing("cache")]);

    expect(result.truncated).toBe(false);
    expect(result.databases[0]).toMatchObject({ id: "ledger", exists: true, error: null });
    expect(result.databases[0]!.objects.map((o) => [o.type, o.name])).toEqual([
      ["table", "entries"],
      ["view", "big"],
      ["index", "by_amount"],
    ]);
    expect(result.databases[0]!.objects[0]!.sql).toContain("CREATE TABLE entries");
    expect(result.databases[1]).toMatchObject({
      id: "cache",
      exists: false,
      objects: [],
      error: null,
    });
    expect(fs.existsSync(path.join(dir, "cache.db"))).toBe(false);
  });

  it("reports an unresolvable database as an error, not as missing", () => {
    const refused: DatabaseTarget = {
      ...missing("ledger"),
      problem: { code: "PATH_NOT_ALLOWED", message: "escapes its root" },
    };
    expect(runDatabaseSchema([refused]).databases[0]).toMatchObject({
      exists: null,
      error: { code: "PATH_NOT_ALLOWED" },
    });
  });

  it("drops DDL past the budget but keeps every database listed", () => {
    const tables = Array.from({ length: 40 }, (_, i) => `CREATE TABLE t${i} (a, b, c);`).join("");
    const result = runDatabaseSchema([target("a", tables), target("b", tables)], 2_000);
    expect(result.truncated).toBe(true);
    expect(result.databases.map((d) => d.id)).toEqual(["a", "b"]);
    expect(result.databases[0]!.truncated).toBe(true);
    expect(result.databases[1]!.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2_000);
  });
});

describe("runDatabaseQuery", () => {
  const seed =
    "CREATE TABLE t (n INTEGER, s TEXT, b BLOB); INSERT INTO t VALUES (1, 'one', x'01'), (9007199254740993, 'big', NULL), (3, 'three', NULL);";

  it("returns columns and encoded rows", () => {
    expect(query(target("ledger", seed), "SELECT n, s, b FROM t ORDER BY rowid")).toEqual({
      databaseId: "ledger",
      columns: ["n", "s", "b"],
      rows: [
        [1, "one", { blob: "AQ==" }],
        ["9007199254740993", "big", null],
        [3, "three", null],
      ],
      truncated: false,
    });
  });

  it("binds params and caps rows", () => {
    const t = target("ledger", seed);
    expect(query(t, "SELECT s FROM t WHERE n = ?", { params: [3] }).rows).toEqual([["three"]]);
    const capped = query(t, "SELECT n FROM t ORDER BY rowid", { rowLimit: 2 });
    expect(capped.rows).toHaveLength(2);
    expect(capped.truncated).toBe(true);
    expect(query(t, "SELECT n FROM t", { rowLimit: 3 }).truncated).toBe(false);
  });

  it("stops at the byte budget", () => {
    const t = target("ledger", "CREATE TABLE t (s TEXT);");
    const raw = new DatabaseSync(t.resolved!.path);
    const insert = raw.prepare("INSERT INTO t VALUES (?)");
    for (let i = 0; i < 50; i++) insert.run("x".repeat(100));
    raw.close();
    const result = runDatabaseQuery(
      { tool: DATABASE_QUERY_TOOL, target: t, sql: "SELECT s FROM t", rowLimit: 1000 },
      1_000
    );
    expect(result.truncated).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1_000);
  });

  it("surfaces refusals and missing databases as coded errors", () => {
    const t = target("ledger", seed);
    expect(
      runDatabaseTool({ tool: DATABASE_QUERY_TOOL, target: t, sql: "DELETE FROM t" })
    ).toMatchObject({ ok: false, error: { code: "DB_NOT_A_QUERY" } });
    expect(
      runDatabaseTool({
        tool: DATABASE_QUERY_TOOL,
        target: t,
        sql: `ATTACH '${path.join(dir, "o.db")}' AS o`,
      })
    ).toMatchObject({ ok: false, error: { code: "DB_STATEMENT_NOT_ALLOWED" } });
    expect(
      runDatabaseTool({ tool: DATABASE_QUERY_TOOL, target: missing("cache"), sql: "SELECT 1" })
    ).toMatchObject({ ok: false, error: { code: "DB_NOT_FOUND" } });
    const raw = new DatabaseSync(t.resolved!.path);
    expect(raw.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 3 });
    raw.close();
  });

  it("binds bare named params and stops before a single value that cannot fit", () => {
    const t = target("ledger", "CREATE TABLE t (s TEXT); INSERT INTO t VALUES ('small');");
    expect(
      runDatabaseQuery({
        tool: DATABASE_QUERY_TOOL,
        target: t,
        sql: "SELECT s FROM t WHERE s = :s",
        params: { s: "small" },
      }).rows
    ).toEqual([["small"]]);
    const huge = runDatabaseQuery(
      {
        tool: DATABASE_QUERY_TOOL,
        target: t,
        sql: "SELECT s FROM t UNION ALL SELECT zeroblob(4096)",
      },
      1_000
    );
    expect(huge).toMatchObject({ rows: [["small"]], truncated: true });
  });

  it("names a missing database once, not twice", () => {
    expect(
      runDatabaseTool({ tool: DATABASE_QUERY_TOOL, target: missing("cache"), sql: "SELECT 1" })
    ).toEqual({
      ok: false,
      error: { code: "DB_NOT_FOUND", message: 'DB_NOT_FOUND: database "cache" does not exist yet' },
    });
  });
});

describe("runDatabaseTool schema", () => {
  it("fails a schema request for one named database that cannot be read", () => {
    const corrupt = target("ledger");
    fs.writeFileSync(corrupt.resolved!.path, "not a database, just some text that is long enough");
    const selected = runDatabaseTool({
      tool: DATABASE_SCHEMA_TOOL,
      targets: [corrupt],
      selected: true,
    });
    expect(selected).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/not a database/) },
    });
    expect(runDatabaseTool({ tool: DATABASE_SCHEMA_TOOL, targets: [corrupt] })).toMatchObject({
      ok: true,
      value: { databases: [{ id: "ledger", exists: null, error: { code: expect.any(String) } }] },
    });
  });

  it("stops only the database that reached the object cap", () => {
    // Keep the real 1,001-object database while avoiding one disk commit per
    // table, which can exceed the test timeout on Windows runners.
    const many = `BEGIN;${Array.from({ length: 1001 }, (_, i) => `CREATE TABLE t${i} (a);`).join("")}COMMIT;`;
    const result = runDatabaseSchema([target("a", many), target("b", "CREATE TABLE only (a);")]);
    expect(result.truncated).toBe(true);
    expect(result.databases[0]).toMatchObject({ truncated: true });
    expect(result.databases[0]!.objects).toHaveLength(1000);
    expect(result.databases[1]).toMatchObject({ truncated: false });
    expect(result.databases[1]!.objects.map((o) => o.name)).toEqual(["only"]);
  });
});
