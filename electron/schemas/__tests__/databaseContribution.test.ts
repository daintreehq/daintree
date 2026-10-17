import { describe, expect, it } from "vitest";
import { describeManifestIssues, getPluginManifestSchema } from "../plugin.js";

function projectManifest(overrides: Record<string, unknown>) {
  return { name: "acme.ledger", version: "1.0.0", scope: "project", ...overrides };
}

function errorCodes(result: { success: boolean; error?: { issues: unknown[] } }): string[] {
  if (result.success || !result.error) return [];
  return result.error.issues.map(
    (issue) => (issue as { params?: { errorCode?: string } }).params?.errorCode ?? "zod"
  );
}

const parseProject = (manifest: unknown) => getPluginManifestSchema("project").safeParse(manifest);

describe("contributes.databases", () => {
  it("defaults each entry to a project database in delete journal mode", () => {
    const result = parseProject(
      projectManifest({
        capabilities: ["fs:project-write"],
        contributes: { databases: [{ id: "ledger" }] },
      })
    );
    expect(result.success && result.data.contributes.databases).toEqual([
      { id: "ledger", location: "project", journalMode: "delete" },
    ]);
  });

  it("requires fs:project-write for a project database", () => {
    const result = parseProject(
      projectManifest({ contributes: { databases: [{ id: "ledger" }] } })
    );
    expect(errorCodes(result)).toContain("database_project_write_required");
  });

  it("allows a local database with no capability", () => {
    const result = parseProject(
      projectManifest({ contributes: { databases: [{ id: "cache", location: "local" }] } })
    );
    expect(result.success).toBe(true);
  });

  it("refuses a project database on an installed plugin", () => {
    const result = getPluginManifestSchema("user").safeParse({
      name: "acme.ledger",
      version: "1.0.0",
      capabilities: ["fs:project-write"],
      contributes: { databases: [{ id: "ledger" }] },
    });
    expect(errorCodes(result)).toContain("database_project_scope_only");
  });

  it("refuses a path on a local database", () => {
    const result = parseProject(
      projectManifest({
        contributes: { databases: [{ id: "cache", location: "local", path: "data/x.db" }] },
      })
    );
    expect(errorCodes(result)).toContain("database_local_path_unsupported");
  });

  it.each([
    ["/abs/finance.db"],
    ["../outside.db"],
    ["data/finance.json"],
    [".git/finance.db"],
    ["sub/.git/finance.db"],
  ])("rejects the path %s", (badPath) => {
    const result = parseProject(
      projectManifest({
        capabilities: ["fs:project-write"],
        contributes: { databases: [{ id: "ledger", path: badPath }] },
      })
    );
    expect(result.success).toBe(false);
  });

  it("rejects duplicate ids and unknown fields", () => {
    const duplicate = parseProject(
      projectManifest({
        capabilities: ["fs:project-write"],
        contributes: { databases: [{ id: "a" }, { id: "a" }] },
      })
    );
    expect(duplicate.success).toBe(false);
    const unknownField = parseProject(
      projectManifest({
        capabilities: ["fs:project-write"],
        contributes: { databases: [{ id: "a", url: "libsql://x" }] },
      })
    );
    expect(unknownField.success).toBe(false);
  });
});

const MONTH_TOTAL = {
  name: "month_total",
  mode: "read",
  description: "Total spend for a month, in integer cents.",
  params: { month: { type: "string", description: "YYYY-MM" } },
  sql: "SELECT SUM(amount_cents) AS total FROM tx WHERE substr(date, 1, 7) = :month",
};

const ADD_TRANSACTION = {
  name: "add_transaction",
  mode: "write",
  description: "Record a transaction. Amount in integer cents, negative for spending.",
  params: {
    date: { type: "string", description: "YYYY-MM-DD" },
    amount_cents: { type: "integer" },
    category: { type: "string" },
  },
  sql: "INSERT INTO tx (date, amount_cents, category) VALUES (:date, :amount_cents, :category)",
};

function withQueries(...databases: Array<{ id: string; queries: unknown[] }>) {
  return parseProject(
    projectManifest({
      capabilities: ["fs:project-write"],
      contributes: { databases },
    })
  );
}

/** What the plugin manager shows for a manifest that failed to load. */
function loadError(result: ReturnType<typeof parseProject>): string {
  if (result.success) return "";
  return describeManifestIssues(result.error.issues, getPluginManifestSchema("project"));
}

