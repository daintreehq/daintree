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
  record: null as {
    spawnedAt: number;
    isExited?: boolean;
    isTrashed?: boolean;
    trashExpiresAt?: number;
    projectId?: string;
    cwd?: string;
    detectedAgentId?: string;
    launchAgentId?: string;
    title?: string;
    worktreeId?: string;
    scheduledRun?: { scheduleId: string; runId: string };
  } | null,
  screen: "",
  /** How the terminal draws a key it is sent; tests set it to move a list's highlight. */
  redraw: (screen: string, _data: string) => screen,
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
  write: vi.fn((_id: string, data: string) => {
    state.writes.push(data);
    state.screen = state.redraw(state.screen, data);
  }),
  submit: vi.fn((_id: string, text: string) => state.submits.push(text)),
  sendKey: vi.fn(),
  trash: vi.fn(),
  restore: vi.fn(),
  kill: vi.fn(),
  gracefulKill: vi.fn(async (_id: string): Promise<string | null> => null),
  updateTitle: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  acquireIpcDataMirror: vi.fn(() => state.releaseMirror),
  getSerializedStateAsync: vi.fn(async () => ({ data: "screen", cols: 80, rows: 24 })),
  getTerminalProjectId: vi.fn((_id: string): string | null => state.terminalProject),
  resize: vi.fn(),
}));

/** Who drives every project: this screen, another one, or nobody (no lease service at all). */
const lease = vi.hoisted(() => ({
  holder: null as "self" | "other" | null,
  /** The handle of the endpoint holding the lease, when one is attached. */
  holderHandle: undefined as number | undefined,
  listeners: new Set<() => void>(),
}));
vi.mock("../../../services/DriveLeaseService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/DriveLeaseService.js")>()),
  peekDriveLeaseService: () =>
    lease.holder === null
      ? null
      : {
          isDriving: () => lease.holder === "self",
          getHolderEndpoint: () =>
            lease.holderHandle === undefined ? null : { handle: lease.holderHandle },
          onChange: (listener: () => void) => {
            lease.listeners.add(listener);
            return () => lease.listeners.delete(listener);
          },
        },
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  webContents: { fromId: () => undefined },
  safeStorage: {},
  app: {
    getPath: () => "/tmp",
    get isPackaged() {
      return state.packaged;
    },
  },
}));
vi.mock("../../../window/serviceRefs.js", () => ({ getPtyClient: () => ptyClient }));
/** The session journal as Canopy reads it: its records, and who hears it written. */
const history = vi.hoisted(() => ({
  records: [] as Array<
    import("../../../../shared/types/ipc/agentSessionHistory.js").AgentSessionRecord
  >,
  listeners: new Set<() => void>(),
  written(): void {
    for (const listener of [...this.listeners]) listener();
  },
}));
const removeFromCanopyTrash = vi.hoisted(() =>
  vi.fn(async (terminals: Array<{ id: string; spawnedAt: number }>) => {
    history.records = history.records.map((record) =>
      record.trash &&
      terminals.some(
        (terminal) =>
          terminal.id === record.terminal?.id && terminal.spawnedAt === record.terminal.spawnedAt
      )
        ? { ...record, trash: { ...record.trash, removedAt: 1 } }
        : record
    );
    history.written();
    return terminals.length;
  })
);
vi.mock("../../../services/pty/agentSessionHistory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/pty/agentSessionHistory.js")>()),
  listAgentSessions: () => history.records,
  onSessionHistoryWritten: (listener: () => void) => {
    history.listeners.add(listener);
    return () => history.listeners.delete(listener);
  },
  removeFromCanopyTrash,
  adoptCanopyTrashClose: vi.fn(async () => false),
}));
/** The lanes main holds an assistant for, and who hears one end. */
const assistants = vi.hoisted(() => ({
  lane: null as { sessionId: string; terminalId: string } | null,
  ended: new Set<(event: { projectId: string; slot: number; sessionId: string }) => void>(),
  /** The global session, when one runs, and the view holding its input. */
  global: null as null | {
    terminalId: string;
    generation: number;
    owner: number | null;
    /** The attachment holding input, at the epoch it was given. */
    holder?: { attachmentId: string; epoch: number };
  },
}));
vi.mock("../../../services/HelpSessionService.js", () => ({
  helpSessionService: {
    getRunningLaneSession: (projectId: string, slot: number) =>
      projectId === "project-1" && slot === 1 ? assistants.lane : null,
    addSessionEndedListener: (
      listener: (event: { projectId: string; slot: number; sessionId: string }) => void
    ) => {
      assistants.ended.add(listener);
      return () => assistants.ended.delete(listener);
    },
  },
}));
vi.mock("../../../services/globalAssistant.js", () => ({
  peekGlobalAssistantService: () =>
    assistants.global && {
      getState: () => ({
        phase: "running",
        generation: assistants.global?.generation ?? 0,
        terminalId: assistants.global?.terminalId ?? null,
      }),
      onChange: () => () => {},
      inputOwnerWebContentsId: () => assistants.global?.owner ?? null,
      canWrite: (attachmentId: string, epoch: number) =>
        assistants.global?.holder?.attachmentId === attachmentId &&
        assistants.global.holder.epoch === epoch,
    },
}));
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
const directoryRead = vi.hoisted(() =>
  vi.fn(async (_options: { projectId?: string }) => ({
    coverage: "ok" as const,
    observedAt: 1,
    complete: true,
    omitted: 0,
    entries: [],
  }))
);
vi.mock("../../../services/assistants/localAgentDirectory.js", () => ({
  getLocalAgentDirectory: () => ({ read: directoryRead }),
}));
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
const localReader = vi.hoisted(() => ({ read: vi.fn(), release: vi.fn() }));
vi.mock("../../../services/canopy/canopyLocalReader.js", () => ({
  CanopyLocalReader: vi.fn(function CanopyLocalReader() {
    return localReader;
  }),
}));
const models = vi.hoisted(() => ({
  ensure: vi.fn(async () => {}),
  cancel: vi.fn(),
  state: vi.fn(() => ({ id: "daintreehq/canopy-reader-17m", status: "ready" as const })),
  info: vi.fn(async () => ({
    id: "daintreehq/canopy-reader-17m",
    name: "Light",
    bytes: 21_000_000,
    installed: true,
  })),
  installedDir: vi.fn(async () => "/tmp/canopy/models/canopy-reader-17m"),
  remove: vi.fn(async () => {}),
}));
vi.mock("../../../services/canopy/canopyModels.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../services/canopy/canopyModels.js")>()),
  CanopyModels: vi.fn(function CanopyModels() {
    return models;
  }),
}));
const broadcasts = vi.hoisted(() => vi.fn());
const pushes = vi.hoisted(() => vi.fn());
const handBacks = vi.hoisted(() => ({ markRead: vi.fn(), markUnread: vi.fn() }));
vi.mock("../../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils.js")>()),
  getProjectPushTargets: vi.fn(() => state.views),
  typedBroadcast: broadcasts,
  broadcastToRenderer: pushes,
}));

