import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args) as unknown,
}));

const { isChildTreeAlive, reapPendingChildTrees, scheduleChildTreeEscalation, signalChildTree } =
  await import("../pluginChildTree.js");

function makeChild(opts: { pid?: number; ownsProcessTree?: boolean } = {}) {
  return {
    pid: opts.pid ?? 5150,
    ownsProcessTree: opts.ownsProcessTree,
    kill: vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true),
  };
}

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("pluginChildTree (#13173)", () => {
  const originalPlatform = process.platform;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setPlatform("linux");
    spawnMock.mockReset();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    reapPendingChildTrees();
    killSpy.mockRestore();
    setPlatform(originalPlatform);
    vi.useRealTimers();
  });

  it("only ever kills the direct child of a handle that does not own its tree", () => {
    const child = makeChild();
    signalChildTree(child, "SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    // A fake PID must never reach a real process group.
    expect(killSpy).not.toHaveBeenCalled();
    expect(isChildTreeAlive(child)).toBe(false);
  });

  it("SIGTERMs then SIGCONTs the child's whole process group on POSIX", () => {
    const child = makeChild({ ownsProcessTree: true });
    signalChildTree(child, "SIGTERM");
    expect(killSpy.mock.calls).toEqual([
      [-5150, "SIGTERM"],
      [-5150, "SIGCONT"],
    ]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("SIGKILLs the group without a trailing SIGCONT", () => {
    const child = makeChild({ ownsProcessTree: true });
    signalChildTree(child, "SIGKILL");
    expect(killSpy.mock.calls).toEqual([[-5150, "SIGKILL"]]);
  });

  it("falls back to the direct child when the group signal fails", () => {
    killSpy.mockImplementation(() => {
      throw errno("ESRCH");
    });
    const child = makeChild({ ownsProcessTree: true });
    signalChildTree(child, "SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("never signals a group for an invalid pid", () => {
    const child = makeChild({ ownsProcessTree: true, pid: 1 });
    signalChildTree(child, "SIGKILL");
    expect(killSpy).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("reports the group alive while any member answers signal 0", () => {
    const child = makeChild({ ownsProcessTree: true });
    expect(isChildTreeAlive(child)).toBe(true);
    expect(killSpy).toHaveBeenLastCalledWith(-5150, 0);

    killSpy.mockImplementation(() => {
      throw errno("EPERM");
    });
    expect(isChildTreeAlive(child)).toBe(true);

    killSpy.mockImplementation(() => {
      throw errno("ESRCH");
    });
    expect(isChildTreeAlive(child)).toBe(false);
  });

  it("SIGKILLs group survivors after the grace window even once the leader is gone", () => {
    vi.useFakeTimers();
    const child = makeChild({ ownsProcessTree: true });
    scheduleChildTreeEscalation(child, 3_000);
    vi.advanceTimersByTime(2_999);
    expect(killSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(killSpy.mock.calls).toEqual([
      [-5150, 0],
      [-5150, "SIGKILL"],
    ]);
  });

  it("skips the escalation when the group is already empty or the fence says no", () => {
    vi.useFakeTimers();
    const fenced = makeChild({ ownsProcessTree: true, pid: 600 });
    scheduleChildTreeEscalation(fenced, 100, () => false);
    vi.advanceTimersByTime(100);
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockImplementation(() => {
      throw errno("ESRCH");
    });
    const gone = makeChild({ ownsProcessTree: true, pid: 601 });
    scheduleChildTreeEscalation(gone, 100);
    vi.advanceTimersByTime(100);
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(-601, 0);
  });

  it("lets quit SIGKILL trees still inside their grace window", () => {
    vi.useFakeTimers();
    const child = makeChild({ ownsProcessTree: true, pid: 700 });
    scheduleChildTreeEscalation(child, 3_000);
    reapPendingChildTrees();
    expect(killSpy).toHaveBeenCalledWith(-700, "SIGKILL");
    killSpy.mockClear();
    // Reaped once — the timer that later fires has nothing left to own.
    reapPendingChildTrees();
    expect(killSpy).not.toHaveBeenCalled();
  });

  describe("on Windows", () => {
    beforeEach(() => {
      setPlatform("win32");
    });

    it("runs taskkill /T before the direct kill, which would erase the parent links", () => {
      const taskkill = new EventEmitter();
      spawnMock.mockReturnValue(taskkill);
      const child = makeChild({ ownsProcessTree: true });
      signalChildTree(child, "SIGTERM");
      expect(spawnMock).toHaveBeenCalledWith(
        "taskkill",
        ["/T", "/F", "/PID", "5150"],
        expect.objectContaining({ windowsHide: true, timeout: 3000 })
      );
      expect(child.kill).not.toHaveBeenCalled();
      taskkill.emit("exit", 0);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(killSpy).not.toHaveBeenCalled();
    });

    it("still kills the direct child when taskkill cannot run", () => {
      const taskkill = new EventEmitter();
      spawnMock.mockReturnValue(taskkill);
      const child = makeChild({ ownsProcessTree: true });
      signalChildTree(child, "SIGKILL");
      taskkill.emit("error", new Error("ENOENT"));
      taskkill.emit("exit", 1);
      expect(child.kill).toHaveBeenCalledTimes(1);
    });

    it("never schedules a group escalation", () => {
      vi.useFakeTimers();
      const child = makeChild({ ownsProcessTree: true });
      scheduleChildTreeEscalation(child, 100);
      vi.advanceTimersByTime(100);
      reapPendingChildTrees();
      expect(spawnMock).not.toHaveBeenCalled();
      expect(isChildTreeAlive(child)).toBe(false);
    });
  });
});
