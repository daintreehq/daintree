import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { checkIgnoredPaths } from "../gitCheckIgnore.js";
import { GIT_BLOCK_TIMEOUT_MS } from "../hardenedGit.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
}

function createChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter() as FakeChild["stdin"];
  stdin.end = vi.fn();
  child.stdin = stdin;
  child.kill = vi.fn();
  return child;
}

/** Install a child the next `spawn` returns, and hand it back for driving. */
function nextChild(): FakeChild {
  const child = createChild();
  vi.mocked(spawn).mockReturnValueOnce(child as never);
  return child;
}

function spawnArgs(): string[] {
  return vi.mocked(spawn).mock.calls[0][1] as string[];
}

describe("checkIgnoredPaths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("returns an empty set without spawning for an empty path list", async () => {
    await expect(checkIgnoredPaths("/repo", [])).resolves.toEqual(new Set());
    expect(spawn).not.toHaveBeenCalled();
  });

  it("feeds paths over NUL-terminated stdin and keeps argv constant-size", async () => {
    const child = nextChild();
    const promise = checkIgnoredPaths("/repo", ["a.log", "sub/b.log"]);
    child.stdout.emit("data", Buffer.from("a.log\0sub/b.log\0"));
    child.emit("close", 0, null);

    await expect(promise).resolves.toEqual(new Set(["a.log", "sub/b.log"]));
    // The whole point of --stdin: simple-git's argv-based checkIgnoreTask
    // blows past ARG_MAX on a large burst (#10234).
    expect(child.stdin.end).toHaveBeenCalledWith("a.log\0sub/b.log\0");
    const args = spawnArgs();
    expect(args.slice(-3)).toEqual(["check-ignore", "--stdin", "-z"]);
    // No path may reach argv at all — argv stays the fixed hardened prefix
    // plus the subcommand, whatever the burst size.
    expect(args).not.toContain("a.log");
    expect(args).not.toContain("sub/b.log");
  });

  it("spawns with the hardened config and env", async () => {
    const child = nextChild();
    const promise = checkIgnoredPaths("/repo", ["a.log"], { platform: "linux" });
    child.emit("close", 1, null);
    await promise;

    const args = spawnArgs();
    expect(args.filter((a) => a === "-c").length).toBeGreaterThan(0);
    expect(args.some((a) => a.startsWith("core.fsmonitor="))).toBe(true);
    const options = vi.mocked(spawn).mock.calls[0][2] as {
      cwd: string;
      env: NodeJS.ProcessEnv;
      windowsHide: boolean;
    };
    expect(options.cwd).toBe("/repo");
    expect(options.windowsHide).toBe(true);
    expect(options.env.GIT_LITERAL_PATHSPECS).toBe("1");
    expect(options.env.GIT_OPTIONAL_LOCKS).toBe("0");
  });

  it("does not pass --no-index, so tracked paths stay out of the result", async () => {
    // Default mode is what makes one spawn answer "ignored AND untracked":
    // git omits tracked files from check-ignore output entirely. --no-index
    // would report them and silently break the caller's skip predicate.
    const child = nextChild();
    const promise = checkIgnoredPaths("/repo", ["a.log"]);
    child.emit("close", 1, null);
    await promise;
    expect(spawnArgs()).not.toContain("--no-index");
    expect(spawnArgs()).not.toContain("-v");
  });

  it("reassembles output split across chunks and drops the trailing empty token", async () => {
    const child = nextChild();
    const promise = checkIgnoredPaths("/repo", ["one.log", "two.log"]);
    child.stdout.emit("data", Buffer.from("one.l"));
    child.stdout.emit("data", Buffer.from("og\0two.log\0"));
    child.emit("close", 0, null);
    await expect(promise).resolves.toEqual(new Set(["one.log", "two.log"]));
  });

  it("preserves paths containing spaces, newlines and unicode", async () => {
    const odd = ["a b.log", "line\nbreak.log", "café/ünïcode.log"];
    const child = nextChild();
    const promise = checkIgnoredPaths("/repo", odd);
    child.stdout.emit("data", Buffer.from(odd.join("\0") + "\0", "utf8"));
    child.emit("close", 0, null);
    // NUL framing is why these survive: no shell quoting, no line splitting.
    await expect(promise).resolves.toEqual(new Set(odd));
  });

  it("treats exit 1 as a valid empty result, not a failure", async () => {
    const child = nextChild();
    const promise = checkIgnoredPaths("/repo", ["tracked.ts"]);
    child.emit("close", 1, null);
    await expect(promise).resolves.toEqual(new Set());
  });

  it.each([
    [2, "generic failure"],
    [128, "fatal: outside repository"],
    [129, "usage error"],
  ])("rejects on exit %i and discards partial output", async (code, stderr) => {
    const child = nextChild();
    const promise = checkIgnoredPaths("/repo", ["a.log", "/etc/hosts"]);
    // A fatal can arrive after git already wrote matches for the paths it
    // processed. Trusting that prefix would skip a status refresh on a burst
    // that was never fully classified.
    child.stdout.emit("data", Buffer.from("a.log\0"));
    child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code, null);
    await expect(promise).rejects.toThrow(`exit ${code}`);
  });

  it("rejects when git is killed by a signal", async () => {
    const child = nextChild();
    const promise = checkIgnoredPaths("/repo", ["a.log"]);
    // code is null on signal death; without this branch it would fall through
    // the `code === 0` / `code === 1` checks into a confusing "exit null".
    child.emit("close", null, "SIGKILL");
    await expect(promise).rejects.toThrow("killed by SIGKILL");
  });

  it("rejects on a spawn error", async () => {
    const child = nextChild();
    const promise = checkIgnoredPaths("/repo", ["a.log"]);
    child.emit("error", new Error("ENOENT"));
    await expect(promise).rejects.toThrow("ENOENT");
  });

  it("swallows stdin EPIPE and still settles from close", async () => {
    const child = nextChild();
    const promise = checkIgnoredPaths("/repo", ["a.log"]);
    // git can exit before the body finishes writing; the stream then errors
    // after the process is already gone. `close` is the source of truth.
    child.stdin.emit("error", new Error("EPIPE"));
    child.emit("close", 1, null);
    await expect(promise).resolves.toEqual(new Set());
  });

  it("kills and rejects when the deadline expires", async () => {
    vi.useFakeTimers();
    const child = nextChild();
    const promise = checkIgnoredPaths("/repo", ["a.log"], { timeoutMs: 250 });
    const assertion = expect(promise).rejects.toThrow("timed out after 250ms");
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("clamps a caller deadline to the hard block ceiling", async () => {
    vi.useFakeTimers();
    nextChild();
    const promise = checkIgnoredPaths("/repo", ["a.log"], {
      timeoutMs: GIT_BLOCK_TIMEOUT_MS * 10,
    });
    const assertion = expect(promise).rejects.toThrow(`timed out after ${GIT_BLOCK_TIMEOUT_MS}ms`);
    await vi.advanceTimersByTimeAsync(GIT_BLOCK_TIMEOUT_MS);
    await assertion;
  });

  it("settles once: a close after the deadline cannot resolve the rejected promise", async () => {
    vi.useFakeTimers();
    const child = nextChild();
    const promise = checkIgnoredPaths("/repo", ["a.log"], { timeoutMs: 100 });
    const assertion = expect(promise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    child.stdout.emit("data", Buffer.from("a.log\0"));
    child.emit("close", 0, null);
    await assertion;
  });

  it("forwards the abort signal to spawn", async () => {
    const controller = new AbortController();
    const child = nextChild();
    const promise = checkIgnoredPaths("/repo", ["a.log"], { signal: controller.signal });
    const options = vi.mocked(spawn).mock.calls[0][2] as { signal?: AbortSignal };
    expect(options.signal).toBe(controller.signal);
    child.emit("close", 1, null);
    await promise;
  });
});
