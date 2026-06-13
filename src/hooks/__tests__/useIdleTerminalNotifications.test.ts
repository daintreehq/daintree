// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { IdleTerminalNotifyPayload } from "@shared/types";

const notifyMock = vi.fn();
vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => notifyMock(...args),
}));

const onNotifyMock = vi.fn();
const unsubscribeMock = vi.fn();
let captured: ((payload: IdleTerminalNotifyPayload) => void) | null = null;

function load() {
  return import("../useIdleTerminalNotifications");
}

describe("useIdleTerminalNotifications", () => {
  beforeEach(() => {
    vi.resetModules();
    notifyMock.mockClear();
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

  // The listener is an app-lifetime singleton; tearing it down on unmount would
  // silently kill notifications since the latch is never reset.
  it("does not unsubscribe on unmount", async () => {
    const { useIdleTerminalNotifications } = await load();

    const { unmount } = renderHook(() => useIdleTerminalNotifications());
    unmount();

    expect(unsubscribeMock).not.toHaveBeenCalled();
  });

  it("emits one notification carrying the idle coalesce key", async () => {
    const { useIdleTerminalNotifications } = await load();
    renderHook(() => useIdleTerminalNotifications());

    act(() => {
      captured!({
        projects: [{ projectId: "p1", projectName: "Acme", terminalCount: 2, idleMinutes: 5 }],
        timestamp: 0,
      });
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        coalesce: expect.objectContaining({ key: "idle-terminal-notify:projects" }),
      })
    );
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
