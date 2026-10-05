import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const state = vi.hoisted(() => ({
  runs: [] as Array<{ runId: string; spawnedAt: number; workspaceId?: string; cwd?: string }>,
  views: [] as Array<{ send: (channel: string, payload: unknown) => void }>,
  record: null as { spawnedAt: number; isExited?: boolean } | null,
  screen: "",
  writes: [] as string[],
  submits: [] as string[],
  releaseMirror: (() => {}) as () => void,
  activated: true,
  packaged: false,
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
  app: {
    getPath: () => "/tmp",
    get isPackaged() {
      return state.packaged;
    },
  },
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
vi.mock("../../../store.js", () => ({
  store: {
    get: (key: string) => (key === "canopyActivated" ? state.activated : {}),
    set: vi.fn((key: string, value: unknown) => {
      if (key === "canopyActivated") state.activated = value as boolean;
    }),
  },
}));
const gitBranch = vi.hoisted(() =>
  vi.fn(async (_path: string) => "feature/login" as string | null)
);
vi.mock("../../../utils/gitUtils.js", () => ({ getGitBranch: gitBranch }));
const canopyBackend = vi.hoisted(() => ({
  classifyWithCanopy: vi.fn(),
  describeWithCanopy: vi.fn(),
  wakeCanopy: vi.fn(),
}));
vi.mock("../../../services/canopy/canopyBackend.js", () => canopyBackend);
vi.mock("../../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils.js")>()),
  getProjectRendererTargets: vi.fn(() => state.views),
}));

import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { registerCanopyHandlers } from "../canopy.js";
import { CANOPY_METHOD_CHANNELS } from "../canopy.preload.js";

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

