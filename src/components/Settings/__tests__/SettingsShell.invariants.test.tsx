// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import {
  NavItem,
  SearchResults,
  modifiedTabsFor,
  resultBreadcrumb,
  scrollAndHighlightSettingsSection,
  useSettingsScrollToSection,
} from "../SettingsDialog";
import { SETTINGS_SEARCH_INDEX } from "../settingsSearchIndex";
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
    // The dialog names each tracked setting by its search id; a typo there would make
    // a change silently invisible to both the sidebar dot and `@modified`.
    const source = readFileSync(resolve(__dirname, "../SettingsDialog.tsx"), "utf8");
    const tracked = [...source.matchAll(/ids\.add\("([^"]+)"\)/g)].map((m) => m[1]!);
    expect(tracked.length).toBeGreaterThan(0);
    const known = new Set(SETTINGS_SEARCH_INDEX.map((e) => e.id));
    for (const id of tracked) expect(known, id).toContain(id);
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

  it("lands a page result on the page's nav tab instead of stranding focus", () => {
    const tab = document.createElement("button");
    tab.id = "settings-tab-notifications";
    document.body.appendChild(tab);
    function Host() {
      useSettingsScrollToSection(true, "tab-nav-notifications", () => {}, "notifications");
      return null;
    }
    render(<Host />);
    expect(document.activeElement).toBe(tab);
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
