import { describe, expect, it } from "vitest";
import { ClientGitError, isClientGitError } from "../clientGitError";

describe("isClientGitError", () => {
  it("decodes prefix-encoded errors and restores name/gitReason/message", () => {
    const err = new Error("[GitError|push-rejected-outdated|deadbeef|main] rejected");
    expect(isClientGitError(err)).toBe(true);
    expect(err.name).toBe("GitOperationError");
    expect((err as Error & { gitReason: string }).gitReason).toBe("push-rejected-outdated");
    expect((err as Error & { leaseSha?: string }).leaseSha).toBe("deadbeef");
    expect((err as Error & { branchName?: string }).branchName).toBe("main");
    expect(err.message).toBe("rejected");
  });

  it("decodes branch names containing slashes (urlencoded as %2F)", () => {
    const err = new Error("[GitError|push-rejected-outdated|abc123|feature%2Fmy-branch] rejection");
    expect(isClientGitError(err)).toBe(true);
    expect((err as Error & { branchName?: string }).branchName).toBe("feature/my-branch");
    expect(err.message).toBe("rejection");
  });

  it("decodes branch names containing pipes and brackets (urlencoded)", () => {
    const branch = "weird|name]with[chars";
    const encoded = encodeURIComponent(branch);
    const err = new Error(`[GitError|auth-failed||${encoded}] auth error`);
    expect(isClientGitError(err)).toBe(true);
    expect((err as Error & { branchName?: string }).branchName).toBe(branch);
    expect(err.message).toBe("auth error");
  });

  it("treats empty leaseSha / branchName slots as undefined", () => {
    const err = new Error("[GitError|auth-failed||] auth refused");
    expect(isClientGitError(err)).toBe(true);
    expect((err as Error & { gitReason: string }).gitReason).toBe("auth-failed");
    expect((err as Error & { leaseSha?: string }).leaseSha).toBeUndefined();
    expect((err as Error & { branchName?: string }).branchName).toBeUndefined();
    expect(err.message).toBe("auth refused");
  });

  it("treats only one optional slot present", () => {
    const err = new Error("[GitError|push-rejected-outdated|sha123|] no branch");
    expect(isClientGitError(err)).toBe(true);
    expect((err as Error & { leaseSha?: string }).leaseSha).toBe("sha123");
    expect((err as Error & { branchName?: string }).branchName).toBeUndefined();
  });

  it("decodes multi-line messages (regex /s flag)", () => {
    const err = new Error("[GitError|hook-rejected||] line one\nline two");
    expect(isClientGitError(err)).toBe(true);
    expect(err.message).toBe("line one\nline two");
  });

  it("returns false for a plain Error without the prefix", () => {
    const err = new Error("nothing to see here");
    expect(isClientGitError(err)).toBe(false);
    expect(err.message).toBe("nothing to see here");
  });

  it("returns false for non-Error values", () => {
    expect(isClientGitError(null)).toBe(false);
    expect(isClientGitError(undefined)).toBe(false);
    expect(isClientGitError("string error")).toBe(false);
    expect(isClientGitError({ message: "fake" })).toBe(false);
  });

  it("returns false for a malformed prefix (uppercase reason)", () => {
    const err = new Error("[GitError|PUSH_REJECTED||] something");
    expect(isClientGitError(err)).toBe(false);
    expect(err.message).toBe("[GitError|PUSH_REJECTED||] something");
  });

  it("returns false for a reason containing underscores or digits (regex boundary)", () => {
    const errUnderscore = new Error("[GitError|push_rejected||] msg");
    expect(isClientGitError(errUnderscore)).toBe(false);
    const errDigits = new Error("[GitError|reason42||] msg");
    expect(isClientGitError(errDigits)).toBe(false);
  });

  it("recognises a same-realm ClientGitError without a prefix", () => {
    const err = new ClientGitError("auth-failed", "fell over", undefined, undefined);
    expect(isClientGitError(err)).toBe(true);
    expect(err.gitReason).toBe("auth-failed");
    expect(err.message).toBe("fell over");
  });

  it("recognises a duck-typed same-realm error (name + gitReason)", () => {
    const err = Object.assign(new Error("fell over"), {
      name: "GitOperationError",
      gitReason: "auth-failed",
    });
    expect(isClientGitError(err)).toBe(true);
  });

  it("is idempotent — second call uses the same-realm fallback after the prefix is stripped", () => {
    const err = new Error("[GitError|auth-failed|sha|branch] original");
    expect(isClientGitError(err)).toBe(true);
    expect(err.message).toBe("original");
    // Second call no longer sees the prefix but the side-effects make the
    // same-realm fallback succeed.
    expect(isClientGitError(err)).toBe(true);
    expect(err.message).toBe("original");
    expect((err as Error & { gitReason: string }).gitReason).toBe("auth-failed");
  });

  it("tolerates malformed percent-encoding without throwing", () => {
    const err = new Error("[GitError|auth-failed|%GG|main] msg");
    expect(() => isClientGitError(err)).not.toThrow();
    expect(isClientGitError(err)).toBe(true);
    // Falls back to the raw encoded string when decodeURIComponent throws.
    expect((err as Error & { leaseSha?: string }).leaseSha).toBe("%GG");
  });
});
