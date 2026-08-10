import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

// `git:push` registers via `typedHandleWithContext`, so `buildIpcContext` runs
// and reaches BrowserWindow through the webContents registry — a bare `ipcMain`
// mock leaves it undefined and every context-taking handler throws.
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
const createAuthenticatedGitMock = vi.hoisted(() => vi.fn());

vi.mock("../../../utils/hardenedGit.js", () => ({
  validateCwd: vi.fn(),
  createHardenedGit: createHardenedGitMock,
  createAuthenticatedGit: createAuthenticatedGitMock,
  buildContinueEnv: vi.fn(() => ({})),
}));

import { registerGitWriteHandlers } from "../git-write.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";

const CWD = "/repo";
const LOCAL_BRANCH = "topic";
const LEASE = "deadbeef";

/**
 * The complex destination from the #11746 permutation table: a remote whose own
 * name carries a slash, and a remote-side branch that differs from the local
 * name. Every argv assertion below uses it so a regression that silently falls
 * back to `origin`, or that reuses the local branch name on the remote side,
 * fails loudly rather than passing by coincidence.
 */
const REMOTE = "team/fork";
const REMOTE_BRANCH = "release/topic";
const PUSH_REF = `refs/remotes/${REMOTE}/${REMOTE_BRANCH}`;

type FakeGit = Record<string, ReturnType<typeof vi.fn>>;

/** A git double whose `for-each-ref` reports the given push destination. */
/** Upstream is a DIFFERENT remote from the push target, so pull-rebase
 *  reading the push destination instead of the upstream would show up as a
 *  failed assertion rather than passing by coincidence. */
const UPSTREAM_REMOTE = "origin";
const UPSTREAM_BRANCH = "release/topic";
const UPSTREAM_REF = `refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`;

function makeGit(
  overrides: FakeGit = {},
  forEachRef = `refs/heads/${LOCAL_BRANCH}\u0000${REMOTE}\u0000${PUSH_REF}`,
  forEachRefUpstream = `refs/heads/${LOCAL_BRANCH}\u0000${UPSTREAM_REMOTE}\u0000${UPSTREAM_REF}`
): FakeGit {
  return {
    revparse: vi.fn(async (args: string[]) => {
      if (args[0] === "--abbrev-ref" && args[1] === "HEAD") return `${LOCAL_BRANCH}\n`;
      return "aaaaaaaabbbbbbbbccccccccdddddddd\n";
    }),
    raw: vi.fn(async (args: string[]) => {
      if (args[0] === "for-each-ref") {
        const format = args[1] ?? "";
        return `${format.includes("upstream") ? forEachRefUpstream : forEachRef}\n`;
      }
      if (args[0] === "rev-list") return "7\n";
      return "";
    }),
    getRemotes: vi.fn(async () => [
      { name: "origin", refs: { fetch: "", push: "" } },
      { name: REMOTE, refs: { fetch: "", push: "" } },
    ]),
    push: vi.fn(async () => undefined),
    pull: vi.fn(async () => undefined),
    log: vi.fn(async () => ({ all: [] })),
    ...overrides,
  };
}

function getHandler(channel: string) {
  const call = ipcMainMock.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
  if (!call) throw new Error(`Handler for ${channel} not registered`);
  return call[1] as (_e: unknown, ...args: unknown[]) => Promise<unknown>;
}

/** The push handler takes an IpcContext, so it needs a sender-shaped first arg. */
const FAKE_EVENT = { sender: { id: 1 } };

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimitQueuesForTest();
  registerGitWriteHandlers({} as never);
});

