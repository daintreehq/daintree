import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

const { execMock, treeKillMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  treeKillMock: vi.fn<(target: unknown, tag: string, options: unknown) => Promise<unknown>>(),
}));
vi.mock("child_process", () => {
  // Node's execFile has a custom promisifier that retains .child and both streams.
  Object.defineProperty(execMock, Symbol.for("nodejs.util.promisify.custom"), {
    value: (...args: unknown[]) => {
      let child: ChildProcess;
      const pending = new Promise((resolve, reject) => {
        child = execMock(...args, (error: Error | null, stdout: string, stderr: string) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
      });
      return Object.assign(pending, { child: child! });
    },
  });
  return { execFile: execMock, spawnSync: vi.fn() };
});
vi.mock("../windowsTreeKill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../windowsTreeKill.js")>()),
  killWindowsProcessTreeInBackground: treeKillMock,
}));
import { execFileWithTreeKill } from "../execFileWithTreeKill.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.useRealTimers();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
});

function makeChild(order: string[] = []) {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, "pid", { value: 1234 });
  Object.defineProperty(child, "exitCode", { value: null, configurable: true });
  Object.defineProperty(child, "signalCode", { value: null });
  const nativeKill = vi.fn(() => {
    order.push("root");
    return true;
  });
  child.kill = nativeKill;
  return { child, nativeKill };
}

describe("execFile process tree cleanup", () => {
  it.each(["timeout", "maxBuffer"])(
    "kills the tree, then the root, on %s, without blocking",
    async (reason) => {
      const order: string[] = [];
      treeKillMock.mockImplementation(async () => {
        order.push("tree");
        return null;
      });
      const { child } = makeChild(order);
      execMock.mockImplementation((_file, _args, _options, callback) => {
        setTimeout(() => {
          // What Node's execFile does on a timeout or overflow.
          expect(child.kill()).toBe(true);
          callback(
            Object.assign(new Error(reason), {
              killed: true,
              code: reason === "maxBuffer" ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : "ETIMEDOUT",
            })
          );
        }, 10);
        return child;
      });

      const pending = execFileWithTreeKill("cli", ["--help"], { timeout: 10, maxBuffer: 10 });
      const rejection = expect(pending).rejects.toThrow(reason);
      await vi.advanceTimersByTimeAsync(10);
      await rejection;

      expect(order).toEqual(["tree", "root"]);
      expect(treeKillMock).toHaveBeenCalledWith({ pid: 1234, ownChild: true }, "[CLI probe]", {
        timeoutMs: 3000,
      });
    }
  );

  it("keeps the root alive, and the call non-blocking, while the tree kill runs", () => {
    treeKillMock.mockReturnValue(new Promise(() => {}));
    const { child, nativeKill } = makeChild();
    execMock.mockImplementation(() => child);

    void execFileWithTreeKill("cli", [], {}).catch(() => {});
    expect(child.kill()).toBe(true);
    expect(child.kill()).toBe(true);

    // The walk starts from the live root, so the native kill waits for it.
    expect(nativeKill).not.toHaveBeenCalled();
    expect(treeKillMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the native kill fallback when the tree kill fails", async () => {
    treeKillMock.mockRejectedValue(new Error("cannot start"));
    const { child, nativeKill } = makeChild();
    execMock.mockImplementation((_file, _args, _options, callback) => {
      queueMicrotask(() => {
        child.kill();
        callback(null, "help", "");
      });
      return child;
    });

    expect((await execFileWithTreeKill("cli", [], {})).stdout).toBe("help");
    await vi.advanceTimersByTimeAsync(0);
    expect(nativeKill).toHaveBeenCalled();
  });

  it("never tree-kills a root that has already exited, whose PID may be reused", () => {
    const { child, nativeKill } = makeChild();
    Object.defineProperty(child, "exitCode", { value: 0 });
    execMock.mockImplementation(() => child);

    void execFileWithTreeKill("cli", [], {}).catch(() => {});
    child.kill();

    expect(treeKillMock).not.toHaveBeenCalled();
    expect(nativeKill).toHaveBeenCalledTimes(1);
  });

  it("leaves execFile's own kill alone off Windows", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const { child, nativeKill } = makeChild();
    execMock.mockImplementation((_file, _args, _options, callback) => {
      queueMicrotask(() => {
        child.kill();
        callback(null, "ok", "");
      });
      return child;
    });

    await execFileWithTreeKill("cli", [], {});

    expect(nativeKill).toHaveBeenCalledTimes(1);
    expect(treeKillMock).not.toHaveBeenCalled();
  });
});
