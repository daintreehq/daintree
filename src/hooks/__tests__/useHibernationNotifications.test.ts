// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { HibernationProjectHibernatedPayload } from "@shared/types";

const notifyMock = vi.fn();
vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => notifyMock(...args),
}));

const onHibernatedMock = vi.fn();
const unsubscribeMock = vi.fn();
let captured: ((payload: HibernationProjectHibernatedPayload) => void) | null = null;

function load() {
  return import("../useHibernationNotifications");
}

describe("useHibernationNotifications", () => {
  beforeEach(() => {
    vi.resetModules();
    notifyMock.mockClear();
    onHibernatedMock.mockReset();
    unsubscribeMock.mockReset();
    captured = null;
    onHibernatedMock.mockImplementation(
      (cb: (payload: HibernationProjectHibernatedPayload) => void) => {
        captured = cb;
        return unsubscribeMock;
      }
    );

    window.electron = {
      hibernation: {
        onProjectHibernated: onHibernatedMock,
      },
    } as unknown as typeof window.electron;
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
  });

  // #10455: a remount must not register a second IPC listener.
  it("subscribes exactly once across mount → unmount → remount", async () => {
    const { useHibernationNotifications } = await load();

    const first = renderHook(() => useHibernationNotifications());
    expect(onHibernatedMock).toHaveBeenCalledTimes(1);

    first.unmount();
    renderHook(() => useHibernationNotifications());
    renderHook(() => useHibernationNotifications());

    expect(onHibernatedMock).toHaveBeenCalledTimes(1);
  });

  it("does not unsubscribe on unmount", async () => {
    const { useHibernationNotifications } = await load();

    const { unmount } = renderHook(() => useHibernationNotifications());
    unmount();

    expect(unsubscribeMock).not.toHaveBeenCalled();
  });

  it("emits one notification carrying the hibernation coalesce key", async () => {
    const { useHibernationNotifications } = await load();
    renderHook(() => useHibernationNotifications());

    act(() => {
      captured!({
        projectId: "p1",
        projectName: "Acme",
        terminalsKilled: 3,
        reason: "memory-pressure",
        timestamp: 0,
      });
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        coalesce: expect.objectContaining({ key: "hibernation:project" }),
      })
    );
  });

  it("does not subscribe when Electron is unavailable", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
    const { useHibernationNotifications } = await load();

    expect(() => renderHook(() => useHibernationNotifications())).not.toThrow();
    expect(onHibernatedMock).not.toHaveBeenCalled();
  });
});