describe("canopy IPC", () => {
  let cleanup: () => void;

  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    state.runs = [{ runId: "run-1", spawnedAt: 100, workspaceId: "project-1" }];
    state.views = [];
    state.record = { spawnedAt: 100 };
    state.screen = MENU;
    state.writes = [];
    state.submits = [];
    state.activated = true;
    state.packaged = false;
    // No test reaches the real service, whatever the shell sets.
    vi.stubEnv("DAINTREE_CANOPY_TIER", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network is off in tests");
      })
    );
    cleanup = registerCanopyHandlers();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reads a run's branch from the folder the fleet holds for it, and nothing for a gone one", async () => {
    state.runs = [{ runId: "run-1", spawnedAt: 100, cwd: "/repo/worktrees/login" }];
    const sender = fakeSender(5);
    expect(
      await invoke(CANOPY_METHOD_CHANNELS.runBranch, sender, "run-1", { spawnedAt: 100 })
    ).toBe("feature/login");
    expect(gitBranch).toHaveBeenCalledWith("/repo/worktrees/login");

    gitBranch.mockClear();
    expect(
      await invoke(CANOPY_METHOD_CHANNELS.runBranch, sender, "run-1", { spawnedAt: 99 })
    ).toBeNull();
    expect(gitBranch).not.toHaveBeenCalled();
  });

  it("reads no branch while Canopy is off, or for an id that isn't one", async () => {
    state.runs = [{ runId: "run-1", spawnedAt: 100, cwd: "/repo" }];
    const sender = fakeSender(5);
    state.activated = false;
    expect(
      (await outcome(invoke(CANOPY_METHOD_CHANNELS.runBranch, sender, "run-1", { spawnedAt: 100 })))
        .ok
    ).toBe(false);
    state.activated = true;
    expect(
      (await outcome(invoke(CANOPY_METHOD_CHANNELS.runBranch, sender, "", { spawnedAt: 100 }))).ok
    ).toBe(false);
    expect(gitBranch).not.toHaveBeenCalled();
  });

  it("acts on no terminal until the user turns Canopy on, and keeps the choice", async () => {
    state.activated = false;
    const sender = fakeSender(5);
    const before = await outcome(
      invoke(CANOPY_METHOD_CHANNELS.answer, sender, "run-1", { spawnedAt: 100 }, "Yes")
    );
    expect(before).toEqual({ ok: false, message: expect.stringContaining("isn't turned on") });
    expect(state.writes).toEqual([]);

    const turnedOn = (await invoke(CANOPY_METHOD_CHANNELS.activate, sender, true)) as {
      data?: { activated: boolean; tier: string };
      activated?: boolean;
    };
    expect((turnedOn.data ?? turnedOn).activated).toBe(true);
    expect(state.activated).toBe(true);
    // Free during the beta.
    expect((turnedOn.data ?? (turnedOn as { tier: string })).tier).toBe("free");
    const after = await outcome(
      invoke(CANOPY_METHOD_CHANNELS.answer, sender, "run-1", { spawnedAt: 100 }, "Yes")
    );
    expect(after.ok).toBe(true);
  });

  it("wakes the service when a panel opens on Canopy turned on, and not before", async () => {
    state.activated = false;
    const sender = fakeSender(9);
    await invoke(CANOPY_METHOD_CHANNELS.setActive, sender, true);
    expect(canopyBackend.wakeCanopy).not.toHaveBeenCalled();
    await invoke(CANOPY_METHOD_CHANNELS.activate, sender, true);
    expect(canopyBackend.wakeCanopy).toHaveBeenCalledTimes(1);
    await invoke(CANOPY_METHOD_CHANNELS.setActive, sender, true);
    expect(canopyBackend.wakeCanopy).toHaveBeenCalledTimes(2);
  });

  it("refuses every action on a terminal while Canopy is off", async () => {
    state.activated = false;
    const sender = fakeSender(4);
    const refused = await Promise.all([
      outcome(invoke(CANOPY_METHOD_CHANNELS.answer, sender, "run-1", { spawnedAt: 100 }, "Yes")),
      outcome(invoke(CANOPY_METHOD_CHANNELS.watchTerminal, sender, "run-1", { spawnedAt: 100 })),
      outcome(invoke(CANOPY_METHOD_CHANNELS.trash, sender, "run-1", { spawnedAt: 100 })),
      outcome(invoke(CANOPY_METHOD_CHANNELS.refresh, sender)),
    ]);
    for (const result of refused) {
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Canopy isn't turned on");
    }
    expect(state.writes).toEqual([]);
    expect(ptyClient.trash).not.toHaveBeenCalled();
    expect(ptyClient.acquireIpcDataMirror).not.toHaveBeenCalled();
  });

  it("watches a view's lifecycle once however often the panel reopens", async () => {
    const sender = fakeSender(7);
    for (let i = 0; i < 15; i++) {
      await invoke(CANOPY_METHOD_CHANNELS.setActive, sender, true);
      await invoke(CANOPY_METHOD_CHANNELS.setActive, sender, false);
    }
    const destroyed = sender.once.mock.calls.filter(([event]) => event === "destroyed");
    expect(destroyed).toHaveLength(1);
  });

  it("stops watching a view whose document reloaded with the panel open", async () => {
    const sender = fakeSender(3);
    await invoke(CANOPY_METHOD_CHANNELS.setActive, sender, true);
    sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    const snapshot = await invoke(CANOPY_METHOD_CHANNELS.getSnapshot, sender);
    expect(active(snapshot)).toBe(false);
  });

  it("stays active while any view has the panel open", async () => {
    const a = fakeSender(1);
    const b = fakeSender(2);
    await invoke(CANOPY_METHOD_CHANNELS.setActive, a, true);
    await invoke(CANOPY_METHOD_CHANNELS.setActive, b, true);
    expect(active(await invoke(CANOPY_METHOD_CHANNELS.setActive, a, false))).toBe(true);
    b.emit("destroyed");
    expect(active(await invoke(CANOPY_METHOD_CHANNELS.getSnapshot, a))).toBe(false);
  });

  it("reads what every open panel shows, and every project once they're closed", async () => {
    const a = fakeSender(1);
    const b = fakeSender(2);
    const scope = async () =>
      ((await invoke(CANOPY_METHOD_CHANNELS.getSnapshot, a)) as { scope: string | null }).scope;
    await invoke(CANOPY_METHOD_CHANNELS.setScope, a, "p1");
    await invoke(CANOPY_METHOD_CHANNELS.setScope, b, "p2");
    await invoke(CANOPY_METHOD_CHANNELS.setActive, a, true);
    expect(await scope()).toBe("p1");
    // Two panels on different projects: both are read, each shows its own.
    await invoke(CANOPY_METHOD_CHANNELS.setActive, b, true);
    expect(await scope()).toBeNull();
    await invoke(CANOPY_METHOD_CHANNELS.setActive, b, false);
    expect(await scope()).toBe("p1");
    // The background watch lights the toolbar for every project.
    await invoke(CANOPY_METHOD_CHANNELS.setActive, a, false);
    expect(await scope()).toBeNull();
  });

  it("won't trash a terminal respawned under the same id", async () => {
    state.record = { spawnedAt: 200 };
    const result = await outcome(
      invoke(CANOPY_METHOD_CHANNELS.trash, fakeSender(1), "run-1", { spawnedAt: 100 })
    );
    expect(result.ok).toBe(false);
    expect(ptyClient.trash).not.toHaveBeenCalled();
  });

  it("trashes on the host and asks the project's views to move the pane to the trash", async () => {
    const view = { send: vi.fn() };
    state.views = [view];
    const result = await outcome(
      invoke(CANOPY_METHOD_CHANNELS.trash, fakeSender(1), "run-1", { spawnedAt: 100 })
    );
    expect(result.ok).toBe(true);
    expect(ptyClient.trash).toHaveBeenCalledWith("run-1");
    expect(view.send).toHaveBeenCalledWith("canopy:trash-requested", { runId: "run-1" });
  });

  it("streams a run's terminal only for the incarnation the card was built from", async () => {
    state.record = { spawnedAt: 200 };
    const result = await outcome(
      invoke(CANOPY_METHOD_CHANNELS.watchTerminal, fakeSender(1), "run-1", { spawnedAt: 100 })
    );
    expect(result.ok).toBe(false);
    expect(ptyClient.acquireIpcDataMirror).not.toHaveBeenCalled();
  });

  it("ends a view's stream when the view reloads", async () => {
    const release = vi.fn();
    state.releaseMirror = release;
    const sender = fakeSender(9);
    await invoke(CANOPY_METHOD_CHANNELS.watchTerminal, sender, "run-1", { spawnedAt: 100 });
    expect(ptyClient.acquireIpcDataMirror).toHaveBeenCalledWith("run-1");
    sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(release).toHaveBeenCalledTimes(1);
  });

  describe("input through a stream", () => {
    async function openStream(sender = fakeSender(4)) {
      const view = (await invoke(CANOPY_METHOD_CHANNELS.watchTerminal, sender, "run-1", {
        spawnedAt: 100,
      })) as { data?: { watchId: number }; watchId?: number };
      return { sender, watchId: (view.data ?? view).watchId! };
    }

    it("types, presses keys and submits to the terminal the stream is for", async () => {
      const { sender, watchId } = await openStream();
      await invoke(CANOPY_METHOD_CHANNELS.terminalInput, sender, watchId, "y");
      await invoke(CANOPY_METHOD_CHANNELS.terminalSendKey, sender, watchId, "escape");
      await invoke(CANOPY_METHOD_CHANNELS.terminalSubmit, sender, watchId, "navy");
      expect(state.writes).toEqual(["y"]);
      expect(ptyClient.sendKey).toHaveBeenCalledWith("run-1", "escape");
      expect(state.submits).toEqual(["navy"]);
    });

    it("refuses input for a stream the view no longer holds", async () => {
      const { sender, watchId } = await openStream();
      await invoke(CANOPY_METHOD_CHANNELS.unwatchTerminal, sender);
      const typed = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.terminalInput, sender, watchId, "y")
      );
      const otherView = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.terminalInput, fakeSender(5), watchId, "y")
      );
      expect(typed.ok).toBe(false);
      expect(otherView.ok).toBe(false);
      expect(state.writes).toEqual([]);
    });

    it("never submits to a terminal respawned under the stream's id", async () => {
      const { sender, watchId } = await openStream();
      state.record = { spawnedAt: 200 };
      const result = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.terminalSubmit, sender, watchId, "navy")
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
      const pending = invoke(CANOPY_METHOD_CHANNELS.watchTerminal, sender, "run-1", {
        spawnedAt: 100,
      });
      await invoke(CANOPY_METHOD_CHANNELS.unwatchTerminal, sender);
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
