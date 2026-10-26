import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ReviewMarkStore } from "../reviewMarks.js";
import type { ReviewPoint } from "../../../shared/types/reviewPoint.js";

const PROJECT = "a".repeat(64);
const OTHER_PROJECT = "b".repeat(64);
const WT_1 = path.resolve("/repos/alpha/feature-1");
const WT_2 = path.resolve("/repos/alpha/feature-2");
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const BASE = "b".repeat(40);

function point(overrides: Partial<ReviewPoint> = {}): ReviewPoint {
  return {
    version: 1,
    capturedAt: 1_000,
    worktreePath: WT_1,
    gitDir: "/repos/alpha/.git/worktrees/feature-1",
    commonDir: "/repos/alpha/.git",
    objectFormat: "sha1",
    head: { kind: "branch", branch: "feature-1", commit: C1 },
    base: {
      requested: { kind: "branch", branch: "main" },
      ref: "refs/heads/main",
      tip: BASE,
      mergeBases: [BASE],
    },
    entries: [
      {
        path: "a.txt",
        head: { mode: "100644", oid: C1 },
        index: { kind: "entry", mode: "100644", oid: C1 },
        worktree: { kind: "file", mode: "100644", oid: C2, size: 2 },
      },
    ],
    incomplete: null,
    ...overrides,
  };
}

const allow = () => {};

let root: string;
let store: ReviewMarkStore;

function stateDir(projectId = PROJECT): string {
  return path.join(root, projectId);
}

async function readIndexFile(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(stateDir(), "review-marks.json"), "utf8"));
}

async function writeIndexFile(value: unknown): Promise<void> {
  await fs.mkdir(stateDir(), { recursive: true });
  await fs.writeFile(
    path.join(stateDir(), "review-marks.json"),
    typeof value === "string" ? value : JSON.stringify(value)
  );
}

