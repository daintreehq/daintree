/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import type { DiffChangeSetEntry } from "@shared/types/git";
import type { PluginContextMenuItemEntry } from "@/hooks/usePluginContextMenuItems";

type DispatchResult = { ok: true; result: unknown } | { ok: false; error: { message: string } };
const dispatchMock = vi.fn<(id: string, args?: unknown, opts?: unknown) => Promise<DispatchResult>>(
  () => Promise.resolve({ ok: true, result: undefined })
);
vi.mock("@/services/ActionService", () => ({
  actionService: (() => ({
    dispatch: (id: string, args?: unknown, opts?: unknown) => dispatchMock(id, args, opts),
  }))(),
}));

vi.mock("@/hooks/useInsertFileReference", () => ({
  useInsertFileReference: () => ({
    canInsert: false,
    refusalReason: "no-eligible-agent",
    insert: () => false,
  }),
}));

const { itemsRef } = vi.hoisted(() => ({
  itemsRef: { current: [] as PluginContextMenuItemEntry[] },
}));
vi.mock("@/hooks/usePluginContextMenuItems", () => ({
  usePluginContextMenuItems: () => itemsRef.current,
}));

/**
 * The shelf reveals an off-screen row through the virtualizer's imperative
 * handle, and jsdom measures nothing, so no scroll it performs is observable.
 * This wraps the REAL `GroupedVirtuoso` rather than replacing it — the grouped
 * windowing below still has to be the library's own — and only taps the handle
 * on the way past, so the index the shelf asks for can be asserted.
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

vi.mock("@/store/diffViewedStore", () => ({
  useDiffViewedStore: (selector?: (state: unknown) => unknown) => {
    const state = { toggleViewed: () => {} };
    return selector ? selector(state) : state;
  },
  selectViewedSet: () => new Set<string>(),
}));

import { VirtuosoMockContext, type GroupedVirtuosoHandle } from "react-virtuoso";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import { DiffFileSidebar } from "../DiffFileSidebar";

const WORKTREE = "/repo";
const OUTER_SENTINEL = "Enclosing menu sentinel";

function entry(path: string): DiffChangeSetEntry {
  return { path, status: "modified", insertions: 1, deletions: 0, viewedKey: `modified:${path}` };
}

function renderSidebar(overrides: Partial<React.ComponentProps<typeof DiffFileSidebar>> = {}) {
  const onSelect = vi.fn();
  const utils = render(
    <TooltipProvider>
      {/* An enclosing trigger stands in for any panel chrome that owns a menu
          of its own — a file row must never fall through to it. */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div>
            <DiffFileSidebar
              files={[entry("src/index.ts")]}
              currentIndex={0}
              worktreePath={WORKTREE}
              worktreeId="wt-1"
              onSelect={onSelect}
              {...overrides}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <button type="button">{OUTER_SENTINEL}</button>
        </ContextMenuContent>
      </ContextMenu>
    </TooltipProvider>
  );
  return { onSelect, ...utils };
}

/**
 * Opens a nested submenu and hands back its content. `SubContent` is
 * Presence-gated, so its items are not in the DOM until the trigger fires;
 * clicked rather than hovered because Radix opens synchronously on click.
 */
async function openSubmenu(menu: HTMLElement, name: string): Promise<HTMLElement> {
  fireEvent.click(within(menu).getByRole("menuitem", { name }));
  return screen.findByRole("menu", { name });
}

beforeAll(async () => {
  await primeRadix();
});

beforeEach(() => {
  dispatchMock.mockClear();
  scrollIntoViewMock.mockClear();
  itemsRef.current = [];
});

afterEach(() => cleanup());

