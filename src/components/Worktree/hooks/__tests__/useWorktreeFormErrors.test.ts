/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWorktreeFormErrors } from "../useWorktreeFormErrors";

describe("useWorktreeFormErrors", () => {
  it("setCreationError sets creation error and clears validation", () => {
    const { result } = renderHook(() => useWorktreeFormErrors());

    act(() => {
      result.current.setValidationError("before", "new-branch");
    });
    act(() => {
      result.current.setCreationError({
        friendly: "Creation failed",
        raw: "Error: Creation failed",
        recovery: undefined,
      });
    });

    expect(result.current.errors.validationError).toBeNull();
    expect(result.current.errors.errorField).toBeNull();
    expect(result.current.errors.creationError?.friendly).toBe("Creation failed");
  });

  it("resetErrors returns to initial state", () => {
    const { result } = renderHook(() => useWorktreeFormErrors());

    act(() => {
      result.current.setValidationError("err", "base-branch");
      result.current.markTouched("branchInput");
      result.current.markTouched("worktreePath");
    });
    act(() => {
      result.current.resetErrors();
    });

    expect(result.current.errors.validationError).toBeNull();
    expect(result.current.errors.errorField).toBeNull();
    expect(result.current.errors.touchedFields.branchInput).toBe(false);
    expect(result.current.errors.touchedFields.worktreePath).toBe(false);
  });

  it("isFormDirty returns true when any field is touched", () => {
    const { result } = renderHook(() => useWorktreeFormErrors());

    expect(result.current.isFormDirty()).toBe(false);

    act(() => {
      result.current.markTouched("recipe");
    });

    expect(result.current.isFormDirty()).toBe(true);
  });
});
