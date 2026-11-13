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

  it("ignores panels and eligibility outside the selection", () => {
    renderModal([main, feature]);
    seedPanel(FEATURE);
    fireEvent.click(document.querySelector(`[data-worktree-overview-cell="${ROOT}"]`)!, {
      metaKey: true,
    });
    expect(isDisabled(removePanelsButton())).toBe(true);
    expect(isDisabled(deleteButton())).toBe(true);
  });

  it("confirms Remove panels as a destructive action", () => {
    renderModal([main, feature]);
    seedPanel(FEATURE);
    selectAll();
    fireEvent.click(removePanelsButton());
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("Remove panels for 2 worktrees?")).toBeTruthy();
  });

  it("lets the stranded quick filter be cleared from the bar or the empty state", () => {
    const { rerender } = renderModal([main, feature]);
    act(() => useWorktreeFilterStore.getState().setQuickStateFilter("working"));
    expect(screen.queryByText("No worktrees match these filters")).not.toBeNull();
    rerender([main]);
    expect(screen.queryByRole("radiogroup")).not.toBeNull();
    expect(screen.queryByText("No other worktrees to match these filters")).not.toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /^All/ }));
    expect(useWorktreeFilterStore.getState().quickStateFilter).toBe("all");
    expect(document.querySelector(`[data-worktree-overview-cell="${ROOT}"]`)).not.toBeNull();
  });

  it("clears the stranded quick filter from the empty state's recovery button", () => {
    const { rerender } = renderModal([main, feature]);
    act(() => useWorktreeFilterStore.getState().setQuickStateFilter("working"));
    rerender([main]);
    fireEvent.click(screen.getByRole("button", { name: "Clear all filters" }));
    expect(useWorktreeFilterStore.getState().quickStateFilter).toBe("all");
    expect(document.querySelector(`[data-worktree-overview-cell="${ROOT}"]`)).not.toBeNull();
  });

  it("hides the quick-state bar with no non-main worktree and no quick filter", () => {
    renderModal([main]);
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});
