import { describe, expect, it } from "vitest";
import { categoryIconFor, pluginIconForIdentity } from "../pluginIcons";
import { DEFAULT_PLUGIN_ICON } from "@/components/icons/pluginIconRegistry";
import type { PluginCategoryId } from "@shared/types/plugin";

describe("pluginIconForIdentity", () => {
  it("uses the same generic glyph as the toolbar for uncategorized plugins", () => {
    expect(pluginIconForIdentity("acme.thing", "other")).toBe(DEFAULT_PLUGIN_ICON);
  });

  it("coerces a category that didn't survive IPC to the generic glyph", () => {
    // A version-skewed projection can carry an unknown category; an undefined
    // icon would crash the consuming dialog.
    expect(pluginIconForIdentity("acme.thing", "not-a-category" as PluginCategoryId)).toBe(
      DEFAULT_PLUGIN_ICON
    );
  });

  it("prefers a brand mark over the category fallback", () => {
    expect(pluginIconForIdentity("daintree.github", "other")).not.toBe(DEFAULT_PLUGIN_ICON);
  });

  it("keeps the brand mark regardless of the resolved category", () => {
    expect(pluginIconForIdentity("daintree.github", "forge")).toBe(
      pluginIconForIdentity("daintree.github", "other")
    );
  });

  it("distinguishes the named categories from the generic fallback", () => {
    for (const category of ["forge", "ai", "workspace"] as const) {
      expect(categoryIconFor(category), `"${category}" reads as uncategorized`).not.toBe(
        DEFAULT_PLUGIN_ICON
      );
    }
  });
});
