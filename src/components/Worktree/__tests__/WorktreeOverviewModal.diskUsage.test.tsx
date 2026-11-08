// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorktreeState } from "@shared/types";
import type {
  WorktreeDiskUsageMeasureRequest,
  WorktreeDiskUsageResult,
} from "@shared/types/ipc/worktreeDiskUsage";

const clientMock = vi.hoisted(() => ({
  measure: vi.fn<(request: WorktreeDiskUsageMeasureRequest) => Promise<WorktreeDiskUsageResult>>(),
  cancel: vi.fn(async () => {}),
}));

vi.mock("@/clients/worktreeDiskUsageClient", () => ({ worktreeDiskUsageClient: clientMock }));

import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { WorktreeOverviewModal } from "../WorktreeOverviewModal";

const ROOT = "/repo";

function makeWorktree(id: string, name: string, lastActivityTimestamp: number): WorktreeState {
  return {
    id,
    worktreeId: id,
    path: id,
    name,
    branch: id === ROOT ? "develop" : `feature/${name}`,
    isCurrent: id === ROOT,
    isMainWorktree: id === ROOT,
    worktreeChanges: null,
    lastActivityTimestamp,
  } as WorktreeState;
}

const worktrees = [
  makeWorktree(ROOT, "repo", 4_000),
  makeWorktree(`${ROOT}-wt-small`, "small", 3_000),
  makeWorktree(`${ROOT}-wt-big`, "big", 2_000),
  makeWorktree(`${ROOT}-wt-pending`, "pending", 1_000),
];

const SIZES: Record<string, number> = {
  [ROOT]: 500,
  [`${ROOT}-wt-small`]: 10,
  [`${ROOT}-wt-big`]: 9_000,
};

function renderedOrder(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-worktree-overview-cell]")).map(
    (el) => el.dataset.worktreeOverviewCell!
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  initBuiltInPanelKinds();
  clientMock.measure.mockReset().mockImplementation(({ worktreeId }) => {
    const bytes = SIZES[worktreeId];
    // The pending worktree's scan never finishes while the test looks.
    if (bytes === undefined) return new Promise(() => {});
    return Promise.resolve({ status: "measured", bytes } as const);
  });
  clientMock.cancel.mockClear();
  const store = createWorktreeStore();
  store.setState({ worktrees: new Map(worktrees.map((wt) => [wt.id, wt])) });
  setCurrentViewStore(store);
  useWorktreeFilterStore.getState().setGroupByType(true);
  render(
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={store}>
        <WorktreeOverviewModal
          isOpen
          onClose={() => {}}
          worktrees={worktrees}
          activeWorktreeId={ROOT}
          onSelectWorktree={() => {}}
        />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
});

afterEach(() => {
  cleanup();
  useWorktreeFilterStore.getState().setGroupByType(false);
});

describe("WorktreeOverviewModal ordered by size (#16393)", () => {
  it("measures every worktree on open and cancels the pass on close", async () => {
    await settle();
    expect(clientMock.measure.mock.calls.map(([r]) => r.worktreeId).sort()).toEqual(
      worktrees.map((w) => w.id).sort()
    );
    const sessionId = clientMock.measure.mock.calls[0]?.[0].sessionId;
    expect(sessionId).toBeTruthy();
    cleanup();
    await settle();
    expect(clientMock.cancel).toHaveBeenCalledWith({ sessionId });
  });

  it("orders the rows largest first, measuring rows last, and the keyboard follows", async () => {
    await settle();
    const sharedOrder = renderedOrder();
    expect(document.querySelectorAll('[role="presentation"]').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Order by size, largest first" }));
    await settle();

    expect(renderedOrder()).toEqual([
      `${ROOT}-wt-big`,
      ROOT,
      `${ROOT}-wt-small`,
      `${ROOT}-wt-pending`,
    ]);
    // Grouping gives way while sizes order the list.
    expect(document.querySelectorAll('[role="presentation"]').length).toBe(0);

    const grid = screen.getByRole("grid");
    grid.focus();
    fireEvent.keyDown(grid, { key: "Home" });
    await settle();
    const cursor = grid.getAttribute("aria-activedescendant");
    expect(cursor && document.getElementById(cursor)?.dataset.worktreeOverviewCell).toBe(
      `${ROOT}-wt-big`
    );

    fireEvent.click(screen.getByRole("button", { name: "Order by size, largest first" }));
    await settle();
    expect(renderedOrder()).toEqual(sharedOrder);
  });
});
