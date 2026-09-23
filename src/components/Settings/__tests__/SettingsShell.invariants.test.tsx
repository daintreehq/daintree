// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import {
  NavItem,
  SearchResults,
  MODIFIED_TRACKED_IDS,
  landOnSettingByText,
  modifiedCoverageSentence,
  modifiedTabsFor,
  resultBreadcrumb,
  scrollAndHighlightSettingsSection,
  useSettingsScrollToSection,
} from "../SettingsDialog";
import { SETTINGS_SEARCH_INDEX } from "../settingsSearchIndex";
import { SETTINGS_REGISTRY, contentScopeForTab, type SettingsTab } from "../settingsTabRegistry";
import { filterSettings } from "../settingsSearchUtils";

vi.mock("framer-motion", () => ({
  LayoutGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  m: {
    span: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
      <span {...props}>{children}</span>
    ),
  },
}));

/**
 * Rules the settings shell holds, asserted over the real registry and search index so a
 * tab or section added later is covered without touching this file.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

describe("search result breadcrumbs", () => {
  const sections = SETTINGS_SEARCH_INDEX.filter((e) => e.kind === "section");
  const pages = SETTINGS_SEARCH_INDEX.filter((e) => e.kind === "tab-nav");

  it("never repeats the result's own title, or any crumb twice", () => {
    for (const entry of sections) {
      const crumbs = resultBreadcrumb(entry).map((c) => c.toLowerCase());
      expect(new Set(crumbs).size, `${entry.id}: ${crumbs.join(" › ")}`).toBe(crumbs.length);
      // The page crumb may legitimately share the title ("Voice input" › …), since it
      // names where the row lives; every deeper crumb repeating the title is noise.
      expect(crumbs.slice(1), entry.id).not.toContain(entry.title.toLowerCase());
    }
  });

  it("starts at the page the sidebar names", () => {
    for (const entry of sections) {
      expect(resultBreadcrumb(entry)[0], entry.id).toBe(entry.tabLabel);
    }
  });

  it("never shows the index's internal bookkeeping to the reader", () => {
    for (const entry of pages) {
      const crumbs = resultBreadcrumb(entry);
      expect(crumbs, entry.id).not.toContain(entry.section);
      expect(crumbs, entry.id).not.toContain(entry.title);
    }
  });
});

describe("@modified", () => {
  it("lists exactly the settings that changed, not every row on their tab", () => {
    const changed = SETTINGS_SEARCH_INDEX.filter((e) => e.kind === "section").slice(0, 3);
    const ids = new Set(changed.map((e) => e.id));
    const results = filterSettings(SETTINGS_SEARCH_INDEX, "@modified", {
      modifiedTabs: modifiedTabsFor(ids),
      modifiedSettingIds: ids,
    });
    expect(new Set(results.map((r) => r.id))).toEqual(ids);
  });

  it("marks a tab modified exactly when one of its settings is", () => {
    const [first] = SETTINGS_SEARCH_INDEX.filter((e) => e.kind === "section");
    expect([...modifiedTabsFor(new Set([first!.id]))]).toEqual([first!.tab]);
    expect(modifiedTabsFor(new Set()).size).toBe(0);
  });

  it("only tracks setting ids the search index knows", () => {
    // A typo in a tracked id would make that change silently invisible to both the
    // sidebar dot and `@modified`.
    const known = new Set(SETTINGS_SEARCH_INDEX.map((e) => e.id));
    for (const id of MODIFIED_TRACKED_IDS) expect(known, id).toContain(id);
  });

  it("names the pages it covers instead of claiming nothing changed anywhere", () => {
    const sentence = modifiedCoverageSentence();
    const covered = new Set(
      MODIFIED_TRACKED_IDS.map((id) => SETTINGS_SEARCH_INDEX.find((e) => e.id === id)!.tabLabel)
    );
    for (const label of covered) expect(sentence).toContain(label);
  });
});

describe("search results", () => {
  const results = SETTINGS_SEARCH_INDEX.filter((e) => e.kind === "section").slice(0, 2);
  const renderResults = (projectLabel: string | null) =>
    render(
      <SearchResults
        results={results}
        query="x"
        cleanQuery="x"
        onResultClick={() => {}}
        activeScope="global"
        projectLabel={projectLabel}
      />
    );

  it("drops the scope chip when only one scope exists", () => {
    const withProject = renderResults("Helios Dashboard").container.innerHTML;
    document.body.innerHTML = "";
    const without = renderResults(null).container;
    expect(without.innerHTML).not.toBe(withProject);
    expect(without.textContent).not.toMatch(/\bGlobal\b/);
  });
});

describe("landing on a search result", () => {
  function section(id: string, inner: string): HTMLElement {
    const el = document.createElement("div");
    el.id = id;
    el.innerHTML = inner;
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);
    return el;
  }

  it("hands focus to the setting's control even when it is not an <input>", () => {
    const el = section(
      "s-switch",
      '<button type="button" aria-label="Reset">r</button><button role="switch" aria-checked="false">s</button>'
    );
    scrollAndHighlightSettingsSection("s-switch");
    expect(document.activeElement).toBe(el.querySelector('[role="switch"]'));
  });

  it("lands a page result on the page's nav tab and reports it did not find a setting", () => {
    const tab = document.createElement("button");
    tab.id = "settings-tab-notifications";
    document.body.appendChild(tab);
    const handled = vi.fn();
    function Host() {
      useSettingsScrollToSection(true, "tab-nav-notifications", handled, "notifications");
      return null;
    }
    render(<Host />);
    expect(document.activeElement).toBe(tab);
    expect(handled).toHaveBeenCalledWith("tab-nav-notifications", false);
  });

  it("finds a setting with no DOM id by the label the page renders for it", () => {
    const entry = SETTINGS_SEARCH_INDEX.find(
      (e) => e.kind === "section" && e.scope === "project" && !document.getElementById(e.id)
    )!;
    const panel = section(
      `settings-panel-${entry.tab}`,
      `<div data-settings-row="inline"><span data-settings-row-label>Something else</span><input aria-label="other" /></div>` +
        `<div data-settings-row="inline"><span data-settings-row-label>${entry.title}</span><input aria-label="target" /></div>`
    );
    panel.querySelectorAll<HTMLElement>("[data-settings-row]").forEach((row) => {
      row.scrollIntoView = vi.fn();
    });
    expect(landOnSettingByText(entry.id, entry.tab as SettingsTab)).toBe(true);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("target");
  });

  it("reports a gated setting that is not on the page as not landed", () => {
    const gated = SETTINGS_SEARCH_INDEX.find((e) => e.requiresEnabled)!;
    section(`settings-panel-${gated.tab}`, "<div>page without the gated row</div>");
    expect(landOnSettingByText(gated.id, gated.tab as SettingsTab)).toBe(false);
  });
});

describe("scope a result names", () => {
  it("follows what a tab writes to, not the nav list it is filed under", () => {
    const divergent = SETTINGS_REGISTRY.filter((t) => contentScopeForTab(t.id) !== t.scope);
    expect(divergent.length).toBeGreaterThan(0);
    for (const tab of divergent) {
      const entries = SETTINGS_SEARCH_INDEX.filter((e) => e.tab === tab.id);
      expect(entries.length, tab.id).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.effectScope ?? entry.scope, entry.id).toBe(contentScopeForTab(tab.id));
      }
    }
  });
});

describe("sidebar tab stop", () => {
  it("can sit on a focused tab while selection stays on the active one", () => {
    const { container } = render(
      <>
        <NavItem
          tab="general"
          icon={<svg />}
          label="General"
          activeTab="general"
          tabStop={false}
          isSearching={false}
          onSelect={() => {}}
        />
        <NavItem
          tab="keyboard"
          icon={<svg />}
          label="Keyboard"
          activeTab="general"
          tabStop
          isSearching={false}
          onSelect={() => {}}
        />
      </>
    );
    const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
    expect(tabs.filter((t) => t.tabIndex === 0).map((t) => t.dataset.tab)).toEqual(["keyboard"]);
    expect(
      tabs.filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.dataset.tab)
    ).toEqual(["general"]);
  });
});
