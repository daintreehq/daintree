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
