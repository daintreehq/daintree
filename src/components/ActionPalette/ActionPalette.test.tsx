// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
        {(props.inputPrefix as React.ReactNode) ?? null}
        {props.beforeList ?? null}
        {showEmptyContent ? (
          props.emptyMessage ? (
            <p>{props.emptyMessage as string}</p>
          ) : (
            (props.emptyContent ?? null)
          )
        ) : null}
        {(props.footer as React.ReactNode) ?? null}
      </div>
    );
  },
}));

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

import { ActionPalette } from "./ActionPalette";
import type { ActionPaletteItem as ActionPaletteItemType } from "@/hooks/useActionPalette";
import { usePaletteStore } from "@/store/paletteStore";

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

const baseProps = {
  isOpen: true as const,
  query: "",
  results: [] as ActionPaletteItemType[],
  totalResults: 0,
  selectedIndex: 0,
  isStale: false,
  pinnedCount: 0,
  close: noop,
  setQuery: noop,
  setSelectedIndex: noop,
  selectPrevious: noop,
  selectNext: noop,
  executeAction: noop,
  confirmSelection: noop,
  pinAction: noopPin,
  unpinAction: noop,
  hideAction: noopHide,
};

function fireKey(key: string, options: { selectionStart?: number; selectionEnd?: number } = {}) {
  const onKeyDown = lastSearchablePaletteProps.current?.onKeyDown as
    | ((e: React.KeyboardEvent<HTMLInputElement>) => void)
    | undefined;
  if (!onKeyDown) throw new Error("onKeyDown not forwarded to SearchablePalette");
  let prevented = false;
  const currentTarget = {
    selectionStart: options.selectionStart ?? 0,
    selectionEnd: options.selectionEnd ?? 0,
  };
  const event = {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    currentTarget,
    preventDefault: () => {
      prevented = true;
    },
    get defaultPrevented() {
      return prevented;
    },
  } as unknown as React.KeyboardEvent<HTMLInputElement>;
  act(() => {
    onKeyDown(event);
  });
  return prevented;
}

describe("ActionPalette", () => {
  beforeEach(() => {
    lastSearchablePaletteProps.current = null;
    usePaletteStore.setState({ activePaletteId: "action" });
  });

  afterEach(() => {
    usePaletteStore.setState({ activePaletteId: null });
  });

  it("does not render the empty message when a typed query has zero matches", () => {
    render(<ActionPalette {...baseProps} query="zzzz" />);
    expect(screen.queryByText("No actions yet")).toBeNull();
  });

  it("shows the empty message when no MRU exists and no query is typed", () => {
    render(<ActionPalette {...baseProps} />);
    expect(screen.getByText("No actions yet")).toBeTruthy();
  });

  it("forwards isStale to SearchablePalette as isFiltering", () => {
    render(
      <ActionPalette
        {...baseProps}
        query="al"
        results={[makeItem("a.action", "Alpha")]}
        totalResults={1}
        isStale
      />
    );
    expect(lastSearchablePaletteProps.current?.isFiltering).toBe(true);
  });

  it("passes a renderBody callback when on the empty-query rail with results", () => {
    render(
      <ActionPalette
        {...baseProps}
        query=""
        results={[makeItem("a.action", "Alpha")]}
        totalResults={1}
      />
    );

    expect(typeof lastSearchablePaletteProps.current?.renderBody).toBe("function");
  });

  it("does NOT pass a renderBody callback when a query is typed", () => {
    render(
      <ActionPalette
        {...baseProps}
        query="al"
        results={[makeItem("a.action", "Alpha")]}
        totalResults={1}
      />
    );

    expect(lastSearchablePaletteProps.current?.renderBody).toBeUndefined();
  });

  it("shows the Commands chip when '>' is typed into an empty query", () => {
    render(<ActionPalette {...baseProps} />);
    const prevented = fireKey(">");
    expect(prevented).toBe(true);
    expect(screen.getByText("Commands")).toBeTruthy();
  });

  it("does not surface a chip when a recognized prefix is typed mid-query", () => {
    render(<ActionPalette {...baseProps} query="search" />);
    const prevented = fireKey(">");
    expect(prevented).toBe(false);
    expect(screen.queryByText("Commands")).toBeNull();
  });

  it("routes '@' to the worktree palette via paletteStore", () => {
    render(<ActionPalette {...baseProps} />);
    const prevented = fireKey("@");
    expect(prevented).toBe(true);
    expect(usePaletteStore.getState().activePaletteId).toBe("worktree");
  });

  it("routes '#' to the panel palette", () => {
    render(<ActionPalette {...baseProps} />);
    fireKey("#");
    expect(usePaletteStore.getState().activePaletteId).toBe("panel");
  });

  it("routes ':' to the prompt-history palette", () => {
    render(<ActionPalette {...baseProps} />);
    fireKey(":");
    expect(usePaletteStore.getState().activePaletteId).toBe("prompt-history");
  });

  it("routes '/' to the project-switcher palette", () => {
    render(<ActionPalette {...baseProps} />);
    fireKey("/");
    expect(usePaletteStore.getState().activePaletteId).toBe("project-switcher");
  });

  it("surfaces the projects hint when an empty-result query looks like a path", () => {
    render(<ActionPalette {...baseProps} query="src/foo" results={[]} totalResults={0} />);
    expect(screen.getByText("search projects")).toBeTruthy();
  });

  it("does not surface the projects hint when results exist", () => {
    render(
      <ActionPalette
        {...baseProps}
        query="src/foo"
        results={[makeItem("a.action", "Alpha")]}
        totalResults={1}
      />
    );
    expect(screen.queryByText("search projects")).toBeNull();
  });

  it("pops the chip on Backspace when the cursor sits at position 0", () => {
    render(<ActionPalette {...baseProps} />);
    fireKey(">");
    expect(screen.getByText("Commands")).toBeTruthy();

    const prevented = fireKey("Backspace", { selectionStart: 0, selectionEnd: 0 });
    expect(prevented).toBe(true);
    expect(screen.queryByText("Commands")).toBeNull();
  });

  it("leaves Backspace alone when the cursor is not at position 0", () => {
    render(<ActionPalette {...baseProps} />);
    fireKey(">");
    expect(screen.getByText("Commands")).toBeTruthy();

    const prevented = fireKey("Backspace", { selectionStart: 3, selectionEnd: 3 });
    expect(prevented).toBe(false);
    expect(screen.getByText("Commands")).toBeTruthy();
  });
});
