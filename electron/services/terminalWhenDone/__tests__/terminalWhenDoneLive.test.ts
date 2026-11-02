import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  ipcMain: null as unknown as import("node:events").EventEmitter,
  views: [] as unknown[],
  cached: new Set<number>(),
  holder: null as { kind: "local-view" | "remote-view" } | null,
  shutdown: null as unknown,
  generation: 4 as number | undefined,
  broadcast: vi.fn(),
  background: vi.fn(async () => {}),
  forget: vi.fn(async () => {}),
  /** Sends waiting on a view's thaw, run by `flushThaws` the way `thawThenSend` does. */
  thaws: [] as Array<{ pending: () => boolean; send: () => void }>,
  ptyClient: null as unknown as {
    getTerminalAsync: ReturnType<typeof vi.fn>;
    gracefulKill: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    submit: ReturnType<typeof vi.fn>;
    setSubmitDecorator: ReturnType<typeof vi.fn>;
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    off: (event: string, listener: (...args: unknown[]) => void) => void;
    emit: (event: string, ...args: unknown[]) => boolean;
    listenerCount: (event: string) => number;
  },
}));

vi.mock("electron", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  state.ipcMain = new Emitter();
  return { ipcMain: state.ipcMain };
});
vi.mock("../../pty/lifecycleLedger.js", () => ({
  getLifecycleLedger: () => ({ currentGeneration: () => state.generation }),
}));
vi.mock("../../../lifecycle/shutdownCoordinator.js", () => ({
  getActiveShutdown: () => state.shutdown,
}));
vi.mock("../../../utils/thawThenSend.js", () => ({
  thawThenSend: (_wc: unknown, pending: () => boolean, send: () => void) =>
    state.thaws.push({ pending, send }),
}));
vi.mock("../../../window/serviceRefs.js", () => ({ getPtyClient: () => state.ptyClient }));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWebContentsForProject: () => state.views,
  isCachedViewWebContents: (id: number) => state.cached.has(id),
}));
vi.mock("../../DriveLeaseService.js", () => ({
  peekDriveLeaseService: () => ({ getHolderEndpoint: () => state.holder }),
}));
vi.mock("../../../ipc/utils.js", () => ({ broadcastToProjectRenderers: state.broadcast }));
vi.mock("../../ProjectStore.js", () => ({ projectStore: { id: "project-store" } }));
vi.mock("../../viewless/projectStateAuthoring.js", () => ({
  backgroundViewlessTerminal: state.background,
  forgetViewlessTerminal: state.forget,
}));

import { CHANNELS } from "../../../ipc/channels.js";
import { events } from "../../events.js";
import type { PtySubmitDecorator } from "../../PtyClient.js";
import {
  appendHandbackInstruction,
  buildHandbackInstruction,
} from "../../../../shared/utils/handback.js";
import {
  IN_USE_ANSWER_TIMEOUT_MS,
  _resetTerminalWhenDoneForTest,
  armWhenDoneLaunch,
  getTerminalWhenDone,
  isTerminalPaneInUse,
} from "../terminalWhenDoneLive.js";

const SPAWNED_AT = 1_800_000_000_040;
const PROJECT = "project-1";
const TERMINAL = "terminal-1";

/** How a view answers the in-use query: at once, never, or when the test says. */
type Answer = boolean | "silent" | "held";

function view(id: number, answer: Answer = false, loading = false) {
  const emitter = new EventEmitter();
  const held: string[] = [];
  const wc = {
    id,
    isDestroyed: () => false,
    isLoadingMainFrame: () => loading,
    once: (event: string, listener: () => void) => emitter.once(event, listener),
    removeListener: (event: string, listener: () => void) =>
      emitter.removeListener(event, listener),
    send: vi.fn((channel: string, payload: { requestId?: string }) => {
      if (channel !== CHANNELS.TERMINAL_WHEN_DONE_IN_USE_QUERY || answer === "silent") return;
      if (answer === "held") {
        held.push(payload.requestId!);
        return;
      }
      queueMicrotask(() => reply(payload.requestId!, answer));
    }),
    /** Answers every held query. */
    answer: (inUse: boolean) => {
      for (const requestId of held.splice(0)) reply(requestId, inUse);
    },
  };
  function reply(requestId: string, inUse: boolean) {
    state.ipcMain.emit(
      CHANNELS.TERMINAL_WHEN_DONE_IN_USE_REPLY,
      { sender: wc },
      { requestId, inUse }
    );
  }
  return wc;
}

