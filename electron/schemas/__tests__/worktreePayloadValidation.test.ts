import { describe, it, expect } from "vitest";
import { WorktreeCreatePayloadSchema, WorktreeSetActivePayloadSchema } from "../ipc.js";

const validOptions = {
  baseBranch: "main",
  newBranch: "feature/test",
  path: "/repo-worktrees/feature-test",
};

describe("WorktreeCreatePayloadSchema", () => {
  it("accepts a well-formed payload", () => {
    const result = WorktreeCreatePayloadSchema.safeParse({
      rootPath: "/home/user/repo",
      options: validOptions,
    });
    expect(result.success).toBe(true);
  });

  it("accepts the optional fromRemote flag", () => {
    const result = WorktreeCreatePayloadSchema.safeParse({
      rootPath: "/home/user/repo",
      options: { ...validOptions, fromRemote: true },
    });
    expect(result.success).toBe(true);
  });

  it("preserves all optional CreateWorktreeOptions fields (no silent stripping)", () => {
    // Regression guard: a plain z.object() strips undeclared fields, which
    // would break PR-dropdown, remote-mode, and branch-reuse creation paths.
    const fullOptions = {
      ...validOptions,
      fromRemote: true,
      useExistingBranch: true,
      provisionResource: true,
      worktreeMode: "remote",
      sourcePrNumber: 42,
      sourcePrTitle: "Add feature",
      sourcePrUrl: "https://github.com/o/r/pull/42",
      sourcePrState: "open" as const,
      sourcePrLinkedIssueNumber: 7,
      submoduleInit: "all" as const,
      collisionPolicy: "error" as const,
    };
    const result = WorktreeCreatePayloadSchema.safeParse({
      rootPath: "/home/user/repo",
      options: fullOptions,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.options).toEqual(fullOptions);
    }
  });

  // `submoduleInit` was in `CreateWorktreeOptions` but not in this schema, so a
  // caller asking for `all` or `none` had the field stripped here and the host
  // silently fell back to `inherit` — leaving a worktree of a submodule repo
  // born unbuildable, which is the exact failure the option exists to prevent.
  // The "no silent stripping" test above did not catch it because it enumerated
  // the same fields the schema did.
  it("carries submoduleInit through rather than stripping it", () => {
    const result = WorktreeCreatePayloadSchema.safeParse({
      rootPath: "/home/user/repo",
      options: { ...validOptions, submoduleInit: "none" },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.options.submoduleInit).toBe("none");
  });

  it("carries collisionPolicy through, since only the host can enforce it", () => {
    // A renderer-side branch check reserves nothing, so the policy is worthless
    // unless it reaches WorkspaceService, where collision detection rides the
    // atomic `git worktree add` failure.
    const result = WorktreeCreatePayloadSchema.safeParse({
      rootPath: "/home/user/repo",
      options: { ...validOptions, collisionPolicy: "error" },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.options.collisionPolicy).toBe("error");
  });

  it("rejects a submoduleInit policy outside the declared union", () => {
    const result = WorktreeCreatePayloadSchema.safeParse({
      rootPath: "/home/user/repo",
      options: { ...validOptions, submoduleInit: "recursive" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a null byte in rootPath", () => {
    const result = WorktreeCreatePayloadSchema.safeParse({
      rootPath: "/home/user/repo\x00",
      options: validOptions,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a null byte in options.path", () => {
    const result = WorktreeCreatePayloadSchema.safeParse({
      rootPath: "/home/user/repo",
      options: { ...validOptions, path: "/repo-worktrees/feature\x00" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty rootPath", () => {
    const result = WorktreeCreatePayloadSchema.safeParse({
      rootPath: "",
      options: validOptions,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty options.path", () => {
    const result = WorktreeCreatePayloadSchema.safeParse({
      rootPath: "/home/user/repo",
      options: { ...validOptions, path: "" },
    });
    expect(result.success).toBe(false);
  });

  it("does not false-positive on a '..' substring (containment is service-level)", () => {
    // Path traversal is enforced by assertWorktreePathContained at the service
    // layer, not the schema. A legitimate path containing '..' as part of a
    // segment name must still parse. #4702.
    const result = WorktreeCreatePayloadSchema.safeParse({
      rootPath: "/home/user/repo",
      options: { ...validOptions, path: "/home/user/repo..worktrees/feature" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a path that exceeds the length cap", () => {
    const result = WorktreeCreatePayloadSchema.safeParse({
      rootPath: "/home/user/repo",
      options: { ...validOptions, path: `/${"a".repeat(4097)}` },
    });
    expect(result.success).toBe(false);
  });
});

describe("WorktreeSetActivePayloadSchema", () => {
  it("accepts a valid worktreeId", () => {
    const result = WorktreeSetActivePayloadSchema.safeParse({ worktreeId: "wt-123" });
    expect(result.success).toBe(true);
  });

  it("rejects an empty worktreeId", () => {
    const result = WorktreeSetActivePayloadSchema.safeParse({ worktreeId: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing worktreeId", () => {
    const result = WorktreeSetActivePayloadSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
