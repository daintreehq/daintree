// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

const execFileMock = vi.hoisted(() => vi.fn());
const fsMock = vi.hoisted(() => ({
  lstat: vi.fn(async () => ({ isDirectory: () => true, blocks: 0 })),
  readdir: vi.fn(async () => []),
}));

vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("node:fs/promises", () => ({ default: fsMock, ...fsMock }));

import { measureDirectorySize } from "../DirectoryDiskUsage.js";

function exitError(code: number): Error {
  return Object.assign(new Error(`Command failed with ${code}`), { code });
}

function answerWith(error: Error | null, stdout: string, stderr = ""): void {
  execFileMock.mockImplementation(
    (_file: string, _args: string[], _opts: unknown, callback: ExecCallback) => {
      queueMicrotask(() => callback(error, stdout, stderr));
      return {};
    }
  );
}

describe("measureDirectorySize — du outcomes", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("runs one du over the root with a grand total, in the C locale, without following symlinks", async () => {
    answerWith(null, "8\t/repo\n8\ttotal\n");
    expect(await measureDirectorySize("/repo", { platform: "linux" })).toBe(8 * 1024);
    const [file, args, opts] = execFileMock.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(file).toBe("du");
    expect(args).toEqual(["-skc", "--", "/repo"]);
    expect(args.some((arg) => /^-[a-zA-Z]*[LH]/.test(arg))).toBe(false);
    expect(opts.env.LC_ALL).toBe("C");
  });

  it("accepts a total when the only complaints are entries that vanished mid-scan", async () => {
    answerWith(
      exitError(1),
      "8\t/repo\n8\ttotal\n",
      "du: cannot access '/repo/.next/tmp': No such file or directory\ndu: /repo/dist/x: No such file or directory\n"
    );
    expect(await measureDirectorySize("/repo", { platform: "linux" })).toBe(8 * 1024);
  });

  it("answers null when part of the tree went uncounted", async () => {
    answerWith(
      exitError(1),
      "8\t/repo\n8\ttotal\n",
      "du: cannot read directory '/repo/secret': Permission denied\n"
    );
    expect(await measureDirectorySize("/repo", { platform: "linux" })).toBeNull();
  });

  it("answers null when du fails without saying why, or prints no total", async () => {
    answerWith(exitError(1), "8\t/repo\n8\ttotal\n", "");
    expect(await measureDirectorySize("/repo", { platform: "linux" })).toBeNull();
    answerWith(null, "8\t/repo\n");
    expect(await measureDirectorySize("/repo", { platform: "linux" })).toBeNull();
  });

  it("answers null when du could not be started", async () => {
    answerWith(Object.assign(new Error("spawn du ENOENT"), { code: "ENOENT" }), "", "");
    expect(await measureDirectorySize("/repo", { platform: "linux" })).toBeNull();
  });

  it("hands du the abort signal with a hard kill, and answers null once aborted", async () => {
    const controller = new AbortController();
    execFileMock.mockImplementation(
      (_file: string, _args: string[], opts: { signal: AbortSignal }, callback: ExecCallback) => {
        opts.signal.addEventListener("abort", () =>
          callback(Object.assign(new Error("aborted"), { name: "AbortError" }), "", "")
        );
        return {};
      }
    );
    const pending = measureDirectorySize("/repo", {
      platform: "linux",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalled());
    const opts = execFileMock.mock.calls[0][2] as { killSignal: string; signal: AbortSignal };
    expect(opts.killSignal).toBe("SIGKILL");
    controller.abort();
    expect(await pending).toBeNull();
  });
});
