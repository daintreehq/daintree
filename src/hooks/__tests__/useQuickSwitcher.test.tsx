// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { usePanelStore } from "@/store/panelStore";
import { registerPanelKind, unregisterPanelKind } from "@shared/config/panelKindRegistry";
import type { PanelInstance } from "@shared/types/panel";

const { useWorktreeStoreMock } = vi.hoisted(() => ({
  useWorktreeStoreMock: vi.fn(),
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: useWorktreeStoreMock,
}));

vi.mock("@/store", async () => {
  const actual = await vi.importActual<typeof import("@/store")>("@/store");
  return {
    ...actual,
    useWorktreeSelectionStore: Object.assign(
      (selector: (s: unknown) => unknown) =>
        selector({ selectWorktree: vi.fn(), activeWorktreeId: null }),
      { getState: () => ({ activeWorktreeId: null }) }
    ),
  };
});

import { useQuickSwitcher, type QuickSwitcherItem } from "../useQuickSwitcher";
import { usePaletteStore } from "@/store/paletteStore";

type MockWorktreeState = {
  worktrees: Map<string, unknown>;
  isLoading: boolean;
  isInitialized: boolean;
  isReconnecting: boolean;
  error: string | null;
};

function seedWorktreeState(state: Partial<MockWorktreeState>): void {
  const fullState: MockWorktreeState = {
    worktrees: new Map(),
    isLoading: false,
    isInitialized: false,
    isReconnecting: false,
    error: null,
    ...state,
  };
  useWorktreeStoreMock.mockImplementation((selector: (s: MockWorktreeState) => unknown) =>
    selector(fullState)
  );
}

describe("useQuickSwitcher isLoading", () => {
  beforeEach(() => {
    usePanelStore.setState({ panelsById: {}, panelIds: [], mruList: [] });
    useWorktreeStoreMock.mockReset();
  });

  it("reports isLoading=true while the worktree store has not yet initialized", () => {
    seedWorktreeState({ isInitialized: false });
    const { result } = renderHook(() => useQuickSwitcher());
    expect(result.current.isLoading).toBe(true);
  });

  it("reports isLoading=false once the worktree store has hydrated", () => {
    seedWorktreeState({ isInitialized: true });
    const { result } = renderHook(() => useQuickSwitcher());
    expect(result.current.isLoading).toBe(false);
  });

  it("does not flip back to loading just because a refetch sets isLoading on the store", () => {
    // After cold-start the bar should stay hidden during a transient refresh —
    // only first-load (`!isInitialized`) is the real "no data yet" signal.
    seedWorktreeState({ isInitialized: true, isLoading: true });
    const { result } = renderHook(() => useQuickSwitcher());
    expect(result.current.isLoading).toBe(false);
  });

  it("does not show the bar after a fatal workspace-host error", () => {
    // setFatalError clears isInitialized AND isLoading and sets error. Without
    // the error guard, the bar would spin forever in this state instead of
    // letting the surrounding UI surface the failure.
    seedWorktreeState({ isInitialized: false, isLoading: false, error: "host crashed" });
    const { result } = renderHook(() => useQuickSwitcher());
    expect(result.current.isLoading).toBe(false);
  });
});

describe("useQuickSwitcher MRU prune", () => {
  beforeEach(() => {
    usePanelStore.setState({ panelsById: {}, panelIds: [], mruList: [] });
    useWorktreeStoreMock.mockReset();
    // Panel/worktree subscriptions (and therefore pruning) are gated on the
    // palette being open — these tests exercise the hydration guards, so run
    // them against an open palette.
    usePaletteStore.setState({ activePaletteId: "quick-switcher" });
  });

  afterEach(() => {
    usePaletteStore.setState({ activePaletteId: null });
  });

  it("does not prune while the item set is empty (panels still hydrating) (#9922)", () => {
    // Panels and worktrees populate asynchronously; pruning against an empty
    // item set here would gut the whole MRU list before this project's items load.
    const pruneMru = vi.fn();
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      mruList: ["terminal:t-1", "worktree:wt-1"],
      pruneMru,
    });
    seedWorktreeState({ isInitialized: true });

    renderHook(() => useQuickSwitcher());

    expect(pruneMru).not.toHaveBeenCalled();
  });

  it("prunes against the current item set once items are present", () => {
    const pruneMru = vi.fn();
    usePanelStore.setState({
      panelsById: {
        "t-1": {
          id: "t-1",
          title: "T1",
          kind: "terminal",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: ["t-1"],
      mruList: ["terminal:t-1", "terminal:gone"],
      pruneMru,
    });
    seedWorktreeState({ isInitialized: true });

    renderHook(() => useQuickSwitcher());

    expect(pruneMru).toHaveBeenCalledWith(new Set(["terminal:t-1"]));
  });

  it("protects terminal entries while panels are still hydrating (worktrees loaded first) (#9922)", () => {
    // Worktrees populate before panels during hydration. Pruning terminal
    // entries here — when zero terminal items exist yet — would drop the
    // restored MRU order. The not-yet-hydrated category must be protected.
    const pruneMru = vi.fn();
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      mruList: ["terminal:t-1", "worktree:wt-1"],
      pruneMru,
    });
    seedWorktreeState({
      isInitialized: true,
      worktrees: new Map([["wt-1", { id: "wt-1", name: "WT1", path: "/wt1" }]]),
    });

    renderHook(() => useQuickSwitcher());

    // worktree:wt-1 is a live item; terminal:t-1 is protected (no terminal items yet).
    expect(pruneMru).toHaveBeenCalledWith(new Set(["worktree:wt-1", "terminal:t-1"]));
  });
});

