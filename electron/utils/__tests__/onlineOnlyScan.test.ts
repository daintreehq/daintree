import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOnlineOnlyFindArgs,
  buildOnlineOnlyProbeArgs,
  startOnlineOnlyProbe,
  startOnlineOnlyScan,
} from "../onlineOnlyScan.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

class FakeChild extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  kill = vi.fn();

  print(text: string): void {
    this.stdout.emit("data", Buffer.from(text));
  }
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol("pending");
  return (await Promise.race([promise, Promise.resolve(pending)])) !== pending;
}

describe("online-only scan process handling", () => {
  const root = "/Users/me/Library/CloudStorage/Dropbox/project";
  let child: FakeChild;

  beforeEach(() => {
    vi.useFakeTimers();
    child = new FakeChild();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never finds find on PATH, where a GNU find has no -flags", () => {
    startOnlineOnlyScan(root, "git", { budgetMs: 1_000 });

    const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(command).toBe("/usr/sbin/taskpolicy");
    expect(args.slice(0, 2)).toEqual(["-b", "/usr/bin/find"]);
  });

  it("looks for the dataless flag unless a test says otherwise", () => {
    startOnlineOnlyScan(root, "workingTree", { budgetMs: 1_000 });

    expect(spawnMock.mock.calls[0]?.[1]).toContain("+dataless");
  });

  it("doesn't name .git until a probe has shown the root isn't dataless", () => {
    expect(buildOnlineOnlyProbeArgs(root)).not.toContain(`${root}/.git`);
    expect(buildOnlineOnlyFindArgs(root, "workingTree")).not.toContain(`${root}/.git`);
    expect(buildOnlineOnlyFindArgs(root, "git")).toContain(`${root}/.git`);
  });

  // CI's Ubuntu can't run the real find, so the safety of each expression is pinned here too.
  describe("the expressions that keep a walk out of dataless directories", () => {
    const joined = (args: string[]) => args.join(" ");

    it.each(["git", "workingTree"] as const)(
      "prunes a flagged directory on the %s side",
      (side) => {
        expect(joined(buildOnlineOnlyFindArgs(root, side))).toContain(
          "-flags +dataless ( -type d -print -prune -o -print0 )"
        );
      }
    );

    it("leaves the top-level .git out of the working tree", () => {
      expect(joined(buildOnlineOnlyFindArgs(root, "workingTree"))).toContain(
        "-depth 1 -name .git -prune -o"
      );
    });

    it("doesn't follow a .git symlink through folders nothing has checked", () => {
      const args = buildOnlineOnlyFindArgs(root, "git");
      expect(args[0]).toBe("-P");
      expect(args).not.toContain("-H");
    });

    it("tests the root's flag first, and goes no deeper than the root's own entries", () => {
      const probe = joined(buildOnlineOnlyProbeArgs(root));
      expect(probe).toContain(`${root} -depth 0 -flags +dataless -print0 -prune -o`);
      expect(probe.endsWith("-depth 1 -prune")).toBe(true);
    });

    it("never stops at a mount, which would claim a count of what it skipped", () => {
      for (const args of [
        buildOnlineOnlyProbeArgs(root),
        buildOnlineOnlyFindArgs(root, "git"),
        buildOnlineOnlyFindArgs(root, "workingTree"),
      ]) {
        expect(args).not.toContain("-x");
      }
    });
  });

  it("counts files and directories across chunks, even where a path is split", async () => {
    const pass = startOnlineOnlyScan(root, "workingTree", { budgetMs: 1_000 });

    child.print(`${root}/a\0${root}/b`);
    child.print(`\0${root}/dir\n${root}/c\0`);
    child.emit("close", 0);

    expect(await pass.result).toEqual({ files: 3, directories: 1, complete: true });
    expect(await isSettled(pass.exited)).toBe(true);
  });

  it("keeps the count but withholds completeness on a non-zero exit", async () => {
    const pass = startOnlineOnlyScan(root, "workingTree", { budgetMs: 1_000 });

    child.print(`${root}/a\0`);
    child.emit("close", 1);

    expect(await pass.result).toEqual({ files: 1, directories: 0, complete: false });
  });

  it("doesn't count a path a killed child never finished writing", async () => {
    const pass = startOnlineOnlyScan(root, "workingTree", { budgetMs: 1_000 });

    child.print(`${root}/a\0${root}/half-writ`);
    child.emit("close", null);

    expect(await pass.result).toEqual({ files: 1, directories: 0, complete: false });
  });

  it("reports a spawn failure as unfinished, not as nothing found", async () => {
    const pass = startOnlineOnlyScan(root, "git", { budgetMs: 1_000 });

    child.emit("error", new Error("ENOENT"));

    expect(await pass.result).toEqual({ files: 0, directories: 0, complete: false });
    expect(await isSettled(pass.exited)).toBe(true);
  });

  it("reports a synchronous spawn throw the same way", async () => {
    spawnMock.mockImplementation(() => {
      throw new Error("EAGAIN");
    });

    const pass = startOnlineOnlyScan(root, "git", { budgetMs: 1_000 });

    expect(await pass.result).toEqual({ files: 0, directories: 0, complete: false });
    expect(await isSettled(pass.exited)).toBe(true);
  });

  it("kills at the budget and settles even if the child never goes away", async () => {
    const pass = startOnlineOnlyScan(root, "workingTree", { budgetMs: 1_000 });
    child.print(`${root}/a\0`);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(child.stdout.destroy).toHaveBeenCalled();
    expect(await pass.result).toEqual({ files: 1, directories: 0, complete: false });
    expect(await isSettled(pass.exited)).toBe(false);

    child.print(`${root}/late\0`);
    child.emit("close", null);
    expect(await pass.result).toEqual({ files: 1, directories: 0, complete: false });
    expect(await isSettled(pass.exited)).toBe(true);
  });

  it("stops the budget timer once the child has finished", async () => {
    const pass = startOnlineOnlyScan(root, "git", { budgetMs: 1_000 });

    child.emit("close", 0);
    await pass.result;

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("kills on cancel and clears the budget timer", async () => {
    const pass = startOnlineOnlyScan(root, "git", { budgetMs: 1_000 });

    pass.cancel();

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect((await pass.result).complete).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  describe("probe", () => {
    it.each([
      ["nothing", "", "no-git"],
      ["the root, NUL-ended", `${root}\0`, "root-online-only"],
      [".git, newline-ended", `${root}/.git\n`, "git-directory"],
      [".git, NUL-ended", `${root}/.git\0`, "git-pointer"],
      ["anything else", `${root}/other\0`, "unknown"],
    ])("reads %s from a clean exit", async (_label, printed, shape) => {
      const pass = startOnlineOnlyProbe(root, { budgetMs: 1_000 });

      child.print(printed);
      child.emit("close", 0);

      expect(await pass.result).toBe(shape);
    });

    it("reads a path that arrives in pieces", async () => {
      const pass = startOnlineOnlyProbe(root, { budgetMs: 1_000 });

      child.print(root);
      child.print("/.git\n");
      child.emit("close", 0);

      expect(await pass.result).toBe("git-directory");
    });

    it("knows nothing after a failed exit, even with output in hand", async () => {
      const pass = startOnlineOnlyProbe(root, { budgetMs: 1_000 });

      child.print(`${root}/.git\n`);
      child.emit("close", 1);

      expect(await pass.result).toBe("unknown");
    });

    it("knows nothing when it runs out of time", async () => {
      const pass = startOnlineOnlyProbe(root, { budgetMs: 1_000 });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(await pass.result).toBe("unknown");
    });
  });
});
