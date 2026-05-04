import { describe, it, expect } from "vitest";
import {
  SETTINGS_REGISTRY,
  globalTabTitles,
  globalTabIcons,
  PROJECT_TAB_IDS,
  scopeForTab,
  isSettingsTab,
  getSettingsNavGroups,
  type SettingsTab,
} from "../settingsTabRegistry";

describe("SETTINGS_REGISTRY", () => {
  it("has 17 entries (all global tabs)", () => {
    expect(SETTINGS_REGISTRY).toHaveLength(17);
  });

  it("has no duplicate tab IDs", () => {
    const ids = SETTINGS_REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all entries have scope 'global'", () => {
    for (const entry of SETTINGS_REGISTRY) {
      expect(entry.scope).toBe("global");
    }
  });

  it("all lazy entries have importer and LazyComponent", () => {
    for (const entry of SETTINGS_REGISTRY) {
      if (entry.importKind === "lazy") {
        expect(entry.importer).toBeDefined();
        expect(entry.LazyComponent).toBeDefined();
      }
    }
  });

  it("all eager entries have Component", () => {
    for (const entry of SETTINGS_REGISTRY) {
      if (entry.importKind === "eager") {
        expect(entry.Component).toBeDefined();
      }
    }
  });

  it("has exactly one eager entry (general)", () => {
    const eager = SETTINGS_REGISTRY.filter((e) => e.importKind === "eager");
    expect(eager).toHaveLength(1);
    expect(eager[0]!.id).toBe("general");
  });

  it("has 16 lazy entries", () => {
    const lazy = SETTINGS_REGISTRY.filter((e) => e.importKind === "lazy");
    expect(lazy).toHaveLength(16);
  });

  it("all entries belong to known groups", () => {
    const knownGroups = ["General", "Terminal", "Assistant", "Integrations", "Support"];
    for (const entry of SETTINGS_REGISTRY) {
      expect(knownGroups).toContain(entry.group);
    }
  });

  it("globalTabTitles covers all registry entries", () => {
    for (const entry of SETTINGS_REGISTRY) {
      expect(globalTabTitles).toHaveProperty(entry.id);
      expect(typeof globalTabTitles[entry.id as keyof typeof globalTabTitles]).toBe("string");
    }
  });

  it("globalTabIcons covers all registry entries", () => {
    for (const entry of SETTINGS_REGISTRY) {
      expect(globalTabIcons).toHaveProperty(entry.id);
    }
  });

  it("does not contain project tab IDs", () => {
    const registryIds = new Set(SETTINGS_REGISTRY.map((e) => e.id));
    for (const id of PROJECT_TAB_IDS) {
      expect(registryIds.has(id)).toBe(false);
    }
  });
});

describe("PROJECT_TAB_IDS", () => {
  it("has 8 entries", () => {
    expect(PROJECT_TAB_IDS).toHaveLength(8);
  });

  it("all start with 'project:'", () => {
    for (const id of PROJECT_TAB_IDS) {
      expect(id.startsWith("project:")).toBe(true);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(PROJECT_TAB_IDS).size).toBe(PROJECT_TAB_IDS.length);
  });
});

describe("scopeForTab", () => {
  it('returns "global" for global tabs', () => {
    for (const entry of SETTINGS_REGISTRY) {
      expect(scopeForTab(entry.id as SettingsTab)).toBe("global");
    }
  });

  it('returns "project" for project tabs', () => {
    for (const id of PROJECT_TAB_IDS) {
      expect(scopeForTab(id as SettingsTab)).toBe("project");
    }
  });
});

describe("isSettingsTab", () => {
  it("returns true for all registry entries", () => {
    for (const entry of SETTINGS_REGISTRY) {
      expect(isSettingsTab(entry.id)).toBe(true);
    }
  });

  it("returns true for all project tab IDs", () => {
    for (const id of PROJECT_TAB_IDS) {
      expect(isSettingsTab(id)).toBe(true);
    }
  });

  it("returns false for unknown IDs", () => {
    expect(isSettingsTab("nonexistent")).toBe(false);
    expect(isSettingsTab("")).toBe(false);
  });
});

describe("getSettingsNavGroups", () => {
  it("returns 5 groups for global scope", () => {
    const groups = getSettingsNavGroups("global");
    expect(groups).toHaveLength(5);
  });

  it("returns groups in correct order", () => {
    const groups = getSettingsNavGroups("global");
    expect(groups.map((g) => g.label)).toEqual([
      "General",
      "Terminal",
      "Assistant",
      "Integrations",
      "Support",
    ]);
  });

  it("all 17 entries are distributed across global groups", () => {
    const groups = getSettingsNavGroups("global");
    const totalEntries = groups.reduce((sum, g) => sum + g.entries.length, 0);
    expect(totalEntries).toBe(17);
  });

  it("returns single Project group for project scope", () => {
    const groups = getSettingsNavGroups("project");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("Project");
    expect(groups[0]!.scope).toBe("project");
  });
});

describe("SettingsTab type coverage", () => {
  it("union of registry IDs + project tab IDs equals 25", () => {
    const allIds = new Set([...SETTINGS_REGISTRY.map((e) => e.id), ...PROJECT_TAB_IDS]);
    expect(allIds.size).toBe(25);
  });
});
