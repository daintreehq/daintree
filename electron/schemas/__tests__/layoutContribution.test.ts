import { describe, it, expect } from "vitest";
import {
  getPluginManifestSchema,
  LAYOUT_MAX_ENTRIES,
  MANIFEST_CONTRIBUTION_CAPS,
} from "../plugin.js";
import type { PluginOrigin } from "../../../shared/types/plugin.js";

/**
 * A layout arranges the plugin's own panels, browser pages and recipes
 * (#13780). Terminals reach it only through a recipe, and every placement the
 * panel store would refuse at apply time is refused here first.
 */

type ParseResult = ReturnType<ReturnType<typeof getPluginManifestSchema>["safeParse"]>;

const panels = [
  { id: "records", name: "Records", iconId: "puzzle", color: "#ffffff" },
  { id: "notes", name: "Notes", iconId: "puzzle", color: "#ffffff" },
  { id: "board", name: "Board", iconId: "puzzle", color: "#ffffff", scope: "project" },
  { id: "pinned", name: "Pinned", iconId: "puzzle", color: "#ffffff", dockable: false },
  { id: "shell", name: "Shell", iconId: "puzzle", color: "#ffffff", hasPty: true },
];

const recipes = [
  { id: "pair", name: "Pair", terminals: [{ type: "claude" }, { type: "terminal" }] },
  { id: "solo", name: "Solo", terminals: [{ type: "terminal" }] },
];

function parseAs(origin: PluginOrigin, layouts: unknown[]) {
  return getPluginManifestSchema(origin).safeParse({
    name: "acme.records",
    version: "1.0.0",
    ...(origin === "project" ? { scope: "project" } : {}),
    contributes: {
      panels: origin === "project" ? panels : panels.filter((p) => p.scope === undefined),
      recipes,
      layouts,
    },
  });
}

function parse(entries: Record<string, unknown>[], origin: PluginOrigin = "user") {
  return parseAs(origin, [{ id: "workspace", name: "Records workspace", entries }]);
}

function issuesFor(result: ParseResult, code: string) {
  if (result.success) return [];
  return result.error.issues.filter(
    (i) => (i as { params?: { errorCode?: string } }).params?.errorCode === code
  );
}

describe("layouts", () => {
  it("accepts panels, browser pages and recipes with placement, grouping and maximize", () => {
    for (const origin of ["user", "project"] as const) {
      const result = parse(
        [
          { panel: "records", tabGroup: "main", maximized: true },
          { panel: "notes", tabGroup: "main" },
          { recipe: "pair", location: "grid" },
          { browser: "http://localhost:3000/", location: "dock" },
          ...(origin === "project" ? [{ panel: "board" }] : []),
        ],
        origin
      );
      expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
      if (!result.success) continue;
      expect(result.data.contributes.layouts?.[0]?.entries).toHaveLength(
        origin === "project" ? 5 : 4
      );
    }
  });

  it("defaults to an empty list", () => {
    const result = getPluginManifestSchema("user").safeParse({
      name: "acme.records",
      version: "1.0.0",
    });
    expect(result.success && result.data.contributes.layouts).toEqual([]);
  });

  it("requires exactly one target per entry", () => {
    expect(issuesFor(parse([{ location: "grid" }]), "layout_entry_target_missing")).toHaveLength(1);
    expect(
      issuesFor(parse([{ panel: "records", recipe: "solo" }]), "layout_entry_target_conflict")
    ).toHaveLength(1);
  });

  it("refuses another plugin's panels and recipes", () => {
    expect(issuesFor(parse([{ panel: "elsewhere" }]), "layout_panel_unknown")).toHaveLength(1);
    expect(issuesFor(parse([{ recipe: "elsewhere" }]), "layout_recipe_unknown")).toHaveLength(1);
  });

  it("refuses a PTY panel, which would start a terminal without the recipe confirmation", () => {
    expect(issuesFor(parse([{ panel: "shell" }]), "layout_panel_pty")).toHaveLength(1);
  });

  it("refuses placements the panel can't take", () => {
    expect(
      issuesFor(parse([{ panel: "pinned", location: "dock" }]), "layout_panel_placement")
    ).toHaveLength(1);
    expect(
      issuesFor(parse([{ panel: "board", location: "grid" }], "project"), "layout_panel_placement")
    ).toHaveLength(1);
    expect(
      issuesFor(
        parse(
          [
            { panel: "board", tabGroup: "g" },
            { panel: "records", tabGroup: "g" },
          ],
          "project"
        ),
        "layout_panel_placement"
      )
    ).toHaveLength(1);
  });

  it("refuses a browser page that isn't http or https", () => {
    for (const browser of ["file:///etc/passwd", "javascript:alert(1)", "not a url"]) {
      const result = parse([{ browser }]);
      expect(result.success).toBe(false);
    }
  });

  it("refuses listing the same panel, recipe or page twice", () => {
    expect(
      issuesFor(parse([{ panel: "records" }, { panel: "records" }]), "layout_entry_duplicate")
    ).toHaveLength(1);
    expect(
      issuesFor(
        parse([{ browser: "http://localhost:3000" }, { browser: "http://localhost:3000/" }]),
        "layout_entry_duplicate"
      )
    ).toHaveLength(1);
  });

  it("maximizes at most one entry, and only in the grid", () => {
    expect(
      issuesFor(
        parse([
          { panel: "records", maximized: true },
          { panel: "notes", maximized: true },
        ]),
        "layout_maximized_invalid"
      )
    ).toHaveLength(1);
    expect(
      issuesFor(
        parse([{ panel: "records", location: "dock", maximized: true }]),
        "layout_maximized_invalid"
      )
    ).toHaveLength(1);
  });

  it("keeps a tab group in one place and gives it at least two panels", () => {
    expect(
      issuesFor(
        parse([
          { panel: "records", tabGroup: "g" },
          { panel: "notes", tabGroup: "g", location: "dock" },
        ]),
        "layout_tab_group_location"
      )
    ).toHaveLength(1);
    expect(
      issuesFor(parse([{ panel: "records", tabGroup: "g" }]), "layout_tab_group_single")
    ).toHaveLength(1);
    // A recipe's terminals count toward its group.
    expect(parse([{ recipe: "pair", tabGroup: "g" }]).success).toBe(true);
    expect(
      issuesFor(parse([{ recipe: "solo", tabGroup: "g" }]), "layout_tab_group_single")
    ).toHaveLength(1);
  });

  it("caps layouts per plugin and entries per layout", () => {
    const many = Array.from({ length: MANIFEST_CONTRIBUTION_CAPS.layouts + 1 }, (_, i) => ({
      id: `l${i}`,
      name: `Layout ${i}`,
      entries: [{ panel: "records" }],
    }));
    expect(parseAs("user", many).success).toBe(false);
    const entries = Array.from({ length: LAYOUT_MAX_ENTRIES + 1 }, (_, i) => ({
      browser: `http://localhost:${3000 + i}`,
    }));
    expect(parse(entries).success).toBe(false);
  });

  it("refuses duplicate layout ids", () => {
    const layout = { id: "same", name: "Same", entries: [{ panel: "records" }] };
    expect(issuesFor(parseAs("user", [layout, layout]), "duplicate_contribution_id")).toHaveLength(
      1
    );
  });
});
