// @vitest-environment jsdom
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Profiler, type ReactNode } from "react";
import { VirtuosoMockContext, type GroupedVirtuosoHandle } from "react-virtuoso";
import { CrossWorktreeDiff, groupComparisonFiles } from "../CrossWorktreeDiff";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FILE_LIST_VIRTUALIZATION_THRESHOLD } from "@/lib/fileListWindowing";
import { pluralize } from "@/lib/pluralize";
import type { CrossWorktreeFile } from "@shared/types/ipc/git";

// Driven as a value and a change event, not as a Radix popup.
vi.mock("@/components/ui/select", () => import("@/components/ui/__tests__/nativeSelectMock"));

// A new map per head move, as the store produces; a new compare head is what
// refreshes the comparison in place.
let worktrees = new Map<string, unknown>();
function setCompareHead(headOid: string) {
  worktrees = new Map<string, unknown>([
    [
      "wt-left",
      {
        id: "wt-left",
        name: "helios",
        path: "/wt/left",
        branch: "main",
        isMainWorktree: true,
        worktreeChanges: { headOid: "base" },
      },
    ],
    [
      "wt-right",
      {
        id: "wt-right",
        name: "right",
        path: "/wt/right",
        branch: "feature",
        isMainWorktree: false,
        worktreeChanges: { headOid },
      },
    ],
  ]);
}

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (sel: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    sel({ worktrees }),
}));

vi.mock("@/components/ui/AppDialog", () => {
  interface SectionProps {
    children?: ReactNode;
  }
  const AppDialog = ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) =>
    isOpen ? <div data-testid="app-dialog">{children}</div> : null;
  AppDialog.Header = ({ children }: SectionProps) => <div>{children}</div>;
  AppDialog.Title = ({ children }: SectionProps) => <h2>{children}</h2>;
  AppDialog.CloseButton = () => <button type="button">close</button>;
  return { AppDialog };
});

vi.mock("../DiffViewer", () => ({
  DiffFilePath: ({ path }: { path: string }) => <span>{path}</span>,
  // The file-list toggle and the comparison controls ride in the viewer's header.
  DiffViewer: ({
    diff,
    headerLeading,
    headerActions,
  }: {
    diff: string;
    headerLeading?: ReactNode;
    headerActions?: ReactNode;
  }) => (
    <div>
      {headerLeading}
      {headerActions}
      <div data-testid="diff-viewer">{diff}</div>
    </div>
  ),
}));

/**
 * jsdom measures nothing, so the scrolls the shelf asks of the virtualizer are
 * only observable through `VirtuosoMockContext`'s synthetic sizes. This wraps
 * the REAL `GroupedVirtuoso`, records the index each reveal asks for, and keeps
 * the real handle so a test can scroll the window the way a user would. The
 * mock sizes items at once, so a test that needs the unmeasured first pass a
 * real layout has holds the virtualizer's own reports and plays its own.
 */
type RenderedItems = { index: number; offset: number; size: number }[];
const { scrollIntoViewMock, virtuoso } = vi.hoisted(() => ({
  scrollIntoViewMock: vi.fn<(location: { index: number; behavior?: string }) => void>(),
  virtuoso: {
    handle: null as GroupedVirtuosoHandle | null,
    holdItemsRendered: false,
    itemsRendered: null as ((items: RenderedItems) => void) | null,
  },
}));

