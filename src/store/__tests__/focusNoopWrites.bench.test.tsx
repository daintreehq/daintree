// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";

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
  },
}));

const saveMock = vi.hoisted(() => vi.fn());
vi.mock("../persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: saveMock,
    saveTabGroups: vi.fn(),
    flush: vi.fn(),
    cancel: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

const { usePanelStore } = await import("../panelStore");
const { useWorktreeSelectionStore } = await import("../worktreeStore");
const { initStoreOrchestrator, destroyStoreOrchestrator } =
  await import("../rendererStoreOrchestrator");

const PANEL_COUNT = 20;
const CLICKS = 50;
// Live `useWorktreeSelectionStore(...)` selector sites in src/ (counted by grep).
const WORKTREE_SELECTOR_SITES = 61;
const ids = Array.from({ length: PANEL_COUNT }, (_, i) => `term-${i}`);
const FIRST = "term-0";
const SECOND = "term-1";

let paneRenders = 0;
function FakePane({ id }: { id: string }) {
  // Mirrors the per-pane subscriptions a TerminalPane holds on the panel store.
  usePanelStore((s) => s.panelsById[id]);
  usePanelStore((s) => s.focusedId === id);
  usePanelStore((s) => s.activeDockTerminalId);
  paneRenders++;
  return null;
}

async function seed() {
  await usePanelStore.getState().reset();
  const panelsById: Record<string, unknown> = {};
  for (const id of ids) {
    panelsById[id] = {
      id,
      kind: "terminal",
      worktreeId: "wt-1",
      title: id,
      cwd: "/test",
      cols: 80,
      rows: 24,
      location: "grid",
    };
  }
  usePanelStore.setState({
    panelsById: panelsById as never,
    panelIds: [...ids],
    tabGroups: new Map(),
    focusedId: null,
    previousFocusedId: null,
    maximizedId: null,
    activeDockTerminalId: null,
  });
  useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
}

function counters() {
  let panelsByIdChanges = 0;
  let panelNotifications = 0;
  let worktreeNotifications = 0;
  const unsubPanel = usePanelStore.subscribe((s, prev) => {
    panelNotifications++;
    if (s.panelsById !== prev.panelsById) panelsByIdChanges++;
  });
  const unsubWt = useWorktreeSelectionStore.subscribe(() => {
    worktreeNotifications++;
  });
  return {
    read: () => ({ panelsByIdChanges, panelNotifications, worktreeNotifications }),
    dispose: () => {
      unsubPanel();
      unsubWt();
    },
  };
}

describe("focus no-op write benchmark", () => {
  beforeEach(async () => {
    await seed();
    expect(usePanelStore.getState().panelIds).toHaveLength(PANEL_COUNT);
    initStoreOrchestrator();
    saveMock.mockClear();
    paneRenders = 0;
  });
  afterEach(() => {
    destroyStoreOrchestrator();
  });

  it(`re-clicking the focused pane ${CLICKS}x with ${PANEL_COUNT} panels`, () => {
    render(
      <>
        {ids.map((id) => (
          <FakePane key={id} id={id} />
        ))}
      </>
    );
    act(() => usePanelStore.getState().setFocused(FIRST));
    saveMock.mockClear();
    paneRenders = 0;
    const c = counters();
    const t0 = performance.now();
    for (let i = 0; i < CLICKS; i++) {
      act(() => usePanelStore.getState().setFocused(FIRST));
    }
    const ms = performance.now() - t0;
    const r = c.read();
    c.dispose();
    process.stdout.write(
      `[bench:refocus] paneRenders=${paneRenders} saveCalls=${saveMock.mock.calls.length} ` +
        `panelsByIdChanges=${r.panelsByIdChanges} panelNotifications=${r.panelNotifications} ` +
        `worktreeNotifications=${r.worktreeNotifications} ms=${ms.toFixed(2)}` +
        "\n"
    );
    expect(usePanelStore.getState().focusedId).toBe(FIRST);
    expect(paneRenders).toBe(0);
    expect(saveMock).not.toHaveBeenCalled();
    expect(r.panelsByIdChanges).toBe(0);
    expect(r.panelNotifications).toBe(0);
  });

  it("clearing focus when nothing is focused does not notify", () => {
    const c = counters();
    for (let i = 0; i < CLICKS; i++) usePanelStore.getState().setFocused(null);
    const r = c.read();
    c.dispose();
    expect(r.panelNotifications).toBe(0);
  });

  it("re-click restamps when another panel holds a newer lastActiveAt", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      usePanelStore.getState().setFocused(FIRST);
      vi.setSystemTime(2_000);
      usePanelStore.getState().stampLastActive(SECOND);
      vi.setSystemTime(3_000);
      saveMock.mockClear();
      usePanelStore.getState().setFocused(FIRST);
      expect(usePanelStore.getState().panelsById[FIRST]!.lastActiveAt).toBe(3_000);
      expect(saveMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-click stamps a focused panel that has no lastActiveAt yet", () => {
    usePanelStore.getState().setBootFocus(FIRST);
    expect(usePanelStore.getState().panelsById[FIRST]!.lastActiveAt).toBeUndefined();
    usePanelStore.getState().setFocused(FIRST);
    expect(usePanelStore.getState().panelsById[FIRST]!.lastActiveAt).toBeTypeOf("number");
  });

  it("re-focusing a dock panel after its dock tab was cleared still reopens it", () => {
    usePanelStore.setState((s) => ({
      panelsById: { ...s.panelsById, [FIRST]: { ...s.panelsById[FIRST]!, location: "dock" } },
    }));
    usePanelStore.getState().setFocused(FIRST);
    expect(usePanelStore.getState().activeDockTerminalId).toBe(FIRST);
    usePanelStore.setState({ activeDockTerminalId: null });
    usePanelStore.getState().setFocused(FIRST);
    expect(usePanelStore.getState().activeDockTerminalId).toBe(FIRST);
  });

  it(`focus cycle across ${PANEL_COUNT} panes`, () => {
    act(() => usePanelStore.getState().setFocused(FIRST));
    const c = counters();
    for (let i = 1; i <= PANEL_COUNT; i++) {
      usePanelStore.getState().setFocused(`term-${i % PANEL_COUNT}`);
    }
    const r = c.read();
    c.dispose();
    process.stdout.write(
      `[bench:cycle] worktreeNotifications=${r.worktreeNotifications} ` +
        `worktreeSelectorRuns=${r.worktreeNotifications * WORKTREE_SELECTOR_SITES} ` +
        `panelNotifications=${r.panelNotifications}` +
        "\n"
    );
    expect(useWorktreeSelectionStore.getState().lastFocusedTerminalByWorktree.get("wt-1")).toBe(
      FIRST
    );
    expect(r.worktreeNotifications).toBe(0);
  });
});
