// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { usePanelStore } from "@/store/panelStore";
import { registerPanelKind, unregisterPanelKind } from "@shared/config/panelKindRegistry";
import type { PanelInstance } from "@shared/types/panel";

const { useWorktreeStoreMock, selectWorktreeMock } = vi.hoisted(() => ({
  useWorktreeStoreMock: vi.fn(),
  selectWorktreeMock: vi.fn(),
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
        selector({ selectWorktree: selectWorktreeMock, activeWorktreeId: null }),
      { getState: () => ({ activeWorktreeId: null }) }
    ),
  };
});

import { useQuickSwitcher, type QuickSwitcherItem } from "../useQuickSwitcher";
import { usePaletteStore } from "@/store/paletteStore";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { consumeDeferredPaletteFocusRestore } from "@/components/ui/paletteFocusRestore";

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
  const { pruneMru, activateTerminal, restoreBackgroundTerminal } = usePanelStore.getState();

  beforeEach(() => {
    // The prune suite above swaps in pruneMru mocks; start from the real actions.
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      mruList: [],
      pruneMru,
      activateTerminal,
      restoreBackgroundTerminal,
    });
    useWorktreeStoreMock.mockReset();
    selectWorktreeMock.mockReset();
    usePaletteStore.setState({ activePaletteId: "quick-switcher" });
  });

  afterEach(() => {
    usePaletteStore.setState({ activePaletteId: null });
    consumeDeferredPaletteFocusRestore();
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

  function selectById(id: string): void {
    const { result } = renderHook(() => useQuickSwitcher());
    const item = result.current.results.find((entry) => entry.id === id);
    expect(item).toBeDefined();
    act(() => result.current.selectItem(item!));
  }

  it("activates a selected browser panel and takes over the palette's focus restore", () => {
    const activate = vi.fn();
    usePanelStore.setState({ activateTerminal: activate });
    seedPanels([
      { id: "br-1", kind: "browser", title: "Storybook", location: "grid" },
    ] as PanelInstance[]);
    seedWorktreeState({ isInitialized: true });

    selectById("terminal:br-1");

    expect(activate).toHaveBeenCalledWith("br-1");
    // The hand-off runs the palette's guarded restore, which only refocuses
    // the opener while nothing else holds the keyboard.
    const receive = consumeDeferredPaletteFocusRestore();
    const restore = vi.fn();
    receive?.(restore);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("switches to a panel's worktree before activating it", () => {
    const activate = vi.fn();
    usePanelStore.setState({ activateTerminal: activate });
    seedPanels([
      { id: "br-1", kind: "browser", title: "Storybook", location: "grid", worktreeId: "wt-2" },
    ] as PanelInstance[]);
    seedWorktreeState({ isInitialized: true });

    selectById("terminal:br-1");

    expect(selectWorktreeMock).toHaveBeenCalledWith("wt-2");
    expect(selectWorktreeMock.mock.invocationCallOrder[0]).toBeLessThan(
      activate.mock.invocationCallOrder[0]!
    );
  });

  it("restores a backgrounded non-PTY panel before activating it", () => {
    const activate = vi.fn();
    const restore = vi.fn();
    usePanelStore.setState({ activateTerminal: activate, restoreBackgroundTerminal: restore });
    seedPanels([
      { id: "rv-1", kind: "review", title: "Review", location: "background" },
    ] as PanelInstance[]);
    seedWorktreeState({ isInitialized: true });

    selectById("terminal:rv-1");

    expect(restore).toHaveBeenCalledWith("rv-1");
    expect(restore.mock.invocationCallOrder[0]).toBeLessThan(activate.mock.invocationCallOrder[0]!);
  });

  it("takes over the palette's focus restore when a worktree is picked", () => {
    seedWorktreeState({
      isInitialized: true,
      worktrees: new Map([["wt-1", { id: "wt-1", name: "main", path: "/repo" }]]),
    });

    selectById("worktree:wt-1");

    expect(selectWorktreeMock).toHaveBeenCalledWith("wt-1");
    expect(consumeDeferredPaletteFocusRestore()).not.toBeNull();
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

describe("useQuickSwitcher custom worktree titles (#17503)", () => {
  const { pruneMru } = usePanelStore.getState();
  const red = {
    id: "wt-red",
    name: "feature/auth-refresh",
    branch: "feature/auth-refresh",
    path: "/repo/wt-red",
  };
  const blue = {
    id: "wt-blue",
    name: "feature/billing",
    branch: "feature/billing",
    path: "/repo/wt-blue",
  };

  const setTitles = (titles: Record<string, string>) =>
    act(() => useWorktreeFilterStore.setState({ worktreeCustomTitles: titles }));

  const seed = (...worktrees: { id: string }[]) =>
    seedWorktreeState({
      isInitialized: true,
      worktrees: new Map(worktrees.map((w) => [w.id, w])),
    });

  beforeEach(() => {
    usePanelStore.setState({ panelsById: {}, panelIds: [], mruList: [], pruneMru });
    useWorktreeStoreMock.mockReset();
    usePaletteStore.setState({ activePaletteId: "quick-switcher" });
  });

  afterEach(() => {
    setTitles({});
    usePaletteStore.setState({ activePaletteId: null });
  });

  it("finds a worktree by its custom title and shows that title, with its branch and path", () => {
    setTitles({ "wt-red": "Release planning" });
    seed(red, blue);

    const { result } = renderHook(() => useQuickSwitcher());
    act(() => result.current.setQuery("release planning"));

    expect(result.current.results.map((item) => item.id)).toEqual(["worktree:wt-red"]);
    const [first] = result.current.results;
    expect(first?.title).toBe("Release planning");
    expect(first?.displaced).toBe("feature/auth-refresh");
    expect(first?.subtitle).toBe("/repo/wt-red");
    expect(result.current.matchesById.get("worktree:wt-red")?.map((m) => m.key)).toEqual(["title"]);
  });

  it("still finds the titled worktree by the branch the title displaced, marking the branch", () => {
    setTitles({ "wt-red": "Release planning" });
    seed(red, blue);

    const { result } = renderHook(() => useQuickSwitcher());
    act(() => result.current.setQuery("authrefresh"));

    expect(result.current.results.map((item) => item.id)).toEqual(["worktree:wt-red"]);
    const keys = result.current.matchesById.get("worktree:wt-red")?.map((match) => match.key);
    expect(keys).toEqual(["displaced"]);
  });

  it("keeps the title's ranges and the branch's apart when a query matches both", () => {
    setTitles({ "wt-red": "Auth refresh notes" });
    seed(red);

    const { result } = renderHook(() => useQuickSwitcher());
    act(() => result.current.setQuery("authrefresh"));

    const matches = result.current.matchesById.get("worktree:wt-red") ?? [];
    expect(matches.map((m) => m.key).sort()).toEqual(["displaced", "title"]);
    const fragments = (key: string) => {
      const match = matches.find((m) => m.key === key)!;
      return match.indices.map(([start, end]) => match.value!.slice(start, end + 1));
    };
    // Each range indexes the text its key names, so the row can paint it there.
    expect(fragments("title")).toEqual(["Auth", "refresh"]);
    expect(fragments("displaced")).toEqual(["auth", "refresh"]);
    expect(matches.find((m) => m.key === "title")?.value).toBe("Auth refresh notes");
    expect(matches.find((m) => m.key === "displaced")?.value).toBe("feature/auth-refresh");
  });

  it("finds the titled worktree by its path as before", () => {
    setTitles({ "wt-red": "Release planning" });
    seed(red, blue);

    const { result } = renderHook(() => useQuickSwitcher());
    act(() => result.current.setQuery("wt-red"));

    expect(result.current.results.map((item) => item.id)).toEqual(["worktree:wt-red"]);
    expect(result.current.matchesById.get("worktree:wt-red")?.map((m) => m.key)).toEqual([
      "subtitle",
    ]);
  });

  it("names a worktree without a title by its name, nothing displaced", () => {
    setTitles({ "wt-red": "Release planning" });
    const folder = {
      id: "wt-dir",
      name: "billing-dir",
      branch: "feature/billing",
      path: "/repo/b",
    };
    seed(red, folder);

    const { result } = renderHook(() => useQuickSwitcher());

    const item = result.current.results.find((entry) => entry.id === "worktree:wt-dir");
    expect(item?.title).toBe("billing-dir");
    expect(item?.displaced).toBeUndefined();
  });

  it("says nothing displaced when a title is the worktree's own name and branch", () => {
    const same = { id: "wt-same", name: "feature/same", branch: "feature/same", path: "/repo/s" };
    setTitles({ "wt-same": "feature/same" });
    seed(same);

    const { result } = renderHook(() => useQuickSwitcher());

    expect(result.current.results[0]?.displaced).toBeNull();
  });

  it("falls back to the branch for a nameless worktree without a title", () => {
    seedWorktreeState({
      isInitialized: true,
      worktrees: new Map([["wt-n", { id: "wt-n", branch: "feature/nameless", path: "/repo/n" }]]),
    });

    const { result } = renderHook(() => useQuickSwitcher());

    expect(result.current.results[0]?.title).toBe("feature/nameless");
  });

  it("says nothing displaced, not undefined, when a title is the only thing a detached worktree is called", () => {
    const detachedMain = {
      id: "wt-main",
      name: "daintree",
      path: "/repo/daintree",
      isMainWorktree: true,
      isDetached: true,
      head: "0123456789abcdef",
    };
    setTitles({ "wt-main": "detached at 0123456" });
    seed(detachedMain);

    const { result } = renderHook(() => useQuickSwitcher());

    expect(result.current.results[0]?.title).toBe("detached at 0123456");
    expect(result.current.results[0]?.displaced).toBeNull();
  });

  it("leaves the order of untitled worktrees under the MRU boost where it was", () => {
    // Fuse spreads key weights over every configured key, so a key of its own
    // for the displaced text moved these scores by more than the boost.
    const a = { id: "wt-a", name: "auth", branch: "auth", path: "/repo/auth" };
    const b = { id: "wt-b", name: "xauth", branch: "xauth", path: "/repo/xauth" };
    usePanelStore.setState({ mruList: ["worktree:wt-b"] });
    seed(a, b);

    const { result } = renderHook(() => useQuickSwitcher());
    act(() => result.current.setQuery("auth"));

    expect(result.current.results.map((item) => item.id)).toEqual([
      "worktree:wt-b",
      "worktree:wt-a",
    ]);
  });

  it("follows a rename or a cleared title while open, falling back to the name", () => {
    setTitles({ "wt-red": "Release planning" });
    seed(red);

    const { result } = renderHook(() => useQuickSwitcher());
    act(() => result.current.setQuery("hotfix"));
    expect(result.current.results).toHaveLength(0);

    setTitles({ "wt-red": "Hotfix" });
    expect(result.current.results[0]?.title).toBe("Hotfix");

    setTitles({});
    expect(result.current.results).toHaveLength(0);
    act(() => result.current.setQuery("auth-refresh"));
    expect(result.current.results[0]?.title).toBe("feature/auth-refresh");
  });

  it("reads the titles as they are when the switcher opens, and ignores them while closed", () => {
    seed(red);
    usePaletteStore.setState({ activePaletteId: null });
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useQuickSwitcher();
    });
    const rendersBefore = renders;

    setTitles({ "wt-red": "Release planning" });
    expect(renders).toBe(rendersBefore);

    act(() => usePaletteStore.setState({ activePaletteId: "quick-switcher" }));

    expect(result.current.results[0]?.title).toBe("Release planning");
  });
});