describe("useQuickSwitcher panel items (#13763)", () => {
  beforeEach(() => {
    usePanelStore.setState({ panelsById: {}, panelIds: [], mruList: [] });
    useWorktreeStoreMock.mockReset();
    usePaletteStore.setState({ activePaletteId: "quick-switcher" });
  });

  afterEach(() => {
    usePaletteStore.setState({ activePaletteId: null });
    unregisterPanelKind("acme.dashboard");
  });

  function seedPanels(panels: PanelInstance[]): void {
    usePanelStore.setState({
      panelsById: Object.fromEntries(panels.map((panel) => [panel.id, panel])),
      panelIds: panels.map((panel) => panel.id),
    });
  }

  function panelRows(results: QuickSwitcherItem[]) {
    return results
      .filter((item) => item.type === "terminal")
      .map(({ id, title, subtitle }) => ({ id, title, subtitle }));
  }

  it("lists open non-PTY and plugin panels by title with their worktree as subtitle", () => {
    registerPanelKind({
      id: "acme.dashboard",
      name: "Acme Dashboard",
      iconId: "gauge",
      color: "#abcdef",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      extensionId: "acme",
    });
    seedPanels([
      {
        id: "br-1",
        kind: "browser",
        title: "localhost:3000",
        location: "grid",
        worktreeId: "wt-1",
      },
      { id: "dp-1", kind: "dev-preview", title: "Preview", location: "dock", worktreeId: "wt-1" },
      { id: "f-1", kind: "file", title: "README.md", location: "grid", worktreeId: "wt-1" },
      { id: "fb-1", kind: "file-browser", title: "Files", location: "grid", worktreeId: "wt-1" },
      { id: "d-1", kind: "diff", title: "app.ts", location: "grid", worktreeId: "wt-1" },
      { id: "r-1", kind: "review", title: "Review", location: "grid", worktreeId: "wt-1" },
      {
        id: "p-1",
        kind: "acme.dashboard",
        title: "Dashboard",
        location: "grid",
        worktreeId: "wt-1",
      },
    ] as PanelInstance[]);
    seedWorktreeState({
      isInitialized: true,
      worktrees: new Map([["wt-1", { id: "wt-1", name: "main", path: "/repo" }]]),
    });

    const { result } = renderHook(() => useQuickSwitcher());

    expect(panelRows(result.current.results)).toEqual([
      { id: "terminal:br-1", title: "localhost:3000", subtitle: "main" },
      { id: "terminal:dp-1", title: "Preview", subtitle: "main" },
      { id: "terminal:f-1", title: "README.md", subtitle: "main" },
      { id: "terminal:fb-1", title: "Files", subtitle: "main" },
      { id: "terminal:d-1", title: "app.ts", subtitle: "main" },
      { id: "terminal:r-1", title: "Review", subtitle: "main" },
      { id: "terminal:p-1", title: "Dashboard", subtitle: "main" },
    ]);
  });

  it("leaves out trashed, ephemeral and dead-PTY panels", () => {
    seedPanels([
      { id: "br-live", kind: "browser", title: "Live", location: "grid" },
      { id: "br-trash", kind: "browser", title: "Trashed", location: "trash" },
      {
        id: "f-dialog",
        kind: "file",
        title: "Dialog file",
        location: "dialog",
        excludeFromPersistence: true,
      },
      {
        id: "t-dead",
        kind: "terminal",
        title: "Dead",
        location: "grid",
        cwd: "/repo",
        cols: 80,
        rows: 24,
        hasPty: false,
      },
    ] as PanelInstance[]);
    seedWorktreeState({ isInitialized: true });

    const { result } = renderHook(() => useQuickSwitcher());

    expect(panelRows(result.current.results)).toEqual([
      { id: "terminal:br-live", title: "Live", subtitle: undefined },
    ]);
  });

  it("finds a browser panel by its title", () => {
    seedPanels([
      {
        id: "t-1",
        kind: "terminal",
        title: "Shell",
        location: "grid",
        cwd: "/repo",
        cols: 80,
        rows: 24,
      },
      { id: "br-1", kind: "browser", title: "Storybook", location: "grid" },
    ] as PanelInstance[]);
    seedWorktreeState({ isInitialized: true });

    const { result } = renderHook(() => useQuickSwitcher());
    act(() => result.current.setQuery("storybook"));

    expect(result.current.results[0]?.id).toBe("terminal:br-1");
  });

  it("activates a selected browser panel so a fullscreen neighbour can't hide it", () => {
    const activateTerminal = vi.fn();
    const original = usePanelStore.getState().activateTerminal;
    usePanelStore.setState({ activateTerminal });
    try {
      seedPanels([
        { id: "br-1", kind: "browser", title: "Storybook", location: "grid" },
      ] as PanelInstance[]);
      seedWorktreeState({ isInitialized: true });

      const { result } = renderHook(() => useQuickSwitcher());
      const item = result.current.results.find((entry) => entry.id === "terminal:br-1");
      expect(item).toBeDefined();
      act(() => result.current.selectItem(item!));

      expect(activateTerminal).toHaveBeenCalledWith("br-1");
    } finally {
      usePanelStore.setState({ activateTerminal: original });
    }
  });

  it("keeps MRU entries for open non-PTY panels when pruning", () => {
    const pruneMru = vi.fn();
    usePanelStore.setState({ pruneMru, mruList: ["terminal:br-1", "terminal:br-closed"] });
    seedPanels([
      { id: "br-1", kind: "browser", title: "Storybook", location: "grid" },
    ] as PanelInstance[]);
    seedWorktreeState({ isInitialized: true });

    renderHook(() => useQuickSwitcher());

    expect(pruneMru).toHaveBeenCalledWith(new Set(["terminal:br-1"]));
  });
});
