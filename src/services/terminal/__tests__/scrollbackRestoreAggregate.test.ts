import { describe, it, expect } from "vitest";
import {
  tallyScrollbackRestoreStates,
  type ScrollbackRestoreState,
} from "../scrollbackRestoreAggregate";

describe("tallyScrollbackRestoreStates", () => {
  it("tallies a mixed batch with total = sum of non-'none' states", () => {
    const states: ScrollbackRestoreState[] = ["none", "pending", "pending", "in-progress", "done"];
    const result = tallyScrollbackRestoreStates(states);
    expect(result.pendingCount).toBe(2);
    expect(result.inProgressCount).toBe(1);
    expect(result.totalCount).toBe(4);
    // The "N of M" done denominator is derivable: done = total - pending - inProgress.
    expect(result.totalCount - result.pendingCount - result.inProgressCount).toBe(1);
  });
});
