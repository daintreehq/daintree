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

  it("keeps equal sizes in their incoming order", () => {
    expect(
      order([
        ["x", measured(7)],
        ["y", measured(7)],
      ])
    ).toEqual(["x", "y"]);
  });

  it("returns a new order and leaves the caller's list as it was", () => {
    const input = [{ id: "small" }, { id: "big" }];
    const usage = new Map([
      ["small", measured(1)],
      ["big", measured(100)],
    ]);
    expect(orderWorktreesBySize(input, usage).map((w) => w.id)).toEqual(["big", "small"]);
    expect(input.map((w) => w.id)).toEqual(["small", "big"]);
  });

  it("keeps worktrees from outside the project below the project's own, ordering each side by size", () => {
    const input = [
      { id: "own-small" },
      { id: "outside-huge", isExternal: true },
      { id: "outside-small", isExternal: true },
      { id: "own-big" },
    ];
    const usage = new Map([
      ["own-small", measured(1)],
      ["outside-huge", measured(1_000_000)],
      ["outside-small", measured(2)],
      ["own-big", measured(50)],
    ]);
    expect(orderWorktreesBySize(input, usage).map((w) => w.id)).toEqual([
      "own-big",
      "own-small",
      "outside-huge",
      "outside-small",
    ]);
  });
});
