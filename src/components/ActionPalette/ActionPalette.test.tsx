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
        {showEmptyContent ? (
          props.emptyMessage ? (
            <p>{props.emptyMessage as string}</p>
          ) : (
            (props.emptyContent ?? null)
          )
        ) : null}
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
    danger: "safe",
    kind: "command",
    titleLower: title.toLowerCase(),
    categoryLower: "general",
    descriptionLower: "",
    titleAcronym: "",
    keywordsLower: [],
  };
}

const noop = () => {};
const noopPin = () => true;
const noopHide = () => {};

describe("ActionPalette", () => {
  it("does not render the empty message when a typed query has zero matches", () => {
    render(
      <ActionPalette
        isOpen
        query="zzzz"
        results={[]}
        totalResults={0}
        selectedIndex={0}
        isStale={false}
        pinnedCount={0}
        close={noop}
        setQuery={noop}
        setSelectedIndex={noop}
        selectPrevious={noop}
        selectNext={noop}
        executeAction={noop}
        confirmSelection={noop}
        pinAction={noopPin}
        unpinAction={noop}
        hideAction={noopHide}
      />
    );

    expect(screen.queryByText("No actions yet")).toBeNull();
  });

  it("shows the empty message when no MRU exists and no query is typed", () => {
    render(
      <ActionPalette
        isOpen
        query=""
        results={[]}
        totalResults={0}
        selectedIndex={0}
        isStale={false}
        pinnedCount={0}
        close={noop}
        setQuery={noop}
        setSelectedIndex={noop}
        selectPrevious={noop}
        selectNext={noop}
        executeAction={noop}
        confirmSelection={noop}
        pinAction={noopPin}
        unpinAction={noop}
        hideAction={noopHide}
      />
    );

    expect(screen.getByText("No actions yet")).toBeTruthy();
  });

  it("forwards isStale to SearchablePalette as isFiltering", () => {
    render(
      <ActionPalette
        isOpen
        query="al"
        results={[makeItem("a.action", "Alpha")]}
        totalResults={1}
        selectedIndex={0}
        isStale
        pinnedCount={0}
        close={noop}
        setQuery={noop}
        setSelectedIndex={noop}
        selectPrevious={noop}
        selectNext={noop}
        executeAction={noop}
        confirmSelection={noop}
        pinAction={noopPin}
        unpinAction={noop}
        hideAction={noopHide}
      />
    );

    expect(lastSearchablePaletteProps.current?.isFiltering).toBe(true);
  });

  it("passes a renderBody callback when on the empty-query rail with results", () => {
    render(
      <ActionPalette
        isOpen
        query=""
        results={[makeItem("a.action", "Alpha")]}
        totalResults={1}
        selectedIndex={0}
        isStale={false}
        pinnedCount={0}
        close={noop}
        setQuery={noop}
        setSelectedIndex={noop}
        selectPrevious={noop}
        selectNext={noop}
        executeAction={noop}
        confirmSelection={noop}
        pinAction={noopPin}
        unpinAction={noop}
        hideAction={noopHide}
      />
    );

    expect(typeof lastSearchablePaletteProps.current?.renderBody).toBe("function");
  });

  it("does NOT pass a renderBody callback when a query is typed", () => {
    render(
      <ActionPalette
        isOpen
        query="al"
        results={[makeItem("a.action", "Alpha")]}
        totalResults={1}
        selectedIndex={0}
        isStale={false}
        pinnedCount={0}
        close={noop}
        setQuery={noop}
        setSelectedIndex={noop}
        selectPrevious={noop}
        selectNext={noop}
        executeAction={noop}
        confirmSelection={noop}
        pinAction={noopPin}
        unpinAction={noop}
        hideAction={noopHide}
      />
    );

    expect(lastSearchablePaletteProps.current?.renderBody).toBeUndefined();
  });
});
