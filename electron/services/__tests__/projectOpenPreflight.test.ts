import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { constants as fsConstants, type Stats } from "fs";
import path from "path";
import { simpleGitMissingBinaryError } from "../../../shared/testing/simpleGitErrorFixtures.js";

const statMock = vi.hoisted(() => vi.fn<(path: string) => Promise<Stats>>());
const lstatMock = vi.hoisted(() => vi.fn<(path: string) => Promise<Stats>>());
const accessMock = vi.hoisted(() => vi.fn<(path: string, mode?: number) => Promise<void>>());

vi.mock("fs/promises", () => ({
  default: { stat: statMock, lstat: lstatMock, access: accessMock },
  stat: statMock,
  lstat: lstatMock,
  access: accessMock,
}));

const {
  assertProjectDirectory,
  isMissingGitExecutableError,
  probeGitMarker,
  PROJECT_DIRECTORY_STAT_TIMEOUT_MS,
  GIT_MARKER_STAT_TIMEOUT_MS,
} = await import("../projectOpenPreflight.js");

const FOLDER = "/repos/alpha";

function statsFor(isDirectory: boolean): Stats {
  return { isDirectory: () => isDirectory } as Stats;
}

function errnoError(
  code: string,
  extra: Partial<NodeJS.ErrnoException> = {}
): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: failing`), { code, ...extra });
}

/** Resolve the AppError an assertion rejected with, failing if it resolved. */
async function rejectionOf(
  path: string
): Promise<{ code: string; message: string; cause?: unknown }> {
  try {
    await assertProjectDirectory(path);
  } catch (error) {
    return error as { code: string; message: string; cause?: unknown };
  }
  throw new Error("expected assertProjectDirectory to reject");
}

describe("assertProjectDirectory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMock.mockResolvedValue(undefined);
  });

  it("resolves for a real directory", async () => {
    statMock.mockResolvedValue(statsFor(true));

    await expect(assertProjectDirectory(FOLDER)).resolves.toBeUndefined();
  });

  it.each([
    // A missing path and a parent segment that is a file both mean the path
    // cannot exist, so both are absent.
    ["ENOENT", "NOT_FOUND"],
    ["ENOTDIR", "NOT_FOUND"],
    ["EACCES", "PERMISSION"],
    ["EPERM", "PERMISSION"],
    ["ELOOP", "INVALID_PATH"],
    ["ENAMETOOLONG", "INVALID_PATH"],
    // Neither proves the path is gone — only that it couldn't be read.
    ["ESTALE", "PROJECT_OPEN_FAILED"],
    ["EIO", "PROJECT_OPEN_FAILED"],
  ])("classifies %s as %s", async (errno, expected) => {
    statMock.mockRejectedValue(errnoError(errno));

    expect((await rejectionOf(FOLDER)).code).toBe(expected);
  });

  it("distinguishes a path that is a file from one that is missing", async () => {
    // simple-git collapses these two into one indistinguishable error, which is
    // the defect this module exists to fix.
    statMock.mockResolvedValue(statsFor(false));
    expect((await rejectionOf(FOLDER)).code).toBe("NOT_A_DIRECTORY");

    statMock.mockRejectedValue(errnoError("ENOENT"));
    expect((await rejectionOf(FOLDER)).code).toBe("NOT_FOUND");
  });

  it("classifies an errno-less failure as unreadable rather than missing", async () => {
    statMock.mockRejectedValue(new Error("something opaque"));

    expect((await rejectionOf(FOLDER)).code).toBe("PROJECT_OPEN_FAILED");
  });

  it("keeps the underlying error and path for diagnostics", async () => {
    const underlying = errnoError("EACCES");
    statMock.mockRejectedValue(underlying);

    const rejection = (await rejectionOf(FOLDER)) as { cause?: unknown; message: string };
    expect(rejection.cause).toBe(underlying);
    expect(rejection.message).toContain(FOLDER);
  });

  it("never reaches the filesystem twice for one call", async () => {
    statMock.mockResolvedValue(statsFor(true));

    await assertProjectDirectory(FOLDER);

    expect(statMock).toHaveBeenCalledTimes(1);
    expect(statMock).toHaveBeenCalledWith(FOLDER);
  });

  it("classifies a directory that stats fine but can't be entered", async () => {
    // stat() only needs execute permission on the PARENT, so a folder whose own
    // bits are cleared stats successfully and only fails once git tries to
    // enter it. Without the explicit access check this fell through to the
    // generic bucket instead of PERMISSION.
    statMock.mockResolvedValue(statsFor(true));
    accessMock.mockRejectedValue(errnoError("EACCES"));

    expect((await rejectionOf(FOLDER)).code).toBe("PERMISSION");
  });

  it("checks for both read and traverse access", async () => {
    statMock.mockResolvedValue(statsFor(true));

    await assertProjectDirectory(FOLDER);

    const mode = accessMock.mock.calls[0]?.[1] ?? 0;
    expect(mode & fsConstants.R_OK).toBe(fsConstants.R_OK);
    expect(mode & fsConstants.X_OK).toBe(fsConstants.X_OK);
  });
});

describe("probeGitMarker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the .git entry inside the project root", async () => {
    lstatMock.mockResolvedValue(statsFor(true));

    await probeGitMarker(FOLDER);

    expect(lstatMock).toHaveBeenCalledWith(path.join(FOLDER, ".git"));
  });

  it("asks about the entry itself, not what it resolves to", async () => {
    // `stat` follows symlinks, so a `.git` symlinked onto a detached volume
    // would answer ENOENT for a marker plainly sitting in the folder — a false
    // "missing" that would route the project straight at the demotion dialog.
    lstatMock.mockResolvedValue(statsFor(false));

    await expect(probeGitMarker(FOLDER)).resolves.toBe("present");
    expect(statMock).not.toHaveBeenCalled();
  });

  it("accepts a .git file as readily as a .git directory", async () => {
    // A linked worktree and a submodule both carry `.git` as a file. Requiring a
    // directory would report every one of them as having lost its repository.
    lstatMock.mockResolvedValue(statsFor(false));

    await expect(probeGitMarker(FOLDER)).resolves.toBe("present");
  });

  it.each([
    // The only two errnos that prove the entry cannot exist.
    ["ENOENT", "missing"],
    ["ENOTDIR", "missing"],
    // Each proves only that we couldn't look, which must never cost a project
    // its git identity.
    ["EACCES", "unknown"],
    ["EPERM", "unknown"],
    ["EIO", "unknown"],
    ["ESTALE", "unknown"],
    ["ELOOP", "unknown"],
  ])("answers %s with %s", async (errno, expected) => {
    lstatMock.mockRejectedValue(errnoError(errno));

    await expect(probeGitMarker(FOLDER)).resolves.toBe(expected);
  });

  it("treats an errno-less failure as inconclusive rather than absent", async () => {
    lstatMock.mockRejectedValue(new Error("something opaque"));

    await expect(probeGitMarker(FOLDER)).resolves.toBe("unknown");
  });

  it("re-reads the folder on the next probe rather than caching a verdict", async () => {
    // The dedup map exists to share one syscall between *concurrent* callers,
    // never to remember an answer. A cached "present" would recreate the very
    // bug this guard fixes once `.git` was deleted mid-session; a cached
    // "missing" would spawn git on every healthy switch thereafter.
    lstatMock.mockResolvedValue(statsFor(true));
    await expect(probeGitMarker(FOLDER)).resolves.toBe("present");

    lstatMock.mockRejectedValue(errnoError("ENOENT"));
    await expect(probeGitMarker(FOLDER)).resolves.toBe("missing");

    lstatMock.mockResolvedValue(statsFor(true));
    await expect(probeGitMarker(FOLDER)).resolves.toBe("present");

    expect(lstatMock).toHaveBeenCalledTimes(3);
  });
});

describe("probeGitMarker under a hung filesystem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on a stat that never settles without claiming the marker is gone", async () => {
    // A dead mount blocks stat in the kernel. Reporting "missing" here would
    // route an unplugged drive straight into the demotion prompt.
    lstatMock.mockReturnValue(new Promise<Stats>(() => {}));

    const pending = probeGitMarker(FOLDER);
    const assertion = expect(pending).resolves.toBe("unknown");

    await vi.advanceTimersByTimeAsync(GIT_MARKER_STAT_TIMEOUT_MS + 1);
    await assertion;

    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds the probe far tighter than a user-initiated open", () => {
    // This one runs on every project switch rather than on an explicit open, so
    // it has to fail open long before the open flow would.
    expect(GIT_MARKER_STAT_TIMEOUT_MS).toBeLessThan(PROJECT_DIRECTORY_STAT_TIMEOUT_MS);
  });

  it("shares one syscall across concurrent probes of the same root", async () => {
    lstatMock.mockReturnValue(new Promise<Stats>(() => {}));

    const both = Promise.all([probeGitMarker(FOLDER), probeGitMarker(FOLDER)]);

    await vi.advanceTimersByTimeAsync(GIT_MARKER_STAT_TIMEOUT_MS + 1);

    expect(await both).toEqual(["unknown", "unknown"]);
    expect(lstatMock).toHaveBeenCalledTimes(1);
  });

  it("lets a remounted drive be probed again after a timeout", async () => {
    // Holding the timed-out probe would pin every later switch to the same
    // doomed promise, so remounting the volume would never take effect.
    lstatMock.mockReturnValue(new Promise<Stats>(() => {}));
    const first = probeGitMarker(FOLDER);
    await vi.advanceTimersByTimeAsync(GIT_MARKER_STAT_TIMEOUT_MS + 1);
    expect(await first).toBe("unknown");

    lstatMock.mockResolvedValue(statsFor(true));

    await expect(probeGitMarker(FOLDER)).resolves.toBe("present");
    expect(lstatMock).toHaveBeenCalledTimes(2);
  });
});

describe("assertProjectDirectory under a hung filesystem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMock.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on a stat that never settles and leaves no timer armed", async () => {
    // A disconnected SMB/AFP mount blocks stat in the kernel rather than
    // failing, so the open flow needs its own bound.
    statMock.mockReturnValue(new Promise<Stats>(() => {}));

    const pending = assertProjectDirectory(FOLDER);
    const assertion = expect(pending).rejects.toMatchObject({ code: "PROJECT_OPEN_FAILED" });

    await vi.advanceTimersByTimeAsync(PROJECT_DIRECTORY_STAT_TIMEOUT_MS + 1);
    await assertion;

    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares one syscall across concurrent calls for the same path", async () => {
    // stat takes no AbortSignal, so a timed-out call keeps its libuv worker.
    // That pool is 4 threads: without sharing, repeated retries against a dead
    // mount would wedge every async fs operation in the main process.
    statMock.mockReturnValue(new Promise<Stats>(() => {}));

    const first = assertProjectDirectory(FOLDER);
    const second = assertProjectDirectory(FOLDER);
    const assertions = Promise.allSettled([first, second]);

    await vi.advanceTimersByTimeAsync(PROJECT_DIRECTORY_STAT_TIMEOUT_MS + 1);
    const results = await assertions;

    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(statMock).toHaveBeenCalledTimes(1);
  });

  it("bounds a hang in the access check too, sharing one probe", async () => {
    // stat succeeding but access hanging is the stale-mount case: without the
    // access call living inside the same shared probe and deadline, concurrent
    // opens would each burn a worker and a caller could wait out two timeouts.
    statMock.mockResolvedValue(statsFor(true));
    accessMock.mockReturnValue(new Promise<void>(() => {}));

    const calls = Promise.allSettled([
      assertProjectDirectory(FOLDER),
      assertProjectDirectory(FOLDER),
    ]);

    await vi.advanceTimersByTimeAsync(PROJECT_DIRECTORY_STAT_TIMEOUT_MS + 1);
    const results = await calls;

    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(accessMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("issues separate syscalls for different paths", async () => {
    statMock.mockReturnValue(new Promise<Stats>(() => {}));

    const calls = Promise.allSettled([
      assertProjectDirectory(FOLDER),
      assertProjectDirectory("/repos/beta"),
    ]);

    await vi.advanceTimersByTimeAsync(PROJECT_DIRECTORY_STAT_TIMEOUT_MS + 1);
    await calls;

    expect(statMock).toHaveBeenCalledTimes(2);
  });

  it("retries a path with a fresh syscall after one timed out", async () => {
    // The shared entry must not outlive its timeout: pinning later attempts to
    // the same doomed promise would mean remounting the drive never takes
    // effect and the folder stays unopenable until the app restarts.
    statMock.mockReturnValue(new Promise<Stats>(() => {}));
    const first = expect(assertProjectDirectory(FOLDER)).rejects.toMatchObject({
      code: "PROJECT_OPEN_FAILED",
    });
    await vi.advanceTimersByTimeAsync(PROJECT_DIRECTORY_STAT_TIMEOUT_MS + 1);
    await first;

    statMock.mockResolvedValue(statsFor(true));
    await expect(assertProjectDirectory(FOLDER)).resolves.toBeUndefined();

    expect(statMock).toHaveBeenCalledTimes(2);
  });

  it("re-stats a path once its previous call settled", async () => {
    statMock.mockResolvedValue(statsFor(true));

    await assertProjectDirectory(FOLDER);
    await assertProjectDirectory(FOLDER);

    // The share is for concurrent callers only — it must not cache a stale
    // answer for a folder that has since changed on disk.
    expect(statMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * The predicate itself lives in `shared/utils/gitOperationErrors.ts` and is
 * exercised in full there. What matters here is that this module keeps
 * re-exporting it, since `ProjectStore` and the switch-handler mock both reach
 * it through this façade.
 */
describe("isMissingGitExecutableError (re-exported)", () => {
  it("recognizes what simple-git actually throws, through GitService's wrapping", () => {
    // The real message is a whole Node stack trace, not the one-liner this
    // suite used to assume — the gap that made #11764's detection dead code.
    const wrapped = new Error("Worktree directory no longer exists", {
      cause: new Error("Git operation failed: getRepositoryRoot", {
        cause: simpleGitMissingBinaryError(),
      }),
    });

    expect(isMissingGitExecutableError(wrapped)).toBe(true);
  });

  it("recognizes a raw spawn errno that never went through simple-git", () => {
    expect(isMissingGitExecutableError(errnoError("ENOENT", { syscall: "spawn git" }))).toBe(true);
  });

  it("does not mistake a missing directory for a missing binary", () => {
    expect(isMissingGitExecutableError(errnoError("ENOENT", { syscall: "stat" }))).toBe(false);
    expect(isMissingGitExecutableError(errnoError("ENOENT"))).toBe(false);
    expect(isMissingGitExecutableError(errnoError("EACCES", { syscall: "spawn git" }))).toBe(false);
  });
});
