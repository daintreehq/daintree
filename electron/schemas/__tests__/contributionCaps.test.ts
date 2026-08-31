import { describe, expect, it } from "vitest";
import { getPluginManifestSchema, MANIFEST_CONTRIBUTION_CAPS } from "../plugin.js";
import type { PluginOrigin } from "../../../shared/types/plugin.js";

function parseContributes(contributes: Record<string, unknown>, origin: PluginOrigin = "user") {
  return getPluginManifestSchema(origin).safeParse({
    name: "acme.caps-test",
    version: "1.0.0",
    contributes,
  });
}

const setting = (i: number) => ({ id: `setting-${i}`, type: "string" });
const menuItem = (i: number) => ({
  label: `Item ${i}`,
  actionId: `acme.caps-test.action-${i}`,
  location: "terminal" as const,
});

describe("contributes.* array-size caps (#10477)", () => {
  it("accepts an array exactly at the cap", () => {
    const cap = MANIFEST_CONTRIBUTION_CAPS.settings;
    const result = parseContributes({
      settings: Array.from({ length: cap }, (_, i) => setting(i)),
    });
    expect(result.success).toBe(true);
  });

  it("rejects an array one over the cap", () => {
    const cap = MANIFEST_CONTRIBUTION_CAPS.settings;
    const result = parseContributes({
      settings: Array.from({ length: cap + 1 }, (_, i) => setting(i)),
    });
    expect(result.success).toBe(false);
  });

  it("enforces a distinct cap per contribution point", () => {
    const menuCap = MANIFEST_CONTRIBUTION_CAPS.menuItems;
    expect(
      parseContributes({
        menuItems: Array.from({ length: menuCap }, (_, i) => menuItem(i)),
      }).success
    ).toBe(true);
    expect(
      parseContributes({
        menuItems: Array.from({ length: menuCap + 1 }, (_, i) => menuItem(i)),
      }).success
    ).toBe(false);
  });

  it.each(Object.keys(MANIFEST_CONTRIBUTION_CAPS))(
    "rejects contributes.%s when one entry over its cap",
    (key) => {
      const cap = MANIFEST_CONTRIBUTION_CAPS[key as keyof typeof MANIFEST_CONTRIBUTION_CAPS];
      // Fill with `null` entries: the array-length `.max()` check runs before
      // per-element validation, so an over-length array is rejected regardless of
      // element shape. (At/under cap, element validation would apply.)
      const result = parseContributes({ [key]: new Array(cap + 1).fill(null) });
      expect(result.success).toBe(false);
    }
  );

  it("exposes a cap for every contributes.* array key", () => {
    // Guard against a new contribution point being added to the schema without a
    // matching cap — every declared array must be bounded.
    const parsed = parseContributes({});
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    for (const key of Object.keys(parsed.data.contributes)) {
      expect(MANIFEST_CONTRIBUTION_CAPS).toHaveProperty(key);
      expect(
        MANIFEST_CONTRIBUTION_CAPS[key as keyof typeof MANIFEST_CONTRIBUTION_CAPS]
      ).toBeGreaterThan(0);
    }
  });
});
