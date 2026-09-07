import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join as pathJoin } from "path";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  execFile: execFileMock,
}));

import {
  getGitBranch,
  getGitDir,
  getGitCommonDir,
  clearGitDirCache,
  clearGitCommonDirCache,
} from "../gitUtils.js";

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

function mockGitOutput(stdout: string): void {
  execFileMock.mockImplementation((_file, _args, _opts, cb: ExecCallback) => cb(null, stdout, ""));
}

function mockGitFailure(message: string): void {
  execFileMock.mockImplementation((_file, _args, _opts, cb: ExecCallback) =>
    cb(new Error(message), "", "")
  );
}

/**
 * git's verdict that the path is not a repository: a clean fatal exit, which is
 * what `execFile` reports as a numeric `code`.
 */
function mockNotARepository(): void {
  execFileMock.mockImplementation((_file, _args, _opts, cb: ExecCallback) => {
    const error = Object.assign(new Error("Command failed: git rev-parse"), { code: 128 });
    cb(error, "", "fatal: not a git repository (or any of the parent directories): .git\n");
  });
}

/** A clean exit-128 fatal that is NOT the "no repository here" diagnostic. */
function mockGitFatal(stderr: string): void {
  execFileMock.mockImplementation((_file, _args, _opts, cb: ExecCallback) => {
    const error = Object.assign(new Error("Command failed: git rev-parse"), { code: 128 });
    cb(error, "", stderr);
  });
}

/** git never ran: the spawn itself failed (AV lock, missing binary, EPERM). */
function mockSpawnFailure(code: string): void {
  execFileMock.mockImplementation((_file, _args, _opts, cb: ExecCallback) => {
    const error = Object.assign(new Error(`spawn git ${code}`), { code });
    cb(error, "", "");
  });
}

/** execFile's `timeout` fired and killed the child before it answered. */
function mockGitTimeout(): void {
  execFileMock.mockImplementation((_file, _args, _opts, cb: ExecCallback) => {
    const error = Object.assign(new Error("Command failed: git rev-parse"), {
      killed: true,
      signal: "SIGTERM",
    });
    cb(error, "", "");
  });
}

beforeEach(() => {
  clearGitDirCache();
  clearGitCommonDirCache();
});

afterEach(() => {
  execFileMock.mockReset();
});

describe("getGitBranch", () => {
  it("returns the trimmed branch name", async () => {
    mockGitOutput("feature/foo\n");
    await expect(getGitBranch("/repo")).resolves.toBe("feature/foo");
  });

  it("returns null for a detached HEAD", async () => {
    mockGitOutput("HEAD\n");
    await expect(getGitBranch("/repo")).resolves.toBeNull();
  });

  it("returns null when git output is empty", async () => {
    mockGitOutput("\n");
    await expect(getGitBranch("/repo")).resolves.toBeNull();
  });

  it("returns null when git fails (not a repo / timeout)", async () => {
    mockGitFailure("not a git repository");
    await expect(getGitBranch("/not-a-repo")).resolves.toBeNull();
  });

  it("runs git in the given cwd with the requested timeout", async () => {
    mockGitOutput("main\n");
    await getGitBranch("/repo/path", { timeout: 1234 });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [file, args, opts] = execFileMock.mock.calls[0];
    expect(file).toBe("git");
    expect(args).toEqual(["rev-parse", "--abbrev-ref", "HEAD"]);
    expect(opts).toMatchObject({ cwd: "/repo/path", timeout: 1234 });
  });

  it("defaults to a short 500ms timeout", async () => {
    mockGitOutput("main\n");
    await getGitBranch("/repo");
    expect(execFileMock.mock.calls[0][2]).toMatchObject({ timeout: 500 });
  });
});

