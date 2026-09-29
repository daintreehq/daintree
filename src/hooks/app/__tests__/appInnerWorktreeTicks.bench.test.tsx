// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { act, cleanup, render } from "@testing-library/react";
import type { Project, WorktreeSnapshot, WorktreeState } from "@shared/types";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";

// A worktree status tick (modifiedCount, lastActivityTimestamp, ahead/behind)
// replaces the store's Map. AppInner's app-root hooks only need the active
// worktree's path/existence and — while a worktree palette or the overview is
// open — the list, so a tick on an unrelated worktree must not commit the
// root or hand ModalHostLayer a new resumeSession.

vi.mock("@/hooks/app/useHomeDir", () => ({ useHomeDir: () => ({ homeDir: "/home/user" }) }));

const resumeSessionIntoPanel = vi.hoisted(() =>
  vi.fn(async (_session: unknown, _target: unknown, _hooks: unknown) => ({ terminalId: "t-1" }))
);
vi.mock("@/services/agentResume", () => ({ resumeSessionIntoPanel }));

// Every other bridge namespace the palette hooks touch on mount: listeners hand
// back an unsubscribe, requests resolve empty.
function bridgeNamespace(): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get: (_target, key) =>
        typeof key === "string" && key.startsWith("on")
          ? () => () => {}
          : () => Promise.resolve(undefined),
    }
  );
}
const request = vi.fn((_op: string, _payload?: unknown) => Promise.resolve());
const namespaces: Record<string, unknown> = { worktreePort: { request } };
vi.stubGlobal(
  "electron",
  new Proxy(namespaces, {
    get: (target, key: string) => (target[key] ??= bridgeNamespace()),
  })
);

const { usePaletteWiring } = await import("../usePaletteWiring");
const { useActiveWorktreeSync } = await import("../useActiveWorktreeSync");
const { useResumeAgentSession } = await import("@/hooks/useResumeAgentSession");
const { WorktreeStoreContext } = await import("@/contexts/WorktreeStoreContext");
const { createWorktreeStore } = await import("@/store/createWorktreeStore");
const { useWorktreeSelectionStore } = await import("@/store/worktreeStore");
const { usePaletteStore } = await import("@/store/paletteStore");
const { useProjectStore } = await import("@/store/projectStore");
const { actionService } = await import("@/services/ActionService");
const { markHostActivationApplied, _resetHostAppliedActivationForTesting } =
  await import("@/store/worktreeActivationOrigin");

const WORKTREE_COUNT = 10;
const TICKS = 100;
const RUNS = 5;
const ACTIVE = "wt-0";
const OTHER = "wt-3";

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

type WtStore = ReturnType<typeof createWorktreeStore>;

function makeWorktreeStore(): WtStore {
  const store = createWorktreeStore();
  store.setState({
    worktrees: new Map(Array.from({ length: WORKTREE_COUNT }, (_, i) => [`wt-${i}`, snapshot(i)])),
    isLoading: false,
    isInitialized: true,
  });
  return store;
}

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
let hostRenders = 0;
let resumeIdentities = 0;
type Wiring = ReturnType<typeof usePaletteWiring>;

interface HostProps {
  newTerminalPalette: Wiring["newTerminalPalette"];
  worktreePalette: Wiring["worktreePalette"];
  resumeSession: ReturnType<typeof useResumeAgentSession>;
  defaultTerminalCwd: string;
  activeWorktreeId: string | null;
  isWorktreeOverviewOpen: boolean;
  worktrees: WorktreeState[];
  isLoading: boolean;
}

let lastResume: HostProps["resumeSession"] | null = null;
let lastHostProps: HostProps | null = null;
const host = (): HostProps => lastHostProps!;

const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  commits++;
  actualMs += actualDuration;
};

// Stands in for ModalHostLayer: receives the same worktree-derived props App
// passes it and counts renders.
function ModalHostSpy(props: HostProps) {
  hostRenders++;
  if (props.resumeSession !== lastResume) {
    resumeIdentities++;
    lastResume = props.resumeSession;
  }
  lastHostProps = props;
  return null;
}