import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";
import { wrapError, wrapSuccess } from "../../../../shared/utils/ipcErrorSerialization.js";
import { _resetRateLimitQueuesForTest, getProjectPushTargets } from "../../utils.js";
import { events } from "../../../services/events.js";
import { getDefaultPanelTitle } from "../../../../shared/config/panelKindRegistry.js";
import { canopyPanelsListing, registerCanopyHandlers } from "../canopy.js";
import { CANOPY_METHOD_CHANNELS } from "../canopy.preload.js";
import { activeTerminalWatches } from "../canopyTerminalWatch.js";
import { getIpcDispatcher } from "../../dispatcher.js";
import { resetCanopyTrashRemovalsForTests } from "../../../services/pty/canopyTrashRemovals.js";
import type { ClientEndpoint } from "../../endpoint.js";
import { CHANNELS } from "../../channels.js";
import { readPluginTerminalScreen } from "../../../services/plugin/pluginTerminalScreenRead.js";
import { redrawFor } from "../../../services/__tests__/answerRedraw.js";

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
    state.redraw = redrawFor;
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
    // No test downloads a model or starts a reader.
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

  it("searches only the terminals the fleet holds, answering with ids alone", async () => {
    state.runs = [
      { runId: "run-1", spawnedAt: 100 },
      { runId: "run-2", spawnedAt: 100 },
    ];
    state.screen = "Error: ECONNRESET at fetch";
    vi.mocked(readPluginTerminalScreen).mockClear();
    const sender = fakeSender(5);
    const found = await invoke(CANOPY_METHOD_CHANNELS.searchScreens, sender, [
      { runId: "run-1", spawnedAt: 100, terms: ["econnreset"] },
      // Another incarnation of a run the fleet holds, and a run it doesn't.
      { runId: "run-2", spawnedAt: 99, terms: ["econnreset"] },
      { runId: "run-3", spawnedAt: 100, terms: ["econnreset"] },
    ]);
    expect(found).toEqual(["run-1"]);
    expect(vi.mocked(readPluginTerminalScreen).mock.calls.map((call) => call[1])).toEqual([
      "run-1",
    ]);
    // Nothing read for a search goes anywhere, the reader included.
    expect(fetch).not.toHaveBeenCalled();
    expect(localReader.read).not.toHaveBeenCalled();
  });

  it("refuses a search with no words, or words past its bounds", async () => {
    state.runs = [{ runId: "run-1", spawnedAt: 100 }];
    vi.mocked(readPluginTerminalScreen).mockClear();
    const sender = fakeSender(5);
    for (const terms of [[], [""], ["x".repeat(201)], Array.from({ length: 17 }, () => "x")]) {
      const result = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.searchScreens, sender, [
          { runId: "run-1", spawnedAt: 100, terms },
        ])
      );
      expect(result.ok).toBe(false);
    }
    expect(vi.mocked(readPluginTerminalScreen)).not.toHaveBeenCalled();
  });

  it("reads no branch for an id that isn't one", async () => {
    state.runs = [{ runId: "run-1", spawnedAt: 100, cwd: "/repo" }];
    const sender = fakeSender(5);
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
      data?: { activated: boolean };
      activated?: boolean;
    };
    expect((turnedOn.data ?? turnedOn).activated).toBe(true);
    expect(state.mode).toBe("on");
    const after = await outcome(
      invoke(CANOPY_METHOD_CHANNELS.answer, sender, "run-1", { spawnedAt: 100 }, "Yes")
    );
    expect(after.ok).toBe(true);
  });

  it("never answers the global assistant's prompt from a card (#14454)", async () => {
    state.mode = "on";
    assistants.global = { terminalId: "run-1", generation: 5, owner: 5 };
    try {
      const refused = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.answer, fakeSender(5), "run-1", { spawnedAt: 100 }, "Yes")
      );
      expect(refused).toEqual({
        ok: false,
        message: expect.stringContaining("global assistant"),
      });
      expect(state.writes).toEqual([]);
    } finally {
      assistants.global = null;
    }
  });

  it.each([
    ["refresh", []],
    ["reread", ["run-1", { spawnedAt: 100 }]],
    ["answer", ["run-1", { spawnedAt: 100 }, "Yes"]],
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

    it("presses no Enter once another question with the same options replaces the dialog", async () => {
      state.redraw = () => MENU.replace("Do you want to proceed?", "Do you want to push --force?");
      const refused = await answer(NO);
      expect(refused).toEqual({
        ok: false,
        message: expect.stringContaining("Enter wasn't"),
      });
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

  it("changes nothing for a change made against another host process's epoch", async () => {
    const sender = fakeSender(5);
    const snapshotOf = (result: unknown) => {
      const envelope = result as { data?: Record<string, unknown> };
      return (envelope.data ?? result) as { mode: string; modeRevision: number; hostEpoch: string };
    };
    const start = snapshotOf(await invoke(CANOPY_METHOD_CHANNELS.setMode, sender, "unset"));
    expect(typeof start.hostEpoch).toBe("string");

    // The revision matches by coincidence, as it can after a restart; the epoch does not.
    const stale = snapshotOf(
      await invoke(
        CANOPY_METHOD_CHANNELS.setMode,
        sender,
        "hidden",
        start.modeRevision,
        "other-launch"
      )
    );
    expect(stale).toMatchObject({ mode: "unset", modeRevision: start.modeRevision });
    expect(state.mode).toBe("unset");

    const landed = snapshotOf(
      await invoke(
        CANOPY_METHOD_CHANNELS.setMode,
        sender,
        "hidden",
        start.modeRevision,
        start.hostEpoch
      )
    );
    expect(landed).toMatchObject({ mode: "hidden", hostEpoch: start.hostEpoch });
    expect(landed.modeRevision).toBe(start.modeRevision + 1);

    const noRevision = await outcome(
      invoke(CANOPY_METHOD_CHANNELS.setMode, sender, "unset", undefined, start.hostEpoch)
    );
    expect(noRevision.ok).toBe(false);
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

    it("refuses a respawned terminal, and a title that isn't one", async () => {
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

  it("gets the model once Canopy is turned on, and lets the reader go when it is turned off", async () => {
    state.mode = "unset";
    const sender = fakeSender(9);
    await invoke(CANOPY_METHOD_CHANNELS.setActive, sender, true);
    // Off, nothing is downloaded or started.
    expect(models.ensure).not.toHaveBeenCalled();
    await invoke(CANOPY_METHOD_CHANNELS.setMode, sender, "on");
    expect(models.ensure).toHaveBeenCalled();
    // Once it is ready, any model an earlier Daintree chose goes, the one in use stays.
    await vi.waitFor(() => expect(models.remove).toHaveBeenCalledWith(true));
    await invoke(CANOPY_METHOD_CHANNELS.setMode, sender, "unset");
    // A download under way stops; no read was made, so no reader was ever started.
    expect(models.cancel).toHaveBeenCalled();
    expect(localReader.read).not.toHaveBeenCalled();
  });

  it("says what the model is and whether it is on this machine, as the models say", async () => {
    const info = {
      id: "daintreehq/canopy-reader-17m",
      name: "Light",
      bytes: 1234,
      installed: false,
    };
    models.info.mockResolvedValueOnce(info);
    const result = (await invoke(CANOPY_METHOD_CHANNELS.getModel, fakeSender(9))) as {
      data?: unknown;
    };
    expect(models.info).toHaveBeenCalled();
    expect(result.data ?? result).toEqual(info);
  });

  it("deletes the downloaded models at any time, turning Canopy off first when it is on", async () => {
    state.mode = "on";
    const sender = fakeSender(9);
    await invoke(CANOPY_METHOD_CHANNELS.removeModels, sender);
    // Off, through the guarded change: so every view is told, and a restart
    // finds nothing to download again.
    expect(state.mode).toBe("unset");
    expect(models.remove).toHaveBeenCalledWith(false);
    models.remove.mockClear();
    // Already off: just the delete.
    await invoke(CANOPY_METHOD_CHANNELS.removeModels, sender);
    expect(state.mode).toBe("unset");
    expect(models.remove).toHaveBeenCalledWith(false);
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

  describe("Canopy's Trash", () => {
    const EXPIRES = Date.now() + TRASH_TTL_MS;
    const target = { spawnedAt: 100, expiresAt: EXPIRES };

    /** The host trashed run-1, an agent in another project, however it was closed. */
    async function trashedOnHost(expiresAt = EXPIRES): Promise<void> {
      state.record = {
        spawnedAt: 100,
        isTrashed: true,
        trashExpiresAt: expiresAt,
        projectId: "project-2",
        cwd: "/repo/login",
        detectedAgentId: "claude",
        launchAgentId: "claude",
        title: "Fix login",
      };
      state.runs = [];
      events.emit("terminal:trashed", { id: "run-1", expiresAt });
      await heard();
    }

    /** The ledger reads the host's record of a trash it hears: those reads answered. */
    async function heard(): Promise<void> {
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    }

    async function trash(): Promise<Array<{ run: { runId: string; workspaceId: string } }>> {
      const snapshot = (await invoke(CANOPY_METHOD_CHANNELS.getSnapshot, fakeSender(1))) as {
        trash?: Array<{ run: { runId: string; workspaceId: string } }>;
      };
      return snapshot.trash ?? [];
    }

    it("lists an agent trashed in any project, drops it restored, and keeps it ended once let go", async () => {
      await trashedOnHost();
      expect((await trash()).map((entry) => [entry.run.runId, entry.run.workspaceId])).toEqual([
        ["run-1", "project-2"],
      ]);
      events.emit("terminal:restored", { id: "run-1" });
      expect(await trash()).toEqual([]);

      await trashedOnHost();
      events.emit("terminal:trash-cleared", { id: "run-1", expiresAt: EXPIRES });
      expect(await trash()).toEqual([
        expect.objectContaining({ run: expect.objectContaining({ runId: "run-1" }), ended: {} }),
      ]);
    });

    describe("past the trash's window", () => {
      /** The user closed run-1 in project-2; the journal holds its session. */
      function journaled(overrides: Record<string, unknown> = {}) {
        history.records = [
          {
            sessionId: "session-1",
            agentId: "claude",
            worktreeId: null,
            title: "Fix login",
            projectId: "project-2",
            savedAt: EXPIRES,
            cwd: "/repo/login",
            closedBy: "user",
            terminal: { id: "run-1", spawnedAt: 100 },
            trash: { expiresAt: EXPIRES, closedAt: EXPIRES - TRASH_TTL_MS },
            ...overrides,
          },
        ];
        history.written();
      }

      /** A view of the run's project, as main reaches it. */
      function projectView(id: number) {
        const view = { id, send: vi.fn(), isDestroyed: () => false };
        state.views = [view];
        return view;
      }

      beforeEach(() => {
        history.records = [];
        removeFromCanopyTrash.mockClear();
        // Runs removed by earlier cases are this module's to remember, not this case's.
        resetCanopyTrashRemovalsForTests();
      });

      /** What the panel is told when a restore is refused. */
      async function refusal(promise: Promise<unknown>): Promise<string> {
        try {
          await promise;
          return "";
        } catch (error) {
          return (error as { userMessage?: string }).userMessage ?? "";
        }
      }

      it("lists the user's closes from the journal, and nothing else that ended a pane", async () => {
        journaled();
        history.records.push({
          sessionId: "session-quit",
          agentId: "codex",
          worktreeId: null,
          title: null,
          projectId: "project-2",
          savedAt: EXPIRES,
          closedBy: "shutdown",
          terminal: { id: "run-quit", spawnedAt: 100 },
        });
        history.written();
        const listed = await trash();
        expect(listed.map((entry) => entry.run.runId)).toEqual(["run-1"]);
        expect(listed[0]).toMatchObject({ ended: {}, expiresAt: EXPIRES });
        // The snapshot names the run, never the session it would resume.
        expect(JSON.stringify(listed)).not.toContain("session-1");
      });

      it("resumes an ended run through a view of its project, then takes it out of the Trash", async () => {
        journaled();
        const view = projectView(1);
        await trash();
        const restoring = invoke(
          CANOPY_METHOD_CHANNELS.restoreTrashed,
          fakeSender(1),
          "run-1",
          target
        ) as Promise<{ ok: boolean; data: unknown }>;
        await vi.waitFor(() => expect(view.send).toHaveBeenCalled());
        expect(ptyClient.restore).not.toHaveBeenCalled();
        const [channel, request] = view.send.mock.calls[0]! as [
          string,
          { requestId: string; session: { sessionId: string } },
        ];
        expect(channel).toBe("canopy:resume-requested");
        expect(request.session.sessionId).toBe("session-1");

        // Only the view asked is heard.
        await invoke(CANOPY_METHOD_CHANNELS.resumeSettled, fakeSender(2), request.requestId, {
          runId: "elsewhere",
        });
        await invoke(CANOPY_METHOD_CHANNELS.resumeSettled, fakeSender(1), request.requestId, {
          runId: "run-9",
        });

        expect(await restoring).toEqual({ runId: "run-9" });
        expect(removeFromCanopyTrash).toHaveBeenCalledWith(
          [{ id: "run-1", spawnedAt: 100 }],
          expect.any(String)
        );
        expect(await trash()).toEqual([]);
      });

      it("lets only the view asked take up a resume, once, and only while Canopy waits", async () => {
        journaled();
        const view = projectView(1);
        await trash();
        const restoring = invoke(
          CANOPY_METHOD_CHANNELS.restoreTrashed,
          fakeSender(1),
          "run-1",
          target
        );
        await vi.waitFor(() => expect(view.send).toHaveBeenCalled());
        const { requestId } = view.send.mock.calls[0]![1] as { requestId: string };
        const started = (sender: number) =>
          invoke(CANOPY_METHOD_CHANNELS.resumeStarted, fakeSender(sender), requestId);
        expect(await started(2)).toBeNull();
        // The launch's own while to land the pane, told to the view.
        expect(await started(1)).toBeGreaterThan(0);
        expect(await started(1)).toBeNull();
        await invoke(CANOPY_METHOD_CHANNELS.resumeSettled, fakeSender(1), requestId, {
          runId: "run-9",
        });
        expect(await restoring).toEqual({ runId: "run-9" });
        // Settled: a view hearing it only now launches nothing.
        expect(await started(1)).toBeNull();
      });

      it("gives up on a resume not taken up in time, and gives one taken up its own while", async () => {
        journaled();
        const view = projectView(1);
        await trash();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          // Never taken up: Canopy stops waiting, and a late claim starts nothing.
          const untaken = refusal(
            invoke(CANOPY_METHOD_CHANNELS.restoreTrashed, fakeSender(1), "run-1", target)
          );
          await vi.waitFor(() => expect(view.send).toHaveBeenCalledTimes(1));
          const first = (view.send.mock.calls[0]![1] as { requestId: string }).requestId;
          await vi.advanceTimersByTimeAsync(30_000);
          expect(await untaken).toContain("didn't answer in time");
          expect(
            await invoke(CANOPY_METHOD_CHANNELS.resumeStarted, fakeSender(1), first)
          ).toBeNull();

          // Taken up: the start's deadline no longer applies, the launch's does.
          const taken = refusal(
            invoke(CANOPY_METHOD_CHANNELS.restoreTrashed, fakeSender(1), "run-1", target)
          );
          await vi.waitFor(() => expect(view.send).toHaveBeenCalledTimes(2));
          const second = (view.send.mock.calls[1]![1] as { requestId: string }).requestId;
          await vi.advanceTimersByTimeAsync(20_000);
          const budget = (await invoke(
            CANOPY_METHOD_CHANNELS.resumeStarted,
            fakeSender(1),
            second
          )) as number;
          await vi.advanceTimersByTimeAsync(budget - 1);
          let settled = false;
          void taken.then(() => {
            settled = true;
          });
          await vi.advanceTimersByTimeAsync(0);
          expect(settled).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          expect(await taken).toContain("didn't finish resuming it in time");
        } finally {
          vi.useRealTimers();
        }
      });

      it("keeps an ended run whose resume failed, saying why", async () => {
        journaled();
        const view = projectView(1);
        await trash();
        const restoring = refusal(
          invoke(CANOPY_METHOD_CHANNELS.restoreTrashed, fakeSender(1), "run-1", target)
        );
        await vi.waitFor(() => expect(view.send).toHaveBeenCalled());
        const { requestId } = view.send.mock.calls[0]![1] as { requestId: string };
        await invoke(CANOPY_METHOD_CHANNELS.resumeSettled, fakeSender(1), requestId, {
          error: "Its agent can't resume.",
        });
        expect(await restoring).toBe("Its agent can't resume.");
        expect(removeFromCanopyTrash).not.toHaveBeenCalled();
        expect(await trash()).toHaveLength(1);
      });

      it("asks the view that drives the project, never one that would hold the launch", async () => {
        journaled();
        // The caller watches the project from this machine; a remote Shell drives it.
        const watcher = { id: 1, send: vi.fn(), isDestroyed: () => false };
        const driver = { id: -7, send: vi.fn(), isDestroyed: () => false };
        state.views = [watcher, driver];
        lease.holder = "self";
        lease.holderHandle = -7;
        try {
          await trash();
          const restoring = invoke(
            CANOPY_METHOD_CHANNELS.restoreTrashed,
            fakeSender(1),
            "run-1",
            target
          );
          await vi.waitFor(() => expect(driver.send).toHaveBeenCalled());
          expect(watcher.send).not.toHaveBeenCalled();
          const { requestId } = driver.send.mock.calls[0]![1] as { requestId: string };
          await invoke(CANOPY_METHOD_CHANNELS.resumeSettled, fakeSender(-7), requestId, {
            runId: "run-9",
          });
          expect(await restoring).toEqual({ runId: "run-9" });
        } finally {
          lease.holder = null;
          lease.holderHandle = undefined;
        }
      });

      it("says to open the project when no view of it is open, and resumes nothing", async () => {
        journaled();
        state.views = [];
        await trash();
        const result = await invoke(
          CANOPY_METHOD_CHANNELS.restoreTrashed,
          fakeSender(1),
          "run-1",
          target
        );
        expect(result).toEqual({ open: { workspaceId: "project-2" } });
        expect(removeFromCanopyTrash).not.toHaveBeenCalled();
      });

      it("restores nothing whose worktree is gone, or that is still closing", async () => {
        await trashedOnHost();
        events.emit("terminal:trash-cleared", { id: "run-1", expiresAt: EXPIRES });
        expect(
          await refusal(
            invoke(CANOPY_METHOD_CHANNELS.restoreTrashed, fakeSender(1), "run-1", target)
          )
        ).toContain("still closing");

        journaled({ worktreeId: "/no/such/worktree-14891" });
        projectView(1);
        await vi.waitFor(async () =>
          expect((await trash())[0]).toMatchObject({ ended: { worktreeRemoved: true } })
        );
        expect(
          await refusal(
            invoke(CANOPY_METHOD_CHANNELS.restoreTrashed, fakeSender(1), "run-1", target)
          )
        ).toContain("worktree has been removed");
      });

      it("takes an ended run out of the Trash without ending anything", async () => {
        journaled();
        await trash();
        const removed = await outcome(
          invoke(CANOPY_METHOD_CHANNELS.removeTrashed, fakeSender(1), "run-1", target)
        );
        expect(removed.ok).toBe(true);
        expect(ptyClient.gracefulKill).not.toHaveBeenCalled();
        expect(removeFromCanopyTrash).toHaveBeenCalledWith(
          [{ id: "run-1", spawnedAt: 100 }],
          expect.any(String)
        );
        expect(await trash()).toEqual([]);
      });
    });

    it("restores a run a view trashed through the view holding its pane", async () => {
      const view = { send: vi.fn() };
      state.views = [view];
      await trashedOnHost();
      const restored = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.restoreTrashed, fakeSender(1), "run-1", target)
      );
      expect(restored.ok).toBe(true);
      expect(ptyClient.restore).toHaveBeenCalledWith("run-1");
      // The views of the project the run was trashed in, not the panel's.
      expect(getProjectPushTargets).toHaveBeenCalledWith("project-2", "canopy:restore-requested");
      expect(view.send).toHaveBeenCalledWith("canopy:restore-requested", { runId: "run-1" });
    });

    it("restores nothing for a trash it no longer holds, or with nowhere to put the pane", async () => {
      const view = { send: vi.fn() };
      state.views = [view];
      await trashedOnHost();
      // A later trash of the same run, or a respawn: not the one the panel showed.
      for (const stale of [
        { spawnedAt: 100, expiresAt: EXPIRES + 1 },
        { spawnedAt: 99, expiresAt: EXPIRES },
      ]) {
        const refused = await outcome(
          invoke(CANOPY_METHOD_CHANNELS.restoreTrashed, fakeSender(1), "run-1", stale)
        );
        expect(refused.ok).toBe(false);
      }
      // The host has let it go meanwhile.
      state.record = { ...state.record!, isTrashed: false, trashExpiresAt: undefined };
      const gone = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.restoreTrashed, fakeSender(1), "run-1", target)
      );
      expect(gone.ok).toBe(false);

      // No view of its project is open to hold the pane.
      await trashedOnHost();
      state.views = [];
      const closed = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.restoreTrashed, fakeSender(1), "run-1", target)
      );
      expect(closed.ok).toBe(false);
      expect(ptyClient.restore).not.toHaveBeenCalled();
      expect(view.send).not.toHaveBeenCalledWith("canopy:restore-requested", expect.anything());
    });

    it("leaves a trash in a project driven from another screen where it is", async () => {
      state.views = [{ send: vi.fn() }];
      await trashedOnHost();
      lease.holder = "other";
      for (const channel of [
        CANOPY_METHOD_CHANNELS.restoreTrashed,
        CANOPY_METHOD_CHANNELS.removeTrashed,
      ]) {
        const refused = await outcome(invoke(channel, fakeSender(1), "run-1", target));
        expect(refused.ok).toBe(false);
      }
      const emptied = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.emptyTrash, fakeSender(1), [{ runId: "run-1", ...target }])
      );
      expect(emptied.ok).toBe(false);
      expect(ptyClient.restore).not.toHaveBeenCalled();
      expect(ptyClient.gracefulKill).not.toHaveBeenCalled();
    });

    it("removes nothing when control moves elsewhere while the host is asked", async () => {
      await trashedOnHost();
      const held = state.record;
      ptyClient.getTerminalAsync.mockImplementationOnce(async () => {
        lease.holder = "other";
        return held;
      });
      lease.holder = "self";
      const refused = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.removeTrashed, fakeSender(1), "run-1", target)
      );
      expect(refused.ok).toBe(false);
      expect(ptyClient.gracefulKill).not.toHaveBeenCalled();
    });

    it("removes a run through the view holding its pane, and on the host when no view does", async () => {
      const view = { send: vi.fn() };
      state.views = [view];
      await trashedOnHost();
      const removed = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.removeTrashed, fakeSender(1), "run-1", target)
      );
      expect(removed.ok).toBe(true);
      // The view's own Remove ends it, keeping its session as any close does.
      expect(getProjectPushTargets).toHaveBeenCalledWith("project-2", "canopy:remove-requested");
      expect(view.send).toHaveBeenCalledWith("canopy:remove-requested", { runId: "run-1" });
      expect(ptyClient.gracefulKill).not.toHaveBeenCalled();

      state.views = [];
      const alone = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.removeTrashed, fakeSender(1), "run-1", target)
      );
      expect(alone.ok).toBe(true);
      await vi.waitFor(() => expect(ptyClient.gracefulKill).toHaveBeenCalledWith("run-1"));
    });

    it("ends on the host a removal no view took, keeping its session for resuming", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        // A view of the project is open, but it no longer holds the pane.
        state.views = [{ send: vi.fn() }];
        await trashedOnHost();
        // A scheduled run's pane: its run is named on the record (#15977).
        const run = { scheduleId: "schedule-1", runId: "sched-run-1" };
        state.record = { ...state.record!, scheduledRun: run };
        ptyClient.gracefulKill.mockResolvedValueOnce("sess-9");
        const captured: unknown[] = [];
        const off = events.on("agent-session:captured", (payload) => captured.push(payload));
        const removed = await outcome(
          invoke(CANOPY_METHOD_CHANNELS.removeTrashed, fakeSender(1), "run-1", target)
        );
        expect(removed.ok).toBe(true);
        expect(ptyClient.gracefulKill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(3_000);
        expect(ptyClient.gracefulKill).toHaveBeenCalledWith("run-1");
        await vi.waitFor(() => expect(captured).toHaveLength(1));
        expect(captured[0]).toMatchObject({
          terminalId: "run-1",
          boundary: "trash-expiry",
          record: {
            sessionId: "sess-9",
            agentId: "claude",
            projectId: "project-2",
            scheduledRun: run,
          },
        });
        off();
      } finally {
        vi.useRealTimers();
      }
    });

    it("ends no unheld removal once control has moved elsewhere", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        state.views = [{ send: vi.fn() }];
        await trashedOnHost();
        lease.holder = "self";
        const removed = await outcome(
          invoke(CANOPY_METHOD_CHANNELS.removeTrashed, fakeSender(1), "run-1", target)
        );
        expect(removed.ok).toBe(true);
        lease.holder = "other";
        await vi.advanceTimersByTimeAsync(3_000);
        expect(ptyClient.gracefulKill).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves a removal the view took to the view", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        state.views = [{ send: vi.fn() }];
        await trashedOnHost();
        await outcome(invoke(CANOPY_METHOD_CHANNELS.removeTrashed, fakeSender(1), "run-1", target));
        // The view's close takes it out of the trash.
        events.emit("terminal:trash-cleared", { id: "run-1", expiresAt: EXPIRES });
        await vi.advanceTimersByTimeAsync(3_000);
        expect(ptyClient.gracefulKill).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("empties exactly the runs confirmed, skipping one that left the trash since", async () => {
      await trashedOnHost();
      // Held too, but not in the list the user confirmed.
      events.emit("terminal:trashed", { id: "run-3", expiresAt: EXPIRES });
      // In the list, but restored before the empty lands.
      events.emit("terminal:trashed", { id: "run-2", expiresAt: EXPIRES });
      await heard();
      events.emit("terminal:restored", { id: "run-2" });
      const emptied = (await invoke(CANOPY_METHOD_CHANNELS.emptyTrash, fakeSender(1), [
        { runId: "run-1", ...target },
        { runId: "run-2", ...target },
      ])) as number | { data?: number };
      expect(typeof emptied === "number" ? emptied : emptied.data).toBe(1);
      await vi.waitFor(() => expect(ptyClient.gracefulKill).toHaveBeenCalledTimes(1));
      expect(ptyClient.gracefulKill).toHaveBeenCalledWith("run-1");
      expect((await trash()).map((entry) => entry.run.runId)).toEqual(
        expect.arrayContaining(["run-3"])
      );

      const refused = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.emptyTrash, fakeSender(1), [{ runId: "run-1" }])
      );
      expect(refused.ok).toBe(false);
    });
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

    it("lets a late cleanup end only its own stream, never the one opened since (#14454)", async () => {
      const first = await openStream();
      const second = await openStream(first.sender);
      expect(second.watchId).not.toBe(first.watchId);
      await invoke(CANOPY_METHOD_CHANNELS.unwatchTerminal, first.sender, first.watchId);
      await invoke(CANOPY_METHOD_CHANNELS.terminalInput, second.sender, second.watchId, "y");
      expect(state.writes).toEqual(["y"]);
      await invoke(CANOPY_METHOD_CHANNELS.unwatchTerminal, second.sender, second.watchId);
      const typed = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.terminalInput, second.sender, second.watchId, "z")
      );
      expect(typed.ok).toBe(false);
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

  describe("a reply that outlived its card (#15510)", () => {
    const reply = (text: string, imagePaths?: string[], sender: unknown = fakeSender(4)) =>
      outcome(
        invoke(
          CANOPY_METHOD_CHANNELS.submitReply,
          sender,
          "run-1",
          { spawnedAt: 100 },
          text,
          ...(imagePaths ? [imagePaths] : [])
        )
      );

    it("submits to the run with no stream open for it, while the view watches another", async () => {
      state.runs = [...state.runs, { runId: "run-2", spawnedAt: 100, workspaceId: "project-1" }];
      const sender = fakeSender(4);
      await invoke(CANOPY_METHOD_CHANNELS.watchTerminal, sender, "run-2", { spawnedAt: 100 });

      expect((await reply("navy", undefined, sender)).ok).toBe(true);
      expect(ptyClient.submit).toHaveBeenCalledWith("run-1", "navy");
    });

    it("goes with Canopy's reading off, as the pane's own replies do", async () => {
      state.mode = "unset";
      expect((await reply("navy")).ok).toBe(true);
      expect(state.submits).toEqual(["navy"]);
    });

    it("hands its image chips over with the text", async () => {
      expect((await reply("look", ["/tmp/shot.png"])).ok).toBe(true);
      expect(ptyClient.submit).toHaveBeenCalledWith(
        "run-1",
        "look",
        undefined,
        undefined,
        undefined,
        ["/tmp/shot.png"]
      );
    });

    it("reaches the run it names, in the incarnation it names, among several", async () => {
      state.runs = [...state.runs, { runId: "run-2", spawnedAt: 300, workspaceId: "project-1" }];
      ptyClient.getTerminalAsync.mockImplementation((async (runId: string) => ({
        spawnedAt: runId === "run-2" ? 300 : 100,
      })) as unknown as () => Promise<typeof state.record>);
      const to = (runId: string, spawnedAt: number, text: string) =>
        outcome(
          invoke(CANOPY_METHOD_CHANNELS.submitReply, fakeSender(4), runId, { spawnedAt }, text)
        );

      expect((await to("run-2", 300, "for two")).ok).toBe(true);
      expect((await to("run-1", 100, "for one")).ok).toBe(true);
      // The other run's incarnation is not this one's.
      expect((await to("run-2", 100, "stale")).ok).toBe(false);

      expect(ptyClient.submit.mock.calls.map(([runId, text]) => [runId, text])).toEqual([
        ["run-2", "for two"],
        ["run-1", "for one"],
      ]);
      ptyClient.getTerminalAsync.mockImplementation(async () => state.record);
    });

    it("never reaches a terminal respawned while the host was asked", async () => {
      ptyClient.getTerminalAsync.mockImplementationOnce(async () => {
        state.generation = 2;
        return state.record;
      });
      expect((await reply("navy")).ok).toBe(false);
      expect(state.submits).toEqual([]);
    });

    it("never reaches a terminal respawned under the run's id, or one that exited", async () => {
      state.record = { spawnedAt: 200 };
      expect((await reply("navy")).ok).toBe(false);
      state.record = { spawnedAt: 100, isExited: true };
      expect((await reply("navy")).ok).toBe(false);
      expect(state.submits).toEqual([]);
    });

    it("refuses a screen that doesn't drive the run, and attachments that aren't images", async () => {
      expect((await reply("navy", ["/etc/passwd"])).ok).toBe(false);
      lease.holder = "other";
      expect((await reply("navy")).ok).toBe(false);
      expect(state.submits).toEqual([]);
    });
  });

  describe("a Daintree Assistant a person chose (#14162)", () => {
    const subject = {
      hostId: "local",
      scope: { kind: "project", projectId: "project-1" },
      terminalId: "assistant-1",
      incarnation: 1,
      lane: 1,
    };

    beforeEach(() => {
      // The fleet never lists an assistant, and Canopy need not be on to view one.
      state.runs = [];
      state.mode = "unset";
      assistants.lane = { sessionId: "session-1", terminalId: "assistant-1" };
      assistants.ended.clear();
      assistants.global = null;
    });

    afterEach(() => {
      getIpcDispatcher().setRemoteRouter(null);
    });

    function capturingSender(id = 4) {
      const sent: Array<{ channel: string; payload: unknown }> = [];
      const sender = Object.assign(fakeSender(id), {
        send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
      });
      return { sender, sent };
    }

    async function openAssistant(
      sender = fakeSender(4),
      chosen: unknown = subject,
      ...stamp: unknown[]
    ) {
      const view = (await invoke(
        CANOPY_METHOD_CHANNELS.watchAssistantTerminal,
        sender,
        chosen,
        ...stamp
      )) as { data?: { watchId: number | null }; watchId?: number | null };
      return { sender, watchId: (view.data ?? view).watchId ?? null };
    }

    it("streams and answers the exact lane's run with no fleet row and Canopy off", async () => {
      const capture = capturingSender();
      const { sender, watchId } = await openAssistant(capture.sender);
      expect(watchId).not.toBeNull();
      const forward = ptyClient.on.mock.calls.find(([event]) => event === "data-mirror")?.[1] as (
        ...args: unknown[]
      ) => void;
      forward("assistant-1", "hello", 7);
      expect(capture.sent).toContainEqual({
        channel: CHANNELS.CANOPY_TERMINAL_DATA,
        payload: { kind: "data", watchId, runId: "assistant-1", data: "hello", streamEnd: 7 },
      });
      await invoke(CANOPY_METHOD_CHANNELS.terminalInput, sender, watchId, "y");
      await invoke(CANOPY_METHOD_CHANNELS.terminalSendKey, sender, watchId, "enter");
      await invoke(CANOPY_METHOD_CHANNELS.terminalSubmit, sender, watchId, "carry on");
      expect(state.writes).toEqual(["y"]);
      expect(ptyClient.sendKey).toHaveBeenCalledWith("assistant-1", "enter");
      expect(state.submits).toEqual(["carry on"]);
      // Nothing about viewing an assistant reaches the Canopy reader.
      expect(fetch).not.toHaveBeenCalled();
      expect(localReader.read).not.toHaveBeenCalled();
      expect(readPluginTerminalScreen).not.toHaveBeenCalled();
    });

    it("refuses another lane, another host, or a generation that has moved on", async () => {
      for (const chosen of [
        { ...subject, lane: 2 },
        { ...subject, lane: undefined },
        { ...subject, hostId: "elsewhere" },
        { ...subject, incarnation: 2 },
        { ...subject, terminalId: "assistant-2" },
      ]) {
        const result = await outcome(
          invoke(CANOPY_METHOD_CHANNELS.watchAssistantTerminal, fakeSender(4), chosen)
        );
        expect(result.ok).toBe(false);
      }
      expect(ptyClient.acquireIpcDataMirror).not.toHaveBeenCalled();
    });

    it("refuses a window bound to another host, whose input goes there", async () => {
      getIpcDispatcher().setRemoteRouter({
        hostForSender: () => "remote-1",
      } as unknown as Parameters<ReturnType<typeof getIpcDispatcher>["setRemoteRouter"]>[0]);
      const result = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.watchAssistantTerminal, fakeSender(4), subject)
      );
      expect(result).toEqual({
        ok: false,
        message: expect.stringContaining("machine they run on"),
      });
      expect(ptyClient.acquireIpcDataMirror).not.toHaveBeenCalled();
    });

    it("keeps an assistant's stream when Canopy is turned off", async () => {
      state.mode = "on";
      const { sender, watchId } = await openAssistant();
      const off = await outcome(invoke(CANOPY_METHOD_CHANNELS.setMode, sender, "unset"));
      expect(off.ok).toBe(true);
      await invoke(CANOPY_METHOD_CHANNELS.terminalInput, sender, watchId, "y");
      expect(state.writes).toEqual(["y"]);
    });

    it("takes the global session's input only from the window holding it", async () => {
      assistants.global = {
        terminalId: "global-1",
        generation: 5,
        owner: 7,
        holder: { attachmentId: "a7", epoch: 2 },
      };
      const globalSubject = {
        hostId: "local",
        scope: { kind: "global" },
        terminalId: "global-1",
        incarnation: 1,
      };
      // The reader names an ownership it doesn't hold; that grants nothing.
      const reader = await openAssistant(fakeSender(4), globalSubject, {
        attachmentId: "a7",
        inputEpoch: 2,
      });
      const owner = await openAssistant(fakeSender(7), globalSubject, {
        attachmentId: "a7",
        inputEpoch: 2,
      });
      for (const [channel, args] of [
        [CANOPY_METHOD_CHANNELS.terminalInput, ["y"]],
        [CANOPY_METHOD_CHANNELS.terminalSendKey, ["enter"]],
        [CANOPY_METHOD_CHANNELS.terminalSubmit, ["hi"]],
      ] as const) {
        const refused = await outcome(invoke(channel, reader.sender, reader.watchId, ...args));
        expect(refused).toEqual({
          ok: false,
          message: expect.stringContaining("another view holds"),
        });
      }
      expect(state.writes).toEqual([]);
      expect(ptyClient.sendKey).not.toHaveBeenCalled();
      expect(state.submits).toEqual([]);
      await invoke(CANOPY_METHOD_CHANNELS.terminalInput, owner.sender, owner.watchId, "y");
      expect(state.writes).toEqual(["y"]);

      // Input moves to another window while a submit waits on the host.
      ptyClient.getTerminalAsync.mockImplementationOnce(async () => {
        if (assistants.global) {
          assistants.global.owner = 4;
          assistants.global.holder = { attachmentId: "a4", epoch: 3 };
        }
        return state.record;
      });
      const moved = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.terminalSubmit, owner.sender, owner.watchId, "late")
      );
      expect(moved.ok).toBe(false);
      expect(state.submits).toEqual([]);
    });

    it("refuses input queued under an ownership the window has since lost and regained", async () => {
      assistants.global = {
        terminalId: "global-1",
        generation: 5,
        owner: 7,
        holder: { attachmentId: "a7", epoch: 2 },
      };
      const owner = await openAssistant(
        fakeSender(7),
        { hostId: "local", scope: { kind: "global" }, terminalId: "global-1", incarnation: 1 },
        { attachmentId: "a7", inputEpoch: 2 }
      );
      await invoke(CANOPY_METHOD_CHANNELS.terminalInput, owner.sender, owner.watchId, "a");
      // Another window takes input, then this one takes it back: a later epoch.
      assistants.global.holder = { attachmentId: "a7", epoch: 4 };
      const late = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.terminalInput, owner.sender, owner.watchId, "b")
      );
      expect(late.ok).toBe(false);
      expect(state.writes).toEqual(["a"]);
    });

    it("refuses a malformed input stamp", async () => {
      assistants.global = { terminalId: "global-1", generation: 5, owner: 7 };
      const refused = await outcome(
        invoke(
          CANOPY_METHOD_CHANNELS.watchAssistantTerminal,
          fakeSender(7),
          { hostId: "local", scope: { kind: "global" }, terminalId: "global-1", incarnation: 1 },
          { attachmentId: 5 }
        )
      );
      expect(refused.ok).toBe(false);
    });

    it("refuses the global session named as a project lane", async () => {
      assistants.global = { terminalId: "global-1", generation: 5, owner: 7 };
      const result = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.watchAssistantTerminal, fakeSender(4), {
          ...subject,
          scope: { kind: "project", projectId: "daintree:global-assistant" },
          lane: 0,
        })
      );
      expect(result.ok).toBe(false);
    });

    it("leaves the worker path closed to assistants", async () => {
      state.mode = "on";
      const result = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.watchTerminal, fakeSender(4), "assistant-1", {
          spawnedAt: 100,
        })
      );
      expect(result.ok).toBe(false);
    });

    it("ends the stream when the lane's session ends, refusing what was typed after", async () => {
      const sent: unknown[] = [];
      const sender = Object.assign(fakeSender(4), {
        send: (_channel: string, payload: unknown) => sent.push(payload),
      });
      const { watchId } = await openAssistant(sender);
      // Replaced without a byte of output: the lane now runs another session.
      assistants.lane = { sessionId: "session-2", terminalId: "assistant-1" };
      for (const listener of [...assistants.ended]) {
        listener({ projectId: "project-1", slot: 1, sessionId: "session-1" });
      }
      expect(sent).toContainEqual(expect.objectContaining({ kind: "ended", watchId }));
      expect(assistants.ended.size).toBe(0);
      const typed = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.terminalSubmit, sender, watchId, "stale")
      );
      expect(typed.ok).toBe(false);
      expect(state.submits).toEqual([]);
    });

    it("refuses a submit when the session is replaced while the host is asked", async () => {
      const { sender, watchId } = await openAssistant();
      ptyClient.getTerminalAsync.mockImplementationOnce(async () => {
        assistants.lane = { sessionId: "session-2", terminalId: "assistant-1" };
        return state.record;
      });
      const result = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.terminalSubmit, sender, watchId, "stale")
      );
      expect(result.ok).toBe(false);
      expect(state.submits).toEqual([]);
    });

    it("keeps the drive check on a person's reply", async () => {
      lease.holder = "other";
      const { sender, watchId } = await openAssistant();
      const typed = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.terminalInput, sender, watchId, "y")
      );
      expect(typed.ok).toBe(false);
      expect(state.writes).toEqual([]);
    });

    it("resolves Open to the exact lane, and to nothing once the session has ended", async () => {
      const resolved = (await invoke(
        CANOPY_METHOD_CHANNELS.resolveAssistant,
        fakeSender(4),
        subject
      )) as { data?: unknown };
      expect(resolved.data ?? resolved).toEqual({
        scope: "project",
        hostId: "local",
        projectId: "project-1",
        lane: 1,
        terminalId: "assistant-1",
        incarnation: 1,
      });
      assistants.lane = null;
      const ended = (await invoke(
        CANOPY_METHOD_CHANNELS.resolveAssistant,
        fakeSender(4),
        subject
      )) as { data?: unknown } | null;
      expect(ended?.data ?? ended).toBeNull();
    });
  });

  describe("the agent directory", () => {
    afterEach(() => {
      getIpcDispatcher().setRemoteRouter(null);
    });

    it("lists this machine's agents with Canopy off, reading no screen to do it", async () => {
      state.mode = "unset";
      const listed = (await invoke(CANOPY_METHOD_CHANNELS.readAgentDirectory, fakeSender(4))) as {
        data?: unknown;
      };
      expect((listed.data ?? listed) as { coverage: string }).toMatchObject({ coverage: "ok" });
      expect(directoryRead).toHaveBeenCalledWith({});
      expect(localReader.read).not.toHaveBeenCalled();
      expect(readPluginTerminalScreen).not.toHaveBeenCalled();
      expect(ptyClient.acquireIpcDataMirror).not.toHaveBeenCalled();
    });

    it("keeps to one project when asked, and refuses an id that isn't one", async () => {
      await invoke(CANOPY_METHOD_CHANNELS.readAgentDirectory, fakeSender(4), {
        projectId: "project-1",
      });
      expect(directoryRead).toHaveBeenLastCalledWith({ projectId: "project-1" });
      directoryRead.mockClear();
      for (const options of [
        { projectId: "" },
        { projectId: 7 },
        { projectId: "x".repeat(257) },
        [],
        null,
        "project-1",
      ]) {
        const result = await outcome(
          invoke(CANOPY_METHOD_CHANNELS.readAgentDirectory, fakeSender(4), options)
        );
        expect(result.ok).toBe(false);
      }
      expect(directoryRead).not.toHaveBeenCalled();
    });

    it("refuses a window bound to another host, whose agents aren't these", async () => {
      getIpcDispatcher().setRemoteRouter({
        hostForSender: () => "remote-1",
      } as unknown as Parameters<ReturnType<typeof getIpcDispatcher>["setRemoteRouter"]>[0]);
      const result = await outcome(
        invoke(CANOPY_METHOD_CHANNELS.readAgentDirectory, fakeSender(4))
      );
      expect(result.ok).toBe(false);
      expect(directoryRead).not.toHaveBeenCalled();
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

      const sizeHolds = () =>
        pushes.mock.calls
          .filter(
            ([channel, envelope]) =>
              channel === CHANNELS.EVENTS_PUSH &&
              (envelope as { name: string }).name === "terminal:canopy-size-holds-changed"
          )
          .map(([, envelope]) => (envelope as { payload: string[] }).payload);

      it("sizes the terminal while its machine drives it, and hands the size back (#14497)", async () => {
        lease.holder = "self";
        const { view, watchId } = await openViewerStream(-11);
        await view.call(CANOPY_METHOD_CHANNELS.terminalResize, watchId, 100, 30);
        expect(ptyClient.resize).toHaveBeenCalledWith("run-1", 100, 30);
        // This machine's own panes are told to hold still for it.
        expect(sizeHolds().at(-1)).toEqual(["run-1"]);
        const held = (await view.call(CANOPY_METHOD_CHANNELS.getSizeHolds)) as { data: string[] };
        expect(held.data).toEqual(["run-1"]);
        ptyClient.resize.mockClear();
        await view.call(CANOPY_METHOD_CHANNELS.unwatchTerminal);
        expect(ptyClient.resize).toHaveBeenCalledWith("run-1", 80, 24);
        expect(sizeHolds().at(-1)).toEqual([]);
      });

      it("says to the viewer that this host takes its size", async () => {
        lease.holder = "self";
        const view = viewer(-14);
        const opened = (await view.call(CANOPY_METHOD_CHANNELS.watchTerminal, "run-1", {
          spawnedAt: 100,
        })) as { data: { holdsSize?: boolean } };
        expect(opened.data.holdsSize).toBe(true);
      });

      it("never sizes a terminal another screen drives", async () => {
        lease.holder = "other";
        const { view, watchId } = await openViewerStream(-15);
        await view.call(CANOPY_METHOD_CHANNELS.terminalResize, watchId, 100, 30);
        expect(ptyClient.resize).not.toHaveBeenCalled();
        await view.call(CANOPY_METHOD_CHANNELS.unwatchTerminal);
        expect(ptyClient.resize).not.toHaveBeenCalled();
      });

      it("lets this machine's panes fit again once the lease moves away from the viewer", async () => {
        lease.holder = "self";
        const { view, watchId } = await openViewerStream(-16);
        await view.call(CANOPY_METHOD_CHANNELS.terminalResize, watchId, 100, 30);
        expect(sizeHolds().at(-1)).toEqual(["run-1"]);
        lease.holder = "other";
        for (const listener of lease.listeners) listener();
        expect(sizeHolds().at(-1)).toEqual([]);
        ptyClient.resize.mockClear();
        // Lost the drive: nothing is handed back over the new driver's size.
        await view.call(CANOPY_METHOD_CHANNELS.unwatchTerminal);
        expect(ptyClient.resize).not.toHaveBeenCalled();
      });

      it("hands the size back when the link to the viewer drops", async () => {
        lease.holder = "self";
        const { view, watchId } = await openViewerStream(-17);
        await view.call(CANOPY_METHOD_CHANNELS.terminalResize, watchId, 100, 30);
        ptyClient.resize.mockClear();
        view.close();
        expect(ptyClient.resize).toHaveBeenCalledWith("run-1", 80, 24);
        expect(sizeHolds().at(-1)).toEqual([]);
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

    describe("a person's assistant viewer reading this host (#14163)", () => {
      const subject = {
        hostId: "local",
        scope: { kind: "project", projectId: "project-1" },
        terminalId: "assistant-1",
        incarnation: 1,
        lane: 1,
      };
      const admissions: Array<() => void> = [];

      beforeEach(() => {
        state.runs = [];
        state.mode = "unset";
        assistants.lane = { sessionId: "session-1", terminalId: "assistant-1" };
        assistants.global = null;
        for (const channel of [
          CANOPY_METHOD_CHANNELS.watchAssistantTerminal,
          CANOPY_METHOD_CHANNELS.resolveAssistant,
        ]) {
          admissions.push(getIpcDispatcher().allowHybridOverLink(channel));
        }
      });

      afterEach(() => {
        for (const admitted of admissions.splice(0)) admitted();
      });

      const viewer = (handle: number) => remoteView(handle, `canopy-viewer:a${-handle}`);

      async function watch(view: ReturnType<typeof viewer>, chosen: unknown = subject) {
        const opened = (await view.call(CANOPY_METHOD_CHANNELS.watchAssistantTerminal, chosen)) as {
          ok: boolean;
          data?: { watchId: number };
        };
        return { ok: opened.ok, watchId: opened.data?.watchId ?? null };
      }

      it("streams and answers a lane with Canopy off, and never sizes it", async () => {
        const view = viewer(-21);
        const { ok, watchId } = await watch(view);
        expect(ok).toBe(true);
        await view.call(CANOPY_METHOD_CHANNELS.terminalInput, watchId, "y");
        await view.call(CANOPY_METHOD_CHANNELS.terminalSubmit, watchId, "carry on");
        await view.call(CANOPY_METHOD_CHANNELS.terminalResize, watchId, 100, 30);
        expect(state.writes).toEqual(["y"]);
        expect(state.submits).toEqual(["carry on"]);
        expect(ptyClient.resize).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      });

      it("reads while another machine drives the project, but types nothing", async () => {
        lease.holder = "other";
        const view = viewer(-22);
        const { ok, watchId } = await watch(view);
        expect(ok).toBe(true);
        const typed = (await view.call(CANOPY_METHOD_CHANNELS.terminalInput, watchId, "y")) as {
          ok: boolean;
          error?: { code?: string };
        };
        expect(typed).toMatchObject({ ok: false, error: { code: "DRIVEN_ELSEWHERE" } });
        expect(state.writes).toEqual([]);
      });

      it("refuses a stale generation or a subject naming another host", async () => {
        const view = viewer(-23);
        expect((await watch(view, { ...subject, incarnation: 2 })).ok).toBe(false);
        expect((await watch(view, { ...subject, hostId: "studio" })).ok).toBe(false);
        expect(ptyClient.acquireIpcDataMirror).not.toHaveBeenCalled();
      });

      it("only reads the global session: its input belongs to a window here", async () => {
        assistants.global = { terminalId: "global-1", generation: 5, owner: 7 };
        const view = viewer(-24);
        const { ok, watchId } = await watch(view, {
          hostId: "local",
          scope: { kind: "global" },
          terminalId: "global-1",
          incarnation: 1,
        });
        expect(ok).toBe(true);
        const typed = (await view.call(CANOPY_METHOD_CHANNELS.terminalInput, watchId, "y")) as {
          ok: boolean;
        };
        expect(typed.ok).toBe(false);
        expect(state.writes).toEqual([]);
      });

      it("refuses a remote project window's own endpoint, which is no viewer", async () => {
        const view = remoteView(-25);
        expect((await watch(view as ReturnType<typeof viewer>)).ok).toBe(false);
        expect(ptyClient.acquireIpcDataMirror).not.toHaveBeenCalled();
      });

      it("ends the watch when the viewer closes", async () => {
        const release = vi.fn();
        state.releaseMirror = release;
        const view = viewer(-26);
        expect((await watch(view)).ok).toBe(true);
        view.close();
        expect(activeTerminalWatches().has(-26)).toBe(false);
        expect(release).toHaveBeenCalledTimes(1);
      });

      it("is refused over a link while no assistant viewer is admitted", async () => {
        for (const admitted of admissions.splice(0)) admitted();
        const view = viewer(-27);
        const opened = (await view.call(
          CANOPY_METHOD_CHANNELS.watchAssistantTerminal,
          subject
        )) as { ok: boolean; error?: { code?: string } };
        expect(opened).toMatchObject({ ok: false, error: { code: "CHANNEL_NOT_REMOTABLE" } });
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
        state.writes.push(data);
        state.screen = state.redraw(state.screen, data);
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