const terminalInfo = (overrides: Record<string, unknown> = {}) => ({
  id: TERMINAL,
  spawnedAt: SPAWNED_AT,
  launchGeneration: 4,
  launchAgentId: "claude",
  detectedAgentId: "claude",
  agentState: "working",
  projectId: PROJECT,
  worktreeId: "/repo",
  cwd: "/repo",
  title: "Claude",
  agentLaunchFlags: [],
  hasPty: true,
  ...overrides,
});

function createPtyClient() {
  const emitter = new EventEmitter();
  return {
    getTerminalAsync: vi.fn(async () => terminalInfo()),
    gracefulKill: vi.fn(async () => "claude-session"),
    kill: vi.fn(),
    submit: vi.fn(),
    setSubmitDecorator: vi.fn(),
    on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
    off: (event: string, listener: (...args: unknown[]) => void) => emitter.off(event, listener),
    emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args),
    listenerCount: (event: string) => emitter.listenerCount(event),
  };
}

function finishRequests(wc: ReturnType<typeof view>) {
  return wc.send.mock.calls
    .filter(([channel]) => channel === CHANNELS.TERMINAL_WHEN_DONE_FINISH_REQUEST)
    .map(([, payload]) => payload);
}

function inUseQueries(wc: ReturnType<typeof view>) {
  return wc.send.mock.calls.filter(
    ([channel]) => channel === CHANNELS.TERMINAL_WHEN_DONE_IN_USE_QUERY
  );
}

/** The code the arming submission carried. */
function armingCode(): string {
  const call = state.ptyClient.submit.mock.calls[0] as unknown[];
  return call[3] as string;
}

function installedDecorator(): PtySubmitDecorator {
  const calls = state.ptyClient.setSubmitDecorator.mock.calls;
  return calls[calls.length - 1]?.[0] as PtySubmitDecorator;
}

function reportDone(code = armingCode(), report: "done" | "needs-you" = "done"): void {
  events.emit("agent:run-handback-observed", {
    terminalId: TERMINAL,
    spawnedAt: SPAWNED_AT,
    code,
    report,
    message: null,
    truncated: false,
    observedAt: SPAWNED_AT + 10,
    timestamp: SPAWNED_AT + 10,
  });
}

function flushThaws(): void {
  for (const { pending, send } of state.thaws.splice(0)) if (pending()) send();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  flushThaws();
}

beforeEach(() => {
  state.views = [];
  state.cached.clear();
  state.holder = null;
  state.shutdown = null;
  state.generation = 4;
  state.thaws = [];
  state.broadcast.mockClear();
  state.background.mockClear();
  state.forget.mockClear();
  state.ptyClient = createPtyClient();
});

afterEach(() => {
  _resetTerminalWhenDoneForTest();
  events.removeAllListeners();
  state.ipcMain.removeAllListeners();
  vi.useRealTimers();
});

