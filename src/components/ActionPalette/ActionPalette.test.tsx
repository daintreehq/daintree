// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const lastSearchablePaletteProps: { current: Record<string, unknown> | null } = { current: null };

// Capture the props passed to SearchablePalette so we can assert the wiring
// (beforeList, emptyContent) without bringing the full AppPaletteDialog stack
// into a renderer-only unit test.
vi.mock("@/components/ui/SearchablePalette", () => ({
  SearchablePalette: (props: Record<string, unknown>) => {
    lastSearchablePaletteProps.current = props;
    return (
      <div data-testid="searchable-palette">
        {(props.beforeList as React.ReactNode) ?? null}
        {(props.emptyContent as React.ReactNode) ?? null}
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
        close={noop}
        setQuery={noop}
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
        close={noop}
        setQuery={noop}
        selectPrevious={noop}
        selectNext={noop}
        executeAction={noop}
        confirmSelection={noop}
      />
    );

    expect(screen.queryByText("Recently used")).toBeNull();
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
        close={noop}
        setQuery={noop}
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
});
