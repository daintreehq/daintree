// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";

vi.mock("@/components/ui/ScrollShadow", () => ({
  ScrollShadow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/animationUtils", () => ({
  UI_ENTER_DURATION: 0,
  UI_EXIT_DURATION: 0,
  UI_ENTER_EASING: "linear",
  UI_EXIT_EASING: "linear",
  getUiTransitionDuration: () => 0,
}));

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

import { FleetArmingDialog } from "../FleetArmingDialog";
import { usePanelStore } from "@/store/panelStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { _resetForTests as resetEscapeStack, dispatchEscape } from "@/lib/escapeStack";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore } from "@/store/createWorktreeStore";
import type { TerminalInstance, WorktreeSnapshot } from "@shared/types";

function makeTerminal(id: string, overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id,
    title: id,
    kind: "terminal",
    worktreeId: "wt-1",
    location: "grid",
    hasPty: true,
    agentState: "idle",
    runtimeStatus: "running",
    ...overrides,
  } as TerminalInstance;
}

function seedTerminals(terminals: TerminalInstance[]): void {
  const panelsById: Record<string, TerminalInstance> = {};
  const panelIds: string[] = [];
  for (const t of terminals) {
    panelsById[t.id] = t;
    panelIds.push(t.id);
  }
  usePanelStore.setState({ panelsById, panelIds });
}

function makeWorktreeSnap(id: string, name: string): WorktreeSnapshot {
  return {
    id,
    worktreeId: id,
    path: `/repo/${id}`,
    name,
    isCurrent: false,
  } as WorktreeSnapshot;
}

function renderDialog(
  worktrees: WorktreeSnapshot[],
  isOpen = true,
  onClose: () => void = () => {}
) {
  const store = createWorktreeStore();
  store.getState().applySnapshot(worktrees, 1);
  return render(
    <WorktreeStoreContext.Provider value={store}>
      <FleetArmingDialog isOpen={isOpen} onClose={onClose} />
    </WorktreeStoreContext.Provider>
  );
}

function resetStores(): void {
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
    previewArmedIds: new Set<string>(),
    broadcastSignal: 0,
  });
  usePanelStore.setState({ panelsById: {}, panelIds: [], focusedId: null });
  resetEscapeStack();
}