vi.mock("react-virtuoso", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-virtuoso")>();
  const { createElement, forwardRef, useImperativeHandle, useRef } = await import("react");
  const Actual = actual.GroupedVirtuoso as unknown as React.ComponentType<
    Record<string, unknown> & { ref?: unknown }
  >;
  return {
    ...actual,
    GroupedVirtuoso: forwardRef(function GroupedVirtuosoSpy(
      props: Record<string, unknown>,
      ref: React.ForwardedRef<Partial<GroupedVirtuosoHandle>>
    ) {
      const inner = useRef<GroupedVirtuosoHandle | null>(null);
      useImperativeHandle(ref, () => ({
        scrollIntoView: (location: Parameters<GroupedVirtuosoHandle["scrollIntoView"]>[0]) => {
          scrollIntoViewMock(location as { index: number; behavior?: string });
          inner.current?.scrollIntoView(location);
        },
        scrollToIndex: (location: Parameters<GroupedVirtuosoHandle["scrollToIndex"]>[0]) =>
          inner.current?.scrollToIndex(location),
      }));
      const itemsRendered = props.itemsRendered as ((items: RenderedItems) => void) | undefined;
      virtuoso.itemsRendered = itemsRendered ?? null;
      return createElement(Actual, {
        ...props,
        itemsRendered: (items: RenderedItems) => {
          if (!virtuoso.holdItemsRendered) itemsRendered?.(items);
        },
        ref: (handle: GroupedVirtuosoHandle | null) => {
          inner.current = handle;
          virtuoso.handle = handle;
        },
      });
    }),
  };
});

const mockCompareWorktrees = vi.fn();

beforeEach(() => {
  setCompareHead("one");
  mockCompareWorktrees.mockReset();
  scrollIntoViewMock.mockClear();
  virtuoso.handle = null;
  virtuoso.holdItemsRendered = false;
  virtuoso.itemsRendered = null;
  Object.defineProperty(window, "electron", {
    value: { git: { compareWorktrees: mockCompareWorktrees } },
    configurable: true,
  });
});

/**
 * `groupCount` directories of `perGroup` files, handed over in REVERSE so the
 * shelf's own sort is what puts them in order.
 */
function comparison(groupCount: number, perGroup: number, root = "src/mod"): CrossWorktreeFile[] {
  const files: CrossWorktreeFile[] = [];
  for (let g = 0; g < groupCount; g++) {
    for (let f = 0; f < perGroup; f++) {
      files.push({
        path: `${root}-${String(g).padStart(3, "0")}/file-${String(f).padStart(4, "0")}.ts`,
        status: "M",
        insertions: 2,
        deletions: 1,
      });
    }
  }
  return files.reverse();
}

function respondWith(files: CrossWorktreeFile[]) {
  mockCompareWorktrees.mockImplementation((_path, _b1, _b2, filePath?: string) =>
    Promise.resolve(
      filePath === undefined
        ? { branch1: "main", branch2: "feature", files }
        : `diff --git a/${filePath} b/${filePath}\n@@ -1 +1 @@\n-old\n+new`
    )
  );
}

function tree(onRender?: () => void) {
  const dialog = <CrossWorktreeDiff isOpen onClose={vi.fn()} initialWorktreeId="wt-left" />;
  return (
    <TooltipProvider>
      <VirtuosoMockContext.Provider value={{ itemHeight: 24, viewportHeight: 480 }}>
        {onRender ? (
          <Profiler id="compare" onRender={onRender}>
            {dialog}
          </Profiler>
        ) : (
          dialog
        )}
      </VirtuosoMockContext.Provider>
    </TooltipProvider>
  );
}

function renderComparison(files: CrossWorktreeFile[], onRender?: () => void) {
  respondWith(files);
  const view = render(tree(onRender));
  fireEvent.change(screen.getByLabelText("Compare"), { target: { value: "wt-right" } });
  // A new compare head reruns the comparison in place, keeping the open file.
  const refresh = (next: CrossWorktreeFile[], head: string) => {
    respondWith(next);
    setCompareHead(head);
    view.rerender(tree(onRender));
  };
  return { refresh };
}

function drawnOrder(files: CrossWorktreeFile[]): string[] {
  return groupComparisonFiles(files).flatMap((group) => group.files.map((f) => f.path));
}

function fileRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-file-path]"));
}

function rowFor(path: string | undefined): HTMLElement | undefined {
  return fileRows().find((row) => row.dataset.filePath === path);
}

function currentRow(): HTMLElement | undefined {
  return fileRows().find((row) => row.getAttribute("aria-current") === "true");
}

function focusedPath(): string | undefined {
  const active = document.activeElement;
  return active instanceof HTMLElement ? active.dataset.filePath : undefined;
}

function position(): string | null {
  return screen.queryByTestId("cross-worktree-file-position")?.textContent ?? null;
}

