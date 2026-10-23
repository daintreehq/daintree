import { describe, expect, it } from "vitest";
import { getPluginManifestSchema } from "../plugin.js";
import type { PluginOrigin } from "../../../shared/types/plugin.js";

function parse(contextProviders: unknown, origin: PluginOrigin = "user") {
  return getPluginManifestSchema(origin).safeParse({
    name: "acme.kanban",
    version: "1.0.0",
    ...(origin === "project" ? { scope: "project" } : {}),
    contributes: { contextProviders },
  });
}

function issues(result: ReturnType<typeof parse>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe("contributes.contextProviders schema (#13795)", () => {
  it("accepts providers from installed and project plugins and defaults the group to empty", () => {
    const providers = [{ id: "cards", prefix: "rec", label: "Cards" }];
    expect(parse(providers).success).toBe(true);
    expect(parse(providers, "project").success).toBe(true);

    const empty = getPluginManifestSchema("user").parse({ name: "acme.none", version: "1.0.0" });
    expect(empty.contributes.contextProviders).toEqual([]);
  });

  it("refuses the composer's own words and anything but a short lowercase word", () => {
    for (const prefix of ["diff", "terminal", "selection"]) {
      expect(issues(parse([{ id: "x", prefix, label: "X" }])).join()).toContain("reserves");
    }
    for (const prefix of ["Rec", "rec1", "re-c", "", "a".repeat(17)]) {
      expect(parse([{ id: "x", prefix, label: "X" }]).success).toBe(false);
    }
  });

  it("refuses one plugin claiming a prefix twice, and unknown fields", () => {
    const twice = parse([
      { id: "a", prefix: "rec", label: "A" },
      { id: "b", prefix: "rec", label: "B" },
    ]);
    expect(issues(twice).join()).toContain('Prefix "rec" is claimed by more than one');
    expect(parse([{ id: "a", prefix: "rec", label: "A", submit: true }]).success).toBe(false);
  });
});
