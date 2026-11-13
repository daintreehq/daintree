import { describe, expect, it } from "vitest";
import { workingTreeViewedKey } from "../diffViewedKey";

describe("workingTreeViewedKey", () => {
  it("gives the same key whichever separator the path was spelled with", () => {
    expect(workingTreeViewedKey("src\\deep\\a.ts")).toBe(workingTreeViewedKey("src/deep/a.ts"));
  });

  it("keeps distinct paths apart, including ones containing a colon", () => {
    expect(workingTreeViewedKey("src/a.ts")).not.toBe(workingTreeViewedKey("src/b.ts"));
    expect(workingTreeViewedKey("a:b.ts")).not.toBe(workingTreeViewedKey("a/b.ts"));
  });
});
