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

describe("the declared query tool", () => {
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