describe("git push — resolved destination", () => {
  it("sets upstream to the resolved remote with an explicit local:remote refspec", async () => {
    const git = makeGit();
    createAuthenticatedGitMock.mockResolvedValue(git);

    await getHandler("git:push")(FAKE_EVENT, { cwd: CWD, setUpstream: true });

    expect(git.push).toHaveBeenCalledWith([
      "--set-upstream",
      REMOTE,
      `${LOCAL_BRANCH}:${REMOTE_BRANCH}`,
    ]);
    expect(git.push).not.toHaveBeenCalledWith(
      expect.arrayContaining(["origin"]) as unknown as string[]
    );
  });

  it("leaves the plain push a zero-argument call so git's own tracking config wins", async () => {
    const git = makeGit();
    createAuthenticatedGitMock.mockResolvedValue(git);

    await getHandler("git:push")(FAKE_EVENT, { cwd: CWD });

    expect(git.push).toHaveBeenCalledWith();
  });

  it("re-pushes with the resolved remote when the plain push reports no upstream", async () => {
    let attempt = 0;
    const push = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("fatal: The current branch topic has no upstream branch");
      return undefined;
    });
    createAuthenticatedGitMock.mockResolvedValue(makeGit({ push }));

    await getHandler("git:push")(FAKE_EVENT, { cwd: CWD });

    expect(push).toHaveBeenNthCalledWith(1);
    expect(push).toHaveBeenNthCalledWith(2, [
      "--set-upstream",
      REMOTE,
      `${LOCAL_BRANCH}:${REMOTE_BRANCH}`,
    ]);
  });

  it("propagates a non-upstream push failure without retrying", async () => {
    const push = vi.fn(async () => {
      throw new Error("fatal: Authentication failed");
    });
    createAuthenticatedGitMock.mockResolvedValue(makeGit({ push }));

    await expect(getHandler("git:push")(FAKE_EVENT, { cwd: CWD })).rejects.toThrow();
    expect(push).toHaveBeenCalledTimes(1);
  });
});

describe("git push — lease capture", () => {
  it("reads the lease SHA from the destination's own tracking ref", async () => {
    const revparse = vi.fn(async (args: string[]) => {
      if (args[0] === "--abbrev-ref" && args[1] === "HEAD") return `${LOCAL_BRANCH}\n`;
      return "abc123\n";
    });
    const push = vi.fn(async () => {
      throw new Error("! [rejected] topic -> topic (non-fast-forward)");
    });
    createAuthenticatedGitMock.mockResolvedValue(makeGit({ revparse, push }));

    await expect(getHandler("git:push")(FAKE_EVENT, { cwd: CWD })).rejects.toThrow();

    expect(revparse).toHaveBeenCalledWith([PUSH_REF]);
    expect(revparse).not.toHaveBeenCalledWith([`refs/remotes/origin/${LOCAL_BRANCH}`]);
  });
});

describe("git pull --rebase — resolved destination", () => {
  it("pulls from the branch upstream, not from its push target", async () => {
    const git = makeGit();
    createAuthenticatedGitMock.mockResolvedValue(git);

    await getHandler("git:pull-rebase")(FAKE_EVENT, { cwd: CWD });

    expect(git.pull).toHaveBeenCalledWith(UPSTREAM_REMOTE, UPSTREAM_BRANCH, ["--rebase"]);
    expect(git.pull).not.toHaveBeenCalledWith(REMOTE, REMOTE_BRANCH, ["--rebase"]);
  });
});

describe("git force-push-with-lease — resolved destination", () => {
  it("leases against the remote-side branch name, not the local one", async () => {
    const git = makeGit();
    createAuthenticatedGitMock.mockResolvedValue(git);

    await getHandler("git:force-push-with-lease")(FAKE_EVENT, {
      cwd: CWD,
      branchName: LOCAL_BRANCH,
      leaseSha: LEASE,
    });

    expect(git.push).toHaveBeenCalledWith(REMOTE, `${LOCAL_BRANCH}:${REMOTE_BRANCH}`, [
      `--force-with-lease=${REMOTE_BRANCH}:${LEASE}`,
      "--force-if-includes",
    ]);
  });
});

