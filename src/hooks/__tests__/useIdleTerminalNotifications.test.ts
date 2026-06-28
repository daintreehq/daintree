// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { IdleTerminalNotifyPayload } from "@shared/types";

interface NotifyArg {
  priority?: string;
  supersedeKey?: string;
  context?: { projectId?: string };
  coalesce?: unknown;
  actions?: Array<{ actionId?: string; actionArgs?: Record<string, unknown> }>;
}

// Capture each notify() payload into a typed array so assertions read real
// fields without an unsafe `as` cast off the loosely-typed mock.calls tuple.
const notifyCalls: NotifyArg[] = [];
const notifyMock = vi.fn((payload: NotifyArg) => {
  notifyCalls.push(payload);
});
vi.mock("@/lib/notify", () => ({
  notify: (payload: NotifyArg) => notifyMock(payload),
}));

const onNotifyMock = vi.fn();
const unsubscribeMock = vi.fn();
let captured: ((payload: IdleTerminalNotifyPayload) => void) | null = null;

function notifyArg(n: number): NotifyArg {
  const payload = notifyCalls[n];
  if (!payload) throw new Error(`expected a notify call at index ${n}`);
  return payload;
}

function load() {
  return import("../useIdleTerminalNotifications");
}

describe("useIdleTerminalNotifications", () => {
  beforeEach(() => {
    vi.resetModules();
    notifyMock.mockClear();
    notifyCalls.length = 0;
    onNotifyMock.mockReset();
    unsubscribeMock.mockReset();
    captured = null;
    onNotifyMock.mockImplementation((cb: (payload: IdleTerminalNotifyPayload) => void) => {
      captured = cb;
      return unsubscribeMock;
    });

    window.electron = {
      idleTerminals: {
        onNotify: onNotifyMock,
        closeProject: vi.fn(),
        dismissProject: vi.fn(),
      },
    } as unknown as typeof window.electron;
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
  });

  // #10455: a PostHydrationListeners remount must not register a second IPC
  // listener — the module latch is one-way and is never reset on unmount.
  it("subscribes exactly once across mount → unmount → remount", async () => {
    const { useIdleTerminalNotifications } = await load();

    const first = renderHook(() => useIdleTerminalNotifications());
    expect(onNotifyMock).toHaveBeenCalledTimes(1);

    first.unmount();
    renderHook(() => useIdleTerminalNotifications());
    renderHook(() => useIdleTerminalNotifications());

    expect(onNotifyMock).toHaveBeenCalledTimes(1);
  });

  // The surviving single listener must still deliver exactly one notification
  // after a remount cycle — guards against the duplicate-toast regression while
  // proving the listener is not torn down.
  it("delivers exactly one notification after a remount cycle", async () => {
    const { useIdleTerminalNotifications } = await load();

    const first = renderHook(() => useIdleTerminalNotifications());
    first.unmount();
    renderHook(() => useIdleTerminalNotifications());

    act(() => {
      captured!({
        projects: [{ projectId: "p1", projectName: "Acme", terminalCount: 1, idleMinutes: 3 }],
        timestamp: 0,
      });
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  // The listener is an app-lifetime singleton; tearing it down on unmount would
  // silently kill notifications since the latch is never reset.
  it("does not unsubscribe on unmount", async () => {
    const { useIdleTerminalNotifications } = await load();

    const { unmount } = renderHook(() => useIdleTerminalNotifications());
    unmount();

    expect(unsubscribeMock).not.toHaveBeenCalled();
  });

  // Idle terminals are a passive signal — the notification must route to the
  // inbox only (priority "low", no toast) with a per-project supersedeKey so a
  // re-fire retires the prior row instead of stacking near-duplicate toasts.
  it("emits an inbox-only notification keyed per project", async () => {
    const { useIdleTerminalNotifications } = await load();
    renderHook(() => useIdleTerminalNotifications());

    act(() => {
      captured!({
        projects: [{ projectId: "p1", projectName: "Acme", terminalCount: 2, idleMinutes: 5 }],
        timestamp: 0,
      });
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = notifyArg(0);
    expect(payload).toMatchObject({
      priority: "low",
      supersedeKey: "idle-terminal:p1",
      context: { projectId: "p1" },
    });
    expect(payload.coalesce).toBeUndefined();
  });

  // Inbox rows only persist actions carrying an `actionId`; the recovery
  // affordances must be action-backed so they survive into the inbox row.
  it("attaches action-backed Close/Mute affordances carrying the projectId", async () => {
    const { useIdleTerminalNotifications } = await load();
    renderHook(() => useIdleTerminalNotifications());

    act(() => {
      captured!({
        projects: [{ projectId: "p1", projectName: "Acme", terminalCount: 1, idleMinutes: 90 }],
        timestamp: 0,
      });
    });

    const payload = notifyArg(0);
    expect(payload.actions).toEqual([
      expect.objectContaining({
        actionId: "idleTerminalNotify.closeProject",
        actionArgs: { projectId: "p1" },
      }),
      expect.objectContaining({
        actionId: "idleTerminalNotify.muteProject",
        actionArgs: { projectId: "p1" },
      }),
    ]);
  });

  // Multi-project payloads fan out to one inbox row per project, each with its
  // own supersedeKey and projectId-scoped actions — no shared aggregate row.
  it("fans out one notification per project", async () => {
    const { useIdleTerminalNotifications } = await load();
    renderHook(() => useIdleTerminalNotifications());

    act(() => {
      captured!({
        projects: [
          { projectId: "p1", projectName: "Acme", terminalCount: 1, idleMinutes: 70 },
          { projectId: "p2", projectName: "Beta", terminalCount: 3, idleMinutes: 80 },
        ],
        timestamp: 0,
      });
    });

    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(notifyArg(0)).toMatchObject({ supersedeKey: "idle-terminal:p1" });
    expect(notifyArg(1)).toMatchObject({ supersedeKey: "idle-terminal:p2" });
  });

  it("ignores payloads with no idle projects", async () => {
    const { useIdleTerminalNotifications } = await load();
    renderHook(() => useIdleTerminalNotifications());

    act(() => {
      captured!({ projects: [], timestamp: 0 });
    });

    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("does not subscribe when Electron is unavailable", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
    const { useIdleTerminalNotifications } = await load();

    expect(() => renderHook(() => useIdleTerminalNotifications())).not.toThrow();
    expect(onNotifyMock).not.toHaveBeenCalled();
  });
});
