import { describe, expect, it } from "vitest";
import type { ChangeData, HunkData, HunkTokens, TokenNode } from "react-diff-view";
import {
  countHunkRows,
  DIFF_ROW_BATCH,
  shouldStageRows,
  sliceHunksToRowBudget,
  stageTokens,
} from "../diffRowStaging";

function insert(line: number): ChangeData {
  return { type: "insert", content: `+${line}`, lineNumber: line, isInsert: true } as ChangeData;
}
function del(line: number): ChangeData {
  return { type: "delete", content: `-${line}`, lineNumber: line, isDelete: true } as ChangeData;
}
function normal(oldLine: number, newLine: number): ChangeData {
  return {
    type: "normal",
    content: ` ${oldLine}`,
    oldLineNumber: oldLine,
    newLineNumber: newLine,
    isNormal: true,
  } as ChangeData;
}
function hunk(changes: ChangeData[], start = 1): HunkData {
  return {
    content: `@@ -${start} +${start} @@`,
    oldStart: start,
    newStart: start,
    oldLines: changes.filter((c) => c.type !== "insert").length,
    newLines: changes.filter((c) => c.type !== "delete").length,
    changes,
  };
}
function tokenLine(label: string): TokenNode[] {
  return [{ type: "text", value: label }];
}

describe("shouldStageRows", () => {
  it("stages only sets past one batch", () => {
    expect(shouldStageRows(DIFF_ROW_BATCH)).toBe(false);
    expect(shouldStageRows(DIFF_ROW_BATCH + 1)).toBe(true);
  });
});

describe("countHunkRows", () => {
  it("counts every change across hunks", () => {
    expect(countHunkRows([])).toBe(0);
    expect(countHunkRows([hunk([insert(1), insert(2)]), hunk([del(5)], 5)])).toBe(3);
  });
});

describe("sliceHunksToRowBudget", () => {
  it("returns the same array when everything fits", () => {
    const hunks = [hunk([insert(1), insert(2)]), hunk([insert(3)], 3)];
    expect(sliceHunksToRowBudget(hunks, 3)).toBe(hunks);
    expect(sliceHunksToRowBudget(hunks, Number.POSITIVE_INFINITY)).toBe(hunks);
  });

  it("keeps whole hunks while they fit, then cuts the next one short", () => {
    const first = hunk([insert(1), insert(2)]);
    const second = hunk([insert(3), insert(4), insert(5)], 3);
    const sliced = sliceHunksToRowBudget([first, second], 4);
    expect(sliced).toHaveLength(2);
    expect(sliced[0]).toBe(first);
    // The partial hunk keeps its own header fields and the original change objects.
    expect(sliced[1]).not.toBe(second);
    expect(sliced[1]!.content).toBe(second.content);
    expect(sliced[1]!.oldStart).toBe(second.oldStart);
    expect(sliced[1]!.changes).toEqual([second.changes[0], second.changes[1]]);
    expect(sliced[1]!.changes[0]).toBe(second.changes[0]);
  });

  it("drops hunks past the budget entirely", () => {
    const first = hunk([insert(1), insert(2)]);
    expect(sliceHunksToRowBudget([first, hunk([insert(3)], 3)], 2)).toEqual([first]);
    expect(sliceHunksToRowBudget([first], 0)).toEqual([]);
  });

  it("never separates a delete from the insert split view pairs it with", () => {
    // Every adjacency react-diff-view's groupElements distinguishes: a lone
    // delete, a delete run, a delete followed by an insert, inserts, normals.
    const changes = [
      normal(1, 1),
      del(2),
      del(3),
      insert(2),
      insert(3),
      normal(4, 4),
      del(5),
      normal(6, 5),
      del(7),
      insert(6),
    ];
    const source = hunk(changes);
    for (let budget = 1; budget < changes.length; budget++) {
      const [sliced] = sliceHunksToRowBudget([source], budget);
      const kept = sliced!.changes;
      expect(kept).toEqual(changes.slice(0, kept.length));
      const last = kept[kept.length - 1];
      const next = changes[kept.length];
      expect(
        last?.type === "delete" && next?.type === "insert",
        `budget ${budget} cut a delete from its insert`
      ).toBe(false);
      // Rounds up by at most the one insert it pulled in.
      expect(kept.length - budget).toBeLessThanOrEqual(1);
      expect(kept.length).toBeGreaterThanOrEqual(budget);
    }
  });

  it("grows as a prefix: each budget's rows start with the previous budget's", () => {
    const changes = Array.from({ length: 23 }, (_, i) =>
      i % 3 === 1 ? del(i + 1) : insert(i + 1)
    );
    const hunks = [hunk(changes.slice(0, 10)), hunk(changes.slice(10), 20)];
    let previous: ChangeData[] = [];
    for (let budget = 0; budget <= 24; budget += 4) {
      const flat = sliceHunksToRowBudget(hunks, budget).flatMap((h) => h.changes);
      expect(flat.slice(0, previous.length)).toEqual(previous);
      previous = flat;
    }
    expect(previous).toEqual(changes);
  });
});