describe("contributes.databases[].queries", () => {
  it("accepts the issue's ledger query and leaves a database without queries untouched", () => {
    const result = withQueries(
      { id: "ledger", queries: [MONTH_TOTAL] },
      { id: "cache", queries: [] }
    );
    expect(result.success && result.data.contributes.databases).toEqual([
      { id: "ledger", location: "project", journalMode: "delete", queries: [MONTH_TOTAL] },
      { id: "cache", location: "project", journalMode: "delete", queries: [] },
    ]);
  });

  it("accepts the issue's write query", () => {
    const result = withQueries({ id: "ledger", queries: [ADD_TRANSACTION] });
    expect(result.success && result.data.contributes.databases[0]?.queries).toEqual([
      ADD_TRANSACTION,
    ]);
  });

  it.each([
    ["a read", { sql: "SELECT :date, :amount_cents, :category" }, /not one starting SELECT/],
    [
      "a WITH that leads into a read",
      { sql: "WITH x AS (SELECT :date, :amount_cents, :category) SELECT * FROM x" },
      /must lead into INSERT, REPLACE, UPDATE or DELETE, not SELECT/,
    ],
    [
      "a write that ends the host's transaction",
      { sql: "INSERT INTO tx VALUES (:date, :amount_cents, :category); COMMIT" },
      /2 statements/,
    ],
    [
      "a schema change",
      { sql: "CREATE TABLE t AS SELECT :date, :amount_cents, :category" },
      /not one starting CREATE/,
    ],
  ])("rejects a write query that is %s, naming the query", (_label, override, message) => {
    const result = withQueries({ id: "ledger", queries: [{ ...ADD_TRANSACTION, ...override }] });
    expect(errorCodes(result)).toEqual(["database_query_unservable"]);
    expect(loadError(result)).toMatch(/query "add_transaction"/);
    expect(loadError(result)).toMatch(message);
  });

  it("defaults a query's params to none", () => {
    const { params: _params, ...bare } = MONTH_TOTAL;
    const result = withQueries({
      id: "ledger",
      queries: [{ ...bare, name: "entry_count", sql: "SELECT count(*) FROM tx" }],
    });
    expect(result.success && result.data.contributes.databases[0]?.queries?.[0]?.params).toEqual(
      {}
    );
  });

  it.each([
    ["more than one statement", { sql: "SELECT 1; SELECT 2" }, /2 statements/],
    [
      "placeholders that do not match params",
      { sql: "SELECT :month, :year" },
      /placeholder :year has no param/,
    ],
    [
      "a read query that writes",
      { sql: "WITH x AS (SELECT 1) DELETE FROM tx WHERE :month" },
      /cannot contain DELETE/,
    ],
  ])("rejects %s at load, naming the query", (_label, override, message) => {
    const result = withQueries({ id: "ledger", queries: [{ ...MONTH_TOTAL, ...override }] });
    expect(errorCodes(result)).toEqual(["database_query_unservable"]);
    expect(loadError(result)).toMatch(/query "month_total"/);
    expect(loadError(result)).toMatch(message);
  });

  it("rejects a query named like one of the host's database tools", () => {
    const result = withQueries({
      id: "ledger",
      queries: [{ ...MONTH_TOTAL, name: "database_query" }],
    });
    expect(errorCodes(result)).toEqual(["database_query_name_reserved"]);
    expect(loadError(result)).toMatch(/query "database_query"/);
  });

  it("rejects a query name declared twice, across databases too", () => {
    const sameDatabase = withQueries({ id: "ledger", queries: [MONTH_TOTAL, MONTH_TOTAL] });
    expect(errorCodes(sameDatabase)).toEqual(["database_query_name_duplicate"]);
    const acrossDatabases = withQueries(
      { id: "ledger", queries: [MONTH_TOTAL] },
      { id: "archive", queries: [MONTH_TOTAL] }
    );
    expect(errorCodes(acrossDatabases)).toEqual(["database_query_name_duplicate"]);
    expect(loadError(acrossDatabases)).toMatch(/query "month_total" .*database "ledger"/);
  });

  it("caps declared queries at the tool budget across all databases", () => {
    const named = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({ ...MONTH_TOTAL, name: `q${from + i}` }));
    expect(
      withQueries({ id: "a", queries: named(0, 10) }, { id: "b", queries: named(10, 6) }).success
    ).toBe(true);
    const over = withQueries(
      { id: "a", queries: named(0, 10) },
      { id: "b", queries: named(10, 7) }
    );
    expect(errorCodes(over)).toEqual(["database_query_limit"]);
    expect(loadError(over)).toMatch(/query "q16" is past the limit/);
    const oneDatabase = withQueries({ id: "a", queries: named(0, 17) });
    expect(errorCodes(oneDatabase)).toEqual(["database_query_limit"]);
    expect(loadError(oneDatabase)).toMatch(/query "q16" is past the limit/);
  });

  it.each([
    ["an unknown mode", { mode: "admin" }],
    ["an unknown field", { readOnlyHint: true }],
    ["a tool name the MCP grammar refuses", { name: "Month-Total" }],
    ["a blank description", { description: "   " }],
    ["a description over the byte budget", { description: "é".repeat(201) }],
    ["an unknown param type", { params: { month: { type: "date" } } }],
    ["an invalid param name", { params: { "1month": { type: "string" } }, sql: "SELECT 1" }],
    ["a NUL in the SQL", { sql: "SELECT :month\0; DELETE FROM tx" }],
  ])("rejects %s", (_label, override) => {
    expect(withQueries({ id: "ledger", queries: [{ ...MONTH_TOTAL, ...override }] }).success).toBe(
      false
    );
  });
});

