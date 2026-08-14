// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

interface NotifyArg {
  title?: string;
  message?: string;
  supersedeKey?: string;
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

    window.electron = {
      events: { on: onMock },
    } as unknown as typeof window.electron;
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
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
      snapshot: {
        runs: [seedRun()] as never,
        changedAt: NOW,
        degraded: false,
        lastSuccessfulAt: NOW,
      },
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
    expect(payload.action).toMatchObject({
      actionId: "pilot.openRun",
      actionArgs: { runId: "t1", workspaceId: "p1" },
    });
  });

  it("says so when the gate closed rather than finished — and still carries the note", async () => {
    const { useParkReleaseNotifications, useFleetSnapshotStore } = await load();
    useFleetSnapshotStore.setState({
      snapshot: {
        runs: [seedRun()] as never,
        changedAt: NOW,
        degraded: false,
        lastSuccessfulAt: NOW,
      },
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

  it("degrades to a generic hand-back when the run is no longer in the snapshot", async () => {
    const { useParkReleaseNotifications } = await load();
    renderHook(() => useParkReleaseNotifications());

    act(() => {
      captured!({ id: "gone", gateRunId: "g1", reason: "gate-ready", timestamp: NOW });
    });

    const payload = notifyArg(0);
    expect(payload.message).toContain("A parked agent");
    // No run means no workspace to open — an action that cannot resolve its
    // target is worse than none.
    expect(payload.action).toBeUndefined();
  });

  it("does not subscribe when Electron is unavailable", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
    const { useParkReleaseNotifications } = await load();

    expect(() => renderHook(() => useParkReleaseNotifications())).not.toThrow();
    expect(onMock).not.toHaveBeenCalled();
  });
});
