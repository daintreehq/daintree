import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RepoState } from "../../../../shared/types/git.js";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

vi.mock("../../../store.js", () => ({
  store: { get: vi.fn().mockReturnValue({ uiFeedbackSoundEnabled: false }) },
}));

vi.mock("../../../services/SoundService.js", () => ({
  soundService: { play: vi.fn() },
}));

vi.mock("../../../services/PreAgentSnapshotService.js", () => ({
  preAgentSnapshotService: {
    getSnapshot: vi.fn(),
    listSnapshots: vi.fn(),
    revertToSnapshot: vi.fn(),
    deleteSnapshot: vi.fn(),
  },
}));

const createHardenedGitMock = vi.hoisted(() => vi.fn());
// Sentinel returned by the mocked buildContinueEnv so the test can assert the
// handler passes its result to .env() rather than raw process.env.
const CONTINUE_ENV_SENTINEL = { __continueEnv: true } as const;
const buildContinueEnvMock = vi.hoisted(() => vi.fn());

vi.mock("../../../utils/hardenedGit.js", () => ({
  validateCwd: vi.fn(),
  createHardenedGit: createHardenedGitMock,
  createAuthenticatedGit: vi.fn(),
  buildContinueEnv: buildContinueEnvMock,
}));

const resolveGitDirMock = vi.hoisted(() => vi.fn());
const detectRepoOperationStateMock = vi.hoisted(() => vi.fn());

vi.mock("../../../services/git/repoOperationState.js", () => ({
  resolveGitDir: resolveGitDirMock,
  detectRepoOperationState: detectRepoOperationStateMock,
}));

import { registerGitWriteHandlers } from "../git-write.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";

type FakeGit = {
  env: ReturnType<typeof vi.fn>;
  merge: ReturnType<typeof vi.fn>;
  rebase: ReturnType<typeof vi.fn>;
  raw: ReturnType<typeof vi.fn>;
};

function makeFakeGit(): FakeGit {
  const git: FakeGit = {
    env: vi.fn(),
    merge: vi.fn().mockResolvedValue(undefined),
    rebase: vi.fn().mockResolvedValue(undefined),
    raw: vi.fn().mockResolvedValue(""),
  };
  // .env() is chainable in simple-git — return the same instance.
  git.env.mockReturnValue(git);
  return git;
}

function getHandler(channel: string) {
  const call = ipcMainMock.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
  if (!call) throw new Error(`Handler for ${channel} not registered`);
  return call[1] as (_e: unknown, ...args: unknown[]) => unknown;
}

const CONTINUE_CHANNEL = "git:continue-repository-operation";

function setup(state: RepoState) {
  const git = makeFakeGit();
  createHardenedGitMock.mockReturnValue(git);
  buildContinueEnvMock.mockReturnValue(CONTINUE_ENV_SENTINEL);
  resolveGitDirMock.mockResolvedValue("/tmp/repo/.git");
  detectRepoOperationStateMock.mockResolvedValue({
    state,
    rebaseStep: null,
    rebaseTotalSteps: null,
    rebaseSequence: null,
  });
  registerGitWriteHandlers({} as Parameters<typeof registerGitWriteHandlers>[0]);
  return { git, handler: getHandler(CONTINUE_CHANNEL) };
}

describe("git:continue-repository-operation handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetRateLimitQueuesForTest();
  });

  it("applies the hardened continue env via a single .env() call", async () => {
    const { git, handler } = setup("REBASING");

    await handler(null, "/tmp/repo");

    expect(buildContinueEnvMock).toHaveBeenCalledTimes(1);
    expect(git.env).toHaveBeenCalledTimes(1);
    expect(git.env).toHaveBeenCalledWith(CONTINUE_ENV_SENTINEL);
  });

  it("does not pass raw process.env to .env() (no editor leak)", async () => {
    const { git, handler } = setup("REBASING");

    await handler(null, "/tmp/repo");

    const envArg = git.env.mock.calls[0][0] as Record<string, unknown>;
    expect(envArg).toBe(CONTINUE_ENV_SENTINEL);
    expect(envArg).not.toBe(process.env);
  });

  it("continues a rebase with --continue (no --no-edit, env suppresses editor)", async () => {
    const { git, handler } = setup("REBASING");

    await handler(null, "/tmp/repo");

    expect(git.rebase).toHaveBeenCalledWith(["--continue"]);
  });

  it("continues a merge with --continue --no-edit", async () => {
    const { git, handler } = setup("MERGING");

    await handler(null, "/tmp/repo");

    expect(git.merge).toHaveBeenCalledWith(["--continue", "--no-edit"]);
  });

  it("continues a cherry-pick with --continue --no-edit", async () => {
    const { git, handler } = setup("CHERRY_PICKING");

    await handler(null, "/tmp/repo");

    expect(git.raw).toHaveBeenCalledWith(["cherry-pick", "--continue", "--no-edit"]);
  });

  it("continues a revert with --continue --no-edit", async () => {
    const { git, handler } = setup("REVERTING");

    await handler(null, "/tmp/repo");

    expect(git.raw).toHaveBeenCalledWith(["revert", "--continue", "--no-edit"]);
  });

  it("throws when no operation is in progress", async () => {
    const { git, handler } = setup("CLEAN");

    await expect(handler(null, "/tmp/repo")).rejects.toThrow(
      /No merge, rebase, cherry-pick, or revert operation is in progress/
    );
    expect(git.rebase).not.toHaveBeenCalled();
    expect(git.merge).not.toHaveBeenCalled();
  });
});
