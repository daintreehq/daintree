// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, fireEvent, type RenderOptions } from "@testing-library/react";
import { createStore } from "zustand/vanilla";
import type { ReactElement, ReactNode } from "react";
import type { TerminalInstance, WorktreeSnapshot } from "@shared/types";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

// ClusterAttentionPill depends on the WorktreeStore context (via
// useAgentClusters) — stub to keep the test focused on Deck composition.
vi.mock("../ClusterAttentionPill", () => ({
  ClusterAttentionPill: () => null,
}));

// FleetComposer reaches into terminal focus/scope infrastructure; stub to
// a dumb span for composition tests.
vi.mock("../FleetComposer", () => ({
  FleetComposer: () => <span data-testid="fleet-composer-stub" />,
}));

// FleetScopeBar subscribes to several stores we don't care about here.
vi.mock("../FleetScopeBar", () => ({
  FleetScopeBar: () => <span data-testid="fleet-scope-bar-stub" />,
}));

import { FleetDeck } from "../FleetDeck";
import { useFleetDeckStore } from "@/store/fleetDeckStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import type { WorktreeViewState, WorktreeViewActions } from "@/store/createWorktreeStore";

function makeAgent(id: string, overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id,
    title: id,
    kind: "agent",
    agentId: "claude",
    worktreeId: "wt-1",
    location: "grid",
    hasPty: true,
    agentState: "idle",
    ...overrides,
  } as TerminalInstance;
}

function makeWorktreeSnapshot(
  id: string,
  name: string,
  overrides: Partial<WorktreeSnapshot> = {}
): WorktreeSnapshot {
  return {
    id,
    worktreeId: id,
    path: `/repo/${id}`,
    name,
    branch: `feature/${id}`,
    isCurrent: true,
    ...overrides,
  } as WorktreeSnapshot;
}

function seedPanels(agents: TerminalInstance[]): void {
  const panelsById: Record<string, TerminalInstance> = {};
  const panelIds: string[] = [];
  for (const a of agents) {
    panelsById[a.id] = a;
    panelIds.push(a.id);
  }
  usePanelStore.setState({ panelsById, panelIds });
}

function reorderPanels(newOrder: string[]): void {
  const current = usePanelStore.getState();
  usePanelStore.setState({ panelsById: current.panelsById, panelIds: newOrder });
}

function resetStores(): void {
  useFleetDeckStore.setState({
    isOpen: true,
    stateFilter: "all",
    isHydrated: true,
    alwaysPreview: false,
    quorumThreshold: 5,
  });
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
  });
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
  useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
}

function makeViewStore(worktrees: Map<string, WorktreeSnapshot>) {
  return createStore<WorktreeViewState & WorktreeViewActions>(() => ({
    worktrees,
    version: 0,
    isLoading: false,
    error: null,
    isInitialized: true,
    isReconnecting: false,
    nextVersion: () => 0,
    applySnapshot: () => {},
    applyUpdate: () => {},
    applyRemove: () => {},
    setLoading: () => {},
    setError: () => {},
    setFatalError: () => {},
    setReconnecting: () => {},
  }));
}

function renderWithWorktrees(
  ui: ReactElement,
  worktrees: Map<string, WorktreeSnapshot> = new Map([
    ["wt-1", makeWorktreeSnapshot("wt-1", "main")],
    ["wt-2", makeWorktreeSnapshot("wt-2", "feature-x")],
  ]),
  options?: RenderOptions
): ReturnType<typeof render> {
  const store = makeViewStore(worktrees);
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <WorktreeStoreContext value={store}>{children}</WorktreeStoreContext>
  );
  return render(ui, { wrapper: Wrapper, ...options });
}