describe("isTerminalPaneInUse (#16171)", () => {
  it("finds nobody using a pane no view shows", async () => {
    await expect(isTerminalPaneInUse(PROJECT, TERMINAL)).resolves.toBe(false);
  });

  it("asks no cached view, which is off screen", async () => {
    const cached = view(7, true);
    state.cached.add(7);
    state.views = [cached];
    await expect(isTerminalPaneInUse(PROJECT, TERMINAL)).resolves.toBe(false);
    expect(cached.send).not.toHaveBeenCalled();
  });

  it("asks every on-screen view, any yes keeping the pane", async () => {
    const views = [view(1, false), view(2, false)];
    state.views = views;
    await expect(isTerminalPaneInUse(PROJECT, TERMINAL)).resolves.toBe(false);
    for (const wc of views) expect(inUseQueries(wc)).toHaveLength(1);

    for (const answers of [
      [true, false],
      [false, true],
    ]) {
      state.views = answers.map((answer, index) => view(index + 1, answer));
      await expect(isTerminalPaneInUse(PROJECT, TERMINAL)).resolves.toBe(true);
    }
  });

  it("counts a view that can't answer as someone using the pane", async () => {
    state.views = [view(1, false, true)];
    await expect(isTerminalPaneInUse(PROJECT, TERMINAL)).resolves.toBe(true);

    vi.useFakeTimers();
    state.views = [view(2, "silent")];
    const answer = isTerminalPaneInUse(PROJECT, TERMINAL);
    await vi.advanceTimersByTimeAsync(IN_USE_ANSWER_TIMEOUT_MS);
    await expect(answer).resolves.toBe(true);
    expect(state.ipcMain.listenerCount(CHANNELS.TERMINAL_WHEN_DONE_IN_USE_REPLY)).toBe(0);
  });

  it("counts a person driving the project from another machine, before or during the answers", async () => {
    state.holder = { kind: "remote-view" };
    await expect(isTerminalPaneInUse(PROJECT, TERMINAL)).resolves.toBe(true);
    state.holder = { kind: "local-view" };
    await expect(isTerminalPaneInUse(PROJECT, TERMINAL)).resolves.toBe(false);

    const wc = view(1, "held");
    state.views = [wc];
    const answer = isTerminalPaneInUse(PROJECT, TERMINAL);
    state.holder = { kind: "remote-view" };
    wc.answer(false);
    await expect(answer).resolves.toBe(true);
  });
});

