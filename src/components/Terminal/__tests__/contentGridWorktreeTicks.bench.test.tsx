// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import type { WorktreeSnapshot } from "@shared/types";
import type { PtyPanelData } from "@shared/types/panel";

// A worktree status tick (modifiedCount, lastActivityTimestamp, ahead/behind)
// replaces the store's Map. The content grid only reads the active worktree's
// identity fields and whether any worktree exists, so a tick — on any worktree
// — must not commit the grid.

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
    onBroadcastResult: vi.fn().mockReturnValue(() => {}),
    setFocusedTerminal: vi.fn(),
    updateWorktreeId: vi.fn(),
  },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({ agents: {} }),
    invalidate: vi.fn(),
    set: vi.fn(),
    reset: vi.fn(),
    stampVersion: vi.fn(),
  },
  cliAvailabilityClient: { refresh: vi.fn() },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
    setInputLocked: vi.fn(),
    wake: vi.fn(),
    wakeForFocus: vi.fn(),
    lockResize: vi.fn(),
    runResizePass: vi.fn(),
    scheduleBatchResize: vi.fn(),
    resize: vi.fn().mockReturnValue(null),
    getInstance: vi.fn(),
  },
}));

vi.mock("@/store/persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: vi.fn(),
    saveTabGroups: vi.fn(),
    flush: vi.fn(),
    cancel: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("@/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks")>()),
  useProjectBranding: () => ({ projectIconSvg: undefined }),
}));

vi.mock("../GridPanel", () => ({
  GridPanel: ({ terminalId, titleOverride }: { terminalId: string; titleOverride?: string }) => (
    <div data-bench-panel={terminalId} data-title={titleOverride ?? ""} />
  ),
}));
vi.mock("../GridTabGroup", () => ({
  GridTabGroup: ({ group }: { group: { activeTabId: string } }) => (
    <div data-bench-panel={group.activeTabId} />
  ),
}));
vi.mock("../GridShell", () => ({
  GridShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../ContentGridEmptyState", () => ({
  ContentGridEmptyState: (props: {
    hasWorktrees: boolean;
    isWorktreeInitialized: boolean;
    activeWorktreeName: string | null;
    activeWorktreeIsDetached: boolean;
  }) => (
    <div
      data-bench-empty=""
      data-has-worktrees={String(props.hasWorktrees)}
      data-initialized={String(props.isWorktreeInitialized)}
      data-active-name={props.activeWorktreeName ?? ""}
      data-detached={String(props.activeWorktreeIsDetached)}
    />
  ),
}));
vi.mock("../GridNotificationBar", () => ({ GridNotificationBar: () => null }));
vi.mock("../TerminalCountWarning", () => ({ TerminalCountWarning: () => null }));
vi.mock("../BatchScrollbackRestoreBar", () => ({ BatchScrollbackRestoreBar: () => null }));
vi.mock("@/components/Plugin/ProjectPluginTrustBanner", () => ({
  ProjectPluginTrustBanner: () => null,
}));

const { ContentGrid } = await import("../ContentGrid");
const { WorktreeStoreContext } = await import("@/contexts/WorktreeStoreContext");
const { createWorktreeStore } = await import("@/store/createWorktreeStore");
const { usePanelStore } = await import("@/store/panelStore");
const { useWorktreeSelectionStore } = await import("@/store/worktreeStore");
const { useFleetArmingStore } = await import("@/store/fleetArmingStore");
const { useFleetScopeFlagStore } = await import("@/store/fleetScopeFlagStore");

const WORKTREE_COUNT = 10;
const PANEL_COUNT = 8;
const TICKS = 100;
const RUNS = 5;
const ACTIVE = "wt-0";
const OTHER = "wt-3";

type Mode = "default" | "fleet";

function snapshot(i: number): WorktreeSnapshot {
  return {
    id: `wt-${i}`,
    worktreeId: `wt-${i}`,
    path: `/repo/wt-${i}`,
    name: `wt-${i}`,
    branch: `feature/${i}`,
    isCurrent: i === 0,
    isMainWorktree: i === 0,
    modifiedCount: 0,
    lastActivityTimestamp: 1_000,
  } as WorktreeSnapshot;
}

function panel(id: string, worktreeId: string): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: `/repo/${worktreeId}`,
    cols: 80,
    rows: 24,
    worktreeId,
    location: "grid",
    isVisible: true,
  } as PtyPanelData;
}

type WtStore = ReturnType<typeof makeWorktreeStore>;

function makeWorktreeStore() {
  const store = createWorktreeStore();
  store.setState({
    worktrees: new Map(Array.from({ length: WORKTREE_COUNT }, (_, i) => [`wt-${i}`, snapshot(i)])),
    isLoading: false,
    isInitialized: true,
  });
  return store;
}

// Mirrors the store's per-worktree replacement: one fresh snapshot, fresh Map.
function update(store: WtStore, id: string, patch: Partial<WorktreeSnapshot>) {
  const next = new Map(store.getState().worktrees);
  next.set(id, { ...next.get(id)!, ...patch });
  store.setState({ worktrees: next });
}

function tick(store: WtStore, id: string, n: number) {
  update(store, id, { modifiedCount: n, lastActivityTimestamp: 1_000 + n, aheadCount: n });
}

let commits = 0;
let actualMs = 0;
const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  commits++;
  actualMs += actualDuration;
};

