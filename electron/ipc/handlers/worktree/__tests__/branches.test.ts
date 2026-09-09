import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

vi.mock("../../../utils.js", () => {
  const typedHandle = (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  };
  return {
    checkRateLimit: vi.fn(),
    waitForRateLimitSlot: vi.fn().mockResolvedValue(undefined),
    waitForBurstRateLimitSlot: vi.fn().mockResolvedValue(undefined),
    typedHandle,
    typedHandleWithContext: typedHandle,
    typedHandleValidated: typedHandle,
    typedHandleWithContextValidated: typedHandle,
  };
});

const resolveForgeRemoteNameForCwdMock = vi.hoisted(() =>
  vi.fn<(cwd: string) => Promise<string | null>>(async () => "origin")
);
const resolvePRHeadRefspecForCwdMock = vi.hoisted(() =>
  vi.fn<(cwd: string, prNumber: number, headRefName: string) => Promise<string | null | undefined>>(
    async () => undefined
  )
);

vi.mock("../../forgeResolution.js", () => ({
  resolveForgeRemoteNameForCwd: resolveForgeRemoteNameForCwdMock,
  resolvePRHeadRefspecForCwd: resolvePRHeadRefspecForCwdMock,
}));

vi.mock("../../../../services/GitServiceCache.js", () => ({
  gitServiceCache: { getGitService: vi.fn() },
}));

vi.mock("../../../../utils/worktreePattern.js", () => ({
  resolveWorktreePattern: vi.fn().mockResolvedValue("../wt/{branch}"),
}));

vi.mock("../../../../../shared/utils/pathPattern.js", () => ({
  generateWorktreePath: vi.fn(),
  validatePathPattern: vi.fn(() => ({ valid: true })),
}));

import { registerWorktreeBranchHandlers } from "../branches.js";
import { CHANNELS } from "../../../channels.js";
import type { HandlerDependencies } from "../../../types.js";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const PAYLOAD = { rootPath: "/repo", prNumber: 42, headRefName: "feature/my-branch" };
const GITLAB_REFSPEC = "refs/merge-requests/42/head:feature/my-branch";

describe("handleWorktreeFetchPRBranch", () => {
  let cleanup: () => void;
  let fetchPRBranch: ReturnType<typeof vi.fn>;

  function invoke(payload: unknown = PAYLOAD): Promise<unknown> {
    const handler = ipcHandlers.get(CHANNELS.WORKTREE_FETCH_PR_BRANCH) as Handler | undefined;
    if (!handler) throw new Error("fetchPRBranch handler not registered");
    return handler(null, payload);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    ipcHandlers.clear();
    resolveForgeRemoteNameForCwdMock.mockResolvedValue("origin");
    resolvePRHeadRefspecForCwdMock.mockResolvedValue(undefined);
    fetchPRBranch = vi.fn().mockResolvedValue(undefined);
    cleanup = registerWorktreeBranchHandlers({
      worktreeService: { fetchPRBranch },
    } as unknown as HandlerDependencies);
  });

  afterEach(() => {
    cleanup?.();
  });

  it("threads the resolved remote and refspec to the workspace host", async () => {
    resolveForgeRemoteNameForCwdMock.mockResolvedValue("upstream");
    resolvePRHeadRefspecForCwdMock.mockResolvedValue(GITLAB_REFSPEC);

    await invoke();

    expect(resolvePRHeadRefspecForCwdMock).toHaveBeenCalledWith("/repo", 42, "feature/my-branch");
    expect(fetchPRBranch).toHaveBeenCalledWith(
      "/repo",
      42,
      "feature/my-branch",
      "upstream",
      GITLAB_REFSPEC
    );
  });

  it("passes undefined through so the host applies its GitHub-shaped default", async () => {
    resolveForgeRemoteNameForCwdMock.mockResolvedValue("upstream");

    await invoke();

    expect(fetchPRBranch).toHaveBeenCalledWith(
      "/repo",
      42,
      "feature/my-branch",
      "upstream",
      undefined
    );
  });

  it("maps a null remote to undefined, leaving the host's origin default", async () => {
    resolveForgeRemoteNameForCwdMock.mockResolvedValue(null);

    await invoke();

    expect(fetchPRBranch).toHaveBeenCalledWith(
      "/repo",
      42,
      "feature/my-branch",
      undefined,
      undefined
    );
  });

  it("refuses to fetch when the forge publishes no PR-head ref", async () => {
    // `null` is the provider saying so positively; the GitHub default would
    // fail with an unrelated "couldn't find remote ref".
    resolvePRHeadRefspecForCwdMock.mockResolvedValue(null);

    // The PR number and branch are the actionable parts — this message is all
    // the caller gets, since no fetch will run to produce a git error.
    await expect(invoke()).rejects.toThrow(/doesn't publish a fetchable ref/);
    await expect(invoke()).rejects.toThrow(/pull request #42/);
    await expect(invoke()).rejects.toThrow(/"feature\/my-branch"/);
    expect(fetchPRBranch).not.toHaveBeenCalled();
  });

  it("propagates a stale-remote failure without resolving a refspec", async () => {
    // Ordering is load-bearing: the refspec resolver swallows every failure
    // into the GitHub default, so it must never run before this one.
    resolveForgeRemoteNameForCwdMock.mockRejectedValue(
      new Error('This project is set to use the "gone" remote, which isn\'t available.')
    );

    await expect(invoke()).rejects.toThrow(/"gone" remote/);
    expect(resolvePRHeadRefspecForCwdMock).not.toHaveBeenCalled();
    expect(fetchPRBranch).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing rootPath", { ...PAYLOAD, rootPath: "" }, /rootPath is required/],
    ["a zero prNumber", { ...PAYLOAD, prNumber: 0 }, /prNumber must be a positive number/],
    ["a missing headRefName", { ...PAYLOAD, headRefName: "" }, /headRefName is required/],
  ])("rejects %s before any forge resolution", async (_label, payload, matcher) => {
    await expect(invoke(payload)).rejects.toThrow(matcher);
    expect(resolveForgeRemoteNameForCwdMock).not.toHaveBeenCalled();
    expect(resolvePRHeadRefspecForCwdMock).not.toHaveBeenCalled();
    expect(fetchPRBranch).not.toHaveBeenCalled();
  });
});
