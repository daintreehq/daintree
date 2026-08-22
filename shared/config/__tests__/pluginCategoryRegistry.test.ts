import { describe, expect, it } from "vitest";
import {
  PLUGIN_CATEGORIES,
  getPluginCategoryMeta,
  isPluginCategoryId,
  resolvePluginCategory,
} from "../pluginCategoryRegistry.js";
import { PLUGIN_CATEGORY_IDS, type PluginManifest } from "../../types/plugin.js";

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "acme.test-plugin",
    version: "1.0.0",
    contributes: {
      panels: [],
      toolbarButtons: [],
      menuItems: [],
      keybindings: [],
      contextMenus: [],
      commands: [],
      views: [],
      mcpServers: [],
      skills: [],
      forgeProviders: [],
      fileDecorationProviders: [],
      agents: [],
      processTools: [],
      recipes: [],
      settings: [],
    },
    ...overrides,
  };
}

describe("pluginCategoryRegistry", () => {
  it("covers every category id with exactly one meta entry, in a unique order", () => {
    const metaIds = PLUGIN_CATEGORIES.map((c) => c.id);
    expect(new Set(metaIds).size).toBe(metaIds.length);
    expect([...metaIds].sort()).toEqual([...PLUGIN_CATEGORY_IDS].sort());
    // Labels must be distinct — two sections with the same header would be
    // indistinguishable in the listbox.
    const labels = PLUGIN_CATEGORIES.map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("does not let process-tool detections alone claim a catalog category (#11613)", () => {
    // Deliberate: a command → icon mapping says nothing about what a plugin is
    // for, so it must not pull the plugin out of the fallback bucket the way a
    // forge provider or an agent does.
    const manifest = makeManifest();
    const before = resolvePluginCategory(manifest);
    manifest.contributes.processTools = [{ command: "acme-cli", iconId: "sparkles" }];
    expect(resolvePluginCategory(manifest)).toBe(before);
  });

  it("places the fallback category last so real categories render above it", () => {
    expect(PLUGIN_CATEGORIES[PLUGIN_CATEGORIES.length - 1]?.id).toBe("other");
  });

  it("returns meta for every id", () => {
    for (const id of PLUGIN_CATEGORY_IDS) {
      expect(getPluginCategoryMeta(id).id).toBe(id);
    }
  });

  it("accepts only known category ids", () => {
    for (const id of PLUGIN_CATEGORY_IDS) expect(isPluginCategoryId(id)).toBe(true);
    expect(isPluginCategoryId("themes")).toBe(false);
    expect(isPluginCategoryId(undefined)).toBe(false);
    expect(isPluginCategoryId(42)).toBe(false);
  });

  describe("resolvePluginCategory", () => {
    it("prefers a declared category over derivation", () => {
      const manifest = makeManifest({ category: "workspace" });
      manifest.contributes.forgeProviders = [
        { id: "gh", name: "GitHub", matches: ["github.com"] } as never,
      ];
      expect(resolvePluginCategory(manifest)).toBe("workspace");
    });

    it("derives forge from a forge-provider contribution", () => {
      const manifest = makeManifest();
      manifest.contributes.forgeProviders = [
        { id: "gh", name: "GitHub", matches: ["github.com"] } as never,
      ];
      expect(resolvePluginCategory(manifest)).toBe("forge");
    });

    it("derives ai from agent or MCP-server contributions", () => {
      const withAgent = makeManifest();
      withAgent.contributes.agents = [{ id: "bot" } as never];
      expect(resolvePluginCategory(withAgent)).toBe("ai");

      const withMcp = makeManifest();
      withMcp.contributes.mcpServers = [{ id: "srv" } as never];
      expect(resolvePluginCategory(withMcp)).toBe("ai");
    });

    it("derives workspace from panel or view contributions", () => {
      const withPanel = makeManifest();
      withPanel.contributes.panels = [{ id: "notes" } as never];
      expect(resolvePluginCategory(withPanel)).toBe("workspace");

      const withView = makeManifest();
      withView.contributes.views = [{ id: "v" } as never];
      expect(resolvePluginCategory(withView)).toBe("workspace");
    });

    it("falls back to other when nothing identity-defining is contributed", () => {
      const manifest = makeManifest();
      manifest.contributes.toolbarButtons = [{ id: "btn" } as never];
      expect(resolvePluginCategory(manifest)).toBe("other");
    });

    it("ignores an unknown declared category and derives instead", () => {
      const manifest = makeManifest({ category: "not-a-category" as never });
      manifest.contributes.panels = [{ id: "notes" } as never];
      expect(resolvePluginCategory(manifest)).toBe("workspace");
    });
  });
});