describe("DiffFileSidebar — file row menu", () => {
  it("opens the shared file menu on a row and claims the event", async () => {
    renderSidebar();

    const row = screen.getByTestId("diff-sidebar-file").parentElement!;
    fireEvent.contextMenu(row);

    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Open file/ })).toBeTruthy();
    const copy = await openSubmenu(menu, "Copy");
    expect(within(copy).getByRole("menuitem", { name: "Copy path" })).toBeTruthy();
    expect(screen.queryByText(OUTER_SENTINEL)).toBeNull();
  });

  it("marks the targeted row while its menu is open", async () => {
    renderSidebar();

    const row = screen.getByTestId("diff-sidebar-file").parentElement!;
    fireEvent.contextMenu(row);
    await screen.findByRole("menu");

    expect(row.getAttribute("data-state")).toBe("open");
  });

  it("steps this sidebar's own viewer rather than dispatching a second diff", async () => {
    const { onSelect } = renderSidebar({
      files: [entry("src/a.ts"), entry("src/b.ts")],
      currentIndex: 0,
    });

    const rows = screen.getAllByTestId("diff-sidebar-file");
    fireEvent.contextMenu(rows[1]!.parentElement!);
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open diff" }));

    expect(onSelect).toHaveBeenCalledWith(1);
    expect(dispatchMock.mock.calls.some(([id]) => id === "file.openDiff")).toBe(false);
  });

  it("opens the menu from the keyboard on the focused file button", async () => {
    renderSidebar();

    fireEvent.keyDown(screen.getByTestId("diff-sidebar-file"), { key: "ContextMenu" });

    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Open file/ })).toBeTruthy();
  });

  it("drops Copy context when no worktree resolves", async () => {
    renderSidebar({ worktreeId: null });

    fireEvent.contextMenu(screen.getByTestId("diff-sidebar-file").parentElement!);
    const menu = await screen.findByRole("menu");

    const copy = await openSubmenu(menu, "Copy");
    expect(within(copy).queryByRole("menuitem", { name: "Copy context" })).toBeNull();
    expect(within(copy).getByRole("menuitem", { name: "Copy path" })).toBeTruthy();
  });

  it("offers no row menu at all when the worktree root has not resolved", async () => {
    // `DiffPane` reports an empty root rather than guessing one. Every item here
    // names a path on disk, and joining onto "" would leave a relative path that
    // `file.view` resolves against whatever project is current — a different
    // repo, a different file. Falling through to the enclosing menu is the
    // honest answer, and is what this surface did before it had a row menu.
    renderSidebar({ worktreePath: "" });

    fireEvent.contextMenu(screen.getByTestId("diff-sidebar-file").parentElement!);

    expect(await screen.findByText(OUTER_SENTINEL)).toBeTruthy();
    // The row menu's own root row, not one of its nested copies — a closed
    // submenu is absent from the DOM either way and would prove nothing.
    expect(screen.queryByRole("menuitem", { name: "Copy" })).toBeNull();
  });

  it("stands the global menu key down only while rows have a menu to open", () => {
    const { unmount } = renderSidebar();
    const withRoot = screen.getByTestId("diff-sidebar-file").parentElement!;
    expect(withRoot.hasAttribute("data-row-menu")).toBe(true);
    unmount();

    renderSidebar({ worktreePath: "" });
    const rootless = screen.getByTestId("diff-sidebar-file");
    // `useGlobalKeybindings` stands down on the marker alone. With no trigger
    // rendered here, keeping it would swallow Shift+F10 into nothing — the row
    // has to leave the key for the global handler.
    expect(rootless.parentElement!.hasAttribute("data-row-menu")).toBe(false);
    expect(fireEvent.keyDown(rootless, { key: "ContextMenu" })).toBe(true);
  });

  it("carries plugin file items onto this surface too", async () => {
    itemsRef.current = [
      { pluginId: "acme", item: { label: "Acme thing", actionId: "acme.do", location: "file" } },
    ];
    renderSidebar();

    fireEvent.contextMenu(screen.getByTestId("diff-sidebar-file").parentElement!);
    const menu = await screen.findByRole("menu");
    const extensions = await openSubmenu(menu, "Extensions");
    fireEvent.click(within(extensions).getByRole("menuitem", { name: "Acme thing" }));

    const call = dispatchMock.mock.calls.find(([id]) => id === "acme.do");
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({ path: "/repo/src/index.ts", worktreePath: WORKTREE });
  });
});

