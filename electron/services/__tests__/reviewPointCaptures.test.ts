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
    const id = captures.hold("p1", "/repo/wt", point(1))!;

    expect(captures.get("p1", "/repo/wt", id)?.capturedAt).toBe(1);
    expect(captures.get("p2", "/repo/wt", id)).toBeNull();
    expect(captures.get("p1", "/repo/other", id)).toBeNull();
    expect(captures.get("p1", "/repo/wt", "unknown")).toBeNull();
  });

  it("keeps a worktree's newest captures and lets the oldest go", () => {
    const captures = new ReviewPointCaptures();
    const other = captures.hold("p1", "/repo/other", point(99))!;
    const elsewhere = captures.hold("p2", "/repo/wt", point(98))!;
    const ids = Array.from({ length: 12 }, (_, i) => captures.hold("p1", "/repo/wt", point(i))!);

    const kept = ids.filter((id) => captures.get("p1", "/repo/wt", id) !== null);
    // A hub's displayed capture is among its last few; eight is plenty, and
    // another worktree's or project's captures are never what's let go.
    expect(kept).toEqual(ids.slice(4));
    expect(captures.get("p1", "/repo/other", other)).not.toBeNull();
    expect(captures.get("p2", "/repo/wt", elsewhere)).not.toBeNull();
  });

  it("lets captures go once they're old, and keeps them until then", () => {
    let now = 0;
    const captures = new ReviewPointCaptures(() => now);
    const id = captures.hold("p1", "/repo/wt", point(1))!;

    now += 29 * 60_000;
    expect(captures.get("p1", "/repo/wt", id)).not.toBeNull();
    now += 2 * 60_000;
    expect(captures.get("p1", "/repo/wt", id)).toBeNull();
  });

  it("holds no capture larger than a mark can keep, and lets nothing go for one", () => {
    const captures = new ReviewPointCaptures();
    const kept = captures.hold("p1", "/repo/wt", point(1))!;
    // Over 16 MiB of entries.
    const huge = point(2, 110_000);

    expect(captures.hold("p1", "/repo/wt", huge)).toBeNull();
    expect(captures.get("p1", "/repo/wt", kept)).not.toBeNull();
  });

  it("drops the oldest captures across worktrees once their total size runs over", () => {
    const captures = new ReviewPointCaptures();
    const size = Buffer.byteLength(JSON.stringify(point(0, 20_000)));
    // Across worktrees, so no per-worktree limit applies.
    const ids = Array.from({ length: 30 }, (_, i) =>
      captures.hold("p1", `/repo/wt-${i}`, point(i, 20_000))!
    );

    const kept = ids.filter((id, i) => captures.get("p1", `/repo/wt-${i}`, id) !== null);
    // The newest that fit in 64 MiB together, and no fewer.
    expect(kept).toEqual(ids.slice(ids.length - Math.floor((64 * 1024 * 1024) / size)));
  });
});
