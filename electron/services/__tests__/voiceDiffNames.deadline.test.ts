import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunGitResult } from "../git/reviewPoint/runGit.js";

const runGitForBytes = vi.hoisted(() => vi.fn());
vi.mock("../git/reviewPoint/runGit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../git/reviewPoint/runGit.js")>()),
  runGitForBytes,
}));

import { GitCommandError, GitTimeoutError } from "../git/reviewPoint/runGit.js";
import { readWorktreeDiffNames } from "../voiceDiffNames.js";

const answer = (text: string): RunGitResult => ({ stdout: Buffer.from(text), exitCode: 0 });
const commands = () => runGitForBytes.mock.calls.map(([, args]) => (args as string[])[0]);

beforeEach(() => {
  runGitForBytes.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("readWorktreeDiffNames's deadline", () => {
  it("answers with nothing at the deadline while git is still running", async () => {
    runGitForBytes.mockReturnValue(new Promise(() => {}));
    expect(await readWorktreeDiffNames("/repo", 20)).toEqual([]);
  });

  it("starts no diff once the deadline has passed", async () => {
    vi.useFakeTimers();
    runGitForBytes.mockImplementation((_cwd: string, args: string[]) =>
      args[0] === "config"
        ? new Promise((resolve) => setTimeout(() => resolve(answer("")), 50))
        : Promise.resolve(answer("abc123\n"))
    );
    const names = readWorktreeDiffNames("/repo", 20);
    await vi.advanceTimersByTimeAsync(60);

    expect(await names).toEqual([]);
    expect(commands()).toEqual(["config", "merge-base"]);
  });

  it("ends the read when the merge base runs out of time, rather than diffing from HEAD", async () => {
    runGitForBytes.mockImplementation((_cwd: string, args: string[]) =>
      args[0] === "merge-base"
        ? Promise.reject(new GitTimeoutError("merge-base"))
        : Promise.resolve(answer(""))
    );

    expect(await readWorktreeDiffNames("/repo", 5_000)).toEqual([]);
    expect(commands()).toEqual(["config", "merge-base"]);
  });

  it("diffs from HEAD when git answers that there is no merge base", async () => {
    runGitForBytes.mockImplementation((_cwd: string, args: string[]) =>
      args[0] === "merge-base"
        ? Promise.reject(new GitCommandError("merge-base", 128, "Not a valid object name"))
        : Promise.resolve(answer(""))
    );

    await readWorktreeDiffNames("/repo", 5_000);
    const diff = runGitForBytes.mock.calls.find(([, args]) => args[0] === "diff-index");
    expect((diff?.[1] as string[]).at(-2)).toBe("HEAD");
  });
});
