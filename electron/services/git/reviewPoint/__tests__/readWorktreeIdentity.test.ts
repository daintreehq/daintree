import { beforeEach, describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import { readWorktreeIdentity } from "../readWorktreeIdentity.js";
import { runGitForBytes, type RunGitResult } from "../runGit.js";

vi.mock("../runGit.js", () => ({ runGitForBytes: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("readWorktreeIdentity command lifecycle", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([0, 1])("waits for the other Git command when command %i fails", async (failed) => {
    const commands = [deferred<RunGitResult>(), deferred<RunGitResult>()];
    vi.mocked(runGitForBytes)
      .mockReturnValueOnce(commands[0].promise)
      .mockReturnValueOnce(commands[1].promise);
    const error = new Error("not a repository");
    const settled = vi.fn();
    const identity = readWorktreeIdentity("/plain", { timeoutMs: 10_000 });
    void identity.then(settled, settled);

    commands[failed].reject(error);
    await setImmediate();
    expect(settled).not.toHaveBeenCalled();

    commands[1 - failed].resolve({ stdout: Buffer.alloc(0), exitCode: 0 });
    await expect(identity).rejects.toBe(error);
  });

  it("preserves the first failure when the other command also fails", async () => {
    const located = deferred<RunGitResult>();
    const head = deferred<RunGitResult>();
    vi.mocked(runGitForBytes)
      .mockReturnValueOnce(located.promise)
      .mockReturnValueOnce(head.promise);
    const first = new Error("symbolic-ref failed first");
    const settled = vi.fn();
    const identity = readWorktreeIdentity("/plain", { timeoutMs: 10_000 });
    void identity.then(settled, settled);

    head.reject(first);
    await setImmediate();
    expect(settled).not.toHaveBeenCalled();

    located.reject(new Error("rev-parse also failed"));
    await expect(identity).rejects.toBe(first);
  });
});
