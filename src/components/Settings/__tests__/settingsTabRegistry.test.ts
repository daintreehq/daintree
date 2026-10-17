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

const allEntries: readonly AnySettingsTabEntry[] = SETTINGS_REGISTRY;
const globalEntries = allEntries.filter((e) => e.scope === "global");
const projectEntries = allEntries.filter((e) => e.scope === "project");

describe("SETTINGS_REGISTRY", () => {
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
