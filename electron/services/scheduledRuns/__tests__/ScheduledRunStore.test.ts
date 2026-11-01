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
import { ScheduledRunConflictError, ScheduledRunStore } from "../ScheduledRunStore.js";
import type { ScheduledRun } from "../../../../shared/types/scheduledRuns.js";
import { occurrenceKeyFor } from "../../../../shared/utils/scheduledRuns.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../persistence/migrations");

const T0 = Date.UTC(2026, 10, 1, 9);

let dir: string;
let dbPath: string;
let sqlite: Database.Database;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-scheduled-runs-"));
  dbPath = path.join(dir, "app.db");
  sqlite = openDb(dbPath, migrationsFolder).sqlite;
});

afterEach(() => {
  if (sqlite.open) sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(id: string, overrides: Partial<ScheduledRun> = {}): ScheduledRun {
  return {
    id,
    scheduleId: "schedule-1",
    projectId: "project-1",
    origin: { trigger: "run-now", dueAt: null, occurrenceKey: null, coalesced: null },
    createdAt: T0,
    terminalId: null,
    terminalSpawnedAt: null,
    settlement: {
      state: "settled",
      settledAt: T0,
      outcome: "done",
      evidence: { kind: "exit", process: "pty", exitCode: 0, signal: null },
    },
    process: { agent: { state: "not-started" }, pty: { state: "not-started" } },
    pane: { state: "none" },
    resume: null,
    ...overrides,
  };
}

function scheduled(id: string, dueAt: number): ScheduledRun {
  return run(id, {
    origin: { trigger: "scheduled", dueAt, occurrenceKey: occurrenceKeyFor(dueAt), coalesced: null },
  });
}

describe("ScheduledRunStore", () => {
  it("keeps a run across a restart", () => {
    new ScheduledRunStore(sqlite).insert(run("run-1", { settlement: { state: "open" } }));
    sqlite.close();

    sqlite = openDb(dbPath, migrationsFolder).sqlite;
    const reopened = new ScheduledRunStore(sqlite);
    expect(reopened.get("run-1")?.settlement).toEqual({ state: "open" });
    expect(reopened.listLive().map((r) => r.id)).toEqual(["run-1"]);
  });

  it("refuses a second run for an occurrence, but not for another schedule's", () => {
    const store = new ScheduledRunStore(sqlite);
    store.insert(scheduled("run-1", T0));

    expect(() => store.insert(scheduled("run-2", T0))).toThrow(ScheduledRunConflictError);
    store.insert({ ...scheduled("run-3", T0), scheduleId: "schedule-2" });
    // Run-now runs carry no occurrence, so any number of them can be registered.
    store.insert(run("run-4"));
    store.insert(run("run-5"));
    expect(store.listByProject("project-1")).toHaveLength(4);
  });

  it("lists newest first, keeping registration order within a millisecond", () => {
    const store = new ScheduledRunStore(sqlite);
    store.insert(run("older", { createdAt: T0 - 1 }));
    store.insert(run("first", { createdAt: T0 }));
    store.insert(run("second", { createdAt: T0 }));
    store.insert(run("elsewhere", { createdAt: T0 + 1, projectId: "project-2", scheduleId: "s2" }));

    expect(store.listBySchedule("schedule-1").map((r) => r.id)).toEqual([
      "second",
      "first",
      "older",
    ]);
    expect(store.listByProject("project-2").map((r) => r.id)).toEqual(["elsewhere"]);
  });

  it("prunes a schedule past its newest runs, but never one still live", () => {
    const store = new ScheduledRunStore(sqlite);
    store.insert(run("open-oldest", { createdAt: T0 - 10, settlement: { state: "open" } }));
    for (let i = 0; i < 5; i++) store.insert(run(`run-${i}`, { createdAt: T0 + i }));
    store.insert(run("other-schedule", { createdAt: T0 - 20, scheduleId: "schedule-2" }));

    expect(store.prune("schedule-1", 3)).toBe(2);
    expect(store.listBySchedule("schedule-1").map((r) => r.id)).toEqual([
      "run-4",
      "run-3",
      "run-2",
      "open-oldest",
    ]);
    expect(store.listBySchedule("schedule-2")).toHaveLength(1);
  });

  it("deletes a schedule's runs and names the projects they were in", () => {
    const store = new ScheduledRunStore(sqlite);
    store.insert(run("run-1"));
    store.insert(run("run-2", { scheduleId: "schedule-2" }));

    expect(store.deleteForSchedule("schedule-1")).toEqual(["project-1"]);
    expect(store.get("run-1")).toBeNull();
    expect(store.get("run-2")).not.toBeNull();
    expect(store.deleteForSchedule("schedule-1")).toEqual([]);
  });

  it("writes nothing over a run whose row is gone", () => {
    const store = new ScheduledRunStore(sqlite);
    store.insert(run("run-1", { settlement: { state: "open" } }));
    store.deleteForSchedule("schedule-1");

    expect(store.update(run("run-1"))).toBe(false);
    expect(store.get("run-1")).toBeNull();
  });

  it("refuses to write a record the contract rejects", () => {
    const store = new ScheduledRunStore(sqlite);
    expect(() => store.insert(run("run-1", { terminalSpawnedAt: T0 }))).toThrow();
    expect(store.get("run-1")).toBeNull();
  });

  it("skips a row that no longer parses instead of failing the whole list", () => {
    const warn = vi.fn();
    const store = new ScheduledRunStore(sqlite, warn);
    store.insert(run("good"));
    sqlite
      .prepare(
        "INSERT INTO scheduled_runs (id, project_id, schedule_id, live, created_at, record) VALUES ('bad', 'project-1', 'schedule-1', 0, 0, '{\"id\":\"bad\"}')"
      )
      .run();

    expect(store.listByProject("project-1").map((r) => r.id)).toEqual(["good"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
