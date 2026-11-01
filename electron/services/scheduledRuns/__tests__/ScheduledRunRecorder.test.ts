import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/fake/userData",
    isPackaged: false,
    getAppPath: () => "/fake/appPath",
  },
}));

import { openDb } from "../../persistence/db.js";
import { ScheduledRunStore, SCHEDULED_RUN_HISTORY_LIMIT } from "../ScheduledRunStore.js";
import {
  ScheduledRunRecorder,
  type RegisterScheduledLaunchInput,
  type ScheduledRunsChange,
} from "../ScheduledRunRecorder.js";
import type { ScheduledRunResume } from "../../../../shared/types/scheduledRuns.js";
import { occurrenceKeyFor } from "../../../../shared/utils/scheduledRuns.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../persistence/migrations");

const T0 = Date.UTC(2026, 10, 1, 9);
const SPAWNED_AT = T0 + 40;

let dir: string;
let dbPath: string;
let sqlite: Database.Database;
let now: number;
let shuttingDown: boolean;
let changes: ScheduledRunsChange[];
let emitted: Array<{ name: string; payload: Record<string, unknown> }>;

function lifetime(): ScheduledRunRecorder {
  return new ScheduledRunRecorder({
    store: new ScheduledRunStore(sqlite),
    now: () => now,
    isShuttingDown: () => shuttingDown,
    onChanged: (change) => changes.push(change),
    onRunStarted: (payload) => emitted.push({ name: "scheduled-run:started", payload }),
    onRunEnded: (payload) => emitted.push({ name: "scheduled-run:ended", payload }),
    onRunsDeleted: (payload) => emitted.push({ name: "scheduled-runs:deleted", payload }),
    logWarn: () => {},
  });
}

/** Quits and starts again: a new connection and a recorder that reconciles first. */
function restart(): ScheduledRunRecorder {
  sqlite.close();
  sqlite = openDb(dbPath, migrationsFolder).sqlite;
  shuttingDown = false;
  const recorder = lifetime();
  recorder.reconcileInterrupted();
  return recorder;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-scheduled-recorder-"));
  dbPath = path.join(dir, "app.db");
  sqlite = openDb(dbPath, migrationsFolder).sqlite;
  now = T0;
  shuttingDown = false;
  changes = [];
  emitted = [];
});

