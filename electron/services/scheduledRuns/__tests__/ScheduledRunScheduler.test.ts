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
import { ScheduledRunRecorder } from "../ScheduledRunRecorder.js";
import { ScheduledRunStore } from "../ScheduledRunStore.js";
import {
  ON_TIME_GRACE_MS,
  SCHEDULER_TICK_MS,
  ScheduledRunScheduler,
  type ScheduledRunSchedulerDeps,
  type ScheduledRunSchedulerLaunch,
} from "../ScheduledRunScheduler.js";
import type { ScheduleRunNowOutcome, SchedulesSnapshot } from "../../../../shared/types/ipc/schedules.js";
import type { Schedule, ScheduledRunOrigin } from "../../../../shared/types/scheduledRuns.js";
import { createSchedule, occurrenceKeyFor } from "../../../../shared/utils/scheduledRuns.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../persistence/migrations");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (hour: number, minute = 0, second = 0) => Date.UTC(2026, 10, 2, hour, minute, second);

const RESUME = {
  agentId: "claude",
  agentSessionId: null,
  cwd: "/repo",
  worktreeId: null,
  agentLaunchFlags: [],
  agentModelId: null,
  agentPresetId: null,
};

let dir: string;
let dbPath: string;
let sqlite: Database.Database;
let recorder: ScheduledRunRecorder;
/** How far the wall clock has moved from monotonic time: sleeps and clock changes. */
let skew: number;
let launchedAt: number[];
let ids: number;
let revision: number;
let snapshots: Map<string, SchedulesSnapshot>;
let listeners: Set<(snapshot: SchedulesSnapshot) => void>;
let projects: Set<string>;
let shuttingDown: boolean;
let launches: ScheduledRunSchedulerLaunch[];
let launchImpl: (input: ScheduledRunSchedulerLaunch) => Promise<ScheduleRunNowOutcome>;
let getRecorder: ReturnType<typeof vi.fn<() => Promise<ScheduledRunRecorder | null>>>;
let scheduler: ScheduledRunScheduler | null;

function openRecorder(): ScheduledRunRecorder {
  const opened = new ScheduledRunRecorder({
    store: new ScheduledRunStore(sqlite),
    now: () => Date.now(),
    logWarn: () => {},
  });
  opened.reconcileInterrupted();
  return opened;
}

/** What `launchScheduledRun` does on success: registers the run at its spawn. */
function registerAtSpawn(input: ScheduledRunSchedulerLaunch): ScheduleRunNowOutcome {
  const runId = `run-${++ids}`;
  const terminalId = `terminal-${runId}`;
  recorder.registerLaunch({
    id: runId,
    scheduleId: input.scheduleId,
    projectId: input.projectId,
    origin: input.origin,
    terminalId,
    resume: RESUME,
  });
  return { status: "started", runId, terminalId };
}

function schedule(overrides: Partial<Schedule> & { cron?: string; timeZone?: string } = {}) {
  const { cron = "0 * * * *", timeZone = "UTC", ...rest } = overrides;
  const created = createSchedule(
    {
      id: "schedule-1",
      projectId: "project-1",
      name: "Hourly triage",
      launch: { agentId: "claude", prompt: "Triage the new issues." },
      cron,
      timeZone,
    },
    rest.updatedAt ?? Date.now()
  );
  return { ...created, ...rest };
}

/** Commits a project's schedules as the store does, announcing them. */
function commit(projectId: string, schedules: Schedule[]): void {
  const snapshot = { projectId, schedules, revision: ++revision };
  snapshots.set(projectId, snapshot);
  for (const listener of listeners) listener(snapshot);
}

