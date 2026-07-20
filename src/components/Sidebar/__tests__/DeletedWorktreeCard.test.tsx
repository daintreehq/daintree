// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: ReactNode }) => <>{children}</>,
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

vi.mock("@/components/DragDrop/SortableWorktreeTerminal", () => ({
  SortableWorktreeTerminal: ({ children }: { children: ReactNode }) => <>{children}</>,
  getAccordionDragId: (id: string) => `accordion-${id}`,
}));

vi.mock("@/components/Terminal/TerminalIcon", () => ({
  TerminalIcon: ({ className }: { className?: string }) => (
    <svg data-testid="terminal-row-icon" className={className} />
  ),
}));

import { usePanelStore } from "@/store/panelStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useTerminalPendingDestructiveActionStore } from "@/store/terminalPendingDestructiveActionStore";
import { useWorktreeSelectionStore, type DeletedWorktree } from "@/store/worktreeStore";
import { TooltipProvider } from "@/components/ui/tooltip";
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

function renderCard(wt: DeletedWorktree = worktree) {
  return render(
    <TooltipProvider>
      <DeletedWorktreeCard worktree={wt} />
    </TooltipProvider>
  );
}

const worktree: DeletedWorktree = {
  id: "wt-1",
  title: "feature/login",
  path: "/repo/feature-login",
  deletedAt: 1000,
  expiresAt: null,
  pinnedIndex: 2,
};

const originalSelectWorktree = useWorktreeSelectionStore.getState().selectWorktree;

beforeEach(() => {
  cleanup();
  useTerminalPendingDestructiveActionStore.getState().clear();
  useWorktreeSelectionStore.getState().reset();
  // reset() restores data fields only — undo any per-test action override.
  useWorktreeSelectionStore.setState({ selectWorktree: originalSelectWorktree });
  usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: 60 });
  setPanels([]);
});

describe("DeletedWorktreeCard", () => {
  it("shows the last-known title, path, and Deleted badge", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    renderCard();

    expect(screen.getByText("feature/login")).toBeTruthy();
    expect(screen.getByText("Deleted")).toBeTruthy();
    expect(screen.getByText("/repo/feature-login")).toBeTruthy();
  });

  it("shows the live-card terminal summary bar instead of instructional copy", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-1" },
    ]);
    renderCard();

    expect(screen.queryByText("Drag terminals to another worktree")).toBeNull();
    // Collapsed WorktreeTerminalSection: count + "active" label, same as live cards.
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();
  });

  it("lists surviving terminals when the sessions section is expanded", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1", title: "claude" },
      { id: "t2", worktreeId: "wt-1", title: "shell" },
    ]);
    useWorktreeSelectionStore.getState().toggleTerminalsExpanded("wt-1");
    renderCard();

    expect(screen.getByText("claude")).toBeTruthy();
    expect(screen.getByText("shell")).toBeTruthy();
  });

  it("selects the deleted worktree when the card is clicked", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    const selectWorktree = vi.fn();
    useWorktreeSelectionStore.setState({ selectWorktree });
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Select deleted worktree: feature/login" }));

    // Session-only selection: a ghost id must never become the persisted
    // restore target (deletedWorktrees does not survive restarts).
    expect(selectWorktree).toHaveBeenCalledWith("wt-1", { source: "focus" });
  });

  it("shows the auto-cleanup countdown bar when a deadline is armed", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    const { container } = renderCard({ ...worktree, expiresAt: Date.now() + 60_000 });

    expect(container.querySelector("[data-testid='deleted-worktree-countdown']")).toBeTruthy();
  });

  it("shows the seconds readout next to the close button while armed", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    const { container } = renderCard({ ...worktree, expiresAt: Date.now() + 60_000 });

    const readout = container.querySelector("[data-testid='deleted-worktree-countdown-seconds']");
    expect(readout?.textContent).toMatch(/^\d+s$/);
  });

  it("hides the countdown bar while auto-cleanup is off or the row is unarmed", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    const unarmed = renderCard();
    expect(
      unarmed.container.querySelector("[data-testid='deleted-worktree-countdown']")
    ).toBeNull();
    cleanup();

    usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: 0 });
    const off = renderCard({ ...worktree, expiresAt: Date.now() + 60_000 });
    expect(off.container.querySelector("[data-testid='deleted-worktree-countdown']")).toBeNull();
  });

  it("marks the card active when it is the active worktree", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    const { container } = renderCard();

    expect(
      container.querySelector("[data-deleted-worktree-id='wt-1']")?.getAttribute("data-active")
    ).toBe("true");
  });

  it("omits trashed and overlay panels, matching what dismissing would close", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1", title: "claude" },
      { id: "t2", worktreeId: "wt-1", title: "binned", location: "trash" },
      { id: "t3", worktreeId: "wt-1", title: "assistant", location: "overlay" },
    ]);
    renderCard();

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
    renderCard();

    expect(screen.getByRole("button", { name: "Close 3 terminals" })).toBeTruthy();
  });

  it("requests a confirmation rather than closing terminals immediately", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-1" },
    ]);
    renderCard();

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

  it("does not select the worktree when the dismiss button is clicked", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    const selectWorktree = vi.fn();
    useWorktreeSelectionStore.setState({ selectWorktree });
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Close 1 terminal" }));

    expect(selectWorktree).not.toHaveBeenCalled();
  });

  it("renders nothing once no terminals remain", () => {
    setPanels([{ id: "t1", worktreeId: "other" }]);
    const { container } = renderCard();

    expect(container.firstChild).toBeNull();
  });

  it("exposes no drop-target data, so terminals can never be dropped onto it", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1" }]);
    const { container } = renderCard();

    // The card is identified by its own attribute and must not advertise the
    // worktree drop payload DndProvider gates on.
    expect(container.querySelector("[data-deleted-worktree-id='wt-1']")).toBeTruthy();
    expect(container.querySelector("[data-worktree-drop-target]")).toBeNull();
  });
});
