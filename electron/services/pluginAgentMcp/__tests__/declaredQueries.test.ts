import { describe, expect, it } from "vitest";
import type { PluginDatabaseQueryContribution } from "../../../../shared/types/plugin.js";
import {
  bindDeclaredQueryArgs,
  declaredQueryDescriptor,
  declaredQueryInputSchema,
  declaredQueryPlaceholders,
  declaredQueryProblems,
} from "../declaredQueries.js";
import { compileAgentMcpTool } from "../validateTools.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

function query(
  sql: string,
  params: PluginDatabaseQueryContribution["params"] = {}
): PluginDatabaseQueryContribution {
  return { name: "month_total", mode: "read", description: "Total for a month.", params, sql };
}

const MONTH = { month: { type: "string" as const, description: "YYYY-MM" } };

function messages(sql: string, params: PluginDatabaseQueryContribution["params"] = {}): string[] {
  return declaredQueryProblems(query(sql, params)).map((problem) => problem.message);
}

function write(
  sql: string,
  params: PluginDatabaseQueryContribution["params"] = {}
): PluginDatabaseQueryContribution {
  return { ...query(sql, params), name: "add_entry", mode: "write" };
}

function writeMessages(
  sql: string,
  params: PluginDatabaseQueryContribution["params"] = {}
): string[] {
  return declaredQueryProblems(write(sql, params)).map((problem) => problem.message);
}

const ENTRY = { month: { type: "string" as const }, amount: { type: "integer" as const } };

