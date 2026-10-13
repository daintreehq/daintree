/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useWorktreeFormValidation } from "../useWorktreeFormValidation";

describe("useWorktreeFormValidation", () => {
  const baseInput = {
    branchMode: "new" as const,
    baseBranch: "develop",
    branchInput: "feature/my-feature",
    selectedExistingBranch: null,
    worktreePath: "/path/to/worktree",
  };

  it("returns valid for good new-branch input", () => {
    const { result } = renderHook(() => useWorktreeFormValidation());

    const validation = result.current.validate(baseInput);
    expect(validation.valid).toBe(true);
    expect(validation.fullBranchName).toBe("feature/my-feature");
  });

  it("validates existing mode", () => {
    const { result } = renderHook(() => useWorktreeFormValidation());

    const validation = result.current.validate({
      ...baseInput,
      branchMode: "existing",
      branchInput: "",
      selectedExistingBranch: "develop",
      baseBranch: "",
    });
    expect(validation.valid).toBe(true);
  });

  it("rejects existing mode without selected branch", () => {
    const { result } = renderHook(() => useWorktreeFormValidation());

    const validation = result.current.validate({
      ...baseInput,
      branchMode: "existing",
      selectedExistingBranch: null,
    });
    expect(validation.valid).toBe(false);
    expect(validation.error?.message).toBe("Please select a branch");
  });

  it("rejects existing mode without worktree path", () => {
    const { result } = renderHook(() => useWorktreeFormValidation());

    const validation = result.current.validate({
      ...baseInput,
      branchMode: "existing",
      selectedExistingBranch: "develop",
      worktreePath: "",
    });
    expect(validation.valid).toBe(false);
    expect(validation.error?.message).toContain("worktree path");
    expect(validation.error?.field).toBe("worktree-path");
  });

  it("rejects missing base branch in new mode", () => {
    const { result } = renderHook(() => useWorktreeFormValidation());

    const validation = result.current.validate({
      ...baseInput,
      baseBranch: "",
    });
    expect(validation.valid).toBe(false);
    expect(validation.error?.message).toContain("base branch");
    expect(validation.error?.field).toBe("base-branch");
  });

  it("rejects empty branch input in new mode", () => {
    const { result } = renderHook(() => useWorktreeFormValidation());

    const validation = result.current.validate({
      ...baseInput,
      branchInput: "",
    });
    expect(validation.valid).toBe(false);
    expect(validation.error?.message).toContain("branch name");
    expect(validation.error?.field).toBe("new-branch");
  });

  it("rejects prefixed branch with empty slug", () => {
    const { result } = renderHook(() => useWorktreeFormValidation());

    const validation = result.current.validate({
      ...baseInput,
      branchInput: "feature/",
    });
    expect(validation.valid).toBe(false);
    expect(validation.error?.message).toContain("after the prefix");
  });

  it("rejects invalid prefix characters", () => {
    // #7033: error messages now come from the shared validateBranchName and
    // identify the specific forbidden character (":" here) rather than the
    // generic "invalid characters" copy.
    const { result } = renderHook(() => useWorktreeFormValidation());

    const validation = result.current.validate({
      ...baseInput,
      branchInput: "bad:prefix/my-feature",
    });
    expect(validation.valid).toBe(false);
    expect(validation.error?.field).toBe("new-branch");
    expect(validation.error?.message).toMatch(/':'|invalid character/i);
  });

  it("rejects missing worktree path", () => {
    const { result } = renderHook(() => useWorktreeFormValidation());

    const validation = result.current.validate({
      ...baseInput,
      worktreePath: "",
    });
    expect(validation.valid).toBe(false);
    expect(validation.error?.message).toContain("worktree path");
    expect(validation.error?.field).toBe("worktree-path");
  });

  it("returns fullBranchName for unprefixed input", () => {
    const { result } = renderHook(() => useWorktreeFormValidation());

    const validation = result.current.validate({
      ...baseInput,
      branchInput: "simple-branch",
    });
    expect(validation.valid).toBe(true);
    expect(validation.fullBranchName).toBe("simple-branch");
  });
});
