// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

type SearchFn = (
  query: string,
  isRegex: boolean
) => Promise<Array<{ terminalId: string; line: string; matchStart: number; matchEnd: number }>>;

function installElectronMock(searchFn: SearchFn): void {
  (window as unknown as { electron: unknown }).electron = {
    terminal: { searchSemanticBuffers: searchFn },
  };
}

describe("FleetArmingDialog", () => {
  beforeEach(() => {
    resetStores();
    installElectronMock(vi.fn().mockResolvedValue([]));
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("empty query does not invoke the semantic-buffer search", () => {
    const search = vi.fn().mockResolvedValue([]);
    installElectronMock(search);
    seedTerminals([makeTerminal("a", { title: "alpha" })]);
    renderDialog([makeWorktreeSnap("wt-1", "Main")]);
    expect(search).not.toHaveBeenCalled();
  });

  it("content search surfaces a terminal that only matches its recent output", async () => {
    vi.useFakeTimers();
    const search = vi.fn(async (query: string) => {
      if (query.toLowerCase().includes("usage")) {
        return [
          {
            terminalId: "b",
            line: "Claude Usage Limit reached at 4pm",
            matchStart: 7,
            matchEnd: 18,
          },
        ];
      }
      return [];
    });
    installElectronMock(search);
    seedTerminals([makeTerminal("a", { title: "alpha" }), makeTerminal("b", { title: "beta" })]);
    renderDialog([makeWorktreeSnap("wt-1", "Main")]);
    const input = screen.getByTestId("fleet-arming-dialog-search") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "usage" } });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(search).toHaveBeenCalledWith("usage", false);
    expect(screen.getByText("beta")).toBeTruthy();
    expect(screen.queryByText("alpha")).toBeNull();
    expect(screen.getByTestId("fleet-arming-dialog-snippet")).toBeTruthy();
  });

  it("regex toggle sends isRegex: true to the IPC call", async () => {
    vi.useFakeTimers();
    const search = vi.fn().mockResolvedValue([]);
    installElectronMock(search);
    seedTerminals([makeTerminal("a", { title: "alpha" })]);
    renderDialog([makeWorktreeSnap("wt-1", "Main")]);
    fireEvent.click(screen.getByTestId("fleet-arming-dialog-regex-toggle"));
    fireEvent.change(screen.getByTestId("fleet-arming-dialog-search"), {
      target: { value: "fo+" },
    });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(search).toHaveBeenCalledWith("fo+", true);
  });

  it("invalid regex shows an error and suppresses the IPC call", async () => {
    vi.useFakeTimers();
    const search = vi.fn().mockResolvedValue([]);
    installElectronMock(search);
    seedTerminals([makeTerminal("a", { title: "alpha" })]);
    renderDialog([makeWorktreeSnap("wt-1", "Main")]);
    fireEvent.click(screen.getByTestId("fleet-arming-dialog-regex-toggle"));
    fireEvent.change(screen.getByTestId("fleet-arming-dialog-search"), {
      target: { value: "[unterminated" },
    });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(search).not.toHaveBeenCalled();
    expect(screen.getByTestId("fleet-arming-dialog-regex-error")).toBeTruthy();
  });

  it("stale IPC response does not overwrite a fresher one", async () => {
    vi.useFakeTimers();
    const slowResolvers: Array<(value: unknown) => void> = [];
    const search = vi.fn(
      (query: string) =>
        new Promise((resolve) => {
          if (query === "old") {
            slowResolvers.push(resolve as (value: unknown) => void);
          } else {
            resolve([]);
          }
        })
    );
    installElectronMock(search as unknown as SearchFn);
    seedTerminals([makeTerminal("a", { title: "alpha" }), makeTerminal("b", { title: "beta" })]);
    renderDialog([makeWorktreeSnap("wt-1", "Main")]);
    const input = screen.getByTestId("fleet-arming-dialog-search") as HTMLInputElement;
    // First query — debounce and fire, response stays pending.
    fireEvent.change(input, { target: { value: "old" } });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    // Second query — debounce and fire, response resolves immediately to [].
    fireEvent.change(input, { target: { value: "new" } });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    await act(async () => {
      await Promise.resolve();
    });
    // Now resolve the stale "old" promise with a forged match for "a".
    await act(async () => {
      slowResolvers.forEach((r) =>
        r([{ terminalId: "a", line: "old line", matchStart: 0, matchEnd: 3 }])
      );
      await Promise.resolve();
    });
    // Stale snippet must be ignored — "alpha" does not contain "new" in title,
    // and the snippet response was discarded, so the row stays hidden.
    expect(screen.queryByTestId("fleet-arming-dialog-snippet")).toBeNull();
  });

  it("snippets and regex mode reset on dialog close/reopen", async () => {
    vi.useFakeTimers();
    const search = vi
      .fn()
      .mockResolvedValue([{ terminalId: "a", line: "match line", matchStart: 0, matchEnd: 5 }]);
    installElectronMock(search);
    seedTerminals([makeTerminal("a", { title: "alpha" })]);
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeWorktreeSnap("wt-1", "Main")], 1);
    const { rerender } = render(
      <WorktreeStoreContext.Provider value={store}>
        <FleetArmingDialog isOpen={true} onClose={() => {}} />
      </WorktreeStoreContext.Provider>
    );
    fireEvent.click(screen.getByTestId("fleet-arming-dialog-regex-toggle"));
    fireEvent.change(screen.getByTestId("fleet-arming-dialog-search"), {
      target: { value: "match" },
    });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("fleet-arming-dialog-snippet")).toBeTruthy();
    // Close, then reopen — same component instance, isOpen prop transitions
    // false→true, so the reset effect must re-run.
    rerender(
      <WorktreeStoreContext.Provider value={store}>
        <FleetArmingDialog isOpen={false} onClose={() => {}} />
      </WorktreeStoreContext.Provider>
    );
    rerender(
      <WorktreeStoreContext.Provider value={store}>
        <FleetArmingDialog isOpen={true} onClose={() => {}} />
      </WorktreeStoreContext.Provider>
    );
    expect((screen.getByTestId("fleet-arming-dialog-search") as HTMLInputElement).value).toBe("");
    expect(screen.queryByTestId("fleet-arming-dialog-snippet")).toBeNull();
    expect(
      screen.getByTestId("fleet-arming-dialog-regex-toggle").getAttribute("aria-pressed")
    ).toBe("false");
  });

  it("active chip overrides snippet match — buffer hit on wrong-state terminal stays hidden", async () => {
    vi.useFakeTimers();
    const search = vi
      .fn()
      .mockResolvedValue([{ terminalId: "b", line: "deep match", matchStart: 0, matchEnd: 5 }]);
    installElectronMock(search);
    seedTerminals([
      makeTerminal("a", { title: "alpha", agentState: "waiting" }),
      makeTerminal("b", { title: "beta", agentState: "working" }),
    ]);
    renderDialog([makeWorktreeSnap("wt-1", "Main")]);
    fireEvent.click(screen.getByTestId("fleet-arming-dialog-chip-waiting"));
    fireEvent.change(screen.getByTestId("fleet-arming-dialog-search"), {
      target: { value: "deep" },
    });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    await act(async () => {
      await Promise.resolve();
    });
    // beta has a snippet match but is "working", chip filter is "waiting" — must stay hidden.
    expect(screen.queryByText("beta")).toBeNull();
  });

  it("regex mode hides title-only matches when the backend returns no snippet", async () => {
    vi.useFakeTimers();
    const search = vi.fn().mockResolvedValue([]);
    installElectronMock(search);
    seedTerminals([makeTerminal("a", { title: "alpha" })]);
    renderDialog([makeWorktreeSnap("wt-1", "Main")]);
    // Switch to regex mode, then search for a literal "alpha" — title contains
    // it, but in regex mode title-matching is bypassed and the backend
    // returned no snippet, so the row must stay hidden.
    fireEvent.click(screen.getByTestId("fleet-arming-dialog-regex-toggle"));
    fireEvent.change(screen.getByTestId("fleet-arming-dialog-search"), {
      target: { value: "alpha" },
    });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("alpha")).toBeNull();
    expect(screen.getByText("No terminals match")).toBeTruthy();
  });

  it("buffer-matched terminals are not auto-selected — confirm stays disabled", async () => {
    vi.useFakeTimers();
    const search = vi
      .fn()
      .mockResolvedValue([{ terminalId: "a", line: "deep match", matchStart: 5, matchEnd: 10 }]);
    installElectronMock(search);
    seedTerminals([makeTerminal("a", { title: "alpha" })]);
    renderDialog([makeWorktreeSnap("wt-1", "Main")]);
    fireEvent.change(screen.getByTestId("fleet-arming-dialog-search"), {
      target: { value: "match" },
    });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    await act(async () => {
      await Promise.resolve();
    });
    const confirm = screen.getByText("Arm selected").closest("button") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
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
