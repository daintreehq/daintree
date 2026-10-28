import { describe, it, expect } from "vitest";
import { getPluginManifestSchema, MANIFEST_CONTRIBUTION_CAPS } from "../plugin.js";
import type { PluginOrigin } from "../../../shared/types/plugin.js";

/**
 * A search provider adds a keyword-scoped source to the quick switcher
 * (#13792): a declarative one answers from a read-only declared query with one
 * string param, a runtime one from a function bound in activate(). Either way
 * its results open only the plugin's own panels and commands.
 */

type ParseResult = ReturnType<ReturnType<typeof getPluginManifestSchema>["safeParse"]>;

const panels = [
  { id: "notes", name: "Notes", iconId: "notebook", color: "#ffffff" },
  { id: "shell", name: "Shell", iconId: "terminal", color: "#ffffff", hasPty: true },
];

const command = {
  id: "open-note",
  title: "Open note",
  description: "Open a note by id",
  category: "notes",
  kind: "command",
  danger: "safe",
};

const FIND_NOTES = {
  name: "find_notes",
  mode: "read",
  description: "Notes whose title matches.",
  params: { q: { type: "string" } },
  sql: "SELECT id, title AS label FROM notes WHERE title LIKE '%' || :q || '%' LIMIT 20",
};

function parseAs(
  origin: PluginOrigin,
  providers: Record<string, unknown>[],
  queries: Record<string, unknown>[] = [FIND_NOTES],
  extra: Record<string, unknown> = {}
) {
  return getPluginManifestSchema(origin).safeParse({
    name: "acme.notes",
    version: "1.0.0",
    ...(origin === "project" ? { scope: "project" } : {}),
    contributes: {
      panels,
      databases: [{ id: "notes", location: "local", queries }],
      searchProviders: providers,
      ...extra,
    },
  });
}

const declarative = {
  id: "notes",
  kind: "declarative",
  title: "Notes",
  keyword: "notes",
  query: "find_notes",
  target: { panel: "notes" },
};

function parse(overrides: Record<string, unknown>, extra?: Record<string, unknown>) {
  return parseAs("user", [{ ...declarative, ...overrides }], [FIND_NOTES], extra);
}

function issuesFor(result: ParseResult, code: string) {
  if (result.success) return [];
  return result.error.issues.filter(
    (i) => (i as { params?: { errorCode?: string } }).params?.errorCode === code
  );
}