describe("contributes.databases[].queries[].params constraints", () => {
  const withParams = (params: Record<string, unknown>) =>
    withQueries({
      id: "ledger",
      queries: [
        {
          ...ADD_TRANSACTION,
          params,
          sql: `INSERT INTO tx VALUES (${Object.keys(params)
            .map((name) => `:${name}`)
            .join(", ")})`,
        },
      ],
    });

  it("keeps each constraint on a param of the type it applies to", () => {
    const params = {
      date: { type: "string", format: "date" },
      memo: { type: "string", minLength: 0, maxLength: 280, pattern: "^\\P{Cc}*$" },
      amount_cents: { type: "integer", minimum: -100, maximum: 100, not: { const: 0 } },
      ratio: { type: "number", minimum: 0.5, maximum: 0.5, not: { const: 0.25 } },
      voided: { type: "boolean", not: { const: true } },
    };
    const result = withParams(params);
    expect(result.success && result.data.contributes.databases[0]?.queries?.[0]?.params).toEqual(
      params
    );
  });

  it.each([
    [
      "a string constraint on an integer",
      { n: { type: "integer", maxLength: 3 } },
      /maxLength applies only to a "string" param/,
    ],
    [
      "a format on a number",
      { n: { type: "number", format: "date" } },
      /format applies only to a "string" param/,
    ],
    [
      "a numeric bound on a string",
      { s: { type: "string", minimum: 1 } },
      /minimum applies only to a "number" or "integer" param/,
    ],
    [
      "a numeric bound on a boolean",
      { b: { type: "boolean", maximum: 1 } },
      /maximum applies only/,
    ],
    [
      "a fractional bound on an integer",
      { n: { type: "integer", minimum: 0.5 } },
      /must be an integer no larger than 2\^53 - 1/,
    ],
    [
      "an integer bound a number cannot bind exactly",
      { n: { type: "integer", maximum: 2 ** 53 } },
      /no larger than 2\^53 - 1/,
    ],
    [
      "a minimum above the maximum",
      { n: { type: "number", minimum: 2, maximum: 1 } },
      /minimum 2 is more than maximum 1/,
    ],
    [
      "a minLength above the maxLength",
      { s: { type: "string", minLength: 4, maxLength: 3 } },
      /minLength 4 is more than maxLength 3/,
    ],
    [
      "a pattern that does not compile",
      { s: { type: "string", pattern: "(" } },
      /valid Unicode regular expression/,
    ],
    [
      "a pattern only a non-Unicode expression accepts",
      { s: { type: "string", pattern: "[\\w-a]" } },
      /valid Unicode regular expression/,
    ],
    [
      "a refused value of another type",
      { n: { type: "integer", not: { const: "0" } } },
      /not\.const must be a value of the param's type, "integer"/,
    ],
    [
      "a fractional refused value on an integer",
      { n: { type: "integer", not: { const: 0.5 } } },
      /not\.const must be a value/,
    ],
  ])("rejects %s, naming the rule", (_label, params, message) => {
    const result = withParams(params);
    expect(errorCodes(result)).toContain("database_query_param_constraint");
    expect(loadError(result)).toMatch(message);
  });

  it.each([
    ["a format the host does not check", { s: { type: "string", format: "date-fullyear" } }],
    ["a negative length", { s: { type: "string", maxLength: -1 } }],
    ["a not that is a whole schema", { n: { type: "integer", not: { minimum: 0 } } }],
    ["an unknown keyword", { n: { type: "integer", multipleOf: 5 } }],
  ])("rejects %s", (_label, params) => {
    expect(withParams(params).success).toBe(false);
  });
});
