// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

interface MockSearchablePaletteProps {
  query?: string;
  results?: unknown[];
  beforeList?: React.ReactNode;
  emptyContent?: React.ReactNode;
  [key: string]: unknown;
}

const lastSearchablePaletteProps: { current: MockSearchablePaletteProps | null } = {
  current: null,
};

// Capture the props passed to SearchablePalette and mirror its empty-state
// gating (only render `emptyContent` when the user hasn't typed a query, same
// as AppPaletteDialog.Empty's zero-data branch). Avoids dragging the full
// dialog/animation stack into a renderer-only unit test.
vi.mock("@/components/ui/SearchablePalette", () => ({
  SearchablePalette: (props: MockSearchablePaletteProps) => {
    lastSearchablePaletteProps.current = props;
    const query = props.query ?? "";
    const results = props.results ?? [];
    const showEmptyContent = results.length === 0 && query.trim() === "";
    return (
      <div data-testid="searchable-palette">
        {props.beforeList ?? null}
        {showEmptyContent ? (props.emptyContent ?? null) : null}
      </div>
    );
  },
}));

import { ActionPalette } from "./ActionPalette";
import type { ActionPaletteItem as ActionPaletteItemType } from "@/hooks/useActionPalette";

function makeItem(id: string, title: string): ActionPaletteItemType {
  return {
    id,
    title,
    description: "",
    category: "General",
    enabled: true,
    kind: "command",
    titleLower: title.toLowerCase(),
    categoryLower: "general",
    descriptionLower: "",
    titleAcronym: "",
    keywordsLower: [],
  };
}

const noop = () => {};

describe("ActionPalette", () => {
  it("renders the 'Recently used' header when surfacing MRU on the empty state", () => {
    render(
      <ActionPalette
        isOpen
        query=""
        results={[makeItem("a.action", "Alpha"), makeItem("b.action", "Bravo")]}
        totalResults={2}
        selectedIndex={0}
        isShowingRecentlyUsed
        isStale={false}
        close={noop}
        setQuery={noop}
        setSelectedIndex={noop}
        selectPrevious={noop}
        selectNext={noop}
        executeAction={noop}
        confirmSelection={noop}
      />
    );

    expect(screen.getByText("Recently used")).toBeTruthy();
  });

  it("does not render the header when the user has typed a query", () => {
    render(
      <ActionPalette
        isOpen
        query="alp"
        results={[makeItem("a.action", "Alpha")]}
        totalResults={1}
        selectedIndex={0}
        isShowingRecentlyUsed={false}
        isStale={false}
        close={noop}
        setQuery={noop}
        setSelectedIndex={noop}
        selectPrevious={noop}
        selectNext={noop}
        executeAction={noop}
        confirmSelection={noop}
      />
    );

    expect(screen.queryByText("Recently used")).toBeNull();
  });

  it("renders neither the header nor the hint when a typed query has zero matches", () => {
    render(
      <ActionPalette
        isOpen
        query="zzzz"
        results={[]}
        totalResults={0}
        selectedIndex={0}
        isShowingRecentlyUsed={false}
        isStale={false}
        close={noop}
        setQuery={noop}
        setSelectedIndex={noop}
        selectPrevious={noop}
        selectNext={noop}
        executeAction={noop}
        confirmSelection={noop}
      />
    );

    expect(screen.queryByText("Recently used")).toBeNull();
    // The static hint must stay parked behind the recently-used flag — it's not
    // a generic palette decoration and shouldn't leak into the no-match state.
    expect(
      screen.queryByText("Actions depend on the focused panel and current context.")
    ).toBeNull();
  });

  it("provides the static hint as emptyContent for SearchablePalette to render when no MRU exists", () => {
    render(
      <ActionPalette
        isOpen
        query=""
        results={[]}
        totalResults={0}
        selectedIndex={0}
        isShowingRecentlyUsed={false}
        isStale={false}
        close={noop}
        setQuery={noop}
        setSelectedIndex={noop}
        selectPrevious={noop}
        selectNext={noop}
        executeAction={noop}
        confirmSelection={noop}
      />
    );

    expect(screen.queryByText("Recently used")).toBeNull();
    expect(
      screen.getByText("Actions depend on the focused panel and current context.")
    ).toBeTruthy();
  });

  it("forwards isStale to SearchablePalette as isFiltering", () => {
    render(
      <ActionPalette
        isOpen
        query="al"
        results={[makeItem("a.action", "Alpha")]}
        totalResults={1}
        selectedIndex={0}
        isShowingRecentlyUsed={false}
        isStale
        close={noop}
        setQuery={noop}
        setSelectedIndex={noop}
        selectPrevious={noop}
        selectNext={noop}
        executeAction={noop}
        confirmSelection={noop}
      />
    );

    expect(lastSearchablePaletteProps.current?.isFiltering).toBe(true);
  });
});
