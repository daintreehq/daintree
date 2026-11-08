import { describe, expect, it } from "vitest";
import type { WorktreeDiskUsage } from "@/hooks/useWorktreeDiskUsage";
import { orderWorktreesBySize } from "../worktreeSizeOrder";

const measured = (bytes: number): WorktreeDiskUsage => ({ status: "measured", bytes });
const pending: WorktreeDiskUsage = { status: "pending" };
const unknown: WorktreeDiskUsage = { status: "unknown" };

function order(entries: Array<[string, WorktreeDiskUsage | undefined]>): string[] {
  const usage = new Map<string, WorktreeDiskUsage>();
  for (const [id, entry] of entries) if (entry) usage.set(id, entry);
  return orderWorktreesBySize(
    entries.map(([id]) => ({ id })),
    usage
  ).map((w) => w.id);
}

describe("orderWorktreesBySize", () => {
  it("puts the largest first", () => {
    expect(
      order([
        ["small", measured(10)],
        ["big", measured(1_000)],
        ["mid", measured(100)],
      ])
    ).toEqual(["big", "mid", "small"]);
  });

  it("keeps a measured zero among the measured, above anything without a figure", () => {
    expect(
      order([
        ["pending", pending],
        ["empty", measured(0)],
        ["unknown", unknown],
      ])
    ).toEqual(["empty", "pending", "unknown"]);
  });

  it("leaves pending, unknown and unlisted rows in their incoming order after the measured", () => {
    expect(
      order([
        ["u1", unknown],
        ["p1", pending],
        ["m", measured(5)],
        ["missing", undefined],
        ["p2", pending],
      ])
    ).toEqual(["m", "u1", "p1", "missing", "p2"]);
  });

  it("doesn't move a row that turns from pending to unknown", () => {
    const before = order([
      ["a", pending],
      ["b", pending],
      ["c", measured(1)],
    ]);
    const after = order([
      ["a", unknown],
      ["b", pending],
      ["c", measured(1)],
    ]);
    expect(after).toEqual(before);
  });

  it("keeps equal sizes in their incoming order and doesn't mutate the input", () => {
    const input = [{ id: "x" }, { id: "y" }];
    const usage = new Map([
      ["x", measured(7)],
      ["y", measured(7)],
    ]);
    expect(orderWorktreesBySize(input, usage).map((w) => w.id)).toEqual(["x", "y"]);
    expect(input.map((w) => w.id)).toEqual(["x", "y"]);
  });
});
