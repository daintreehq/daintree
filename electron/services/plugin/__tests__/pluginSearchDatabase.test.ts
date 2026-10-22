import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginDatabaseQueryContribution } from "../../../../shared/types/plugin.js";

const { resolveLocation } = vi.hoisted(() => ({ resolveLocation: vi.fn() }));

vi.mock("../pluginDatabase.js", () => ({
  resolvePluginDatabaseLocation: resolveLocation,
}));

import { createDeclarativeSearchRunner } from "../pluginSearchDatabase.js";

const QUERY: PluginDatabaseQueryContribution = {
  name: "find_notes",
  mode: "read",
  description: "Notes whose title matches.",
  params: { q: { type: "string", maxLength: 40 } },
  sql: "SELECT id, title AS label FROM notes WHERE title LIKE '%' || :q || '%'",
};

const LOCATION = { path: "/data/acme.notes/notes.db", journalMode: "delete" };

function runner(overrides: { isCurrent?: () => boolean } = {}) {
  const run = vi.fn(async () => ({
    databaseId: "notes",
    columns: ["id", "label"],
    rows: [[1, "Groceries"]],
    truncated: false,
  }));
  const search = createDeclarativeSearchRunner({
    declaration: { id: "notes", location: "local", journalMode: "delete" },
    query: QUERY,
    manifestId: "acme.notes",
    projectRoot: null,
    dataDir: "/data/acme.notes",
    isCurrent: overrides.isCurrent ?? (() => true),
    run,
  });
  return { search, run };
}

beforeEach(() => {
  resolveLocation.mockReset();
  resolveLocation.mockResolvedValue(LOCATION);
});

describe("createDeclarativeSearchRunner", () => {
  it("runs the declared statement read-only with the typed text bound to its one param", async () => {
    const { search, run } = runner();
    const signal = new AbortController().signal;
    await expect(search("gro", 3, signal)).resolves.toEqual({
      columns: ["id", "label"],
      rows: [[1, "Groceries"]],
    });
    expect(resolveLocation).toHaveBeenCalledWith(
      expect.objectContaining({ existingOnly: true, manifestId: "acme.notes" })
    );
    expect(run).toHaveBeenCalledWith(
      {
        tool: "database_query",
        target: { id: "notes", location: "local", resolved: LOCATION, problem: null },
        sql: QUERY.sql,
        params: { ":q": "gro" },
        rowLimit: 3,
      },
      signal
    );
  });

  it("answers no rows, without running anything, for text the param refuses", async () => {
    const { search, run } = runner();
    await expect(search("x".repeat(41), 20, new AbortController().signal)).resolves.toEqual({
      columns: [],
      rows: [],
    });
    expect(run).not.toHaveBeenCalled();
    expect(resolveLocation).not.toHaveBeenCalled();
  });

  it("answers no rows for a database the plugin hasn't created yet", async () => {
    resolveLocation.mockRejectedValue(
      Object.assign(new Error("missing"), { code: "DB_NOT_FOUND" })
    );
    const { search, run } = runner();
    await expect(search("gro", 20, new AbortController().signal)).resolves.toEqual({
      columns: [],
      rows: [],
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("fails rather than run for a plugin that unloaded while the path resolved", async () => {
    const { search, run } = runner({ isCurrent: () => false });
    await expect(search("gro", 20, new AbortController().signal)).rejects.toThrow(/unloaded/);
    expect(run).not.toHaveBeenCalled();
  });

  it("doesn't start the query once the search was aborted", async () => {
    const { search, run } = runner();
    const controller = new AbortController();
    controller.abort();
    await expect(search("gro", 20, controller.signal)).rejects.toBeDefined();
    expect(run).not.toHaveBeenCalled();
  });
});
