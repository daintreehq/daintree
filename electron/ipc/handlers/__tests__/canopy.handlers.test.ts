import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRASH_TTL_MS } from "../../../../shared/config/trash.js";

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
  mode: "on" as string,
  packaged: false,
}));

const ptyClient = vi.hoisted(() => ({
  getTerminalAsync: vi.fn(async () => state.record),
  write: vi.fn((_id: string, data: string) => state.writes.push(data)),
  submit: vi.fn((_id: string, text: string) => state.submits.push(text)),
  sendKey: vi.fn(),
  trash: vi.fn(),
  restore: vi.fn(),
  updateTitle: vi.fn(),
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
const saved = vi.hoisted(() => ({
  state: null as { terminals: Array<{ id: string; title: string; titleMode?: string }> } | null,
}));
const projectStore = vi.hoisted(() => ({
  enqueueProjectStateUpdate: vi.fn(
    async (_projectId: string, updater: (state: unknown) => unknown) => {
      const next = await updater(saved.state);
      if (next !== null) saved.state = next as typeof saved.state;
    }
  ),
}));
vi.mock("../../../services/ProjectStore.js", () => ({ projectStore }));
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
    get: (key: string) => (key === "canopyMode" ? state.mode : {}),
    set: vi.fn((key: string, value: unknown) => {
      if (key === "canopyMode") state.mode = value as string;
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
  canopyWaking: vi.fn(() => false),
}));
vi.mock("../../../services/canopy/canopyBackend.js", () => canopyBackend);
vi.mock("../../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils.js")>()),
  getProjectRendererTargets: vi.fn(() => state.views),
}));

