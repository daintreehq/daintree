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
    emit: (name, payload) => emitted.push({ name, payload }),
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
    const recorder = lifetime();
    const registered = recorder.registerLaunch(launch());

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
    expect(run?.process.pty).toMatchObject({ state: "exited", exitCode: 0, signal: null });
    expect(run?.settlement).toMatchObject({ state: "settled", outcome: "done" });
  });

  it("ignores another incarnation of its terminal", () => {
    const recorder = lifetime();
    recorder.registerLaunch(launch());
    recorder.handleSpawnResult("terminal-1", { success: true, spawnedAt: SPAWNED_AT });
    // A restart under the same id spawns, exits, and has a session captured.
    recorder.handleSpawnResult("terminal-1", { success: true, spawnedAt: SPAWNED_AT + 500 });
    recorder.handleExit({ terminalId: "terminal-1", spawnedAt: SPAWNED_AT + 500, exitCode: 1 });
    recorder.handleSessionCaptured(capture("someone-else", SPAWNED_AT + 500));

    const run = recorder.get("run-1");
    expect(run?.terminalSpawnedAt).toBe(SPAWNED_AT);
    expect(run?.process.pty).toEqual({ state: "running", startedAt: SPAWNED_AT });
    expect(run?.settlement).toEqual({ state: "open" });
    expect(run?.resume?.agentSessionId).toBeNull();
    // An exit with no incarnation can't be matched at all.
    recorder.handleExit({ terminalId: "terminal-1", exitCode: 0 });
    expect(recorder.get("run-1")?.settlement).toEqual({ state: "open" });
  });

  it("fills the session id captured after the exit, leaving the settlement alone", () => {
    const recorder = lifetime();
    recorder.registerLaunch(launch());
    recorder.handleSpawnResult("terminal-1", { success: true, spawnedAt: SPAWNED_AT });
    recorder.handleExit({ terminalId: "terminal-1", spawnedAt: SPAWNED_AT, exitCode: 0 });
    const settled = recorder.get("run-1")?.settlement;

    recorder.handleSessionCaptured(capture("codex-session", SPAWNED_AT, "claude"));
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

  it("settles a run another service saw end, once", () => {
    const recorder = lifetime();
    recorder.registerLaunch(launch());

    expect(recorder.settle("run-1", { kind: "cancel" })?.settlement).toMatchObject({
      outcome: "cancelled",
    });
    expect(recorder.settle("run-1", { kind: "handback", report: "done" })).toBeNull();
    expect(recorder.get("run-1")?.settlement).toMatchObject({ outcome: "cancelled" });
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

    const ids = recorder.listBySchedule("schedule-1").map((r) => r.id);
    // The open run is past the limit but still live, so it stays until it's over.
    expect(ids).toHaveLength(SCHEDULED_RUN_HISTORY_LIMIT + 1);
    expect(ids[0]).toBe(`skip-${SCHEDULED_RUN_HISTORY_LIMIT + 4}`);
    expect(ids).not.toContain("skip-4");
    expect(ids).toContain("skip-5");
    expect(ids.at(-1)).toBe("kept-open");
    expect(recorder.listBySchedule("schedule-2")).toHaveLength(1);

    recorder.settle("kept-open", { kind: "cancel" });
    expect(recorder.listBySchedule("schedule-1")).toHaveLength(SCHEDULED_RUN_HISTORY_LIMIT);
    expect(recorder.get("kept-open")).toBeNull();
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
    expect(emitted).toEqual([]);
  });
});
