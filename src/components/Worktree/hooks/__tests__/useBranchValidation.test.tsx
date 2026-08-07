/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const mockGetAvailableBranch = vi.fn();
const mockGetDefaultPath = vi.fn();

vi.mock("@/clients", () => ({
  worktreeClient: {
    getAvailableBranch: (...args: unknown[]) => mockGetAvailableBranch(...args),
    getDefaultPath: (...args: unknown[]) => mockGetDefaultPath(...args),
  },
}));

vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import { useBranchValidation } from "../useBranchValidation";

const ROOT = "/test/root";

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
}

function renderValidation(
  branchInput: string,
  extra: { skipAvailabilityCheck?: boolean; overrideBranchName?: string } = {}
) {
  return renderHook(
    (props: { branchInput: string }) =>
      useBranchValidation({
        branchInput: props.branchInput,
        rootPath: ROOT,
        isOpen: true,
        ...extra,
      }),
    { initialProps: { branchInput } }
  );
}

describe("useBranchValidation — deferred branch resolution", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetAvailableBranch.mockImplementation((_root: string, name: string) =>
      Promise.resolve(name)
    );
    mockGetDefaultPath.mockImplementation((_root: string, branch: string) =>
      Promise.resolve(`/worktrees/${branch}`)
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("offers a divergent name once rather than pushing it back into the field", async () => {
    mockGetAvailableBranch.mockResolvedValue("feature/terrain-2");
    const { result } = renderValidation("feature/terrain");
    await settle();

    expect(result.current.branchWasAutoResolved).toBe(true);
    expect(result.current.consumeBranchResolution("feature/terrain")).toBe("feature/terrain-2");
    expect(result.current.consumeBranchResolution("feature/terrain")).toBeNull();
  });

  it("refuses a resolution the field has already moved past", async () => {
    mockGetAvailableBranch.mockResolvedValue("feature/terrain-2");
    const { result } = renderValidation("feature/terrain");
    await settle();

    expect(result.current.consumeBranchResolution("feature/terrain-shadows")).toBeNull();
  });

  it("matches on the canonical branch name, not the raw input", async () => {
    mockGetAvailableBranch.mockResolvedValue("feature/terrain-2");
    const { result } = renderValidation("feat/terrain");
    await settle();

    expect(mockGetAvailableBranch).toHaveBeenCalledWith(ROOT, "feature/terrain");
    expect(result.current.consumeBranchResolution("  feat/terrain  ")).toBe("feature/terrain-2");
  });

  it("has nothing to offer when the typed name is already available", async () => {
    const { result } = renderValidation("feature/terrain");
    await settle();

    expect(result.current.branchWasAutoResolved).toBe(false);
    expect(result.current.consumeBranchResolution("feature/terrain")).toBeNull();
  });

  it("has nothing to offer when the availability check fails", async () => {
    mockGetAvailableBranch.mockRejectedValue(new Error("git failed"));
    const { result } = renderValidation("feature/terrain");
    await settle();

    expect(result.current.branchWasAutoResolved).toBe(false);
    expect(result.current.consumeBranchResolution("feature/terrain")).toBeNull();
  });

  it("keeps a branch resolution when only the path lookup fails", async () => {
    mockGetAvailableBranch.mockResolvedValue("feature/terrain-2");
    mockGetDefaultPath.mockRejectedValue(new Error("no path"));
    const { result } = renderValidation("feature/terrain");
    await settle();

    expect(result.current.consumeBranchResolution("feature/terrain")).toBe("feature/terrain-2");
  });

  it("discards a pending resolution as soon as the input changes", async () => {
    mockGetAvailableBranch.mockImplementation((_root: string, name: string) =>
      Promise.resolve(name === "feature/terrain" ? "feature/terrain-2" : name)
    );
    const { result, rerender } = renderValidation("feature/terrain");
    await settle();

    rerender({ branchInput: "feature/terrain-shadows" });

    expect(result.current.consumeBranchResolution("feature/terrain")).toBeNull();
  });

  it("does not re-check a name it just handed over", async () => {
    mockGetAvailableBranch.mockImplementation((_root: string, name: string) =>
      Promise.resolve(name === "feature/terrain" ? "feature/terrain-2" : name)
    );
    const { result, rerender } = renderValidation("feature/terrain");
    await settle();

    const settledPath = result.current.worktreePath;
    act(() => {
      result.current.consumeBranchResolution("feature/terrain");
    });
    mockGetAvailableBranch.mockClear();
    mockGetDefaultPath.mockClear();

    rerender({ branchInput: "feature/terrain-2" });

    expect(result.current.isCheckingBranch).toBe(false);
    expect(result.current.isGeneratingPath).toBe(false);
    expect(result.current.worktreePath).toBe(settledPath);
    expect(result.current.branchWasAutoResolved).toBe(true);

    await settle();
    expect(mockGetAvailableBranch).not.toHaveBeenCalled();
    expect(mockGetDefaultPath).not.toHaveBeenCalled();
  });

  it("resumes checking for any name other than the accepted one", async () => {
    mockGetAvailableBranch.mockImplementation((_root: string, name: string) =>
      Promise.resolve(name === "feature/terrain" ? "feature/terrain-2" : name)
    );
    const { result, rerender } = renderValidation("feature/terrain");
    await settle();

    act(() => {
      result.current.consumeBranchResolution("feature/terrain");
    });
    mockGetAvailableBranch.mockClear();

    rerender({ branchInput: "feature/canyon" });
    await settle();

    expect(mockGetAvailableBranch).toHaveBeenCalledWith(ROOT, "feature/canyon");
  });

  it("stays inert while the availability check is skipped", async () => {
    const { result } = renderValidation("feature/terrain", {
      skipAvailabilityCheck: true,
      overrideBranchName: "existing/branch",
    });
    await settle();

    expect(mockGetAvailableBranch).not.toHaveBeenCalled();
    expect(result.current.consumeBranchResolution("feature/terrain")).toBeNull();
  });

  it("drops a cached resolution when the dialog reopens", async () => {
    mockGetAvailableBranch.mockResolvedValue("feature/terrain-2");
    const { result, rerender } = renderHook(
      (props: { isOpen: boolean }) =>
        useBranchValidation({
          branchInput: "feature/terrain",
          rootPath: ROOT,
          isOpen: props.isOpen,
        }),
      { initialProps: { isOpen: true } }
    );
    await settle();
    expect(result.current.branchWasAutoResolved).toBe(true);

    rerender({ isOpen: false });
    rerender({ isOpen: true });

    expect(result.current.consumeBranchResolution("feature/terrain")).toBeNull();
  });
});