describe("getTerminalWhenDone live wiring", () => {
  it("sends the arming instruction undecorated, then gives each later prompt its own code", async () => {
    await getTerminalWhenDone().set(TERMINAL, "background", PROJECT);

    const code = armingCode();
    expect(state.ptyClient.submit).toHaveBeenCalledWith(
      TERMINAL,
      buildHandbackInstruction(code, "run"),
      undefined,
      code,
      undefined,
      undefined,
      null,
      "run"
    );
    expect(state.broadcast).toHaveBeenCalledWith(PROJECT, CHANNELS.TERMINAL_WHEN_DONE_CHANGED, {
      terminalId: TERMINAL,
      choice: "background",
    });

    const decorate = installedDecorator();
    const first = decorate(TERMINAL, "fix the bug", undefined);
    const second = decorate(TERMINAL, "fix the bug", undefined);
    expect(first?.text).toBe(appendHandbackInstruction("fix the bug", first!.handbackCode, "run"));
    expect(new Set([code, first?.handbackCode, second?.handbackCode]).size).toBe(3);
    expect(getTerminalWhenDone().peek(TERMINAL)?.outstanding).toBe(second?.handbackCode);
    expect(decorate("terminal-2", "fix the bug", undefined)).toBeNull();

    await getTerminalWhenDone().set(TERMINAL, "keep", PROJECT);
    expect(state.ptyClient.setSubmitDecorator).toHaveBeenLastCalledWith(null);
    expect(state.ptyClient.listenerCount("incarnation-exit")).toBe(0);
  });

  it("refuses a terminal with no agent in it, so a shell never runs the instruction", async () => {
    for (const shell of [
      terminalInfo({ detectedAgentId: undefined, launchAgentId: undefined, agentState: "idle" }),
      terminalInfo({ detectedAgentId: undefined, agentState: "exited" }),
    ]) {
      state.ptyClient.getTerminalAsync.mockResolvedValueOnce(shell);
      await expect(getTerminalWhenDone().set(TERMINAL, "close", PROJECT)).rejects.toThrow();
    }
    expect(state.ptyClient.submit).not.toHaveBeenCalled();
  });

  it("backgrounds the pane in every view and the saved layout on done", async () => {
    const views = [view(1, false), view(2, false)];
    state.views = views;
    await getTerminalWhenDone().set(TERMINAL, "background", PROJECT);

    reportDone();
    await settle();

    for (const wc of views) {
      expect(finishRequests(wc)).toEqual([{ terminalId: TERMINAL, action: "background" }]);
    }
    expect(state.background).toHaveBeenCalledWith(
      { id: "project-store" },
      PROJECT,
      TERMINAL,
      expect.any(Function)
    );
    expect(state.ptyClient.gracefulKill).not.toHaveBeenCalled();

    // The queued layout write asks again when it runs: a newer prompt since stops it.
    const stillWanted = (state.background.mock.calls[0] as unknown[])[3] as () => boolean;
    expect(stillWanted()).toBe(true);
    installedDecorator()(TERMINAL, "and the docs", undefined);
    expect(stillWanted()).toBe(false);
  });

  it("closes the terminal keeping its session before the pane goes", async () => {
    const wc = view(1, false);
    state.views = [wc];
    const captured: unknown[] = [];
    events.on("agent-session:captured", (payload) => captured.push(payload));
    let finishKill: (sessionId: string) => void = () => {};
    state.ptyClient.gracefulKill.mockImplementation(
      () => new Promise<string>((resolve) => (finishKill = resolve))
    );
    await getTerminalWhenDone().set(TERMINAL, "close", PROJECT);

    reportDone();
    await settle();
    expect(state.ptyClient.gracefulKill).toHaveBeenCalledWith(TERMINAL);
    expect(finishRequests(wc)).toEqual([]);
    expect(state.forget).not.toHaveBeenCalled();

    finishKill("claude-session");
    await settle();
    expect(captured).toEqual([
      expect.objectContaining({
        terminalId: TERMINAL,
        boundary: "kill",
        record: expect.objectContaining({ sessionId: "claude-session", agentId: "claude" }),
      }),
    ]);
    expect(finishRequests(wc)).toEqual([{ terminalId: TERMINAL, action: "remove" }]);
    expect(state.forget).toHaveBeenCalledWith(
      { id: "project-store" },
      PROJECT,
      TERMINAL,
      expect.any(Function)
    );
    // A successor spawned before the queued layout write runs keeps its saved pane.
    const stillWanted = (state.forget.mock.calls[0] as unknown[])[3] as () => boolean;
    expect(stillWanted()).toBe(true);
    state.generation = 5;
    expect(stillWanted()).toBe(false);
    expect(state.ptyClient.setSubmitDecorator).toHaveBeenLastCalledWith(null);
  });

  it.each(["background", "close"] as const)(
    "moves nothing on %s while someone is using the pane",
    async (choice) => {
      const wc = view(1, true);
      state.views = [wc];
      await getTerminalWhenDone().set(TERMINAL, choice, PROJECT);

      reportDone();
      await settle();

      expect(state.ptyClient.gracefulKill).not.toHaveBeenCalled();
      expect(finishRequests(wc)).toEqual([]);
      expect(state.background).not.toHaveBeenCalled();
      expect(state.forget).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["a newer prompt", () => installedDecorator()(TERMINAL, "and the docs", undefined)],
    ["Keep open", () => void getTerminalWhenDone().set(TERMINAL, "keep", PROJECT)],
    [
      "another machine taking the project",
      () => {
        state.holder = { kind: "remote-view" };
      },
    ],
    [
      "a restart",
      () => {
        state.generation = 5;
      },
    ],
  ])("closes nothing when %s arrives while the views answer", async (_name, change) => {
    const wc = view(1, "held");
    state.views = [wc];
    await getTerminalWhenDone().set(TERMINAL, "close", PROJECT);

    reportDone();
    await settle();
    change();
    wc.answer(false);
    await settle();

    expect(state.ptyClient.gracefulKill).not.toHaveBeenCalled();
    expect(finishRequests(wc)).toEqual([]);
    expect(state.forget).not.toHaveBeenCalled();
  });

  it("delivers no removal to a view once a successor spawned under the id", async () => {
    const wc = view(1, false);
    state.views = [wc];
    await getTerminalWhenDone().set(TERMINAL, "close", PROJECT);

    reportDone();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // The close finished; the view's thaw is still outstanding when the user restarts.
    state.generation = 5;
    flushThaws();

    expect(state.ptyClient.gracefulKill).toHaveBeenCalled();
    expect(finishRequests(wc)).toEqual([]);
  });

  it("moves nothing on needs-you, or on a code that isn't the outstanding one", async () => {
    const wc = view(1, false);
    state.views = [wc];
    await getTerminalWhenDone().set(TERMINAL, "close", PROJECT);

    reportDone("zzzzzz");
    reportDone(armingCode(), "needs-you");
    reportDone();
    await settle();

    expect(inUseQueries(wc)).toEqual([]);
    expect(state.ptyClient.gracefulKill).not.toHaveBeenCalled();
  });

  it("drops the choice when the incarnation exits or its host dies", async () => {
    await getTerminalWhenDone().set(TERMINAL, "close", PROJECT);
    state.ptyClient.emit("incarnation-exit", {
      terminalId: TERMINAL,
      spawnedAt: SPAWNED_AT,
      exitCode: 0,
      signal: null,
    });
    expect(getTerminalWhenDone().peek(TERMINAL)).toBeUndefined();

    await getTerminalWhenDone().set(TERMINAL, "close", PROJECT);
    state.ptyClient.emit("incarnation-lost", { terminalId: TERMINAL, launchGeneration: 4 });
    expect(getTerminalWhenDone().peek(TERMINAL)).toBeUndefined();

    await getTerminalWhenDone().set(TERMINAL, "close", PROJECT);
    events.emit("agent:exited", { terminalId: TERMINAL, timestamp: SPAWNED_AT + 5 });
    expect(getTerminalWhenDone().peek(TERMINAL)).toBeUndefined();

    await getTerminalWhenDone().set(TERMINAL, "close", PROJECT);
    state.ptyClient.emit("terminal-lost", TERMINAL);
    expect(getTerminalWhenDone().peek(TERMINAL)).toBeUndefined();
  });
});