function deps(): ScheduledRunSchedulerDeps {
  return {
    listProjectIds: () => [...projects],
    projectExists: (projectId) => projects.has(projectId),
    listSchedules: async (projectId) =>
      snapshots.get(projectId) ?? { projectId, schedules: [], revision },
    subscribeSchedules: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getRecorder,
    launch: (input) => {
      launches.push(input);
      launchedAt.push(Date.now());
      return launchImpl(input);
    },
    newId: () => `skip-${++ids}`,
    isShuttingDown: () => shuttingDown,
    monotonicNow: () => Date.now() - skew,
    logInfo: () => {},
    logWarn: () => {},
  };
}

async function start(): Promise<ScheduledRunScheduler> {
  scheduler = new ScheduledRunScheduler(deps());
  await scheduler.start();
  await scheduler.idle();
  return scheduler;
}

/** Time passing while the machine is awake: both clocks and the timers move. */
async function elapse(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await scheduler?.idle();
}

/** The wall clock set to `time`, as a clock change or a quit does; no timer runs. */
function setClock(time: number): void {
  skew += time - Date.now();
  vi.setSystemTime(time);
}

/** A sleep: the wall clock moves on while monotonic time, and every timer, stands still. */
function sleepFor(ms: number): void {
  setClock(Date.now() + ms);
}

/** Quits and starts again on the same database. */
async function restart(): Promise<ScheduledRunScheduler> {
  await scheduler?.dispose();
  sqlite.close();
  sqlite = openDb(dbPath, migrationsFolder).sqlite;
  recorder = openRecorder();
  listeners.clear();
  return start();
}

function origins(): ScheduledRunOrigin[] {
  return launches.map((launch) => launch.origin);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(at(8, 30));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-scheduler-"));
  dbPath = path.join(dir, "app.db");
  sqlite = openDb(dbPath, migrationsFolder).sqlite;
  recorder = openRecorder();
  getRecorder = vi.fn(async () => recorder);
  skew = -1_000_000;
  launchedAt = [];
  ids = 0;
  revision = 0;
  snapshots = new Map();
  listeners = new Set();
  projects = new Set(["project-1"]);
  shuttingDown = false;
  launches = [];
  launchImpl = async (input) => registerAtSpawn(input);
  scheduler = null;
});

