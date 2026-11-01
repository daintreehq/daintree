import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

const state = vi.hoisted(() => ({
  sqlite: null as Database.Database | null,
  shutdown: null as { initiator: string; phase: string } | null,
  sent: [] as Array<{ channel: string; event: unknown }>,
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => "/fake/userData",
    isPackaged: false,
    getAppPath: () => "/fake/appPath",
  },
}));

vi.mock("../../persistence/db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../persistence/db.js")>()),
  getSharedDb: vi.fn(),
  getSharedSqlite: () => state.sqlite,
}));

vi.mock("../../../lifecycle/shutdownCoordinator.js", () => ({
  getActiveShutdown: () => state.shutdown,
}));

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWebContentsForProject: (projectId: string) =>
    projectId === "project-1"
      ? [{ send: (channel: string, event: unknown) => state.sent.push({ channel, event }) }]
      : [],
}));

vi.mock("../../../ipc/endpointRegistry.js", () => ({
  getEndpointRegistry: () => ({ hasRemote: () => false }),
}));

const keepAwake = vi.hoisted(() => ({ getService: vi.fn() }));

vi.mock("../../PowerSaveBlockerService.js", () => ({
  getPowerSaveBlockerService: keepAwake.getService,
}));

const notifier = vi.hoisted(() => ({
  notify: vi.fn(async (_run: { id: string }, _attention: unknown) => {}),
}));

vi.mock("../scheduledRunNotifierLive.js", () => ({
  notifyScheduledRunAttention: notifier.notify,
}));

import { openDb } from "../../persistence/db.js";
import { events } from "../../events.js";
import { ScheduledRunStore } from "../ScheduledRunStore.js";
import type { RegisterScheduledLaunchInput } from "../ScheduledRunRecorder.js";
import {
  _resetScheduledRunRecorderForTest,
  getScheduledRunRecorder,
  hasOpenScheduledRun,
  onScheduledRunClosed,
  startScheduledRunFacts,
  whenScheduledRunNotificationsSent,
  type ScheduledRunFactSource,
} from "../index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../persistence/migrations");

let dir: string;
let source: EventEmitter;
let stop: () => void;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-scheduled-wiring-"));
  state.sqlite = openDb(path.join(dir, "app.db"), migrationsFolder).sqlite;
  state.shutdown = null;
  state.sent = [];
  keepAwake.getService.mockReset();
  notifier.notify.mockClear();
  _resetScheduledRunRecorderForTest();
  source = new EventEmitter();
  stop = startScheduledRunFacts(source as unknown as ScheduledRunFactSource);
});

