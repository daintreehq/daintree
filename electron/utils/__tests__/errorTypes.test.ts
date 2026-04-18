import { describe, it, expect } from "vitest";
import {
  GitError,
  GitOperationError,
  WorktreeRemovedError,
  DaintreeError,
  toGitOperationError,
} from "../errorTypes.js";

describe("GitOperationError", () => {
  it("preserves the GitError -> DaintreeError -> Error hierarchy", () => {
    const err = new GitOperationError("auth-failed", "boom", { cwd: "/repo", op: "push" });
    expect(err).toBeInstanceOf(GitOperationError);
    expect(err).toBeInstanceOf(GitError);
    expect(err).toBeInstanceOf(DaintreeError);
    expect(err).toBeInstanceOf(Error);
  });

  it("still allows existing WorktreeRemovedError instanceof checks to hold", () => {
    const wt = new WorktreeRemovedError("/missing");
    expect(wt).toBeInstanceOf(GitError);
    expect(wt).toBeInstanceOf(WorktreeRemovedError);
    // WorktreeRemovedError must NOT be conflated with the new taxonomy
    expect(wt).not.toBeInstanceOf(GitOperationError);
  });

  it("stamps reason/op/cwd into context and dedicated fields", () => {
    const err = new GitOperationError("conflict-unresolved", "merge conflict", {
      cwd: "/w",
      op: "merge",
    });
    expect(err.reason).toBe("conflict-unresolved");
    expect(err.op).toBe("merge");
    expect(err.context).toEqual(
      expect.objectContaining({
        cwd: "/w",
        op: "merge",
        reason: "conflict-unresolved",
      })
    );
  });

  it("defaults rawMessage to the visible message when unset", () => {
    const err = new GitOperationError("unknown", "hi");
    expect(err.rawMessage).toBe("hi");
  });
});

describe("toGitOperationError", () => {
  it("wraps a plain Error and classifies its reason", () => {
    const original = new Error("fatal: not a git repository");
    const wrapped = toGitOperationError(original, { cwd: "/x", op: "status" });
    expect(wrapped).toBeInstanceOf(GitOperationError);
    expect(wrapped.reason).toBe("not-a-repository");
    expect(wrapped.op).toBe("status");
    expect(wrapped.cause).toBe(original);
  });

  it("is idempotent — returns the same instance when given a GitOperationError", () => {
    const existing = new GitOperationError("auth-failed", "whoops", { op: "push" });
    const result = toGitOperationError(existing, { cwd: "/y", op: "clone" });
    expect(result).toBe(existing);
    // Never rewrites the original's op/cwd/reason
    expect(result.reason).toBe("auth-failed");
    expect(result.op).toBe("push");
  });

  it("coerces non-Error throwables without losing classification", () => {
    const wrapped = toGitOperationError("fatal: unable to read config file '/etc/gitconfig'");
    expect(wrapped).toBeInstanceOf(GitOperationError);
    expect(wrapped.reason).toBe("config-missing");
  });
});
