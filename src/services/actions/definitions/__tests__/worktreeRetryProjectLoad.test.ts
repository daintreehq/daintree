// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const retryProjectLoadMock = vi.fn<() => Promise<void>>();
const setWorktreeLoadErrorMock = vi.fn<(error: string | null) => void>();

let worktreeLoadError: string | null = null;
let currentProject: { id: string } | null = null;
let viewState: { isInitialized: boolean; isLoading: boolean } | null = null;

vi.mock("@/clients", () => ({
  worktreeClient: {
    retryProjectLoad: () => retryProjectLoadMock(),
  },
}));

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStoreOrNull: () => (viewState ? { getState: () => viewState } : null),
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: {
    getState: () => ({
      worktreeLoadError,
      currentProject,
      setWorktreeLoadError: setWorktreeLoadErrorMock,
    }),
  },
}));

const { registerWorktreeServiceActions } = await import("../worktreeServiceActions");

type Registry = Map<string, () => { [k: string]: unknown }>;

function buildRegistry(): Registry {
  const registry: Registry = new Map();
  registerWorktreeServiceActions(registry as never, {} as never);
  return registry;
}

function getAction() {
  const factory = buildRegistry().get("worktree.retryProjectLoad");
  if (!factory) throw new Error("worktree.retryProjectLoad not registered");
  return factory() as {
    danger: string;
    isEnabled: (ctx: unknown) => boolean;
    disabledReason: (ctx: unknown) => string | undefined;
    run: (args: unknown, ctx: unknown) => Promise<void>;
  };
}

describe("worktree.retryProjectLoad (#8400)", () => {
  beforeEach(() => {
    retryProjectLoadMock.mockReset();
    retryProjectLoadMock.mockResolvedValue(undefined);
    setWorktreeLoadErrorMock.mockReset();
    worktreeLoadError = null;
    currentProject = null;
    viewState = null;
  });

  it("is a safe action (no confirm gate)", () => {
    expect(getAction().danger).toBe("safe");
  });

  it("is disabled when there is no worktree load failure", () => {
    worktreeLoadError = null;
    const action = getAction();
    expect(action.isEnabled({})).toBe(false);
    expect(action.disabledReason({})).toBe("No worktree load failure to retry");
  });

  it("is enabled while a worktree load failure is present", () => {
    worktreeLoadError = "Not a git repository";
    const action = getAction();
    expect(action.isEnabled({})).toBe(true);
    expect(action.disabledReason({})).toBeUndefined();
  });

  it("is enabled for an open project whose worktree store settled without a snapshot (#12576)", () => {
    // No error to show, but no port either — the state that used to read as an
    // empty repository. It must be retryable, not a dead end.
    currentProject = { id: "p1" };
    viewState = { isInitialized: false, isLoading: false };
    const action = getAction();
    expect(action.isEnabled({})).toBe(true);
    expect(action.disabledReason({})).toBeUndefined();
  });

  it("stays disabled while the first snapshot is still loading or once one has landed", () => {
    currentProject = { id: "p1" };
    viewState = { isInitialized: false, isLoading: true };
    expect(getAction().isEnabled({})).toBe(false);

    viewState = { isInitialized: true, isLoading: false };
    expect(getAction().isEnabled({})).toBe(false);
  });

  it("stays disabled for an unbound view", () => {
    currentProject = null;
    viewState = { isInitialized: false, isLoading: false };
    expect(getAction().isEnabled({})).toBe(false);
  });

  it("clears the banner after a successful retry", async () => {
    worktreeLoadError = "Not a git repository";
    await getAction().run(undefined, {});
    expect(retryProjectLoadMock).toHaveBeenCalledTimes(1);
    expect(setWorktreeLoadErrorMock).toHaveBeenCalledWith(null);
  });

  it("leaves the banner in place when the retry fails", async () => {
    worktreeLoadError = "Not a git repository";
    retryProjectLoadMock.mockRejectedValue(new Error("still broken"));
    await expect(getAction().run(undefined, {})).rejects.toThrow("still broken");
    expect(setWorktreeLoadErrorMock).not.toHaveBeenCalled();
  });

  it("does not clobber a new error that arrived mid-retry", async () => {
    worktreeLoadError = "Not a git repository";
    let resolveRetry: () => void = () => {};
    retryProjectLoadMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRetry = resolve;
      })
    );

    const runPromise = getAction().run(undefined, {});
    // A concurrent switch surfaces a different failure while the retry is in
    // flight — the success path must not wipe it.
    worktreeLoadError = "A different project failed";
    resolveRetry();
    await runPromise;

    expect(setWorktreeLoadErrorMock).not.toHaveBeenCalled();
  });
});
