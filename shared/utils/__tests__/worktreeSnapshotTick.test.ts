import { describe, expect, it } from "vitest";
import type { WorktreeSnapshot } from "../../types/workspace-host.js";
import {
  applyWorktreeTick,
  toWorktreeTick,
  worktreeSnapshotContentEqual,
  worktreeTickMatches,
} from "../worktreeSnapshotTick.js";

function makeSnapshot(extra: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return {
    id: "/repo/wt",
    worktreeId: "/repo/wt",
    generation: 3,
    path: "/repo/wt",
    name: "wt",
    isCurrent: true,
    worktreeChanges: {
      worktreeId: "/repo/wt",
      rootPath: "/repo/wt",
      changes: [
        { path: "a.ts", status: "modified", insertions: 1, deletions: 0, mtimeMs: 10 },
        { path: "b.ts", status: "added", insertions: 4, deletions: 0, mtimeMs: 20 },
      ],
      changedFileCount: 2,
      lastUpdated: 100,
    },
    linked: { providerId: "github", pr: undefined },
    timestamp: 1,
    lastGitStatusCheckedAt: 1,
    workingTreeChangedAt: 1,
    workingTreeChangedDirs: ["src"],
    ...extra,
  } as WorktreeSnapshot;
}

describe("worktreeSnapshotContentEqual", () => {
  it("ignores every volatile stamp", () => {
    const next = makeSnapshot({
      timestamp: 2,
      lastGitStatusCheckedAt: 2,
      workingTreeChangedAt: 2,
      workingTreeChangedDirs: null,
    });
    expect(worktreeSnapshotContentEqual(makeSnapshot(), next)).toBe(true);
  });

  it("compares structurally, not by reference", () => {
    const a = makeSnapshot();
    const b = structuredClone(a);
    expect(worktreeSnapshotContentEqual(a, b)).toBe(true);
  });

  it("sees a change deep inside the changes array", () => {
    const a = makeSnapshot();
    const b = structuredClone(a);
    b.worktreeChanges!.changes[1]!.mtimeMs = 21;
    expect(worktreeSnapshotContentEqual(a, b)).toBe(false);
  });

  it("sees a field it has no explicit knowledge of", () => {
    const b = { ...makeSnapshot(), someFutureField: "x" } as WorktreeSnapshot;
    expect(worktreeSnapshotContentEqual(makeSnapshot(), b)).toBe(false);
    expect(worktreeSnapshotContentEqual(b, makeSnapshot())).toBe(false);
  });

  it("sees an own key that shadows an inherited name", () => {
    const b = { ...makeSnapshot(), toString: "x" } as unknown as WorktreeSnapshot;
    expect(worktreeSnapshotContentEqual(makeSnapshot(), b)).toBe(false);
    expect(worktreeSnapshotContentEqual(b, makeSnapshot())).toBe(false);
  });

  it("never treats two distinct non-plain objects as equal", () => {
    const a = makeSnapshot({ linked: new Date(1) as never });
    const b = makeSnapshot({ linked: new Date(1) as never });
    expect(worktreeSnapshotContentEqual(a, b)).toBe(false);
  });

  it("ignores key order", () => {
    const a = makeSnapshot();
    const reversed = Object.fromEntries(Object.entries(a).reverse()) as WorktreeSnapshot;
    expect(worktreeSnapshotContentEqual(a, reversed)).toBe(true);
  });

  it("treats an absent key and an undefined one alike", () => {
    const withUndefined = makeSnapshot({ prNumber: undefined });
    const without = makeSnapshot();
    delete (without as Partial<WorktreeSnapshot>).prNumber;
    expect(worktreeSnapshotContentEqual(withUndefined, without)).toBe(true);
    expect(worktreeSnapshotContentEqual(without, withUndefined)).toBe(true);
  });

  it("tells null, an empty array and an object apart", () => {
    expect(
      worktreeSnapshotContentEqual(
        makeSnapshot({ linked: null }),
        makeSnapshot({ linked: undefined })
      )
    ).toBe(false);
    expect(
      worktreeSnapshotContentEqual(
        makeSnapshot({ lifecyclePhaseResults: [] }),
        makeSnapshot({ lifecyclePhaseResults: {} as never })
      )
    ).toBe(false);
  });
});

describe("worktree ticks", () => {
  it("round-trip back to the snapshot they were cut from", () => {
    const base = makeSnapshot();
    const next = makeSnapshot({
      timestamp: 9,
      lastGitStatusCheckedAt: 8,
      workingTreeChangedAt: 7,
      workingTreeChangedDirs: [],
    });
    expect(applyWorktreeTick(base, structuredClone(toWorktreeTick(next)))).toEqual(next);
  });

  it("carry an absent stamp through as absent", () => {
    const base = makeSnapshot();
    const next = makeSnapshot({
      workingTreeChangedAt: undefined,
      workingTreeChangedDirs: undefined,
    });
    const rebuilt = applyWorktreeTick(base, toWorktreeTick(next));
    expect(rebuilt.workingTreeChangedAt).toBeUndefined();
    expect(rebuilt.workingTreeChangedDirs).toBeUndefined();
  });

  it("match only the incarnation they were cut from", () => {
    const tick = toWorktreeTick(makeSnapshot());
    expect(worktreeTickMatches(makeSnapshot(), tick)).toBe(true);
    expect(worktreeTickMatches(makeSnapshot({ generation: 4 }), tick)).toBe(false);
    expect(worktreeTickMatches(makeSnapshot({ id: "/repo/other" }), tick)).toBe(false);
  });
});