describe("stageTokens", () => {
  // Realistic addressing: a later hunk past a gap, and normal lines whose old
  // and new numbers differ by the inserts above them.
  const changes = [normal(10, 12), del(11), insert(13), insert(14), normal(12, 15), normal(40, 43)];
  const hunks = [hunk(changes.slice(0, 5), 10), hunk(changes.slice(5), 40)];
  const sideLines = (label: string, count: number) =>
    Array.from({ length: count }, (_, i) => tokenLine(`${label}-${i + 1}`));
  const target: HunkTokens = { old: sideLines("t-old", 40), new: sideLines("t-new", 43) };
  const base: HunkTokens = { old: sideLines("b-old", 40), new: sideLines("b-new", 43) };

  it("takes the first rows from the target and the rest from the base, by identity", () => {
    const staged = stageTokens(hunks, target, base, 2);
    // Row 0 (normal 10 -> 12): each side looked up by its own line number.
    expect(staged.old[9]).toBe(target.old[9]);
    expect(staged.new[11]).toBe(target.new[11]);
    // Row 1 (delete old 11).
    expect(staged.old[10]).toBe(target.old[10]);
    // Rows 2-5 keep the base pass, the later hunk included.
    expect(staged.new[12]).toBe(base.new[12]);
    expect(staged.new[13]).toBe(base.new[13]);
    expect(staged.old[11]).toBe(base.old[11]);
    expect(staged.new[14]).toBe(base.new[14]);
    expect(staged.old[39]).toBe(base.old[39]);
    expect(staged.new[42]).toBe(base.new[42]);
  });

  it("leaves rows past the cursor without an entry when nothing was shown before", () => {
    const staged = stageTokens(hunks, target, null, 1);
    expect(staged.old[9]).toBe(target.old[9]);
    expect(staged.new[11]).toBe(target.new[11]);
    // A hole reads `undefined`, the value a staged table hands every row before
    // any pass, so a memoized row the cursor hasn't reached sees no change.
    expect(10 in staged.old).toBe(false);
    expect(12 in staged.new).toBe(false);
    expect(Object.keys(staged.old)).toEqual(["9"]);
    expect(Object.keys(staged.new)).toEqual(["11"]);
  });

  it("copies only lines the rows actually address", () => {
    const staged = stageTokens(hunks, target, base, changes.length);
    expect(Object.keys(staged.old).map(Number)).toEqual([9, 10, 11, 39]);
    expect(Object.keys(staged.new).map(Number)).toEqual([11, 12, 13, 14, 42]);
    for (const line of [9, 10, 11, 39]) expect(staged.old[line]).toBe(target.old[line]);
    for (const line of [11, 12, 13, 14, 42]) expect(staged.new[line]).toBe(target.new[line]);
  });

  it("skips lines a pass has no tokens for", () => {
    const sparse: HunkTokens = { old: [], new: [] };
    sparse.new[11] = tokenLine("only");
    const staged = stageTokens(hunks, sparse, null, changes.length);
    expect(Object.keys(staged.old)).toEqual([]);
    expect(Object.keys(staged.new)).toEqual(["11"]);
    expect(staged.new[11]).toBe(sparse.new[11]);
  });
});
