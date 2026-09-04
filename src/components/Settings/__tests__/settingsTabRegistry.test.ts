import { describe, it, expect } from "vitest";
import {
  SETTINGS_REGISTRY,
  globalTabTitles,
  globalTabIcons,
  projectTabTitles,
  projectTabIcons,
  PROJECT_TAB_IDS,
  scopeForTab,
  isSettingsTab,
  getSettingsNavGroups,
  type AnySettingsTabEntry,
  type LazySettingsTabEntry,
  type SettingsTab,
} from "../settingsTabRegistry";
import { GLOBAL_SETTINGS_TAB_IDS, PROJECT_SETTINGS_TAB_IDS } from "../settingsTabIds";

const allEntries: readonly AnySettingsTabEntry[] = SETTINGS_REGISTRY;
const globalEntries = allEntries.filter((e) => e.scope === "global");
const projectEntries = allEntries.filter((e) => e.scope === "project");

describe("SETTINGS_REGISTRY", () => {
  it("has 29 entries (20 global + 9 project)", () => {
    expect(SETTINGS_REGISTRY).toHaveLength(29);
  });

  it("has 20 global entries", () => {
    expect(globalEntries).toHaveLength(20);
  });

  it("has 9 project entries", () => {
    expect(projectEntries).toHaveLength(9);
  });

  it("has no duplicate tab IDs", () => {
    const ids = SETTINGS_REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all global entries have scope 'global'", () => {
    for (const entry of globalEntries) {
      expect(entry.scope).toBe("global");
    }
  });

  it("all project entries have scope 'project'", () => {
    for (const entry of projectEntries) {
      expect(entry.scope).toBe("project");
    }
  });

  it("all project entry IDs start with 'project:'", () => {
    for (const entry of projectEntries) {
      expect(entry.id.startsWith("project:")).toBe(true);
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

  it("has 28 lazy entries (19 global + 9 project)", () => {
    const lazy = SETTINGS_REGISTRY.filter((e) => e.importKind === "lazy");
    expect(lazy).toHaveLength(28);
  });

  it("all global entries belong to known global groups", () => {
    const knownGroups = ["General", "Terminal", "Assistant", "Integrations", "Support"];
    for (const entry of globalEntries) {
      expect(knownGroups).toContain(entry.group);
    }
  });

  it("all project entries belong to the 'Project' group", () => {
    for (const entry of projectEntries) {
      expect(entry.group).toBe("Project");
    }
  });

  it("globalTabTitles covers all global registry entries", () => {
    for (const entry of globalEntries) {
      expect(globalTabTitles).toHaveProperty(entry.id);
      expect(typeof globalTabTitles[entry.id as keyof typeof globalTabTitles]).toBe("string");
    }
  });

  it("globalTabIcons covers all global registry entries", () => {
    for (const entry of globalEntries) {
      expect(globalTabIcons).toHaveProperty(entry.id);
    }
  });

  it("projectTabTitles covers all project registry entries", () => {
    for (const entry of projectEntries) {
      expect(projectTabTitles).toHaveProperty(entry.id);
      expect(typeof projectTabTitles[entry.id as keyof typeof projectTabTitles]).toBe("string");
    }
  });

  it("projectTabIcons covers all project registry entries", () => {
    for (const entry of projectEntries) {
      expect(projectTabIcons).toHaveProperty(entry.id);
    }
  });

  it("project entries are all flagged needsProjectForm", () => {
    for (const entry of projectEntries) {
      if (entry.importKind === "lazy") {
        expect((entry as LazySettingsTabEntry).needsProjectForm).toBe(true);
      }
    }
  });

  it("project:automation does not require onNavigateToTab", () => {
    const automation = allEntries.find((e) => e.id === "project:automation");
    expect(automation).toBeDefined();
    if (automation && automation.importKind === "lazy") {
      expect((automation as LazySettingsTabEntry).needsOnNavigateToTab).toBeFalsy();
    }
  });

  it("global entries do not declare needsProjectForm", () => {
    for (const entry of globalEntries) {
      if (entry.importKind === "lazy") {
        expect((entry as LazySettingsTabEntry).needsProjectForm).toBeFalsy();
      }
    }
  });
});

describe("PROJECT_TAB_IDS", () => {
  it("has 9 entries matching the project registry", () => {
    expect(PROJECT_TAB_IDS).toHaveLength(9);
    expect([...PROJECT_TAB_IDS].sort()).toEqual(projectEntries.map((e) => e.id).sort());
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
    for (const entry of globalEntries) {
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

  it("returns global groups in correct order", () => {
    const groups = getSettingsNavGroups("global");
    expect(groups.map((g) => g.label)).toEqual([
      "General",
      "Terminal",
      "Assistant",
      "Integrations",
      "Support",
    ]);
  });

  it("all 20 global entries are distributed across global groups", () => {
    const groups = getSettingsNavGroups("global");
    const totalEntries = groups.reduce((sum, g) => sum + g.entries.length, 0);
    expect(totalEntries).toBe(20);
  });

  it("global groups contain only global-scoped entries", () => {
    const groups = getSettingsNavGroups("global");
    for (const group of groups) {
      for (const entry of group.entries) {
        expect(entry.scope).toBe("global");
      }
    }
  });

  it("returns single Project group for project scope with 9 entries", () => {
    const groups = getSettingsNavGroups("project");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("Project");
    expect(groups[0]!.scope).toBe("project");
    expect(groups[0]!.entries).toHaveLength(9);
  });

  it("project group entries match the registry order", () => {
    const groups = getSettingsNavGroups("project");
    const expectedOrder = [
      "project:general",
      "project:context",
      "project:variables",
      "project:automation",
      "project:recipes",
      "project:commands",
      "project:notifications",
      "project:code-forge",
      "project:plugins",
    ];
    expect(groups[0]!.entries.map((e) => e.id)).toEqual(expectedOrder);
  });
});

describe("settingsTabIds drift guard", () => {
  it("GLOBAL_SETTINGS_TAB_IDS matches the registry's global entries", () => {
    expect([...GLOBAL_SETTINGS_TAB_IDS].sort()).toEqual(globalEntries.map((e) => e.id).sort());
  });

  it("PROJECT_SETTINGS_TAB_IDS matches the registry's project entries", () => {
    expect([...PROJECT_SETTINGS_TAB_IDS].sort()).toEqual(projectEntries.map((e) => e.id).sort());
  });
});

describe("SettingsTab type coverage", () => {
  it("union of registry IDs equals 29", () => {
    const allIds = new Set(SETTINGS_REGISTRY.map((e) => e.id));
    expect(allIds.size).toBe(29);
  });
});
