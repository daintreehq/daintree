// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorktreeState } from "@shared/types";
import type { PtyPanelData } from "@shared/types/panel";

vi.mock("@/clients/worktreeDiskUsageClient", () => ({
  worktreeDiskUsageClient: {
    measure: vi.fn(() => new Promise(() => {})),
    cancel: vi.fn(async () => {}),
  },
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore, setCurrentViewStore } from "@/store/createWorktreeStore";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { usePanelStore } from "@/store/panelStore";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { WorktreeOverviewModal } from "../WorktreeOverviewModal";

const ROOT = "/repo";
const FEATURE = "/repo-wt-feature";

function makeWorktree(id: string, name: string, isMain: boolean): WorktreeState {
  return {
    id,
    worktreeId: id,
    path: id,
    name,
    branch: isMain ? "develop" : `feature/${name}`,
    isCurrent: isMain,
    isMainWorktree: isMain,
    worktreeChanges: null,
    lastActivityTimestamp: 1_000,
  } as WorktreeState;
}

const main = makeWorktree(ROOT, "repo", true);
const feature = makeWorktree(FEATURE, "feature", false);

function renderModal(worktrees: WorktreeState[]) {
  const store = createWorktreeStore();
  store.setState({ worktrees: new Map(worktrees.map((wt) => [wt.id, wt])) });
  setCurrentViewStore(store);
  const element = (list: WorktreeState[]) => (
    <TooltipProvider>
      <WorktreeStoreContext.Provider value={store}>
        <WorktreeOverviewModal
          isOpen
          onClose={() => {}}
          worktrees={list}
          activeWorktreeId={ROOT}
          onSelectWorktree={() => {}}
        />
      </WorktreeStoreContext.Provider>
    </TooltipProvider>
  );
  const view = render(element(worktrees));
  return { rerender: (list: WorktreeState[]) => view.rerender(element(list)) };
}

function selectAll() {
  fireEvent.keyDown(screen.getByRole("grid"), { key: "a", metaKey: true });
}

function seedPanel(worktreeId: string) {
  const panel = {
    id: "p1",
    kind: "terminal",
    title: "Shell",
    location: "grid",
    worktreeId,
    cwd: worktreeId,
    cols: 80,
    rows: 24,
  } as PtyPanelData;
  act(() =>
    usePanelStore.setState({
      panelsById: { p1: panel },
      panelIds: ["p1"],
      panelIdsByWorktreeId: { [worktreeId]: ["p1"] },
    })
  );
}

const removePanelsButton = () => screen.getByTestId("worktree-bulk-close-sessions");
const deleteButton = () => screen.getByTestId("worktree-bulk-remove");
const isDisabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled;

beforeEach(() => {
  initBuiltInPanelKinds();
  usePanelStore.setState({ panelsById: {}, panelIds: [], panelIdsByWorktreeId: {} });
  useWorktreeFilterStore.getState().clearAll();
});

afterEach(() => {
  cleanup();
  useWorktreeFilterStore.getState().clearAll();
  usePanelStore.setState({ panelsById: {}, panelIds: [], panelIdsByWorktreeId: {} });
});

describe("WorktreeOverviewModal bulk actions (#16890)", () => {
  it("disables Delete worktrees while only the main worktree is selected", () => {
    renderModal([main]);
    selectAll();
    expect(isDisabled(deleteButton())).toBe(true);
  });

  it("enables Delete worktrees once a non-main worktree is selected", () => {
    renderModal([main, feature]);
    selectAll();
    expect(isDisabled(deleteButton())).toBe(false);
  });

  it("disables Remove panels until a selected worktree owns a panel", () => {
    renderModal([main, feature]);
    selectAll();
    expect(isDisabled(removePanelsButton())).toBe(true);
    seedPanel(FEATURE);
    expect(isDisabled(removePanelsButton())).toBe(false);
  });

  it("keeps the quick-state bar reachable when a filter outlives the last non-main worktree", () => {
    const { rerender } = renderModal([main, feature]);
    act(() => useWorktreeFilterStore.getState().setQuickStateFilter("working"));
    expect(screen.queryByRole("radiogroup")).not.toBeNull();
    rerender([main]);
    expect(screen.queryByRole("radiogroup")).not.toBeNull();
    expect(screen.queryByText("No other worktrees to match these filters")).not.toBeNull();
  });

  it("hides the quick-state bar with no non-main worktree and no quick filter", () => {
    renderModal([main]);
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});