describe("a recipe step's launch armed with When done (#16172)", () => {
  const launch = {
    terminalId: TERMINAL,
    projectId: PROJECT,
    launchGeneration: 4,
    choice: "close" as const,
    code: "launch",
  };

  it("is confirmed by the host's spawn result and closes on its prompt's done, sending nothing", async () => {
    const wc = view(1, false);
    state.views = [wc];
    expect(armWhenDoneLaunch(launch)).toBe(true);

    state.ptyClient.emit("spawn-result", TERMINAL, {
      success: true,
      id: TERMINAL,
      launchGeneration: 4,
      spawnedAt: SPAWNED_AT,
    });
    expect(state.broadcast).toHaveBeenCalledWith(PROJECT, CHANNELS.TERMINAL_WHEN_DONE_CHANGED, {
      terminalId: TERMINAL,
      choice: "close",
    });

    reportDone("launch");
    await settle();

    expect(state.ptyClient.submit).not.toHaveBeenCalled();
    expect(state.ptyClient.gracefulKill).toHaveBeenCalledTimes(1);
    expect(finishRequests(wc)).toEqual([{ terminalId: TERMINAL, action: "remove" }]);
  });

  it("stops listening when its spawn fails", () => {
    armWhenDoneLaunch(launch);
    expect(state.ptyClient.listenerCount("spawn-result")).toBe(1);

    state.ptyClient.emit("spawn-result", TERMINAL, {
      success: false,
      id: TERMINAL,
      launchGeneration: 4,
    });

    expect(getTerminalWhenDone().peek(TERMINAL)).toBeUndefined();
    expect(state.ptyClient.listenerCount("spawn-result")).toBe(0);
    expect(installedDecorator()).toBeNull();
    expect(state.broadcast).not.toHaveBeenCalled();
  });
});
