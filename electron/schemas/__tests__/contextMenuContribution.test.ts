import { describe, it, expect } from "vitest";
import { ContextMenuContributionSchema } from "../plugin.js";

const base = { actionId: "acme.plugin.action", label: "Do it" };

describe("ContextMenuContributionSchema location", () => {
  it("accepts every live location", () => {
    for (const location of ["worktree", "terminal", "file", "browser", "project"]) {
      expect(ContextMenuContributionSchema.safeParse({ ...base, location }).success).toBe(true);
    }
  });

  it("rejects a location with no consumer", () => {
    expect(ContextMenuContributionSchema.safeParse({ ...base, location: "panel" }).success).toBe(
      false
    );
  });
});
