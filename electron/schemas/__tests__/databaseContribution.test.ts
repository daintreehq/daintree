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
  });

  it.each([
    ["an unknown mode", { mode: "write" }],
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