describe("DiffFileSidebar — windowed file shelf (#12241)", () => {
  /**
   * Directory names that sort in the OPPOSITE order to their files' changeset
   * indices. Display position and file index are then genuinely different
   * numbers, which is the only way to prove the shelf keeps them apart: it
   * reveals by display position and selects by file index.
   */
  /**
   * jsdom measures nothing, so the real virtualizer would see a zero-height
   * viewport and mount no rows at all. `VirtuosoMockContext` is react-virtuoso's
   * own answer to that — it supplies fixed dimensions and lets the REAL grouped
   * windowing run, which is the point: these tests are about the group/item
   * index arithmetic, and a stub would be asserting the stub.
   */
  const renderWindowed = (files: DiffChangeSetEntry[], currentIndex: number) => {
    const onSelect = vi.fn();
    const { container } = render(
      <TooltipProvider>
        <VirtuosoMockContext.Provider value={{ itemHeight: 32, viewportHeight: 640 }}>
          <DiffFileSidebar
            files={files}
            currentIndex={currentIndex}
            worktreePath={WORKTREE}
            worktreeId="wt-1"
            onSelect={onSelect}
          />
        </VirtuosoMockContext.Provider>
      </TooltipProvider>
    );
    return { onSelect, container };
  };

  const reversedGroups = (count: number): DiffChangeSetEntry[] =>
    Array.from({ length: count }, (_, i) =>
      entry(`src/z${String(count - 1 - i).padStart(4, "0")}/file-${String(i).padStart(4, "0")}.ts`)
    );

  /**
   * `groupCount` directories of `perGroup` files each, named so the directories
   * sort into the order they were built in. File index and DISPLAY index are
   * then the same number — which is exactly the confusion this fixture is here
   * to catch, because neither of them is the SLOT index the virtualizer's
   * handle speaks. The slot of the nth file is `n + (its group ordinal + 1)`.
   */
  const GROUP_COUNT = 20;
  const PER_GROUP = 10;
  const groupedFiles = (): DiffChangeSetEntry[] =>
    Array.from({ length: GROUP_COUNT * PER_GROUP }, (_, i) =>
      entry(
        `src/g${String(Math.floor(i / PER_GROUP)).padStart(2, "0")}/file-${String(i).padStart(3, "0")}.ts`
      )
    );
  const slotOf = (fileIndex: number) => fileIndex + Math.floor(fileIndex / PER_GROUP) + 1;

  it("renders every row below the windowing threshold", () => {
    renderSidebar({ files: reversedGroups(20), currentIndex: 0 });
    expect(screen.getAllByTestId("diff-sidebar-file")).toHaveLength(20);
  });

  it("keeps the directory headers and the file's own index once it windows", () => {
    const files = reversedGroups(120);
    const { onSelect } = renderWindowed(files, 0);

    // A row per directory here, so headers and rows are 1:1 — what matters is
    // that the headers survived windowing at all.
    expect(screen.getAllByText(/^src\/z\d{4}$/).length).toBeGreaterThan(0);

    const rows = screen.getAllByTestId("diff-sidebar-file");
    expect(rows.length).toBeLessThan(120);

    // The first row on screen is the LAST file in the changeset, because the
    // directories sort in reverse. Clicking it must report 119, not 0.
    fireEvent.click(rows[0]!);
    expect(onSelect).toHaveBeenCalledWith(119);
  });

  it("marks the open file current by its changeset index, not its display position", () => {
    // File 119 sits in the FIRST directory on screen, because the directories
    // sort in reverse. That is the point: display position 0 and changeset
    // index 119 are different numbers, and `aria-current` has to follow the
    // second one. (Revealing a genuinely off-screen row is not asserted here —
    // Virtuoso's scroll path needs a scroller with a real height, and jsdom
    // gives every element zero.)
    const files = reversedGroups(120);
    renderWindowed(files, 119);
    const current = screen
      .getAllByTestId("diff-sidebar-file")
      .find((row) => row.getAttribute("aria-current") === "true");
    expect(current?.getAttribute("aria-label")).toBe(`Open ${files[119]!.path}`);
  });

  it("still filters, and falls back to every row when the filter narrows it", () => {
    renderWindowed(reversedGroups(120), 0);
    fireEvent.change(screen.getByTestId("diff-sidebar-filter"), {
      target: { value: "file-0001." },
    });
    const rows = screen.getAllByTestId("diff-sidebar-file");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("aria-label")).toContain("file-0001.ts");
  });

  it("lays its rows out in slot space, group headers included", () => {
    // The premise every reveal assertion below rests on, taken from the real
    // virtualizer rather than from the docs: the slots react-virtuoso indexes
    // COUNT the group headers, so the first file sits at slot 1, not slot 0.
    const { container } = renderWindowed(groupedFiles(), 0);
    const slots = Array.from(container.querySelectorAll<HTMLElement>("[data-index]"));
    const firstFileSlot = slots.find((slot) => slot.querySelector("[data-file-index]"));
    expect(firstFileSlot?.getAttribute("data-index")).toBe(String(slotOf(0)));
  });

  it("reveals the open file by its flat slot index, not its file-only index", () => {
    // File 95 is the sixth file of the tenth directory: ten group headers sit
    // ahead of it, so its slot is 105 while its position among the files is 95.
    // Handing the handle 95 scrolls ten rows short of the row the user opened.
    const target = 95;
    renderWindowed(groupedFiles(), target);

    expect(scrollIntoViewMock).toHaveBeenCalled();
    expect(scrollIntoViewMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: slotOf(target) })
    );
    expect(slotOf(target)).toBe(105);
  });

  it("counts the header ahead of even the first file when it reveals it", () => {
    // The smallest version of the same mistake, and the one an off-by-"a few
    // headers" test can still pass through: file 0 is slot 1.
    renderWindowed(groupedFiles(), 0);

    expect(scrollIntoViewMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 1, behavior: "auto" })
    );
  });

  it("re-reveals in slot space after a filter renumbers the groups", () => {
    // A filter rebuilds the groups, so the slot has to be rebuilt with them
    // rather than carried over from the unfiltered list.
    const target = 155;
    renderWindowed(groupedFiles(), target);
    expect(scrollIntoViewMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: slotOf(target) })
    );
    scrollIntoViewMock.mockClear();

    // Keeps g10..g19 — a hundred files, still windowed — and drops the ten
    // directories ahead of them. The target is then the sixth file of the sixth
    // surviving group: display index 55, six headers ahead of it, slot 61.
    fireEvent.change(screen.getByTestId("diff-sidebar-filter"), {
      target: { value: "src/g1" },
    });

    expect(scrollIntoViewMock).toHaveBeenLastCalledWith(expect.objectContaining({ index: 61 }));
  });
});
