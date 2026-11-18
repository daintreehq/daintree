// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";

interface NotifyArg {
  title?: string;
  message?: string;
  supersedeKey?: string;
  historyId?: string;
  context?: { projectId?: string; panelId?: string };
  action?: { label?: string; actionId?: string; actionArgs?: Record<string, unknown> };
}

const notifyCalls: NotifyArg[] = [];
const notifyMock = vi.fn((payload: NotifyArg) => {
  notifyCalls.push(payload);
});
vi.mock("@/lib/notify", () => ({
  notify: (payload: NotifyArg) => notifyMock(payload),
}));

const dispatchMock = vi.fn();
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));

type ReleasePayload = {
  id: string;
  gateRunId: string;
  note?: string;
  reason: "gate-ready" | "gate-closed";
  timestamp: number;
};

const onMock = vi.fn();
const getSnapshotMock = vi.fn<() => Promise<unknown>>();
let captured: ((payload: ReleasePayload) => void) | null = null;

function notifyArg(n: number): NotifyArg {
  const payload = notifyCalls[n];
  if (!payload) throw new Error(`expected a notify call at index ${n}`);
  return payload;
}

async function load() {
  const [hookModule, storeModule] = await Promise.all([
    import("../useParkReleaseNotifications"),
    import("@/store/fleetSnapshotStore"),
  ]);
  return { ...hookModule, ...storeModule };
}

const NOW = 1_830_000_000_000;

function seedRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: "t1",
    workspaceId: "p1",
    spawnedAt: NOW - 3_600_000,
    cwd: "/repo",
    title: "Fix the auth redirect",
    ...overrides,
  };
}

// The rows carry only what the hook reads.
function snapshotOf(runs: Array<ReturnType<typeof seedRun>>): FleetSnapshot {
  return { runs, changedAt: NOW, degraded: false, lastSuccessfulAt: NOW } as FleetSnapshot;
}