describe("list-remote-commits — resolved destination", () => {
  it("ranges over the destination's tracking ref and returns it with the commits", async () => {
    const git = makeGit({
      log: vi.fn(async () => ({
        all: [{ hash: "h1", date: "d", message: "m", author_name: "a" }],
      })),
    });
    createHardenedGitMock.mockResolvedValue(git);

    const result = (await getHandler("git:list-remote-commits")(FAKE_EVENT, {
      cwd: CWD,
      branchName: LOCAL_BRANCH,
      limit: 5,
    })) as { destination: unknown; total: number; commits: unknown[] };

    expect(git.log).toHaveBeenCalledWith([
      "--max-count=5",
      `refs/heads/${LOCAL_BRANCH}..${PUSH_REF}`,
    ]);
    expect(result.destination).toEqual({ remote: REMOTE, branch: REMOTE_BRANCH });
    expect(result.total).toBe(7);
    expect(result.commits).toHaveLength(1);
  });

  it("counts the total over the same range the rows came from", async () => {
    const git = makeGit();
    createHardenedGitMock.mockResolvedValue(git);

    await getHandler("git:list-remote-commits")(FAKE_EVENT, {
      cwd: CWD,
      branchName: LOCAL_BRANCH,
    });

    expect(git.raw).toHaveBeenCalledWith([
      "rev-list",
      "--count",
      `refs/heads/${LOCAL_BRANCH}..${PUSH_REF}`,
    ]);
  });
});

describe("fails closed when the destination is unresolvable", () => {
  /** Two remotes, no push config anywhere — the genuinely ambiguous case. */
  function makeUnresolvableGit(overrides: FakeGit = {}): FakeGit {
    return makeGit(
      overrides,
      `refs/heads/${LOCAL_BRANCH}\u0000\u0000`,
      `refs/heads/${LOCAL_BRANCH}\u0000\u0000`
    );
  }

  it("refuses to push and issues no push call", async () => {
    const git = makeUnresolvableGit();
    createAuthenticatedGitMock.mockResolvedValue(git);

    await expect(getHandler("git:push")(FAKE_EVENT, { cwd: CWD })).rejects.toThrow(
      /no push destination configured/
    );
    expect(git.push).not.toHaveBeenCalled();
  });

  it("refuses setUpstream rather than falling back to origin", async () => {
    const git = makeUnresolvableGit();
    createAuthenticatedGitMock.mockResolvedValue(git);

    await expect(
      getHandler("git:push")(FAKE_EVENT, { cwd: CWD, setUpstream: true })
    ).rejects.toThrow(/no push destination configured/);
    expect(git.push).not.toHaveBeenCalled();
  });

  it("refuses to pull-rebase and issues no pull call", async () => {
    const git = makeUnresolvableGit();
    createAuthenticatedGitMock.mockResolvedValue(git);

    await expect(getHandler("git:pull-rebase")(FAKE_EVENT, { cwd: CWD })).rejects.toThrow(
      /no push destination configured/
    );
    expect(git.pull).not.toHaveBeenCalled();
  });

  it("refuses to force-push and issues no push call", async () => {
    const git = makeUnresolvableGit();
    createAuthenticatedGitMock.mockResolvedValue(git);

    await expect(
      getHandler("git:force-push-with-lease")(FAKE_EVENT, {
        cwd: CWD,
        branchName: LOCAL_BRANCH,
        leaseSha: LEASE,
      })
    ).rejects.toThrow(/no push destination configured/);
    expect(git.push).not.toHaveBeenCalled();
  });

  it("rejects the discard preview rather than reporting an empty commit list", async () => {
    // An empty list would read as "nothing would be discarded" — the preview
    // must refuse instead so the confirm can't imply a safe force-push.
    const git = makeUnresolvableGit();
    createHardenedGitMock.mockResolvedValue(git);

    await expect(
      getHandler("git:list-remote-commits")(FAKE_EVENT, { cwd: CWD, branchName: LOCAL_BRANCH })
    ).rejects.toThrow(/no push destination configured/);
    expect(git.log).not.toHaveBeenCalled();
  });

  it("still refuses when an origin remote exists but nothing selects it", async () => {
    const git = makeGit(
      {},
      `refs/heads/${LOCAL_BRANCH}\u0000\u0000`,
      `refs/heads/${LOCAL_BRANCH}\u0000\u0000`
    );
    git.getRemotes = vi.fn(async () => [
      { name: "origin", refs: { fetch: "", push: "" } },
      { name: "fork", refs: { fetch: "", push: "" } },
    ]);
    createAuthenticatedGitMock.mockResolvedValue(git);

    await expect(getHandler("git:push")(FAKE_EVENT, { cwd: CWD })).rejects.toThrow(
      /no push destination configured/
    );
    expect(git.push).not.toHaveBeenCalled();
  });
});
