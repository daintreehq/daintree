import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const state = vi.hoisted(() => ({
  runs: [] as Array<{ runId: string; spawnedAt: number }>,
  record: null as { spawnedAt: number; isExited?: boolean } | null,
  screen: "",
  writes: [] as string[],
  submits: [] as string[],
  releaseMirror: (() => {}) as () => void,
}));

const ptyClient = vi.hoisted(() => ({
  getTerminalAsync: vi.fn(async () => state.record),
  write: vi.fn((_id: string, data: string) => state.writes.push(data)),
  submit: vi.fn((_id: string, text: string) => state.submits.push(text)),
  sendKey: vi.fn(),
  trash: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  acquireIpcDataMirror: vi.fn(() => state.releaseMirror),
  getSerializedStateAsync: vi.fn(async () => ({ data: "screen", cols: 80, rows: 24 })),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  safeStorage: {},
  app: { getPath: () => "/tmp" },
}));
vi.mock("../../../window/serviceRefs.js", () => ({ getPtyClient: () => ptyClient }));
vi.mock("../projectCrud/index.js", () => ({
  getFleetSnapshotService: () => ({
    getLastBroadcast: () => ({ runs: state.runs, degraded: false, changedAt: 0 }),
    subscribe: () => () => {},
  }),
}));
vi.mock("../../../services/plugin/pluginTerminalScreenRead.js", () => ({
  readPluginTerminalScreen: vi.fn(async () => ({
    status: "ok",
    text: state.screen,
    lineCount: 1,
    truncated: false,
  })),
}));
vi.mock("../../../store.js", () => ({ store: { get: () => ({}), set: vi.fn() } }));

import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { registerTriageHandlers } from "../triage.js";
import { TRIAGE_METHOD_CHANNELS } from "../triage.preload.js";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function fakeSender(id: number) {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const add = vi.fn((event: string, fn: (...args: unknown[]) => void) => {
    handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    return sender;
  });
  const sender = {
    id,
    on: add,
    once: add,
    removeListener: vi.fn(),
    emit: (event: string, ...args: unknown[]) => handlers.get(event)?.forEach((fn) => fn(...args)),
    isDestroyed: () => false,
  };
  return sender;
}

function invoke(channel: string, sender: unknown, ...args: unknown[]) {
  const handler = ipcHandlers.get(channel) as Handler;
  return handler({ sender } as unknown as Electron.IpcMainInvokeEvent, ...args);
}

/** Handlers answer `{ ok, data }` or `{ ok: false, error }` envelopes. */
async function outcome(promise: Promise<unknown>): Promise<{ ok: boolean; message: string }> {
  try {
    const result = (await promise) as { ok?: boolean; error?: { message?: string } };
    if (result && result.ok === false) return { ok: false, message: result.error?.message ?? "" };
    return { ok: true, message: "" };
  } catch (error) {
    return { ok: false, message: formatErrorMessage(error, "") };
  }
}

function active(result: unknown): boolean {
  const envelope = result as { data?: { active: boolean }; active?: boolean };
  return (envelope.data ?? envelope).active === true;
}

const MENU = "Do you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently";

