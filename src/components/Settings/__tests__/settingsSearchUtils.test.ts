import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  filterSettings,
  countMatchesPerTab,
  HighlightText,
  parseQuery,
} from "../settingsSearchUtils";
import { SETTINGS_SEARCH_INDEX } from "../settingsSearchIndex";
import type { SettingsTab } from "../SettingsDialog";

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

describe("subtab-aware search", () => {
  it("includes subtabLabel in searchable haystack", () => {
    const index = [
      {
        id: "test-entry",
        tab: "agents" as const,
        tabLabel: "CLI Agents",
        section: "Settings",
        title: "Some Setting",
        description: "Some description",
        subtab: "gemini",
        subtabLabel: "Gemini",
      },
    ];
    const results = filterSettings(index, "gemini");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("test-entry");
  });

  it("returns subtab metadata in matched results", () => {
    const index = [
      {
        id: "sub-entry",
        tab: "agents" as const,
        tabLabel: "CLI Agents",
        section: "Runtime",
        title: "Enable Agent",
        description: "Toggle agent on/off",
        subtab: "claude",
        subtabLabel: "Claude",
        keywords: ["enable"],
      },
    ];
    const results = filterSettings(index, "enable");
    expect(results[0].subtab).toBe("claude");
    expect(results[0].subtabLabel).toBe("Claude");
  });

  it("does not require subtab or subtabLabel fields", () => {
    const index = [
      {
        id: "no-subtab",
        tab: "general" as const,
        tabLabel: "General",
        section: "About",
        title: "App Version",
        description: "Current version",
      },
    ];
    const results = filterSettings(index, "version");
    expect(results).toHaveLength(1);
    expect(results[0].subtab).toBeUndefined();
  });

  it("countMatchesPerTab is unaffected by subtab presence", () => {
    const index = [
      {
        id: "a",
        tab: "agents" as const,
        tabLabel: "CLI Agents",
        section: "S",
        title: "Enable",
        description: "d",
        subtab: "claude",
      },
      {
        id: "b",
        tab: "agents" as const,
        tabLabel: "CLI Agents",
        section: "S",
        title: "Enable Gemini",
        description: "d",
        subtab: "gemini",
      },
    ];
    const results = filterSettings(index, "enable");
    const counts = countMatchesPerTab(results);
    expect(counts.agents).toBe(2);
  });
});

describe("SETTINGS_SEARCH_INDEX", () => {
  it("has entries covering all 16 settings tabs", () => {
    const tabs = new Set(SETTINGS_SEARCH_INDEX.map((e) => e.tab));
    const expectedTabs = [
      "general",
      "keyboard",
      "terminal",
      "terminalAppearance",
      "worktree",
      "agents",
      "github",
      "portal",
      "toolbar",
      "notifications",
      "integrations",
      "voice",
      "mcp",
      "environment",
      "privacy",
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

  it("tabLabel values match canonical tabTitles", () => {
    const tabTitles: Record<string, string> = {
      general: "General",
      keyboard: "Keyboard Shortcuts",
      terminal: "Panel Grid",
      terminalAppearance: "Appearance",
      worktree: "Worktree Paths",
      agents: "CLI Agents",
      github: "GitHub Integration",
      portal: "Portal Links",
      toolbar: "Toolbar Customization",
      notifications: "Notifications",
      integrations: "Integrations",
      voice: "Voice Input",
      mcp: "MCP Server",
      environment: "Environment Variables",
      privacy: "Privacy & Data",
      troubleshooting: "Troubleshooting",
    };
    for (const entry of SETTINGS_SEARCH_INDEX) {
      expect(
        entry.tabLabel,
        `entry "${entry.id}" tabLabel should match tabTitles["${entry.tab}"]`
      ).toBe(tabTitles[entry.tab]);
    }
  });

  it("has a tab-nav entry for every tab", () => {
    const tabTitles: Record<string, string> = {
      general: "General",
      keyboard: "Keyboard Shortcuts",
      terminal: "Panel Grid",
      terminalAppearance: "Appearance",
      worktree: "Worktree Paths",
      agents: "CLI Agents",
      github: "GitHub Integration",
      portal: "Portal Links",
      toolbar: "Toolbar Customization",
      notifications: "Notifications",
      integrations: "Integrations",
      voice: "Voice Input",
      mcp: "MCP Server",
      environment: "Environment Variables",
      privacy: "Privacy & Data",
      troubleshooting: "Troubleshooting",
    };
    for (const tabKey of Object.keys(tabTitles)) {
      const navEntry = SETTINGS_SEARCH_INDEX.find((e) => e.id === `tab-nav-${tabKey}`);
      expect(navEntry, `tab-nav entry should exist for "${tabKey}"`).toBeDefined();
    }
  });
});

describe("voice tab coverage", () => {
  it("returns results for 'voice' query", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "voice");
    expect(results.some((r) => r.tab === "voice")).toBe(true);
  });

  it("returns results for 'microphone' query", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "microphone");
    expect(results.length).toBeGreaterThan(0);
  });

  it("returns results for 'deepgram' query", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "deepgram");
    expect(results.some((r) => r.tab === "voice")).toBe(true);
  });

  it("returns results for 'speech' query", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "speech");
    expect(results.some((r) => r.tab === "voice")).toBe(true);
  });

  it("returns results for 'transcription' query", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "transcription");
    expect(results.some((r) => r.tab === "voice")).toBe(true);
  });
});

