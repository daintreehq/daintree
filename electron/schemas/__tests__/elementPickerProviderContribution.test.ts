import { describe, expect, it } from "vitest";
import { getPluginManifestSchema } from "../plugin.js";
import type { PluginOrigin } from "../../../shared/types/plugin.js";

const PROVIDER = {
  id: "qwik",
  name: "Qwik",
  detection: [{ kind: "global", name: "qwikevents", match: "exact" }],
  guestEntry: "guest/qwik.js",
};

function parse(
  contributes: Record<string, unknown>,
  capabilities: string[] = ["preview:inspect"],
  origin: PluginOrigin = "user"
) {
  return getPluginManifestSchema(origin).safeParse({
    name: "acme.qwik",
    version: "1.0.0",
    ...(origin === "project" ? { scope: "project" } : {}),
    capabilities,
    contributes,
  });
}

function provider(overrides: Record<string, unknown> = {}) {
  return { ...PROVIDER, ...overrides };
}

describe("contributes.elementPickerProviders (#14073)", () => {
  it("defaults to an empty list", () => {
    const result = parse({});
    expect(result.data?.contributes.elementPickerProviders).toEqual([]);
  });

  it("accepts a provider with preview:inspect", () => {
    expect(parse({ elementPickerProviders: [provider()] }).success).toBe(true);
  });

  it("requires preview:inspect", () => {
    const result = parse({ elementPickerProviders: [provider()] }, []);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("preview_inspect_capability_required");
  });

  it("requires fs:project-read for a resolverEntry", () => {
    const withResolver = provider({ resolverEntry: "resolver/qwik.js" });
    const without = parse({ elementPickerProviders: [withResolver] });
    expect(without.success).toBe(false);
    expect(JSON.stringify(without.error?.issues)).toContain("fs_project_read_capability_required");
    expect(
      parse({ elementPickerProviders: [withResolver] }, ["preview:inspect", "fs:project-read"])
        .success
    ).toBe(true);
  });

  it.each(["svelte", "react", "vue", "angular", "astro", "preact", "solid"])(
    "reserves the core name %s",
    (id) => {
      expect(parse({ elementPickerProviders: [provider({ id })] }).success).toBe(false);
    }
  );

  it.each(["Qwik", "a.b", "a b", "-x", "x-"])("refuses the local id %s", (id) => {
    expect(parse({ elementPickerProviders: [provider({ id })] }).success).toBe(false);
  });

  it("refuses duplicate ids", () => {
    expect(parse({ elementPickerProviders: [provider(), provider()] }).success).toBe(false);
  });

  it("allows several providers", () => {
    expect(
      parse({ elementPickerProviders: [provider(), provider({ id: "marko", name: "Marko" })] })
        .success
    ).toBe(true);
  });

  it.each([
    ["unsafe guestEntry", { guestEntry: "../escape.js" }],
    ["absolute guestEntry", { guestEntry: "/etc/passwd" }],
    ["URL resolverEntry", { resolverEntry: "https://example.com/r.js" }],
    ["no rules", { detection: [] }],
    ["too many rules", { detection: Array.from({ length: 17 }, (_, i) => rule(`m${i}`)) }],
    ["regex marker", { detection: [rule("(?=x)")] }],
    ["selector marker", { detection: [rule("div > span")] }],
    ["unknown kind", { detection: [{ kind: "script", name: "x", match: "exact" }] }],
    ["unknown match", { detection: [{ kind: "global", name: "x", match: "regex" }] }],
    ["unknown field", { evaluate: "1" }],
  ])("refuses %s", (_label, overrides) => {
    expect(
      parse({ elementPickerProviders: [provider(overrides)] }, [
        "preview:inspect",
        "fs:project-read",
      ]).success
    ).toBe(false);
  });

  it("refuses more than the cap", () => {
    const many = Array.from({ length: 21 }, (_, i) => provider({ id: `p${i}` }));
    expect(parse({ elementPickerProviders: many }).success).toBe(false);
  });

  it("is allowed in a project plugin", () => {
    expect(
      parse({ elementPickerProviders: [provider()] }, ["preview:inspect"], "project").success
    ).toBe(true);
  });
});

function rule(name: string) {
  return { kind: "global", name, match: "exact" };
}