describe("getGitDir caching", () => {
  it("resolves a relative git dir against the worktree path", async () => {
    mockGitOutput(".git\n");
    await expect(getGitDir("/repo")).resolves.toBe(pathJoin("/repo", ".git"));
  });

  it("dedupes concurrent callers into a single git spawn", async () => {
    const callbacks: ExecCallback[] = [];
    execFileMock.mockImplementation((_file, _args, _opts, cb: ExecCallback) => {
      callbacks.push(cb);
    });

    const first = getGitDir("/repo");
    const second = getGitDir("/repo");
    // The fs fast path probes .git asynchronously before falling back to the
    // subprocess, so wait for the (single, deduped) spawn to be issued.
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(1));

    callbacks[0](null, ".git\n", "");
    await expect(first).resolves.toBe(pathJoin("/repo", ".git"));
    await expect(second).resolves.toBe(pathJoin("/repo", ".git"));
  });

  it("serves later callers from the cache after resolution", async () => {
    mockGitOutput(".git\n");
    await getGitDir("/repo");
    await getGitDir("/repo");
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("caches failures by default so a broken path doesn't re-spawn per call", async () => {
    mockGitFailure("not a git repository");
    await expect(getGitDir("/broken")).resolves.toBeNull();
    await expect(getGitDir("/broken")).resolves.toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures when cacheErrors is false", async () => {
    mockGitFailure("not a git repository");
    await expect(getGitDir("/broken", { cacheErrors: false })).resolves.toBeNull();
    await expect(getGitDir("/broken", { cacheErrors: false })).resolves.toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache entirely when cache is false", async () => {
    mockGitOutput(".git\n");
    await getGitDir("/repo", { cache: false });
    await getGitDir("/repo", { cache: false });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("re-resolves after clearGitDirCache", async () => {
    mockGitOutput(".git\n");
    await getGitDir("/repo");
    clearGitDirCache("/repo");
    await getGitDir("/repo");
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("keeps git-dir and common-dir caches independent", async () => {
    mockGitOutput("/repo/.git\n");
    await expect(getGitDir("/repo")).resolves.toBe("/repo/.git");
    await expect(getGitCommonDir("/repo")).resolves.toBe("/repo/.git");
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[0][1]).toEqual(["rev-parse", "--git-dir"]);
    expect(execFileMock.mock.calls[1][1]).toEqual(["rev-parse", "--git-common-dir"]);
  });
});

describe("filesystem fast path (no subprocess)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(pathJoin(tmpdir(), "daintree-gitdir-fastpath-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeGitDir(base: string): string {
    const gitDir = pathJoin(base, ".git");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(pathJoin(gitDir, "HEAD"), "ref: refs/heads/main\n");
    return gitDir;
  }

  it("resolves a regular repo's .git directory without spawning git", async () => {
    const gitDir = makeGitDir(root);
    await expect(getGitDir(root)).resolves.toBe(gitDir);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("resolves a linked worktree's gitdir pointer file without spawning git", async () => {
    const mainRoot = pathJoin(root, "main");
    mkdirSync(mainRoot, { recursive: true });
    const mainGitDir = makeGitDir(mainRoot);
    const wtGitDir = pathJoin(mainGitDir, "worktrees", "wt1");
    mkdirSync(wtGitDir, { recursive: true });
    writeFileSync(pathJoin(wtGitDir, "HEAD"), "ref: refs/heads/feature\n");
    const wtRoot = pathJoin(root, "wt1");
    mkdirSync(wtRoot, { recursive: true });
    writeFileSync(pathJoin(wtRoot, ".git"), `gitdir: ${wtGitDir}\n`);

    await expect(getGitDir(wtRoot)).resolves.toBe(wtGitDir);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("resolves a relative gitdir pointer against the worktree path", async () => {
    const target = pathJoin(root, "meta");
    mkdirSync(target, { recursive: true });
    writeFileSync(pathJoin(target, "HEAD"), "ref: refs/heads/main\n");
    const wtRoot = pathJoin(root, "wt");
    mkdirSync(wtRoot, { recursive: true });
    writeFileSync(pathJoin(wtRoot, ".git"), "gitdir: ../meta\n");

    await expect(getGitDir(wtRoot)).resolves.toBe(target);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("falls back to the subprocess when .git exists but has no HEAD", async () => {
    mkdirSync(pathJoin(root, ".git"), { recursive: true });
    mockGitFailure("not a git repository");
    await expect(getGitDir(root)).resolves.toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the subprocess when no .git entry exists", async () => {
    mockGitFailure("not a git repository");
    await expect(getGitDir(root)).resolves.toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("resolves the common dir through the commondir pointer without spawning git", async () => {
    const mainRoot = pathJoin(root, "main");
    mkdirSync(mainRoot, { recursive: true });
    const mainGitDir = makeGitDir(mainRoot);
    const wtGitDir = pathJoin(mainGitDir, "worktrees", "wt1");
    mkdirSync(wtGitDir, { recursive: true });
    writeFileSync(pathJoin(wtGitDir, "HEAD"), "ref: refs/heads/feature\n");
    writeFileSync(pathJoin(wtGitDir, "commondir"), "../..\n");
    const wtRoot = pathJoin(root, "wt1");
    mkdirSync(wtRoot, { recursive: true });
    writeFileSync(pathJoin(wtRoot, ".git"), `gitdir: ${wtGitDir}\n`);

    await expect(getGitCommonDir(wtRoot)).resolves.toBe(mainGitDir);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("returns the git dir itself as common dir for a main worktree", async () => {
    const gitDir = makeGitDir(root);
    await expect(getGitCommonDir(root)).resolves.toBe(gitDir);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe("negative-result caching is classified by failure kind (#12042)", () => {
  // A null gitDir is load-bearing far beyond this module: GitFileWatcher.start()
  // bails on it (leaving WatcherController in mode "none", whose poll cadence is
  // the adaptive profile interval) and GitStatusPass skips its stat pre-check
  // without one. Caching "we failed to look" as long as "this is not a repo" is
  // what turns one transient Windows fs blip into minutes of forced polling.

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Elapsed time at which a transient failure should have expired but a
   *  definitive one should not — the whole point is that they differ. */
  const BETWEEN_TTLS_MS = 60_000;

  it("re-probes a spawn failure but keeps a not-a-repository verdict cached", async () => {
    mockSpawnFailure("EPERM");
    await expect(getGitDir("/flaky")).resolves.toBeNull();

    mockNotARepository();
    await expect(getGitDir("/plain-folder")).resolves.toBeNull();
    const spawnsAfterDefinitive = execFileMock.mock.calls.length;

    await vi.advanceTimersByTimeAsync(BETWEEN_TTLS_MS);

    await expect(getGitDir("/plain-folder")).resolves.toBeNull();
    expect(execFileMock.mock.calls.length).toBe(spawnsAfterDefinitive);

    mockSpawnFailure("EPERM");
    await expect(getGitDir("/flaky")).resolves.toBeNull();
    expect(execFileMock.mock.calls.length).toBe(spawnsAfterDefinitive + 1);
  });

  it("treats a timed-out probe as transient", async () => {
    mockGitTimeout();
    await expect(getGitDir("/slow")).resolves.toBeNull();
    const spawns = execFileMock.mock.calls.length;

    await vi.advanceTimersByTimeAsync(BETWEEN_TTLS_MS);
    await expect(getGitDir("/slow")).resolves.toBeNull();

    expect(execFileMock.mock.calls.length).toBeGreaterThan(spawns);
  });

  // 128 is git's generic die() status, so every one of these is a fatal that
  // says nothing durable about whether the path is a repository. Caching any of
  // them as a verdict is what re-creates the ten-minute blackout.
  it.each([
    [
      "dubious ownership (fixable with safe.directory, app still open)",
      "fatal: detected dubious ownership in repository at '/repo'\n",
    ],
    ["a broken gitdir pointer", "fatal: invalid gitfile format: /repo/.git\n"],
    ["unreadable repository metadata", "error: cannot stat '/repo/.git/HEAD': Permission denied\n"],
    ["malformed config", "fatal: bad config line 3 in file /repo/.git/config\n"],
    ["an unsupported flag on an old git", "error: unknown option `git-common-dir'\n"],
    ["a fatal with no diagnostic at all", ""],
  ])("treats exit 128 from %s as transient", async (_label, stderr) => {
    mockGitFatal(stderr);
    await expect(getGitDir("/ambiguous")).resolves.toBeNull();
    const spawns = execFileMock.mock.calls.length;

    await vi.advanceTimersByTimeAsync(BETWEEN_TTLS_MS);
    await expect(getGitDir("/ambiguous")).resolves.toBeNull();

    expect(execFileMock.mock.calls.length).toBeGreaterThan(spawns);
  });

  it("upgrades a transient failure to the permanent TTL once it succeeds", async () => {
    mockSpawnFailure("EBUSY");
    await expect(getGitDir("/recovering")).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(BETWEEN_TTLS_MS);
    mockGitOutput("/recovering/.git\n");
    await expect(getGitDir("/recovering")).resolves.toBe("/recovering/.git");
    const spawnsAfterRecovery = execFileMock.mock.calls.length;

    // The entry was stamped transient on the way in; the success must re-stamp
    // it permanent rather than leaving the short window in place.
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    await expect(getGitDir("/recovering")).resolves.toBe("/recovering/.git");
    expect(execFileMock.mock.calls.length).toBe(spawnsAfterRecovery);
  });

  it("widens the retry window as transient failures repeat", async () => {
    // Without a backoff, an unreachable path (disconnected network drive, git
    // gone from PATH) would re-spawn `git rev-parse` on a fixed short cycle for
    // the life of the app — trading one spawn storm for another.
    // Long enough to expire the first window, short enough that it must not
    // expire the second — the widening is the whole assertion.
    const ONE_WINDOW_MS = 20_000;

    mockSpawnFailure("EPERM");
    await expect(getGitDir("/unreachable")).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(ONE_WINDOW_MS);
    await expect(getGitDir("/unreachable")).resolves.toBeNull();
    const spawnsAfterSecondFailure = execFileMock.mock.calls.length;

    // The same wait no longer expires the (now wider) window.
    await vi.advanceTimersByTimeAsync(ONE_WINDOW_MS);
    await expect(getGitDir("/unreachable")).resolves.toBeNull();
    expect(execFileMock.mock.calls.length).toBe(spawnsAfterSecondFailure);
  });

  it("keeps the backoff separate for git-dir and common-dir", async () => {
    // Two distinct probes. Sharing a streak would let a common-dir failure
    // widen getGitDir's window — delaying exactly the resolution the watcher
    // is waiting on — and let a success on one wipe the other's history.
    const ONE_WINDOW_MS = 20_000;

    mockSpawnFailure("EPERM");
    await expect(getGitCommonDir("/shared")).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(ONE_WINDOW_MS);
    await expect(getGitCommonDir("/shared")).resolves.toBeNull();

    // getGitDir has failed zero times, so it must still be on the base window.
    await expect(getGitDir("/shared")).resolves.toBeNull();
    const spawns = execFileMock.mock.calls.length;

    await vi.advanceTimersByTimeAsync(ONE_WINDOW_MS);
    await expect(getGitDir("/shared")).resolves.toBeNull();
    expect(execFileMock.mock.calls.length).toBe(spawns + 1);
  });

  it("restarts the backoff after an explicit invalidation", async () => {
    mockSpawnFailure("EPERM");
    await expect(getGitDir("/unreachable")).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(BETWEEN_TTLS_MS);
    await expect(getGitDir("/unreachable")).resolves.toBeNull();

    // A worktree the user re-added, or a topology change, must not inherit the
    // widened window from the path's previous life.
    clearGitDirCache("/unreachable");
    await expect(getGitDir("/unreachable")).resolves.toBeNull();
    const spawns = execFileMock.mock.calls.length;

    await vi.advanceTimersByTimeAsync(BETWEEN_TTLS_MS);
    await expect(getGitDir("/unreachable")).resolves.toBeNull();
    expect(execFileMock.mock.calls.length).toBeGreaterThan(spawns);
  });

  it("does not re-probe a success, however long the app runs", async () => {
    mockGitOutput("/repo/.git\n");
    await expect(getGitDir("/repo")).resolves.toBe("/repo/.git");
    const spawns = execFileMock.mock.calls.length;

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    await expect(getGitDir("/repo")).resolves.toBe("/repo/.git");

    expect(execFileMock.mock.calls.length).toBe(spawns);
  });

  it("still honours cacheErrors: false for a transient failure", async () => {
    mockSpawnFailure("EBUSY");
    await expect(getGitDir("/flaky", { cacheErrors: false })).resolves.toBeNull();
    await expect(getGitDir("/flaky", { cacheErrors: false })).resolves.toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("classifies common-dir failures the same way", async () => {
    mockSpawnFailure("EACCES");
    await expect(getGitCommonDir("/flaky")).resolves.toBeNull();
    const spawns = execFileMock.mock.calls.length;

    await vi.advanceTimersByTimeAsync(BETWEEN_TTLS_MS);
    await expect(getGitCommonDir("/flaky")).resolves.toBeNull();

    expect(execFileMock.mock.calls.length).toBeGreaterThan(spawns);
  });
});

describe("subprocess options", () => {
  it("hides the console window so the probe can't flash one on Windows", async () => {
    mockGitOutput(".git\n");
    await getGitDir("/repo");
    expect(execFileMock.mock.calls[0][2]).toMatchObject({ windowsHide: true });
  });

  it("pins the diagnostic locale the failure classification reads", async () => {
    // classifyGitFailure tells "not a repository" from every other fatal by
    // reading stderr, so a translated message would silently reclassify it.
    mockGitOutput(".git\n");
    await getGitDir("/repo");
    const opts = execFileMock.mock.calls[0][2] as { env?: Record<string, string> };
    expect(opts.env?.LC_ALL).toBe("C");
    // PATH must survive the override, or git isn't found at all.
    expect(opts.env?.PATH).toBe(process.env.PATH);
  });
});