afterEach(async () => {
  await scheduler?.dispose();
  vi.useRealTimers();
  if (sqlite.open) sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("ScheduledRunScheduler", () => {
  it("launches a schedule within a minute of each due time while running", async () => {
    commit("project-1", [schedule()]);
    await start();
    expect(launches).toEqual([]);

    await elapse(30 * MINUTE);
    expect(origins()).toEqual([
      { trigger: "scheduled", dueAt: at(9), occurrenceKey: occurrenceKeyFor(at(9)), coalesced: null },
    ]);
    expect(launches[0]).toMatchObject({ projectId: "project-1", scheduleId: "schedule-1" });

    await elapse(HOUR);
    expect(origins().map((origin) => [origin.trigger, origin.dueAt])).toEqual([
      ["scheduled", at(9)],
      ["scheduled", at(10)],
    ]);
    expect(launchedAt).toEqual([at(9), at(10)]);
  });

  it("finds a due time its timer slept through on the next look at the wall clock", async () => {
    commit("project-1", [schedule({ cron: "0 9 * * *" })]);
    await start();

    // An event loop held up past the due time: the timer runs late, both clocks moved.
    vi.setSystemTime(at(8, 59, 59));
    await elapse(SCHEDULER_TICK_MS);
    expect(launches).toHaveLength(1);
    expect(origins()[0]).toMatchObject({ trigger: "scheduled", dueAt: at(9) });
    expect(launchedAt[0]! - at(9)).toBeLessThan(ON_TIME_GRACE_MS);
  });

  it("opens no history and keeps no timer while nothing is enabled", async () => {
    commit("project-1", [schedule({ enabled: false })]);
    await start();

    expect(getRecorder).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await elapse(2 * HOUR);
    expect(launches).toEqual([]);
  });

  it("applies the missed-run policy once, as one late run, for a sleep across due times", async () => {
    commit("project-1", [schedule({ updatedAt: at(8) })]);
    await start();

    scheduler!.suspend();
    sleepFor(5 * HOUR);
    scheduler!.resume();
    await scheduler!.idle();

    expect(origins()).toEqual([
      {
        trigger: "catch-up",
        dueAt: at(13),
        occurrenceKey: occurrenceKeyFor(at(13)),
        coalesced: { after: at(8), through: at(13, 30) },
      },
    ]);
    // Nothing more for the missed window, and the next one fires on time.
    await elapse(30 * MINUTE);
    expect(origins().map((origin) => [origin.trigger, origin.dueAt])).toEqual([
      ["catch-up", at(13)],
      ["scheduled", at(14)],
    ]);
  });

  it("records one skip for a sleep across due times when missed runs are skipped", async () => {
    const skipping = schedule({ updatedAt: at(8) });
    commit("project-1", [{ ...skipping, policies: { ...skipping.policies, missedRuns: "skip" } }]);
    await start();

    scheduler!.suspend();
    sleepFor(5 * HOUR);
    scheduler!.resume();
    await scheduler!.idle();

    expect(launches).toEqual([]);
    const runs = recorder.listBySchedule("schedule-1");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      origin: { trigger: "catch-up", dueAt: at(13), coalesced: { after: at(8), through: at(13, 30) } },
      settlement: { state: "settled", outcome: "skipped", evidence: { kind: "skip", reason: { kind: "missed" } } },
    });

    await elapse(30 * MINUTE);
    expect(origins().map((origin) => [origin.trigger, origin.dueAt])).toEqual([["scheduled", at(14)]]);
    expect(recorder.listBySchedule("schedule-1")).toHaveLength(2);
  });

  it("calls a due time a sleep spanned missed, even when the machine woke within the minute", async () => {
    vi.setSystemTime(at(8, 59, 50));
    commit("project-1", [schedule()]);
    await start();

    scheduler!.suspend();
    sleepFor(30_000);
    scheduler!.resume();
    await scheduler!.idle();

    expect(origins()).toEqual([
      expect.objectContaining({ trigger: "catch-up", dueAt: at(9) }),
    ]);
  });

  it("catches up a sleep with no power events from the clock alone", async () => {
    commit("project-1", [schedule({ updatedAt: at(8) })]);
    await start();

    // Linux and Windows stop monotonic time, and with it every timer, while asleep.
    sleepFor(3 * HOUR);
    await elapse(SCHEDULER_TICK_MS);

    expect(origins()).toEqual([
      expect.objectContaining({
        trigger: "catch-up",
        dueAt: at(11),
        coalesced: { after: at(8), through: at(11, 30, 30) },
      }),
    ]);
  });

  it("looks again at once on unlock", async () => {
    commit("project-1", [schedule({ updatedAt: at(8) })]);
    await start();

    // A clock set forward while the screen was locked; no timer has run since.
    setClock(at(9, 0, 5));
    scheduler!.unlock();
    await scheduler!.idle();

    expect(launches).toHaveLength(1);
  });

  it("catches up after a restart that spanned due times, and never reruns an occurrence that ran", async () => {
    commit("project-1", [schedule({ updatedAt: at(8) })]);
    await start();
    await elapse(30 * MINUTE);
    expect(origins().map((origin) => origin.trigger)).toEqual(["scheduled"]);

    // Quit at 09:00 and started again at 12:30.
    setClock(at(12, 30));
    await restart();
    expect(origins()).toEqual([
      expect.objectContaining({ trigger: "scheduled", dueAt: at(9) }),
      {
        trigger: "catch-up",
        dueAt: at(12),
        occurrenceKey: occurrenceKeyFor(at(12)),
        coalesced: { after: at(9), through: at(12, 30) },
      },
    ]);

    setClock(at(12, 31));
    await restart();
    expect(launches).toHaveLength(2);
  });

  it("catches up a due time a restart came moments after", async () => {
    setClock(at(9, 0, 5));
    commit("project-1", [schedule({ updatedAt: at(8) })]);
    await start();

    expect(origins()).toEqual([expect.objectContaining({ trigger: "catch-up", dueAt: at(9) })]);
  });

  it("leaves an occurrence due when Daintree quit before its run registered", async () => {
    commit("project-1", [schedule({ updatedAt: at(8) })]);
    launchImpl = () => new Promise(() => {});
    await start();
    await elapse(30 * MINUTE);
    expect(launches).toHaveLength(1);

    launchImpl = async (input) => registerAtSpawn(input);
    setClock(at(9, 10));
    await restart();
    expect(origins().map((origin) => [origin.trigger, origin.dueAt])).toEqual([
      ["scheduled", at(9)],
      ["catch-up", at(9)],
    ]);
  });

  it("never launches a schedule again while its launch is in flight", async () => {
    let finish: (outcome: ScheduleRunNowOutcome) => void = () => {};
    launchImpl = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    commit("project-1", [schedule({ updatedAt: at(8) })]);
    await start();
    await elapse(30 * MINUTE);
    scheduler!.unlock();
    scheduler!.resume();
    await elapse(2 * SCHEDULER_TICK_MS);
    expect(launches).toHaveLength(1);

    finish(registerAtSpawn(launches[0]!));
    await scheduler!.idle();
    expect(launches).toHaveLength(1);
  });

  it("tries a launch the history couldn't record again a minute later, not every tick", async () => {
    commit("project-1", [schedule({ updatedAt: at(8) })]);
    launchImpl = async () => ({ status: "failed", runId: null, message: "History unavailable" });
    await start();
    await elapse(30 * MINUTE);
    expect(launches).toHaveLength(1);

    launchImpl = async (input) => registerAtSpawn(input);
    await elapse(SCHEDULER_TICK_MS);
    expect(launches).toHaveLength(1);
    await elapse(SCHEDULER_TICK_MS + 1_000);
    expect(origins().map((origin) => [origin.trigger, origin.dueAt])).toEqual([
      ["scheduled", at(9)],
      ["catch-up", at(9)],
    ]);
  });

  it("counts a refused launch the history recorded as that occurrence's run", async () => {
    commit("project-1", [schedule({ updatedAt: at(8) })]);
    launchImpl = async (input) => {
      recorder.registerRefusedLaunch({ id: "refused", ...input, message: "No panel space" });
      return { status: "failed", runId: "refused", message: "No panel space" };
    };
    await start();
    await elapse(30 * MINUTE + 5 * SCHEDULER_TICK_MS);

    expect(launches).toHaveLength(1);
    expect(recorder.evaluationPoint("schedule-1")).toBe(at(9));
  });

  it("recomputes the next due time at once when a cadence is edited", async () => {
    commit("project-1", [schedule({ updatedAt: at(8) })]);
    await start();

    commit("project-1", [schedule({ cron: "45 * * * *", updatedAt: at(8, 30) })]);
    await scheduler!.idle();
    await elapse(15 * MINUTE);
    expect(origins()).toEqual([expect.objectContaining({ trigger: "scheduled", dueAt: at(8, 45) })]);

    await elapse(15 * MINUTE);
    expect(launches).toHaveLength(1);
  });

  it("never fires a disabled schedule, and doesn't catch up the time it was off", async () => {
    commit("project-1", [schedule({ updatedAt: at(8) })]);
    await start();
    expect(vi.getTimerCount()).toBe(1);

    commit("project-1", [schedule({ enabled: false, updatedAt: at(8, 30) })]);
    await scheduler!.idle();
    expect(vi.getTimerCount()).toBe(0);
    await elapse(2 * HOUR);
    expect(launches).toEqual([]);

    // Switched on at 10:30: 09:00 and 10:00 passed while it was off.
    commit("project-1", [schedule({ updatedAt: at(10, 30) })]);
    await scheduler!.idle();
    expect(launches).toEqual([]);
    await elapse(30 * MINUTE);
    expect(origins()).toEqual([expect.objectContaining({ trigger: "scheduled", dueAt: at(11) })]);
  });

  it("follows schedules created in a project added after it started", async () => {
    await start();
    projects.add("project-2");
    commit("project-2", [{ ...schedule(), id: "schedule-2", projectId: "project-2" }]);
    await scheduler!.idle();
    await elapse(30 * MINUTE);

    expect(launches).toEqual([
      expect.objectContaining({ projectId: "project-2", scheduleId: "schedule-2" }),
    ]);
  });

  it("keeps a removal over the slower first read of a project", async () => {
    commit("project-1", [schedule({ updatedAt: at(8) })]);
    const read = snapshots.get("project-1")!;
    let release: () => void = () => {};
    const base = deps();
    scheduler = new ScheduledRunScheduler({
      ...base,
      listSchedules: () => new Promise((resolve) => (release = () => resolve(read))),
    });
    const starting = scheduler.start();
    commit("project-1", []);
    release();
    await starting;
    await scheduler.idle();

    await elapse(HOUR);
    expect(launches).toEqual([]);
  });

  it("writes no skip for a project whose removal has begun", async () => {
    const skipping = schedule({ updatedAt: at(8) });
    commit("project-1", [{ ...skipping, policies: { ...skipping.policies, missedRuns: "skip" } }]);
    await start();

    projects.delete("project-1");
    scheduler!.suspend();
    sleepFor(2 * HOUR);
    scheduler!.resume();
    await scheduler!.idle();

    expect(recorder.listBySchedule("schedule-1")).toEqual([]);
    expect(recorder.evaluationPoint("schedule-1")).toBeNull();
  });

  it("keeps a system time-zone change from moving a due time", async () => {
    const machineZone = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      commit("project-1", [schedule({ cron: "0 9 * * *", timeZone: "Europe/London", updatedAt: at(8) })]);
      await start();

      process.env.TZ = "Asia/Tokyo";
      scheduler!.unlock();
      await elapse(30 * MINUTE);
      // London is on GMT in November: 09:00 there is 09:00 UTC.
      expect(origins()).toEqual([expect.objectContaining({ trigger: "scheduled", dueAt: at(9) })]);
    } finally {
      if (machineZone === undefined) delete process.env.TZ;
      else process.env.TZ = machineZone;
    }
  });

  it("never runs an occurrence twice after the clock is set back", async () => {
    commit("project-1", [schedule({ updatedAt: at(8) })]);
    await start();
    await elapse(30 * MINUTE + 10_000);
    expect(launches).toHaveLength(1);

    setClock(at(8, 58));
    await elapse(5 * MINUTE);
    expect(launches).toHaveLength(1);

    await elapse(HOUR);
    expect(origins().map((origin) => [origin.trigger, origin.dueAt])).toEqual([
      ["scheduled", at(9)],
      ["scheduled", at(10)],
    ]);
  });

  it("stops every timer on dispose and launches nothing after", async () => {
    commit("project-1", [schedule({ updatedAt: at(8) })]);
    await start();
    expect(vi.getTimerCount()).toBe(1);

    await scheduler!.dispose();
    expect(vi.getTimerCount()).toBe(0);
    sleepFor(2 * HOUR);
    scheduler!.resume();
    commit("project-1", [schedule({ updatedAt: at(8) })]);
    await elapse(HOUR);
    expect(launches).toEqual([]);
    expect(listeners.size).toBe(0);
  });

  it("launches and records nothing once Daintree is quitting", async () => {
    commit("project-1", [schedule({ updatedAt: at(8) })]);
    await start();

    shuttingDown = true;
    await elapse(HOUR);
    expect(launches).toEqual([]);
    expect(recorder.listBySchedule("schedule-1")).toEqual([]);
  });
});
