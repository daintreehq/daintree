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
  generation: 1 as number | null,
  /** The project the pty-host's record names; null once the terminal has exited. */
  terminalProject: "project-1" as string | null,
}));

const ptyClient = vi.hoisted(() => ({
  getTerminalAsync: vi.fn(async () => state.record),
  getLiveGeneration: vi.fn((_id: string) => state.generation),
  isLiveGeneration: vi.fn((_id: string, live: number) => live === state.generation),
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
  getTerminalProjectId: vi.fn((_id: string): string | null => state.terminalProject),
  resize: vi.fn(),
}));

/** Who drives every project: this screen, another one, or nobody (no lease service at all). */
const lease = vi.hoisted(() => ({ holder: null as "self" | "other" | null }));
vi.mock("../../../services/DriveLeaseService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/DriveLeaseService.js")>()),
  peekDriveLeaseService: () =>
    lease.holder === null ? null : { isDriving: () => lease.holder === "self" },
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
  state: null as {
    terminals: Array<{ id: string; title: string; titleMode?: string; location?: string }>;
  } | null,
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
  getRunHandBackService: () => handBacks,
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
  canopyServiceUrl: vi.fn(() => "https://canopy.daintree.org"),
}));
vi.mock("../../../services/canopy/canopyBackend.js", () => canopyBackend);
const broadcasts = vi.hoisted(() => vi.fn());
const handBacks = vi.hoisted(() => ({ markRead: vi.fn(), markUnread: vi.fn() }));
vi.mock("../../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils.js")>()),
  getProjectPushTargets: vi.fn(() => state.views),
  typedBroadcast: broadcasts,
}));

