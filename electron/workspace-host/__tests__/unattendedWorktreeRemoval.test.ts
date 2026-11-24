import { describe, expect, it, vi } from "vitest";
import { verifyUnattendedCheckout } from "../unattendedWorktreeRemoval.js";

const HEAD = "e".repeat(40);
const guard = {
  expectedBranch: "feature/x",
  expectedHead: HEAD,
  notAfter: Number.MAX_SAFE_INTEGER,
};

function observed(overrides: Record<string, unknown> = {}) {
  return vi.fn(async () => ({
    headOid: HEAD,
    branch: "feature/x",
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    changedEntries: 0,
    hiddenFromStatus: 0,
    ...overrides,
  }));
}

describe("verifyUnattendedCheckout", () => {
  it("passes a checkout on the expected branch and commit with nothing outstanding", async () => {
    const read = observed();
    await expect(verifyUnattendedCheckout("/wt", guard, read)).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledWith("/wt");
  });

  it.each([
    ["another branch", { branch: "feature/y" }, /branch/],
    ["a detached HEAD", { branch: null }, /branch/],
    ["another commit", { headOid: "f".repeat(40) }, /HEAD/],
    ["a staged file", { staged: 1 }, /committed/],
    ["an unstaged file", { unstaged: 1 }, /committed/],
    ["an untracked file", { untracked: 1 }, /committed/],
    ["a conflict", { conflicted: 1 }, /committed/],
    ["a file hidden from status", { hiddenFromStatus: 1 }, /committed/],
  ])("refuses %s", async (_label, overrides, message) => {
    await expect(verifyUnattendedCheckout("/wt", guard, observed(overrides))).rejects.toThrow(
      message
    );
  });

  it("refuses when git can't answer", async () => {
    const read = vi.fn(async () => Promise.reject(new Error("timed out")));
    await expect(verifyUnattendedCheckout("/wt", guard, read)).rejects.toThrow("timed out");
  });
});
