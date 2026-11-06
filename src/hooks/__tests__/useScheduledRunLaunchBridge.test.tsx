// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionDispatchOptions, ActionDispatchResult } from "@shared/types/actions";
import type {
  ScheduledLaunchViewRequest,
  ScheduledRunClosedPush,
} from "@shared/types/ipc/schedules";

const dispatch = vi.hoisted(() =>
  vi.fn<
    (id: string, args: unknown, options: ActionDispatchOptions) => Promise<ActionDispatchResult>
  >()
);

vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

const panels = vi.hoisted(() => ({
  panelsById: {} as Record<
    string,
    { id: string; kind?: string; scheduledRun?: { scheduleId: string; runId: string } }
  >,
  removePanel: vi.fn(),
}));

vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: () => panels } }));

import { useScheduledRunLaunchBridge } from "@/hooks/useScheduledRunLaunchBridge";

let requestLaunch: ((request: ScheduledLaunchViewRequest) => void) | null = null;
let runClosed: ((push: ScheduledRunClosedPush) => void) | null = null;
const sendLaunchResponse = vi.fn();
const unsubscribe = vi.fn();
const unsubscribeClosed = vi.fn();

const request: ScheduledLaunchViewRequest = {
  requestId: "request-1",
  args: { agentId: "claude", prompt: "Triage.", handback: true, requestedId: "terminal-1" },
  scheduledRun: { scheduleId: "schedule-1", runId: "run-1" },
};

beforeEach(() => {
  dispatch.mockReset();
  sendLaunchResponse.mockReset();
  unsubscribe.mockReset();
  unsubscribeClosed.mockReset();
  panels.removePanel.mockReset();
  panels.panelsById = {};
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      schedules: {
        onLaunchRequest: (cb: typeof requestLaunch) => {
          requestLaunch = cb;
          return unsubscribe;
        },
        sendLaunchResponse,
        onRunClosed: (cb: typeof runClosed) => {
          runClosed = cb;
          return unsubscribeClosed;
        },
      },
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
  requestLaunch = null;
  runClosed = null;
});

describe("useScheduledRunLaunchBridge", () => {
  it("launches with the run stamped as provenance, never as an argument, and answers", async () => {
    const result: ActionDispatchResult = {
      ok: true,
      result: { launched: true, terminalId: "terminal-1" },
    };
    dispatch.mockResolvedValue(result);
    renderHook(() => useScheduledRunLaunchBridge());

    requestLaunch?.(request);

    await vi.waitFor(() =>
      expect(sendLaunchResponse).toHaveBeenCalledWith({ requestId: "request-1", result })
    );
    expect(dispatch).toHaveBeenCalledWith("agent.launch", request.args, {
      source: "agent",
      confirmed: true,
      scheduledRun: request.scheduledRun,
    });
    expect(dispatch.mock.calls[0]![1]).not.toHaveProperty("scheduledRun");
  });

  it("answers a launch that threw as a failure carrying the reason", async () => {
    dispatch.mockRejectedValue(new Error("No project in scope"));
    renderHook(() => useScheduledRunLaunchBridge());

    requestLaunch?.(request);

    await vi.waitFor(() => expect(sendLaunchResponse).toHaveBeenCalledTimes(1));
    expect(sendLaunchResponse.mock.calls[0]![0]).toMatchObject({
      requestId: "request-1",
      result: { ok: false, error: { message: expect.stringContaining("No project in scope") } },
    });
  });

  it("stops listening when it unmounts, and doesn't answer for a launch it left", async () => {
    let finish: (result: ActionDispatchResult) => void = () => {};
    dispatch.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { unmount } = renderHook(() => useScheduledRunLaunchBridge());

    requestLaunch?.(request);
    unmount();
    finish({ ok: true, result: { launched: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribeClosed).toHaveBeenCalledTimes(1);
    expect(sendLaunchResponse).not.toHaveBeenCalled();
  });

  it("drops the pane of a run main closed to replace it, leaving its backend alone (#15980)", () => {
    panels.panelsById = {
      "terminal-1": {
        id: "terminal-1",
        scheduledRun: { scheduleId: "schedule-1", runId: "run-1" },
      },
      "terminal-2": {
        id: "terminal-2",
        scheduledRun: { scheduleId: "schedule-1", runId: "run-2" },
      },
      "terminal-3": { id: "terminal-3" },
      "browser-1": {
        id: "browser-1",
        kind: "browser",
        scheduledRun: { scheduleId: "schedule-1", runId: "run-1" },
      },
    };
    renderHook(() => useScheduledRunLaunchBridge());

    runClosed?.({ runId: "run-1", terminalId: "terminal-1" });
    // A pane under the id that holds another run, or none, isn't the closed run's.
    runClosed?.({ runId: "run-1", terminalId: "terminal-2" });
    runClosed?.({ runId: "run-1", terminalId: "terminal-3" });
    runClosed?.({ runId: "run-1", terminalId: "terminal-gone" });
    runClosed?.({ runId: "run-1", terminalId: "browser-1" });

    expect(panels.removePanel).toHaveBeenCalledExactlyOnceWith("terminal-1", {
      backendAlreadyClosed: true,
    });
  });
});
