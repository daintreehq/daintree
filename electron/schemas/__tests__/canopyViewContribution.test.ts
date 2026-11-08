import { describe, it, expect } from "vitest";
import { getPluginManifestSchema, MANIFEST_CONTRIBUTION_CAPS } from "../plugin.js";
import type { PluginOrigin } from "../../../shared/types/plugin.js";

/**
 * `contributes.canopyViews` (#16344): an app-wide plugin names the panel views
 * the Canopy window may show, each one a view Canopy can mount with no panel
 * record and no project around it.
 */

type ParseResult = ReturnType<ReturnType<typeof getPluginManifestSchema>["safeParse"]>;

const panels = [
  { id: "triage", name: "Triage", iconId: "puzzle", color: "#ffffff" },
  { id: "shell", name: "Shell", iconId: "terminal", color: "#ffffff", hasPty: true },
];
const views = [
  { id: "triage", componentPath: "dist/triage.js", location: "panel" as const },
  { id: "shell", componentPath: "dist/shell.js", location: "panel" as const },
  { id: "prefs", componentPath: "dist/prefs.js", location: "settings" as const },
  { id: "rail", componentPath: "dist/rail.js", location: "sidebar" as const, name: "Rail" },
];

function parse(
  canopyViews: unknown,
  { origin = "user", extra = {} }: { origin?: PluginOrigin; extra?: Record<string, unknown> } = {}
): ParseResult {
  return getPluginManifestSchema(origin).safeParse({
    name: "acme.beads",
    version: "1.0.0",
    ...extra,
    contributes: { panels, views, canopyViews },
  });
}

function codes(result: ParseResult): string[] {
  if (result.success) return [];
  return result.error.issues.flatMap((issue) => {
    const code = (issue as { params?: { errorCode?: string } }).params?.errorCode;
    return code === undefined ? [] : [code];
  });
}

describe("contributes.canopyViews", () => {
  it("accepts an installed plugin naming one of its panel views", () => {
    const result = parse([{ viewId: "triage" }]);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.contributes.canopyViews).toEqual([{ viewId: "triage" }]);
  });

  it("materializes an empty list when the manifest declares none", () => {
    const result = getPluginManifestSchema("user").safeParse({
      name: "acme.none",
      version: "1.0.0",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.contributes.canopyViews).toEqual([]);
  });

  it("refuses a view the manifest doesn't declare", () => {
    expect(codes(parse([{ viewId: "missing" }]))).toContain("canopy_view_unknown");
  });

  it("refuses a settings or sidebar view, which have homes of their own", () => {
    expect(codes(parse([{ viewId: "prefs" }]))).toContain("canopy_view_not_panel");
    expect(codes(parse([{ viewId: "rail" }]))).toContain("canopy_view_not_panel");
  });

  it("refuses a PTY panel's view, which never loads its module", () => {
    expect(codes(parse([{ viewId: "shell" }]))).toContain("canopy_view_pty");
  });

  it("refuses the same view named twice", () => {
    expect(codes(parse([{ viewId: "triage" }, { viewId: "triage" }]))).toEqual([
      "canopy_view_duplicate",
    ]);
  });

  it("refuses unknown fields", () => {
    expect(parse([{ viewId: "triage", title: "Beads" }]).success).toBe(false);
  });

  it("takes as many distinct views as the cap, and refuses one more", () => {
    const cap = MANIFEST_CONTRIBUTION_CAPS.canopyViews;
    const ids = Array.from({ length: cap + 1 }, (_, index) => `view${index}`);
    const parseIds = (viewIds: string[]) =>
      getPluginManifestSchema("user").safeParse({
        name: "acme.many",
        version: "1.0.0",
        contributes: {
          panels: ids.map((id) => ({ id, name: id, iconId: "puzzle", color: "#ffffff" })),
          views: ids.map((id) => ({ id, componentPath: `dist/${id}.js`, location: "panel" })),
          canopyViews: viewIds.map((viewId) => ({ viewId })),
        },
      });
    expect(parseIds(ids.slice(0, cap)).success).toBe(true);
    const over = parseIds(ids);
    expect(over.success).toBe(false);
    if (!over.success) {
      expect(over.error.issues.some((issue) => issue.code === "too_big")).toBe(true);
    }
  });

  it("refuses a project plugin and a per-project package, which Canopy has no project for", () => {
    const project = parse([{ viewId: "triage" }], {
      origin: "project",
      extra: { scope: "project" },
    });
    expect(codes(project)).toContain("canopyViews_project_scope_forbidden");
    const instanced = parse([{ viewId: "triage" }], { extra: { instanceMode: "project" } });
    expect(codes(instanced)).toContain("canopyViews_project_scope_forbidden");
  });

  it("leaves a project plugin with no Canopy views alone", () => {
    expect(
      codes(parse([], { origin: "project", extra: { scope: "project" } })).filter((code) =>
        code.startsWith("canopy")
      )
    ).toEqual([]);
  });
});