describe("FleetDeck", () => {
  beforeEach(() => {
    resetStores();
  });

  it("renders nothing when the deck is closed", () => {
    useFleetDeckStore.setState({ isOpen: false });
    seedPanels([makeAgent("a")]);
    const { container } = renderWithWorktrees(<FleetDeck />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one row per eligible agent when open", () => {
    seedPanels([makeAgent("a"), makeAgent("b"), makeAgent("c")]);
    const { getAllByTestId } = renderWithWorktrees(<FleetDeck />);
    expect(getAllByTestId("fleet-deck-row")).toHaveLength(3);
  });

  it("re-renders rows in order when panelIds is reordered", async () => {
    seedPanels([makeAgent("a"), makeAgent("b"), makeAgent("c")]);
    const { getAllByTestId } = renderWithWorktrees(<FleetDeck />);
    const initial = getAllByTestId("fleet-deck-row").map(
      (el) => el.getAttribute("data-panel-id") ?? ""
    );
    expect(initial).toEqual(["a", "b", "c"]);

    await act(async () => {
      reorderPanels(["c", "b", "a"]);
    });

    const reordered = getAllByTestId("fleet-deck-row").map(
      (el) => el.getAttribute("data-panel-id") ?? ""
    );
    expect(reordered).toEqual(["c", "b", "a"]);
  });

  it("groups rows by worktree with a header per worktree", () => {
    seedPanels([
      makeAgent("a", { worktreeId: "wt-1" }),
      makeAgent("b", { worktreeId: "wt-1" }),
      makeAgent("c", { worktreeId: "wt-2" }),
    ]);
    const { getAllByTestId } = renderWithWorktrees(<FleetDeck />);
    const headers = getAllByTestId("fleet-deck-group-header").map((el) => el.textContent);
    expect(headers).toEqual(["main", "feature-x"]);
  });

  it("clicking a row arms that agent; clicking again disarms", () => {
    seedPanels([makeAgent("a"), makeAgent("b")]);
    const { getAllByTestId } = renderWithWorktrees(<FleetDeck />);
    const rows = getAllByTestId("fleet-deck-row");
    fireEvent.click(rows[0]!);
    expect(useFleetArmingStore.getState().armedIds.has("a")).toBe(true);
    fireEvent.click(rows[0]!);
    expect(useFleetArmingStore.getState().armedIds.has("a")).toBe(false);
  });

  it("shift-click extends range selection across visible rows", () => {
    seedPanels([makeAgent("a"), makeAgent("b"), makeAgent("c"), makeAgent("d")]);
    const { getAllByTestId } = renderWithWorktrees(<FleetDeck />);
    const rows = getAllByTestId("fleet-deck-row");
    fireEvent.click(rows[0]!); // Arm "a" (anchor)
    fireEvent.click(rows[2]!, { shiftKey: true }); // Extend to "c"
    const armed = useFleetArmingStore.getState().armedIds;
    expect(armed.has("a")).toBe(true);
    expect(armed.has("b")).toBe(true);
    expect(armed.has("c")).toBe(true);
    expect(armed.has("d")).toBe(false);
  });

  it("state filter narrows visible rows", () => {
    seedPanels([
      makeAgent("a", { agentState: "idle" }),
      makeAgent("b", { agentState: "waiting" }),
      makeAgent("c", { agentState: "working" }),
    ]);
    useFleetDeckStore.setState({ stateFilter: "waiting" });
    const { getAllByTestId } = renderWithWorktrees(<FleetDeck />);
    const rows = getAllByTestId("fleet-deck-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("data-panel-id")).toBe("b");
  });

  it("renders empty state when no agents match", () => {
    useFleetDeckStore.setState({ stateFilter: "completed" });
    seedPanels([makeAgent("a", { agentState: "idle" })]);
    const { getByRole, queryAllByTestId } = renderWithWorktrees(<FleetDeck />);
    expect(queryAllByTestId("fleet-deck-row")).toHaveLength(0);
    expect(getByRole("status")).toBeTruthy();
  });

  it("armed row exposes data-armed attribute and aria-pressed", () => {
    seedPanels([makeAgent("a")]);
    useFleetArmingStore.setState({
      armedIds: new Set(["a"]),
      armOrder: ["a"],
      armOrderById: { a: 1 },
      lastArmedId: "a",
    });
    const { getByTestId } = renderWithWorktrees(<FleetDeck />);
    const row = getByTestId("fleet-deck-row");
    expect(row.getAttribute("data-armed")).toBe("true");
    expect(row.getAttribute("aria-pressed")).toBe("true");
  });
});
