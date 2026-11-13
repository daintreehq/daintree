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

  describe("with the path left to the host", () => {
    const existingInput = {
      ...baseInput,
      branchMode: "existing" as const,
      branchInput: "",
      selectedExistingBranch: "develop",
    };

    it.each([
      ["new", baseInput],
      ["existing", existingInput],
    ])("accepts an empty path in %s mode", (_mode, input) => {
      const { result } = renderHook(() => useWorktreeFormValidation());

      for (const worktreePath of ["", "   "]) {
        expect(result.current.validate({ ...input, worktreePath, requirePath: false }).valid).toBe(
          true
        );
      }
    });

    it("still names the branch it will create", () => {
      const { result } = renderHook(() => useWorktreeFormValidation());

      const validation = result.current.validate({
        ...baseInput,
        worktreePath: "",
        requirePath: false,
      });
      expect(validation.fullBranchName).toBe("feature/my-feature");
    });

    it.each([
      ["no branch name", { branchInput: "" }, "new-branch"],
      ["an empty slug", { branchInput: "feature/" }, "new-branch"],
      ["an invalid name", { branchInput: "bad:prefix/my-feature" }, "new-branch"],
      ["no base branch", { baseBranch: "" }, "base-branch"],
      [
        "no existing pick",
        { branchMode: "existing" as const, selectedExistingBranch: null },
        "existing-branch",
      ],
    ])("still rejects %s", (_case, overrides, field) => {
      const { result } = renderHook(() => useWorktreeFormValidation());

      const validation = result.current.validate({
        ...baseInput,
        ...overrides,
        worktreePath: "",
        requirePath: false,
      });
      expect(validation.valid).toBe(false);
      expect(validation.error?.field).toBe(field);
    });
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