describe("search providers", () => {
  it("accepts a declarative and a runtime provider, for installed and project plugins", () => {
    for (const origin of ["user", "project"] as const) {
      const result = parseAs(
        origin,
        [
          { ...declarative, iconId: "notebook", blend: true },
          { id: "people", kind: "runtime", title: "People", keyword: "people" },
          {
            id: "drafts",
            kind: "runtime",
            title: "Drafts",
            keyword: "drafts",
            target: { command: "acme.notes.open-note" },
          },
        ],
        [FIND_NOTES],
        { commands: [command] }
      );
      expect(result.success, JSON.stringify(!result.success && result.error.issues)).toBe(true);
    }
  });

  it("defaults to an empty list", () => {
    const result = getPluginManifestSchema("user").safeParse({
      name: "acme.notes",
      version: "1.0.0",
    });
    expect(result.success && result.data.contributes.searchProviders).toEqual([]);
  });

  it.each([
    ["an uppercase letter", "Notes"],
    ["a leading digit", "1notes"],
    ["a space", "my notes"],
    ["a palette prefix", ">notes"],
    ["a project prefix", "/notes"],
    ["a mention prefix", "@notes"],
    ["too many characters", "a".repeat(25)],
    ["nothing", ""],
  ])("refuses a keyword with %s", (_label, keyword) => {
    expect(parse({ keyword }).success).toBe(false);
  });

  it("refuses two of the plugin's own providers sharing a keyword", () => {
    const result = parseAs("user", [
      declarative,
      { id: "other", kind: "runtime", title: "Other", keyword: "notes" },
    ]);
    expect(issuesFor(result, "search_provider_keyword_duplicate")).toHaveLength(1);
  });

  it("refuses duplicate provider ids", () => {
    const result = parseAs("user", [
      declarative,
      { id: "notes", kind: "runtime", title: "Other", keyword: "other" },
    ]);
    expect(issuesFor(result, "duplicate_contribution_id")).toHaveLength(1);
  });

  it(`caps a plugin at ${MANIFEST_CONTRIBUTION_CAPS.searchProviders} providers`, () => {
    const many = Array.from({ length: MANIFEST_CONTRIBUTION_CAPS.searchProviders + 1 }, (_, i) => ({
      id: `p${i}`,
      kind: "runtime",
      title: `P${i}`,
      keyword: `p${i}`,
    }));
    expect(parseAs("user", many).success).toBe(false);
  });

  describe("declarative", () => {
    it("requires a query", () => {
      const result = parse({ query: undefined });
      expect(issuesFor(result, "search_provider_query_missing")).toHaveLength(1);
    });

    it("refuses a query the plugin doesn't declare", () => {
      const result = parse({ query: "nope" });
      expect(issuesFor(result, "search_provider_query_unknown")).toHaveLength(1);
    });

    it("refuses a write query", () => {
      const write = {
        ...FIND_NOTES,
        name: "add_note",
        mode: "write",
        sql: "INSERT INTO notes (title) VALUES (:q)",
      };
      const result = parseAs("user", [{ ...declarative, query: "add_note" }], [FIND_NOTES, write]);
      expect(issuesFor(result, "search_provider_query_not_read")).toHaveLength(1);
    });

    it.each([
      ["no param", { params: {}, sql: "SELECT id, title AS label FROM notes" }],
      [
        "two params",
        {
          params: { q: { type: "string" }, limit: { type: "integer" } },
          sql: "SELECT id, title AS label FROM notes WHERE title = :q LIMIT :limit",
        },
      ],
      [
        "a non-string param",
        {
          params: { q: { type: "integer" } },
          sql: "SELECT id, title AS label FROM notes WHERE id = :q",
        },
      ],
    ])("refuses a query with %s", (_label, override) => {
      const result = parseAs("user", [declarative], [{ ...FIND_NOTES, ...override }]);
      expect(issuesFor(result, "search_provider_query_params")).toHaveLength(1);
    });

    it("requires a target", () => {
      const result = parse({ target: undefined });
      expect(issuesFor(result, "search_provider_target_missing")).toHaveLength(1);
    });
  });

  it("refuses a runtime provider that also names a query", () => {
    const result = parse({ kind: "runtime" });
    expect(issuesFor(result, "search_provider_query_runtime")).toHaveLength(1);
  });

  describe("targets", () => {
    it("refuses a target naming both a panel and a command, or neither", () => {
      expect(
        issuesFor(
          parse({ target: { panel: "notes", command: "acme.notes.open-note" } }),
          "search_provider_target_conflict"
        )
      ).toHaveLength(1);
      expect(issuesFor(parse({ target: {} }), "search_provider_target_conflict")).toHaveLength(1);
    });

    it("refuses a panel the plugin doesn't contribute", () => {
      const result = parse({ target: { panel: "elsewhere" } });
      expect(issuesFor(result, "search_provider_panel_unknown")).toHaveLength(1);
    });

    it("refuses a PTY panel, which has no view to hand args to", () => {
      const result = parse({ target: { panel: "shell" } });
      expect(issuesFor(result, "search_provider_panel_pty")).toHaveLength(1);
    });

    it.each([
      ["a built-in action", "panel.openPluginPanel"],
      ["another plugin's action", "other.plugin.open"],
      ["the bare namespace", "acme.notes."],
    ])("refuses %s as a command", (_label, actionId) => {
      const result = parse({ target: { command: actionId } });
      expect(issuesFor(result, "search_provider_command_not_own")).toHaveLength(1);
    });

    it("refuses an own-namespace command that matches no declared command", () => {
      const result = parse(
        { target: { command: "acme.notes.opne-note" } },
        { commands: [command] }
      );
      expect(issuesFor(result, "action_id_undeclared_command")).toHaveLength(1);
    });
  });
});
