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
  useInsertFileReference: () => ({ canInsert: false, insert: () => false }),
}));

const { itemsRef } = vi.hoisted(() => ({
  itemsRef: { current: [] as PluginContextMenuItemEntry[] },
}));
vi.mock("@/hooks/usePluginContextMenuItems", () => ({
  usePluginContextMenuItems: () => itemsRef.current,
}));

vi.mock("@/store/diffViewedStore", () => ({
  useDiffViewedStore: (selector?: (state: unknown) => unknown) => {
    const state = { toggleViewed: () => {} };
    return selector ? selector(state) : state;
  },
  selectViewedSet: () => new Set<string>(),
}));

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

beforeAll(async () => {
  await primeRadix();
});

beforeEach(() => {
  dispatchMock.mockClear();
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
    expect(within(menu).getByRole("menuitem", { name: /Copy path/ })).toBeTruthy();
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

    expect(within(menu).queryByRole("menuitem", { name: "Copy context" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: /Copy path/ })).toBeTruthy();
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
    expect(screen.queryByRole("menuitem", { name: /Copy path/ })).toBeNull();
  });

  it("carries plugin file items onto this surface too", async () => {
    itemsRef.current = [
      { pluginId: "acme", item: { label: "Acme thing", actionId: "acme.do", location: "file" } },
    ];
    renderSidebar();

    fireEvent.contextMenu(screen.getByTestId("diff-sidebar-file").parentElement!);
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Acme thing" }));

    const call = dispatchMock.mock.calls.find(([id]) => id === "acme.do");
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({ path: "/repo/src/index.ts", worktreePath: WORKTREE });
  });
});
