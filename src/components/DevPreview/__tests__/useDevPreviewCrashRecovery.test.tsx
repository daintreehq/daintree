/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const notifyMock = vi.fn();
vi.mock("@/lib/notify", () => ({ notify: (...args: unknown[]) => notifyMock(...args) }));

import { useDevPreviewCrashRecovery } from "../useDevPreviewCrashRecovery";

const PANE_ID = "pane-1";

let unresponsiveCb: ((data: { panelId: string }) => void) | undefined;
let responsiveCb: ((data: { panelId: string }) => void) | undefined;
const offUnresponsive = vi.fn();
const offResponsive = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  unresponsiveCb = undefined;
  responsiveCb = undefined;
  (window as unknown as { electron: Record<string, unknown> }).electron = {
    webview: {
      onUnresponsive: vi.fn((cb: (data: { panelId: string }) => void) => {
        unresponsiveCb = cb;
        return offUnresponsive;
      }),
      onResponsive: vi.fn((cb: (data: { panelId: string }) => void) => {
        responsiveCb = cb;
        return offResponsive;
      }),
    },
  };
});

function renderCrashRecovery(currentUrl = "http://localhost:3000/page") {
  const crashReloadRef = { current: vi.fn() };
  const view = renderHook(
    ({ url }) =>
      useDevPreviewCrashRecovery({
        id: PANE_ID,
        currentUrl: url,
        crashReloadRef,
      }),
    { initialProps: { url: currentUrl } }
  );
  return { ...view, crashReloadRef };
}

describe("useDevPreviewCrashRecovery — render-process-gone handling", () => {
  it("auto-reloads via crashReloadRef on the first crash within the 60s window", () => {
    const { result, crashReloadRef } = renderCrashRecovery();

    act(() => {
      result.current.handleRenderProcessGone({ reason: "crashed", exitCode: 1 });
    });

    expect(result.current.crashState).toBe("crashed");
    expect(result.current.crashDetails).toEqual({ reason: "crashed", exitCode: 1 });
    expect(crashReloadRef.current).toHaveBeenCalledTimes(1);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("stops auto-reloading and notifies on a second crash within 60 seconds", () => {
    const { result, crashReloadRef } = renderCrashRecovery();

    act(() => {
      result.current.handleRenderProcessGone({ reason: "crashed", exitCode: 1 });
    });
    act(() => {
      result.current.handleRenderProcessGone({ reason: "crashed", exitCode: 1 });
    });

    expect(crashReloadRef.current).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ supersedeKey: `dev-preview-crash-loop:${PANE_ID}` })
    );
  });

  it("reads crashReloadRef.current lazily, so a ref populated after the hook renders still fires", () => {
    const { result, crashReloadRef } = renderCrashRecovery();
    // Simulate the parent's separate sync effect assigning performReload later.
    const laterReload = vi.fn();
    crashReloadRef.current = laterReload;

    act(() => {
      result.current.handleRenderProcessGone({ reason: "crashed", exitCode: 1 });
    });

    expect(laterReload).toHaveBeenCalledTimes(1);
  });
});

describe("useDevPreviewCrashRecovery — unresponsive/responsive listeners", () => {
  it("sets unresponsive on a matching panelId event", () => {
    const { result } = renderCrashRecovery();
    act(() => {
      unresponsiveCb?.({ panelId: PANE_ID });
    });
    expect(result.current.crashState).toBe("unresponsive");
  });

  it("ignores unresponsive/responsive events for a different panelId", () => {
    const { result } = renderCrashRecovery();
    act(() => {
      unresponsiveCb?.({ panelId: "other-pane" });
    });
    expect(result.current.crashState).toBe("none");
  });

  it("does not downgrade a crashed state to unresponsive", () => {
    const { result } = renderCrashRecovery();
    act(() => {
      result.current.handleRenderProcessGone({ reason: "crashed", exitCode: 1 });
    });
    act(() => {
      unresponsiveCb?.({ panelId: PANE_ID });
    });
    expect(result.current.crashState).toBe("crashed");
  });

  it("clears back to none on a matching responsive event", () => {
    const { result } = renderCrashRecovery();
    act(() => {
      unresponsiveCb?.({ panelId: PANE_ID });
    });
    act(() => {
      responsiveCb?.({ panelId: PANE_ID });
    });
    expect(result.current.crashState).toBe("none");
  });

  it("does not clear a crashed state via a responsive event", () => {
    const { result } = renderCrashRecovery();
    act(() => {
      result.current.handleRenderProcessGone({ reason: "crashed", exitCode: 1 });
    });
    act(() => {
      responsiveCb?.({ panelId: PANE_ID });
    });
    expect(result.current.crashState).toBe("crashed");
  });

  it("unsubscribes both listeners on unmount", () => {
    const { unmount } = renderCrashRecovery();
    unmount();
    expect(offUnresponsive).toHaveBeenCalledTimes(1);
    expect(offResponsive).toHaveBeenCalledTimes(1);
  });
});

describe("useDevPreviewCrashRecovery — reset helpers", () => {
  it("resetCrashHistory clears state, details, and the crash timestamp history", () => {
    const { result, crashReloadRef } = renderCrashRecovery();
    act(() => {
      result.current.handleRenderProcessGone({ reason: "crashed", exitCode: 1 });
    });
    act(() => {
      result.current.resetCrashHistory();
    });
    expect(result.current.crashState).toBe("none");
    expect(result.current.crashDetails).toBeNull();

    // Timestamp history was cleared too: a subsequent crash is treated as
    // the first one again (auto-reload fires instead of the loop notice).
    act(() => {
      result.current.handleRenderProcessGone({ reason: "crashed", exitCode: 1 });
    });
    expect(crashReloadRef.current).toHaveBeenCalledTimes(2);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("clearUnresponsiveState only clears crashState, not crashDetails or history", () => {
    const { result, crashReloadRef } = renderCrashRecovery();
    act(() => {
      result.current.handleRenderProcessGone({ reason: "crashed", exitCode: 1 });
    });
    act(() => {
      result.current.clearUnresponsiveState();
    });
    expect(result.current.crashState).toBe("none");

    // Crash history was NOT cleared: a second crash within 60s still trips
    // the crash-loop notice instead of auto-reloading again.
    act(() => {
      result.current.handleRenderProcessGone({ reason: "crashed", exitCode: 1 });
    });
    expect(crashReloadRef.current).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });
});

describe("useDevPreviewCrashRecovery — URL-transition clearing", () => {
  it("clears crash state on a genuine URL transition", () => {
    const { result, rerender } = renderCrashRecovery("http://localhost:3000/a");
    act(() => {
      result.current.handleRenderProcessGone({ reason: "crashed", exitCode: 1 });
    });
    expect(result.current.crashState).toBe("crashed");

    rerender({ url: "http://localhost:3000/b" });
    expect(result.current.crashState).toBe("none");
  });

  it("does not clear crash state when the URL is unchanged (no reset loop)", () => {
    const { result, rerender } = renderCrashRecovery("http://localhost:3000/a");
    act(() => {
      result.current.handleRenderProcessGone({ reason: "crashed", exitCode: 1 });
    });
    rerender({ url: "http://localhost:3000/a" });
    expect(result.current.crashState).toBe("crashed");
  });

  it("does not clear crash state on a transition to about:blank", () => {
    const { result, rerender } = renderCrashRecovery("http://localhost:3000/a");
    act(() => {
      result.current.handleRenderProcessGone({ reason: "crashed", exitCode: 1 });
    });
    rerender({ url: "about:blank" });
    expect(result.current.crashState).toBe("crashed");
  });
});