afterEach(() => {
  stop();
  _resetScheduledRunRecorderForTest();
  state.sqlite?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const launch: RegisterScheduledLaunchInput = {
  id: "run-1",
  scheduleId: "schedule-1",
  projectId: "project-1",
  origin: { trigger: "run-now", dueAt: null, occurrenceKey: null, coalesced: null },
  terminalId: "terminal-1",
  resume: {
    agentId: "codex",
    agentSessionId: null,
    cwd: "/repo",
    worktreeId: null,
    agentLaunchFlags: [],
    agentModelId: null,
    agentPresetId: null,
  },
};

describe("scheduled-run history wiring", () => {
  it("settles an earlier lifetime's open runs when it opens, and tells the project's views", async () => {
    new ScheduledRunStore(state.sqlite!).insert({
      ...launch,
      createdAt: 1,
      terminalSpawnedAt: null,
      settlement: { state: "open" },
      process: { agent: { state: "not-started" }, pty: { state: "not-started" } },
      pane: { state: "none" },
    });
    const ended = vi.fn();
    const offEnded = events.on("scheduled-run:ended", ended);

    const [recorder, concurrent] = await Promise.all([
      getScheduledRunRecorder(),
      getScheduledRunRecorder(),
    ]);
    offEnded();
    expect(concurrent).toBe(recorder);

    expect(recorder?.get("run-1")?.settlement).toMatchObject({ outcome: "interrupted" });
    expect(ended).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }));
    expect(state.sent).toEqual([
      {
        channel: "events:push",
        event: {
          name: "scheduled-runs:changed",
          payload: { projectId: "project-1", scheduleIds: ["schedule-1"] },
        },
      },
    ]);
    expect(await getScheduledRunRecorder()).toBe(recorder);
  });

  it("has the keep-awake service listening before a run's start goes out", async () => {
    const order: string[] = [];
    keepAwake.getService.mockImplementation(() => order.push("keep-awake"));
    const offStarted = events.on("scheduled-run:started", (payload) =>
      order.push(`started ${payload.runId}`)
    );

    (await getScheduledRunRecorder())!.registerLaunch(launch);
    offStarted();

    expect(order).toEqual(["keep-awake", "started run-1"]);
  });

  it("still announces a run's start when keep-awake has been shut down", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    keepAwake.getService.mockImplementation(() => {
      throw new Error("Keep-awake is unavailable while Daintree shuts down");
    });
    const started = vi.fn();
    const offStarted = events.on("scheduled-run:started", started);

    (await getScheduledRunRecorder())!.registerLaunch(launch);
    offStarted();
    warn.mockRestore();

    expect(started).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }));
  });

  it("announces a schedule's deleted history on the main bus", async () => {
    const deleted = vi.fn();
    const offDeleted = events.on("scheduled-runs:deleted", deleted);
    const recorder = (await getScheduledRunRecorder())!;
    recorder.registerLaunch(launch);

    recorder.deleteForSchedule("schedule-1");
    offDeleted();

    expect(deleted).toHaveBeenCalledWith({
      projectId: "project-1",
      scheduleId: "schedule-1",
      timestamp: expect.any(Number),
    });
  });

  it("reads open runs without opening the history, which has none until it opens", async () => {
    new ScheduledRunStore(state.sqlite!).insert({
      ...launch,
      createdAt: 1,
      terminalSpawnedAt: null,
      settlement: { state: "open" },
      process: { agent: { state: "not-started" }, pty: { state: "not-started" } },
      pane: { state: "none" },
    });
    // An earlier lifetime's run, settled as interrupted once the history opens.
    expect(hasOpenScheduledRun()).toBe(false);

    const recorder = (await getScheduledRunRecorder())!;
    expect(hasOpenScheduledRun()).toBe(false);
    recorder.registerLaunch({ ...launch, id: "run-2", terminalId: "terminal-2" });
    expect(hasOpenScheduledRun()).toBe(true);
  });

  it("counts a history it can't read as no open run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const recorder = (await getScheduledRunRecorder())!;
    recorder.registerLaunch(launch);
    state.sqlite!.close();

    expect(hasOpenScheduledRun()).toBe(false);
    warn.mockRestore();
    state.sqlite = openDb(path.join(dir, "app.db"), migrationsFolder).sqlite;
  });

  it("hears every way a run stops being open, until it stops listening", async () => {
    const closed = vi.fn();
    const stopListening = onScheduledRunClosed(closed);
    const recorder = (await getScheduledRunRecorder())!;
    recorder.registerLaunch(launch);
    recorder.registerLaunch({
      ...launch,
      id: "run-2",
      scheduleId: "schedule-2",
      terminalId: "terminal-2",
    });

    recorder.settle("run-1", { kind: "cancel" });
    expect(closed).toHaveBeenCalledTimes(1);
    // A project removed with its history: its runs never end.
    events.emit("scheduled-runs:deleted", {
      projectId: "project-1",
      scheduleId: null,
      timestamp: 1,
    });
    expect(closed).toHaveBeenCalledTimes(2);

    stopListening();
    recorder.registerLaunch({
      ...launch,
      id: "run-3",
      scheduleId: "schedule-3",
      terminalId: "terminal-3",
    });
    recorder.settle("run-3", { kind: "cancel" });
    recorder.deleteForSchedule("schedule-2");
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it("records the PTY and session facts of a launched run", async () => {
    const recorder = (await getScheduledRunRecorder())!;
    recorder.registerLaunch(launch);

    source.emit("spawn-result", "terminal-1", { success: true, id: "terminal-1", spawnedAt: 50 });
    expect(recorder.get("run-1")?.process.pty).toEqual({ state: "running", startedAt: 50 });
    source.emit("incarnation-exit", {
      terminalId: "terminal-1",
      spawnedAt: 50,
      exitCode: 0,
      signal: null,
    });
    events.emit("agent-session:captured", {
      terminalId: "terminal-1",
      boundary: "exit",
      record: {
        sessionId: "codex-session",
        agentId: "codex",
        worktreeId: null,
        title: null,
        projectId: "project-1",
        terminal: { id: "terminal-1", spawnedAt: 50 },
      },
    });

    const run = recorder.get("run-1");
    expect(run?.settlement).toMatchObject({ outcome: "done" });
    expect(run?.resume?.agentSessionId).toBe("codex-session");
  });

  it("settles a run on its agent's launch marker (#15982)", async () => {
    const recorder = (await getScheduledRunRecorder())!;
    recorder.registerLaunch({ ...launch, handbackCode: "k7f3qa" });
    source.emit("spawn-result", "terminal-1", { success: true, id: "terminal-1", spawnedAt: 50 });

    events.emit("agent:run-handback-observed", {
      terminalId: "terminal-1",
      spawnedAt: 50,
      code: "k7f3qa",
      report: "needs-you",
      message: "a label needs a call",
      truncated: false,
      observedAt: 60,
      timestamp: 60,
    });

    expect(recorder.get("run-1")?.settlement).toMatchObject({
      outcome: "needs-you",
      evidence: { kind: "handback", report: "needs-you", summary: "a label needs a call" },
    });
  });

  it("notifies about a run that settles needing a person, and not one that went fine (#15988)", async () => {
    const recorder = (await getScheduledRunRecorder())!;
    recorder.registerLaunch(launch);
    recorder.registerLaunch({ ...launch, id: "run-2", terminalId: "terminal-2" });
    source.emit("spawn-result", "terminal-1", { success: true, id: "terminal-1", spawnedAt: 50 });
    source.emit("spawn-result", "terminal-2", { success: true, id: "terminal-2", spawnedAt: 51 });
    source.emit("incarnation-exit", {
      terminalId: "terminal-1",
      spawnedAt: 50,
      exitCode: 0,
      signal: null,
    });
    source.emit("incarnation-exit", {
      terminalId: "terminal-2",
      spawnedAt: 51,
      exitCode: 2,
      signal: null,
    });
    recorder.registerRefusedLaunch({
      id: "run-3",
      scheduleId: "schedule-1",
      projectId: "project-1",
      origin: launch.origin,
      terminalId: "terminal-3",
      message: "The project's folder is missing.",
    });

    await vi.waitFor(() =>
      expect(notifier.notify.mock.calls.map(([run]) => run.id)).toEqual(["run-2", "run-3"])
    );
    expect(notifier.notify.mock.calls.map(([run, attention]) => [run.id, attention])).toEqual([
      ["run-2", { kind: "exited", process: "pty", exitCode: 2 }],
      ["run-3", { kind: "launch-failed" }],
    ]);
  });

  it("tells a quit when the notifications already set off have gone out", async () => {
    await expect(whenScheduledRunNotificationsSent()).resolves.toBeUndefined();
    let delivered!: () => void;
    notifier.notify.mockImplementationOnce(
      () => new Promise<void>((resolve) => (delivered = resolve))
    );
    const recorder = (await getScheduledRunRecorder())!;
    recorder.registerRefusedLaunch({
      id: "run-3",
      scheduleId: "schedule-1",
      projectId: "project-1",
      origin: launch.origin,
      terminalId: "terminal-3",
      message: "The project's folder is missing.",
    });

    let sent = false;
    void whenScheduledRunNotificationsSent().then(() => (sent = true));
    await vi.waitFor(() => expect(notifier.notify).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(sent).toBe(false);

    delivered();
    await vi.waitFor(() => expect(sent).toBe(true));
  });

  it("settles a run lost when its pty-host dies with its incarnation", async () => {
    const recorder = (await getScheduledRunRecorder())!;
    recorder.registerLaunch(launch);
    source.emit("spawn-result", "terminal-1", {
      success: true,
      id: "terminal-1",
      spawnedAt: 50,
      launchGeneration: 7,
    });
    source.emit("incarnation-lost", { terminalId: "terminal-1", launchGeneration: 7 });

    expect(recorder.get("run-1")?.settlement).toMatchObject({ outcome: "lost" });
  });

  it("stops following facts once stopped", async () => {
    const recorder = (await getScheduledRunRecorder())!;
    recorder.registerLaunch({ ...launch, handbackCode: "k7f3qa" });
    source.emit("spawn-result", "terminal-1", { success: true, id: "terminal-1", spawnedAt: 50 });
    stop();
    stop = () => {};

    source.emit("incarnation-exit", {
      terminalId: "terminal-1",
      spawnedAt: 50,
      exitCode: 0,
      signal: null,
    });
    events.emit("agent-session:captured", {
      terminalId: "terminal-1",
      boundary: "exit",
      record: {
        sessionId: "codex-session",
        agentId: "codex",
        worktreeId: null,
        title: null,
        projectId: "project-1",
        terminal: { id: "terminal-1", spawnedAt: 50 },
      },
    });
    events.emit("agent:run-handback-observed", {
      terminalId: "terminal-1",
      spawnedAt: 50,
      code: "k7f3qa",
      report: "done",
      message: null,
      truncated: false,
      observedAt: 60,
      timestamp: 60,
    });
    expect(source.listenerCount("spawn-result")).toBe(0);
    expect(source.listenerCount("incarnation-exit")).toBe(0);
    expect(source.listenerCount("incarnation-lost")).toBe(0);
    const run = recorder.get("run-1");
    expect(run?.settlement).toEqual({ state: "open" });
    expect(run?.resume?.agentSessionId).toBeNull();
  });

  it("doesn't open the history once Daintree is quitting", async () => {
    state.shutdown = { initiator: "app-quit", phase: "cleaning" };
    expect(await getScheduledRunRecorder()).toBeNull();
  });

  it("opens the history and announces starts when keep-awake can't load", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    vi.doMock("../../PowerSaveBlockerService.js", () => {
      throw new Error("keep-awake failed to load");
    });
    try {
      const fresh = await import("../index.js");
      const { events: freshEvents } = await import("../../events.js");
      const started = vi.fn();
      const offStarted = freshEvents.on("scheduled-run:started", started);

      const recorder = await fresh.getScheduledRunRecorder();
      recorder?.registerLaunch(launch);
      offStarted();
      fresh._resetScheduledRunRecorderForTest();

      expect(recorder).not.toBeNull();
      expect(started).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }));
      expect(warn).toHaveBeenCalledWith(
        "[ScheduledRuns] Keep-awake couldn't load:",
        expect.anything()
      );
    } finally {
      vi.doMock("../../PowerSaveBlockerService.js", () => ({
        getPowerSaveBlockerService: keepAwake.getService,
      }));
      vi.resetModules();
      warn.mockRestore();
    }
  });
});
