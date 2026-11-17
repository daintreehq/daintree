// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { VirtuosoMockContext, type GroupedVirtuosoHandle } from "react-virtuoso";
import { CrossWorktreeDiff, groupComparisonFiles } from "../CrossWorktreeDiff";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FILE_LIST_VIRTUALIZATION_THRESHOLD } from "@/lib/fileListWindowing";
import { pluralize } from "@/lib/pluralize";
import type { CrossWorktreeFile } from "@shared/types/ipc/git";

// Driven as a value and a change event, not as a Radix popup.
vi.mock("@/components/ui/select", () => import("@/components/ui/__tests__/nativeSelectMock"));

const worktrees = new Map([
  [
    "wt-left",
    { id: "wt-left", name: "helios", path: "/wt/left", branch: "main", isMainWorktree: true },
  ],
  [
    "wt-right",
    { id: "wt-right", name: "right", path: "/wt/right", branch: "feature", isMainWorktree: false },
  ],
]);

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
  DiffViewer: ({ diff, headerActions }: { diff: string; headerActions?: ReactNode }) => (
    <div>
      {headerActions}
      <div data-testid="diff-viewer">{diff}</div>
    </div>
  ),
}));

/**
 * jsdom measures nothing, so no scroll the shelf asks of the virtualizer is
 * observable. This wraps the REAL `GroupedVirtuoso` and only taps its handle on
 * the way past, so the slot the shelf reveals can be asserted while the
 * windowing itself stays the library's own.
 */
const { scrollIntoViewMock } = vi.hoisted(() => ({
  scrollIntoViewMock: vi.fn<(location: { index: number; behavior?: string }) => void>(),
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
      return createElement(Actual, { ...props, ref: inner });
    }),
  };
});

const mockCompareWorktrees = vi.fn();

beforeEach(() => {
  mockCompareWorktrees.mockReset();
  scrollIntoViewMock.mockClear();
  Object.defineProperty(window, "electron", {
    value: { git: { compareWorktrees: mockCompareWorktrees } },
    configurable: true,
  });
});

/**
 * `groupCount` directories of `perGroup` files, handed over in REVERSE so the
 * shelf's own sort is what puts them in order. The directories sort in the
 * order they are numbered, so the nth drawn file sits behind n / perGroup
 * group headers plus its own: slot = n + floor(n / perGroup) + 1.
 */
function comparison(groupCount: number, perGroup: number): CrossWorktreeFile[] {
  const files: CrossWorktreeFile[] = [];
  for (let g = 0; g < groupCount; g++) {
    for (let f = 0; f < perGroup; f++) {
      files.push({
        path: `src/mod-${String(g).padStart(3, "0")}/file-${String(f).padStart(4, "0")}.ts`,
        status: "M",
        insertions: 2,
        deletions: 1,
      });
    }
  }
  return files.reverse();
}

function renderComparison(files: CrossWorktreeFile[]) {
  mockCompareWorktrees.mockImplementation((_path, _b1, _b2, filePath?: string) =>
    Promise.resolve(
      filePath === undefined
        ? { branch1: "main", branch2: "feature", files }
        : `diff --git a/${filePath} b/${filePath}\n@@ -1 +1 @@\n-old\n+new`
    )
  );
  render(
    <TooltipProvider>
      <VirtuosoMockContext.Provider value={{ itemHeight: 24, viewportHeight: 480 }}>
        <CrossWorktreeDiff isOpen onClose={vi.fn()} initialWorktreeId="wt-left" />
      </VirtuosoMockContext.Provider>
    </TooltipProvider>
  );
  fireEvent.change(screen.getByLabelText("Compare"), { target: { value: "wt-right" } });
}

function fileRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-file-path]"));
}

function position(): string | null {
  return screen.queryByTestId("cross-worktree-file-position")?.textContent ?? null;
}

describe("CrossWorktreeDiff shelf with a large comparison (#17461)", () => {
  it("mounts a bounded window of rows while the totals still count every file", async () => {
    const files = comparison(30, 100);
    renderComparison(files);
    await waitFor(() => expect(fileRows().length).toBeGreaterThan(0));
    await waitFor(() => expect(position()).toBe(`1 of ${files.length}`));

    expect(fileRows().length).toBeLessThan(FILE_LIST_VIRTUALIZATION_THRESHOLD);
    const shelf = screen.getByTestId("cross-worktree-file-shelf");
    expect(shelf.textContent).toContain(pluralize(files.length, "file"));
    expect(shelf.textContent).toContain(`+${(files.length * 2).toLocaleString()}`);
    expect(shelf.textContent).toContain(`-${files.length.toLocaleString()}`);
  });

  it("draws the window in the shelf's order, directory bands included", async () => {
    const files = comparison(30, 100);
    renderComparison(files);
    await waitFor(() => expect(fileRows().length).toBeGreaterThan(0));

    const drawn = groupComparisonFiles(files).flatMap((group) => group.files.map((f) => f.path));
    const mounted = fileRows().map((row) => row.dataset.filePath);
    expect(mounted).toEqual(drawn.slice(0, mounted.length));
    expect(screen.getAllByText("src/mod-000").length).toBeGreaterThan(0);
  });

  it("steps with ] and [ through every file, past the mounted window", async () => {
    const perGroup = 50;
    const files = comparison(4, perGroup);
    renderComparison(files);
    await waitFor(() => expect(position()).toBe(`1 of ${files.length}`));

    for (let i = 1; i < files.length; i++) fireEvent.keyDown(window, { key: "]" });
    await waitFor(() => expect(position()).toBe(`${files.length} of ${files.length}`));
    // The open file's row is asked for by its SLOT, which counts the band ahead
    // of each directory's files.
    const last = files.length - 1;
    expect(scrollIntoViewMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: last + Math.floor(last / perGroup) + 1 })
    );

    fireEvent.keyDown(window, { key: "[" });
    await waitFor(() => expect(position()).toBe(`${files.length - 1} of ${files.length}`));
  });

  it("asks the virtualizer for the final file when End lands on a row that is not mounted", async () => {
    const perGroup = 100;
    const files = comparison(30, perGroup);
    renderComparison(files);
    await waitFor(() => expect(fileRows().length).toBeGreaterThan(0));

    const stop = fileRows().find((row) => row.tabIndex === 0)!;
    stop.focus();
    scrollIntoViewMock.mockClear();
    fireEvent.keyDown(stop, { key: "End" });

    const last = files.length - 1;
    expect(scrollIntoViewMock).toHaveBeenCalledWith(
      expect.objectContaining({ index: last + Math.floor(last / perGroup) + 1 })
    );
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

    const row = fileRows()[0]!;
    fireEvent.focus(row);
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("tooltip")
          .some((t) => t.textContent?.includes(row.dataset.filePath ?? "\0"))
      ).toBe(true)
    );
  });
});
