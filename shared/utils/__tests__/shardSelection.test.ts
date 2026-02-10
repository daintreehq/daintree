import { describe, expect, it } from "vitest";
import { selectShard } from "../shardSelection.js";

describe("selectShard", () => {
  it("returns zero when shardCount is one", () => {
    expect(selectShard("terminal-1", 1)).toBe(0);
  });

  it("returns deterministic shard indices within range", () => {
    const shardCount = 8;
    const id = "terminal-abc";
    const first = selectShard(id, shardCount);
    const second = selectShard(id, shardCount);

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(shardCount);
  });

  it("distributes multiple ids into valid shards", () => {
    const shardCount = 4;
    const ids = Array.from({ length: 30 }, (_, i) => `terminal-${i}`);
    const assignments = ids.map((id) => selectShard(id, shardCount));

    expect(assignments.every((idx) => Number.isInteger(idx))).toBe(true);
    expect(assignments.every((idx) => idx >= 0 && idx < shardCount)).toBe(true);
  });

  it("throws for zero or negative shard counts", () => {
    expect(() => selectShard("terminal-1", 0)).toThrow("shardCount must be a positive integer");
    expect(() => selectShard("terminal-1", -1)).toThrow("shardCount must be a positive integer");
  });

  it("throws for non-finite or non-integer shard counts", () => {
    expect(() => selectShard("terminal-1", Number.NaN)).toThrow(
      "shardCount must be a positive integer"
    );
    expect(() => selectShard("terminal-1", Number.POSITIVE_INFINITY)).toThrow(
      "shardCount must be a positive integer"
    );
    expect(() => selectShard("terminal-1", 1.5)).toThrow("shardCount must be a positive integer");
  });
});
