import { describe, expect, it } from "vitest";
import { workingTreeViewedKey } from "../diffViewedKey";

describe("workingTreeViewedKey", () => {
  it("keeps distinct paths apart, including ones containing a colon or a backslash", () => {
    expect(workingTreeViewedKey("src/a.ts")).not.toBe(workingTreeViewedKey("src/b.ts"));
    expect(workingTreeViewedKey("a:b.ts")).not.toBe(workingTreeViewedKey("a/b.ts"));
    // A legal POSIX filename, not a separator.
    expect(workingTreeViewedKey("a\\b.ts")).not.toBe(workingTreeViewedKey("a/b.ts"));
  });
});
