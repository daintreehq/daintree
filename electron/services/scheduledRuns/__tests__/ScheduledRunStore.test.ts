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

/** The ids of the rows whose `record` reached JS, however the statement was stepped. */
function watchRecordReads(): string[] {
  const ids: string[] = [];
  const seen = (row: unknown) => {
    if (typeof row === "object" && row !== null && "id" in row) ids.push(String(row.id));
  };
  const prepare = sqlite.prepare.bind(sqlite);
  vi.spyOn(sqlite, "prepare").mockImplementation((source: string) => {
    const statement = prepare(source);
    if (!/\brecord\b/.test(source)) return statement;
    const all = statement.all.bind(statement);
    const get = statement.get.bind(statement);
    const iterate = statement.iterate.bind(statement);
    statement.all = (...params) => {
      const rows = all(...params);
      rows.forEach(seen);
      return rows;
    };
    statement.get = (...params) => {
      const row = get(...params);
      seen(row);
      return row;
    };
    statement.iterate = function* (...params) {
      for (const row of iterate(...params)) {
        seen(row);
        yield row;
      }
    };
    return statement;
  });
  return ids;
}

function scheduled(id: string, dueAt: number): ScheduledRun {
  return run(id, {
    origin: {
      trigger: "scheduled",
      dueAt,
      occurrenceKey: occurrenceKeyFor(dueAt),
      coalesced: null,
    },
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
    store.insert(scheduled("next-occurrence", T0 + 60_000));
    store.insert({ ...scheduled("run-3", T0), scheduleId: "schedule-2" });
    // Run-now runs carry no occurrence, so any number of them can be registered.
    store.insert(run("run-4"));
    store.insert(run("run-5"));
    expect(store.listBySchedule("schedule-1")).toHaveLength(4);
    expect(store.listBySchedule("schedule-2")).toHaveLength(1);
  });

  it("moves a schedule's evaluation point with each occurrence's run, never back", () => {
    const store = new ScheduledRunStore(sqlite);
    store.insert(run("run-now"));
    expect(store.evaluationPoint("schedule-1")).toBeNull();

    store.insert(scheduled("on-time", T0));
    expect(store.evaluationPoint("schedule-1")).toBe(T0);

    const caughtUp = T0 + 3 * 3_600_000;
    store.insert(
      run("caught-up", {
        origin: {
          trigger: "catch-up",
          dueAt: caughtUp - 60_000,
          occurrenceKey: occurrenceKeyFor(caughtUp - 60_000),
          coalesced: { after: T0, through: caughtUp },
        },
      })
    );
    expect(store.evaluationPoint("schedule-1")).toBe(caughtUp);

    // An older occurrence registered late (a slow launch) doesn't move it back.
    store.insert(scheduled("late-registration", T0 + 60_000));
    expect(store.evaluationPoint("schedule-1")).toBe(caughtUp);
    expect(store.evaluationPoint("schedule-2")).toBeNull();
  });

  it("keeps the evaluation point when retention prunes the run behind it", () => {
    const store = new ScheduledRunStore(sqlite);
    store.insert(scheduled("on-time", T0));
    for (let i = 0; i < 3; i++) store.insert(run(`run-now-${i}`, { createdAt: T0 + i + 1 }));

    expect(store.prune("schedule-1", 3)).toBe(1);
    expect(store.get("on-time")).toBeNull();
    expect(store.evaluationPoint("schedule-1")).toBe(T0);
  });

  it("writes neither the run nor the evaluation point when the point's write fails", () => {
    const store = new ScheduledRunStore(sqlite);
    store.insert(scheduled("first", T0));
    sqlite.exec(`CREATE TRIGGER refuse_point BEFORE INSERT ON schedule_evaluation_points
      BEGIN SELECT RAISE(ABORT, 'point write failed'); END`);

    expect(() => store.insert(scheduled("second", T0 + 60_000))).toThrow(/point write failed/);
    expect(store.get("second")).toBeNull();
    expect(store.evaluationPoint("schedule-1")).toBe(T0);
  });

  it("leaves the evaluation point where it was when the run's insert fails", () => {
    const store = new ScheduledRunStore(sqlite);
    store.insert(scheduled("first", T0));

    expect(() => store.insert(scheduled("again", T0))).toThrow(ScheduledRunConflictError);
    // A run id already taken, carrying a later occurrence.
    expect(() => store.insert(scheduled("first", T0 + 120_000))).toThrow();
    expect(() =>
      store.insert({ ...scheduled("invalid", T0 + 60_000), terminalSpawnedAt: T0 })
    ).toThrow();
    expect(store.evaluationPoint("schedule-1")).toBe(T0);
  });

  it("deletes the evaluation point with its schedule's or project's runs", () => {
    const store = new ScheduledRunStore(sqlite);
    store.insert(scheduled("run-1", T0));
    store.insert({ ...scheduled("run-2", T0), scheduleId: "schedule-2" });
    store.insert({ ...scheduled("run-3", T0), scheduleId: "schedule-3", projectId: "project-2" });

    store.deleteForSchedule("schedule-1");
    expect(store.evaluationPoint("schedule-1")).toBeNull();
    expect(store.evaluationPoint("schedule-2")).toBe(T0);

    expect(store.deleteForProject("project-1")).toBe(1);
    expect(store.evaluationPoint("schedule-2")).toBeNull();
    expect(store.evaluationPoint("schedule-3")).toBe(T0);
  });

  it("lists a schedule's history newest first, keeping registration order within a millisecond", () => {
    const store = new ScheduledRunStore(sqlite);
    store.insert(run("older", { createdAt: T0 - 1 }));
    store.insert(run("first", { createdAt: T0 }));
    store.insert(run("second", { createdAt: T0 }));
    store.insert(run("registered-late", { createdAt: T0 - 2 }));
    store.insert(run("other-schedule", { createdAt: T0, scheduleId: "schedule-2" }));

    expect(store.listBySchedule("schedule-1").map((r) => r.id)).toEqual([
      "second",
      "first",
      "older",
      "registered-late",
    ]);
  });

  it("reads each schedule's newest run once, newest first, keeping registration order within a millisecond", () => {
    const store = new ScheduledRunStore(sqlite);
    store.insert(run("older", { createdAt: T0 - 1 }));
    store.insert(run("first", { createdAt: T0 }));
    store.insert(run("second", { createdAt: T0 }));
    store.insert(run("registered-late", { createdAt: T0 - 2 }));
    store.insert(run("tied-schedule", { createdAt: T0, scheduleId: "schedule-2" }));
    store.insert(run("stale-schedule", { createdAt: T0 - 5, scheduleId: "schedule-3" }));
    store.insert(run("elsewhere", { createdAt: T0 + 1, projectId: "project-2" }));

    expect(store.latestByProject("project-1").map((r) => r.id)).toEqual([
      "tied-schedule",
      "second",
      "stale-schedule",
    ]);
    expect(store.latestByProject("project-2").map((r) => r.id)).toEqual(["elsewhere"]);
    expect(store.latestByProject("project-3")).toEqual([]);
  });

  it("falls back past a newest row that no longer parses, and never reads older history", () => {
    const warn = vi.fn();
    const store = new ScheduledRunStore(sqlite, warn);
    const insertRaw = sqlite.prepare(
      "INSERT INTO scheduled_runs (id, project_id, schedule_id, live, created_at, record) VALUES (?, 'project-1', ?, 0, ?, ?)"
    );
    store.insert(run("fallback", { createdAt: T0 - 2 }));
    insertRaw.run("broken-head", "schedule-1", T0, "{not json");
    insertRaw.run("buried", "schedule-2", T0 - 10, '{"id":"buried"}');
    store.insert(run("head", { createdAt: T0, scheduleId: "schedule-2" }));
    insertRaw.run("only-invalid", "schedule-3", T0, '{"id":"only-invalid"}');
    store.insert(run("older-valid", { createdAt: T0 - 3 }));

    const reads = watchRecordReads();
    expect(store.latestByProject("project-1").map((r) => r.id)).toEqual(["head", "fallback"]);
    expect(reads.sort()).toEqual(["broken-head", "fallback", "head", "only-invalid"]);
    const skipped = warn.mock.calls.map(([message]) => String(message).split(" ").at(-1)).sort();
    expect(skipped).toEqual(["broken-head", "only-invalid"]);
  });

  it("finds a schedule's run for an occurrence by its key alone", () => {
    const logWarn = vi.fn();
    const store = new ScheduledRunStore(sqlite, logWarn);
    const key = occurrenceKeyFor(T0);
    const origin = {
      trigger: "scheduled" as const,
      dueAt: T0,
      occurrenceKey: key,
      coalesced: null,
    };
    store.insert(run("keyed", { origin }));
    store.insert(run("other-schedule", { scheduleId: "schedule-2", origin }));
    store.insert(run("unkeyed"));
    // Its record no longer reads, but the occurrence is still taken: a second
    // run for it would only fail on the unique index.
    sqlite.prepare("UPDATE scheduled_runs SET record = 'not json' WHERE id = ?").run("keyed");

    expect(store.findIdByOccurrence("schedule-1", key)).toBe("keyed");
    expect(logWarn).not.toHaveBeenCalled();
    expect(store.findIdByOccurrence("schedule-2", key)).toBe("other-schedule");
    expect(store.findIdByOccurrence("schedule-1", occurrenceKeyFor(T0 + 1))).toBeNull();
  });

  it("lists a schedule's open runs newest first, leaving settled and still-running ones out", () => {
    const logWarn = vi.fn();
    const store = new ScheduledRunStore(sqlite, logWarn);
    store.insert(run("open-older", { createdAt: T0 - 1, settlement: { state: "open" } }));
    store.insert(run("open-first", { createdAt: T0, settlement: { state: "open" } }));
    store.insert(run("open-second", { createdAt: T0, settlement: { state: "open" } }));
    store.insert(run("settled", { createdAt: T0 + 1 }));
    // Live, since its agent was last seen running, but settled: not open.
    store.insert(
      run("settled-running", {
        createdAt: T0 + 2,
        process: { agent: { state: "running", startedAt: T0 }, pty: { state: "not-started" } },
      })
    );
    store.insert(run("elsewhere", { scheduleId: "schedule-2", settlement: { state: "open" } }));
    // Settled history isn't read at all: a record of it that no longer parses
    // goes unnoticed.
    sqlite.prepare("UPDATE scheduled_runs SET record = 'not json' WHERE id = ?").run("settled");

    expect(store.listOpenBySchedule("schedule-1").map((r) => r.id)).toEqual([
      "open-second",
      "open-first",
      "open-older",
    ]);
    expect(logWarn).not.toHaveBeenCalled();

    const [newest] = store.listOpenBySchedule("schedule-1");
    store.update({
      ...newest!,
      settlement: {
        state: "settled",
        settledAt: T0 + 3,
        outcome: "done",
        evidence: { kind: "exit", process: "pty", exitCode: 0, signal: null },
      },
    });
    expect(store.listOpenBySchedule("schedule-1").map((r) => r.id)).toEqual([
      "open-first",
      "open-older",
    ]);
    const plan = sqlite
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id, record FROM scheduled_runs WHERE schedule_id = ? AND live = 1 ORDER BY created_at DESC, rowid DESC"
      )
      .all("schedule-1") as { detail: string }[];
    expect(plan.map((step) => step.detail).join("\n")).toContain(
      "scheduled_runs_schedule_live_idx"
    );
  });

  it("prunes a schedule past its newest runs, but never one still live", () => {
    const store = new ScheduledRunStore(sqlite);
    store.insert(run("open-oldest", { createdAt: T0 - 10, settlement: { state: "open" } }));
    // Settled, but its terminal was last seen running: still live.
    store.insert(
      run("pty-running", {
        createdAt: T0 - 9,
        terminalId: "terminal-1",
        terminalSpawnedAt: T0 - 9,
        process: {
          agent: { state: "not-started" },
          pty: { state: "running", startedAt: T0 - 9 },
        },
      })
    );
    store.insert(
      run("agent-running", {
        createdAt: T0 - 8,
        process: {
          agent: { state: "running", startedAt: T0 - 8 },
          pty: { state: "not-started" },
        },
      })
    );
    for (let i = 0; i < 5; i++)
      store.insert(run(`run-${i}`, { createdAt: T0 + Math.floor((i + 1) / 2) }));
    store.insert(run("other-schedule", { createdAt: T0 - 20, scheduleId: "schedule-2" }));

    expect(store.prune("schedule-1", 3)).toBe(2);
    // Ties go by registration order, so run-2 outranks run-1 in the same millisecond.
    expect(store.listBySchedule("schedule-1").map((r) => r.id)).toEqual([
      "run-4",
      "run-3",
      "run-2",
      "agent-running",
      "pty-running",
      "open-oldest",
    ]);
    expect(store.listBySchedule("schedule-2")).toHaveLength(1);
  });

  it("deletes a schedule's runs and names the projects they were in", () => {
    const store = new ScheduledRunStore(sqlite);
    store.insert(run("run-1"));
    store.insert(run("run-1b"));
    store.insert(run("run-2", { scheduleId: "schedule-2" }));

    expect(store.deleteForSchedule("schedule-1")).toEqual(["project-1"]);
    expect(store.get("run-1b")).toBeNull();
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
    const insertRaw = sqlite.prepare(
      "INSERT INTO scheduled_runs (id, project_id, schedule_id, live, created_at, record) VALUES (?, 'project-1', 'schedule-1', 0, 0, ?)"
    );
    insertRaw.run("invalid", '{"id":"invalid"}');
    insertRaw.run("unreadable", "{not json");

    expect(store.listBySchedule("schedule-1").map((r) => r.id)).toEqual(["good"]);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("worktree claims (#16369)", () => {
  const claim = {
    scheduleId: "schedule-1",
    projectId: "project-1",
    branch: "schedule-nightly-a",
    baseBranch: "origin/develop",
    fromRemote: true,
  };
  const madeRun = (id: string, branch = claim.branch) =>
    run(id, { newWorktree: { branch, baseBranch: claim.baseBranch, worktreeId: "/wt" } });

  it("survives a restart, boolean and all", () => {
    new ScheduledRunStore(sqlite).saveWorktreeClaim(claim);
    sqlite.close();

    const reopened = openDb(dbPath, migrationsFolder).sqlite;
    sqlite = reopened;

    expect(new ScheduledRunStore(reopened).worktreeClaim("schedule-1")).toEqual(claim);
  });

  it("holds one per schedule, a new one replacing the old", () => {
    const store = new ScheduledRunStore(sqlite);
    store.saveWorktreeClaim(claim);
    store.saveWorktreeClaim({ ...claim, branch: "schedule-nightly-b", fromRemote: false });

    expect(store.worktreeClaim("schedule-1")).toMatchObject({
      branch: "schedule-nightly-b",
      fromRemote: false,
    });
    expect(store.worktreeClaim("schedule-2")).toBeNull();
  });

  it("goes in the insert that records the run", () => {
    const store = new ScheduledRunStore(sqlite);
    store.saveWorktreeClaim(claim);

    store.insert(madeRun("run-1"));

    expect(store.worktreeClaim("schedule-1")).toBeNull();
    expect(store.get("run-1")?.newWorktree?.branch).toBe(claim.branch);
  });

  it("stays when the insert fails, so a retry still finds it", () => {
    const store = new ScheduledRunStore(sqlite);
    store.saveWorktreeClaim(claim);
    const dueAt = T0;
    const origin = {
      trigger: "scheduled" as const,
      dueAt,
      occurrenceKey: occurrenceKeyFor(dueAt),
      coalesced: null,
    };
    store.insert(run("run-0", { origin }));

    expect(() => store.insert({ ...madeRun("run-1"), origin })).toThrow(ScheduledRunConflictError);

    expect(store.worktreeClaim("schedule-1")).toEqual(claim);
    expect(store.get("run-1")).toBeNull();
  });

  it("commits with the run or not at all, the evaluation point included", () => {
    const store = new ScheduledRunStore(sqlite);
    store.saveWorktreeClaim(claim);
    sqlite.exec(`
      CREATE TRIGGER refuse_claim_delete BEFORE DELETE ON scheduled_run_worktree_claims
      BEGIN SELECT RAISE(ABORT, 'disk full'); END;
    `);
    const origin = {
      trigger: "scheduled" as const,
      dueAt: T0,
      occurrenceKey: occurrenceKeyFor(T0),
      coalesced: null,
    };

    expect(() => store.insert({ ...madeRun("run-1"), origin })).toThrow("disk full");

    expect(store.get("run-1")).toBeNull();
    expect(store.evaluationPoint("schedule-1")).toBeNull();
    expect(store.worktreeClaim("schedule-1")).toEqual(claim);
  });

  it("leaves a claim for another branch alone", () => {
    const store = new ScheduledRunStore(sqlite);
    store.saveWorktreeClaim(claim);

    store.insert(madeRun("run-1", "schedule-nightly-other"));
    store.dropWorktreeClaim("schedule-1", "schedule-nightly-other");

    expect(store.worktreeClaim("schedule-1")).toEqual(claim);
  });

  it("is deleted with its schedule or project", () => {
    const store = new ScheduledRunStore(sqlite);
    store.saveWorktreeClaim(claim);
    store.saveWorktreeClaim({ ...claim, scheduleId: "schedule-2" });
    store.saveWorktreeClaim({ ...claim, scheduleId: "schedule-3", projectId: "project-2" });

    store.deleteForSchedule("schedule-2");
    expect(store.worktreeClaim("schedule-2")).toBeNull();
    expect(store.worktreeClaim("schedule-1")).toEqual(claim);

    store.deleteForProject("project-1");
    expect(store.worktreeClaim("schedule-1")).toBeNull();
    expect(store.worktreeClaim("schedule-3")).not.toBeNull();
  });
});
