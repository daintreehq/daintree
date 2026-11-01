import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: { sender: { id: number } }, payload: unknown) => void;

const { listeners, destroyedCallbacks, thaw } = vi.hoisted(() => ({
  listeners: new Map<string, Listener>(),
  destroyedCallbacks: new Map<number, () => void>(),
  /** Each send waits on the view's thaw, as the real `thawThenSend` does. */
  thaw: { done: Promise.resolve() as Promise<void> },
}));

vi.mock("electron", () => ({
  ipcMain: {
    on: (channel: string, listener: Listener) => listeners.set(channel, listener),
    removeListener: (channel: string) => listeners.delete(channel),
  },
}));

vi.mock("../../../utils/thawThenSend.js", () => ({
  thawThenSend: (_wc: unknown, isStillPending: () => boolean, send: () => void) => {
    void thaw.done.then(() => {
      if (isStillPending()) send();
    });
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
  _resetViewHydrationForTesting,
  _viewHydrationWaitersForTesting,
  markViewHydrated,
} from "../../../window/viewHydration.js";
import {
  _resetScheduledRunViewBridgeForTest,
  requestScheduledLaunchInView,
} from "../scheduledRunViewBridge.js";
import {
  ScheduledLaunchUnansweredError,
  type ScheduledLaunchRequest,
} from "../ScheduledRunLauncher.js";

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

/** A view; one whose state has hydrated unless `loading`. */
function view(id: number, { loading = false } = {}) {
  const wc = {
    id,
    send: vi.fn(),
    isDestroyed: () => false,
    on: vi.fn(),
    once: vi.fn(),
  } as unknown as Electron.WebContents & { send: ReturnType<typeof vi.fn> };
  if (!loading) markViewHydrated(wc);
  return wc;
}

function answer(senderId: number, payload: unknown): void {
  listeners.get(CHANNELS.SCHEDULES_LAUNCH_RESPONSE)?.({ sender: { id: senderId } }, payload);
}

beforeEach(() => {
  vi.useFakeTimers();
  thaw.done = Promise.resolve();
});

/** Lets the thaw, and the send behind it, run. */
const thawed = () => vi.advanceTimersByTimeAsync(0);

afterEach(() => {
  _resetScheduledRunViewBridgeForTest();
  _resetViewHydrationForTesting();
  vi.useRealTimers();
});

describe("requestScheduledLaunchInView", () => {
  it("asks the view to launch the run and resolves with its answer", async () => {
    const wc = view(7);
    let finishThaw: () => void = () => {};
    thaw.done = new Promise((resolve) => (finishThaw = resolve));
    const pending = requestScheduledLaunchInView(wc, request);

    // A frozen view never answers, so nothing is sent until it's thawed.
    await thawed();
    expect(wc.send).not.toHaveBeenCalled();
    finishThaw();
    await thawed();
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

  it("asks a view still loading once its state has hydrated, not before", async () => {
    const wc = view(9, { loading: true });
    const pending = requestScheduledLaunchInView(wc, request);
    await thawed();
    // Preload buffers nothing: a request sent before the bridge listens is lost.
    expect(wc.send).not.toHaveBeenCalled();

    markViewHydrated(wc);
    expect(wc.send).toHaveBeenCalledTimes(1);
    const { requestId } = wc.send.mock.calls[0][1] as { requestId: string };
    const result = { ok: true, result: { launched: true, terminalId: "terminal-1" } };
    answer(9, { requestId, result });
    await expect(pending).resolves.toEqual(result);
  });

  it("asks nothing of a view that finishes loading after the request gave up", async () => {
    const wc = view(9, { loading: true });
    const pending = requestScheduledLaunchInView(wc, request, 1_000);
    const settled = expect(pending).rejects.toBeInstanceOf(ScheduledLaunchUnansweredError);
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;

    expect(_viewHydrationWaitersForTesting()).toBe(0);
    markViewHydrated(wc);
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("reads an answer it can't make sense of as a failure", async () => {
    const wc = view(7);
    const pending = requestScheduledLaunchInView(wc, request);
    await thawed();
    const { requestId } = wc.send.mock.calls[0][1] as { requestId: string };
    answer(7, { requestId, result: "launched" });

    await expect(pending).resolves.toMatchObject({ ok: false });
  });

  it("gives up when the view doesn't answer in time, and asks nothing once it has", async () => {
    const wc = view(7);
    let finishThaw: () => void = () => {};
    thaw.done = new Promise((resolve) => (finishThaw = resolve));
    const pending = requestScheduledLaunchInView(wc, request, 1_000);
    const settled = expect(pending).rejects.toBeInstanceOf(ScheduledLaunchUnansweredError);
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;

    finishThaw();
    await thawed();
    expect(wc.send).not.toHaveBeenCalled();
    expect(destroyedCallbacks.has(7)).toBe(false);
  });

  it("gives up when the view closes, and ignores an answer after that", async () => {
    const wc = view(7);
    const pending = requestScheduledLaunchInView(wc, request);
    await thawed();
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
    const pending = requestScheduledLaunchInView(wc, request);
    const settled = expect(pending).rejects.toThrow(/disposed/);
    await thawed();
    await settled;
  });
});
