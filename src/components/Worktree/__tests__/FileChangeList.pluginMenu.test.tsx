/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import type { FileChangeDetail } from "../../../types";
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

const { itemsRef } = vi.hoisted(() => ({
  itemsRef: { current: [] as PluginContextMenuItemEntry[] },
}));
vi.mock("@/hooks/usePluginContextMenuItems", () => ({
  usePluginContextMenuItems: () => itemsRef.current,
}));

// The insert target is resolved from panel/typing state this suite doesn't
// stand up; the menu item's enabled/disabled branch is covered in the hook's
// own suite.
vi.mock("@/hooks/useInsertFileReference", () => ({
  useInsertFileReference: () => ({ canInsert: false, insert: () => false }),
}));

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import { FileChangeList } from "../FileChangeList";

const ROOT = "/repo";
const WORKTREE_SENTINEL = "Worktree menu sentinel";

function file(path: string, status: FileChangeDetail["status"] = "modified"): FileChangeDetail {
  return { path, status, insertions: 1, deletions: 0 };
}

function fileItem(actionId: string): PluginContextMenuItemEntry {
  return { pluginId: "acme", item: { label: "Open with Acme", actionId, location: "file" } };
}

/**
 * The worktree card's shape, reduced to what the bug is about: one card-wide
 * trigger with the worktree menu as its content, and the changed-files list
 * rendered inside it. Anything the list fails to claim opens the sentinel.
 */
function renderInWorktreeCard(props: Partial<React.ComponentProps<typeof FileChangeList>> = {}) {
  // Real tooltip primitives, not stubs: the row's `data-state` has to survive a
  // real `TooltipTrigger` sitting between the context-menu trigger and the row,
  // and a stubbed tooltip is exactly what hid that from the old suite.
  return render(
    <TooltipProvider>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div data-testid="card">
            <FileChangeList changes={[file("src/index.ts")]} rootPath={ROOT} {...props} />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>{WORKTREE_SENTINEL}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </TooltipProvider>
  );
}

// Radix is behind a dynamic import; priming it once up front means the very
// first right-click in each test has real primitives to open.
beforeAll(async () => {
  await primeRadix();
});

beforeEach(() => {
  dispatchMock.mockClear();
  itemsRef.current = [];
});

afterEach(() => cleanup());

describe("FileChangeList — the file row owns its menu", () => {
  it("opens the file menu, not the worktree menu, with zero plugins installed", async () => {
    // The regression guard for #11757. The row used to render no trigger at
    // all without a plugin, so the contextmenu bubbled to the card.
    renderInWorktreeCard();

    const row = screen.getByRole("button", { name: "Open src/index.ts" });
    fireEvent.contextMenu(row);

    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Open file/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /Copy path/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: WORKTREE_SENTINEL })).toBeNull();
  });

  it("marks the row its open menu targets", async () => {
    renderInWorktreeCard();

    const row = screen.getByRole("button", { name: "Open src/index.ts" });
    expect(row.getAttribute("data-state")).toBe("closed");

    fireEvent.contextMenu(row);
    await screen.findByRole("menu");

    // The context menu's state reaches the row even though a tooltip trigger
    // sits between them and writes `data-state` of its own.
    expect(row.getAttribute("data-state")).toBe("open");
  });

  it("opens the file menu on a row in the last folder group", async () => {
    // `zzz` sorts after `src`, so this row is genuinely the second group's —
    // with `bin` it was the FIRST one rendered and the test proved nothing
    // about rows reached after a group reorder.
    renderInWorktreeCard({
      changes: [file("src/a.ts"), file("zzz/b.ts")],
    });

    fireEvent.contextMenu(screen.getByRole("button", { name: "Open zzz/b.ts" }));

    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Open file/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: WORKTREE_SENTINEL })).toBeNull();
  });

  it("leaves a folder group header to the worktree menu", async () => {
    // A group header is a grouping derived from the visible rows, not a
    // filesystem object — it must keep falling through to the card.
    const { container } = renderInWorktreeCard({
      changes: [file("bin/b.ts")],
    });

    const header = container.querySelector("[data-testid='card'] .font-mono");
    expect(header?.textContent).toContain("bin");
    fireEvent.contextMenu(header!);

    expect(await screen.findByRole("menuitem", { name: WORKTREE_SENTINEL })).toBeTruthy();
  });

  it("leaves the '...and N more' line to the worktree menu", async () => {
    renderInWorktreeCard({
      changes: [file("a.ts"), file("b.ts"), file("c.ts")],
      maxVisible: 1,
    });

    const more = screen.getByText(/and 2 more/);
    fireEvent.contextMenu(more);

    expect(await screen.findByRole("menuitem", { name: WORKTREE_SENTINEL })).toBeTruthy();
  });

  it("opens the row's menu from the keyboard with Shift+F10", async () => {
    renderInWorktreeCard();

    const row = screen.getByRole("button", { name: "Open src/index.ts" });
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });

    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Open file/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: WORKTREE_SENTINEL })).toBeNull();
  });
});

describe("FileChangeList — plugin items", () => {
  it("appends plugin items after the built-in core rather than replacing it", async () => {
    itemsRef.current = [fileItem("acme.open")];
    renderInWorktreeCard();

    fireEvent.contextMenu(screen.getByRole("button", { name: "Open src/index.ts" }));
    const menu = await screen.findByRole("menu");

    const items = within(menu).getAllByRole("menuitem");
    const revealIndex = items.findIndex((item) => /Reveal|Show in/.test(item.textContent ?? ""));
    const pluginIndex = items.findIndex((item) => item.textContent === "Open with Acme");

    expect(revealIndex).toBeGreaterThanOrEqual(0);
    // Document order, not a count: the section trails the core wherever the
    // core's own length lands.
    expect(pluginIndex).toBeGreaterThan(revealIndex);
  });

  it("dispatches the clicked file's real absolute path, not undefined", async () => {
    itemsRef.current = [fileItem("acme.open")];
    renderInWorktreeCard({ changes: [file("src/index.ts", "modified")] });

    fireEvent.contextMenu(screen.getByRole("button", { name: "Open src/index.ts" }));
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open with Acme" }));

    const call = dispatchMock.mock.calls.find(([actionId]) => actionId === "acme.open");
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({
      path: "/repo/src/index.ts",
      worktreePath: ROOT,
      status: "modified",
    });
  });

  it("keeps an already-absolute change path absolute in the dispatched args", async () => {
    itemsRef.current = [fileItem("acme.open")];
    renderInWorktreeCard({ changes: [file("/repo/src/abs.ts", "added")] });

    fireEvent.contextMenu(screen.getByRole("button", { name: "Open src/abs.ts" }));
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open with Acme" }));

    const call = dispatchMock.mock.calls.find(([actionId]) => actionId === "acme.open");
    expect(call![1]).toMatchObject({ path: "/repo/src/abs.ts", status: "added" });
  });
});