afterEach(() => {
  if (sqlite.open) sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const resume = (agentId: string, agentSessionId: string | null = null): ScheduledRunResume => ({
  agentId,
  agentSessionId,
  cwd: "/repo",
  worktreeId: null,
  agentLaunchFlags: [],
  agentModelId: null,
  agentPresetId: null,
});

function launch(
  overrides: Partial<RegisterScheduledLaunchInput> = {}
): RegisterScheduledLaunchInput {
  return {
    id: "run-1",
    scheduleId: "schedule-1",
    projectId: "project-1",
    origin: { trigger: "run-now", dueAt: null, occurrenceKey: null, coalesced: null },
    terminalId: "terminal-1",
    resume: resume("codex"),
    ...overrides,
  };
}

const capture = (sessionId: string, spawnedAt: number, agentId = "codex") => ({
  record: {
    sessionId,
    agentId,
    projectId: "project-1",
    terminal: { id: "terminal-1", spawnedAt },
  },
});

describe("ScheduledRunRecorder", () => {
  it("commits a run before its terminal spawns, and says it started", () => {
    // Every listener reads the run through another connection: it is
    // committed before anyone hears of it.
    const reader = openDb(dbPath, migrationsFolder).sqlite;
    const seen: unknown[] = [];
    const readBack = () => seen.push(new ScheduledRunStore(reader).get("run-1")?.settlement);
    const recorder = new ScheduledRunRecorder({
      store: new ScheduledRunStore(sqlite),
      now: () => now,
      onChanged: (change) => {
        changes.push(change);
        readBack();
      },
      onRunStarted: (payload) => {
        emitted.push({ name: "scheduled-run:started", payload });
        readBack();
      },
    });
    const registered = recorder.registerLaunch(launch());
    reader.close();
    expect(seen).toEqual([{ state: "open" }, { state: "open" }]);

    // What a launcher reads back between registering and spawning.
    const stored = new ScheduledRunStore(sqlite).get("run-1");
    expect(stored).toEqual(registered);
    expect(stored?.settlement).toEqual({ state: "open" });
    expect(stored?.terminalId).toBe("terminal-1");
    expect(emitted).toEqual([
      {
        name: "scheduled-run:started",
        payload: {
          runId: "run-1",
          scheduleId: "schedule-1",
          projectId: "project-1",
          terminalId: "terminal-1",
          timestamp: T0,
        },
      },
    ]);
    expect(changes).toEqual([{ projectId: "project-1", scheduleIds: ["schedule-1"] }]);
  });

  it("records an agent that exits within milliseconds of spawning", () => {
    const recorder = lifetime();
    recorder.registerLaunch(launch());
    recorder.handleSpawnResult("terminal-1", { success: true, spawnedAt: SPAWNED_AT });
    now = SPAWNED_AT + 3;
    recorder.handleExit({ terminalId: "terminal-1", spawnedAt: SPAWNED_AT, exitCode: 2 });

    const run = recorder.get("run-1");
    expect(run?.terminalSpawnedAt).toBe(SPAWNED_AT);
    expect(run?.process.pty).toEqual({
      state: "exited",
      startedAt: SPAWNED_AT,
      exitedAt: SPAWNED_AT + 3,
      exitCode: 2,
      signal: null,
    });
    expect(run?.settlement).toMatchObject({ state: "settled", outcome: "failed" });
    expect(emitted.map((e) => e.name)).toEqual(["scheduled-run:started", "scheduled-run:ended"]);
    expect(emitted[1]?.payload).toMatchObject({ runId: "run-1", outcome: "failed" });
  });

  it("takes an exit that reaches it before the spawn answer, which then changes nothing", () => {
    const recorder = lifetime();
    recorder.registerLaunch(launch());
    recorder.handleExit({
      terminalId: "terminal-1",
      spawnedAt: SPAWNED_AT,
      exitCode: 0,
      signal: 0,
    });
    recorder.handleSpawnResult("terminal-1", { success: true, spawnedAt: SPAWNED_AT });

    const run = recorder.get("run-1");
    expect(run?.terminalSpawnedAt).toBe(SPAWNED_AT);
    expect(run?.process.pty).toMatchObject({ state: "exited", exitCode: 0, signal: null });
    expect(run?.settlement).toMatchObject({ state: "settled", outcome: "done" });
    expect(emitted.filter((e) => e.name === "scheduled-run:ended")).toHaveLength(1);
  });

  it("ignores the facts of another incarnation of its terminal", () => {
    const recorder = lifetime();
    recorder.registerLaunch(launch());
    recorder.handleSpawnResult("terminal-1", { success: true, spawnedAt: SPAWNED_AT });
    recorder.handleExit({ terminalId: "terminal-1", spawnedAt: SPAWNED_AT + 500, exitCode: 1 });
    recorder.handleSessionCaptured(capture("someone-else", SPAWNED_AT + 500));
    // An exit with no incarnation can't be matched at all.
    recorder.handleExit({ terminalId: "terminal-1", exitCode: 0 });

    const run = recorder.get("run-1");
    expect(run?.terminalSpawnedAt).toBe(SPAWNED_AT);
    expect(run?.process.pty).toEqual({ state: "running", startedAt: SPAWNED_AT });
    expect(run?.settlement).toEqual({ state: "open" });
    expect(run?.resume?.agentSessionId).toBeNull();
  });

  it("records the real exit of an incarnation a restart replaced", () => {
    const recorder = lifetime();
    recorder.registerLaunch(launch());
    recorder.handleSpawnResult("terminal-1", { success: true, spawnedAt: SPAWNED_AT });
    // The restart's incarnation spawns before the first one's exit reaches main.
    recorder.handleSpawnResult("terminal-1", { success: true, spawnedAt: SPAWNED_AT + 500 });
    expect(recorder.get("run-1")?.process.pty).toEqual({ state: "running", startedAt: SPAWNED_AT });

    recorder.handleExit({
      terminalId: "terminal-1",
      spawnedAt: SPAWNED_AT,
      exitCode: 0,
      signal: 1,
    });
    recorder.handleExit({ terminalId: "terminal-1", spawnedAt: SPAWNED_AT + 500, exitCode: 0 });

    const run = recorder.get("run-1");
    expect(run?.terminalSpawnedAt).toBe(SPAWNED_AT);
    expect(run?.process.pty).toMatchObject({ state: "exited", exitCode: 0, signal: 1 });
    expect(run?.settlement).toMatchObject({ outcome: "failed" });
    expect(emitted.filter((e) => e.name === "scheduled-run:ended")).toHaveLength(1);
  });

  it("is lost when its incarnation dies with the pty-host, and only its own", () => {
    const recorder = lifetime();
    recorder.registerLaunch(launch());
    recorder.handleSpawnResult("terminal-1", {
      success: true,
      spawnedAt: SPAWNED_AT,
      launchGeneration: 3,
    });
    recorder.handleIncarnationLost({ terminalId: "terminal-1", launchGeneration: 2 });
    expect(recorder.get("run-1")?.settlement).toEqual({ state: "open" });

    now = SPAWNED_AT + 900;
    recorder.handleIncarnationLost({ terminalId: "terminal-1", launchGeneration: 3 });
    // The replay's spawn and exit are another incarnation's.
    recorder.handleSpawnResult("terminal-1", {
      success: true,
      spawnedAt: SPAWNED_AT + 950,
      launchGeneration: 4,
    });
    recorder.handleExit({ terminalId: "terminal-1", spawnedAt: SPAWNED_AT + 950, exitCode: 0 });

    const run = recorder.get("run-1");
    expect(run?.settlement).toMatchObject({ outcome: "lost", evidence: { kind: "lost" } });
    expect(run?.process.pty).toEqual({
      state: "exited",
      startedAt: SPAWNED_AT,
      exitedAt: SPAWNED_AT + 900,
      exitCode: null,
      signal: null,
    });
    expect(emitted.filter((e) => e.name === "scheduled-run:ended")).toHaveLength(1);
    // Its session can still be captured afterwards.
    recorder.handleSessionCaptured(capture("codex-session", SPAWNED_AT));
    expect(recorder.get("run-1")?.resume?.agentSessionId).toBe("codex-session");
  });

  it("keeps the incarnation it saw first when writing it failed", () => {
    const store = new ScheduledRunStore(sqlite);
    const recorder = new ScheduledRunRecorder({ store, now: () => now, logWarn: () => {} });
    recorder.registerLaunch(launch());
    const update = vi.spyOn(store, "update").mockImplementationOnce(() => {
      throw new Error("SQLITE_FULL");
    });
    recorder.handleSpawnResult("terminal-1", { success: true, spawnedAt: SPAWNED_AT });
    update.mockRestore();
    expect(recorder.get("run-1")?.terminalSpawnedAt).toBeNull();

    // A later incarnation can't take the run, and a refused duplicate spawn
    // isn't its launch failing.
    recorder.handleSpawnResult("terminal-1", { success: true, spawnedAt: SPAWNED_AT + 500 });
    recorder.handleExit({ terminalId: "terminal-1", spawnedAt: SPAWNED_AT + 500, exitCode: 0 });
    recorder.handleSpawnResult("terminal-1", {
      success: false,
      error: { message: "Terminal terminal-1 already has a live owner" },
    });
    expect(recorder.get("run-1")?.terminalSpawnedAt).toBeNull();
    expect(recorder.get("run-1")?.settlement).toEqual({ state: "open" });

    // The first incarnation's own exit binds it once the database takes writes again.
    recorder.handleExit({ terminalId: "terminal-1", spawnedAt: SPAWNED_AT, exitCode: 0 });
    expect(recorder.get("run-1")?.terminalSpawnedAt).toBe(SPAWNED_AT);
    expect(recorder.get("run-1")?.settlement).toMatchObject({ outcome: "done" });
  });

  it("refuses a terminal id another run already holds", () => {
    const recorder = lifetime();
    recorder.registerLaunch(launch());
    recorder.registerSkip({
      id: "skipped",
      scheduleId: "schedule-2",
      projectId: "project-1",
      origin: { trigger: "run-now", dueAt: null, occurrenceKey: null, coalesced: null },
      reason: { kind: "overlap", openRunId: "run-1" },
      terminalId: "terminal-held",
    });

    expect(() => recorder.registerLaunch(launch({ id: "run-2" }))).toThrow(/already reserved/);
    expect(() =>
      recorder.registerLaunch(launch({ id: "run-3", terminalId: "terminal-held" }))
    ).toThrow(/already reserved/);
    // Deleting the run's schedule doesn't free its terminal id for another run:
    // a late fact from that terminal would be taken for the new run's.
    recorder.deleteForSchedule("schedule-1");
    expect(() => recorder.registerLaunch(launch({ id: "run-4" }))).toThrow(/already reserved/);
    expect(recorder.get("run-2")).toBeNull();
  });

  it("records the spawn and exit of a run settled before its spawn answered", () => {
    const recorder = lifetime();
    recorder.registerLaunch(launch());
    recorder.settle("run-1", { kind: "cancel" });
    recorder.handleSpawnResult("terminal-1", { success: true, spawnedAt: SPAWNED_AT });
    expect(recorder.get("run-1")?.process.pty).toEqual({ state: "running", startedAt: SPAWNED_AT });
    recorder.handleExit({
      terminalId: "terminal-1",
      spawnedAt: SPAWNED_AT,
      exitCode: 0,
      signal: 15,
    });

    const run = recorder.get("run-1");
    expect(run?.terminalSpawnedAt).toBe(SPAWNED_AT);
    expect(run?.process.pty).toMatchObject({ state: "exited", startedAt: SPAWNED_AT, signal: 15 });
    expect(run?.settlement).toMatchObject({ outcome: "cancelled" });
    expect(emitted.filter((e) => e.name === "scheduled-run:ended")).toHaveLength(1);
  });

  it("fills the session id captured after the exit, leaving the settlement alone", () => {
    const recorder = lifetime();
    recorder.registerLaunch(launch());
    recorder.handleSpawnResult("terminal-1", { success: true, spawnedAt: SPAWNED_AT });
    recorder.handleExit({ terminalId: "terminal-1", spawnedAt: SPAWNED_AT, exitCode: 0 });
    const settled = recorder.get("run-1")?.settlement;

    recorder.handleSessionCaptured(capture("codex-session", SPAWNED_AT, "claude"));
    recorder.handleSessionCaptured({
      record: { ...capture("elsewhere", SPAWNED_AT).record, projectId: "project-2" },
    });
    expect(recorder.get("run-1")?.resume?.agentSessionId).toBeNull();

    recorder.handleSessionCaptured(capture("codex-session", SPAWNED_AT));
    const run = recorder.get("run-1");
    expect(run?.resume?.agentSessionId).toBe("codex-session");
    expect(run?.settlement).toEqual(settled);
    expect(emitted.filter((e) => e.name === "scheduled-run:ended")).toHaveLength(1);
  });

  it("keeps the session id assigned at launch", () => {
    const recorder = lifetime();
    recorder.registerLaunch(launch({ resume: resume("claude", "assigned") }));
    recorder.handleSpawnResult("terminal-1", { success: true, spawnedAt: SPAWNED_AT });
    recorder.handleSessionCaptured(capture("other", SPAWNED_AT, "claude"));

    expect(recorder.get("run-1")?.resume?.agentSessionId).toBe("assigned");
  });

  it("settles a run whose terminal couldn't spawn as a launch error", () => {
    const recorder = lifetime();
    recorder.registerLaunch(launch());
    recorder.handleSpawnResult("terminal-1", {
      success: false,
      error: { message: "spawn zsh ENOENT" },
    });

    const run = recorder.get("run-1");
    expect(run?.settlement).toMatchObject({
      state: "settled",
      outcome: "failed",
      evidence: { kind: "launch-error", message: "spawn zsh ENOENT" },
    });
    expect(run?.process.pty).toEqual({ state: "not-started" });
    recorder.handleSpawnResult("terminal-1", { success: false, error: { message: "again" } });
    expect(recorder.get("run-1")?.settlement).toEqual(run?.settlement);
    expect(emitted.filter((e) => e.name === "scheduled-run:ended")).toHaveLength(1);
  });

  it("records a skipped occurrence with its reason, and neither starts nor ends it", () => {
    const recorder = lifetime();
    recorder.registerSkip({
      id: "run-2",
      scheduleId: "schedule-1",
      projectId: "project-1",
      origin: {
        trigger: "scheduled",
        dueAt: T0,
        occurrenceKey: occurrenceKeyFor(T0),
        coalesced: null,
      },
      reason: { kind: "overlap", openRunId: "run-1" },
    });

    expect(recorder.get("run-2")?.settlement).toMatchObject({
      outcome: "skipped",
      evidence: { kind: "skip", reason: { kind: "overlap", openRunId: "run-1" } },
    });
    expect(emitted).toEqual([]);
    expect(changes).toEqual([{ projectId: "project-1", scheduleIds: ["schedule-1"] }]);
  });

  it("records a refused launch as failed with its reason, holding its reserved terminal id", () => {
    const recorder = lifetime();
    recorder.registerRefusedLaunch({
      id: "run-3",
      scheduleId: "schedule-1",
      projectId: "project-1",
      origin: launch().origin,
      terminalId: "terminal-3",
      message: "The project already has as many panels as it can hold.",
    });

    const run = recorder.get("run-3");
    expect(run).toMatchObject({
      terminalId: "terminal-3",
      resume: null,
      pane: { state: "none" },
      process: { agent: { state: "not-started" }, pty: { state: "not-started" } },
      settlement: {
        state: "settled",
        outcome: "failed",
        evidence: {
          kind: "launch-error",
          message: "The project already has as many panels as it can hold.",
        },
      },
    });
    expect(emitted).toEqual([]);
    expect(changes).toEqual([{ projectId: "project-1", scheduleIds: ["schedule-1"] }]);
    expect(recorder.hasOpenRun("project-1")).toBe(false);
    // Its terminal never spawned under the run, so a late spawn of the id isn't the run's.
    recorder.handleSpawnResult("terminal-3", { success: true, spawnedAt: SPAWNED_AT });
    expect(recorder.get("run-3")).toEqual(run);
    expect(() => recorder.registerLaunch(launch({ terminalId: "terminal-3" }))).toThrow(
      /already reserved/
    );
  });

  it("has an open run in a project only until the run settles", () => {
    const recorder = lifetime();
    expect(recorder.hasOpenRun("project-1")).toBe(false);
    recorder.registerLaunch(launch());
    expect(recorder.hasOpenRun("project-1")).toBe(true);
    expect(recorder.hasOpenRun("project-2")).toBe(false);

    recorder.handleSpawnResult("terminal-1", { success: true, spawnedAt: SPAWNED_AT });
    recorder.handleExit({ terminalId: "terminal-1", spawnedAt: SPAWNED_AT, exitCode: 0 });
    expect(recorder.hasOpenRun("project-1")).toBe(false);
  });

  it("settles a run another service saw end, once", () => {
    const recorder = lifetime();
    recorder.registerLaunch(launch());

    expect(recorder.settle("run-1", { kind: "cancel" })?.settlement).toMatchObject({
      outcome: "cancelled",
    });
    expect(recorder.settle("run-1", { kind: "handback", report: "done" })).toBeNull();
    expect(recorder.get("run-1")?.settlement).toMatchObject({ outcome: "cancelled" });
    expect(emitted.filter((e) => e.name === "scheduled-run:ended")).toHaveLength(1);
  });

  describe("across a quit or crash", () => {
    it("settles the runs an earlier lifetime left open as interrupted", () => {
      const first = lifetime();
      first.registerLaunch(launch());
      first.handleSpawnResult("terminal-1", { success: true, spawnedAt: SPAWNED_AT });
      first.registerLaunch(launch({ id: "run-2", terminalId: "terminal-2" }));
      first.registerLaunch(launch({ id: "run-3", terminalId: "terminal-3" }));
      first.handleSpawnResult("terminal-3", { success: true, spawnedAt: SPAWNED_AT });
      first.settle("run-3", { kind: "handback", report: "done" });
      // A settled run whose agent was last seen running, as a later producer records it.
      const store = new ScheduledRunStore(sqlite);
      const settled = store.get("run-3")!;
      store.update({
        ...settled,
        process: { ...settled.process, agent: { state: "running", startedAt: SPAWNED_AT } },
      });

      now = T0 + 60_000;
      emitted = [];
      const second = restart();

      const spawned = second.get("run-1");
      expect(spawned?.settlement).toEqual({
        state: "settled",
        settledAt: now,
        outcome: "interrupted",
        evidence: { kind: "interrupted" },
      });
      expect(spawned?.process.pty).toEqual({
        state: "exited",
        startedAt: SPAWNED_AT,
        exitedAt: now,
        exitCode: null,
        signal: null,
      });
      // Registered but killed before its terminal spawned.
      expect(second.get("run-2")?.settlement).toMatchObject({ outcome: "interrupted" });
      expect(second.get("run-2")?.process.pty).toEqual({ state: "not-started" });
      // Already settled: the settlement stays, the process is no longer running.
      expect(second.get("run-3")?.settlement).toMatchObject({ outcome: "done" });
      expect(second.get("run-3")?.process.pty).toMatchObject({ state: "exited", exitCode: null });
      expect(second.get("run-3")?.process.agent).toEqual({
        state: "exited",
        startedAt: SPAWNED_AT,
        exitedAt: now,
        exitCode: null,
        signal: null,
      });
      expect(emitted.map((e) => [e.name, e.payload.runId])).toEqual([
        ["scheduled-run:ended", "run-1"],
        ["scheduled-run:ended", "run-2"],
      ]);

      expect(second.reconcileInterrupted()).toBe(0);
    });

    it("keeps a quit's terminal kills from settling the run", () => {
      const first = lifetime();
      first.registerLaunch(launch());
      first.handleSpawnResult("terminal-1", { success: true, spawnedAt: SPAWNED_AT });
      shuttingDown = true;
      first.handleExit({ terminalId: "terminal-1", spawnedAt: SPAWNED_AT, exitCode: 1, signal: 1 });

      expect(first.get("run-1")?.settlement).toEqual({ state: "open" });
      expect(first.get("run-1")?.process.pty).toMatchObject({ state: "exited", signal: 1 });

      const second = restart();
      const run = second.get("run-1");
      expect(run?.settlement).toMatchObject({ outcome: "interrupted" });
      expect(run?.process.pty).toMatchObject({ state: "exited", exitCode: 1, signal: 1 });
    });
  });

  it("keeps the newest runs of each schedule", () => {
    const recorder = lifetime();
    recorder.registerLaunch(launch({ id: "kept-open", terminalId: "t-open" }));
    for (let i = 0; i < SCHEDULED_RUN_HISTORY_LIMIT + 5; i++) {
      now = T0 + 1 + i;
      recorder.registerSkip({
        id: `skip-${i}`,
        scheduleId: "schedule-1",
        projectId: "project-1",
        origin: { trigger: "run-now", dueAt: null, occurrenceKey: null, coalesced: null },
        reason: { kind: "overlap", openRunId: "kept-open" },
      });
    }
    recorder.registerLaunch(launch({ id: "other", scheduleId: "schedule-2", terminalId: "t-2" }));
    now += 1;
    recorder.registerLaunch(launch({ id: "newest", terminalId: "t-newest" }));

    const ids = recorder.listBySchedule("schedule-1").map((r) => r.id);
    // The open run is past the limit but still live, so it stays until it's over.
    expect(ids).toHaveLength(SCHEDULED_RUN_HISTORY_LIMIT + 1);
    expect(ids[0]).toBe("newest");
    expect(ids).not.toContain("skip-5");
    expect(ids).toContain("skip-6");
    expect(ids.at(-1)).toBe("kept-open");
    expect(recorder.listBySchedule("schedule-2")).toHaveLength(1);

    recorder.settle("kept-open", { kind: "cancel" });
    expect(recorder.listBySchedule("schedule-1")).toHaveLength(SCHEDULED_RUN_HISTORY_LIMIT);
    expect(recorder.get("kept-open")).toBeNull();
    expect(recorder.get("newest")).not.toBeNull();
  });

  it("deletes a schedule's history with it, and a late fact doesn't bring it back", () => {
    const recorder = lifetime();
    recorder.registerLaunch(launch());
    recorder.handleSpawnResult("terminal-1", { success: true, spawnedAt: SPAWNED_AT });
    recorder.registerLaunch(launch({ id: "kept", scheduleId: "schedule-2", terminalId: "t-2" }));
    changes = [];
    emitted = [];

    recorder.deleteForSchedule("schedule-1");
    recorder.handleExit({ terminalId: "terminal-1", spawnedAt: SPAWNED_AT, exitCode: 0 });
    recorder.handleSessionCaptured(capture("late", SPAWNED_AT));

    expect(recorder.listBySchedule("schedule-1")).toEqual([]);
    expect(recorder.get("run-1")).toBeNull();
    expect(recorder.get("kept")).not.toBeNull();
    expect(changes).toEqual([{ projectId: "project-1", scheduleIds: ["schedule-1"] }]);
    // Deleted, its open run never ends: services hear of the deletion instead.
    expect(emitted).toEqual([
      {
        name: "scheduled-runs:deleted",
        payload: { projectId: "project-1", scheduleId: "schedule-1", timestamp: now },
      },
    ]);
  });

  it("reports a deletion even when a view listener throws, and none for a schedule with no runs", () => {
    const deleted: unknown[] = [];
    const recorder = new ScheduledRunRecorder({
      store: new ScheduledRunStore(sqlite),
      now: () => now,
      onChanged: () => {
        throw new Error("view gone");
      },
      onRunsDeleted: (payload) => deleted.push(payload),
      logWarn: () => {},
    });
    recorder.registerLaunch(launch());

    recorder.deleteForSchedule("schedule-none");
    expect(deleted).toEqual([]);

    try {
      recorder.deleteForSchedule("schedule-1");
    } catch {
      // The view listener's failure is the caller's to log.
    }
    expect(deleted).toEqual([{ projectId: "project-1", scheduleId: "schedule-1", timestamp: now }]);
  });

  it("still tells the views of a deletion when a deletion listener throws", () => {
    const viewChanges: ScheduledRunsChange[] = [];
    const recorder = new ScheduledRunRecorder({
      store: new ScheduledRunStore(sqlite),
      now: () => now,
      onChanged: (change) => viewChanges.push(change),
      onRunsDeleted: () => {
        throw new Error("listener failed");
      },
      logWarn: () => {},
    });
    recorder.registerLaunch(launch());
    viewChanges.length = 0;

    expect(() => recorder.deleteForSchedule("schedule-1")).not.toThrow();
    expect(viewChanges).toEqual([{ projectId: "project-1", scheduleIds: ["schedule-1"] }]);
    expect(recorder.get("run-1")).toBeNull();
  });
});
