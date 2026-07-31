import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { Readable } from "stream";

interface SpawnSyncResult {
  status: number | null;
  error?: Error;
}

// Explicitly typed so `.mock.calls` reads without casts that would regress the
// no-unsafe-type-assertion ratchet, and so the mock factories below type-check.
const spawnMock = vi.fn<(command: string, options: Record<string, unknown>) => unknown>();
const spawnSyncMock =
  vi.fn<(file: string, args: string[], options: Record<string, unknown>) => SpawnSyncResult>();
const realpathMock = vi.fn<(target: string) => Promise<string>>();
const detectMock =
  vi.fn<(path: string) => Promise<Array<{ id: string; name: string; command: string }>>>();
const getProjectByIdMock = vi.fn<(id: string) => { id: string; path: string } | null>();
const listWorktreesMock = vi.fn<() => Promise<Array<{ path: string; bare: boolean }>>>();

vi.mock("child_process", () => ({
  spawn: (command: string, options: Record<string, unknown>) => spawnMock(command, options),
  spawnSync: (file: string, args: string[], options: Record<string, unknown>) =>
    spawnSyncMock(file, args, options),
}));

vi.mock("fs/promises", () => ({
  realpath: (target: string) => realpathMock(target),
}));

vi.mock("../RunCommandDetector.js", () => ({
  runCommandDetector: { detect: (path: string) => detectMock(path) },
}));

vi.mock("../ProjectStore.js", () => ({
  projectStore: { getProjectById: (id: string) => getProjectByIdMock(id) },
}));

vi.mock("../GitService.js", () => ({
  GitService: class {
    listWorktrees() {
      return listWorktreesMock();
    }
  },
}));

vi.mock("../../utils/spawnEnv.js", () => ({
  buildInstallEnv: () => ({ PATH: "/usr/bin", HOME: "/home/u", TERM: "dumb" }),
}));

const { ProjectCheckService, ProjectCheckError } = await import("../ProjectCheckService.js");