describe("triage IPC", () => {
  let cleanup: () => void;

  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    state.runs = [{ runId: "run-1", spawnedAt: 100 }];
    state.record = { spawnedAt: 100 };
    state.screen = MENU;
    state.writes = [];
    state.submits = [];
    cleanup = registerTriageHandlers();
  });

  afterEach(() => cleanup());

  it("watches a view's lifecycle once however often the panel reopens", async () => {
    const sender = fakeSender(7);
    for (let i = 0; i < 15; i++) {
      await invoke(TRIAGE_METHOD_CHANNELS.setActive, sender, true);
      await invoke(TRIAGE_METHOD_CHANNELS.setActive, sender, false);
    }
    const destroyed = sender.once.mock.calls.filter(([event]) => event === "destroyed");
    expect(destroyed).toHaveLength(1);
  });

  it("stops watching a view whose document reloaded with the panel open", async () => {
    const sender = fakeSender(3);
    await invoke(TRIAGE_METHOD_CHANNELS.setActive, sender, true);
    sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    const snapshot = await invoke(TRIAGE_METHOD_CHANNELS.getSnapshot, sender);
    expect(active(snapshot)).toBe(false);
  });

  it("stays active while any view has the panel open", async () => {
    const a = fakeSender(1);
    const b = fakeSender(2);
    await invoke(TRIAGE_METHOD_CHANNELS.setActive, a, true);
    await invoke(TRIAGE_METHOD_CHANNELS.setActive, b, true);
    expect(active(await invoke(TRIAGE_METHOD_CHANNELS.setActive, a, false))).toBe(true);
    b.emit("destroyed");
    expect(active(await invoke(TRIAGE_METHOD_CHANNELS.getSnapshot, a))).toBe(false);
  });

  it("answers a menu option by moving to it and pressing Enter", async () => {
    const result = await outcome(
      invoke(TRIAGE_METHOD_CHANNELS.choose, fakeSender(1), "run-1", "No, and tell Claude", {
        spawnedAt: 100,
        question: "Do you want to proceed?",
      })
    );
    expect(result.ok).toBe(true);
    expect(state.writes).toEqual(["\x1b[B", "\r"]);
  });

  it("refuses to answer once the question on screen has changed", async () => {
    state.screen = "Deploy to production?\n❯ 1. Yes\n  2. No";
    const result = await outcome(
      invoke(TRIAGE_METHOD_CHANNELS.choose, fakeSender(1), "run-1", "Yes", {
        spawnedAt: 100,
        question: "Do you want to proceed?",
      })
    );
    expect(result.ok).toBe(false);
    expect(state.writes).toEqual([]);
  });

  it("refuses a terminal respawned under the same id", async () => {
    state.record = { spawnedAt: 200 };
    const result = await outcome(
      invoke(TRIAGE_METHOD_CHANNELS.choose, fakeSender(1), "run-1", "Yes", { spawnedAt: 100 })
    );
    expect(result.ok).toBe(false);
    expect(state.writes).toEqual([]);
  });

  it("refuses a second answer while the first is still being typed", async () => {
    const sender = fakeSender(1);
    const target = { spawnedAt: 100, question: "Do you want to proceed?" };
    const first = invoke(TRIAGE_METHOD_CHANNELS.choose, sender, "run-1", "No, and tell", target);
    const second = await outcome(
      invoke(TRIAGE_METHOD_CHANNELS.choose, sender, "run-1", "No, and tell", target)
    );
    expect(second.ok).toBe(false);
    await first;
    expect(state.writes).toEqual(["\x1b[B", "\r"]);
  });

  it("never repeats the option label in an error", async () => {
    const result = await outcome(
      invoke(TRIAGE_METHOD_CHANNELS.choose, fakeSender(1), "run-1", "Ship customer-data-export", {
        spawnedAt: 100,
      })
    );
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("customer-data-export");
  });

  it("streams a run's terminal only for the incarnation the card was built from", async () => {
    state.record = { spawnedAt: 200 };
    const result = await outcome(
      invoke(TRIAGE_METHOD_CHANNELS.watchTerminal, fakeSender(1), "run-1", { spawnedAt: 100 })
    );
    expect(result.ok).toBe(false);
    expect(ptyClient.acquireIpcDataMirror).not.toHaveBeenCalled();
  });

  it("ends a view's stream when the view reloads", async () => {
    const release = vi.fn();
    state.releaseMirror = release;
    const sender = fakeSender(9);
    await invoke(TRIAGE_METHOD_CHANNELS.watchTerminal, sender, "run-1", { spawnedAt: 100 });
    expect(ptyClient.acquireIpcDataMirror).toHaveBeenCalledWith("run-1");
    sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(release).toHaveBeenCalledTimes(1);
  });

  describe("input through a stream", () => {
    async function openStream(sender = fakeSender(4)) {
      const view = (await invoke(TRIAGE_METHOD_CHANNELS.watchTerminal, sender, "run-1", {
        spawnedAt: 100,
      })) as { data?: { watchId: number }; watchId?: number };
      return { sender, watchId: (view.data ?? view).watchId! };
    }

    it("types, presses keys and submits to the terminal the stream is for", async () => {
      const { sender, watchId } = await openStream();
      await invoke(TRIAGE_METHOD_CHANNELS.terminalInput, sender, watchId, "y");
      await invoke(TRIAGE_METHOD_CHANNELS.terminalSendKey, sender, watchId, "escape");
      await invoke(TRIAGE_METHOD_CHANNELS.terminalSubmit, sender, watchId, "navy");
      expect(state.writes).toEqual(["y"]);
      expect(ptyClient.sendKey).toHaveBeenCalledWith("run-1", "escape");
      expect(state.submits).toEqual(["navy"]);
    });

    it("refuses input for a stream the view no longer holds", async () => {
      const { sender, watchId } = await openStream();
      await invoke(TRIAGE_METHOD_CHANNELS.unwatchTerminal, sender);
      const typed = await outcome(
        invoke(TRIAGE_METHOD_CHANNELS.terminalInput, sender, watchId, "y")
      );
      const otherView = await outcome(
        invoke(TRIAGE_METHOD_CHANNELS.terminalInput, fakeSender(5), watchId, "y")
      );
      expect(typed.ok).toBe(false);
      expect(otherView.ok).toBe(false);
      expect(state.writes).toEqual([]);
    });

    it("never submits to a terminal respawned under the stream's id", async () => {
      const { sender, watchId } = await openStream();
      state.record = { spawnedAt: 200 };
      const result = await outcome(
        invoke(TRIAGE_METHOD_CHANNELS.terminalSubmit, sender, watchId, "navy")
      );
      expect(result.ok).toBe(false);
      expect(state.submits).toEqual([]);
    });

    it("starts no stream for a request cancelled while it was being checked", async () => {
      const sender = fakeSender(6);
      let release: (value: { spawnedAt: number }) => void = () => {};
      ptyClient.getTerminalAsync.mockImplementationOnce(
        () => new Promise((resolve) => (release = resolve))
      );
      const pending = invoke(TRIAGE_METHOD_CHANNELS.watchTerminal, sender, "run-1", {
        spawnedAt: 100,
      });
      await invoke(TRIAGE_METHOD_CHANNELS.unwatchTerminal, sender);
      release({ spawnedAt: 100 });
      const view = (await pending) as {
        data?: { watchId: number | null };
        watchId?: number | null;
      };
      expect((view.data ?? view).watchId).toBeNull();
      expect(ptyClient.acquireIpcDataMirror).not.toHaveBeenCalled();
    });
  });
});
