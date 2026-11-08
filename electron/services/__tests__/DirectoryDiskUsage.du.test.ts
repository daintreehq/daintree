// @vitest-environment node
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const fsMock = vi.hoisted(() => ({
  lstat: vi.fn(async () => ({ isDirectory: () => true, blocks: 0 })),
  readdir: vi.fn(async () => []),
}));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("node:fs/promises", () => ({ default: fsMock, ...fsMock }));

import { measureDirectorySize } from "../DirectoryDiskUsage.js";

class FakeChild extends EventEmitter {
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  readonly kill = vi.fn((_signal?: string) => true);
  readonly pid: number | undefined;
  /** `started: false` is a spawn that failed: no pid, and an `error` to come. */
  constructor(started = true) {
    super();
    this.pid = started ? 1234 : undefined;
  }
  finish(code: number | null, stdout = ""): void {
    if (stdout) this.stdout.emit("data", stdout);
    this.emit("close", code);
  }
}

/** Each spawn answers with the next scripted exit. */
function script(...runs: Array<{ code: number; stdout?: string }>): FakeChild[] {
  const children: FakeChild[] = [];
  spawnMock.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    const run = runs[children.length - 1];
    if (run) queueMicrotask(() => child.finish(run.code, run.stdout));
    return child;
  });
  return children;
}

describe("measureDirectorySize — du outcomes", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("runs one du over the root with a grand total, in the C locale, without following symlinks", async () => {
    script({ code: 0, stdout: "8\t/repo\n8\ttotal\n" });
    expect(await measureDirectorySize("/repo", { platform: "linux" })).toBe(8 * 1024);
    const [file, args, opts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(file).toBe("du");
    expect(args).toEqual(["-skc", "--", "/repo"]);
    expect(args.some((arg) => /^-[a-zA-Z]*[LH]/.test(arg))).toBe(false);
    expect(opts.env.LC_ALL).toBe("C");
  });

  it("reads only the closing total, however long the per-operand output", async () => {
    const perOperand = Array.from({ length: 2_000 }, (_, i) => `1\t/repo/f${i}\n`).join("");
    script({ code: 0, stdout: `${perOperand}2000\ttotal\n` });
    expect(await measureDirectorySize("/repo", { platform: "linux" })).toBe(2000 * 1024);
  });

  it("retries a du that skipped something, and takes the clean second run", async () => {
    script(
      { code: 1, stdout: "8\t/repo\n8\ttotal\n" },
      { code: 0, stdout: "6\t/repo\n6\ttotal\n" }
    );
    expect(await measureDirectorySize("/repo", { platform: "linux" })).toBe(6 * 1024);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("answers null, not a partial total, when du keeps skipping part of the tree", async () => {
    script(
      { code: 1, stdout: "8\t/repo\n8\ttotal\n" },
      { code: 1, stdout: "8\t/repo\n8\ttotal\n" }
    );
    expect(await measureDirectorySize("/repo", { platform: "linux" })).toBeNull();
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("answers null when du prints no total", async () => {
    script({ code: 0, stdout: "8\t/repo\n" }, { code: 0, stdout: "" });
    expect(await measureDirectorySize("/repo", { platform: "linux" })).toBeNull();
  });

  it("answers null when du can't be started", async () => {
    spawnMock.mockImplementation(() => {
      const child = new FakeChild(false);
      queueMicrotask(() => child.emit("error", new Error("spawn du ENOENT")));
      return child;
    });
    expect(await measureDirectorySize("/repo", { platform: "linux" })).toBeNull();
  });

  it("kills du outright on abort and settles only once it has exited", async () => {
    const children = script();
    const controller = new AbortController();
    let settled = false;
    const pending = measureDirectorySize("/repo", {
      platform: "linux",
      signal: controller.signal,
    }).then((value) => {
      settled = true;
      return value;
    });
    await vi.waitFor(() => expect(children).toHaveLength(1));

    controller.abort();
    expect(children[0].kill).toHaveBeenCalledWith("SIGKILL");
    await Promise.resolve();
    expect(settled).toBe(false);

    children[0].finish(null);
    expect(await pending).toBeNull();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