describe("FleetArmingDialog", () => {
  beforeEach(() => {
    resetStores();
  });

  it("does not render when closed", () => {
    seedTerminals([makeTerminal("a"), makeTerminal("b")]);
    renderDialog([makeWorktreeSnap("wt-1", "Main")], false);
    expect(screen.queryByTestId("fleet-arming-dialog")).toBeNull();
  });

  it("renders only fleet-eligible terminals", () => {
    seedTerminals([
      makeTerminal("alpha", { title: "alpha" }),
      makeTerminal("beta", { title: "beta" }),
      makeTerminal("trash-row", { title: "trashed", location: "trash" }),
      makeTerminal("nopty", { title: "no-pty", hasPty: false }),
      makeTerminal("exited", { title: "exited", runtimeStatus: "exited" }),
    ]);
    renderDialog([makeWorktreeSnap("wt-1", "Main")]);
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText("beta")).toBeTruthy();
    expect(screen.queryByText("trashed")).toBeNull();
    expect(screen.queryByText("no-pty")).toBeNull();
    expect(screen.queryByText("exited")).toBeNull();
  });

  it("shows empty state when there are no eligible terminals", () => {
    renderDialog([makeWorktreeSnap("wt-1", "Main")]);
    expect(screen.getByText("No terminals available")).toBeTruthy();
  });

  it("shows different empty state when search/chip yields no matches", () => {
    seedTerminals([makeTerminal("alpha", { title: "alpha" })]);
    renderDialog([makeWorktreeSnap("wt-1", "Main")]);
    const search = screen.getByTestId("fleet-arming-dialog-search") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "zzzzz" } });
    expect(screen.getByText("No terminals match")).toBeTruthy();
  });

  it("toggling a terminal checkbox updates the confirm button label", () => {
    seedTerminals([makeTerminal("a", { title: "alpha" }), makeTerminal("b", { title: "beta" })]);
    renderDialog([makeWorktreeSnap("wt-1", "Main")]);
    expect(screen.getByText("Arm selected")).toBeTruthy();
    const alphaCheckbox = screen.getByLabelText("Select alpha");
    fireEvent.click(alphaCheckbox);
    expect(screen.getByText("Arm 1 selected")).toBeTruthy();
  });

  it("confirm button is disabled when nothing is selected", () => {
    seedTerminals([makeTerminal("a")]);
    renderDialog([makeWorktreeSnap("wt-1", "Main")]);
    const confirm = screen.getByText("Arm selected").closest("button") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it("confirm calls armIds with selected ids and invokes onClose", () => {
    seedTerminals([
      makeTerminal("a", { title: "alpha" }),
      makeTerminal("b", { title: "beta" }),
      makeTerminal("c", { title: "gamma" }),
    ]);
    const onClose = vi.fn();
    renderDialog([makeWorktreeSnap("wt-1", "Main")], true, onClose);
    fireEvent.click(screen.getByLabelText("Select alpha"));
    fireEvent.click(screen.getByLabelText("Select gamma"));
    fireEvent.click(screen.getByText("Arm 2 selected"));
    expect(useFleetArmingStore.getState().armOrder).toEqual(["a", "c"]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cancel does not call armIds", () => {
    seedTerminals([makeTerminal("a"), makeTerminal("b")]);
    const onClose = vi.fn();
    renderDialog([makeWorktreeSnap("wt-1", "Main")], true, onClose);
    fireEvent.click(screen.getByLabelText("Select a"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("waiting chip filters the visible list to waiting agents only", () => {
    seedTerminals([
      makeTerminal("a", { title: "alpha", agentState: "waiting" }),
      makeTerminal("b", { title: "beta", agentState: "working" }),
      makeTerminal("c", { title: "gamma", agentState: "idle" }),
    ]);
    renderDialog([makeWorktreeSnap("wt-1", "Main")]);
    fireEvent.click(screen.getByTestId("fleet-arming-dialog-chip-waiting"));
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.queryByText("beta")).toBeNull();
    expect(screen.queryByText("gamma")).toBeNull();
  });

  it("chip does not mutate selection — only filters the visible list", () => {
    seedTerminals([
      makeTerminal("a", { title: "alpha", agentState: "waiting" }),
      makeTerminal("b", { title: "beta", agentState: "working" }),
    ]);
    renderDialog([makeWorktreeSnap("wt-1", "Main")]);
    fireEvent.click(screen.getByLabelText("Select alpha"));
    expect(screen.getByText("Arm 1 selected")).toBeTruthy();
    fireEvent.click(screen.getByTestId("fleet-arming-dialog-chip-working"));
    // alpha is still selected even though it's not visible
    expect(screen.getByText("Arm 1 selected")).toBeTruthy();
    expect(screen.queryByText("alpha")).toBeNull();
    expect(screen.getByText("beta")).toBeTruthy();
  });

  it("search filters by title and worktree name", () => {
    seedTerminals([
      makeTerminal("a", { title: "build-server", worktreeId: "wt-1" }),
      makeTerminal("b", { title: "test-runner", worktreeId: "wt-2" }),
    ]);
    renderDialog([
      makeWorktreeSnap("wt-1", "feature-foo"),
      makeWorktreeSnap("wt-2", "feature-bar"),
    ]);
    const search = screen.getByTestId("fleet-arming-dialog-search") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "build" } });
    expect(screen.getByText("build-server")).toBeTruthy();
    expect(screen.queryByText("test-runner")).toBeNull();
    // search by worktree name
    fireEvent.change(search, { target: { value: "feature-bar" } });
    expect(screen.queryByText("build-server")).toBeNull();
    expect(screen.getByText("test-runner")).toBeTruthy();
  });

  it("Cmd+A on the list selects only currently visible terminals", () => {
    seedTerminals([
      makeTerminal("a", { title: "alpha", agentState: "waiting" }),
      makeTerminal("b", { title: "beta", agentState: "working" }),
      makeTerminal("c", { title: "gamma", agentState: "waiting" }),
    ]);
    renderDialog([makeWorktreeSnap("wt-1", "Main")]);
    fireEvent.click(screen.getByTestId("fleet-arming-dialog-chip-waiting"));
    const list = screen.getByTestId("fleet-arming-dialog-list");
    fireEvent.keyDown(list, { key: "a", metaKey: true });
    expect(screen.getByText("Arm 2 selected")).toBeTruthy();
  });

  it("worktree group header click selects all visible terminals in that group", () => {
    seedTerminals([
      makeTerminal("a", { title: "alpha", worktreeId: "wt-1" }),
      makeTerminal("b", { title: "beta", worktreeId: "wt-1" }),
      makeTerminal("c", { title: "gamma", worktreeId: "wt-2" }),
    ]);
    renderDialog([makeWorktreeSnap("wt-1", "Main"), makeWorktreeSnap("wt-2", "Other")]);
    fireEvent.click(screen.getByLabelText("Select all 2 terminals in Main"));
    expect(screen.getByText("Arm 2 selected")).toBeTruthy();
  });

  it("worktree group header click when partially selected deselects all in group (safe reset)", () => {
    seedTerminals([
      makeTerminal("a", { title: "alpha", worktreeId: "wt-1" }),
      makeTerminal("b", { title: "beta", worktreeId: "wt-1" }),
      makeTerminal("c", { title: "gamma", worktreeId: "wt-2" }),
    ]);
    renderDialog([makeWorktreeSnap("wt-1", "Main"), makeWorktreeSnap("wt-2", "Other")]);
    fireEvent.click(screen.getByLabelText("Select alpha"));
    // Group "Main" is now indeterminate (1/2 selected). Header click should deselect both.
    fireEvent.click(screen.getByLabelText("Select all 2 terminals in Main"));
    expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
    expect(screen.queryByText(/Arm \d/)).toBeNull();
    expect(screen.getByText("Arm selected")).toBeTruthy();
  });

  it("worktree group header is hidden when there is only one group", () => {
    seedTerminals([
      makeTerminal("a", { title: "alpha", worktreeId: "wt-1" }),
      makeTerminal("b", { title: "beta", worktreeId: "wt-1" }),
    ]);
    renderDialog([makeWorktreeSnap("wt-1", "Main")]);
    expect(screen.queryByTestId("fleet-arming-dialog-group-wt-1")).toBeNull();
  });

  it("first Esc clears search; second Esc closes dialog", () => {
    seedTerminals([makeTerminal("a", { title: "alpha" })]);
    const onClose = vi.fn();
    renderDialog([makeWorktreeSnap("wt-1", "Main")], true, onClose);
    const search = screen.getByTestId("fleet-arming-dialog-search") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(search.value).toBe("zzz");
    act(() => {
      dispatchEscape();
    });
    expect((screen.getByTestId("fleet-arming-dialog-search") as HTMLInputElement).value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      dispatchEscape();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ineligible selected ids are filtered out at confirm time", () => {
    seedTerminals([makeTerminal("a", { title: "alpha" }), makeTerminal("b", { title: "beta" })]);
    const onClose = vi.fn();
    renderDialog([makeWorktreeSnap("wt-1", "Main")], true, onClose);
    fireEvent.click(screen.getByLabelText("Select alpha"));
    fireEvent.click(screen.getByLabelText("Select beta"));
    // Drop beta from the panel store before confirming.
    act(() => {
      const state = usePanelStore.getState();
      const next = { ...state.panelsById };
      delete next.b;
      usePanelStore.setState({ panelsById: next, panelIds: ["a"] });
    });
    fireEvent.click(screen.getByText("Arm 1 selected"));
    expect(useFleetArmingStore.getState().armOrder).toEqual(["a"]);
  });

  it("confirm replaces (not extends) the existing armed set", () => {
    seedTerminals([makeTerminal("a", { title: "alpha" }), makeTerminal("b", { title: "beta" })]);
    useFleetArmingStore.getState().armIds(["old"]);
    expect(useFleetArmingStore.getState().armOrder).toEqual(["old"]);
    renderDialog([makeWorktreeSnap("wt-1", "Main")]);
    fireEvent.click(screen.getByLabelText("Select beta"));
    fireEvent.click(screen.getByText("Arm 1 selected"));
    expect(useFleetArmingStore.getState().armOrder).toEqual(["b"]);
    expect(useFleetArmingStore.getState().armedIds.has("old")).toBe(false);
  });

  it("group header stays visible when a chip filters all but one group", () => {
    seedTerminals([
      makeTerminal("a", { title: "alpha", worktreeId: "wt-1", agentState: "waiting" }),
      makeTerminal("b", { title: "beta", worktreeId: "wt-2", agentState: "working" }),
    ]);
    renderDialog([makeWorktreeSnap("wt-1", "Main"), makeWorktreeSnap("wt-2", "Other")]);
    fireEvent.click(screen.getByTestId("fleet-arming-dialog-chip-waiting"));
    // Only Main has waiting terminals; its header must remain visible so the
    // user knows which worktree the row belongs to.
    expect(screen.getByTestId("fleet-arming-dialog-group-wt-1")).toBeTruthy();
  });

  it("excludes background and error-status terminals", () => {
    seedTerminals([
      makeTerminal("a", { title: "alpha" }),
      makeTerminal("bg", { title: "background", location: "background" }),
      makeTerminal("err", { title: "errored", runtimeStatus: "error" }),
    ]);
    renderDialog([makeWorktreeSnap("wt-1", "Main")]);
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.queryByText("background")).toBeNull();
    expect(screen.queryByText("errored")).toBeNull();
  });

  it("terminals without a worktreeId fall under 'Unassigned' and search hits the fallback name", () => {
    seedTerminals([
      makeTerminal("orphan", { title: "homeless", worktreeId: undefined }),
      makeTerminal("a", { title: "alpha", worktreeId: "wt-1" }),
    ]);
    renderDialog([makeWorktreeSnap("wt-1", "Main")]);
    expect(screen.getByText("Unassigned")).toBeTruthy();
    const search = screen.getByTestId("fleet-arming-dialog-search") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "unassigned" } });
    expect(screen.getByText("homeless")).toBeTruthy();
    expect(screen.queryByText("alpha")).toBeNull();
  });

  it("group safe-reset clears only that group, not other groups", () => {
    seedTerminals([
      makeTerminal("a", { title: "alpha", worktreeId: "wt-1" }),
      makeTerminal("b", { title: "beta", worktreeId: "wt-1" }),
      makeTerminal("c", { title: "gamma", worktreeId: "wt-2" }),
    ]);
    renderDialog([makeWorktreeSnap("wt-1", "Main"), makeWorktreeSnap("wt-2", "Other")]);
    fireEvent.click(screen.getByLabelText("Select alpha"));
    fireEvent.click(screen.getByLabelText("Select gamma"));
    expect(screen.getByText("Arm 2 selected")).toBeTruthy();
    // Click Main's header (indeterminate: 1/2 selected) — should deselect Main only.
    fireEvent.click(screen.getByLabelText("Select all 2 terminals in Main"));
    expect(screen.getByText("Arm 1 selected")).toBeTruthy();
  });
});
