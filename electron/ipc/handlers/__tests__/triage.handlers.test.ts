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
}));

const ptyClient = vi.hoisted(() => ({
  getTerminalAsync: vi.fn(async () => state.record),
  write: vi.fn((_id: string, data: string) => state.writes.push(data)),
  submit: vi.fn((_id: string, text: string) => state.submits.push(text)),
  trash: vi.fn(),
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
      invoke(TRIAGE_METHOD_CHANNELS.reply, fakeSender(1), "run-1", "keep going", { spawnedAt: 100 })
    );
    expect(result.ok).toBe(false);
    expect(state.submits).toEqual([]);
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

  it("refuses a reply once the question it answered has left the screen", async () => {
    state.screen = "Which database should I use?";
    const result = await outcome(
      invoke(TRIAGE_METHOD_CHANNELS.reply, fakeSender(1), "run-1", "postgres", {
        spawnedAt: 100,
        question: "Should I drop the sessions table?",
      })
    );
    expect(result.ok).toBe(false);
    expect(state.submits).toEqual([]);
  });
});