import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";
import { events } from "../../../services/events.js";
import { getDefaultPanelTitle } from "../../../../shared/config/panelKindRegistry.js";
import { canopyPanelsListing, registerCanopyHandlers } from "../canopy.js";
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
    state.mode = "on";
    state.packaged = false;
    // setMode is rate-limited across the file; each case starts with the window clear.
    _resetRateLimitQueuesForTest();
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
    state.mode = "unset";
    expect(
      (await outcome(invoke(CANOPY_METHOD_CHANNELS.runBranch, sender, "run-1", { spawnedAt: 100 })))
        .ok
    ).toBe(false);
    state.mode = "on";
    expect(
      (await outcome(invoke(CANOPY_METHOD_CHANNELS.runBranch, sender, "", { spawnedAt: 100 }))).ok
    ).toBe(false);
    expect(gitBranch).not.toHaveBeenCalled();
  });

  it("acts on no terminal until the user turns Canopy on, and keeps the choice", async () => {
    state.mode = "unset";
    const sender = fakeSender(5);
    const before = await outcome(
      invoke(CANOPY_METHOD_CHANNELS.answer, sender, "run-1", { spawnedAt: 100 }, "Yes")
    );
    expect(before).toEqual({ ok: false, message: expect.stringContaining("isn't turned on") });
    expect(state.writes).toEqual([]);

    const turnedOn = (await invoke(CANOPY_METHOD_CHANNELS.setMode, sender, "on")) as {
      data?: { activated: boolean; tier: string };
      activated?: boolean;
    };
    expect((turnedOn.data ?? turnedOn).activated).toBe(true);
    expect(state.mode).toBe("on");
    // Free during the beta.
    expect((turnedOn.data ?? (turnedOn as { tier: string })).tier).toBe("free");
    const after = await outcome(
      invoke(CANOPY_METHOD_CHANNELS.answer, sender, "run-1", { spawnedAt: 100 }, "Yes")
    );
    expect(after.ok).toBe(true);
  });

  it("hides Canopy, which stops reading, and shows it again only as off", async () => {
    const sender = fakeSender(5);
    const mode = (result: unknown) => {
      const envelope = result as { data?: { mode: string; activated: boolean } };
      return envelope.data ?? (result as { mode: string; activated: boolean });
    };
    const hidden = mode(await invoke(CANOPY_METHOD_CHANNELS.setMode, sender, "hidden"));
    expect(hidden).toMatchObject({ mode: "hidden", activated: false });
    expect(state.mode).toBe("hidden");
    const refused = await outcome(
      invoke(CANOPY_METHOD_CHANNELS.answer, sender, "run-1", { spawnedAt: 100 }, "Yes")
    );
    expect(refused).toEqual({ ok: false, message: expect.stringContaining("isn't turned on") });

    // Reading never starts straight from hidden: it goes through off, and the on switch.
    const straightOn = await outcome(invoke(CANOPY_METHOD_CHANNELS.setMode, sender, "on"));
    expect(straightOn.ok).toBe(false);
    expect(state.mode).toBe("hidden");

    const shown = mode(await invoke(CANOPY_METHOD_CHANNELS.setMode, sender, "unset"));
    expect(shown).toMatchObject({ mode: "unset", activated: false });
    const on = mode(await invoke(CANOPY_METHOD_CHANNELS.setMode, sender, "on"));
    expect(on).toMatchObject({ mode: "on", activated: true });
  });

  it("changes nothing for a change made against a mode revision main has moved on from", async () => {
    const sender = fakeSender(5);
    const revisionOf = (result: unknown) => {
      const envelope = result as { data?: { modeRevision: number } };
      return (envelope.data ?? (result as { modeRevision: number })).modeRevision;
    };
    const hiddenAt = revisionOf(await invoke(CANOPY_METHOD_CHANNELS.setMode, sender, "hidden"));
    // Shown and hidden again, from another view, before the first hide's Undo.
    await invoke(CANOPY_METHOD_CHANNELS.setMode, sender, "unset");
    const hiddenAgain = revisionOf(await invoke(CANOPY_METHOD_CHANNELS.setMode, sender, "hidden"));
    expect(hiddenAgain).toBe(hiddenAt + 2);

    const stale = await invoke(CANOPY_METHOD_CHANNELS.setMode, sender, "unset", hiddenAt);
    expect(revisionOf(stale)).toBe(hiddenAgain);
    expect(state.mode).toBe("hidden");

    await invoke(CANOPY_METHOD_CHANNELS.setMode, sender, "unset", hiddenAgain);
    expect(state.mode).toBe("unset");
  });

  describe("rename", () => {
    function renameView() {
      const sent: Array<{ channel: string; payload: unknown }> = [];
      state.views = [{ send: (channel, payload) => sent.push({ channel, payload }) }];
      return sent;
    }

    it("renames the terminal at the host, in its saved project, and in the views holding it", async () => {
      const sent = renameView();
      saved.state = { terminals: [{ id: "run-1", title: "Claude", titleMode: "default" }] };
      const emit = vi.spyOn(events, "emit");
      await invoke(
        CANOPY_METHOD_CHANNELS.rename,
        fakeSender(5),
        "run-1",
        { spawnedAt: 100 },
        "  auth fix  "
      );
      expect(ptyClient.updateTitle).toHaveBeenCalledWith("run-1", "auth fix", "user");
      expect(emit).toHaveBeenCalledWith(
        "terminal:title-changed",
        expect.objectContaining({ id: "run-1" })
      );
      // An evicted view restores the new name rather than the one it saved.
      expect(projectStore.enqueueProjectStateUpdate).toHaveBeenCalledWith(
        "project-1",
        expect.any(Function)
      );
      expect(saved.state?.terminals[0]).toMatchObject({ title: "auth fix", titleMode: "user" });
      expect(sent).toEqual([
        { channel: "canopy:rename-requested", payload: { runId: "run-1", title: "auth fix" } },
      ]);
      emit.mockRestore();
    });

    it("puts back the default name for an empty one", async () => {
      const sent = renameView();
      state.runs = [
        {
          runId: "run-1",
          spawnedAt: 100,
          workspaceId: "project-1",
          agentId: "claude",
          titleMode: "user",
        } as never,
      ];
      saved.state = { terminals: [{ id: "run-1", title: "auth fix", titleMode: "user" }] };
      await invoke(CANOPY_METHOD_CHANNELS.rename, fakeSender(5), "run-1", { spawnedAt: 100 }, "");
      const fallback = getDefaultPanelTitle("terminal", "claude");
      expect(ptyClient.updateTitle).toHaveBeenCalledWith("run-1", fallback, "default");
      expect(saved.state?.terminals[0]).toMatchObject({ title: fallback, titleMode: "default" });
      // The view works out its own exact default from the empty title.
      expect(sent[0]?.payload).toEqual({ runId: "run-1", title: "" });
    });

    it("names a run not yet seen as its agent after the agent it was launched as", async () => {
      renameView();
      state.runs = [
        {
          runId: "run-1",
          spawnedAt: 100,
          workspaceId: "project-1",
          launchAgentId: "codex",
          titleMode: "user",
        } as never,
      ];
      await invoke(CANOPY_METHOD_CHANNELS.rename, fakeSender(5), "run-1", { spawnedAt: 100 }, "");
      expect(ptyClient.updateTitle).toHaveBeenCalledWith(
        "run-1",
        getDefaultPanelTitle("terminal", "codex"),
        "default"
      );
    });

    it("puts back nothing for a name that is already the default", async () => {
      const sent = renameView();
      state.runs = [
        { runId: "run-1", spawnedAt: 100, workspaceId: "project-1", titleMode: "default" } as never,
      ];
      await invoke(CANOPY_METHOD_CHANNELS.rename, fakeSender(5), "run-1", { spawnedAt: 100 }, "");
      expect(ptyClient.updateTitle).not.toHaveBeenCalled();
      expect(projectStore.enqueueProjectStateUpdate).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    });

    it("answers only once the saved project has the new name", async () => {
      renameView();
      let saveDone: () => void = () => {};
      projectStore.enqueueProjectStateUpdate.mockImplementationOnce(
        () => new Promise<void>((resolve) => (saveDone = resolve))
      );
      let answered = false;
      const renaming = invoke(
        CANOPY_METHOD_CHANNELS.rename,
        fakeSender(5),
        "run-1",
        { spawnedAt: 100 },
        "x"
      ).then(() => (answered = true));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(answered).toBe(false);
      saveDone();
      await renaming;
      expect(answered).toBe(true);
    });

    it("refuses a respawned terminal, a title that isn't one, and Canopy off", async () => {
      renameView();
      const sender = fakeSender(5);
      const respawned = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.rename, sender, "run-1", { spawnedAt: 99 }, "x")
      );
      expect(respawned.ok).toBe(false);
      for (const bad of [7, null, "x".repeat(201)]) {
        expect(
          (
            await outcome(
              invoke(CANOPY_METHOD_CHANNELS.rename, sender, "run-1", { spawnedAt: 100 }, bad)
            )
          ).ok
        ).toBe(false);
      }
      state.mode = "unset";
      const off = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.rename, sender, "run-1", { spawnedAt: 100 }, "x")
      );
      expect(off.ok).toBe(false);
      expect(ptyClient.updateTitle).not.toHaveBeenCalled();
    });
  });

  it("ends every live terminal view when reading stops", async () => {
    const release = vi.fn();
    state.releaseMirror = release;
    const sender = fakeSender(9);
    await invoke(CANOPY_METHOD_CHANNELS.watchTerminal, sender, "run-1", { spawnedAt: 100 });
    expect(ptyClient.acquireIpcDataMirror).toHaveBeenCalledWith("run-1");
    await invoke(CANOPY_METHOD_CHANNELS.setMode, fakeSender(3), "hidden");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("refuses a mode that isn't one", async () => {
    const sender = fakeSender(5);
    for (const bad of [true, "off", "", null, 1]) {
      expect((await outcome(invoke(CANOPY_METHOD_CHANNELS.setMode, sender, bad))).ok).toBe(false);
    }
    for (const badRevision of ["1", 1.5, NaN]) {
      expect(
        (await outcome(invoke(CANOPY_METHOD_CHANNELS.setMode, sender, "unset", badRevision))).ok
      ).toBe(false);
    }
    expect(state.mode).toBe("on");
  });

  it("answers a hidden Canopy's snapshot without starting it", async () => {
    state.mode = "hidden";
    const sender = fakeSender(5);
    const result = (await invoke(CANOPY_METHOD_CHANNELS.getSnapshot, sender)) as {
      data?: { mode: string; cards: unknown[] };
    };
    // Sequence 0: never newer than anything a service pushes once one is made.
    expect(result.data ?? result).toMatchObject({
      sequence: 0,
      mode: "hidden",
      activated: false,
      cards: [],
    });
    // Nothing was made to show it: no service, so nothing listening to terminals.
    expect(ptyClient.on).not.toHaveBeenCalled();
  });

  it("counts only panels that list a run's project as in front of its ask", async () => {
    const all = fakeSender(21);
    const elsewhere = fakeSender(22);
    await invoke(CANOPY_METHOD_CHANNELS.setActive, all, true);
    await invoke(CANOPY_METHOD_CHANNELS.setActive, elsewhere, true);
    await invoke(CANOPY_METHOD_CHANNELS.setScope, elsewhere, "project-2");
    // A panel scoped to another project hides project-1's ask from no one.
    expect(canopyPanelsListing("project-1")).toEqual([21]);
    expect(canopyPanelsListing("project-2").sort()).toEqual([21, 22]);
  });

  it("wakes the service when a panel opens on Canopy turned on, and not before", async () => {
    state.mode = "unset";
    const sender = fakeSender(9);
    await invoke(CANOPY_METHOD_CHANNELS.setActive, sender, true);
    expect(canopyBackend.wakeCanopy).not.toHaveBeenCalled();
    await invoke(CANOPY_METHOD_CHANNELS.setMode, sender, "on");
    expect(canopyBackend.wakeCanopy).toHaveBeenCalledTimes(1);
    await invoke(CANOPY_METHOD_CHANNELS.setActive, sender, true);
    expect(canopyBackend.wakeCanopy).toHaveBeenCalledTimes(2);
  });

  it("refuses every action on a terminal while Canopy is off", async () => {
    state.mode = "unset";
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

  describe("reads", () => {
    type Mark = { runId: string; markedUnreadAt: number | null; version: number };
    /** The run's mark; a test reading one Canopy never made fails here, not on a field of nothing. */
    const readMark = async (sender: unknown): Promise<Mark> => {
      const result = (await invoke(CANOPY_METHOD_CHANNELS.getSnapshot, sender)) as {
        data?: { reads: Mark[] };
        reads?: Mark[];
      };
      const mark = (result.data ?? result).reads?.find((entry) => entry.runId === "run-1");
      expect(mark).toBeDefined();
      return mark!;
    };

    it("marks a run unread by hand and read again, for the incarnation the panel showed", async () => {
      const sender = fakeSender(1);
      expect(
        (
          await outcome(
            invoke(CANOPY_METHOD_CHANNELS.setRead, sender, "run-1", { spawnedAt: 100 }, false)
          )
        ).ok
      ).toBe(true);
      expect((await readMark(sender)).markedUnreadAt).not.toBeNull();
      await invoke(CANOPY_METHOD_CHANNELS.setRead, sender, "run-1", { spawnedAt: 100 }, true);
      expect((await readMark(sender)).markedUnreadAt).toBeNull();
    });

    it("refuses a read that names no turn a run can have", async () => {
      const sender = fakeSender(1);
      for (const turn of [-1, 1.5, "2"]) {
        const result = await outcome(
          invoke(CANOPY_METHOD_CHANNELS.setRead, sender, "run-1", { spawnedAt: 100 }, true, turn)
        );
        expect(result.ok).toBe(false);
      }
    });

    it("checks every run a bulk read names before changing any", async () => {
      const sender = fakeSender(1);
      await invoke(CANOPY_METHOD_CHANNELS.setRead, sender, "run-1", { spawnedAt: 100 }, false);
      const bad = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.markAllRead, sender, [
          { runId: "run-1", spawnedAt: 100, turn: 0 },
          { runId: "run-2", spawnedAt: 100 },
        ])
      );
      expect(bad.ok).toBe(false);
      expect((await readMark(sender)).markedUnreadAt).not.toBeNull();
      expect((await outcome(invoke(CANOPY_METHOD_CHANNELS.markAllRead, sender, "run-1"))).ok).toBe(
        false
      );
      const good = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.markAllRead, sender, [
          { runId: "run-1", spawnedAt: 100, turn: 0 },
        ])
      );
      expect(good.ok).toBe(true);
      expect((await readMark(sender)).markedUnreadAt).toBeNull();
    });

    it("puts back a mark taken back with Undo, and refuses a malformed one", async () => {
      const sender = fakeSender(1);
      const mark = {
        runId: "run-1",
        spawnedAt: 100,
        turn: 0,
        readTurn: 0,
        markedUnreadAt: 5,
        version: 0,
      };
      await invoke(CANOPY_METHOD_CHANNELS.setRead, sender, "run-1", { spawnedAt: 100 }, false);
      await invoke(CANOPY_METHOD_CHANNELS.setRead, sender, "run-1", { spawnedAt: 100 }, true);
      const left = (await readMark(sender)).version;
      await invoke(CANOPY_METHOD_CHANNELS.restoreReads, sender, [{ mark, expectVersion: left }]);
      expect((await readMark(sender)).markedUnreadAt).toBe(5);
      for (const bad of [
        { mark: { ...mark, markedUnreadAt: "x" }, expectVersion: 0 },
        // A mark set in the future would hold off every look until then.
        { mark: { ...mark, markedUnreadAt: Date.now() + 60_000 }, expectVersion: 0 },
        { mark, expectVersion: -1 },
        mark,
      ]) {
        const result = await outcome(invoke(CANOPY_METHOD_CHANNELS.restoreReads, sender, [bad]));
        expect(result.ok).toBe(false);
      }
    });

    it("hears what the user sent from a pane only while Canopy is on, and only for a run id", async () => {
      const sender = fakeSender(1);
      state.mode = "unset";
      expect((await outcome(invoke(CANOPY_METHOD_CHANNELS.noteSent, sender, "run-1"))).ok).toBe(
        true
      );
      state.mode = "on";
      expect((await outcome(invoke(CANOPY_METHOD_CHANNELS.noteSent, sender, "run-1"))).ok).toBe(
        true
      );
      expect((await outcome(invoke(CANOPY_METHOD_CHANNELS.noteSent, sender, 7))).ok).toBe(false);
    });

    it("follows a view that reports looks, so one that goes away stops looking", async () => {
      const sender = fakeSender(9);
      await invoke(CANOPY_METHOD_CHANNELS.markSeen, sender, "run-1", true);
      expect(sender.once.mock.calls.some(([event]) => event === "destroyed")).toBe(true);
      // A report that names no look is only a sighting, and watches nothing.
      const other = fakeSender(10);
      await invoke(CANOPY_METHOD_CHANNELS.markSeen, other, "run-1");
      expect(other.once).not.toHaveBeenCalled();
      const refused = await outcome(invoke(CANOPY_METHOD_CHANNELS.markSeen, other, "run-1", "yes"));
      expect(refused.ok).toBe(false);
    });
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

  /** The receipt a Canopy trash hands back, for its Undo. */
  async function trashReceipt(): Promise<number> {
    const result = (await invoke(CANOPY_METHOD_CHANNELS.trash, fakeSender(1), "run-1", {
      spawnedAt: 100,
    })) as { ok?: boolean; data?: unknown } | number;
    const receipt = typeof result === "number" ? result : result.data;
    if (typeof receipt !== "number") throw new Error(`no receipt: ${JSON.stringify(result)}`);
    return receipt;
  }

  it("takes back its own trash through the host and the project's views, once", async () => {
    const view = { send: vi.fn() };
    state.views = [view];
    const receipt = await trashReceipt();
    // Trashed, the run leaves the fleet; the receipt still knows its project.
    state.runs = [];
    const undone = await outcome(invoke(CANOPY_METHOD_CHANNELS.untrash, fakeSender(1), receipt));
    expect(undone.ok).toBe(true);
    expect(ptyClient.restore).toHaveBeenCalledWith("run-1");
    expect(view.send).toHaveBeenCalledWith("canopy:restore-requested", { runId: "run-1" });
    // A second Undo has nothing left to take back.
    const again = await outcome(invoke(CANOPY_METHOD_CHANNELS.untrash, fakeSender(1), receipt));
    expect(again.ok).toBe(false);
  });

  it("takes back its trash with Canopy turned off since, and of an agent that has exited", async () => {
    state.record = { spawnedAt: 100, isExited: true };
    const receipt = await trashReceipt();
    state.mode = "unset";
    const undone = await outcome(invoke(CANOPY_METHOD_CHANNELS.untrash, fakeSender(1), receipt));
    expect(undone.ok).toBe(true);
    expect(ptyClient.restore).toHaveBeenCalledWith("run-1");
  });

  it("keeps a newer trash's Undo through its own restore's late word, and a stale receipt's refusal", async () => {
    const first = await trashReceipt();
    await outcome(invoke(CANOPY_METHOD_CHANNELS.untrash, fakeSender(1), first));
    // Trashed again before the host's word on the first restore arrives.
    const second = await trashReceipt();
    events.emit("terminal:restored", { id: "run-1" });
    // A receipt from an older incarnation is refused without spending the newer one.
    state.record = { spawnedAt: 100 };
    const undone = await outcome(invoke(CANOPY_METHOD_CHANNELS.untrash, fakeSender(1), second));
    expect(undone.ok).toBe(true);
  });

  it("spends a receipt once the terminal is restored anywhere else", async () => {
    const receipt = await trashReceipt();
    // The grid's own Undo, say; then the same terminal is trashed again there.
    events.emit("terminal:restored", { id: "run-1" });
    const stale = await outcome(invoke(CANOPY_METHOD_CHANNELS.untrash, fakeSender(1), receipt));
    expect(stale.ok).toBe(false);
    expect(ptyClient.restore).not.toHaveBeenCalled();
  });

  it("holds back a page only for the runs a panel says it shows", async () => {
    const sender = fakeSender(31);
    await invoke(CANOPY_METHOD_CHANNELS.setActive, sender, true);
    // Open but not yet said what it lists: it holds no page back.
    expect(canopyPanelsListing("project-1", "run-1")).toEqual([]);
    await invoke(CANOPY_METHOD_CHANNELS.setShown, sender, ["run-1"]);
    expect(canopyPanelsListing("project-1", "run-1")).toEqual([31]);
    // The Unread filter hides run-1: the panel isn't in front of its ask.
    await invoke(CANOPY_METHOD_CHANNELS.setShown, sender, ["run-2"]);
    expect(canopyPanelsListing("project-1", "run-1")).toEqual([]);
    expect(canopyPanelsListing("project-1", "run-2")).toEqual([31]);
  });

  it("refuses to read again a run Canopy hasn't read", async () => {
    const result = await outcome(
      invoke(CANOPY_METHOD_CHANNELS.reread, fakeSender(1), "run-1", { spawnedAt: 100 })
    );
    expect(result.ok).toBe(false);
  });

  it("refuses a receipt it never gave, or one for a terminal respawned since", async () => {
    const unknown = await outcome(invoke(CANOPY_METHOD_CHANNELS.untrash, fakeSender(1), 999));
    expect(unknown.ok).toBe(false);
    const receipt = await trashReceipt();
    state.record = { spawnedAt: 200 };
    const respawned = await outcome(invoke(CANOPY_METHOD_CHANNELS.untrash, fakeSender(1), receipt));
    expect(respawned.ok).toBe(false);
    expect(ptyClient.restore).not.toHaveBeenCalled();
  });

  it("refuses once the trash has let the terminal go", async () => {
    vi.useFakeTimers();
    try {
      const receipt = await trashReceipt();
      vi.advanceTimersByTime(TRASH_TTL_MS + 1);
      const late = await outcome(invoke(CANOPY_METHOD_CHANNELS.untrash, fakeSender(1), receipt));
      expect(late.ok).toBe(false);
      expect(ptyClient.restore).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
