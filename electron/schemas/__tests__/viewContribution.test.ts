import { describe, it, expect } from "vitest";
import { ViewContributionSchema } from "../plugin.js";
import {
  SIDEBAR_VIEW_NAME_MAX_LENGTH,
  SIDEBAR_VIEW_PRIORITY_MAX,
  SIDEBAR_VIEW_PRIORITY_MIN,
} from "../../../shared/types/plugin.js";

const base = { id: "main", componentPath: "./dist/view.js", location: "panel" };

describe("ViewContributionSchema (issue #10464)", () => {
  it("accepts a minimal panel view contribution", () => {
    expect(ViewContributionSchema.safeParse(base).success).toBe(true);
  });

  it("accepts a componentPath without a leading ./", () => {
    expect(ViewContributionSchema.safeParse({ ...base, componentPath: "view.js" }).success).toBe(
      true
    );
  });

  it("accepts an optional iconId", () => {
    const result = ViewContributionSchema.safeParse({ ...base, iconId: "Plug" });
    expect(result.success).toBe(true);
  });

  // `description` was removed from panel views (#10888): the matching panel
  // owns a view's display metadata. It came back for settings views only
  // (#14101), so the manifest `superRefine` rejects it on any other location —
  // see `pluginManifestIntegrity.test.ts`.

  it("accepts location 'settings' — the plugin's custom settings section", () => {
    expect(ViewContributionSchema.safeParse({ ...base, location: "settings" }).success).toBe(true);
  });

  it("accepts a settings view's search title, description and pages", () => {
    const result = ViewContributionSchema.safeParse({
      ...base,
      location: "settings",
      title: " Board layout ",
      description: "Columns and swimlanes",
      pages: [
        { id: "columns", title: "Columns" },
        { id: "lanes", title: "Swimlanes", description: "Group cards by assignee" },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.data?.title).toBe("Board layout");
  });

  it.each([
    ["no pages", { pages: [] }],
    ["a page with an unsafe id", { pages: [{ id: "a b", title: "A" }] }],
    ["a page with a blank title", { pages: [{ id: "a", title: "  " }] }],
    ["a page with an unknown field", { pages: [{ id: "a", title: "A", viewPath: "x.js" }] }],
    ["a blank title", { title: "  " }],
  ])("rejects a settings view with %s", (_label, extra) => {
    expect(
      ViewContributionSchema.safeParse({ ...base, location: "settings", ...extra }).success
    ).toBe(false);
  });

  it("rejects a page id declared twice", () => {
    const result = ViewContributionSchema.safeParse({
      ...base,
      location: "settings",
      pages: [
        { id: "columns", title: "Columns" },
        { id: "columns", title: "Columns again" },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["pages", 1, "id"]);
  });

  it("accepts a sidebar view with its switcher fields", () => {
    const result = ViewContributionSchema.safeParse({
      ...base,
      location: "sidebar",
      name: "  Board  ",
      iconId: "list",
      priority: 250,
      when: "isGitBacked",
    });
    expect(result.success).toBe(true);
    expect(result.data?.name).toBe("Board");
  });

  it.each([
    ["a fractional priority", { priority: 1.5 }],
    ["a priority below the range", { priority: SIDEBAR_VIEW_PRIORITY_MIN - 1 }],
    ["a priority above the range", { priority: SIDEBAR_VIEW_PRIORITY_MAX + 1 }],
    ["a blank name", { name: "   " }],
    [
      "a name longer than the header can hold",
      { name: "x".repeat(SIDEBAR_VIEW_NAME_MAX_LENGTH + 1) },
    ],
    ["an empty when", { when: "" }],
  ])("rejects a sidebar view with %s", (_label, extra) => {
    expect(
      ViewContributionSchema.safeParse({ ...base, location: "sidebar", name: "Board", ...extra })
        .success
    ).toBe(false);
  });

  it("rejects a missing location", () => {
    const { location: _omit, ...withoutLocation } = base;
    expect(ViewContributionSchema.safeParse(withoutLocation).success).toBe(false);
  });

  it.each([
    ["a traversal escape", "../escape.js"],
    ["a mid-path traversal", "dist/../escape.js"],
    ["a leading-dot traversal", "./../escape.js"],
    ["an absolute path", "/abs/path.js"],
    ["an http URL scheme", "https://evil.example/view.js"],
    ["a backslash separator", "dist\\view.js"],
    ["a query string", "view.js?cache=1"],
    ["a fragment", "view.js#frag"],
    ["an embedded NUL", "view\0.js"],
    ["a bare current-dir", "."],
    ["a bare current-dir with slash", "./"],
  ])("rejects an unsafe componentPath: %s", (_label, componentPath) => {
    expect(ViewContributionSchema.safeParse({ ...base, componentPath }).success).toBe(false);
  });

  it("rejects an empty componentPath", () => {
    expect(ViewContributionSchema.safeParse({ ...base, componentPath: "" }).success).toBe(false);
  });

  it("rejects unknown top-level fields (strict)", () => {
    expect(ViewContributionSchema.safeParse({ ...base, extra: true }).success).toBe(false);
  });
});