async function pointFiles(): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(stateDir(), "review-marks"))).sort();
  } catch {
    return [];
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "review-marks-"));
  store = new ReviewMarkStore(root, { now: () => 0 });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("ReviewMarkStore", () => {
  it("starts empty and writes nothing to read", async () => {
    expect(await store.read(PROJECT)).toEqual({ projectId: PROJECT, marks: {}, revision: 0 });
    await expect(fs.stat(stateDir())).rejects.toThrow();
  });

  it("keeps the exact point it was given, one per worktree, and replaces it", async () => {
    const first = await store.save(PROJECT, WT_1, point(), 0, allow);
    expect(first).toMatchObject({ status: "saved", changed: true });
    expect(first.snapshot.revision).toBe(1);
    expect(first.snapshot.marks[WT_1]).toMatchObject({
      capturedAt: 1_000,
      head: { kind: "branch", branch: "feature-1", commit: C1 },
      base: { ref: "refs/heads/main", tip: BASE },
      complete: true,
      pathCount: 1,
      revision: 1,
    });
    expect((await store.get(PROJECT, WT_1))?.point).toEqual(point());

    const newer = point({ capturedAt: 2_000, head: { kind: "branch", branch: "feature-1", commit: C2 } });
    const second = await store.save(PROJECT, WT_1, newer, 1, allow);
    expect(second.status).toBe("saved");
    expect(Object.keys(second.snapshot.marks)).toEqual([WT_1]);
    expect((await store.get(PROJECT, WT_1))?.point).toEqual(newer);
    // The replaced point's file goes once the index no longer names it.
    expect(await pointFiles()).toHaveLength(1);
  });

  it("keeps projects apart", async () => {
    await store.save(PROJECT, WT_1, point(), 0, allow);
    expect((await store.read(OTHER_PROJECT)).marks).toEqual({});
    expect(await store.get(OTHER_PROJECT, WT_1)).toBeNull();
  });

  it("refuses a save that started before a newer mark of the worktree", async () => {
    await store.save(PROJECT, WT_1, point({ capturedAt: 2_000 }), 0, allow);
    const late = await store.save(PROJECT, WT_1, point({ capturedAt: 1_500 }), 0, allow);
    expect(late).toMatchObject({ status: "stale", changed: false });
    expect((await store.get(PROJECT, WT_1))?.point.capturedAt).toBe(2_000);
  });

  it("orders saves by revision, not by when their points were captured", async () => {
    await store.save(PROJECT, WT_1, point({ capturedAt: 2_000 }), 0, allow);
    // Started after the first landed, so it replaces it, earlier capture or not.
    const later = await store.save(PROJECT, WT_1, point({ capturedAt: 1_000 }), 1, allow);
    expect(later.status).toBe("saved");
    expect((await store.get(PROJECT, WT_1))?.point.capturedAt).toBe(1_000);
  });

  it("lets a save through when only another worktree's mark changed meanwhile", async () => {
    await store.save(PROJECT, WT_2, point({ worktreePath: WT_2 }), 0, allow);
    expect((await store.save(PROJECT, WT_1, point(), 0, allow)).status).toBe("saved");
  });

  it("never brings back a mark cleared after the save started", async () => {
    await store.save(PROJECT, WT_1, point(), 0, allow);
    expect((await store.clear(PROJECT, WT_1, 1, allow)).status).toBe("cleared");
    const resurrect = await store.save(PROJECT, WT_1, point({ capturedAt: 1_500 }), 1, allow);
    expect(resurrect.status).toBe("stale");
    expect((await store.read(PROJECT)).marks).toEqual({});
    expect(await pointFiles()).toEqual([]);
  });

  it("refuses a clear that would drop a mark made after it started", async () => {
    await store.save(PROJECT, WT_1, point(), 0, allow);
    const clear = await store.clear(PROJECT, WT_1, 0, allow);
    expect(clear).toMatchObject({ status: "stale", changed: false });
    expect((await store.read(PROJECT)).marks[WT_1]).toBeDefined();
  });

  it("refuses a first mark that a clear overtook, as when a mark is undone before it lands", async () => {
    expect(await store.clear(PROJECT, WT_1, 0, allow)).toMatchObject({
      status: "cleared",
      changed: true,
    });
    expect((await store.save(PROJECT, WT_1, point(), 0, allow)).status).toBe("stale");
    // A tombstone overtaken again still refuses the save started before it.
    expect((await store.clear(PROJECT, WT_1, 1, allow)).status).toBe("cleared");
    expect((await store.save(PROJECT, WT_1, point(), 1, allow)).status).toBe("stale");
    expect((await store.save(PROJECT, WT_1, point(), 2, allow)).status).toBe("saved");
  });

  it("writes nothing when the guard refuses", async () => {
    const refuse = () => {
      throw new Error("driven elsewhere");
    };
    await expect(store.save(PROJECT, WT_1, point(), 0, refuse)).rejects.toThrow("driven elsewhere");
    expect(await store.read(PROJECT)).toEqual({ projectId: PROJECT, marks: {}, revision: 0 });
    expect(await pointFiles()).toEqual([]);
  });

  it("puts the index back when the guard refuses once it is written", async () => {
    await store.save(PROJECT, WT_1, point(), 0, allow);
    const before = await readIndexFile();
    let asked = 0;
    const handedOver = () => {
      if (++asked > 1) throw new Error("driven elsewhere");
    };
    await expect(
      store.save(PROJECT, WT_1, point({ capturedAt: 9_000 }), 1, handedOver)
    ).rejects.toThrow("driven elsewhere");
    expect(asked).toBe(2);
    expect(await readIndexFile()).toEqual(before);
    expect((await store.get(PROJECT, WT_1))?.point).toEqual(point());

    // With no index before, a refused first write leaves none.
    asked = 0;
    await expect(store.clear(OTHER_PROJECT, WT_1, 0, handedOver)).rejects.toThrow();
    await expect(fs.stat(path.join(stateDir(OTHER_PROJECT), "review-marks.json"))).rejects.toThrow();
  });

  it("refuses to keep a point too large for the link", async () => {
    const huge = point({
      entries: Array.from({ length: 1200 }, (_, i) => ({
        path: `${String(i).padStart(4, "0")}-${"x".repeat(16_000)}`,
        head: null,
        index: { kind: "absent" as const },
        worktree: { kind: "file" as const, mode: "100644" as const, oid: C2, size: 1 },
      })),
    });
    await expect(store.save(PROJECT, WT_1, huge, 0, allow)).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(await pointFiles()).toEqual([]);
  });

  it("serializes writes, so concurrent saves can't both land", async () => {
    const results = await Promise.all([
      store.save(PROJECT, WT_1, point({ capturedAt: 1_000 }), 0, allow),
      store.save(PROJECT, WT_1, point({ capturedAt: 2_000 }), 0, allow),
    ]);
    expect(results.map((result) => result.status)).toEqual(["saved", "stale"]);
  });

  it("removes marks of gone worktrees, and a save in flight for one can't restore it", async () => {
    await store.save(PROJECT, WT_1, point(), 0, allow);
    const release = store.beginSave(PROJECT, WT_2);
    const removed = await store.remove(
      PROJECT,
      await store.entryRevisions(PROJECT, [WT_2])
    );
    expect(removed.changed).toBe(true);
    expect(removed.snapshot.marks).toEqual({});
    const late = await store.save(PROJECT, WT_2, point({ worktreePath: WT_2 }), 1, allow);
    release();
    expect(late.status).toBe("stale");
  });

  it("writes nothing to remove worktrees with no mark and no save in flight", async () => {
    expect((await store.remove(PROJECT, new Map([[WT_1, null]]))).changed).toBe(false);
    await expect(fs.stat(stateDir())).rejects.toThrow();
  });

  it("leaves a mark made after the removal's read, and says so", async () => {
    await store.save(PROJECT, WT_1, point(), 0, allow);
    const expected = await store.entryRevisions(PROJECT, [WT_2]);
    expect(expected).toEqual(
      new Map([
        [WT_1, 1],
        [WT_2, null],
      ])
    );
    // Recreated and marked again while the host was being asked.
    await store.save(PROJECT, WT_1, point({ capturedAt: 2_000 }), 1, allow);
    const removal = await store.remove(PROJECT, expected);
    expect(removal.changedSince).toEqual([WT_1]);
    expect(removal.changed).toBe(false);
    expect((await store.get(PROJECT, WT_1))?.point.capturedAt).toBe(2_000);
  });

  it("trims old tombstones but still refuses saves that started before them", async () => {
    // 257 clears, each leaving a tombstone; the first is trimmed.
    let revision = 0;
    for (let i = 0; i < 257; i++) {
      const id = path.resolve(`/repos/alpha/wt-${i}`);
      revision = (await store.save(PROJECT, id, point({ worktreePath: id }), revision, allow))
        .snapshot.revision;
      revision = (await store.clear(PROJECT, id, revision, allow)).snapshot.revision;
    }
    const index = await readIndexFile();
    expect(Object.keys(index.worktrees as object)).toHaveLength(256);
    expect(index.floor).toBe(2);
    const first = path.resolve("/repos/alpha/wt-0");
    expect((await store.save(PROJECT, first, point({ worktreePath: first }), 1, allow)).status).toBe(
      "stale"
    );
    expect(
      (await store.save(PROJECT, first, point({ worktreePath: first }), revision, allow)).status
    ).toBe("saved");
  });

  it("refuses a save naming a revision the store never reached", async () => {
    expect((await store.save(PROJECT, WT_1, point(), 7, allow)).status).toBe("stale");
  });

  it("counts revisions from the clock, so a history that starts over passes the old one", async () => {
    let clock = 5_000;
    const clocked = new ReviewMarkStore(root, { now: () => clock });
    expect((await clocked.save(PROJECT, WT_1, point(), 0, allow)).snapshot.revision).toBe(5_000);
    // The clock stepping back never moves a revision down.
    clock = 10;
    expect((await clocked.clear(PROJECT, WT_1, 5_000, allow)).snapshot.revision).toBe(5_001);

    clock = 6_000;
    await fs.rm(path.join(stateDir(), "review-marks.json"));
    const restarted = await clocked.save(PROJECT, WT_2, point({ worktreePath: WT_2 }), 0, allow);
    expect(restarted.snapshot.revision).toBeGreaterThan(5_001);
    expect(restarted.snapshot.marks[WT_2]?.markedAt).toBe(6_000);
  });

  describe("reading a user-editable file", () => {
    it("drops what isn't a worktree id and keeps an unreadable mark as a tombstone", async () => {
      await store.save(PROJECT, WT_1, point(), 0, allow);
      const index = await readIndexFile();
      const worktrees = index.worktrees as Record<string, { mark: Record<string, unknown> }>;
      worktrees[WT_1]!.mark.head = { kind: "branch", branch: "bad..name", commit: C1 };
      worktrees["relative/path"] = { mark: worktrees[WT_1]!.mark };
      await writeIndexFile(index);

      expect((await store.read(PROJECT)).marks).toEqual({});
      expect(await store.get(PROJECT, WT_1)).toBeNull();
      // Still a tombstone at its revision: a save started before it is refused.
      expect((await store.save(PROJECT, WT_1, point({ capturedAt: 5 }), 0, allow)).status).toBe(
        "stale"
      );
    });

    it("takes an entry with no usable revision as changed at the newest", async () => {
      await store.save(PROJECT, WT_1, point(), 0, allow);
      await store.save(PROJECT, WT_2, point({ worktreePath: WT_2 }), 1, allow);
      const index = await readIndexFile();
      (index.worktrees as Record<string, { revision: unknown }>)[WT_1]!.revision = "soon";
      await writeIndexFile(index);
      expect((await store.read(PROJECT)).marks[WT_1]?.revision).toBe(2);
    });

    it("moves a corrupt index aside and starts empty", async () => {
      await writeIndexFile("{ not json");
      expect(await store.read(PROJECT)).toEqual({ projectId: PROJECT, marks: {}, revision: 0 });
      const names = await fs.readdir(stateDir());
      expect(names.some((name) => name.startsWith("review-marks.json.corrupted."))).toBe(true);
      expect(names).not.toContain("review-marks.json");
    });

    it("moves an index from a newer build aside rather than writing over it", async () => {
      await writeIndexFile({ version: 2, revision: 4, worktrees: {} });
      expect((await store.read(PROJECT)).revision).toBe(0);
      const names = await fs.readdir(stateDir());
      expect(names.some((name) => name.startsWith("review-marks.json.future-v2."))).toBe(true);
    });

    it("refuses to write over an index it can't read", async () => {
      await fs.mkdir(path.join(stateDir(), "review-marks.json"), { recursive: true });
      await expect(store.save(PROJECT, WT_1, point(), 0, allow)).rejects.toThrow();
    });

    it("reports no point when its file was edited into something else", async () => {
      await store.save(PROJECT, WT_1, point(), 0, allow);
      const [name] = await pointFiles();
      const file = path.join(stateDir(), "review-marks", name!);
      const stored = JSON.parse(await fs.readFile(file, "utf8"));

      await fs.writeFile(file, JSON.stringify({ ...stored, worktreeId: WT_2 }));
      expect(await store.get(PROJECT, WT_1)).toBeNull();

      await fs.writeFile(file, JSON.stringify({ ...stored, point: { ...stored.point, entries: "x" } }));
      expect(await store.get(PROJECT, WT_1)).toBeNull();

      await fs.writeFile(file, JSON.stringify(stored));
      expect((await store.get(PROJECT, WT_1))?.point).toEqual(point());

      // A point that doesn't say what the index's summary does isn't the mark.
      await fs.writeFile(
        file,
        JSON.stringify({ ...stored, point: { ...stored.point, capturedAt: 7 } })
      );
      expect(await store.get(PROJECT, WT_1)).toBeNull();
    });

    it("tidies point files a crash left behind", async () => {
      await store.save(PROJECT, WT_1, point(), 0, allow);
      const dir = path.join(stateDir(), "review-marks");
      const orphan = `${"c".repeat(64)}.9.json`;
      await fs.writeFile(path.join(dir, orphan), "{}");
      await fs.writeFile(path.join(dir, "notes.txt"), "mine");
      await store.save(PROJECT, WT_2, point({ worktreePath: WT_2 }), 1, allow);
      const names = await pointFiles();
      expect(names).not.toContain(orphan);
      expect(names).toContain("notes.txt");
      expect(names.filter((name) => name.endsWith(".json"))).toHaveLength(2);
    });
  });
});
