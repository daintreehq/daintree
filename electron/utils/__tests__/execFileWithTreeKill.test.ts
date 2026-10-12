import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

const { execMock, treeKillMock } = vi.hoisted(() => ({ execMock: vi.fn(), treeKillMock: vi.fn() }));
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
  killWindowsProcessTreeSync: treeKillMock,
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
});

describe("execFile process tree cleanup", () => {
  it.each(["timeout", "maxBuffer"])(
    "kills the tree before terminating the root on %s",
    async (reason) => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      const order: string[] = [];
      treeKillMock.mockImplementation(() => {
        order.push("tree");
        return { mode: "tree", targeted: [1234], failed: [], stale: [], rootEnded: true };
      });
      const child = new EventEmitter() as ChildProcess;
      Object.defineProperty(child, "pid", { value: 1234 });
      child.kill = vi.fn(() => {
        order.push("root");
        return true;
      });
      execMock.mockImplementation((_file, _args, _options, callback) => {
        setTimeout(() => {
          child.kill();
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
      expect(treeKillMock).toHaveBeenCalledWith(1234, { timeoutMs: 3000 });
    }
  );

  it("keeps the native kill fallback when the tree kill throws", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    treeKillMock.mockImplementation(() => {
      throw new Error("cannot start");
    });
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperty(child, "pid", { value: 1234 });
    const nativeKill = vi.fn(() => true);
    child.kill = nativeKill;
    execMock.mockImplementation((_file, _args, _options, callback) => {
      queueMicrotask(() => {
        child.kill();
        callback(null, "help", "");
      });
      return child;
    });
    expect((await execFileWithTreeKill("cli", [], {})).stdout).toBe("help");
    expect(nativeKill).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
