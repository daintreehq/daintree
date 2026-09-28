// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { act, render, renderHook } from "@testing-library/react";
import {
  SEARCH_RESULTS_LISTBOX_ID,
  SearchResults,
  settingsSearchComboboxAria,
  settingsSearchKeyAction,
  useSearchResultCursor,
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

/**
 * The results header promises "Enter open". That only holds if a row is lit the
 * moment results appear, before any arrow press.
 */
function key(
  name: string,
  mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; isComposing?: boolean } = {}
) {
  return {
    key: name,
    metaKey: mods.metaKey ?? false,
    ctrlKey: mods.ctrlKey ?? false,
    altKey: mods.altKey ?? false,
    nativeEvent: { isComposing: mods.isComposing ?? false, keyCode: 0 },
  };
}

describe("settings search keyboard", () => {
  it("starts every query on its first result", () => {
    const { result, rerender } = renderHook(({ query }) => useSearchResultCursor(query, 5), {
      initialProps: { query: "f" },
    });
    expect(result.current[0]).toBe(0);

    act(() => result.current[1](2));
    expect(result.current[0]).toBe(2);

    rerender({ query: "fo" });
    expect(result.current[0]).toBe(0);

    // Backing out to the earlier query is a new query too.
    rerender({ query: "f" });
    expect(result.current[0]).toBe(0);
  });

  it("falls back to the first result when the list shrinks under the cursor", () => {
    const { result, rerender } = renderHook(
      ({ count }) => useSearchResultCursor("@modified", count),
      { initialProps: { count: 5 } }
    );
    act(() => result.current[1](4));
    rerender({ count: 2 });
    expect(result.current[0]).toBe(0);
  });

  it("opens the active row on Enter, including the untouched first row", () => {
    expect(settingsSearchKeyAction(key("Enter"), 0, RESULTS.length)).toEqual({
      type: "open",
      index: 0,
    });
    expect(settingsSearchKeyAction(key("Enter"), 2, RESULTS.length)).toEqual({
      type: "open",
      index: 2,
    });
  });

  it("leaves Enter alone when there is nothing to open", () => {
    expect(settingsSearchKeyAction(key("Enter"), 0, 0)).toBeNull();
    expect(settingsSearchKeyAction(key("Enter"), 3, 3)).toBeNull();
  });

  it("wraps the arrow keys at both ends", () => {
    const last = RESULTS.length - 1;
    expect(settingsSearchKeyAction(key("ArrowDown"), 0, RESULTS.length)).toEqual({
      type: "move",
      index: 1,
    });
    expect(settingsSearchKeyAction(key("ArrowDown"), last, RESULTS.length)).toEqual({
      type: "move",
      index: 0,
    });
    expect(settingsSearchKeyAction(key("ArrowUp"), 0, RESULTS.length)).toEqual({
      type: "move",
      index: last,
    });
  });

  it("leaves an IME's Enter and modified chords alone", () => {
    // A row is always lit, so an Enter that commits a composition candidate
    // would otherwise open a result.
    expect(
      settingsSearchKeyAction(key("Enter", { isComposing: true }), 0, RESULTS.length)
    ).toBeNull();
    expect(
      settingsSearchKeyAction(
        { ...key("Enter"), nativeEvent: { isComposing: false, keyCode: 229 } },
        0,
        RESULTS.length
      )
    ).toBeNull();
    for (const mod of ["metaKey", "ctrlKey", "altKey"] as const) {
      expect(settingsSearchKeyAction(key("Enter", { [mod]: true }), 0, RESULTS.length)).toBeNull();
    }
  });

  it("leaves Home and End to the field's caret", () => {
    expect(settingsSearchKeyAction(key("Home"), 2, RESULTS.length)).toBeNull();
    expect(settingsSearchKeyAction(key("End"), 0, RESULTS.length)).toBeNull();
  });

  it("points aria-activedescendant at the first row before any arrow press", () => {
    const container = renderResults(0);
    const aria = settingsSearchComboboxAria(RESULTS, 0, true);
    const first = container.querySelectorAll('[role="option"]')[0];

    expect(first?.getAttribute("aria-selected")).toBe("true");
    expect(aria["aria-activedescendant"]).toBe(first?.getAttribute("id"));
  });

  it("reveals the first row when a new query keeps it active", () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const props = {
        results: RESULTS,
        cleanQuery: "theme",
        onResultClick: () => {},
        activeIndex: 0,
        activeScope: "global" as const,
        projectLabel: null,
      };
      const { rerender } = render(<SearchResults {...props} query="them" />);
      scrollIntoView.mockClear();

      rerender(<SearchResults {...props} query="theme" />);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
