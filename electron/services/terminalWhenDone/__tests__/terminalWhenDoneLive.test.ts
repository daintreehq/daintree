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
  thawThenSend: (_wc: unknown, _pending: () => boolean, send: () => void) => send(),
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
import { buildHandbackInstruction } from "../../../../shared/utils/handback.js";
import {
  IN_USE_ANSWER_TIMEOUT_MS,
  _resetTerminalWhenDoneForTest,
  getTerminalWhenDone,
  isTerminalPaneInUse,
} from "../terminalWhenDoneLive.js";

const SPAWNED_AT = 1_800_000_000_040;
const PROJECT = "project-1";
const TERMINAL = "terminal-1";

type Answer = boolean | "silent";

/** A project view that answers the in-use query as told. */
function view(id: number, answer: Answer = false, loading = false) {
  const emitter = new EventEmitter();
  const wc = {
    id,
    isDestroyed: () => false,
    isLoadingMainFrame: () => loading,
    once: (event: string, listener: () => void) => emitter.once(event, listener),
    removeListener: (event: string, listener: () => void) =>
      emitter.removeListener(event, listener),
    send: vi.fn((channel: string, payload: { requestId?: string }) => {
      if (channel !== CHANNELS.TERMINAL_WHEN_DONE_IN_USE_QUERY || answer === "silent") return;
      queueMicrotask(() =>
        state.ipcMain.emit(
          CHANNELS.TERMINAL_WHEN_DONE_IN_USE_REPLY,
          { sender: wc },
          { requestId: payload.requestId, inUse: answer }
        )
      );
    }),
  };
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

/** The code the arming submission carried. */
function armingCode(): string {
  const call = state.ptyClient.submit.mock.calls[0] as unknown[];
  return call[3] as string;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  state.views = [];
  state.cached.clear();
  state.holder = null;
  state.shutdown = null;
  state.generation = 4;
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

  it("takes every on-screen view's answer, any yes keeping the pane", async () => {
    state.views = [view(1, false), view(2, false)];
    await expect(isTerminalPaneInUse(PROJECT, TERMINAL)).resolves.toBe(false);
    state.views = [view(1, false), view(2, true)];
    await expect(isTerminalPaneInUse(PROJECT, TERMINAL)).resolves.toBe(true);
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

  it("counts a person driving the project from another machine", async () => {
    state.holder = { kind: "remote-view" };
    await expect(isTerminalPaneInUse(PROJECT, TERMINAL)).resolves.toBe(true);
    state.holder = { kind: "local-view" };
    await expect(isTerminalPaneInUse(PROJECT, TERMINAL)).resolves.toBe(false);
  });
});

describe("getTerminalWhenDone live wiring", () => {
  it("sends the arming instruction undecorated and decorates later submits only while armed", async () => {
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
    expect(state.ptyClient.setSubmitDecorator).toHaveBeenLastCalledWith(expect.any(Function));
    expect(state.broadcast).toHaveBeenCalledWith(PROJECT, CHANNELS.TERMINAL_WHEN_DONE_CHANGED, {
      terminalId: TERMINAL,
      choice: "background",
    });

    await getTerminalWhenDone().set(TERMINAL, "keep", PROJECT);
    expect(state.ptyClient.setSubmitDecorator).toHaveBeenLastCalledWith(null);
    expect(state.ptyClient.listenerCount("incarnation-exit")).toBe(0);
  });

  it("refuses a terminal whose agent has left it, so a shell never runs the instruction", async () => {
    state.ptyClient.getTerminalAsync.mockResolvedValue(
      terminalInfo({ detectedAgentId: undefined, agentState: "exited" })
    );
    await expect(getTerminalWhenDone().set(TERMINAL, "close", PROJECT)).rejects.toThrow();
    expect(state.ptyClient.submit).not.toHaveBeenCalled();
  });

  it("backgrounds the pane in every view and the saved layout on done", async () => {
    const wc = view(1, false);
    state.views = [wc];
    await getTerminalWhenDone().set(TERMINAL, "background", PROJECT);

    events.emit("agent:run-handback-observed", {
      terminalId: TERMINAL,
      spawnedAt: SPAWNED_AT,
      code: armingCode(),
      report: "done",
      message: null,
      truncated: false,
      observedAt: SPAWNED_AT + 10,
      timestamp: SPAWNED_AT + 10,
    });
    await settle();

    expect(finishRequests(wc)).toEqual([{ terminalId: TERMINAL, action: "background" }]);
    expect(state.background).toHaveBeenCalledWith({ id: "project-store" }, PROJECT, TERMINAL);
    expect(state.ptyClient.gracefulKill).not.toHaveBeenCalled();
  });

  it("closes the terminal keeping its session, then removes the pane", async () => {
    const wc = view(1, false);
    state.views = [wc];
    const captured: unknown[] = [];
    events.on("agent-session:captured", (payload) => captured.push(payload));
    await getTerminalWhenDone().set(TERMINAL, "close", PROJECT);

    events.emit("agent:run-handback-observed", {
      terminalId: TERMINAL,
      spawnedAt: SPAWNED_AT,
      code: armingCode(),
      report: "done",
      message: "shipped",
      truncated: false,
      observedAt: SPAWNED_AT + 10,
      timestamp: SPAWNED_AT + 10,
    });
    await settle();

    expect(state.ptyClient.gracefulKill).toHaveBeenCalledWith(TERMINAL);
    expect(captured).toEqual([
      expect.objectContaining({
        terminalId: TERMINAL,
        boundary: "kill",
        record: expect.objectContaining({ sessionId: "claude-session", agentId: "claude" }),
      }),
    ]);
    expect(finishRequests(wc)).toEqual([{ terminalId: TERMINAL, action: "remove" }]);
    expect(state.forget).toHaveBeenCalledWith({ id: "project-store" }, PROJECT, TERMINAL);
    expect(state.ptyClient.setSubmitDecorator).toHaveBeenLastCalledWith(null);
  });

  it("moves nothing while someone is using the pane", async () => {
    const wc = view(1, true);
    state.views = [wc];
    await getTerminalWhenDone().set(TERMINAL, "close", PROJECT);

    events.emit("agent:run-handback-observed", {
      terminalId: TERMINAL,
      spawnedAt: SPAWNED_AT,
      code: armingCode(),
      report: "done",
      message: null,
      truncated: false,
      observedAt: SPAWNED_AT + 10,
      timestamp: SPAWNED_AT + 10,
    });
    await settle();

    expect(state.ptyClient.gracefulKill).not.toHaveBeenCalled();
    expect(finishRequests(wc)).toEqual([]);
    expect(state.forget).not.toHaveBeenCalled();
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
  });
});