function AppInnerHarness({ isWorktreeOverviewOpen }: { isWorktreeOverviewOpen: boolean }) {
  const { worktrees, isLoading, newTerminalPalette, worktreePalette } = usePaletteWiring({
    isWorktreeOverviewOpen,
  });
  const { activeWorktreeId, defaultTerminalCwd } = useActiveWorktreeSync();
  const resumeSession = useResumeAgentSession();
  return (
    <ModalHostSpy
      newTerminalPalette={newTerminalPalette}
      worktreePalette={worktreePalette}
      resumeSession={resumeSession}
      defaultTerminalCwd={defaultTerminalCwd}
      activeWorktreeId={activeWorktreeId}
      isWorktreeOverviewOpen={isWorktreeOverviewOpen}
      worktrees={worktrees}
      isLoading={isLoading}
    />
  );
}

function mount(overviewOpen = false) {
  useWorktreeSelectionStore.setState({ activeWorktreeId: ACTIVE });
  const store = makeWorktreeStore();
  const Provider = WorktreeStoreContext.Provider;
  const view = render(
    <Provider value={store}>
      <Profiler id="app-inner" onRender={onRender}>
        <AppInnerHarness isWorktreeOverviewOpen={overviewOpen} />
      </Profiler>
    </Provider>
  );
  commits = 0;
  actualMs = 0;
  hostRenders = 0;
  resumeIdentities = 0;
  return { store, view };
}

