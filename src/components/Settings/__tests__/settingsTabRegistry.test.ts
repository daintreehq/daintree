import { describe, it, expect } from "vitest";
import {
  SETTINGS_REGISTRY,
  PROJECT_TAB_IDS,
  scopeForTab,
  isSettingsTab,
  type AnySettingsTabEntry,
  type LazySettingsTabEntry,
  type SettingsTab,
} from "../settingsTabRegistry";
import { SETTINGS_SEARCH_INDEX } from "../settingsSearchIndex";
import { filterSettings } from "../settingsSearchUtils";

const allEntries: readonly AnySettingsTabEntry[] = SETTINGS_REGISTRY;
const globalEntries = allEntries.filter((e) => e.scope === "global");
const projectEntries = allEntries.filter((e) => e.scope === "project");

describe("SETTINGS_REGISTRY", () => {
  it("tells the agents tab when it's hidden, so a prefetched tab runs no CLI copies (#16409)", () => {
    const agents = SETTINGS_REGISTRY.find((entry) => entry.id === "agents") as LazySettingsTabEntry;
    expect(agents.needsIsActive).toBe(true);
  });

  it("tells the decisions tab when it's hidden, so a tab read ahead doesn't count as seen with Connection first (#18058)", () => {
    const decisions = SETTINGS_REGISTRY.find((e) => e.id === "decisions");
    expect(decisions && "needsIsActive" in decisions && decisions.needsIsActive).toBe(true);
  });

  it.each([
    ["recovery kit", "decisions-recovery-kit-save"],
    ["recovery", "decisions-recovery-kit-save"],
    ["rotate keys", "decisions-rotate-keys"],
    ["encryption", "decisions-rotate-keys"],
    ["export", "decisions-data-export"],
  ])("indexes %s under Decisions for settings search (#18065)", (term, id) => {
    const decisions = SETTINGS_REGISTRY.find((e) => e.id === "decisions") as LazySettingsTabEntry;
    const hit = decisions.sections?.find((e) => e.id === id);
    expect(hit).toBeDefined();
    const hay = [hit!.section, hit!.title, hit!.description, ...(hit!.keywords ?? [])]
      .join(" ")
      .toLowerCase();
    expect(hay).toContain(term);
  });

  it.each(["agents", "ask_human", "claude", "codex"])(
    "finds Decisions' Agents section when searching %s (#18057)",
    (term) => {
      const ids = filterSettings(SETTINGS_SEARCH_INDEX, term).map((entry) => entry.id);
      expect(ids).toContain("decisions-agents");
    }
  );

  it("has no duplicate tab IDs", () => {
    const ids = SETTINGS_REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all global entries belong to known global groups", () => {
    const knownGroups = ["General", "Terminal", "Assistant", "Integrations", "Support"];
    for (const entry of globalEntries) {
      expect(knownGroups).toContain(entry.group);
    }
  });

  it("project entries are all flagged needsProjectForm", () => {
    for (const entry of projectEntries) {
      if (entry.importKind === "lazy") {
        expect((entry as LazySettingsTabEntry).needsProjectForm).toBe(true);
      }
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
  it("returns false for unknown IDs", () => {
    expect(isSettingsTab("nonexistent")).toBe(false);
    expect(isSettingsTab("")).toBe(false);
  });
});