describe("declaredQueryProblems", () => {
  it.each([
    "SELECT SUM(amount_cents) AS total FROM tx WHERE substr(date, 1, 7) = :month",
    "WITH m AS (SELECT * FROM tx WHERE substr(date, 1, 7) = :month) SELECT count(*) FROM m",
    "VALUES (:month)",
    "SELECT replace(name, 'a', 'b') FROM tx WHERE month = :month;",
    "select :month -- trailing comment\n;  ",
    "SELECT \"update\", [delete], `insert`, 'REPLACE INTO t' FROM tx WHERE m = :month",
    "SELECT sum(x) OVER (PARTITION BY m ORDER BY d) FROM tx WHERE m = :month",
    "SELECT name FROM pragma_table_info('tx') WHERE name <> :month",
  ])("accepts a read: %s", (sql) => {
    expect(messages(sql, MONTH)).toEqual([]);
  });

  it("names the query in every problem", () => {
    const problems = declaredQueryProblems(query("SELECT 1; SELECT 2"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ field: "sql" });
    expect(problems[0]!.message).toMatch(/^query "month_total": /);
  });

  it.each([
    ["SELECT 1; DELETE FROM tx", /2 statements/],
    ["SELECT 1;\nSELECT 2;", /2 statements/],
    ["  ; -- nothing\n", /no statement/],
  ])("refuses anything but one statement: %j", (sql, message) => {
    expect(messages(sql)).toEqual([expect.stringMatching(message)]);
  });

  it.each([
    ["DELETE FROM tx", /not one starting DELETE/],
    ["PRAGMA journal_mode = wal", /not one starting PRAGMA/],
    ["EXPLAIN SELECT 1", /not one starting EXPLAIN/],
    ["ATTACH 'x.db' AS x", /not one starting ATTACH/],
    ["CREATE TABLE t (a)", /not one starting CREATE/],
    ["WITH x AS (SELECT 1) DELETE FROM tx", /cannot contain DELETE/],
    ["WITH x AS (SELECT 1) INSERT INTO tx SELECT * FROM x", /cannot contain INSERT/],
    ["WITH x AS (SELECT 1) UPDATE tx SET a = 1", /cannot contain UPDATE/],
    ["WITH x AS (SELECT 1) REPLACE INTO tx SELECT * FROM x", /cannot contain REPLACE/],
    ["SELECT load_extension('evil')", /load_extension/],
    ["SELECT \"load_extension\"('evil')", /load_extension/],
    ["SELECT [load_extension]('evil')", /load_extension/],
  ])("refuses a query that writes or reaches outside its file: %s", (sql, message) => {
    expect(messages(sql)).toEqual([expect.stringMatching(message)]);
  });

  it("folds keywords as SQLite does, ASCII only", () => {
    // `ı` upper-cases to `I` in JavaScript, and `ſ` to `S`; to SQLite both
    // spell names, not keywords.
    expect(messages("SELECT 1 AS ınsert")).toEqual([]);
    expect(messages("ſelect 1")).toEqual([expect.stringMatching(/not one starting ſelect/)]);
  });

  it("asks for a column that shares a write keyword to be quoted", () => {
    expect(messages("SELECT update FROM tx")).toEqual([
      expect.stringMatching(/cannot contain UPDATE; quote/),
    ]);
  });

  it("refuses placeholders that do not match params, naming each side", () => {
    expect(messages("SELECT :month, :year", MONTH)).toEqual([
      expect.stringMatching(/placeholder :year has no param "year"/),
    ]);
    expect(messages("SELECT 1", MONTH)).toEqual([
      expect.stringMatching(/param "month" has no placeholder/),
    ]);
    expect(
      declaredQueryProblems(query("SELECT :Month", MONTH)).map((problem) => problem.field)
    ).toEqual(["params", "params"]);
  });

  it.each([
    ["SELECT ?", /positional placeholders/],
    ["SELECT ?1", /positional placeholders/],
    ["SELECT $month::x", /\$month::x is not supported/],
    ["SELECT $month(x)", /is not supported/],
    ["SELECT #month", /#month is not supported/],
    ["SELECT :month, @month", /written both as :month and @month/],
    ["SELECT :month, @", /placeholder @ has no name/],
    ["SELECT :month, @::", /placeholder @:: has no name/],
    ["SELECT :month, :::", /placeholder ::: has no name/],
  ])("refuses a placeholder the host cannot bind by name: %s", (sql, message) => {
    expect(messages(sql, MONTH)).toEqual([expect.stringMatching(message)]);
  });

  it("reads placeholders inside strings and comments as text", () => {
    expect(messages("SELECT ':nope', \"?\" /* :also */ FROM tx -- @not\n")).toEqual([]);
  });

  it.each([
    ["SELECT 'open", /unterminated ' quote/],
    ["SELECT 'it''", /unterminated ' quote/],
    ['SELECT "col', /unterminated " quote/],
    ["SELECT [col", /unterminated \[ quote/],
    ["SELECT 1 /* open", /unterminated \/\* comment/],
    ["SELECT 1 -- note\rDELETE FROM tx", /bare carriage return/],
  ])("refuses SQL whose tokens a reader would split differently: %j", (sql, message) => {
    expect(messages(sql)).toEqual([expect.stringMatching(message)]);
  });

  it("refuses params whose input schema would be over the advertising budget", () => {
    const params = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [
        `p${i}`,
        { type: "string" as const, description: "x".repeat(400) + "é".repeat(200) },
      ])
    );
    const sql = `SELECT ${Object.keys(params)
      .map((name) => `:${name}`)
      .join(", ")}`;
    expect(messages(sql, params)).toEqual([expect.stringMatching(/byte input schema/)]);
  });
});

describe("declaredQueryProblems for a write", () => {
  it.each([
    "INSERT INTO tx (month, amount) VALUES (:month, :amount)",
    "INSERT OR REPLACE INTO tx (month, amount) VALUES (:month, :amount)",
    "REPLACE INTO tx (month, amount) VALUES (:month, :amount)",
    "INSERT INTO tx (month, amount) VALUES (:month, :amount) ON CONFLICT (month) DO UPDATE SET amount = excluded.amount",
    "UPDATE tx SET amount = :amount WHERE month = :month RETURNING *",
    "DELETE FROM tx WHERE month = :month AND amount = :amount",
    "WITH m AS (SELECT :month AS v) INSERT INTO tx (month, amount) SELECT v, :amount FROM m",
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < :amount) INSERT INTO tx (month, amount) SELECT :month, i FROM n",
    'WITH a AS MATERIALIZED (SELECT :month AS m), "b c" AS NOT MATERIALIZED (SELECT (1) AS x) UPDATE tx SET amount = :amount WHERE month IN (SELECT m FROM a)',
  ])("accepts a write: %s", (sql) => {
    expect(writeMessages(sql, ENTRY)).toEqual([]);
    // What the host accepts, SQLite runs as written.
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE tx (month TEXT PRIMARY KEY, amount INTEGER)");
      expect(() => db.prepare(sql)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it.each([
    ["SELECT 1", /not one starting SELECT/],
    ["VALUES (1)", /not one starting VALUES/],
    ["PRAGMA foreign_keys = OFF", /not one starting PRAGMA/],
    ["CREATE TABLE t (a)", /not one starting CREATE/],
    ["DROP TABLE tx", /not one starting DROP/],
    ["ALTER TABLE tx ADD COLUMN b", /not one starting ALTER/],
    ["BEGIN", /not one starting BEGIN/],
    ["COMMIT", /not one starting COMMIT/],
    ["SAVEPOINT s", /not one starting SAVEPOINT/],
    ["ATTACH 'x.db' AS x", /not one starting ATTACH/],
    ["DETACH x", /not one starting DETACH/],
    ["VACUUM INTO 'copy.db'", /not one starting VACUUM/],
    ["REINDEX", /not one starting REINDEX/],
    ["ANALYZE", /not one starting ANALYZE/],
    ["EXPLAIN DELETE FROM tx", /not one starting EXPLAIN/],
    ['"insert" INTO tx VALUES (1)', /not one starting "insert"/],
    ["WITH x AS (SELECT 1) SELECT * FROM x", /must lead into .* not SELECT/],
    ["WITH x AS (DELETE FROM tx) SELECT 1", /must lead into .* not SELECT/],
    ["WITH x SELECT 1", /common table expressions/],
    ["WITH x AS (SELECT 1", /common table expressions/],
    ["INSERT INTO tx VALUES (1); DELETE FROM tx", /2 statements/],
    ["INSERT INTO tx VALUES (load_extension('evil'))", /load_extension/],
    ["INSERT INTO tx VALUES (?)", /positional placeholders/],
  ])("refuses %s", (sql, message) => {
    expect(writeMessages(sql)).toEqual([expect.stringMatching(message)]);
  });

  it("holds a query with no mode to the rules for a read", () => {
    const { mode: _mode, ...bare } = write("DELETE FROM tx");
    expect(declaredQueryProblems(bare).map((problem) => problem.message)).toEqual([
      expect.stringMatching(/a "read" query must be one SELECT/),
    ]);
  });

  it("still checks a write's placeholders against its params", () => {
    expect(writeMessages("DELETE FROM tx WHERE month = :month", ENTRY)).toEqual([
      expect.stringMatching(/param "amount" has no placeholder/),
    ]);
  });
});

describe("the declared query tool", () => {
  it("marks a write for read and write access and never as harmless", () => {
    const tool = compileAgentMcpTool(
      declaredQueryDescriptor(write("DELETE FROM tx WHERE month = :month", MONTH))
    );
    expect(tool.databaseWrite).toBe(true);
    expect(tool.readOnly).toBeUndefined();
    expect(tool.annotations).toEqual({
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(tool.checkInput({ month: "2026-01" })).toBeNull();
  });

  it("demands every param, and nothing else, as its declared type", () => {
    const tool = compileAgentMcpTool(
      declaredQueryDescriptor(
        query("SELECT :month, :limit, :voided, :scale", {
          ...MONTH,
          limit: { type: "integer" },
          voided: { type: "boolean" },
          scale: { type: "number" },
        })
      )
    );
    expect(tool.readOnly).toBe(true);
    expect(tool.annotations).toBeUndefined();
    const ok = { month: "2026-01", limit: 5, voided: false, scale: 1.5 };
    expect(tool.checkInput(ok)).toBeNull();
    expect(tool.checkInput({ ...ok, sql: "DELETE FROM tx" })).toMatch(/sql/);
    expect(tool.checkInput({ month: "2026-01", limit: 5, voided: false })).toMatch(/scale/);
    expect(tool.checkInput({ ...ok, limit: 1.5 })).not.toBeNull();
    expect(tool.checkInput({ ...ok, limit: 2 ** 60 })).not.toBeNull();
    expect(tool.checkInput({ ...ok, voided: 1 })).not.toBeNull();
    expect(tool.checkInput({ ...ok, month: null })).not.toBeNull();
  });

  it("holds each value to the constraints its param declares", () => {
    const tool = compileAgentMcpTool(
      declaredQueryDescriptor(
        write("INSERT INTO tx VALUES (:day, :note, :amount, :ratio)", {
          day: { type: "string", format: "date" },
          note: { type: "string", minLength: 1, maxLength: 3, pattern: "^\\p{Ll}+$" },
          amount: { type: "integer", minimum: -10, maximum: 10, not: { const: 0 } },
          ratio: { type: "number", minimum: 0, maximum: 1 },
        })
      )
    );
    const ok = { day: "2024-02-29", note: "été", amount: -10, ratio: 1 };
    expect(tool.checkInput(ok)).toBeNull();
    expect(tool.checkInput({ ...ok, note: "🧾" })).toMatch(/\/note must match pattern/);
    expect(tool.checkInput({ ...ok, day: "2025-02-29" })).toMatch(/\/day must match format "date"/);
    expect(tool.checkInput({ ...ok, note: "" })).toMatch(/\/note must NOT have fewer than 1/);
    expect(tool.checkInput({ ...ok, note: "abcd" })).toMatch(/\/note must NOT have more than 3/);
    expect(tool.checkInput({ ...ok, note: "Ab" })).toMatch(/\/note must match pattern/);
    expect(tool.checkInput({ ...ok, amount: 0 })).toMatch(/\/amount must NOT be valid/);
    expect(tool.checkInput({ ...ok, amount: 11 })).toMatch(/\/amount must be <= 10/);
    expect(tool.checkInput({ ...ok, ratio: 1.01 })).toMatch(/\/ratio must be <= 1/);
  });

  it("counts a declared length in characters, not UTF-16 units", () => {
    const tool = compileAgentMcpTool(
      declaredQueryDescriptor(
        write("INSERT INTO tx VALUES (:memo)", { memo: { type: "string", maxLength: 3 } })
      )
    );
    expect(tool.checkInput({ memo: "🧾🧾🧾" })).toBeNull();
    expect(tool.checkInput({ memo: "🧾🧾🧾🧾" })).not.toBeNull();
  });

  it("keeps an integer to the range a JavaScript number binds exactly unless it narrows it", () => {
    const schema = declaredQueryInputSchema({
      wide: { type: "integer" },
      narrow: { type: "integer", minimum: 1 },
    });
    expect(schema.properties).toMatchObject({
      wide: { minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
      narrow: { minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    });
  });

  it("takes no arguments when it declares no params", () => {
    const schema = declaredQueryInputSchema({});
    expect(schema).not.toHaveProperty("required");
    const tool = compileAgentMcpTool(declaredQueryDescriptor(query("SELECT 1")));
    expect(tool.checkInput({})).toBeNull();
    expect(tool.checkInput({ extra: 1 })).not.toBeNull();
  });

  it("binds each value under the SQL's own spelling, integers and booleans as INTEGER", () => {
    const declared = query("SELECT :month AS m, typeof(@n) AS n, $flag + 0 AS f, :month AS again", {
      ...MONTH,
      n: { type: "integer" },
      flag: { type: "boolean" },
    });
    const placeholders = declaredQueryPlaceholders(declared.sql);
    const bound = bindDeclaredQueryArgs(declared, placeholders, {
      month: "2026-01",
      n: 7,
      flag: true,
    });
    expect(bound).toEqual({ ":month": "2026-01", "@n": 7n, $flag: 1n });

    const db = new DatabaseSync(":memory:");
    try {
      expect({ ...(db.prepare(declared.sql).get(bound) as object) }).toEqual({
        m: "2026-01",
        n: "integer",
        f: 1,
        again: "2026-01",
      });
    } finally {
      db.close();
    }
  });

  it("refuses a value of the wrong type rather than binding it", () => {
    const declared = query("SELECT :month", MONTH);
    expect(() =>
      bindDeclaredQueryArgs(declared, declaredQueryPlaceholders(declared.sql), { month: 5 })
    ).toThrow(/param "month" must be a string/);
  });
});
