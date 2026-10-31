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
  const changes = [normal(1, 1), del(2), insert(2), insert(3)];
  const hunks = [hunk(changes)];
  const target: HunkTokens = {
    old: [tokenLine("t-old-1"), tokenLine("t-old-2")],
    new: [tokenLine("t-new-1"), tokenLine("t-new-2"), tokenLine("t-new-3")],
  };
  const base: HunkTokens = {
    old: [tokenLine("b-old-1"), tokenLine("b-old-2")],
    new: [tokenLine("b-new-1"), tokenLine("b-new-2"), tokenLine("b-new-3")],
  };

  it("takes the first rows from the target and the rest from the base, by identity", () => {
    const staged = stageTokens(hunks, target, base, 2);
    // Row 0 (normal) and row 1 (delete) are inside the budget.
    expect(staged.old[0]).toBe(target.old[0]);
    expect(staged.new[0]).toBe(target.new[0]);
    expect(staged.old[1]).toBe(target.old[1]);
    // Rows 2 and 3 (inserts) keep the base pass.
    expect(staged.new[1]).toBe(base.new[1]);
    expect(staged.new[2]).toBe(base.new[2]);
  });

  it("gives rows past the cursor an explicit null when nothing was shown before", () => {
    const staged = stageTokens(hunks, target, null, 1);
    expect(staged.old[0]).toBe(target.old[0]);
    expect(staged.new[0]).toBe(target.new[0]);
    // The same value a row reads when the table has no tokens at all, so a
    // memoized row that hasn't been reached sees no prop change.
    expect(staged.old[1]).toBeNull();
    expect(staged.new[1]).toBeNull();
    expect(staged.new[2]).toBeNull();
  });

  it("covers every row once the budget reaches the end", () => {
    const staged = stageTokens(hunks, target, base, changes.length);
    expect(staged.old).toEqual(target.old);
    expect(staged.new).toEqual(target.new);
    staged.new.forEach((line, i) => expect(line).toBe(target.new[i]));
  });
});