describe("useParkReleaseNotifications", () => {
  beforeEach(() => {
    vi.resetModules();
    notifyMock.mockClear();
    notifyCalls.length = 0;
    dispatchMock.mockClear();
    onMock.mockReset();
    captured = null;
    onMock.mockImplementation((name: string, cb: (payload: ReleasePayload) => void) => {
      if (name === "terminal:park-released") captured = cb;
      return vi.fn();
    });

    getSnapshotMock.mockReset();
    getSnapshotMock.mockResolvedValue(null);
    window.electron = {
      events: { on: onMock },
      fleet: { getSnapshot: getSnapshotMock },
    } as unknown as typeof window.electron;
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
    delete window.__DAINTREE_HOST_ID__;
  });

  it("subscribes exactly once across mount → unmount → remount", async () => {
    const { useParkReleaseNotifications } = await load();

    const first = renderHook(() => useParkReleaseNotifications());
    expect(onMock).toHaveBeenCalledTimes(1);

    first.unmount();
    renderHook(() => useParkReleaseNotifications());

    expect(onMock).toHaveBeenCalledTimes(1);
  });

  it("hands the run back with its title, the note, and an Open action", async () => {
    const { useParkReleaseNotifications, useFleetSnapshotStore } = await load();
    useFleetSnapshotStore.setState({
      snapshot: snapshotOf([seedRun()]),
    });
    renderHook(() => useParkReleaseNotifications());

    act(() => {
      captured!({
        id: "t1",
        gateRunId: "g1",
        note: "resume once the migration lands",
        reason: "gate-ready",
        timestamp: NOW,
      });
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = notifyArg(0);
    // The note is the payoff — the reader must see their own words, not just
    // that "something" released.
    expect(payload.message).toContain("Fix the auth redirect");
    expect(payload.message).toContain("resume once the migration lands");
    expect(payload).toMatchObject({
      supersedeKey: "park-released:t1",
      context: { projectId: "p1", panelId: "t1" },
    });
    expect(payload.action).toMatchObject({ actionId: "pilot.openRun" });
    // Strict: a run with no worktree carries no `worktreeId` key to replay.
    expect(payload.action?.actionArgs).toStrictEqual({
      runId: "t1",
      workspaceId: "p1",
    });
    // The view's own snapshot named the run, so main was never asked.
    expect(getSnapshotMock).not.toHaveBeenCalled();
  });

  it("opens the run with its worktree, from the toast and from the inbox alike", async () => {
    // A run that exits while its project opens lands in its own worktree.
    const { useParkReleaseNotifications, useFleetSnapshotStore } = await load();
    useFleetSnapshotStore.setState({
      snapshot: snapshotOf([seedRun({ worktreeId: "/repo/wt/alpha" })]),
    });
    dispatchMock.mockResolvedValue({ ok: true });
    renderHook(() => useParkReleaseNotifications());

    act(() => {
      captured!({ id: "t1", gateRunId: "g1", reason: "gate-ready", timestamp: NOW });
    });

    const expected = { runId: "t1", workspaceId: "p1", worktreeId: "/repo/wt/alpha" };
    const action = notifyArg(0).action as {
      label: string;
      actionId: string;
      actionArgs: unknown;
      onClick: () => Promise<void>;
    };
    expect(action).toMatchObject({ label: "Open", actionId: "pilot.openRun" });
    expect(action.actionArgs).toStrictEqual(expected);
    await action.onClick();
    expect(dispatchMock).toHaveBeenCalledWith("pilot.openRun", expected);
  });

  it("says so when the gate closed rather than finished — and still carries the note", async () => {
    const { useParkReleaseNotifications, useFleetSnapshotStore } = await load();
    useFleetSnapshotStore.setState({
      snapshot: snapshotOf([seedRun()]),
    });
    renderHook(() => useParkReleaseNotifications());

    act(() => {
      captured!({
        id: "t1",
        gateRunId: "g1",
        note: "kick off the release",
        reason: "gate-closed",
        timestamp: NOW,
      });
    });

    // The note is the user's own context; a closed gate doesn't make it less
    // theirs — dropping it here would hand back a run with the "why" missing.
    expect(notifyArg(0).message).toContain("gate terminal closed");
    expect(notifyArg(0).message).toContain("kick off the release");
  });

  it("names a run its own snapshot hasn't caught up to from main's current one (#17038)", async () => {
    // A frozen view hears the release before the fleet push naming the run,
    // which waited for its thaw.
    const { useParkReleaseNotifications, useFleetSnapshotStore } = await load();
    getSnapshotMock.mockResolvedValue({
      runs: [seedRun()],
      changedAt: NOW,
      degraded: false,
      lastSuccessfulAt: NOW,
    });
    renderHook(() => useParkReleaseNotifications());

    await act(async () => {
      captured!({
        id: "t1",
        gateRunId: "g1",
        note: "ship it",
        reason: "gate-ready",
        timestamp: NOW,
      });
    });

    expect(getSnapshotMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyArg(0).message).toContain("Fix the auth redirect");
    expect(notifyArg(0).action).toMatchObject({
      actionId: "pilot.openRun",
      actionArgs: { runId: "t1", workspaceId: "p1" },
    });
    // The store stays the push path's; the pull only names the run.
    expect(useFleetSnapshotStore.getState().snapshot).toBeNull();
  });

  it("never lets a late pull supersede a newer release of the same run", async () => {
    const { useParkReleaseNotifications, useFleetSnapshotStore } = await load();
    let resolvePull!: (snapshot: unknown) => void;
    getSnapshotMock.mockReturnValueOnce(new Promise((resolve) => (resolvePull = resolve)));
    renderHook(() => useParkReleaseNotifications());

    act(() => {
      captured!({ id: "t1", gateRunId: "g1", note: "older", reason: "gate-ready", timestamp: NOW });
    });
    // The fleet push lands, then the run is parked and released again.
    useFleetSnapshotStore.setState({
      snapshot: snapshotOf([seedRun()]),
    });
    act(() => {
      captured!({ id: "t1", gateRunId: "g1", note: "newer", reason: "gate-ready", timestamp: NOW });
    });
    await act(async () => {
      resolvePull({ runs: [seedRun()], changedAt: NOW, degraded: false, lastSuccessfulAt: NOW });
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyArg(0).message).toContain("newer");
  });

  it("still hands the run back, unnamed, when main can't be asked", async () => {
    const { useParkReleaseNotifications } = await load();
    getSnapshotMock.mockRejectedValue(new Error("ipc down"));
    renderHook(() => useParkReleaseNotifications());

    await act(async () => {
      captured!({ id: "t1", gateRunId: "g1", reason: "gate-ready", timestamp: NOW });
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyArg(0).message).toContain("A parked agent");
    expect(notifyArg(0).action).toBeUndefined();
  });

  it("degrades to a generic hand-back when the run is no longer in the snapshot", async () => {
    const { useParkReleaseNotifications } = await load();
    getSnapshotMock.mockResolvedValue({
      runs: [seedRun({ runId: "other" })],
      changedAt: NOW,
      degraded: false,
      lastSuccessfulAt: NOW,
    });
    renderHook(() => useParkReleaseNotifications());

    await act(async () => {
      captured!({ id: "gone", gateRunId: "g1", reason: "gate-ready", timestamp: NOW });
    });

    const payload = notifyArg(0);
    expect(payload.message).toContain("A parked agent");
    // No run means no workspace to open — an action that cannot resolve its
    // target is worse than none.
    expect(payload.action).toBeUndefined();
  });

  // Every project view hears the release and files it under one id, whether
  // its own snapshot named the run or it had to go without (#17191).
  it("files a release under one id in every view, and a later release under another", async () => {
    const release = (timestamp: number): ReleasePayload => ({
      id: "t1",
      gateRunId: "g1",
      reason: "gate-ready",
      timestamp,
    });
    const named = await load();
    named.useFleetSnapshotStore.setState({ snapshot: snapshotOf([seedRun()]) });
    renderHook(() => named.useParkReleaseNotifications());
    act(() => captured!(release(NOW)));

    vi.resetModules();
    getSnapshotMock.mockRejectedValue(new Error("ipc down"));
    const unnamed = await load();
    renderHook(() => unnamed.useParkReleaseNotifications());
    await act(async () => captured!(release(NOW)));
    await act(async () => captured!(release(NOW + 1)));
    await act(async () => captured!({ ...release(NOW), id: "t2" }));

    vi.resetModules();
    window.__DAINTREE_HOST_ID__ = { id: "build-box" };
    const remote = await load();
    renderHook(() => remote.useParkReleaseNotifications());
    await act(async () => captured!(release(NOW)));

    expect(notifyCalls).toHaveLength(5);
    // The two views really differed: one named the run, one couldn't.
    expect(notifyArg(0).message).toContain("Fix the auth redirect");
    expect(notifyArg(1).message).toContain("A parked agent");
    expect(notifyArg(0).historyId).toBeDefined();
    expect(notifyArg(1).historyId).toBe(notifyArg(0).historyId);
    expect(notifyArg(2).historyId).not.toBe(notifyArg(0).historyId);
    expect(notifyArg(3).historyId).not.toBe(notifyArg(0).historyId);
    expect(notifyArg(4).historyId).not.toBe(notifyArg(0).historyId);
  });

  it("does not subscribe when Electron is unavailable", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
    const { useParkReleaseNotifications } = await load();

    expect(() => renderHook(() => useParkReleaseNotifications())).not.toThrow();
    expect(onMock).not.toHaveBeenCalled();
  });
});
