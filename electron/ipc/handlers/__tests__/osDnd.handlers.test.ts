import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;

const ipcHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const broadcastMock = vi.hoisted(() => vi.fn());

const childProcessMock = vi.hoisted(() => {
  const pending: ExecFileCallback[] = [];
  const execFile = vi.fn(
    (_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
      pending.push(callback);
      return { kill: vi.fn() };
    }
  );
  return { execFile, execFileSync: vi.fn(), pending };
});

const notificationHandlers = vi.hoisted(() => new Map<string, () => void>());
const systemPreferencesMock = vi.hoisted(() => {
  let nextId = 1;
  return {
    subscribeNotification: vi.fn((name: string, cb: () => void): number => {
      notificationHandlers.set(name, cb);
      return nextId++;
    }),
    unsubscribeNotification: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({
  execFile: childProcessMock.execFile,
  execFileSync: childProcessMock.execFileSync,
}));

vi.mock("electron", () => ({ systemPreferences: systemPreferencesMock }));

vi.mock("../../utils.js", () => ({
  broadcastToRenderer: broadcastMock,
  typedHandle: (channel: string, handler: (...args: unknown[]) => unknown) => {
    ipcHandlers.set(channel, handler);
    return () => ipcHandlers.delete(channel);
  },
}));

import { registerOsDndHandlers } from "../osDnd.js";
import { OS_DND_METHOD_CHANNELS } from "../osDnd.preload.js";
import { CHANNELS } from "../../channels.js";
import { __resetOsDndServiceForTests } from "../../../services/OsDndService.js";
import type { HandlerDependencies } from "../../types.js";

const originalPlatform = process.platform;

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settleProbe(stdout: string): Promise<void> {
  const callback = childProcessMock.pending.shift();
  if (!callback) throw new Error("no plutil probe in flight");
  callback(null, stdout, "");
  await flush();
}

function invokeGetState(): Promise<boolean | undefined> {
  const handler = ipcHandlers.get(OS_DND_METHOD_CHANNELS.getState);
  if (!handler) throw new Error("os-dnd:get-state not registered");
  return Promise.resolve(handler()) as Promise<boolean | undefined>;
}

describe("os-dnd IPC on macOS", () => {
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    ipcHandlers.clear();
    notificationHandlers.clear();
    childProcessMock.pending.length = 0;
    vi.clearAllMocks();
    __resetOsDndServiceForTests();
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    __resetOsDndServiceForTests();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("registers without waiting on plutil and answers hydration with the probed boolean", async () => {
    cleanup = registerOsDndHandlers({} as HandlerDependencies);
    expect(childProcessMock.execFileSync).not.toHaveBeenCalled();
    expect(childProcessMock.pending).toHaveLength(1);

    let answered = false;
    const hydration = invokeGetState().then((value) => {
      answered = true;
      return value;
    });
    await flush();
    expect(answered).toBe(false);

    await settleProbe("com.apple.donotdisturb.mode.default\n");
    await expect(hydration).resolves.toBe(true);
    expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.OS_DND_STATE_CHANGED, {
      osDndActive: true,
    });
  });

  it("answers hydration with a live notification that lands while the probe is in flight", async () => {
    cleanup = registerOsDndHandlers({} as HandlerDependencies);
    const hydration = invokeGetState();

    notificationHandlers.get("_NSDoNotDisturbDisabledNotification")?.();
    await settleProbe("com.apple.focus.work\n");

    await expect(hydration).resolves.toBe(false);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.OS_DND_STATE_CHANGED, {
      osDndActive: false,
    });
  });

  it("cleanup removes the handler and stops broadcasting", async () => {
    cleanup = registerOsDndHandlers({} as HandlerDependencies);
    cleanup();
    cleanup = null;

    expect(ipcHandlers.has(OS_DND_METHOD_CHANNELS.getState)).toBe(false);
    await settleProbe("com.apple.focus.work\n");
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});