/** Minimal ChildProcess stand-in: emits the events the service listens on. */
class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  pid: number | undefined = 4242;
  kill = vi.fn();
  unref = vi.fn();

  /** Normal termination: `exit` then `close`, as Node delivers them. */
  finish(code: number | null, signal: string | null = null): void {
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

function makeProject(path = "/repo"): { id: string; path: string } {
  return { id: "proj-1", path };
}

let child: FakeChild;

beforeEach(() => {
  vi.clearAllMocks();
  child = new FakeChild();
  spawnMock.mockReturnValue(child);
  spawnSyncMock.mockReturnValue({ status: 0, error: undefined });
  // Identity realpath: every path in these tests is already canonical.
  realpathMock.mockImplementation(async (p: string) => p);
  getProjectByIdMock.mockReturnValue(makeProject());
  detectMock.mockResolvedValue([
    { id: "npm:test", name: "test", command: "npm run test" },
    { id: "npm:lint", name: "lint", command: "npm run lint" },
  ]);
  listWorktreesMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ProjectCheckService.runCheck — result classification", () => {
  it("reports passed on exit 0", async () => {
    const service = new ProjectCheckService();
    const promise = service.runCheck({ projectId: "proj-1", runnerId: "npm:test" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    child.stdout.push("42 passing\n");
    child.finish(0);

    const result = await promise;
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.runnerName).toBe("test");
    expect(result.output).toContain("42 passing");
  });

  it("reports a non-zero exit as a result, not a throw", async () => {
    const service = new ProjectCheckService();
    const promise = service.runCheck({ projectId: "proj-1", runnerId: "npm:test" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    child.stderr.push("1 failing\n");
    child.finish(1);

    // The whole point of the feature: an authoritative failure is data an
    // agent can act on, not an error that hides the exit code.
    const result = await promise;
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.output).toContain("1 failing");
  });

  it("does not report passed when the process died on a signal with a null code", async () => {
    const service = new ProjectCheckService();
    const promise = service.runCheck({ projectId: "proj-1", runnerId: "npm:test" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    child.finish(null, "SIGKILL");

    const result = await promise;
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.signalName).toBe("SIGKILL");
  });

  it("runs the resolved command through a shell in the project root", async () => {
    const service = new ProjectCheckService();
    const promise = service.runCheck({ projectId: "proj-1", runnerId: "npm:lint" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.finish(0);
    await promise;

    const call = spawnMock.mock.calls[0];
    expect(call?.[0]).toBe("npm run lint");
    expect(call?.[1]).toMatchObject({ shell: true, cwd: "/repo" });
    // Non-interactive overrides must survive the env merge, or a runner that
    // prompts would hang against a stdio it can never read from.
    expect(call?.[1]?.env).toMatchObject({ CI: "1", GIT_TERMINAL_PROMPT: "0" });
  });
});

describe("ProjectCheckService.runCheck — refusing to start", () => {
  it("throws for an unknown project", async () => {
    getProjectByIdMock.mockReturnValue(null);
    const service = new ProjectCheckService();
    await expect(
      service.runCheck({ projectId: "missing", runnerId: "npm:test" })
    ).rejects.toBeInstanceOf(ProjectCheckError);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("throws for an unknown runner and enumerates the valid ids", async () => {
    const service = new ProjectCheckService();
    await expect(service.runCheck({ projectId: "proj-1", runnerId: "npm:nope" })).rejects.toThrow(
      /npm:test.*npm:lint|npm:lint.*npm:test/
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("never spawns a caller-supplied command — only the detected one", async () => {
    const service = new ProjectCheckService();
    // A caller controls only the id; the command text comes from detection.
    const promise = service.runCheck({ projectId: "proj-1", runnerId: "npm:test" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.finish(0);
    await promise;

    expect(spawnMock.mock.calls[0]?.[0]).toBe("npm run test");
  });

  it("rejects a cwd that is neither the project root nor a registered worktree", async () => {
    listWorktreesMock.mockResolvedValue([{ path: "/wt/feature", bare: false }]);
    const service = new ProjectCheckService();

    await expect(
      service.runCheck({ projectId: "proj-1", runnerId: "npm:test", cwd: "/etc" })
    ).rejects.toThrow(/not the project root or one of its worktrees/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("accepts a registered worktree as cwd and detects runners there", async () => {
    listWorktreesMock.mockResolvedValue([{ path: "/wt/feature", bare: false }]);
    const service = new ProjectCheckService();
    const promise = service.runCheck({
      projectId: "proj-1",
      runnerId: "npm:test",
      cwd: "/wt/feature",
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.finish(0);
    const result = await promise;

    expect(result.cwd).toBe("/wt/feature");
    // A branch can change its own scripts, so detection must follow the cwd
    // rather than always reading the project root.
    expect(detectMock).toHaveBeenCalledWith("/wt/feature");
  });

  it("ignores bare worktrees when validating cwd", async () => {
    listWorktreesMock.mockResolvedValue([{ path: "/repo.git", bare: true }]);
    const service = new ProjectCheckService();

    await expect(
      service.runCheck({ projectId: "proj-1", runnerId: "npm:test", cwd: "/repo.git" })
    ).rejects.toThrow(/not the project root/);
  });

  it("throws when a cwd does not exist", async () => {
    realpathMock.mockImplementation(async (p: string) => {
      if (p === "/gone") throw new Error("ENOENT");
      return p;
    });
    const service = new ProjectCheckService();

    await expect(
      service.runCheck({ projectId: "proj-1", runnerId: "npm:test", cwd: "/gone" })
    ).rejects.toThrow(/does not exist/);
  });

  it("throws when already aborted before the spawn", async () => {
    const controller = new AbortController();
    controller.abort();
    const service = new ProjectCheckService();

    // Nothing ran, so there is no exit code to report — that is a failure to
    // start, not a cancelled result.
    await expect(
      service.runCheck({ projectId: "proj-1", runnerId: "npm:test" }, { signal: controller.signal })
    ).rejects.toBeInstanceOf(ProjectCheckError);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses a second check in the same directory while one is running", async () => {
    const service = new ProjectCheckService();
    const first = service.runCheck({ projectId: "proj-1", runnerId: "npm:test" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    await expect(service.runCheck({ projectId: "proj-1", runnerId: "npm:lint" })).rejects.toThrow(
      /already running/
    );

    child.finish(0);
    await first;

    // The lock releases on settle, so the directory is usable again.
    const second = new FakeChild();
    spawnMock.mockReturnValue(second);
    const third = service.runCheck({ projectId: "proj-1", runnerId: "npm:lint" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    second.finish(0);
    await expect(third).resolves.toMatchObject({ passed: true });
  });

  it("allows concurrent checks in different worktrees", async () => {
    listWorktreesMock.mockResolvedValue([{ path: "/wt/feature", bare: false }]);
    const service = new ProjectCheckService();
    const rootRun = service.runCheck({ projectId: "proj-1", runnerId: "npm:test" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

    const wtChild = new FakeChild();
    spawnMock.mockReturnValue(wtChild);
    const wtRun = service.runCheck({
      projectId: "proj-1",
      runnerId: "npm:test",
      cwd: "/wt/feature",
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));

    child.finish(0);
    wtChild.finish(0);
    await expect(Promise.all([rootRun, wtRun])).resolves.toHaveLength(2);
  });

  it("throws when a spawn error fires instead of an exit", async () => {
    const service = new ProjectCheckService();
    const promise = service.runCheck({ projectId: "proj-1", runnerId: "npm:test" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    child.emit("error", new Error("EACCES"));

    await expect(promise).rejects.toBeInstanceOf(ProjectCheckError);
  });
});

describe("ProjectCheckService — output handling", () => {
  it("keeps the tail and flags truncation when output exceeds the cap", async () => {
    const service = new ProjectCheckService();
    const promise = service.runCheck({ projectId: "proj-1", runnerId: "npm:test" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    // Well past the 50 KiB cap, with a unique marker at each end.
    child.stdout.push("HEAD_MARKER\n");
    child.stdout.push("x".repeat(60 * 1024));
    child.stdout.push("\nTAIL_MARKER\n");
    child.finish(1);

    const result = await promise;
    expect(result.outputTruncated).toBe(true);
    // The summary a runner prints last is the part worth keeping.
    expect(result.output).toContain("TAIL_MARKER");
    expect(result.output).not.toContain("HEAD_MARKER");
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(50 * 1024);
  });

  it("does not flag truncation for output under the cap", async () => {
    const service = new ProjectCheckService();
    const promise = service.runCheck({ projectId: "proj-1", runnerId: "npm:test" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    child.stdout.push("short\n");
    child.finish(0);

    const result = await promise;
    expect(result.outputTruncated).toBe(false);
    expect(result.output).toBe("short\n");
  });

  it("scrubs secrets out of captured output", async () => {
    const service = new ProjectCheckService();
    const promise = service.runCheck({ projectId: "proj-1", runnerId: "npm:test" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    child.stdout.push("token=ghp_0123456789abcdefghijklmnopqrstuvwxyzAB\n");
    child.finish(1);

    const result = await promise;
    expect(result.output).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyzAB");
  });

  it("interleaves stdout and stderr into one capture", async () => {
    const service = new ProjectCheckService();
    const promise = service.runCheck({ projectId: "proj-1", runnerId: "npm:test" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

    child.stdout.push("out-line\n");
    child.stderr.push("err-line\n");
    child.finish(1);

    const result = await promise;
    expect(result.output).toContain("out-line");
    expect(result.output).toContain("err-line");
  });
});

describe("ProjectCheckService — cancellation and teardown", () => {
  it("kills the process group on abort and reports aborted", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const controller = new AbortController();
      const service = new ProjectCheckService();
      const promise = service.runCheck(
        { projectId: "proj-1", runnerId: "npm:test" },
        { signal: controller.signal }
      );
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

      controller.abort();
      child.finish(null, "SIGTERM");

      const result = await promise;
      expect(result.aborted).toBe(true);
      expect(result.passed).toBe(false);
      // Negative pid targets the whole group, so a runner's worker pool dies
      // with it rather than being orphaned.
      expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
    } finally {
      killSpy.mockRestore();
    }
  });

  it("spawns detached on POSIX so the group is signalable", async () => {
    const service = new ProjectCheckService();
    const promise = service.runCheck({ projectId: "proj-1", runnerId: "npm:test" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.finish(0);
    await promise;

    const options = spawnMock.mock.calls[0]?.[1];
    expect(options?.detached).toBe(process.platform !== "win32");
  });

  it("settles from exit when close never arrives (a grandchild holds the pipe)", async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const service = new ProjectCheckService();
      const promise = service.runCheck({ projectId: "proj-1", runnerId: "npm:test" });
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

      // `exit` only — no `close`. Waiting on close alone would report a
      // spurious timeout on a check that actually passed.
      child.emit("exit", 0, null);
      await vi.advanceTimersByTimeAsync(2_500);

      const result = await promise;
      expect(result.passed).toBe(true);
      expect(result.timedOut).toBe(false);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("reports timedOut and kills the tree when the deadline elapses", async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const service = new ProjectCheckService();
      const promise = service.runCheck({
        projectId: "proj-1",
        runnerId: "npm:test",
        timeoutMs: 1_000,
      });
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

      await vi.advanceTimersByTimeAsync(1_100);
      expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");

      child.finish(null, "SIGTERM");
      const result = await promise;
      expect(result.timedOut).toBe(true);
      expect(result.aborted).toBe(false);
      expect(result.passed).toBe(false);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("keeps the first terminal cause when an abort lands after the timeout", async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const controller = new AbortController();
      const service = new ProjectCheckService();
      const promise = service.runCheck(
        { projectId: "proj-1", runnerId: "npm:test", timeoutMs: 1_000 },
        { signal: controller.signal }
      );
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

      await vi.advanceTimersByTimeAsync(1_100);
      controller.abort();
      child.finish(null, "SIGTERM");

      // An agent retries a timeout differently from a cancellation, so the
      // two flags must not both be set.
      const result = await promise;
      expect(result.timedOut).toBe(true);
      expect(result.aborted).toBe(false);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("dispose() aborts in-flight checks and refuses new ones", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const service = new ProjectCheckService();
      const promise = service.runCheck({ projectId: "proj-1", runnerId: "npm:test" });
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());

      service.dispose();
      expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");

      child.finish(null, "SIGTERM");
      await expect(promise).resolves.toMatchObject({ aborted: true });

      await expect(service.runCheck({ projectId: "proj-1", runnerId: "npm:test" })).rejects.toThrow(
        /shutting down/
      );
    } finally {
      killSpy.mockRestore();
    }
  });
});
