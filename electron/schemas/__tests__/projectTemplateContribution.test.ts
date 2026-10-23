import { describe, expect, it } from "vitest";
import { getPluginManifestSchema } from "../plugin.js";
import type { PluginOrigin } from "../../../shared/types/plugin.js";

const SITE = {
  id: "static-site",
  title: "Static site",
  description: "A site with a build recipe.",
};

function parse(projectTemplates: unknown, origin: PluginOrigin = "user") {
  return getPluginManifestSchema(origin).safeParse({
    name: "acme.sites",
    version: "1.0.0",
    ...(origin === "project" ? { scope: "project" } : {}),
    contributes: { projectTemplates },
  });
}

function errorCodes(result: ReturnType<typeof parse>): string[] {
  if (result.success) return [];
  return result.error.issues.map(
    (issue) => (issue as { params?: { errorCode?: string } }).params?.errorCode ?? issue.code
  );
}

describe("contributes.projectTemplates (#13825)", () => {
  it("accepts a template with an icon and defaults to none", () => {
    const withIcon = parse([{ ...SITE, iconId: "globe" }]);
    expect(withIcon.success && withIcon.data.contributes.projectTemplates).toEqual([
      { ...SITE, iconId: "globe" },
    ]);

    const none = getPluginManifestSchema("user").safeParse({ name: "acme.x", version: "1.0.0" });
    expect(none.success && none.data.contributes.projectTemplates).toEqual([]);
  });

  it.each([
    ["a dot segment", "."],
    ["a parent segment", ".."],
    ["a path", "site/nested"],
    ["upper case", "Site"],
    ["a leading hyphen", "-site"],
    ["a doubled hyphen", "static--site"],
  ])("refuses an id with %s, since it names the payload folder", (_label, id) => {
    expect(parse([{ ...SITE, id }]).success).toBe(false);
  });

  it("requires a title and a description", () => {
    expect(parse([{ id: "site", title: "Site" }]).success).toBe(false);
    expect(parse([{ id: "site", description: "A site." }]).success).toBe(false);
    expect(parse([{ ...SITE, title: "   " }]).success).toBe(false);
  });

  it("refuses an unknown key", () => {
    expect(parse([{ ...SITE, path: "elsewhere" }]).success).toBe(false);
  });

  it("refuses two templates with one id", () => {
    expect(errorCodes(parse([SITE, { ...SITE, title: "Another" }]))).toContain(
      "duplicate_contribution_id"
    );
  });

  it("is open to builtin plugins and closed to project plugins", () => {
    expect(parse([SITE], "builtin").success).toBe(true);
    expect(errorCodes(parse([SITE], "project"))).toContain(
      "projectTemplates_project_scope_forbidden"
    );
  });
});
