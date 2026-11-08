import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/**
 * The backends' contract with their child process: the exact clone-only
 * invocation, how its answer is read, and that an abort waits for the child to
 * exit. A real clone is exercised by the realGit suite on macOS.
 */

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);

  finish(code: number | null, out = "", err = ""): void {
    if (out) this.stdout.write(out);
    if (err) this.stderr.write(err);
    setImmediate(() => this.emit("close", code, null));
  }
}

const spawnMock = vi.fn();
vi.mock("child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

const { cloneTreeForPlatform } = await import("../worktreeClone.js");

function nextChild(): FakeChild {
  const child = new FakeChild();
  spawnMock.mockReturnValueOnce(child);
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe("cloneTreeForPlatform", () => {
  it("has no backend on Windows", () => {
    expect(cloneTreeForPlatform("win32")).toBeUndefined();
  });

  describe("macOS: clonefile through osascript", () => {
    const clone = cloneTreeForPlatform("darwin")!;

    it("calls clonefile once on the whole directory and reads a 0 as success", async () => {
      const child = nextChild();
      const result = clone("/src/node_modules", "/wt/.stage/payload", new AbortController().signal);
      child.finish(0, "0\n");

      await expect(result).resolves.toEqual({ ok: true });
      const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
      expect(command).toBe("/usr/bin/osascript");
      expect(args.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
      expect(args[3]).toContain("$.clonefile(argv[0], argv[1], 1)");
      expect(args.slice(4)).toEqual(["/src/node_modules", "/wt/.stage/payload"]);
    });

    it.each([
      ["45", "This volume doesn't support copy-on-write clones"],
      ["18", "It's on a different volume from the worktree"],
      ["17", "It already exists in the worktree"],
    ])("turns errno %s into a skip reason", async (errno, reason) => {
      const child = nextChild();
      const result = clone("/a", "/b", new AbortController().signal);
      child.finish(0, `${errno}\n`);

      await expect(result).resolves.toEqual({ ok: false, reason });
    });

    it("fails closed when osascript itself fails or prints nothing usable", async () => {
      const failed = nextChild();
      const first = clone("/a", "/b", new AbortController().signal);
      failed.finish(1, "", "execution error");
      await expect(first).resolves.toEqual({ ok: false, reason: "osascript exited 1" });

      const garbled = nextChild();
      const second = clone("/a", "/b", new AbortController().signal);
      garbled.finish(0, "undefined\n");
      await expect(second).resolves.toMatchObject({ ok: false });
    });
  });

  describe("Linux: cp --reflink=always", () => {
    const clone = cloneTreeForPlatform("linux")!;

    it("asks cp for a reflink-only archive copy in the C locale", async () => {
      const child = nextChild();
      const result = clone("/src/node_modules", "/wt/.stage/payload", new AbortController().signal);
      child.finish(0);

      await expect(result).resolves.toEqual({ ok: true });
      const [command, args, options] = spawnMock.mock.calls[0] as [
        string,
        string[],
        { env: NodeJS.ProcessEnv },
      ];
      expect(command).toBe("cp");
      expect(args).toEqual([
        "-a",
        "--reflink=always",
        "--",
        "/src/node_modules",
        "/wt/.stage/payload",
      ]);
      expect(options.env.LC_ALL).toBe("C");
    });

    it.each([
      [
        "cp: failed to clone 'x' from 'y': Operation not supported",
        "This filesystem doesn't support copy-on-write clones",
      ],
      [
        "cp: failed to clone 'x' from 'y': Invalid cross-device link",
        "It's on a different volume from the worktree",
      ],
      [
        "cp: unrecognized option '--reflink=always'",
        "This filesystem doesn't support copy-on-write clones",
      ],
      ["cp: something else entirely", "cp --reflink=always exited 1"],
    ])("turns %j into a skip reason", async (stderr, reason) => {
      const child = nextChild();
      const result = clone("/a", "/b", new AbortController().signal);
      child.finish(1, "", stderr);

      await expect(result).resolves.toEqual({ ok: false, reason });
    });
  });

  it("kills the child on abort and settles only once it has exited", async () => {
    const child = nextChild();
    const controller = new AbortController();
    let settled = false;
    const result = cloneTreeForPlatform("linux")!("/a", "/b", controller.signal).then((r) => {
      settled = true;
      return r;
    });

    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(settled).toBe(false);

    child.finish(null);
    await expect(result).resolves.toMatchObject({ ok: false });
    expect(settled).toBe(true);
  });

  it("reports a child that could not be started", async () => {
    const child = nextChild();
    const result = cloneTreeForPlatform("darwin")!("/a", "/b", new AbortController().signal);
    child.emit(
      "error",
      Object.assign(new Error("spawn /usr/bin/osascript ENOENT"), { code: "ENOENT" })
    );
    child.finish(null);

    await expect(result).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^Couldn't start osascript/),
    });
  });
});
