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
    // An auto-incremented suggestion, so its "resolved" hint has to be dropped too.
    mockGetDefaultPath.mockResolvedValue("/worktrees/feature-terrain-2");
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

  // A dialog kept mounted reopens on the previous opening's input for one
  // render, whether that input was a valid name or not.
  it.each(["feature/", "feature/old"])(
    "survives a stale first run on %s before the field shows the restored branch",
    async (stale) => {
      const { result, rerender } = renderRetry(stale);
      rerender({ branchInput: "feature/terrain" });
      await settle();

      expect(result.current.worktreePath).toBe("/custom/terrain");
    }
  );

  it("gives up the path when the restored branch has since been taken", async () => {
    mockGetAvailableBranch.mockImplementation((_root: string, name: string) =>
      Promise.resolve(name === "feature/terrain" ? "feature/terrain-2" : name)
    );
    const { result, rerender } = renderRetry("feature/terrain");
    await settle();

    // The path an ordinary opening would offer beside the auto-incremented name.
    expect(result.current.worktreePath).toBe("/worktrees/feature/terrain");
    let accepted: string | null = null;
    act(() => {
      accepted = result.current.consumeBranchResolution("feature/terrain");
    });
    expect(accepted).toBe("feature/terrain-2");
    rerender({ branchInput: "feature/terrain-2" });
    await settle();
    expect(result.current.worktreePath).toBe("/worktrees/feature/terrain");
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

describe("useBranchValidation — suggested path separators", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetAvailableBranch.mockImplementation((_root: string, name: string) =>
      Promise.resolve(name)
    );
    mockGetDefaultPath.mockResolvedValue("C:/dev/app-worktrees/feature-x");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const render = (rootPath: string, skipAvailabilityCheck = false) =>
    renderHook(() =>
      useBranchValidation({
        branchInput: "feature/x",
        rootPath,
        isOpen: true,
        skipAvailabilityCheck,
      })
    );

  it("offers a Windows project its worktree path with backslashes", async () => {
    const { result } = render("C:\\dev\\app");
    await settle();
    expect(result.current.worktreePath).toBe("C:\\dev\\app-worktrees\\feature-x");
  });

  it("does the same when only the path is generated", async () => {
    const { result } = render("C:\\dev\\app", true);
    await settle();
    expect(result.current.worktreePath).toBe("C:\\dev\\app-worktrees\\feature-x");
  });

  it("leaves a POSIX project's suggestion as main returned it", async () => {
    mockGetDefaultPath.mockResolvedValue("/home/me/app-worktrees/feature-x");
    const { result } = render("/home/me/app");
    await settle();
    expect(result.current.worktreePath).toBe("/home/me/app-worktrees/feature-x");
  });
});

describe("useBranchValidation — a path the user chose", () => {
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

  it("keeps it through later branch edits", async () => {
    const { result, rerender } = renderValidation("feature/terrain");
    await settle();
    expect(result.current.worktreePath).toBe("/worktrees/feature/terrain");

    act(() => result.current.setCustomWorktreePath("/custom/terrain"));
    rerender({ branchInput: "feature/canyon" });
    await settle();

    // The branch is still checked; only the path is left alone.
    expect(mockGetAvailableBranch).toHaveBeenLastCalledWith(ROOT, "feature/canyon");
    expect(result.current.worktreePath).toBe("/custom/terrain");
  });

  it("keeps it through an invalid name, an empty prefix, and an emptied field", async () => {
    const { result, rerender } = renderValidation("feature/terrain");
    await settle();
    act(() => result.current.setCustomWorktreePath("/custom/terrain"));

    for (const branchInput of ["feature/bad..name", "feature/", ""]) {
      rerender({ branchInput });
      await settle();
      expect(result.current.worktreePath).toBe("/custom/terrain");
    }
  });

  it("drops the auto-resolved hint once the user picks a path", async () => {
    mockGetDefaultPath.mockResolvedValue("/worktrees/feature-terrain-2");
    const { result } = renderValidation("feature/terrain");
    await settle();
    expect(result.current.pathWasAutoResolved).toBe(true);

    act(() => result.current.setCustomWorktreePath("/custom/terrain"));
    expect(result.current.pathWasAutoResolved).toBe(false);
  });

  it.each(["", "   "])(
    "follows suggestions again once the user empties the path to %j",
    async (emptied) => {
      const { result, rerender } = renderValidation("feature/terrain");
      await settle();
      act(() => result.current.setCustomWorktreePath("/custom/terrain"));
      act(() => result.current.setCustomWorktreePath(emptied));

      rerender({ branchInput: "feature/canyon" });
      await settle();
      expect(result.current.worktreePath).toBe("/worktrees/feature/canyon");
    }
  );

  it("is forgotten on reopen", async () => {
    const { result, rerender } = renderHook(
      (props: { branchInput: string; isOpen: boolean }) =>
        useBranchValidation({
          branchInput: props.branchInput,
          rootPath: ROOT,
          isOpen: props.isOpen,
        }),
      { initialProps: { branchInput: "feature/terrain", isOpen: true } }
    );
    await settle();
    act(() => result.current.setCustomWorktreePath("/custom/terrain"));

    rerender({ branchInput: "feature/terrain", isOpen: false });
    rerender({ branchInput: "feature/canyon", isOpen: true });
    await settle();
    expect(result.current.worktreePath).toBe("/worktrees/feature/canyon");
  });

  it("outlasts a Retry's restored path, even back on the restored branch", async () => {
    const { result, rerender } = renderHook(
      (props: { branchInput: string }) =>
        useBranchValidation({
          branchInput: props.branchInput,
          rootPath: ROOT,
          isOpen: true,
          restoredBranch: "feature/terrain",
          restoredPath: "/restored/terrain",
        }),
      { initialProps: { branchInput: "feature/terrain" } }
    );
    await settle();
    expect(result.current.worktreePath).toBe("/restored/terrain");

    act(() => result.current.setCustomWorktreePath("/custom/terrain"));
    rerender({ branchInput: "feature/canyon" });
    await settle();
    rerender({ branchInput: "feature/terrain" });
    await settle();
    expect(result.current.worktreePath).toBe("/custom/terrain");
  });

  // A lookup that answers only when the test says so.
  function holdDefaultPath() {
    const pending: { resolve: (path: string) => void; reject: (err: Error) => void }[] = [];
    mockGetDefaultPath.mockImplementation(
      () => new Promise<string>((resolve, reject) => pending.push({ resolve, reject }))
    );
    return pending;
  }

  it.each([
    ["answers", (lookup: { resolve: (path: string) => void }) => lookup.resolve("/worktrees/x")],
    ["fails", (lookup: { reject: (err: Error) => void }) => lookup.reject(new Error("no path"))],
  ])("keeps a path chosen while the lookup is in flight, when the lookup %s", async (_, land) => {
    const pending = holdDefaultPath();
    const { result } = renderValidation("feature/terrain");
    await settle();
    expect(pending).toHaveLength(1);

    act(() => result.current.setCustomWorktreePath("/custom/terrain"));
    await act(async () => {
      land(pending[0]!);
    });
    expect(result.current.isGeneratingPath).toBe(false);
    expect(result.current.worktreePath).toBe("/custom/terrain");
  });

  it("keeps it when the branch name is taken and another is offered", async () => {
    const { result, rerender } = renderValidation("feature/terrain");
    await settle();
    act(() => result.current.setCustomWorktreePath("/custom/terrain"));

    mockGetAvailableBranch.mockResolvedValue("feature/canyon-2");
    rerender({ branchInput: "feature/canyon" });
    await settle();
    expect(result.current.branchWasAutoResolved).toBe(true);
    expect(result.current.worktreePath).toBe("/custom/terrain");
  });

  it("keeps it for an existing branch too", async () => {
    const { result, rerender } = renderHook(
      (props: { overrideBranchName: string }) =>
        useBranchValidation({
          branchInput: "",
          rootPath: ROOT,
          isOpen: true,
          skipAvailabilityCheck: true,
          overrideBranchName: props.overrideBranchName,
        }),
      { initialProps: { overrideBranchName: "existing/one" } }
    );
    await settle();
    act(() => result.current.setCustomWorktreePath("/custom/existing"));

    rerender({ overrideBranchName: "existing/two" });
    await settle();
    expect(mockGetDefaultPath).toHaveBeenLastCalledWith(ROOT, "existing/two");
    expect(result.current.worktreePath).toBe("/custom/existing");
  });

  it("takes the suggestion for a Retry's branch once a path chosen mid-lookup is emptied", async () => {
    const pending = holdDefaultPath();
    const { result } = renderHook(() =>
      useBranchValidation({
        branchInput: "feature/terrain",
        rootPath: ROOT,
        isOpen: true,
        restoredBranch: "feature/terrain",
        restoredPath: "/restored/terrain",
      })
    );
    await settle();
    expect(result.current.worktreePath).toBe("/restored/terrain");

    act(() => result.current.setCustomWorktreePath("/custom/terrain"));
    act(() => result.current.setCustomWorktreePath(""));
    await act(async () => {
      pending[0]!.resolve("/worktrees/feature/terrain");
    });
    // The lookup began while the Retry's path held, but the user has since let it go.
    expect(result.current.worktreePath).toBe("/worktrees/feature/terrain");
  });
});

describe("useBranchValidation — an emptied branch name", () => {
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

  // A suffixed suggestion, so the "resolved" hint is up before the name goes.
  it.each([
    ["is emptied", "  "],
    ["is down to its prefix", "feature/"],
    ["turns invalid", "feature/bad..name"],
  ])("clears the path suggested for the name it replaced when the name %s", async (_, next) => {
    mockGetDefaultPath.mockResolvedValue("/worktrees/feature-terrain-2");
    const { result, rerender } = renderValidation("feature/terrain");
    await settle();
    expect(result.current.worktreePath).toBe("/worktrees/feature-terrain-2");
    expect(result.current.pathWasAutoResolved).toBe(true);
    mockGetAvailableBranch.mockClear();
    mockGetDefaultPath.mockClear();

    rerender({ branchInput: next });
    expect(result.current.worktreePath).toBe("");
    expect(result.current.pathWasAutoResolved).toBe(false);
    await settle();
    expect(mockGetAvailableBranch).not.toHaveBeenCalled();
    expect(mockGetDefaultPath).not.toHaveBeenCalled();
  });

  it("doesn't take a lookup for the old name that lands after it", async () => {
    const { result, rerender } = renderValidation("feature/terrain");
    await settle();
    expect(result.current.worktreePath).toBe("/worktrees/feature/terrain");

    let answer: (path: string) => void = () => {};
    mockGetDefaultPath.mockImplementationOnce(
      () => new Promise<string>((resolve) => (answer = resolve))
    );
    rerender({ branchInput: "feature/canyon" });
    await settle();
    expect(mockGetDefaultPath).toHaveBeenLastCalledWith(ROOT, "feature/canyon");

    rerender({ branchInput: "" });
    expect(result.current.worktreePath).toBe("");
    await act(async () => {
      answer("/worktrees/feature/canyon");
    });
    expect(result.current.worktreePath).toBe("");
  });

  it("clears an existing-branch suggestion when the pick is cleared", async () => {
    const { result, rerender } = renderHook(
      (props: { overrideBranchName: string }) =>
        useBranchValidation({
          branchInput: "",
          rootPath: ROOT,
          isOpen: true,
          skipAvailabilityCheck: true,
          overrideBranchName: props.overrideBranchName,
        }),
      { initialProps: { overrideBranchName: "existing/branch" } }
    );
    await settle();
    expect(result.current.worktreePath).toBe("/worktrees/existing/branch");

    rerender({ overrideBranchName: "" });
    expect(result.current.worktreePath).toBe("");
  });
});
