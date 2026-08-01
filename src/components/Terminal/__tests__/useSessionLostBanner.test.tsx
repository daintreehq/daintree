// @vitest-environment jsdom
/**
 * Regression guard for #11589. The grid renders only the active worktree's
 * panels, so switching worktrees unmounts a pane outright. These tests drive
 * the acknowledgement through a real store-connected render and then unmount
 * and remount it — the sequence that used to resurrect the banner when the
 * dismissal lived in `TerminalPane` component state.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { isPtyPanel, type PanelInstance, type PtyPanelData } from "@shared/types/panel";

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
  },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
  },
  agentSettingsClient: { get: vi.fn().mockResolvedValue({}) },
  systemClient: { getAppMetrics: vi.fn().mockResolvedValue({ totalMemoryMB: 512 }) },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
  },
}));

vi.mock("../../../store/slices/panelRegistry/persistence", async () => {
  const actual = await vi.importActual<
    typeof import("../../../store/slices/panelRegistry/persistence")
  >("../../../store/slices/panelRegistry/persistence");
  return { ...actual, saveNormalized: vi.fn() };
});

const { usePanelStore } = await import("@/store/panelStore");
const { useSessionLostBanner } = await import("../useSessionLostBanner");
const { _resetSelectorCacheForTests } = await import("@/store/slices/panelRegistry/selectors");

function panel(id: string, overrides: Partial<PtyPanelData> = {}): PanelInstance {
  return {
    id,
    kind: "terminal",
    title: id,
    cwd: "/repo",
    cols: 80,
    rows: 24,
    location: "grid",
    ...overrides,
  } as PanelInstance;
}

function seed(...panels: PanelInstance[]) {
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
  });
}

function flagOf(id: string): boolean | undefined {
  const panel = usePanelStore.getState().panelsById[id];
  return panel && isPtyPanel(panel) ? panel.sessionLostOnRestore : undefined;
}

beforeEach(() => {
  _resetSelectorCacheForTests();
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
});

describe("useSessionLostBanner", () => {
  it("reports the pane's unacknowledged signal", () => {
    seed(panel("t-1", { sessionLostOnRestore: true }));
    const { result } = renderHook(() => useSessionLostBanner("t-1"));
    expect(result.current.sessionLostOnRestore).toBe(true);
  });

  it("reports no signal for a pane that resumed cleanly", () => {
    seed(panel("t-1"));
    const { result } = renderHook(() => useSessionLostBanner("t-1"));
    expect(result.current.sessionLostOnRestore).toBe(false);
  });

  it("reports no signal for an unknown or non-PTY pane", () => {
    const browserPanel: PanelInstance = {
      id: "b-1",
      kind: "browser",
      title: "b-1",
      location: "grid",
    };
    seed(browserPanel);
    const { result: unknown } = renderHook(() => useSessionLostBanner("missing"));
    const { result: browser } = renderHook(() => useSessionLostBanner("b-1"));
    expect(unknown.current.sessionLostOnRestore).toBe(false);
    expect(browser.current.sessionLostOnRestore).toBe(false);
  });

  // The bug: this sequence is exactly what a worktree switch does to a pane.
  it("keeps the acknowledgement across an unmount and remount (#11589)", () => {
    seed(panel("t-1", { sessionLostOnRestore: true }));

    const first = renderHook(() => useSessionLostBanner("t-1"));
    expect(first.result.current.sessionLostOnRestore).toBe(true);
    act(() => first.result.current.dismiss());
    expect(first.result.current.sessionLostOnRestore).toBe(false);

    // Switch away: the pane leaves the grid entirely.
    first.unmount();

    // Switch back: a brand-new hook instance with no memory of the dismissal.
    const second = renderHook(() => useSessionLostBanner("t-1"));
    expect(second.result.current.sessionLostOnRestore).toBe(false);
  });

  it("still reports the signal on remount when it was never acknowledged", () => {
    seed(panel("t-1", { sessionLostOnRestore: true }));

    const first = renderHook(() => useSessionLostBanner("t-1"));
    first.unmount();

    const second = renderHook(() => useSessionLostBanner("t-1"));
    expect(second.result.current.sessionLostOnRestore).toBe(true);
  });

  it("acknowledges only its own pane", () => {
    seed(
      panel("t-1", { sessionLostOnRestore: true }),
      panel("t-2", { sessionLostOnRestore: true })
    );

    const { result } = renderHook(() => useSessionLostBanner("t-1"));
    act(() => result.current.dismiss());

    expect(flagOf("t-1")).toBeUndefined();
    expect(flagOf("t-2")).toBe(true);
  });

  describe("bulk dismissal gate", () => {
    it("withholds the bulk action when this is the only flagged pane", () => {
      seed(panel("t-1", { sessionLostOnRestore: true }), panel("t-2"));
      const { result } = renderHook(() => useSessionLostBanner("t-1"));
      expect(result.current.dismissAll).toBeUndefined();
    });

    it("withholds the bulk action from an unflagged pane even when others are flagged", () => {
      seed(
        panel("t-1"),
        panel("t-2", { sessionLostOnRestore: true }),
        panel("t-3", { sessionLostOnRestore: true })
      );
      const { result } = renderHook(() => useSessionLostBanner("t-1"));
      expect(result.current.dismissAll).toBeUndefined();
    });

    it("offers the bulk action once a second pane is flagged", () => {
      seed(
        panel("t-1", { sessionLostOnRestore: true }),
        panel("t-2", { sessionLostOnRestore: true })
      );
      const { result } = renderHook(() => useSessionLostBanner("t-1"));
      expect(result.current.dismissAll).toBeInstanceOf(Function);
    });

    // Panels of other worktrees aren't rendered, so a worktree-scoped bulk
    // dismissal would leave banners waiting behind a switch — the bug itself.
    it("counts flagged panes in other worktrees", () => {
      seed(
        panel("t-1", { sessionLostOnRestore: true, worktreeId: "wt-a" }),
        panel("t-2", { sessionLostOnRestore: true, worktreeId: "wt-b" })
      );
      const { result } = renderHook(() => useSessionLostBanner("t-1"));
      expect(result.current.dismissAll).toBeInstanceOf(Function);
    });

    it("clears every flagged pane and then withdraws the bulk action", () => {
      seed(
        panel("t-1", { sessionLostOnRestore: true, worktreeId: "wt-a" }),
        panel("t-2", { sessionLostOnRestore: true, worktreeId: "wt-b" }),
        panel("t-3")
      );

      const { result } = renderHook(() => useSessionLostBanner("t-1"));
      act(() => result.current.dismissAll?.());

      expect(flagOf("t-1")).toBeUndefined();
      expect(flagOf("t-2")).toBeUndefined();
      expect(result.current.sessionLostOnRestore).toBe(false);
      expect(result.current.dismissAll).toBeUndefined();
    });

    it("withdraws the bulk action when the other flagged pane is dismissed elsewhere", () => {
      seed(
        panel("t-1", { sessionLostOnRestore: true }),
        panel("t-2", { sessionLostOnRestore: true })
      );

      const { result } = renderHook(() => useSessionLostBanner("t-1"));
      expect(result.current.dismissAll).toBeInstanceOf(Function);

      act(() => usePanelStore.getState().dismissSessionLost("t-2"));

      expect(result.current.sessionLostOnRestore).toBe(true);
      expect(result.current.dismissAll).toBeUndefined();
    });
  });

  it("re-renders when the signal arrives after mount", () => {
    seed(panel("t-1"));
    const { result } = renderHook(() => useSessionLostBanner("t-1"));
    expect(result.current.sessionLostOnRestore).toBe(false);

    act(() => {
      usePanelStore.setState({
        panelsById: { "t-1": panel("t-1", { sessionLostOnRestore: true }) },
      });
    });

    expect(result.current.sessionLostOnRestore).toBe(true);
  });
});