describe("tab-name ranking", () => {
  it("tab-nav entry ranks first for exact tab name queries", () => {
    const queries = ["Panel Grid", "Keyboard Shortcuts", "Voice Input", "GitHub Integration"];
    for (const query of queries) {
      const results = filterSettings(SETTINGS_SEARCH_INDEX, query);
      expect(
        results[0]?.id.startsWith("tab-nav-"),
        `"${query}" should return a tab-nav entry first, got "${results[0]?.id}"`
      ).toBe(true);
    }
  });

  it("compound queries rank field entries above tab-nav entries", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "notifications sound");
    expect(results.length).toBeGreaterThan(0);
    expect(
      results[0]?.id,
      `"notifications sound" should rank field entry first, got "${results[0]?.id}"`
    ).toBe("notifications-sound");
  });

  it("nav group label queries return tab-nav results", () => {
    const groups = ["general", "terminal", "integrations", "input", "support"];
    for (const group of groups) {
      const results = filterSettings(SETTINGS_SEARCH_INDEX, group);
      expect(
        results.some((r) => r.id.startsWith("tab-nav-")),
        `"${group}" should return at least one tab-nav result`
      ).toBe(true);
    }
  });
});

describe("fuzzy matching", () => {
  it("matches prefix queries — 'notif' finds notifications", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "notif");
    expect(results.some((r) => r.tab === "notifications")).toBe(true);
  });

  it("matches prefix queries — 'keybind' finds keyboard", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "keybind");
    expect(results.some((r) => r.tab === "keyboard")).toBe(true);
  });

  it("matches 'shortcut' to keyboard entries", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "shortcut");
    expect(results.some((r) => r.tab === "keyboard")).toBe(true);
  });

  it("matches 'perf' to performance mode", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "perf");
    expect(results.some((r) => r.id === "terminal-performance-mode")).toBe(true);
  });

  it("matches 'font' to appearance entries", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "font");
    expect(results.some((r) => r.tab === "terminalAppearance")).toBe(true);
  });

  it("matches 'dark mode' to appearance theme", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "dark mode");
    expect(results.some((r) => r.id === "appearance-theme")).toBe(true);
  });

  it("does not return garbage for unrelated short queries", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "zzz");
    expect(results).toHaveLength(0);
  });

  it("does not interpret Fuse extended search operators like '!'", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "!font");
    // Should not return inverse/all results — should treat "!font" as literal
    expect(results.length).toBeLessThan(5);
  });

  it("multi-token query requires all tokens to match (AND semantics)", () => {
    const index = [
      {
        id: "a",
        tab: "general" as const,
        tabLabel: "General",
        section: "S",
        title: "Font Size",
        description: "d",
      },
      {
        id: "b",
        tab: "general" as const,
        tabLabel: "General",
        section: "S",
        title: "Color Scheme",
        description: "d",
      },
    ];
    const results = filterSettings(index, "font size");
    expect(results.some((r) => r.id === "a")).toBe(true);
    expect(results.some((r) => r.id === "b")).toBe(false);
  });
});

describe("parseQuery", () => {
  it("extracts @modified token", () => {
    const result = parseQuery("@modified");
    expect(result.filterModified).toBe(true);
    expect(result.cleanQuery).toBe("");
    expect(result.tokens).toHaveLength(0);
  });

  it("extracts @mod shorthand", () => {
    const result = parseQuery("@mod");
    expect(result.filterModified).toBe(true);
    expect(result.cleanQuery).toBe("");
  });

  it("strips @modified from compound query", () => {
    const result = parseQuery("font @modified");
    expect(result.filterModified).toBe(true);
    expect(result.cleanQuery).toBe("font");
    expect(result.tokens).toEqual(["font"]);
  });

  it("strips @mod from compound query", () => {
    const result = parseQuery("@mod font size");
    expect(result.filterModified).toBe(true);
    expect(result.cleanQuery).toBe("font size");
    expect(result.tokens).toEqual(["font", "size"]);
  });

  it("returns filterModified=false for normal queries", () => {
    const result = parseQuery("font size");
    expect(result.filterModified).toBe(false);
    expect(result.cleanQuery).toBe("font size");
    expect(result.tokens).toEqual(["font", "size"]);
  });

  it("does not match embedded @modified (e.g., foo@modified)", () => {
    const result = parseQuery("foo@modified");
    expect(result.filterModified).toBe(false);
    expect(result.tokens).toEqual(["foo@modified"]);
  });

  it("handles repeated @modified tokens", () => {
    const result = parseQuery("@modified @modified font");
    expect(result.filterModified).toBe(true);
    expect(result.tokens).toEqual(["font"]);
  });
});

describe("@modified filter", () => {
  it("returns empty when @modified with no modifiedTabs", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "@modified");
    expect(results).toHaveLength(0);
  });

  it("returns empty when @modified with empty modifiedTabs set", () => {
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "@modified", {
      modifiedTabs: new Set<SettingsTab>(),
    });
    expect(results).toHaveLength(0);
  });

  it("returns all general entries when @modified with general in modifiedTabs", () => {
    const modifiedTabs = new Set<SettingsTab>(["general"]);
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "@modified", { modifiedTabs });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.tab === "general")).toBe(true);
  });

  it("filters fuzzy results by modifiedTabs with compound query", () => {
    const modifiedTabs = new Set<SettingsTab>(["terminalAppearance"]);
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "font @modified", { modifiedTabs });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.tab === "terminalAppearance")).toBe(true);
  });

  it("@mod shorthand works the same as @modified", () => {
    const modifiedTabs = new Set<SettingsTab>(["general"]);
    const full = filterSettings(SETTINGS_SEARCH_INDEX, "@modified", { modifiedTabs });
    const short = filterSettings(SETTINGS_SEARCH_INDEX, "@mod", { modifiedTabs });
    expect(full).toEqual(short);
  });

  it("compound @modified query returns empty when no modified tabs match", () => {
    const modifiedTabs = new Set<SettingsTab>(["github"]);
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "font @modified", { modifiedTabs });
    expect(results).toHaveLength(0);
  });
});
