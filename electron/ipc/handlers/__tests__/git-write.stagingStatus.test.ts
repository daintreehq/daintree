import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
  webContents: { fromId: vi.fn(() => null) },
}));

vi.mock("../../../store.js", () => ({
  store: { get: vi.fn().mockReturnValue({ uiFeedbackSoundEnabled: false }) },
}));

vi.mock("../../../services/SoundService.js", () => ({
  soundService: { play: vi.fn() },
}));

vi.mock("../../../services/getSoundService.js", () => ({
  getSoundService: vi.fn().mockResolvedValue({ play: vi.fn() }),
}));

const createHardenedGitMock = vi.hoisted(() => vi.fn());

vi.mock("../../../utils/hardenedGit.js", () => ({
  validateCwd: vi.fn(),
  createHardenedGit: createHardenedGitMock,
  createAuthenticatedGit: vi.fn(),
  buildContinueEnv: vi.fn(() => ({})),
}));

import { registerGitWriteHandlers } from "../git-write.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";
import { CHANNELS } from "../../channels.js";
import type { StagingStatus } from "../../../../shared/types/git.js";

// A path that does not exist, so the filesystem git-dir read defers to the
// fake's rev-parse and no real repository is consulted.
const CWD = "/nonexistent/staging-status-repo";

/** Triangular: tracks origin/release/topic, pushes to fork/topic. */
const COMBINED_RECORD = [
  "refs/heads/topic",
  "fork",
  "refs/remotes/fork/topic",
  "refs/remotes/origin/release/topic",
  "origin",
].join("\u0000");

type FakeGit = Record<string, ReturnType<typeof vi.fn>>;

function makeGit(overrides: FakeGit = {}, current = "topic"): FakeGit {
  return {
    status: vi.fn(async () => ({
      files: [{ path: "a.ts", index: "M", working_dir: " " }],
      conflicted: [],
      current,
      detached: false,
    })),
    revparse: vi.fn(async (args: string[]) => {
      if (args[0] === "--git-dir") return ".git\n";
      if (args[0] === "--show-toplevel") return `${CWD}\n`;
      return "0123456789abcdef0123456789abcdef01234567\n";
    }),
    raw: vi.fn(async (args: string[]) => {
      if (args[0] === "for-each-ref") return `${COMBINED_RECORD}\n`;
      return "";
    }),
    getRemotes: vi.fn(async () => [
      { name: "origin", refs: { fetch: "", push: "" } },
      { name: "fork", refs: { fetch: "", push: "" } },
    ]),
    diff: vi.fn(async () => ""),
    ...overrides,
  };
}

function getStagingStatus(): Promise<StagingStatus> {
  const call = ipcMainMock.handle.mock.calls.find(
    (c: unknown[]) => c[0] === CHANNELS.GIT_GET_STAGING_STATUS
  );
  if (!call) throw new Error("staging status handler not registered");
  return (call[1] as (e: unknown, cwd: string) => Promise<StagingStatus>)({}, CWD);
}

function forEachRefCalls(git: FakeGit): string[][] {
  return git.raw!.mock.calls.map((c) => c[0] as string[]).filter((a) => a[0] === "for-each-ref");
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimitQueuesForTest();
  registerGitWriteHandlers({} as never);
});

describe("git:get-staging-status — push and pull destinations", () => {
  it("resolves both sides from one for-each-ref and one remote listing", async () => {
    const git = makeGit();
    createHardenedGitMock.mockResolvedValue(git);

    const status = await getStagingStatus();

    expect(status.hasRemote).toBe(true);
    expect(status.pushDestination).toEqual({ remote: "fork", branch: "topic" });
    expect(status.pullSource).toEqual({ remote: "origin", branch: "release/topic" });
    expect(forEachRefCalls(git)).toHaveLength(1);
    expect(git.getRemotes).toHaveBeenCalledTimes(1);
  });

  it("degrades both destinations to null when the ref read fails", async () => {
    const git = makeGit({
      raw: vi.fn(async (args: string[]) => {
        if (args[0] === "for-each-ref") throw new Error("fatal: bad ref");
        return "";
      }),
    });
    createHardenedGitMock.mockResolvedValue(git);

    const status = await getStagingStatus();

    expect(status.hasRemote).toBe(true);
    expect(status.pushDestination).toBeNull();
    expect(status.pullSource).toBeNull();
    expect(status.staged.map((e) => e.path)).toEqual(["a.ts"]);
  });

  it("reports no remote and skips the ref read when listing remotes fails", async () => {
    const git = makeGit({ getRemotes: vi.fn(async () => Promise.reject(new Error("boom"))) });
    createHardenedGitMock.mockResolvedValue(git);

    const status = await getStagingStatus();

    expect(status.hasRemote).toBe(false);
    expect(status.pushDestination).toBeNull();
    expect(forEachRefCalls(git)).toHaveLength(0);
  });

  it("skips destination resolution on a detached HEAD", async () => {
    const git = makeGit({}, "HEAD");
    createHardenedGitMock.mockResolvedValue(git);

    const status = await getStagingStatus();

    expect(status.isDetachedHead).toBe(true);
    expect(status.currentBranch).toBeNull();
    expect(status.pushDestination).toBeNull();
    expect(forEachRefCalls(git)).toHaveLength(0);
  });

  it("keeps staging without churn on an unborn branch", async () => {
    const git = makeGit({
      revparse: vi.fn(async (args: string[]) => {
        if (args[0] === "--git-dir") return ".git\n";
        throw new Error("fatal: ambiguous argument 'HEAD'");
      }),
    });
    createHardenedGitMock.mockResolvedValue(git);

    const status = await getStagingStatus();

    expect(status.staged).toEqual([
      { path: "a.ts", status: "modified", insertions: null, deletions: null },
    ]);
    expect(git.diff).not.toHaveBeenCalled();
    expect(status.repoState).toBe("CLEAN");
  });
});
