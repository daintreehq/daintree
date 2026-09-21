// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import {
  SEARCH_RESULTS_LISTBOX_ID,
  SearchResults,
  settingsSearchComboboxAria,
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

const RESULTS = filterSettings(SETTINGS_SEARCH_INDEX, "theme", {
  modifiedTabs: new Set(),
  scope: "global",
  hasProject: false,
});

function renderResults(activeIndex: number) {
  return render(
    <SearchResults
      results={RESULTS}
      query="theme"
      cleanQuery="theme"
      onResultClick={() => {}}
      activeIndex={activeIndex}
      activeScope="global"
      projectLabel={null}
    />
  ).container;
}

/**
 * The visual highlight and its accessible counterpart. The arrow keys move an
 * index while DOM focus stays in the search field, so without the
 * combobox/listbox pairing a screen reader hears nothing move.
 */
describe("settings search combobox", () => {
  it("has results to work with", () => {
    // Guards the fixture: every assertion below is vacuous on an empty list.
    expect(RESULTS.length).toBeGreaterThan(1);
  });

  it("exposes each result row as an option of the controlled listbox", () => {
    const container = renderResults(0);
    const listbox = container.querySelector(`#${SEARCH_RESULTS_LISTBOX_ID}`);

    expect(listbox?.getAttribute("role")).toBe("listbox");
    const options = listbox?.querySelectorAll('[role="option"]') ?? [];
    expect(options.length).toBe(RESULTS.length);
    // The row is the option — a wrapper would nest interactive roles — so it
    // must still be the clickable control.
    expect(options[0]?.tagName).toBe("BUTTON");
    expect(listbox?.querySelector("button:not([role])")).toBeNull();
  });

  it("marks exactly the highlighted row as selected", () => {
    const container = renderResults(1);
    const selected = container.querySelectorAll('[aria-selected="true"]');

    expect(selected.length).toBe(1);
    expect(selected[0]).toBe(container.querySelectorAll('[role="option"]')[1]);
  });

  it("points aria-activedescendant at the highlighted row's own id", () => {
    for (const index of [0, RESULTS.length - 1]) {
      const container = renderResults(index);
      const aria = settingsSearchComboboxAria(RESULTS, index, true);
      const row = container.querySelectorAll('[role="option"]')[index];

      expect(aria["aria-activedescendant"]).toBe(row?.getAttribute("id"));
      expect(aria["aria-controls"]).toBe(SEARCH_RESULTS_LISTBOX_ID);
      expect(aria["aria-expanded"]).toBe(true);
    }
  });

  it("claims nothing while no row is highlighted", () => {
    const aria = settingsSearchComboboxAria(RESULTS, -1, true);

    expect(aria["aria-expanded"]).toBe(true);
    expect(aria["aria-activedescendant"]).toBeUndefined();
  });

  it("collapses when the listbox is not on screen", () => {
    // `SearchResults` swaps in an EmptyState at zero matches, and renders
    // nothing at all when the user isn't searching — pointing at an absent id
    // would be a broken reference.
    for (const aria of [
      settingsSearchComboboxAria([], -1, true),
      settingsSearchComboboxAria(RESULTS, 0, false),
    ]) {
      expect(aria["aria-expanded"]).toBe(false);
      expect(aria["aria-controls"]).toBeUndefined();
      expect(aria["aria-activedescendant"]).toBeUndefined();
    }
  });
});