import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { wrapError, wrapSuccess } from "../../../../shared/utils/ipcErrorSerialization.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";
import { events } from "../../../services/events.js";
import { getDefaultPanelTitle } from "../../../../shared/config/panelKindRegistry.js";
import { canopyPanelsListing, registerCanopyHandlers } from "../canopy.js";
import { CANOPY_METHOD_CHANNELS } from "../canopy.preload.js";
import { activeTerminalWatches } from "../canopyTerminalWatch.js";
import { getIpcDispatcher } from "../../dispatcher.js";
import type { ClientEndpoint } from "../../endpoint.js";
import { CHANNELS } from "../../channels.js";

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
    state.generation = 1;
    lease.holder = null;
    state.terminalProject = "project-1";
    saved.state = null;
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

  it.each([
    ["refresh", []],
    ["watchTerminal", ["run-1", { spawnedAt: 100 }]],
    ["terminalInput", [1, "y"]],
    ["terminalResize", [1, 80, 24]],
    ["terminalSendKey", [1, "enter"]],
    ["terminalSubmit", [1, "hi"]],
    ["trash", ["run-1", { spawnedAt: 100 }]],
    ["reread", ["run-1", { spawnedAt: 100 }]],
    ["rename", ["run-1", { spawnedAt: 100 }, "Login fix"]],
    ["archive", ["run-1", { spawnedAt: 100 }]],
    ["answer", ["run-1", { spawnedAt: 100 }, "Yes"]],
    ["unarchive", ["run-1", { spawnedAt: 100 }]],
    ["markSeen", ["run-1", true, "pane"]],
    ["setRead", ["run-1", { spawnedAt: 100 }, true]],
    ["markAllRead", [[{ runId: "run-1", spawnedAt: 100, turn: 0 }]]],
    ["restoreReads", [[]]],
    ["runBranch", ["run-1", { spawnedAt: 100 }]],
  ] as const)("refuses %s until Canopy is turned on, touching nothing", async (name, args) => {
    state.mode = "unset";
    const channel = CANOPY_METHOD_CHANNELS[name as keyof typeof CANOPY_METHOD_CHANNELS];
    const result = await outcome(invoke(channel, fakeSender(5), ...args));
    expect(result).toEqual({ ok: false, message: expect.stringContaining("isn't turned on") });
    expect(state.writes).toEqual([]);
    expect(state.submits).toEqual([]);
    for (const call of [ptyClient.trash, ptyClient.updateTitle, ptyClient.sendKey, ptyClient.on]) {
      expect(call).not.toHaveBeenCalled();
    }
  });

  it("hears the user's sends only while Canopy is on, building nothing to hear them", async () => {
    state.mode = "unset";
    expect(
      (await outcome(invoke(CANOPY_METHOD_CHANNELS.noteSent, fakeSender(5), "run-1"))).ok
    ).toBe(true);
    expect(ptyClient.on).not.toHaveBeenCalled();
  });

  describe("one-key answers", () => {
    const answer = (label: string) =>
      outcome(
        invoke(CANOPY_METHOD_CHANNELS.answer, fakeSender(5), "run-1", { spawnedAt: 100 }, label)
      );
    const NO = "No, and tell Claude what to do differently";
    const inKeyGap = () => new Promise((resolve) => setTimeout(resolve, 20));

    it("presses the keys that reach the option from the highlight, as drawn now", async () => {
      expect((await answer("Yes")).ok).toBe(true);
      expect(state.writes).toEqual(["\r"]);
      state.writes = [];
      expect((await answer(NO)).ok).toBe(true);
      expect(state.writes).toEqual(["\x1b[B", "\r"]);
    });

    it("presses nothing for an option no longer drawn, a respawned terminal or an unreadable screen", async () => {
      const missing = await answer("Always allow");
      expect(missing).toEqual({
        ok: false,
        message: expect.stringContaining("Nothing was pressed"),
      });

      state.record = { spawnedAt: 200 };
      expect((await answer("Yes")).ok).toBe(false);

      state.record = { spawnedAt: 100 };
      const { readPluginTerminalScreen } =
        await import("../../../services/plugin/pluginTerminalScreenRead.js");
      vi.mocked(readPluginTerminalScreen).mockResolvedValueOnce({ status: "unavailable" });
      expect((await answer("Yes")).ok).toBe(false);
      expect(state.writes).toEqual([]);
    });

    it("answers a run once at a time: a second press while keys are going in presses nothing", async () => {
      const first = answer(NO);
      await inKeyGap();
      expect(state.writes).toEqual(["\x1b[B"]);
      const second = await answer("Yes");
      expect(second).toEqual({ ok: false, message: expect.stringContaining("Still answering") });
      expect((await first).ok).toBe(true);
      expect(state.writes).toEqual(["\x1b[B", "\r"]);
    });

    it("stops pressing keys once the terminal is respawned under the same id", async () => {
      const pressing = answer(NO);
      await inKeyGap();
      state.generation = 2;
      expect((await pressing).ok).toBe(false);
      expect(state.writes).toEqual(["\x1b[B"]);
    });

    it("stops pressing keys once Canopy is turned off", async () => {
      const pressing = answer(NO);
      await inKeyGap();
      state.mode = "unset";
      expect((await pressing).ok).toBe(false);
      expect(state.writes).toEqual(["\x1b[B"]);
    });
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

  it.each(["hidden", "unset"] as const)(
    "answers the snapshot of a Canopy that is %s without starting it",
    async (mode) => {
      state.mode = mode;
      const sender = fakeSender(5);
      const result = (await invoke(CANOPY_METHOD_CHANNELS.getSnapshot, sender)) as {
        data?: { mode: string; cards: unknown[] };
      };
      // Sequence 0: never newer than anything a service pushes once one is made.
      expect(result.data ?? result).toMatchObject({
        sequence: 0,
        mode,
        activated: false,
        cards: [],
      });
      // Nothing was made to show it: no service, so nothing listening to terminals.
      expect(ptyClient.on).not.toHaveBeenCalled();
    }
  );

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

    it("carries a read or unread mark to the run's hand-back", async () => {
      const sender = fakeSender(1);
      handBacks.markRead.mockClear();
      handBacks.markUnread.mockClear();
      await invoke(CANOPY_METHOD_CHANNELS.setRead, sender, "run-1", { spawnedAt: 100 }, false);
      expect(handBacks.markUnread).toHaveBeenCalledWith("run-1");
      expect(handBacks.markRead).not.toHaveBeenCalled();
      await invoke(CANOPY_METHOD_CHANNELS.setRead, sender, "run-1", { spawnedAt: 100 }, true);
      expect(handBacks.markRead).toHaveBeenCalledWith("run-1");
    });

    it("carries an undo that leaves the run unread to its hand-back", async () => {
      const sender = fakeSender(1);
      const before = (await invoke(
        CANOPY_METHOD_CHANNELS.setRead,
        sender,
        "run-1",
        { spawnedAt: 100 },
        false
      )) as { data?: unknown } & Record<string, unknown>;
      const mark = (before.data ?? before) as { version: number };
      const after = (await invoke(
        CANOPY_METHOD_CHANNELS.setRead,
        sender,
        "run-1",
        { spawnedAt: 100 },
        true
      )) as { data?: unknown } & Record<string, unknown>;
      const left = ((after.data ?? after) as { version: number }).version;
      handBacks.markUnread.mockClear();
      await invoke(CANOPY_METHOD_CHANNELS.restoreReads, sender, [{ mark, expectVersion: left }]);
      expect(handBacks.markUnread).toHaveBeenCalledWith("run-1");
    });

    it("follows a hand-back the user marked from its own surfaces, and only those", async () => {
      const sender = fakeSender(1);
      await invoke(CANOPY_METHOD_CHANNELS.setRead, sender, "run-1", { spawnedAt: 100 }, true);
      events.emit("terminal:hand-back-changed", { id: "run-1", unseen: true, timestamp: 1 });
      expect((await readMark(sender)).markedUnreadAt).toBeNull();
      events.emit("terminal:hand-back-changed", {
        id: "run-1",
        unseen: true,
        fromUser: true,
        timestamp: 2,
      });
      expect((await readMark(sender)).markedUnreadAt).not.toBeNull();
      events.emit("terminal:hand-back-changed", {
        id: "run-1",
        unseen: false,
        fromUser: true,
        timestamp: 3,
      });
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

  describe("a trash made while the run's project is closed", () => {
    const dock = () => {
      saved.state = { terminals: [{ id: "run-1", title: "Claude", location: "dock" }] };
    };

    it("goes to the trash in the project's saved layout, and Undo puts the pane back", async () => {
      dock();
      const receipt = await trashReceipt();
      // Opened later, the project would not bring the trashed agent back.
      expect(saved.state?.terminals[0]?.location).toBe("trash");
      state.runs = [];
      const undone = await outcome(invoke(CANOPY_METHOD_CHANNELS.untrash, fakeSender(1), receipt));
      expect(undone.ok).toBe(true);
      expect(ptyClient.restore).toHaveBeenCalledWith("run-1");
      expect(saved.state?.terminals[0]?.location).toBe("dock");
    });

    it("puts the pane back even when Undo comes before the project's queue saved the trash", async () => {
      dock();
      let release!: () => void;
      let queue = new Promise<void>((resolve) => (release = resolve));
      // The project's state queue, busy with an earlier save: first in, first applied.
      const queued = (_projectId: string, updater: (state: unknown) => unknown) => {
        const run = queue.then(async () => {
          const next = await updater(saved.state);
          if (next !== null) saved.state = next as typeof saved.state;
        });
        queue = run;
        return run;
      };
      projectStore.enqueueProjectStateUpdate
        .mockImplementationOnce(queued)
        .mockImplementationOnce(queued);
      const receipt = await trashReceipt();
      state.runs = [];
      const undo = outcome(invoke(CANOPY_METHOD_CHANNELS.untrash, fakeSender(1), receipt));
      release();
      expect((await undo).ok).toBe(true);
      expect(saved.state?.terminals[0]?.location).toBe("dock");
    });

    it("refuses Undo once the project has opened without the pane", async () => {
      dock();
      const receipt = await trashReceipt();
      state.views = [{ send: vi.fn() }];
      const undone = await outcome(invoke(CANOPY_METHOD_CHANNELS.untrash, fakeSender(1), receipt));
      expect(undone).toEqual({ ok: false, message: expect.stringContaining("opened since") });
      expect(ptyClient.restore).not.toHaveBeenCalled();
    });

    it("leaves the saved layout alone when a view of the project moved the pane itself", async () => {
      dock();
      state.views = [{ send: vi.fn() }];
      await trashReceipt();
      expect(saved.state?.terminals[0]?.location).toBe("dock");
    });
  });

  it("never refuses a look ending, however many looks came before it", async () => {
    const sender = fakeSender(5);
    for (let i = 0; i < 120; i++) {
      await invoke(CANOPY_METHOD_CHANNELS.markSeen, sender, "run-1", true, "panel");
    }
    const begun = await outcome(
      invoke(CANOPY_METHOD_CHANNELS.markSeen, sender, "run-1", true, "panel")
    );
    expect(begun.ok).toBe(false);
    const ended = await outcome(
      invoke(CANOPY_METHOD_CHANNELS.markSeen, sender, "run-1", false, "panel")
    );
    expect(ended.ok).toBe(true);
  });

  it("tells every view a mode change made before Canopy was ever started", async () => {
    state.mode = "unset";
    await invoke(CANOPY_METHOD_CHANNELS.setMode, fakeSender(5), "hidden");
    expect(broadcasts).toHaveBeenCalledWith(
      "canopy:snapshot-updated",
      expect.objectContaining({ mode: "hidden", activated: false })
    );
    expect(ptyClient.on).not.toHaveBeenCalled();
  });

  it("takes back its trash with Canopy turned off since, and of an agent that has exited", async () => {
    state.record = { spawnedAt: 100, isExited: true };
    const receipt = await trashReceipt();
    state.mode = "unset";
    const undone = await outcome(invoke(CANOPY_METHOD_CHANNELS.untrash, fakeSender(1), receipt));
    expect(undone.ok).toBe(true);
    expect(ptyClient.restore).toHaveBeenCalledWith("run-1");
  });

  it("keeps a newer trash's Undo through its own restore's late word", async () => {
    const first = await trashReceipt();
    await outcome(invoke(CANOPY_METHOD_CHANNELS.untrash, fakeSender(1), first));
    // Trashed again before the host's word on the first restore arrives.
    const second = await trashReceipt();
    events.emit("terminal:restored", { id: "run-1" });
    const undone = await outcome(invoke(CANOPY_METHOD_CHANNELS.untrash, fakeSender(1), second));
    expect(undone.ok).toBe(true);
  });

  it("refuses an older incarnation's receipt without spending the newer one's", async () => {
    const old = await trashReceipt();
    // Respawned under the same id, listed and trashed again.
    state.record = { spawnedAt: 200 };
    state.runs = [{ runId: "run-1", spawnedAt: 200, workspaceId: "project-1" }];
    const result = (await invoke(CANOPY_METHOD_CHANNELS.trash, fakeSender(1), "run-1", {
      spawnedAt: 200,
    })) as { data?: unknown } | number;
    const newer = typeof result === "number" ? result : (result.data as number);
    const stale = await outcome(invoke(CANOPY_METHOD_CHANNELS.untrash, fakeSender(1), old));
    expect(stale.ok).toBe(false);
    const undone = await outcome(invoke(CANOPY_METHOD_CHANNELS.untrash, fakeSender(1), newer));
    expect(undone.ok).toBe(true);
  });

  it("refuses an Undo whose trash lapses while the host is asked", async () => {
    vi.useFakeTimers();
    try {
      const receipt = await trashReceipt();
      vi.advanceTimersByTime(TRASH_TTL_MS - 10);
      ptyClient.getTerminalAsync.mockImplementationOnce(async () => {
        vi.advanceTimersByTime(20);
        return state.record;
      });
      const late = await outcome(invoke(CANOPY_METHOD_CHANNELS.untrash, fakeSender(1), receipt));
      expect(late.ok).toBe(false);
      expect(ptyClient.restore).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an Undo whose terminal was restored elsewhere while the host was asked", async () => {
    const receipt = await trashReceipt();
    ptyClient.getTerminalAsync.mockImplementationOnce(async () => {
      events.emit("terminal:restored", { id: "run-1" });
      return state.record;
    });
    const result = await outcome(invoke(CANOPY_METHOD_CHANNELS.untrash, fakeSender(1), receipt));
    expect(result.ok).toBe(false);
    expect(ptyClient.restore).not.toHaveBeenCalled();
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
    expect(canopyPanelsListing("run-1")).toEqual([]);
    await invoke(CANOPY_METHOD_CHANNELS.setShown, sender, ["run-1"]);
    expect(canopyPanelsListing("run-1")).toEqual([31]);
    // The Unread filter hides run-1: the panel isn't in front of its ask.
    await invoke(CANOPY_METHOD_CHANNELS.setShown, sender, ["run-2"]);
    expect(canopyPanelsListing("run-1")).toEqual([]);
    expect(canopyPanelsListing("run-2")).toEqual([31]);
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

  describe("a view on another machine", () => {
    beforeEach(() => {
      getIpcDispatcher().setInvokeEnveloper(async (_channel, _args, call) => {
        try {
          return wrapSuccess(await call());
        } catch (error) {
          return wrapError(error);
        }
      });
    });

    afterEach(() => {
      getIpcDispatcher().setInvokeEnveloper(null);
    });

    function remoteView(handle: number, endpointId = `remote:${handle}`) {
      let closeListener: (() => void) | null = null;
      let closed = false;
      const endpoint: ClientEndpoint = {
        endpointId,
        clientId: "client-greg-mbp",
        projectId: "project-1",
        kind: "remote-view",
        handle,
        send: vi.fn(),
        request: vi.fn(),
        onClose: (listener: () => void) => {
          closeListener = listener;
          return {
            dispose: () => {
              closeListener = null;
            },
          };
        },
        isClosed: () => closed,
      };
      const call = (channel: string, ...args: unknown[]) =>
        getIpcDispatcher().invokeForEndpoint(
          {
            endpoint,
            client: {
              clientId: endpoint.clientId,
              clientName: "greg-mbp",
              platform: "darwin",
              kind: "remote",
            },
          },
          channel,
          args
        );
      return {
        endpoint,
        call,
        close: () => {
          closed = true;
          closeListener?.();
        },
      };
    }

    describe("a Canopy panel reading this host from another machine (#13387)", () => {
      const viewer = (handle: number) => remoteView(handle, `canopy-viewer:v${-handle}`);
      async function openViewerStream(handle: number) {
        const view = viewer(handle);
        const opened = (await view.call(CANOPY_METHOD_CHANNELS.watchTerminal, "run-1", {
          spawnedAt: 100,
        })) as { ok: boolean; data: { watchId: number } };
        expect(opened.ok).toBe(true);
        return { view, watchId: opened.data.watchId };
      }

      it("never sizes the terminal, even while its machine drives it", async () => {
        lease.holder = "self";
        const { view, watchId } = await openViewerStream(-11);
        await view.call(CANOPY_METHOD_CHANNELS.terminalResize, watchId, 100, 30);
        expect(ptyClient.resize).not.toHaveBeenCalled();
        // Nothing held, so nothing is handed back when it lets go.
        await view.call(CANOPY_METHOD_CHANNELS.unwatchTerminal);
        expect(ptyClient.resize).not.toHaveBeenCalled();
      });

      it("types what its machine's window could, but sends no image path from that machine", async () => {
        lease.holder = "self";
        const { view, watchId } = await openViewerStream(-12);
        const typed = (await view.call(CANOPY_METHOD_CHANNELS.terminalSubmit, watchId, "navy")) as {
          ok: boolean;
        };
        expect(typed.ok).toBe(true);
        const withImage = (await view.call(CANOPY_METHOD_CHANNELS.terminalSubmit, watchId, "look", [
          "/Users/greg/Desktop/shot.png",
        ])) as { ok: boolean };
        expect(withImage.ok).toBe(false);
        expect(state.submits).toHaveLength(1);
      });

      it("presses nothing more once the panel that answered is gone", async () => {
        lease.holder = "self";
        const view = viewer(-13);
        ptyClient.write.mockImplementationOnce((_id: string, data: string) => {
          view.close();
          return state.writes.push(data);
        });
        const answered = (await view.call(
          CANOPY_METHOD_CHANNELS.answer,
          "run-1",
          { spawnedAt: 100 },
          "No, and tell Claude what to do differently"
        )) as { ok: boolean };
        expect(answered.ok).toBe(false);
        expect(state.writes).toEqual(["\x1b[B"]);
      });
    });

    it("streams a watched terminal through the view's endpoint, and ends it when the endpoint closes", async () => {
      const release = vi.fn();
      state.releaseMirror = release;
      const view = remoteView(-7);
      const opened = (await view.call(CANOPY_METHOD_CHANNELS.watchTerminal, "run-1", {
        spawnedAt: 100,
      })) as { ok: boolean; data: { watchId: number } };
      expect(opened.ok).toBe(true);

      const forward = ptyClient.on.mock.calls.find(([event]) => event === "data-mirror")?.[1] as (
        id: string,
        data: string,
        streamEnd: number
      ) => void;
      forward("run-1", "hello", 10);
      expect(view.endpoint.send).toHaveBeenCalledWith({
        type: "event",
        channel: CHANNELS.CANOPY_TERMINAL_DATA,
        args: [expect.objectContaining({ kind: "data", runId: "run-1", data: "hello" })],
      });

      view.close();
      expect(activeTerminalWatches().has(-7)).toBe(false);
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  describe("a run whose project another screen drives", () => {
    async function openStream(sender = fakeSender(4)) {
      const view = (await invoke(CANOPY_METHOD_CHANNELS.watchTerminal, sender, "run-1", {
        spawnedAt: 100,
      })) as { data?: { watchId: number }; watchId?: number };
      return { sender, watchId: (view.data ?? view).watchId! };
    }

    it("refuses typing, keys, submits and answers from a screen that doesn't drive it", async () => {
      const { sender, watchId } = await openStream();
      lease.holder = "other";

      const attempts = await Promise.all([
        outcome(invoke(CANOPY_METHOD_CHANNELS.terminalInput, sender, watchId, "y")),
        outcome(invoke(CANOPY_METHOD_CHANNELS.terminalSendKey, sender, watchId, "escape")),
        outcome(invoke(CANOPY_METHOD_CHANNELS.terminalSubmit, sender, watchId, "navy")),
        outcome(invoke(CANOPY_METHOD_CHANNELS.answer, sender, "run-1", { spawnedAt: 100 }, "Yes")),
      ]);

      expect(attempts.map((attempt) => attempt.ok)).toEqual([false, false, false, false]);
      expect(state.writes).toEqual([]);
      expect(state.submits).toEqual([]);
      expect(ptyClient.sendKey).not.toHaveBeenCalled();
    });

    it("leaves the PTY at the driver's size rather than the panel's", async () => {
      const { sender, watchId } = await openStream();
      lease.holder = "other";
      await invoke(CANOPY_METHOD_CHANNELS.terminalResize, sender, watchId, 100, 30);
      expect(ptyClient.resize).not.toHaveBeenCalled();

      lease.holder = "self";
      await invoke(CANOPY_METHOD_CHANNELS.terminalResize, sender, watchId, 100, 30);
      expect(ptyClient.resize).toHaveBeenCalledWith("run-1", 100, 30);
    });

    it("hands no size back once its view has lost control", async () => {
      lease.holder = "self";
      const { sender, watchId } = await openStream();
      await invoke(CANOPY_METHOD_CHANNELS.terminalResize, sender, watchId, 100, 30);
      expect(ptyClient.resize).toHaveBeenCalledWith("run-1", 100, 30);

      lease.holder = "other";
      ptyClient.resize.mockClear();
      await invoke(CANOPY_METHOD_CHANNELS.unwatchTerminal, sender);
      expect(ptyClient.resize).not.toHaveBeenCalled();
    });

    it("stops answering when another screen takes control between keys", async () => {
      lease.holder = "self";
      ptyClient.write.mockImplementationOnce((_id: string, data: string) => {
        lease.holder = "other";
        return state.writes.push(data);
      });
      const answered = await outcome(
        invoke(
          CANOPY_METHOD_CHANNELS.answer,
          fakeSender(5),
          "run-1",
          { spawnedAt: 100 },
          "No, and tell Claude what to do differently"
        )
      );
      expect(answered).toEqual({
        ok: false,
        message: expect.stringContaining("Another screen took control"),
      });
      expect(state.writes).toEqual(["\x1b[B"]);
    });

    it("refuses Undo by the trash's own project, even once its terminal has exited", async () => {
      const receipt = await trashReceipt();
      state.runs = [];
      state.terminalProject = null;
      lease.holder = "other";
      const undone = await outcome(invoke(CANOPY_METHOD_CHANNELS.untrash, fakeSender(1), receipt));
      expect(undone.ok).toBe(false);
      expect(ptyClient.restore).not.toHaveBeenCalled();
    });

    it("refuses Undo when control moves while the host is asked", async () => {
      lease.holder = "self";
      const receipt = await trashReceipt();
      state.runs = [];
      ptyClient.getTerminalAsync.mockImplementationOnce(async () => {
        lease.holder = "other";
        return state.record;
      });
      const undone = await outcome(invoke(CANOPY_METHOD_CHANNELS.untrash, fakeSender(1), receipt));
      expect(undone.ok).toBe(false);
      expect(ptyClient.restore).not.toHaveBeenCalled();
    });
  });
});
