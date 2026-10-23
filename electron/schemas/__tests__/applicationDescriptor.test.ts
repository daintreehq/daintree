import { describe, expect, it } from "vitest";
import { getPluginManifestSchema } from "../plugin.js";
import type { PluginOrigin } from "../../../shared/types/plugin.js";

/**
 * The top-level `application` descriptor (#14097): a project plugin names its
 * application and points at contributions it already declares. Every reference
 * must resolve in the same manifest before anything loads.
 */

const panel = { id: "overview", name: "Overview", iconId: "puzzle", color: "#ffffff" };
const VIEWS = [
  { id: "overview", componentPath: "dist/overview.js", location: "panel" },
  { id: "books", componentPath: "dist/books.js", location: "sidebar", name: "Books" },
  { id: "prefs", componentPath: "dist/prefs.js", location: "settings" },
];
const tour = {
  id: "welcome",
  title: "Welcome",
  componentPath: "dist/tours/welcome.js",
  chapters: [{ id: "intro", duration: 10, audioUrl: null, narrationHash: "0a1b2c3d" }],
};
const command = (id: string, kind: "command" | "query" = "command") => ({
  id,
  title: "Record a transaction",
  description: "Records one transaction",
  category: "Ledger",
  kind,
  danger: "safe",
});

const FULL_APPLICATION = {
  name: "Ledger",
  iconId: "puzzle",
  destination: "home",
  sidebarViewId: "books",
  settingsViewId: "prefs",
  welcomeTour: { id: "welcome", version: 2 },
  firstWorkflow: "record",
  requiredTools: ["data"],
  presentation: { forgeStats: "hidden", copyTree: "demoted" },
};

function manifest(application: unknown, overrides: Record<string, unknown> = {}) {
  return {
    name: "acme.ledger",
    version: "1.0.0",
    scope: "project",
    engines: { daintree: ">=0.1.0" },
    capabilities: ["mcp:expose"],
    application,
    contributes: {
      panels: [panel],
      views: VIEWS,
      tours: [tour],
      commands: [command("record"), command("balance", "query")],
      agentMcp: [{ id: "data", name: "Ledger data", mode: "tools" }],
      surfaces: { projectHome: { viewId: "overview" } },
    },
    ...overrides,
  };
}

function parse(value: unknown, origin: PluginOrigin = "project") {
  return getPluginManifestSchema(origin).safeParse(value);
}

function issues(result: ReturnType<typeof parse>) {
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    code: (issue as { params?: { errorCode?: string } }).params?.errorCode ?? issue.code,
    path: issue.path.join("."),
  }));
}

function withApplication(patch: Record<string, unknown>) {
  return manifest({ ...FULL_APPLICATION, ...patch });
}

describe("manifest application descriptor (#14097)", () => {
  it("accepts a descriptor whose every reference resolves", () => {
    const result = parse(manifest(FULL_APPLICATION));
    expect(issues(result)).toEqual([]);
    if (!result.success) return;
    expect(result.data.application).toEqual(FULL_APPLICATION);
  });

  it("leaves a manifest without one exactly as it was", () => {
    const result = parse(manifest(undefined));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.application).toBeUndefined();
  });

  it("accepts the minimum: a name and a grid destination", () => {
    const result = parse(
      manifest({ name: "Ledger", destination: "grid" }, {
        contributes: {},
      })
    );
    expect(issues(result)).toEqual([]);
  });

  it("rejects an unknown property, so nothing undeclared can ride along", () => {
    expect(issues(parse(withApplication({ token: "secret" })))).toEqual([
      { code: "unrecognized_keys", path: "application" },
    ]);
  });

  it("rejects a destination outside the host's Home/Grid vocabulary", () => {
    expect(issues(parse(withApplication({ destination: "dashboard" })))).toEqual([
      { code: "invalid_value", path: "application.destination" },
    ]);
  });

  it("is available to project plugins only", () => {
    const { scope: _scope, ...installed } = manifest({ name: "Ledger", destination: "grid" });
    void _scope;
    expect(issues(parse({ ...installed, contributes: {} }, "user"))).toEqual([
      { code: "application_project_scope_only", path: "application" },
    ]);
  });

  it("requires an engine range, so compatibility can be checked before it is put in force", () => {
    expect(issues(parse(manifest(FULL_APPLICATION, { engines: undefined })))).toEqual([
      { code: "application_engine_required", path: "application" },
    ]);
  });

  it("requires a claimed Home to open on Home", () => {
    const value = manifest(FULL_APPLICATION);
    const result = parse({ ...value, contributes: { ...value.contributes, surfaces: {} } });
    expect(issues(result)).toEqual([
      { code: "application_home_unclaimed", path: "application.destination" },
    ]);
  });

  it.each([
    [{ sidebarViewId: "missing" }, "application_sidebar_view_unknown", "application.sidebarViewId"],
    [{ sidebarViewId: "prefs" }, "application_sidebar_view_unknown", "application.sidebarViewId"],
    [{ settingsViewId: "books" }, "application_settings_view_unknown", "application.settingsViewId"],
    [
      { welcomeTour: { id: "missing", version: 1 } },
      "application_tour_unknown",
      "application.welcomeTour.id",
    ],
    [{ firstWorkflow: "missing" }, "application_command_unknown", "application.firstWorkflow"],
    [{ firstWorkflow: "balance" }, "application_command_query", "application.firstWorkflow"],
    [{ requiredTools: ["other"] }, "application_tool_unknown", "application.requiredTools.0"],
    [{ requiredTools: ["data", "data"] }, "too_big", "application.requiredTools"],
    [
      { presentation: { noSuchFeature: "hidden" } },
      "application_presentation_unknown",
      "application.presentation.noSuchFeature",
    ],
    [
      { presentation: { copyTree: "hidden" } },
      "application_presentation_level",
      "application.presentation.copyTree",
    ],
  ])("rejects %j with %s", (patch, code, path) => {
    expect(issues(parse(withApplication(patch)))).toEqual([{ code, path }]);
  });

  it("rejects a welcome tour scoped to one panel", () => {
    const value = manifest(FULL_APPLICATION);
    const result = parse({
      ...value,
      contributes: { ...value.contributes, tours: [{ ...tour, panelKind: "overview" }] },
    });
    expect(issues(result)).toEqual([
      { code: "application_tour_panel_scoped", path: "application.welcomeTour.id" },
    ]);
  });

  it.each([0, 1.5, -1])("rejects welcome tour version %s", (version) => {
    expect(issues(parse(withApplication({ welcomeTour: { id: "welcome", version } })))).toEqual([
      { code: expect.any(String), path: "application.welcomeTour.version" },
    ]);
  });

  it("rejects a blank name", () => {
    expect(issues(parse(withApplication({ name: "   " })))).toEqual([
      { code: "too_small", path: "application.name" },
    ]);
  });
});
