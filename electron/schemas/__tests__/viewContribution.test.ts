import { describe, it, expect } from "vitest";
import { ViewContributionSchema } from "../plugin.js";

const base = { id: "main", name: "Main", componentPath: "./dist/view.js", location: "panel" };

describe("ViewContributionSchema (issue #10464)", () => {
  it("accepts a minimal panel view contribution", () => {
    expect(ViewContributionSchema.safeParse(base).success).toBe(true);
  });

  it("accepts a componentPath without a leading ./", () => {
    expect(ViewContributionSchema.safeParse({ ...base, componentPath: "view.js" }).success).toBe(
      true
    );
  });

  it("accepts optional iconId and description", () => {
    const result = ViewContributionSchema.safeParse({
      ...base,
      iconId: "Plug",
      description: "A view",
    });
    expect(result.success).toBe(true);
  });

  it("rejects location 'sidebar' at the schema boundary (no sidebar host yet)", () => {
    expect(ViewContributionSchema.safeParse({ ...base, location: "sidebar" }).success).toBe(false);
  });

  it("rejects an unknown location value", () => {
    expect(ViewContributionSchema.safeParse({ ...base, location: "floating" }).success).toBe(false);
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
