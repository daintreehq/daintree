import { describe, expect, it } from "vitest";
import { categoryIconFor, pluginIconForIdentity } from "../pluginIcons";
import { DEFAULT_PLUGIN_ICON } from "@/components/icons/pluginIconRegistry";
import { GitHubIcon } from "@/components/icons";
import { PLUGIN_CATEGORIES } from "@shared/config/pluginCategoryRegistry";
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
    expect(pluginIconForIdentity("daintree.github", "other")).toBe(GitHubIcon);
  });

  it("keeps the brand mark regardless of the resolved category", () => {
    expect(pluginIconForIdentity("daintree.github", "forge")).toBe(
      pluginIconForIdentity("daintree.github", "other")
    );
  });

  it("gives every category its own glyph", () => {
    // The point of per-category icons is that no two adjacent categories read
    // identically — "not the fallback" alone would let them all share one.
    const seen = new Map<unknown, string>();
    for (const { id } of PLUGIN_CATEGORIES) {
      const icon = categoryIconFor(id);
      const clash = seen.get(icon);
      expect(clash, `"${id}" uses the same glyph as "${clash}"`).toBeUndefined();
      seen.set(icon, id);
    }
  });

  it("reserves the generic glyph for the uncategorized case", () => {
    for (const { id } of PLUGIN_CATEGORIES) {
      if (id === "other") continue;
      expect(categoryIconFor(id), `"${id}" reads as uncategorized`).not.toBe(DEFAULT_PLUGIN_ICON);
    }
  });
});
