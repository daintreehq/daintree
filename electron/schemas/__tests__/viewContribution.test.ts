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

  // `description` was removed (#10888): the matching panel owns a view's
  // display metadata, so nothing at runtime read it. Strict validation rejects
  // it, keeping the frozen contract honest.
  it("rejects the removed view field description (strict)", () => {
    expect(ViewContributionSchema.safeParse({ ...base, description: "x" }).success).toBe(false);
  });

  it("accepts location 'settings' — the plugin's custom settings section", () => {
    expect(ViewContributionSchema.safeParse({ ...base, location: "settings" }).success).toBe(true);
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
