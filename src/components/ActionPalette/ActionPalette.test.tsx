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
// dialog/animation stack into a renderer-only unit test. Footer resolution
// mirrors SearchablePalette: getFooter > footer.
vi.mock("@/components/ui/SearchablePalette", () => ({
  SearchablePalette: (props: MockSearchablePaletteProps) => {
    lastSearchablePaletteProps.current = props;
    const query = props.query ?? "";
    const results = props.results ?? [];
    const showEmptyContent = results.length === 0 && query.trim() === "";
    const getFooter = props.getFooter as ((selected: unknown) => React.ReactNode) | undefined;
    const selectedIndex = (props.selectedIndex as number) ?? 0;
    const selectedItem = results[selectedIndex] ?? null;
    const footerNode = getFooter
      ? getFooter(selectedItem)
      : ((props.footer as React.ReactNode) ?? null);
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
        {footerNode}
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
import type {
  ActionPaletteItem as ActionPaletteItemType,
  UseActionPaletteReturn,
} from "@/hooks/useActionPalette";
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
  sections: [] as UseActionPaletteReturn["sections"],
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

function fireKey(
  key: string,
  options: {
    selectionStart?: number;
    selectionEnd?: number;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
  } = {}
) {
  const onKeyDown = lastSearchablePaletteProps.current?.onKeyDown as
    ((e: React.KeyboardEvent<HTMLInputElement>) => void) | undefined;
  if (!onKeyDown) throw new Error("onKeyDown not forwarded to SearchablePalette");
  let prevented = false;
  const currentTarget = {
    selectionStart: options.selectionStart ?? 0,
    selectionEnd: options.selectionEnd ?? 0,
  };
  const event = {
    key,
    metaKey: options.metaKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
    altKey: options.altKey ?? false,
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

  it("passes a renderBody callback when the hook supplies sections", () => {
    render(
      <ActionPalette
        {...baseProps}
        query=""
        results={[makeItem("a.action", "Alpha")]}
        totalResults={1}
        sections={[{ id: "category:general", label: "General", start: 0, count: 1 }]}
      />
    );

    expect(typeof lastSearchablePaletteProps.current?.renderBody).toBe("function");
  });

  it("keeps the sectioned body while a typed query's results are still catching up", () => {
    // Filtering lags the input, so the browse rows and their sections are both
    // still on screen for a frame after the first keystroke. Gating on `query`
    // would strip the headers off rows that still need them.
    render(
      <ActionPalette
        {...baseProps}
        query="al"
        results={[makeItem("a.action", "Alpha")]}
        totalResults={1}
        sections={[{ id: "category:general", label: "General", start: 0, count: 1 }]}
        isStale
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

  it("does not pop the chip when Backspace spans a selection that starts at 0", () => {
    render(<ActionPalette {...baseProps} />);
    fireKey(">");
    expect(screen.getByText("Commands")).toBeTruthy();

    const prevented = fireKey("Backspace", { selectionStart: 0, selectionEnd: 3 });
    expect(prevented).toBe(false);
    expect(screen.getByText("Commands")).toBeTruthy();
  });

  it("clears the active mode when the palette closes", () => {
    const { rerender } = render(<ActionPalette {...baseProps} />);
    fireKey(">");
    expect(screen.getByText("Commands")).toBeTruthy();

    rerender(<ActionPalette {...baseProps} isOpen={false} />);
    rerender(<ActionPalette {...baseProps} isOpen={true} />);
    expect(screen.queryByText("Commands")).toBeNull();
  });

  it("rejects prefix routing when modifier keys are held", () => {
    render(<ActionPalette {...baseProps} />);

    expect(fireKey(">", { metaKey: true })).toBe(false);
    expect(usePaletteStore.getState().activePaletteId).toBe("action");

    expect(fireKey("@", { ctrlKey: true })).toBe(false);
    expect(usePaletteStore.getState().activePaletteId).toBe("action");

    expect(fireKey("/", { altKey: true })).toBe(false);
    expect(usePaletteStore.getState().activePaletteId).toBe("action");

    expect(screen.queryByText("Commands")).toBeNull();
  });

  it("does not re-route when a second prefix is typed inside an active mode", () => {
    render(<ActionPalette {...baseProps} />);
    fireKey(">");
    expect(screen.getByText("Commands")).toBeTruthy();

    expect(fireKey("@")).toBe(false);
    expect(fireKey("#")).toBe(false);
    expect(fireKey("/")).toBe(false);
    expect(usePaletteStore.getState().activePaletteId).toBe("action");
  });

  it.each([
    ["src/foo", true],
    [".env", true],
    ["~/.ssh", true],
    ["src\\foo", true],
    ["foo.bar", false],
    ["middle~tilde", false],
  ])("looksLikePath heuristic for %s", (query, shouldHint) => {
    render(<ActionPalette {...baseProps} query={query} results={[]} totalResults={0} />);
    if (shouldHint) {
      expect(screen.getByText("search projects")).toBeTruthy();
    } else {
      expect(screen.queryByText("search projects")).toBeNull();
    }
  });

  describe("prefix discoverability footer", () => {
    it("renders the prefix table in the default empty-query footer", () => {
      render(<ActionPalette {...baseProps} />);
      // One chip per prefix — labels are lowercased for mid-sentence rendering.
      expect(screen.getByText("commands")).toBeTruthy();
      expect(screen.getByText("worktrees")).toBeTruthy();
      expect(screen.getByText("panels")).toBeTruthy();
      expect(screen.getByText("prompt history")).toBeTruthy();
      expect(screen.getByText("projects")).toBeTruthy();
    });

    it("hides the prefix table once a query is typed", () => {
      render(
        <ActionPalette
          {...baseProps}
          query="al"
          results={[makeItem("a.action", "Alpha")]}
          totalResults={1}
        />
      );
      expect(screen.queryByText("worktrees")).toBeNull();
    });

    it("hides the prefix table while a mode chip is active", () => {
      render(<ActionPalette {...baseProps} />);
      // Sanity: prefix row visible before any prefix is typed.
      expect(screen.getByText("worktrees")).toBeTruthy();
      fireKey(">");
      // Activating commands mode replaces the row with the mode-scoped hint.
      expect(screen.queryByText("worktrees")).toBeNull();
    });
  });

  describe("section header listbox separators", () => {
    const THREE_SECTIONS = [
      { id: "favorites", label: "Favorites", start: 0, count: 1 },
      { id: "recently-used", label: "Recently used", start: 1, count: 1 },
      { id: "category:worktree", label: "Worktrees", start: 2, count: 2 },
    ];
    const FOUR_ROWS = [
      makeItem("pinned.alpha", "Alpha"),
      makeItem("recent.beta", "Beta"),
      makeItem("browse.gamma", "Gamma"),
      makeItem("browse.delta", "Delta"),
    ];

    function renderSectionedBody(props: Partial<typeof baseProps> = {}) {
      render(
        <ActionPalette
          {...baseProps}
          results={FOUR_ROWS}
          totalResults={FOUR_ROWS.length}
          sections={THREE_SECTIONS}
          {...props}
        />
      );
      const renderBody = lastSearchablePaletteProps.current?.renderBody as
        (() => React.ReactNode) | undefined;
      expect(typeof renderBody).toBe("function");
      return render(<>{renderBody!()}</>).container;
    }

    it("renders every section header as an aria-disabled option so AT announces them", () => {
      const container = renderSectionedBody();

      for (const { label } of THREE_SECTIONS) {
        const header = container.querySelector(`[aria-label="${label}"]`);
        expect(header?.getAttribute("role")).toBe("option");
        expect(header?.getAttribute("aria-disabled")).toBe("true");
        expect(header?.getAttribute("aria-selected")).toBe("false");
      }
    });

    it("never nests a role=group inside the listbox", () => {
      // role="group" inside role="listbox" drops its label under Chromium +
      // VoiceOver, which is why the headers masquerade as inert options.
      const container = renderSectionedBody();
      expect(container.querySelectorAll('[role="group"]').length).toBe(0);
    });

    it("keeps headers out of the navigable rows", () => {
      const container = renderSectionedBody();
      const navigable = container.querySelectorAll('[role="option"]:not([aria-disabled="true"])');
      // Arrow keys walk `results`; the three dividers must not join them.
      expect(navigable.length).toBe(FOUR_ROWS.length);
    });

    it("indexes rows against the flat result list, not each section's slice", () => {
      // The last row is selected, so the highlight must follow its global index
      // rather than its offset within the final section.
      const container = renderSectionedBody({ selectedIndex: FOUR_ROWS.length - 1 });
      const selected = container.querySelectorAll('[aria-selected="true"]');
      expect(selected.length).toBe(1);
      expect(selected[0]?.getAttribute("id")).toBe(`action-option-${FOUR_ROWS[3]!.id}`);
    });

    it("offers the hide control only on Recently used rows", () => {
      const container = renderSectionedBody();
      const hideButtons = container.querySelectorAll('[aria-label^="Hide "]');
      // "Hide from Recently used" against a category row would promise an
      // eviction that rail can't perform.
      expect(hideButtons.length).toBe(1);
      expect(hideButtons[0]?.getAttribute("aria-label")).toContain("Beta");
    });
  });
});
