import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: { sender: { id: number } }, payload: unknown) => void;

const { listeners, destroyedCallbacks } = vi.hoisted(() => ({
  listeners: new Map<string, Listener>(),
  destroyedCallbacks: new Map<number, () => void>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    on: (channel: string, listener: Listener) => listeners.set(channel, listener),
    removeListener: (channel: string) => listeners.delete(channel),
  },
}));

vi.mock("../../../utils/thawThenSend.js", () => ({
  thawThenSend: (_wc: unknown, isStillPending: () => boolean, send: () => void) => {
    if (isStillPending()) send();
  },
}));

vi.mock("../../../window/webContentsDestroyed.js", () => ({
  onWebContentsDestroyed: (wc: { id: number }, callback: () => void) => {
    destroyedCallbacks.set(wc.id, callback);
    return () => destroyedCallbacks.delete(wc.id);
  },
}));

import { CHANNELS } from "../../../ipc/channels.js";
import {
  _resetScheduledRunViewBridgeForTest,
  requestScheduledLaunchInView,
} from "../scheduledRunViewBridge.js";
import { ScheduledLaunchUnansweredError, type ScheduledLaunchRequest } from "../ScheduledRunLauncher.js";

const request: ScheduledLaunchRequest = {
  args: {
    agentId: "claude",
    prompt: "Triage.",
    handback: true,
    presetId: null,
    worktreeId: "",
    location: "grid",
    focusPolicy: "preserve",
    requestedId: "terminal-1",
  },
  scheduledRun: { scheduleId: "schedule-1", runId: "run-1" },
};

function view(id: number) {
  return { id, send: vi.fn() } as unknown as Electron.WebContents & {
    send: ReturnType<typeof vi.fn>;
  };
}

function answer(senderId: number, payload: unknown): void {
  listeners.get(CHANNELS.SCHEDULES_LAUNCH_RESPONSE)?.({ sender: { id: senderId } }, payload);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  _resetScheduledRunViewBridgeForTest();
  vi.useRealTimers();
});

describe("requestScheduledLaunchInView", () => {
  it("asks the view to launch the run and resolves with its answer", async () => {
    const wc = view(7);
    const pending = requestScheduledLaunchInView(wc, request);

    expect(wc.send).toHaveBeenCalledWith(CHANNELS.SCHEDULES_LAUNCH_REQUEST, {
      requestId: expect.any(String),
      args: request.args,
      scheduledRun: request.scheduledRun,
    });
    const { requestId } = wc.send.mock.calls[0][1] as { requestId: string };
    const result = { ok: true, result: { launched: true, terminalId: "terminal-1" } };
    // Only the view that was asked answers for it.
    answer(8, { requestId, result: { ok: false, error: { message: "spoofed" } } });
    answer(7, { requestId, result });

    await expect(pending).resolves.toEqual(result);
    expect(destroyedCallbacks.has(7)).toBe(false);
  });

  it("reads an answer it can't make sense of as a failure", async () => {
    const wc = view(7);
    const pending = requestScheduledLaunchInView(wc, request);
    const { requestId } = wc.send.mock.calls[0][1] as { requestId: string };
    answer(7, { requestId, result: "launched" });

    await expect(pending).resolves.toMatchObject({ ok: false });
  });

  it("gives up when the view doesn't answer in time", async () => {
    const pending = requestScheduledLaunchInView(view(7), request, 1_000);
    const settled = expect(pending).rejects.toBeInstanceOf(ScheduledLaunchUnansweredError);
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
  });

  it("gives up when the view closes, and ignores an answer after that", async () => {
    const wc = view(7);
    const pending = requestScheduledLaunchInView(wc, request);
    const { requestId } = wc.send.mock.calls[0][1] as { requestId: string };

    destroyedCallbacks.get(7)?.();
    await expect(pending).rejects.toThrow(/closed/);
    expect(() => answer(7, { requestId, result: { ok: true, result: {} } })).not.toThrow();
  });

  it("gives up when the request can't be sent", async () => {
    const wc = view(7);
    wc.send.mockImplementation(() => {
      throw new Error("Render frame was disposed");
    });
    await expect(requestScheduledLaunchInView(wc, request)).rejects.toThrow(/disposed/);
  });
});
