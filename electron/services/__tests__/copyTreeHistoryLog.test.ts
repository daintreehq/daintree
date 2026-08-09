import { describe, expect, it } from "vitest";
import { applyCopyTreeRun, copyTreeOptionsDedupeKey } from "../copyTreeHistoryLog.js";
import { COPY_TREE_HISTORY_MAX_RECORDS } from "../../../shared/types/ipc/copyTreeHistory.js";
import type {
  CopyTreeHistoryAppendInput,
  CopyTreeHistoryRecord,
} from "../../../shared/types/ipc/copyTreeHistory.js";
import type { CopyTreeOptions } from "../../../shared/types/ipc/copyTree.js";

function input(overrides: Partial<CopyTreeHistoryAppendInput> = {}): CopyTreeHistoryAppendInput {
  return {
    options: {},
    source: "toolbar",
    worktreeId: "wt-1",
    stats: { fileCount: 3, totalSize: 100, duration: 5 },
    ...overrides,
  };
}

describe("copyTreeOptionsDedupeKey", () => {
  it("agrees across the spellings of one option set", () => {
    expect(copyTreeOptionsDedupeKey({ filter: "src/**", exclude: ["b", "a"] })).toBe(
      copyTreeOptionsDedupeKey({ exclude: ["a", "b"], filter: ["src/**"] })
    );
  });

  it("treats absent and empty options as the same run", () => {
    expect(copyTreeOptionsDedupeKey(undefined)).toBe(copyTreeOptionsDedupeKey({}));
  });

  it("separates option sets that select different files", () => {
    expect(copyTreeOptionsDedupeKey({ modified: true })).not.toBe(copyTreeOptionsDedupeKey({}));
    expect(copyTreeOptionsDedupeKey({ scopePaths: ["src"] })).not.toBe(
      copyTreeOptionsDedupeKey({ scopePaths: ["lib"] })
    );
  });
});

