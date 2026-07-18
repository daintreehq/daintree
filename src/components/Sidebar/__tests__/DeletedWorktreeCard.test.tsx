// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  verticalListSortingStrategy: {},
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    setActivatorNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

import { usePanelStore } from "@/store/panelStore";
import { useTerminalPendingDestructiveActionStore } from "@/store/terminalPendingDestructiveActionStore";
import { useWorktreeSelectionStore, type DeletedWorktree } from "@/store/worktreeStore";
import { DeletedWorktreeCard } from "../DeletedWorktreeCard";

function setPanels(
  entries: Array<{ id: string; worktreeId: string; location?: string; title?: string }>
): void {
  const panelsById: Record<string, unknown> = {};
  const panelIdsByWorktreeId: Record<string, string[]> = {};
  for (const entry of entries) {
    panelsById[entry.id] = {
      id: entry.id,
      kind: "terminal",
      title: entry.title ?? entry.id,
      worktreeId: entry.worktreeId,
      location: entry.location ?? "grid",
    };
    const bucket = panelIdsByWorktreeId[entry.worktreeId];
    if (bucket) bucket.push(entry.id);
    else panelIdsByWorktreeId[entry.worktreeId] = [entry.id];
  }
  usePanelStore.setState({
    panelIds: entries.map((e) => e.id),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    panelsById: panelsById as never,
    panelIdsByWorktreeId,
  });
}

const worktree: DeletedWorktree = {
  id: "wt-1",
  title: "feature/login",
  path: "/repo/feature-login",
  deletedAt: 1000,
  pinnedIndex: 2,
};

beforeEach(() => {
  cleanup();
  useTerminalPendingDestructiveActionStore.getState().clear();
  useWorktreeSelectionStore.getState().reset();
  setPanels([]);
});

describe("DeletedWorktreeCard", () => {
  it("shows the last-known title, struck-through path, and Deleted badge", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    render(<DeletedWorktreeCard worktree={worktree} />);

    expect(screen.getByText("feature/login")).toBeTruthy();
    expect(screen.getByText("Deleted")).toBeTruthy();
    const path = screen.getByText("/repo/feature-login");
    expect(path.className).toContain("line-through");
  });

  it("tells the user the one thing they can do with the terminals", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    render(<DeletedWorktreeCard worktree={worktree} />);

    expect(screen.getByText("Drag terminals to another worktree")).toBeTruthy();
  });

  it("renders a row per surviving terminal", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1", title: "claude" },
      { id: "t2", worktreeId: "wt-1", title: "shell" },
    ]);
    render(<DeletedWorktreeCard worktree={worktree} />);

    expect(screen.getByText("claude")).toBeTruthy();
    expect(screen.getByText("shell")).toBeTruthy();
  });

  it("omits trashed and overlay panels, matching what dismissing would close", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1", title: "claude" },
      { id: "t2", worktreeId: "wt-1", title: "binned", location: "trash" },
      { id: "t3", worktreeId: "wt-1", title: "assistant", location: "overlay" },
    ]);
    render(<DeletedWorktreeCard worktree={worktree} />);

    expect(screen.queryByText("binned")).toBeNull();
    expect(screen.queryByText("assistant")).toBeNull();
    expect(screen.getByRole("button", { name: "Close 1 terminal" })).toBeTruthy();
  });

  it("names the live terminal count on the dismiss button", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-1" },
      { id: "t3", worktreeId: "wt-1" },
    ]);
    render(<DeletedWorktreeCard worktree={worktree} />);

    expect(screen.getByRole("button", { name: "Close 3 terminals" })).toBeTruthy();
  });

  it("requests a confirmation rather than closing terminals immediately", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-1" },
    ]);
    render(<DeletedWorktreeCard worktree={worktree} />);

    fireEvent.click(screen.getByRole("button", { name: "Close 2 terminals" }));

    // Destructive tier D1: the click must only stage a confirm, never trash.
    const pending = useTerminalPendingDestructiveActionStore.getState().pending;
    expect(pending).toMatchObject({
      kind: "deletedWorktreeDismiss",
      targetCount: 2,
      worktreeId: "wt-1",
    });
    expect(usePanelStore.getState().panelsById["t1"]).toBeDefined();
  });

  it("renders nothing once no terminals remain", () => {
    setPanels([{ id: "t1", worktreeId: "other" }]);
    const { container } = render(<DeletedWorktreeCard worktree={worktree} />);

    expect(container.firstChild).toBeNull();
  });

  it("exposes no drop-target data, so terminals can never be dropped onto it", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    const { container } = render(<DeletedWorktreeCard worktree={worktree} />);

    // The card is identified by its own attribute and must not advertise the
    // worktree drop payload DndProvider gates on.
    expect(container.querySelector("[data-deleted-worktree-id='wt-1']")).toBeTruthy();
    expect(container.querySelector("[data-worktree-drop-target]")).toBeNull();
  });
});
