import { describe, expect, it } from "vitest";
import { ReviewPointCaptures } from "../reviewPointCaptures.js";
import type { ReviewPoint } from "../../../shared/types/reviewPoint.js";

const COMMIT = "1".repeat(40);

function point(capturedAt: number, padding = 0): ReviewPoint {
  return {
    version: 1,
    capturedAt,
    worktreePath: "/repo/wt",
    gitDir: "/repo/.git/worktrees/wt",
    commonDir: "/repo/.git",
    objectFormat: "sha1",
    head: { kind: "branch", branch: "wt", commit: COMMIT },
    base: { requested: { kind: "branch", branch: "main" }, ref: null, tip: null, mergeBases: [] },
    entries: Array.from({ length: padding }, (_, i) => ({
      path: `file-${String(i).padStart(8, "0")}.txt`,
      head: null,
      index: { kind: "absent" as const },
      worktree: { kind: "file" as const, mode: "100644" as const, oid: COMMIT, size: 1 },
    })),
    incomplete: null,
  };
}

describe("ReviewPointCaptures", () => {
  it("gives a capture back only for the project and worktree it was taken in", () => {
    const captures = new ReviewPointCaptures();
    const id = captures.hold("p1", "/repo/wt", point(1));

    expect(captures.get("p1", "/repo/wt", id)?.capturedAt).toBe(1);
    expect(captures.get("p2", "/repo/wt", id)).toBeNull();
    expect(captures.get("p1", "/repo/other", id)).toBeNull();
    expect(captures.get("p1", "/repo/wt", "unknown")).toBeNull();
  });

  it("keeps a worktree's newest captures and lets the oldest go", () => {
    const captures = new ReviewPointCaptures();
    const ids = Array.from({ length: 10 }, (_, i) => captures.hold("p1", "/repo/wt", point(i)));
    const other = captures.hold("p1", "/repo/other", point(99));

    const kept = ids.filter((id) => captures.get("p1", "/repo/wt", id) !== null);
    expect(kept).toEqual(ids.slice(ids.length - kept.length));
    expect(kept.length).toBeLessThan(ids.length);
    expect(captures.get("p1", "/repo/wt", ids.at(-1)!)).not.toBeNull();
    expect(captures.get("p1", "/repo/other", other)).not.toBeNull();
  });

  it("lets captures go once they're old", () => {
    let now = 0;
    const captures = new ReviewPointCaptures(() => now);
    const id = captures.hold("p1", "/repo/wt", point(1));

    now += 60 * 60_000;

    expect(captures.get("p1", "/repo/wt", id)).toBeNull();
  });

  it("drops the oldest captures across worktrees once their total size runs over", () => {
    const captures = new ReviewPointCaptures();
    // Roughly 3 MB each, across worktrees so no per-worktree limit applies.
    const ids = Array.from({ length: 30 }, (_, i) =>
      captures.hold("p1", `/repo/wt-${i}`, point(i, 20_000))
    );

    expect(captures.get("p1", "/repo/wt-0", ids[0]!)).toBeNull();
    expect(captures.get("p1", "/repo/wt-29", ids[29]!)).not.toBeNull();
  });
});
