import { describe, expect, it } from "vitest";
import { executeViewlessAction } from "../ViewlessActionExecutor.js";
import { getViewlessHelpBaseManifest } from "../../mcp-server/baseManifest.js";
import { makeDeps, request } from "./viewlessTestDeps.js";

type Entry = { id: string; inputSchema?: unknown; outputSchema?: unknown };

/** A headless host's tools found the way a view finds them (#13493). */
describe("viewless discovery", () => {
  it("searches the catalog a tool listing with no view serves, without schemas or host calls", async () => {
    const { deps, invoke } = makeDeps();
    const catalog = new Set(getViewlessHelpBaseManifest().map((entry) => entry.id));

    const result = await executeViewlessAction(
      request("actions.search", { query: "run command" }),
      deps
    );

    if (!result?.ok) throw new Error(`search failed: ${JSON.stringify(result)}`);
    const { totalMatches, results } = result.result as { totalMatches: number; results: Entry[] };
    const ids = results.map((entry) => entry.id);
    // A tool main runs, which only the no-view catalog adds to the external surface.
    expect(ids).toContain("project.runCommand");
    expect(ids.every((id) => catalog.has(id))).toBe(true);
    expect(results.every((entry) => entry.inputSchema === undefined)).toBe(true);
    expect(totalMatches).toBeGreaterThanOrEqual(results.length);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("pages the whole catalog in a stable order", async () => {
    const { deps } = makeDeps();
    const seen: string[] = [];
    const totals = new Set<number>();
    for (let offset = 0; ; offset += 40) {
      const result = await executeViewlessAction(
        request("actions.list", { limit: 40, offset }),
        deps
      );
      if (!result?.ok) throw new Error(`list failed: ${JSON.stringify(result)}`);
      const page = result.result as { actions: Entry[]; total: number; hasMore: boolean };
      totals.add(page.total);
      seen.push(...page.actions.map((entry) => entry.id));
      if (!page.hasMore) break;
    }
    // Every page counts the same catalog, and the walk covers exactly what discovery may show of it.
    const listable = getViewlessHelpBaseManifest()
      .filter((entry) => entry.mcpVisibility !== "hidden")
      .map((entry) => entry.id);
    expect([...totals]).toEqual([listable.length]);
    expect(new Set(seen)).toEqual(new Set(listable));
    expect(seen).toHaveLength(listable.length);
    expect([...seen].sort()).toEqual(seen);
  });

  it("gives one tool's schema, and a structured miss for one the host doesn't have", async () => {
    const { deps } = makeDeps();

    const found = await executeViewlessAction(
      request("actions.getSchema", { actionId: "terminal.sendCommandOwned" }),
      deps
    );
    const missing = await executeViewlessAction(
      request("actions.getSchema", { actionId: "terminal.sendToAgent" }),
      deps
    );

    expect(found).toMatchObject({
      ok: true,
      result: { ok: true, entry: { id: "terminal.sendCommandOwned" }, policy: null, error: null },
    });
    expect((found?.ok && (found.result as { entry: Entry }).entry.inputSchema) || null).not.toBe(
      null
    );
    expect(missing).toMatchObject({
      ok: true,
      result: { ok: false, entry: null, error: { code: "NOT_FOUND" } },
    });
  });

  it.each([
    ["actions.search", { query: "  " }],
    ["actions.search", { query: "terminal", limit: 0 }],
    ["actions.list", { limit: 1_000 }],
    ["actions.list", { offset: -1 }],
    ["actions.list", { category: 3 }],
    ["actions.getSchema", {}],
    ["actions.getSchema", { actionId: "" }],
  ])("refuses %s arguments the view's tool would refuse: %j", async (actionId, args) => {
    const { deps } = makeDeps();

    const result = await executeViewlessAction(request(actionId, args), deps);

    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  });
});
