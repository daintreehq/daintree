import { describe, it, expect } from "vitest";
import { filterSettings, countMatchesPerTab } from "../settingsSearchUtils";
import { SETTINGS_SEARCH_INDEX } from "../settingsSearchIndex";

describe("filterSettings", () => {
  it("returns empty array for empty query", () => {
    expect(filterSettings(SETTINGS_SEARCH_INDEX, "")).toHaveLength(0);
    expect(filterSettings(SETTINGS_SEARCH_INDEX, "   ")).toHaveLength(0);
  });

  it("matches by title (case-insensitive)", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "Scrollback History");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.tab === "terminal")).toBe(true);
  });

  it("matches by description text", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "JetBrains");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tab).toBe("terminalAppearance");
  });

  it("matches by keyword", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "hibernate");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.tab === "general")).toBe(true);
  });

  it("matches by tab label", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "Notifications");
    expect(results.some((r) => r.tab === "notifications")).toBe(true);
  });

  it("is case-insensitive", () => {
    const lower = filterSettings(SETTINGS_SEARCH_INDEX, "scrollback");
    const upper = filterSettings(SETTINGS_SEARCH_INDEX, "SCROLLBACK");
    expect(lower).toEqual(upper);
  });

  it("trims whitespace from query", () => {
    const trimmed = filterSettings(SETTINGS_SEARCH_INDEX, "font");
    const padded = filterSettings(SETTINGS_SEARCH_INDEX, "  font  ");
    expect(trimmed).toEqual(padded);
  });

  it("handles special regex characters safely", () => {
    expect(() => filterSettings(SETTINGS_SEARCH_INDEX, "(")).not.toThrow();
    expect(() => filterSettings(SETTINGS_SEARCH_INDEX, ".*+?^${}|[]\\")).not.toThrow();
  });

  it("returns no results for unmatched query", () => {
    expect(filterSettings(SETTINGS_SEARCH_INDEX, "zzznomatch999")).toHaveLength(0);
  });

  it("matches github token entry", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "github token");
    expect(results.some((r) => r.id === "github-token")).toBe(true);
  });

  it("can match across multiple tabs", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "agent");
    const tabs = new Set(results.map((r) => r.tab));
    expect(tabs.size).toBeGreaterThan(1);
  });
});

describe("countMatchesPerTab", () => {
  it("returns empty object for empty results", () => {
    expect(countMatchesPerTab([])).toEqual({});
  });

  it("counts correctly for single tab results", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "scrollback");
    const counts = countMatchesPerTab(results);
    expect(counts.terminal).toBeGreaterThanOrEqual(1);
  });

  it("aggregates counts across multiple tabs", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "default");
    const counts = countMatchesPerTab(results);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(results.length);
  });

  it("only includes tabs that have matches", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "github token");
    const counts = countMatchesPerTab(results);
    expect(Object.keys(counts)).toEqual(["github"]);
  });
});

describe("SETTINGS_SEARCH_INDEX", () => {
  it("has entries covering all 12 settings tabs", () => {
    const tabs = new Set(SETTINGS_SEARCH_INDEX.map((e) => e.tab));
    const expectedTabs = [
      "general",
      "keyboard",
      "terminal",
      "terminalAppearance",
      "worktree",
      "agents",
      "github",
      "sidecar",
      "toolbar",
      "notifications",
      "editor",
      "troubleshooting",
    ];
    for (const tab of expectedTabs) {
      expect(tabs.has(tab as never), `tab "${tab}" should be in index`).toBe(true);
    }
  });

  it("has no duplicate ids", () => {
    const ids = SETTINGS_SEARCH_INDEX.map((e) => e.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("every entry has required fields", () => {
    for (const entry of SETTINGS_SEARCH_INDEX) {
      expect(entry.id, "id should be defined").toBeTruthy();
      expect(entry.tab, "tab should be defined").toBeTruthy();
      expect(entry.tabLabel, "tabLabel should be defined").toBeTruthy();
      expect(entry.section, "section should be defined").toBeTruthy();
      expect(entry.title, "title should be defined").toBeTruthy();
      expect(entry.description, "description should be defined").toBeTruthy();
    }
  });
});
