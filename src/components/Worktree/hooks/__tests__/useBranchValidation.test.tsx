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

    // An offer genuinely exists — the null below is the mismatch talking.
    expect(result.current.branchWasAutoResolved).toBe(true);
    expect(result.current.consumeBranchResolution("feature/terrain-shadows")).toBeNull();
  });

  it("matches on the parsed branch name, keeping the typed alias", async () => {
    mockGetAvailableBranch.mockResolvedValue("feat/terrain-2");
    const { result } = renderValidation("feat/terrain");
    await settle();

    expect(mockGetAvailableBranch).toHaveBeenCalledWith(ROOT, "feat/terrain");
    expect(result.current.consumeBranchResolution("  feat/terrain  ")).toBe("feat/terrain-2");
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
      Promise.resolve(`${name}-2`)
    );
    const { result, rerender } = renderValidation("feature/terrain");
    await settle();

    rerender({ branchInput: "feature/canyon" });
    expect(result.current.consumeBranchResolution("feature/terrain")).toBeNull();

    // The new value's own offer still lands, so the null above is invalidation
    // rather than a consumer that never returns anything.
    await settle();
    expect(result.current.consumeBranchResolution("feature/canyon")).toBe("feature/canyon-2");
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

    // The path still generates, so the hook ran and skipped only the branch check.
    expect(mockGetDefaultPath).toHaveBeenCalledWith(ROOT, "existing/branch");
    expect(mockGetAvailableBranch).not.toHaveBeenCalled();
    expect(result.current.consumeBranchResolution("feature/terrain")).toBeNull();
  });

  it("re-checks on reopen even when the branch and root are unchanged", async () => {
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

    // Reopening clears the path and the cached offer, so it has to ask again —
    // otherwise the dialog reopens with an empty path it can never refill.
    expect(result.current.consumeBranchResolution("feature/terrain")).toBeNull();
    mockGetAvailableBranch.mockClear();
    mockGetDefaultPath.mockClear();

    await settle();
    expect(mockGetAvailableBranch).toHaveBeenCalledWith(ROOT, "feature/terrain");
    expect(result.current.worktreePath).toBe("/worktrees/feature/terrain");
  });
});

describe("useBranchValidation — a Retry's path", () => {
  const RESTORED = { restoredBranch: "feature/terrain", restoredPath: "/custom/terrain" };

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

  function renderRetry(branchInput: string, extra: { skipAvailabilityCheck?: boolean } = {}) {
    return renderHook(
      (props: { branchInput: string; overrideBranchName?: string }) =>
        useBranchValidation({ rootPath: ROOT, isOpen: true, ...RESTORED, ...extra, ...props }),
      { initialProps: { branchInput } as { branchInput: string; overrideBranchName?: string } }
    );
  }

  it("holds the submitted path over the suggestion for its own branch", async () => {
    const { result } = renderRetry("feature/terrain");
    await settle();

    expect(mockGetDefaultPath).toHaveBeenCalledWith(ROOT, "feature/terrain");
    expect(result.current.worktreePath).toBe("/custom/terrain");
    expect(result.current.pathWasAutoResolved).toBe(false);
  });

  it("holds it when the path lookup fails as well", async () => {
    mockGetDefaultPath.mockRejectedValue(new Error("no path"));
    const { result } = renderRetry("feature/terrain");
    await settle();

    expect(result.current.worktreePath).toBe("/custom/terrain");
  });

  it("survives a stale first run before the field shows the restored branch", async () => {
    // A dialog kept mounted reopens on the previous opening's input for one render.
    const { result, rerender } = renderRetry("feature/");
    rerender({ branchInput: "feature/terrain" });
    await settle();

    expect(result.current.worktreePath).toBe("/custom/terrain");
  });

  it("follows a renamed branch, and doesn't come back for the old name", async () => {
    const { result, rerender } = renderRetry("feature/terrain");
    await settle();

    rerender({ branchInput: "feature/canyon" });
    await settle();
    expect(result.current.worktreePath).toBe("/worktrees/feature/canyon");

    rerender({ branchInput: "feature/terrain" });
    await settle();
    expect(result.current.worktreePath).toBe("/worktrees/feature/terrain");
  });

  it("holds an existing-branch Retry's path the same way", async () => {
    // The existing picker names the branch; the new-branch input stays empty.
    const { result, rerender } = renderRetry("", { skipAvailabilityCheck: true });
    rerender({ branchInput: "", overrideBranchName: "feature/terrain" });
    await settle();

    expect(mockGetDefaultPath).toHaveBeenCalledWith(ROOT, "feature/terrain");
    expect(result.current.worktreePath).toBe("/custom/terrain");
  });
});
