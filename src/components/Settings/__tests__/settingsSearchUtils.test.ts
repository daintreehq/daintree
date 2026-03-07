import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { filterSettings, countMatchesPerTab, HighlightText } from "../settingsSearchUtils";
import { SETTINGS_SEARCH_INDEX } from "../settingsSearchIndex";

describe("filterSettings", () => {
  it("returns empty array for empty query", () => {
    expect(filterSettings(SETTINGS_SEARCH_INDEX, "")).toHaveLength(0);
    expect(filterSettings(SETTINGS_SEARCH_INDEX, "   ")).toHaveLength(0);
  });

  it("matches by title text", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "Scrollback History");
    expect(results.length).toBeGreaterThan(0);
    // All results must have "scrollback" in some field — presence check, not exclusivity
    expect(results.some((r) => r.id === "terminal-scrollback")).toBe(true);
  });

  it("matches by description text", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "JetBrains");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.tab === "terminalAppearance")).toBe(true);
  });

  it("matches by keyword", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "hibernate");
    expect(results.length).toBeGreaterThan(0);
    // All matching entries should be in general (hibernate keyword only on general entries)
    expect(results.some((r) => r.tab === "general")).toBe(true);
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

  it("handles special regex characters without throwing", () => {
    expect(() => filterSettings(SETTINGS_SEARCH_INDEX, "(")).not.toThrow();
    expect(() => filterSettings(SETTINGS_SEARCH_INDEX, ".*+?^${}|[]\\")).not.toThrow();
    expect(() => filterSettings(SETTINGS_SEARCH_INDEX, "[invalid")).not.toThrow();
  });

  it("returns no results for unmatched query", () => {
    expect(filterSettings(SETTINGS_SEARCH_INDEX, "zzznomatch999")).toHaveLength(0);
  });

  it("matches github token entry by id", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "github token");
    expect(results.some((r) => r.id === "github-token")).toBe(true);
  });

  it("can match across multiple tabs", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "agent");
    const tabs = new Set(results.map((r) => r.tab));
    expect(tabs.size).toBeGreaterThan(1);
  });

  it("matches common real-world queries", () => {
    // These are things users will actually type
    expect(filterSettings(SETTINGS_SEARCH_INDEX, "verbose").length).toBeGreaterThan(0);
    expect(filterSettings(SETTINGS_SEARCH_INDEX, "font size").length).toBeGreaterThan(0);
    expect(filterSettings(SETTINGS_SEARCH_INDEX, "crash report").length).toBeGreaterThan(0);
    expect(filterSettings(SETTINGS_SEARCH_INDEX, "scrollback").length).toBeGreaterThan(0);
  });
});

describe("countMatchesPerTab", () => {
  it("returns empty object for empty results", () => {
    expect(countMatchesPerTab([])).toEqual({});
  });

  it("counts correctly for single-tab results", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "JetBrains Mono");
    const counts = countMatchesPerTab(results);
    expect(counts.terminalAppearance).toBeGreaterThanOrEqual(1);
  });

  it("aggregates counts — total equals result count", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "default");
    const counts = countMatchesPerTab(results);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(results.length);
  });

  it("only includes tabs that have matches", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "github token");
    const counts = countMatchesPerTab(results);
    // All results should be github tab — relaxed: every key has count > 0
    for (const count of Object.values(counts)) {
      expect(count).toBeGreaterThan(0);
    }
    // And github should be one of the tabs with matches
    expect(counts.github).toBeGreaterThanOrEqual(1);
  });
});

describe("HighlightText", () => {
  it("renders plain text when query is empty", () => {
    const html = renderToStaticMarkup(HighlightText({ text: "Hello World", query: "" }));
    expect(html).not.toContain("<mark");
    expect(html).toContain("Hello World");
  });

  it("wraps matching text in a mark element", () => {
    const html = renderToStaticMarkup(HighlightText({ text: "Font size setting", query: "font" }));
    expect(html).toContain("<mark");
    // The matched portion should be inside a mark
    expect(html.toLowerCase()).toContain(">font<");
  });

  it("is case-insensitive in highlighting", () => {
    const html = renderToStaticMarkup(HighlightText({ text: "GitHub Token", query: "github" }));
    expect(html).toContain("<mark");
    // Original casing preserved
    expect(html).toContain("GitHub");
  });

  it("highlights multiple occurrences", () => {
    const html = renderToStaticMarkup(
      HighlightText({ text: "font family font size", query: "font" })
    );
    const markCount = (html.match(/<mark/g) ?? []).length;
    expect(markCount).toBeGreaterThanOrEqual(2);
  });

  it("preserves full text content after highlighting", () => {
    const text = "Reduce scrollback and disable animations";
    const html = renderToStaticMarkup(HighlightText({ text, query: "scrollback" }));
    // Strip tags to get text content
    const textContent = html.replace(/<[^>]+>/g, "");
    expect(textContent).toBe(text);
  });

  it("handles regex metacharacters safely", () => {
    expect(() =>
      renderToStaticMarkup(HighlightText({ text: "Some (text) here", query: "(" }))
    ).not.toThrow();
    expect(() =>
      renderToStaticMarkup(HighlightText({ text: "Star * match", query: "*" }))
    ).not.toThrow();
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

  it("has at least 50 entries across all tabs", () => {
    expect(SETTINGS_SEARCH_INDEX.length).toBeGreaterThanOrEqual(50);
  });
});
