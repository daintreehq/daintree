// @vitest-environment jsdom
/**
 * The banner's state has to survive a worktree switch unmounting and remounting
 * the pane — that is why it lives in the panel store rather than in
 * `TerminalPane` (#11853, same reasoning as #11589). These tests drive both
 * outcomes through a real store-connected render and then remount.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { isPtyPanel, type PanelInstance, type PtyPanelData } from "@shared/types/panel";

const mockQueue = vi.fn().mockReturnValue(true);

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

vi.mock("@/services/terminal/worktreeMoveInstruction", () => ({
  queueWorktreeMoveInstruction: (...args: unknown[]) => mockQueue(...args),
}));

const worktrees = new Map<string, { id: string; path: string }>();
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (state: { worktrees: typeof worktrees }) => unknown) =>
    selector({ worktrees }),
}));

vi.mock("../../../store/slices/panelRegistry/persistence", async () => {
  const actual = await vi.importActual<
    typeof import("../../../store/slices/panelRegistry/persistence")
  >("../../../store/slices/panelRegistry/persistence");
  return { ...actual, saveNormalized: vi.fn() };
});

const { usePanelStore } = await import("@/store/panelStore");
const { useWorktreeMoveBanner } = await import("../useWorktreeMoveBanner");

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

function noticeOf(id: string): string | undefined {
  const p = usePanelStore.getState().panelsById[id];
  return p && isPtyPanel(p) ? p.worktreeMoveNotice?.destinationWorktreeId : undefined;
}

const NOTICE = { worktreeMoveNotice: { destinationWorktreeId: "wt-b" } };

beforeEach(() => {
  vi.clearAllMocks();
  mockQueue.mockReturnValue(true);
  worktrees.clear();
  worktrees.set("wt-b", { id: "wt-b", path: "/repo/wt-b" });
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
});

describe("useWorktreeMoveBanner", () => {
  it("is hidden for a pane with no pending move", () => {
    seed(panel("t-1"));
    const { result } = renderHook(() => useWorktreeMoveBanner("t-1"));
    expect(result.current.visible).toBe(false);
  });

  it("is hidden for an unknown or non-PTY pane", () => {
    seed({ id: "b-1", kind: "browser", title: "b-1", location: "grid" } as PanelInstance);
    const { result: missing } = renderHook(() => useWorktreeMoveBanner("nope"));
    const { result: browser } = renderHook(() => useWorktreeMoveBanner("b-1"));
    expect(missing.current.visible).toBe(false);
    expect(browser.current.visible).toBe(false);
  });

  it("shows the destination's current path", () => {
    seed(panel("t-1", NOTICE));
    const { result } = renderHook(() => useWorktreeMoveBanner("t-1"));
    expect(result.current.visible).toBe(true);
    expect(result.current.destinationPath).toBe("/repo/wt-b");
  });

  it("stays visible with no path when the destination worktree is gone", () => {
    // No fallback path: guessing one is how a destructive default ships (#7880).
    seed(panel("t-1", NOTICE));
    worktrees.clear();
    const { result } = renderHook(() => useWorktreeMoveBanner("t-1"));
    expect(result.current.visible).toBe(true);
    expect(result.current.destinationPath).toBeUndefined();
  });

  it("queues the instruction and hides the bar on tell", () => {
    seed(panel("t-1", NOTICE));
    const { result } = renderHook(() => useWorktreeMoveBanner("t-1"));

    act(() => result.current.tell());

    expect(mockQueue).toHaveBeenCalledWith("t-1", "wt-b");
    expect(noticeOf("t-1")).toBeUndefined();
  });

  it("leaves the bar up when the instruction cannot be queued", () => {
    // Swallowing the user's one click would be worse than showing it again.
    mockQueue.mockReturnValue(false);
    seed(panel("t-1", NOTICE));
    const { result } = renderHook(() => useWorktreeMoveBanner("t-1"));

    act(() => result.current.tell());

    expect(noticeOf("t-1")).toBe("wt-b");
  });

  it("hides the bar on dismiss without sending anything", () => {
    seed(panel("t-1", NOTICE));
    const { result } = renderHook(() => useWorktreeMoveBanner("t-1"));

    act(() => result.current.dismiss());

    expect(mockQueue).not.toHaveBeenCalled();
    expect(noticeOf("t-1")).toBeUndefined();
  });

  it("leaves nothing on the panel after a tell", () => {
    // Compliance is undetectable, so any surviving marker would sit lit forever
    // on total success. Both outcomes consume the same field.
    seed(panel("t-1", NOTICE));
    const { result } = renderHook(() => useWorktreeMoveBanner("t-1"));

    act(() => result.current.tell());

    const p = usePanelStore.getState().panelsById["t-1"];
    expect(p && isPtyPanel(p) ? p.worktreeMoveNotice : "unset").toBeUndefined();
  });

  // The bug this shape exists to prevent: a worktree switch does exactly this.
  it("keeps the answer across an unmount and remount", () => {
    seed(panel("t-1", NOTICE));

    const first = renderHook(() => useWorktreeMoveBanner("t-1"));
    expect(first.result.current.visible).toBe(true);
    act(() => first.result.current.dismiss());
    first.unmount();

    const second = renderHook(() => useWorktreeMoveBanner("t-1"));
    expect(second.result.current.visible).toBe(false);
  });

  it("keeps an unanswered bar across an unmount and remount", () => {
    seed(panel("t-1", NOTICE));

    const first = renderHook(() => useWorktreeMoveBanner("t-1"));
    first.unmount();

    const second = renderHook(() => useWorktreeMoveBanner("t-1"));
    expect(second.result.current.visible).toBe(true);
    expect(second.result.current.destinationPath).toBe("/repo/wt-b");
  });

  it("answers each pane of a moved group independently", () => {
    seed(panel("t-1", NOTICE), panel("t-2", NOTICE));

    const first = renderHook(() => useWorktreeMoveBanner("t-1"));
    act(() => first.result.current.tell());

    expect(mockQueue).toHaveBeenCalledTimes(1);
    expect(noticeOf("t-1")).toBeUndefined();
    expect(noticeOf("t-2")).toBe("wt-b");
  });
});