// Default mode: every panel in the active worktree's grid. Fleet mode: half
// the panels in another worktree, all armed, so titles carry worktree prefixes.
function mount(mode: Mode) {
  const ids = Array.from({ length: PANEL_COUNT }, (_, i) => `p-${i}`);
  const worktreeOf = (i: number) => (mode === "fleet" && i % 2 === 1 ? OTHER : ACTIVE);
  const byWorktree: Record<string, string[]> = {};
  ids.forEach((id, i) => (byWorktree[worktreeOf(i)] ??= []).push(id));
  usePanelStore.setState({
    panelsById: Object.fromEntries(ids.map((id, i) => [id, panel(id, worktreeOf(i))])),
    panelIds: ids,
    panelIdsByWorktreeId: byWorktree,
    tabGroups: new Map(),
    focusedId: null,
    maximizedId: null,
  });
  useWorktreeSelectionStore.setState({
    activeWorktreeId: ACTIVE,
    isFleetScopeActive: mode === "fleet",
  });
  useFleetScopeFlagStore.setState({ mode: "scoped" });
  useFleetArmingStore.setState(
    mode === "fleet"
      ? { armedIds: new Set(ids), armOrder: ids }
      : { armedIds: new Set(), armOrder: [] }
  );

  const store = makeWorktreeStore();
  const Provider = WorktreeStoreContext.Provider;
  const { container } = render(
    <Provider value={store}>
      <DndContext>
        <Profiler id="content-grid" onRender={onRender}>
          <ContentGrid />
        </Profiler>
      </DndContext>
    </Provider>
  );
  const panels = () => [...container.querySelectorAll<HTMLElement>("[data-bench-panel]")];
  expect(panels().length).toBe(PANEL_COUNT);
  expect(container.querySelector('[data-fleet-scope="true"]') !== null).toBe(mode === "fleet");
  commits = 0;
  actualMs = 0;
  return { store, panels };
}

function runOnce(mode: Mode, targetId: string) {
  const { store } = mount(mode);
  for (let n = 1; n <= TICKS; n++) {
    act(() => tick(store, targetId, n));
  }
  const result = { commits, actualMs };
  cleanup();
  return result;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function measure(mode: Mode, targetId: string, label: string) {
  runOnce(mode, targetId); // warm-up
  const runs = Array.from({ length: RUNS }, () => runOnce(mode, targetId));
  for (const run of runs) expect(run.commits).toBe(0);
  const r = {
    commits: median(runs.map((x) => x.commits)),
    actualMs: median(runs.map((x) => x.actualMs)),
  };
  if (process.env.CONTENT_GRID_BENCH) {
    process.stdout.write(
      `[bench] ${label}: ${TICKS} ticks, commits=${r.commits} actualMs=${r.actualMs.toFixed(2)}\n`
    );
  }
  return r;
}

describe("ContentGrid worktree-tick re-renders", () => {
  afterEach(() => {
    cleanup();
    useWorktreeSelectionStore.setState({ isFleetScopeActive: false });
    useFleetArmingStore.setState({ armedIds: new Set(), armOrder: [] });
  });

  it("does not commit the grid on status ticks for a non-active worktree", () => {
    measure("default", OTHER, "default grid, non-active worktree");
  });

  it("does not commit the grid on status ticks for the active worktree", () => {
    measure("default", ACTIVE, "default grid, active worktree");
  });

  it("does not commit the fleet grid on status ticks for an armed worktree", () => {
    measure("fleet", OTHER, "fleet grid, armed worktree");
  });

  it("still commits when the active worktree's branch changes", () => {
    const { store } = mount("default");
    act(() => update(store, ACTIVE, { branch: "renamed" }));
    expect(commits).toBeGreaterThan(0);
  });

  it("feeds the empty state through initialization, first worktree and detach", () => {
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      panelIdsByWorktreeId: {},
      tabGroups: new Map(),
      focusedId: null,
      maximizedId: null,
    });
    useWorktreeSelectionStore.setState({ activeWorktreeId: ACTIVE, isFleetScopeActive: false });
    const store = makeWorktreeStore();
    store.setState({ worktrees: new Map(), isInitialized: false });
    const Provider = WorktreeStoreContext.Provider;
    const { container } = render(
      <Provider value={store}>
        <DndContext>
          <ContentGrid />
        </DndContext>
      </Provider>
    );
    const empty = () => container.querySelector<HTMLElement>("[data-bench-empty]")!.dataset;
    expect(empty()).toMatchObject({ hasWorktrees: "false", initialized: "false", activeName: "" });

    act(() => store.setState({ isInitialized: true }));
    expect(empty()).toMatchObject({ hasWorktrees: "false", initialized: "true" });

    act(() => store.setState({ worktrees: new Map([[ACTIVE, snapshot(0)]]) }));
    expect(empty()).toMatchObject({ hasWorktrees: "true", activeName: "wt-0", detached: "false" });

    act(() => update(store, ACTIVE, { isDetached: true, head: "abc123" }));
    expect(empty().detached).toBe("true");
  });

  it("keeps fleet title prefixes in step with a worktree rename", () => {
    const { store, panels } = mount("fleet");
    const titleOf = (id: string) =>
      panels().find((el) => el.dataset.benchPanel === id)!.dataset.title;
    expect(titleOf("p-1")).toMatch(/^feature\/3 — /);
    expect(titleOf("p-0")).toMatch(/^wt-0 — /);
    act(() => update(store, OTHER, { branch: "renamed" }));
    expect(titleOf("p-1")).toMatch(/^renamed — /);
  });
});
