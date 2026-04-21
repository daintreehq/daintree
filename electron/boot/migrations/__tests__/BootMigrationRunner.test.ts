import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BootMigrationRunner } from "../BootMigrationRunner.js";
import type { BootMigrationState } from "../BootMigrationState.js";
import type { BootMigration, BootMigrationsMarker } from "../types.js";

type FakeState = BootMigrationState & {
  current: BootMigrationsMarker;
  saved: string[][];
};

function createFakeState(initial: BootMigrationsMarker = { completed: [] }): FakeState {
  const current: BootMigrationsMarker = {
    completed: [...initial.completed],
  };
  const saved: string[][] = [];
  return {
    getMarkerPath: () => "/fake/migrations.json",
    load: () => ({ completed: [...current.completed] }),
    save: (ids: readonly string[]) => {
      current.completed = [...ids];
      saved.push([...ids]);
    },
    current,
    saved,
  } as unknown as FakeState;
}

describe("BootMigrationRunner", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs migrations in registration order and records each to the marker", async () => {
    const applied: string[] = [];
    const migrations: BootMigration[] = [
      { id: "one", description: "first", up: () => void applied.push("one") },
      { id: "two", description: "second", up: async () => void applied.push("two") },
      { id: "three", description: "third", up: () => void applied.push("three") },
    ];
    const state = createFakeState();

    const result = await new BootMigrationRunner({ migrations, state }).run();

    expect(applied).toEqual(["one", "two", "three"]);
    expect(result.applied).toEqual(["one", "two", "three"]);
    expect(result.skippedForSafeMode).toBe(false);
    expect(state.current.completed).toEqual(["one", "two", "three"]);
    expect(state.saved).toEqual([["one"], ["one", "two"], ["one", "two", "three"]]);
  });

  it("skips migrations already recorded in the marker", async () => {
    const applied: string[] = [];
    const migrations: BootMigration[] = [
      {
        id: "one",
        description: "first",
        up: () => {
          applied.push("one");
        },
      },
      {
        id: "two",
        description: "second",
        up: () => {
          applied.push("two");
        },
      },
    ];
    const state = createFakeState({ completed: ["one"] });

    const result = await new BootMigrationRunner({ migrations, state }).run();

    expect(applied).toEqual(["two"]);
    expect(result.applied).toEqual(["two"]);
    expect(state.current.completed).toEqual(["one", "two"]);
  });

  it("leaves the marker untouched when nothing is pending", async () => {
    const migrations: BootMigration[] = [
      {
        id: "one",
        description: "first",
        up: () => {
          throw new Error("should not run");
        },
      },
    ];
    const state = createFakeState({ completed: ["one"] });

    const result = await new BootMigrationRunner({ migrations, state }).run();

    expect(result.applied).toEqual([]);
    expect(state.saved).toEqual([]);
  });

  it("stops at the first failure and only records prior successes", async () => {
    const applied: string[] = [];
    const migrations: BootMigration[] = [
      {
        id: "one",
        description: "first",
        up: () => {
          applied.push("one");
        },
      },
      {
        id: "two",
        description: "second",
        up: () => {
          applied.push("two");
          throw new Error("boom");
        },
      },
      {
        id: "three",
        description: "third",
        up: () => {
          applied.push("three");
        },
      },
    ];
    const state = createFakeState();
    const runner = new BootMigrationRunner({ migrations, state });

    await expect(runner.run()).rejects.toThrow(/Boot migration two failed: boom/);
    expect(applied).toEqual(["one", "two"]);
    expect(state.current.completed).toEqual(["one"]);
  });

  it("resumes at the failing migration on the next boot", async () => {
    let shouldThrow = true;
    const applied: string[] = [];
    const migrations: BootMigration[] = [
      {
        id: "one",
        description: "first",
        up: () => {
          applied.push("one");
        },
      },
      {
        id: "two",
        description: "second",
        up: () => {
          applied.push("two");
          if (shouldThrow) throw new Error("boom");
        },
      },
      {
        id: "three",
        description: "third",
        up: () => {
          applied.push("three");
        },
      },
    ];
    const state = createFakeState();

    await expect(new BootMigrationRunner({ migrations, state }).run()).rejects.toThrow();
    expect(state.current.completed).toEqual(["one"]);

    shouldThrow = false;
    applied.length = 0;

    const result = await new BootMigrationRunner({ migrations, state }).run();

    expect(applied).toEqual(["two", "three"]);
    expect(result.applied).toEqual(["two", "three"]);
    expect(state.current.completed).toEqual(["one", "two", "three"]);
  });

  it("skips every migration when safe mode is active", async () => {
    const applied: string[] = [];
    const migrations: BootMigration[] = [
      {
        id: "one",
        description: "first",
        up: () => {
          applied.push("one");
        },
      },
    ];
    const state = createFakeState();
    const loadSpy = vi.spyOn(state, "load");
    const saveSpy = vi.spyOn(state, "save");

    const result = await new BootMigrationRunner({
      migrations,
      state,
      isSafeMode: true,
    }).run();

    expect(applied).toEqual([]);
    expect(result.skippedForSafeMode).toBe(true);
    expect(result.applied).toEqual([]);
    expect(state.saved).toEqual([]);
    expect(loadSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("re-runs a migration on the next boot when save fails after up succeeded", async () => {
    let saveShouldThrow = true;
    const runCount: string[] = [];
    const migrations: BootMigration[] = [
      {
        id: "one",
        description: "first",
        up: () => {
          runCount.push("one");
        },
      },
    ];
    const state = createFakeState();
    const originalSave = state.save.bind(state);
    state.save = ((ids: readonly string[]) => {
      if (saveShouldThrow) {
        throw new Error("disk full");
      }
      originalSave(ids);
    }) as typeof state.save;

    await expect(new BootMigrationRunner({ migrations, state }).run()).rejects.toThrow(/disk full/);
    expect(runCount).toEqual(["one"]);
    expect(state.current.completed).toEqual([]);

    saveShouldThrow = false;

    const result = await new BootMigrationRunner({ migrations, state }).run();
    expect(runCount).toEqual(["one", "one"]);
    expect(result.applied).toEqual(["one"]);
    expect(state.current.completed).toEqual(["one"]);
  });

  it("throws at construction when two migrations share an id", () => {
    const migrations: BootMigration[] = [
      { id: "dup", description: "a", up: () => {} },
      { id: "dup", description: "b", up: () => {} },
    ];
    expect(() => new BootMigrationRunner({ migrations, state: createFakeState() })).toThrow(
      /Duplicate boot migration id: "dup"/
    );
  });

  it("reports didExceedBudget when the run takes longer than the budget", async () => {
    let t = 0;
    const now = () => t;
    const migrations: BootMigration[] = [
      {
        id: "slow",
        description: "slow",
        up: () => {
          t += 750;
        },
      },
    ];
    const state = createFakeState();

    const result = await new BootMigrationRunner({
      migrations,
      state,
      budgetMs: 500,
      now,
    }).run();

    expect(result.durationMs).toBe(750);
    expect(result.didExceedBudget).toBe(true);
  });

  it("does not flag didExceedBudget when the run stays under budget", async () => {
    let t = 0;
    const now = () => t;
    const migrations: BootMigration[] = [
      {
        id: "fast",
        description: "fast",
        up: () => {
          t += 50;
        },
      },
    ];
    const state = createFakeState();

    const result = await new BootMigrationRunner({
      migrations,
      state,
      budgetMs: 500,
      now,
    }).run();

    expect(result.didExceedBudget).toBe(false);
  });

  it("wraps non-Error throws with the migration id", async () => {
    const migrations: BootMigration[] = [
      {
        id: "bad",
        description: "throws a string",
        up: () => {
          throw "nope";
        },
      },
    ];
    const state = createFakeState();
    await expect(new BootMigrationRunner({ migrations, state }).run()).rejects.toThrow(
      /Boot migration bad failed/
    );
  });
});