describe("applyCopyTreeRun", () => {
  it("records a first run with a run count of one and matching timestamps", () => {
    const [record] = applyCopyTreeRun([], input(), { id: "id-1", now: 1_000 });
    expect(record.runCount).toBe(1);
    expect(record.createdAt).toBe(1_000);
    expect(record.lastUsedAt).toBe(1_000);
    expect(record.dedupeKey).toBe(copyTreeOptionsDedupeKey({}));
  });

  it("collapses repeat runs of the same option set into one bumped entry", () => {
    let records = applyCopyTreeRun([], input(), { id: "id-1", now: 1_000 });
    records = applyCopyTreeRun(records, input(), { id: "id-2", now: 2_000 });
    records = applyCopyTreeRun(records, input(), { id: "id-3", now: 3_000 });

    expect(records).toHaveLength(1);
    expect(records[0].runCount).toBe(3);
    expect(records[0].id).toBe("id-1");
    expect(records[0].createdAt).toBe(1_000);
    expect(records[0].lastUsedAt).toBe(3_000);
  });

  it("dedupes runs whose options differ only in array order or string-vs-array form", () => {
    let records = applyCopyTreeRun([], input({ options: { filter: "a" } }), {
      id: "id-1",
      now: 1_000,
    });
    records = applyCopyTreeRun(records, input({ options: { filter: ["a"] } }), {
      id: "id-2",
      now: 2_000,
    });
    expect(records).toHaveLength(1);
    expect(records[0].runCount).toBe(2);
  });

  it("keeps runs with genuinely different options apart", () => {
    let records = applyCopyTreeRun([], input({ options: { modified: true } }), {
      id: "id-1",
      now: 1_000,
    });
    records = applyCopyTreeRun(records, input({ options: {} }), { id: "id-2", now: 2_000 });
    expect(records).toHaveLength(2);
  });

  it("dedupes across delivery surfaces and worktrees, adopting the newest", () => {
    let records = applyCopyTreeRun([], input({ source: "toolbar", worktreeId: "wt-1" }), {
      id: "id-1",
      now: 1_000,
    });
    records = applyCopyTreeRun(records, input({ source: "mcp", worktreeId: "wt-2" }), {
      id: "id-2",
      now: 2_000,
    });

    expect(records).toHaveLength(1);
    expect(records[0].source).toBe("mcp");
    expect(records[0].worktreeId).toBe("wt-2");
  });

  it("replaces stats with the newest run's rather than keeping the first", () => {
    let records = applyCopyTreeRun(
      [],
      input({ stats: { fileCount: 1, totalSize: 10, duration: 2 } }),
      {
        id: "id-1",
        now: 1_000,
      }
    );
    records = applyCopyTreeRun(
      records,
      input({ stats: { fileCount: 9, totalSize: 90, duration: 20 } }),
      { id: "id-2", now: 2_000 }
    );
    expect(records[0].stats).toEqual({ fileCount: 9, totalSize: 90, duration: 20 });
  });

  it("derives a name when none is supplied", () => {
    const [record] = applyCopyTreeRun([], input({ options: { modified: true } }), {
      id: "id-1",
      now: 1,
    });
    expect(record.name).toBe("Modified files");
  });

  it("lets a supplied name replace the stored one without forking the entry", () => {
    let records = applyCopyTreeRun([], input(), { id: "id-1", now: 1_000 });
    const derivedName = records[0].name;
    records = applyCopyTreeRun(records, input({ name: "Release context" }), {
      id: "id-2",
      now: 2_000,
    });

    expect(records).toHaveLength(1);
    expect(records[0].name).toBe("Release context");
    expect(records[0].name).not.toBe(derivedName);
    expect(records[0].id).toBe("id-1");
  });

  it("does not let a later unnamed run reset a supplied name", () => {
    let records = applyCopyTreeRun([], input({ name: "Release context" }), { id: "id-1", now: 1 });
    records = applyCopyTreeRun(records, input(), { id: "id-2", now: 2 });
    records = applyCopyTreeRun(records, input({ name: "   " }), { id: "id-3", now: 3 });
    expect(records[0].name).toBe("Release context");
  });

  it("orders the most recently used run first", () => {
    let records = applyCopyTreeRun([], input({ options: { modified: true } }), {
      id: "id-1",
      now: 1_000,
    });
    records = applyCopyTreeRun(records, input({ options: {} }), { id: "id-2", now: 2_000 });
    expect(records[0].id).toBe("id-2");

    records = applyCopyTreeRun(records, input({ options: { modified: true } }), {
      id: "id-3",
      now: 3_000,
    });
    expect(records[0].id).toBe("id-1");
  });

  it("keeps a re-run entry ahead of the one it overtook when both land in the same tick", () => {
    let records = applyCopyTreeRun([], input({ options: { modified: true } }), {
      id: "id-1",
      now: 7,
    });
    records = applyCopyTreeRun(records, input({ options: {} }), { id: "id-2", now: 7 });
    records = applyCopyTreeRun(records, input({ options: { modified: true } }), {
      id: "id-3",
      now: 7,
    });
    expect(records[0].id).toBe("id-1");
  });

  it("evicts the least recently used entry once the cap is reached", () => {
    let records: CopyTreeHistoryRecord[] = [];
    for (let i = 0; i < COPY_TREE_HISTORY_MAX_RECORDS; i++) {
      records = applyCopyTreeRun(records, input({ options: { changed: `ref-${i}` } }), {
        id: `id-${i}`,
        now: 1_000 + i,
      });
    }
    expect(records).toHaveLength(COPY_TREE_HISTORY_MAX_RECORDS);

    // Re-run the oldest-by-insertion entry so it is no longer the least recent.
    records = applyCopyTreeRun(records, input({ options: { changed: "ref-0" } }), {
      id: "ignored",
      now: 9_000,
    });
    records = applyCopyTreeRun(records, input({ options: { changed: "brand-new" } }), {
      id: "id-new",
      now: 9_001,
    });

    expect(records).toHaveLength(COPY_TREE_HISTORY_MAX_RECORDS);
    const keptRefs = records.map((r) => (r.options as CopyTreeOptions).changed);
    expect(keptRefs).toContain("brand-new");
    // Survives on recency, despite being the first ever inserted.
    expect(keptRefs).toContain("ref-0");
    // The genuinely least-recently-used entry is the one that went.
    expect(keptRefs).not.toContain("ref-1");
  });

  it("lets one explicit name replace another", () => {
    let records = applyCopyTreeRun([], input({ name: "First name" }), { id: "id-1", now: 1 });
    records = applyCopyTreeRun(records, input({ name: "Second name" }), { id: "id-2", now: 2 });
    expect(records).toHaveLength(1);
    expect(records[0].name).toBe("Second name");
    expect(records[0].id).toBe("id-1");
  });

  it("does not evict the run that just happened when the clock has moved backwards", () => {
    let records: CopyTreeHistoryRecord[] = [];
    for (let i = 0; i < COPY_TREE_HISTORY_MAX_RECORDS; i++) {
      records = applyCopyTreeRun(records, input({ options: { changed: `ref-${i}` } }), {
        id: `id-${i}`,
        now: 1_000_000 + i,
      });
    }

    // A clock correction lands this run before everything already stored.
    records = applyCopyTreeRun(records, input({ options: { changed: "after-rollback" } }), {
      id: "id-rollback",
      now: 1,
    });

    expect(records.map((r) => (r.options as CopyTreeOptions).changed)).toContain("after-rollback");
    expect(records[0].id).toBe("id-rollback");
    expect(records).toHaveLength(COPY_TREE_HISTORY_MAX_RECORDS);
  });

  it("stores the caller's options verbatim", () => {
    const options = { scopePaths: ["src/z", "src/a"], format: "markdown" as const };
    const [record] = applyCopyTreeRun([], input({ options }), { id: "id-1", now: 1 });
    expect(record.options).toEqual(options);
  });

  it("does not mutate the records it was given", () => {
    const first = applyCopyTreeRun([], input(), { id: "id-1", now: 1_000 });
    const snapshot = structuredClone(first);
    applyCopyTreeRun(first, input(), { id: "id-2", now: 2_000 });
    expect(first).toEqual(snapshot);
  });

  it("reorders a history that arrived out of order on disk", () => {
    // A hand-edited file can be out of order; the fold must re-establish
    // newest-first so the tail really is the eviction candidate.
    const stale: CopyTreeHistoryRecord[] = [
      {
        id: "old",
        dedupeKey: copyTreeOptionsDedupeKey({ changed: "old" }),
        name: "old",
        options: { changed: "old" },
        source: "toolbar",
        worktreeId: "wt",
        stats: { fileCount: 1 },
        createdAt: 1,
        lastUsedAt: 1,
        runCount: 1,
      },
      {
        id: "recent",
        dedupeKey: copyTreeOptionsDedupeKey({ changed: "recent" }),
        name: "recent",
        options: { changed: "recent" },
        source: "toolbar",
        worktreeId: "wt",
        stats: { fileCount: 1 },
        createdAt: 1,
        lastUsedAt: 9_999,
        runCount: 1,
      },
    ];
    const records = applyCopyTreeRun(stale, input({ options: { changed: "newest" } }), {
      id: "newest",
      now: 10_000,
    });
    expect(records.map((r) => r.id)).toEqual(["newest", "recent", "old"]);
  });
});