function runOnce(targetId: string) {
  const { store } = mount();
  lastResume = host().resumeSession;
  resumeIdentities = 0;
  for (let n = 1; n <= TICKS; n++) {
    act(() => tick(store, targetId, n));
  }
  const result = { commits, actualMs, hostRenders, resumeIdentities };
  cleanup();
  return result;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function measure(targetId: string, label: string) {
  runOnce(targetId); // warm-up
  const runs = Array.from({ length: RUNS }, () => runOnce(targetId));
  const r = {
    commits: median(runs.map((x) => x.commits)),
    actualMs: median(runs.map((x) => x.actualMs)),
    hostRenders: median(runs.map((x) => x.hostRenders)),
    resumeIdentities: median(runs.map((x) => x.resumeIdentities)),
  };
  if (process.env.APP_INNER_BENCH) {
    process.stdout.write(
      `[bench] ${label}: ${TICKS} ticks, appInnerCommits=${r.commits} modalHostRenders=${r.hostRenders} ` +
        `resumeSessionIdentities=${r.resumeIdentities} actualMs=${r.actualMs.toFixed(2)}\n`
    );
  }
  return r;
}

const project: Project = {
  id: "project-1",
  path: "/repo",
  name: "repo",
  emoji: "🌲",
  lastOpened: 0,
};

const setActiveCalls = () =>
  request.mock.calls.filter(([op]) => op === "set-active").map(([, payload]) => payload);

describe("AppInner worktree-tick re-renders", () => {
  beforeEach(() => {
    resumeSessionIntoPanel.mockClear();
    request.mockClear();
    _resetHostAppliedActivationForTesting();
    usePaletteStore.setState({ activePaletteId: null });
    useProjectStore.setState({ currentProject: null });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    usePaletteStore.setState({ activePaletteId: null });
    useProjectStore.setState({ currentProject: null });
    useWorktreeSelectionStore.setState({ activeWorktreeId: null });
  });

  it("does not commit the app root on status ticks for a non-active worktree", () => {
    const r = measure(OTHER, "non-active worktree");
    expect(r.commits).toBe(0);
    expect(r.hostRenders).toBe(0);
    expect(r.resumeIdentities).toBe(0);
  });

  it("does not commit the app root on status ticks for the active worktree", () => {
    const r = measure(ACTIVE, "active worktree");
    expect(r.commits).toBe(0);
    expect(r.hostRenders).toBe(0);
    expect(r.resumeIdentities).toBe(0);
  });

  const worktreePaletteRows = () => host().worktreePalette.results;

  it("gives the worktree palette the live list on open and holds it through close", () => {
    const { store } = mount();
    act(() => tick(store, OTHER, 7));
    act(() => usePaletteStore.setState({ activePaletteId: "worktree" }));
    expect(worktreePaletteRows()).toHaveLength(WORKTREE_COUNT);
    expect(worktreePaletteRows()[0]!.id).toBe(ACTIVE);
    expect(worktreePaletteRows().find((w) => w.id === OTHER)!.modifiedCount).toBe(7);

    act(() => tick(store, OTHER, 8));
    expect(worktreePaletteRows().find((w) => w.id === OTHER)!.modifiedCount).toBe(8);

    act(() => usePaletteStore.setState({ activePaletteId: null }));
    commits = 0;
    act(() => tick(store, OTHER, 9));
    expect(commits).toBe(0);
    // Closed, it keeps the rows it closed with for the exit animation.
    expect(worktreePaletteRows()).toHaveLength(WORKTREE_COUNT);
    expect(worktreePaletteRows().find((w) => w.id === OTHER)!.modifiedCount).toBe(8);

    act(() => usePaletteStore.setState({ activePaletteId: "worktree" }));
    expect(worktreePaletteRows().find((w) => w.id === OTHER)!.modifiedCount).toBe(9);
  });

  it("feeds the overview the live list while it is open", () => {
    const { store, view } = mount();
    view.rerender(
      <WorktreeStoreContext.Provider value={store}>
        <AppInnerHarness isWorktreeOverviewOpen />
      </WorktreeStoreContext.Provider>
    );
    const rows = () => host().worktrees;
    expect(rows()).toHaveLength(WORKTREE_COUNT);
    act(() => tick(store, OTHER, 3));
    expect(rows().find((w) => w.id === OTHER)!.modifiedCount).toBe(3);
  });

  it("launches the new-terminal palette into the active worktree's current path", async () => {
    const dispatch = vi
      .spyOn(actionService, "dispatch")
      .mockResolvedValue({ ok: true, result: undefined });
    const { store } = mount();
    act(() => update(store, ACTIVE, { path: "/repo/moved" }));
    await act(() =>
      host().newTerminalPalette.handleSelect({
        id: "claude",
        launchAgentId: "claude",
        label: "Claude",
        description: "",
        icon: null,
      })
    );
    expect(dispatch).toHaveBeenCalledWith(
      "agent.launch",
      expect.objectContaining({ worktreeId: ACTIVE, cwd: "/repo/moved" }),
      { source: "user" }
    );
  });

  it("resumes against the worktree map at call time", async () => {
    const { store } = mount();
    const resume = host().resumeSession;
    const session: AgentSessionRecord = {
      sessionId: "s-1",
      agentId: "claude",
      worktreeId: "wt-new",
      title: null,
      projectId: "project-1",
      savedAt: 0,
      cwd: "/repo/wt-new",
    };

    await act(() => resume(session));
    expect(resumeSessionIntoPanel).not.toHaveBeenCalled();

    act(() => {
      const next = new Map(store.getState().worktrees);
      next.set("wt-new", { ...snapshot(20), id: "wt-new", path: "/repo/wt-new" });
      store.setState({ worktrees: next });
    });
    expect(host().resumeSession).toBe(resume);
    await act(() => resume(session));
    expect(resumeSessionIntoPanel).toHaveBeenCalledWith(
      session,
      { cwd: "/repo/wt-new", worktreeId: "wt-new" },
      expect.anything()
    );
    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-new");
  });

  it("follows the active worktree's path and liveness", () => {
    const { store } = mount();
    expect(host().defaultTerminalCwd).toBe("/repo/wt-0");
    expect(host().activeWorktreeId).toBe(ACTIVE);
    act(() => update(store, ACTIVE, { path: "/repo/elsewhere" }));
    expect(host().defaultTerminalCwd).toBe("/repo/elsewhere");

    act(() => useWorktreeSelectionStore.setState({ activeWorktreeId: "ghost" }));
    // An id that is no longer live snaps back to the main worktree.
    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe(ACTIVE);
  });

  it("retries a failed set-active on the next worktree change", async () => {
    useProjectStore.setState({ currentProject: project });
    request.mockRejectedValueOnce(new Error("port closed"));
    const { store } = mount();
    await act(async () => {});
    expect(setActiveCalls()).toHaveLength(1);

    act(() => tick(store, OTHER, 1));
    expect(setActiveCalls()).toHaveLength(2);
    expect(setActiveCalls()[1]).toMatchObject({ worktreeId: ACTIVE });

    // Delivered this time, so later ticks send nothing.
    await act(async () => {});
    act(() => tick(store, OTHER, 2));
    expect(setActiveCalls()).toHaveLength(2);
  });

  it("expires an unconsumed host-applied mark on the next worktree change", async () => {
    useProjectStore.setState({ currentProject: project });
    const { store } = mount();
    await act(async () => {});
    // The host's pick was overtaken before the sync effect ever saw it.
    markHostActivationApplied(OTHER);
    act(() => tick(store, OTHER, 1));

    act(() => useWorktreeSelectionStore.setState({ activeWorktreeId: OTHER }));
    expect(setActiveCalls().at(-1)).toMatchObject({ worktreeId: OTHER });
  });
});