/** The per-file diffs asked for, in order (not the whole-file source reads). */
function requestedDiffs(): string[] {
  return mockCompareWorktrees.mock.calls
    .filter((call) => call[3] !== undefined && call[6] === undefined)
    .map((call) => String(call[3]));
}

/** Everything in the shelf that Tab can land on. */
function tabStops(): HTMLElement[] {
  const shelf = screen.getByTestId("cross-worktree-file-shelf");
  return Array.from(shelf.querySelectorAll<HTMLElement>("button, [tabindex]")).filter(
    (el) => el.tabIndex >= 0
  );
}

describe("CrossWorktreeDiff shelf with a large comparison (#17461)", () => {
  it("never mounts more than a window of rows, while the totals count every file", async () => {
    // Counted in every commit from the pick on, so a list that mounted every
    // row once and windowed afterwards would still be caught.
    let mostRows = 0;
    const files = comparison(30, 100);
    renderComparison(files, () => {
      mostRows = Math.max(mostRows, fileRows().length);
    });
    await waitFor(() => expect(position()).toBe(`1 of ${files.length}`));

    expect(fileRows().length).toBeGreaterThan(0);
    expect(mostRows).toBeLessThan(FILE_LIST_VIRTUALIZATION_THRESHOLD);
    const shelf = screen.getByTestId("cross-worktree-file-shelf");
    expect(shelf.textContent).toContain(pluralize(files.length, "file"));
    expect(shelf.textContent).toContain(`+${(files.length * 2).toLocaleString()}`);
    expect(shelf.textContent).toContain(`-${files.length.toLocaleString()}`);
  });

  it("draws the window root first, then by directory and file name", async () => {
    const files: CrossWorktreeFile[] = [
      ...comparison(30, 100),
      { path: "docs/z.md", status: "M", insertions: 1, deletions: 0 },
      { path: "b.ts", status: "M", insertions: 1, deletions: 0 },
      { path: "docs/a.md", status: "A", insertions: 1, deletions: 0 },
      { path: "a.ts", status: "D", insertions: 0, deletions: 1 },
      { path: "docs/c.md", status: "M", insertions: 1, deletions: 0 },
    ];
    renderComparison(files);
    await waitFor(() => expect(fileRows().length).toBeGreaterThan(0));

    expect(
      fileRows()
        .slice(0, 6)
        .map((row) => row.dataset.filePath)
    ).toEqual(["a.ts", "b.ts", "docs/a.md", "docs/c.md", "docs/z.md", "src/mod-000/file-0000.ts"]);
    const shelf = screen.getByTestId("cross-worktree-file-shelf");
    const bands = Array.from(shelf.querySelectorAll("[data-shelf-band]")).map(
      (band) => band.textContent
    );
    expect(bands.slice(0, 3)).toEqual(["(root)", "docs", "src/mod-000"]);
  });

  it("steps with ] past the initially mounted rows, one file at a time, and back with [", async () => {
    const files = comparison(4, 50);
    const drawn = drawnOrder(files);
    renderComparison(files);
    await waitFor(() => expect(position()).toBe(`1 of ${files.length}`));
    const steps = fileRows().length + 5;
    expect(rowFor(drawn[steps])).toBeUndefined();

    for (let i = 0; i < steps; i++) fireEvent.keyDown(window, { key: "]" });
    await waitFor(() => expect(position()).toBe(`${steps + 1} of ${files.length}`));
    // Each press opened the next file in the drawn order, none skipped.
    expect(requestedDiffs()).toEqual(drawn.slice(0, steps + 1));
    // The open file is asked for by its place in the drawn order, and the row
    // the virtualizer brings in is that file's.
    expect(scrollIntoViewMock).toHaveBeenLastCalledWith(expect.objectContaining({ index: steps }));
    await waitFor(() => expect(currentRow()?.dataset.filePath).toBe(drawn[steps]));

    fireEvent.keyDown(window, { key: "[" });
    await waitFor(() => expect(position()).toBe(`${steps} of ${files.length}`));
    expect(currentRow()?.dataset.filePath).toBe(drawn[steps - 1]);
  });

  it("brings in, focuses and opens the final file with End, and returns with Home", async () => {
    const files = comparison(30, 100);
    const drawn = drawnOrder(files);
    renderComparison(files);
    await waitFor(() => expect(fileRows().length).toBeGreaterThan(0));
    expect(rowFor(drawn.at(-1))).toBeUndefined();

    const stop = fileRows().find((row) => row.tabIndex === 0)!;
    act(() => stop.focus());
    fireEvent.keyDown(stop, { key: "End" });

    expect(scrollIntoViewMock).toHaveBeenCalledWith(
      expect.objectContaining({ index: files.length - 1 })
    );
    await waitFor(() => expect(focusedPath()).toBe(drawn.at(-1)));
    fireEvent.click(document.activeElement!);
    await waitFor(() => expect(position()).toBe(`${files.length} of ${files.length}`));

    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    await waitFor(() => expect(focusedPath()).toBe(drawn[0]));
    // Home moves focus, not the open file.
    expect(position()).toBe(`${files.length} of ${files.length}`);
  });

  it("keeps the shelf one tab stop, parked on the list while the focused row is scrolled out", async () => {
    const files = comparison(30, 100);
    const drawn = drawnOrder(files);
    renderComparison(files);
    await waitFor(() => expect(fileRows().length).toBeGreaterThan(0));
    await waitFor(() => expect(virtuoso.handle).not.toBeNull());
    expect(tabStops().map((el) => el.dataset.filePath)).toEqual([drawn[0]]);

    act(() => rowFor(drawn[0])!.focus());
    act(() => virtuoso.handle!.scrollToIndex({ index: 2000 }));
    await waitFor(() => expect(rowFor(drawn[0])).toBeUndefined());
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));

    const parked = document.activeElement as HTMLElement;
    expect(parked.dataset.filePath).toBeUndefined();
    expect(screen.getByTestId("cross-worktree-file-shelf").contains(parked)).toBe(true);
    expect(tabStops()).toEqual([parked]);

    act(() => virtuoso.handle!.scrollToIndex({ index: 0 }));
    await waitFor(() => expect(focusedPath()).toBe(drawn[0]));
    expect(tabStops().map((el) => el.dataset.filePath)).toEqual([drawn[0]]);
  });

  it("reveals the open file where a refresh moved it, headers ahead of it included", async () => {
    // The open file starts first in the shelf. The refresh adds 2,900 files in
    // 290 directories that sort ahead of it, so its row moves to position 2,900
    // with 290 more bands above it: a reveal that counted those bands as rows
    // would land 290 rows past it, well outside the mounted window.
    const original = comparison(4, 50);
    const open = drawnOrder(original)[0]!;
    const { refresh } = renderComparison(original);
    await waitFor(() => expect(currentRow()?.dataset.filePath).toBe(open));

    const refreshed = [...comparison(290, 10, "lib/pkg"), ...original];
    refresh(refreshed, "two");

    await waitFor(() => expect(position()).toBe(`2901 of ${refreshed.length}`));
    expect(drawnOrder(refreshed)[2900]).toBe(open);
    expect(scrollIntoViewMock).toHaveBeenLastCalledWith(expect.objectContaining({ index: 2900 }));
    await waitFor(() => expect(currentRow()?.dataset.filePath).toBe(open));
  });

  it("asks again for the open file when a refresh adds bands ahead of it", async () => {
    // Sixty files in one directory become sixty directories of one file. The
    // open file keeps its place among the files, 60, but has 59 more bands
    // above it, so its row moves down out of the window.
    const tail = comparison(1, 30);
    const together = Array.from({ length: 60 }, (_, i) => ({
      path: `lib/a/file-${String(i).padStart(2, "0")}.ts`,
      status: "M",
      insertions: 1,
      deletions: 0,
    }));
    const apart = together.map((file, i) => ({
      ...file,
      path: `lib/d-${String(i).padStart(2, "0")}/file.ts`,
    }));
    const files = [...together, ...tail];
    const open = drawnOrder(files)[60]!;
    const { refresh } = renderComparison(files);
    await waitFor(() => expect(position()).toBe(`1 of ${files.length}`));
    for (let i = 0; i < 60; i++) fireEvent.keyDown(window, { key: "]" });
    await waitFor(() => expect(currentRow()?.dataset.filePath).toBe(open));

    scrollIntoViewMock.mockClear();
    const refreshed = [...apart, ...tail];
    refresh(refreshed, "two");
    await waitFor(() => expect(requestedDiffs().filter((path) => path === open)).toHaveLength(2));
    expect(drawnOrder(refreshed)[60]).toBe(open);
    expect(scrollIntoViewMock).toHaveBeenLastCalledWith(expect.objectContaining({ index: 60 }));
    await waitFor(() => expect(currentRow()?.dataset.filePath).toBe(open));
  });

  it("brings the open file back into view when the shelf is put away and reopened", async () => {
    const original = comparison(4, 50);
    const open = drawnOrder(original)[0]!;
    const { refresh } = renderComparison(original);
    await waitFor(() => expect(currentRow()?.dataset.filePath).toBe(open));
    refresh([...comparison(290, 10, "lib/pkg"), ...original], "two");
    await waitFor(() => expect(currentRow()?.dataset.filePath).toBe(open));

    fireEvent.click(screen.getByRole("button", { name: "Toggle file list" }));
    await waitFor(() => expect(screen.queryByTestId("cross-worktree-file-shelf")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Toggle file list" }));

    // A new virtualizer opens at the top; the open file's row only comes back
    // once it has measured and been asked for again.
    await waitFor(() => expect(currentRow()?.dataset.filePath).toBe(open));
  });

  it("asks again for the open file once a reopened list has measured, not before", async () => {
    const original = comparison(4, 50);
    const open = drawnOrder(original)[0]!;
    const { refresh } = renderComparison(original);
    await waitFor(() => expect(currentRow()?.dataset.filePath).toBe(open));
    refresh([...comparison(290, 10, "lib/pkg"), ...original], "two");
    await waitFor(() => expect(currentRow()?.dataset.filePath).toBe(open));

    fireEvent.click(screen.getByRole("button", { name: "Toggle file list" }));
    await waitFor(() => expect(screen.queryByTestId("cross-worktree-file-shelf")).toBeNull());
    virtuoso.holdItemsRendered = true;
    fireEvent.click(screen.getByRole("button", { name: "Toggle file list" }));
    await waitFor(() => expect(virtuoso.handle).not.toBeNull());
    await act(async () => {});

    // A real layout's first pass is an unmeasured probe, which a scroll can't
    // land on; the reveal waits for an item with a size.
    scrollIntoViewMock.mockClear();
    act(() => virtuoso.itemsRendered!([{ index: 0, offset: 0, size: 0 }]));
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
    act(() => virtuoso.itemsRendered!([{ index: 0, offset: 0, size: 24 }]));
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    expect(scrollIntoViewMock).toHaveBeenLastCalledWith(expect.objectContaining({ index: 2900 }));
    act(() => virtuoso.itemsRendered!([{ index: 1, offset: 24, size: 24 }]));
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
  });

  it("leaves the list where the keyboard took it when a refresh changes nothing", async () => {
    const files = comparison(30, 100);
    const drawn = drawnOrder(files);
    const { refresh } = renderComparison(files);
    await waitFor(() => expect(fileRows().length).toBeGreaterThan(0));
    await waitFor(() => expect(requestedDiffs()).toEqual([drawn[0]]));
    const stop = fileRows().find((row) => row.tabIndex === 0)!;
    act(() => stop.focus());
    fireEvent.keyDown(stop, { key: "End" });
    await waitFor(() => expect(focusedPath()).toBe(drawn.at(-1)));

    // The same list again, as fresh objects; the open file reloads in place.
    scrollIntoViewMock.mockClear();
    refresh(
      files.map((file) => ({ ...file })),
      "two"
    );
    await waitFor(() => expect(requestedDiffs()).toEqual([drawn[0], drawn[0]]));
    await act(async () => {});

    expect(scrollIntoViewMock).not.toHaveBeenCalled();
    expect(focusedPath()).toBe(drawn.at(-1));
  });

  it("keeps focus on its row when a refresh moves the shelf across the windowing threshold", async () => {
    const below = comparison(1, FILE_LIST_VIRTUALIZATION_THRESHOLD - 1);
    const drawn = drawnOrder(below);
    const { refresh } = renderComparison(below);
    await waitFor(() => expect(fileRows()).toHaveLength(below.length));
    act(() => rowFor(drawn[1])!.focus());

    const added: CrossWorktreeFile = {
      path: "src/mod-000/file-9999.ts",
      status: "A",
      insertions: 1,
      deletions: 0,
    };
    refresh([...below, added], "two");
    await waitFor(() => expect(fileRows().length).toBeLessThan(below.length));
    await waitFor(() => expect(focusedPath()).toBe(drawn[1]));

    refresh(below, "three");
    await waitFor(() => expect(fileRows()).toHaveLength(below.length));
    await waitFor(() => expect(focusedPath()).toBe(drawn[1]));
  });

  it("still discloses the full path when a windowed row's directory band is shortened", async () => {
    const files: CrossWorktreeFile[] = Array.from({ length: 120 }, (_, i) => ({
      path: `packages/telemetry-exporter/src/internal/strategy-${String(i).padStart(3, "0")}.ts`,
      status: "A",
      insertions: 1,
      deletions: 0,
    }));
    renderComparison(files);
    await waitFor(() => expect(fileRows().length).toBeGreaterThan(0));
    expect(fileRows().length).toBeLessThan(files.length);

    const row = fileRows()[1]!;
    fireEvent.focus(row);
    await waitFor(() =>
      expect(
        screen.getAllByRole("tooltip").some((tip) => tip.textContent === row.dataset.filePath)
      ).toBe(true)
    );
  });

  it("discloses the full path while a windowed row's band is clipped, and stops once it fits", async () => {
    // Two segments, so the band is never shortened; only its measured width
    // can hide the directory. jsdom lays nothing out, so the band reports an
    // overflow here (while `clipped` holds) and every other element none.
    const dir = "src/clipped";
    let clipped = true;
    const isBand = (el: Element) =>
      el.textContent === dir && el.closest("[data-shelf-band]") !== null;
    const scrollWidth = vi
      .spyOn(Element.prototype, "scrollWidth", "get")
      .mockImplementation(function (this: Element) {
        return clipped && isBand(this) ? 400 : 0;
      });
    const clientWidth = vi
      .spyOn(Element.prototype, "clientWidth", "get")
      .mockImplementation(function (this: Element) {
        return isBand(this) ? 100 : 0;
      });
    try {
      const files: CrossWorktreeFile[] = Array.from({ length: 120 }, (_, i) => ({
        path: `${dir}/file-${String(i).padStart(3, "0")}.ts`,
        status: "M",
        insertions: 1,
        deletions: 0,
      }));
      renderComparison(files);
      await waitFor(() => expect(fileRows().length).toBeGreaterThan(0));
      expect(fileRows().length).toBeLessThan(files.length);

      const row = fileRows()[1]!;
      fireEvent.focus(row);
      await waitFor(() =>
        expect(
          screen.getAllByRole("tooltip").some((tip) => tip.textContent === row.dataset.filePath)
        ).toBe(true)
      );
      expect(row.getAttribute("data-state")).not.toBe("closed");

      // The shelf comes back with room for the directory (a scrollbar gone,
      // say): the remounted band measures again and its rows stop disclosing.
      clipped = false;
      fireEvent.click(screen.getByRole("button", { name: "Toggle file list" }));
      await waitFor(() => expect(screen.queryByTestId("cross-worktree-file-shelf")).toBeNull());
      fireEvent.click(screen.getByRole("button", { name: "Toggle file list" }));
      await waitFor(() => expect(fileRows().length).toBeGreaterThan(2));
      const next = fileRows()[2]!;
      fireEvent.focus(next);
      await act(async () => {});
      // The trigger's own state: its content would render a beat later.
      expect(next.getAttribute("data-state")).toBe("closed");
    } finally {
      scrollWidth.mockRestore();
      clientWidth.mockRestore();
    }
  });
});
