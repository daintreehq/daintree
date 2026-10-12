import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const treeKillMock = vi.fn();

vi.mock("../../../utils/windowsTreeKill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/windowsTreeKill.js")>()),
  killWindowsProcessTree: (...args: unknown[]) => treeKillMock(...args) as unknown,
}));

const {
  drainPendingChildTrees,
  isChildTreeAlive,
  reapChildTreeAfterExit,
  reapPendingChildTrees,
  scheduleChildTreeEscalation,
  signalChildTree,
} = await import("../pluginChildTree.js");

function makeChild(opts: { pid?: number; ownsProcessTree?: boolean } = {}) {
  return {
    pid: "pid" in opts ? opts.pid : 5150,
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
    treeKillMock.mockReset();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    reapPendingChildTrees();
    vi.clearAllTimers();
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

  it.each([undefined, 0, 1])("never signals a group for pid %s", (pid) => {
    // An undefined pid is a spawn that failed (ENOENT) — there is no group.
    const child = makeChild({ ownsProcessTree: true, pid });
    signalChildTree(child, "SIGKILL");
    expect(killSpy).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(isChildTreeAlive(child)).toBe(false);
  });

  it("falls back to the direct child when the group signal is refused", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      killSpy.mockImplementation(() => {
        throw errno("EPERM");
      });
      const child = makeChild({ ownsProcessTree: true });
      signalChildTree(child, "SIGKILL");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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
    scheduleChildTreeEscalation(child, "process", 3_000);
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
    scheduleChildTreeEscalation(fenced, "process", 100, () => false);
    vi.advanceTimersByTime(100);
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockImplementation(() => {
      throw errno("ESRCH");
    });
    const gone = makeChild({ ownsProcessTree: true, pid: 601 });
    scheduleChildTreeEscalation(gone, "process", 100);
    vi.advanceTimersByTime(100);
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(-601, 0);
  });

  it("lets quit SIGKILL trees still inside their grace window", () => {
    vi.useFakeTimers();
    const child = makeChild({ ownsProcessTree: true, pid: 700 });
    scheduleChildTreeEscalation(child, "process", 3_000);
    reapPendingChildTrees();
    expect(killSpy).toHaveBeenCalledWith(-700, "SIGKILL");
    killSpy.mockClear();
    // Reaped once — the timer that later fires has nothing left to own.
    reapPendingChildTrees();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("reaps what a root that exited on its own left in its group", () => {
    vi.useFakeTimers();
    const child = makeChild({ ownsProcessTree: true, pid: 800 });
    reapChildTreeAfterExit(child, "process", 1_000);
    expect(killSpy.mock.calls).toEqual([
      [-800, 0],
      [-800, "SIGTERM"],
      [-800, "SIGCONT"],
    ]);
    vi.advanceTimersByTime(1_000);
    expect(killSpy).toHaveBeenLastCalledWith(-800, "SIGKILL");
  });

  it("leaves an emptied group alone after its root's natural exit", () => {
    killSpy.mockImplementation(() => {
      throw errno("ESRCH");
    });
    const child = makeChild({ ownsProcessTree: true, pid: 801 });
    reapChildTreeAfterExit(child, "process", 1_000);
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("honours the escalation fence at quit as well as on the timer", () => {
    vi.useFakeTimers();
    const child = makeChild({ ownsProcessTree: true, pid: 900 });
    scheduleChildTreeEscalation(child, "process", 3_000, () => false);
    reapPendingChildTrees();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("drains pending trees: waits for them to empty, then reaps any survivor", async () => {
    vi.useFakeTimers();
    let alive = true;
    killSpy.mockImplementation(((pid: number, signal?: unknown) => {
      if (signal === 0 && (pid === -950 || !alive)) throw errno("ESRCH");
      return true;
    }) as typeof process.kill);
    const quitting = makeChild({ ownsProcessTree: true, pid: 951 });
    scheduleChildTreeEscalation(quitting, "process", 10_000);
    let drained = false;
    const done = drainPendingChildTrees("process", 3_000).then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(drained).toBe(false);
    alive = false;
    await vi.advanceTimersByTimeAsync(50);
    await done;
    expect(killSpy).not.toHaveBeenCalledWith(-951, "SIGKILL");

    alive = true;
    const stubborn = makeChild({ ownsProcessTree: true, pid: 952 });
    scheduleChildTreeEscalation(stubborn, "process", 10_000);
    const bounded = drainPendingChildTrees("process", 3_000);
    await vi.advanceTimersByTimeAsync(3_050);
    await bounded;
    expect(killSpy).toHaveBeenCalledWith(-952, "SIGKILL");
  });

  it("reaps only the asking owner's trees, leaving another's grace window intact", () => {
    vi.useFakeTimers();
    const mine = makeChild({ ownsProcessTree: true, pid: 960 });
    const theirs = makeChild({ ownsProcessTree: true, pid: 961 });
    scheduleChildTreeEscalation(mine, "process", 3_000);
    scheduleChildTreeEscalation(theirs, "mcp", 3_000);
    reapPendingChildTrees("process");
    expect(killSpy).toHaveBeenCalledWith(-960, "SIGKILL");
    expect(killSpy).not.toHaveBeenCalledWith(-961, "SIGKILL");
    vi.advanceTimersByTime(3_000);
    expect(killSpy).toHaveBeenCalledWith(-961, "SIGKILL");
  });

  describe("on Windows", () => {
    beforeEach(() => {
      setPlatform("win32");
    });

    it("runs the verified tree kill before the direct kill, which ends its root", async () => {
      let finishTreeKill!: () => void;
      treeKillMock.mockReturnValue(
        new Promise<void>((resolve) => {
          finishTreeKill = resolve;
        })
      );
      const child = makeChild({ ownsProcessTree: true });
      signalChildTree(child, "SIGTERM");
      expect(treeKillMock).toHaveBeenCalledWith(5150, { timeoutMs: 3000 });
      await Promise.resolve();
      expect(child.kill).not.toHaveBeenCalled();
      finishTreeKill();
      await vi.waitFor(() => expect(child.kill).toHaveBeenCalledTimes(1));
      expect(killSpy).not.toHaveBeenCalled();
    });

    it("still kills the direct child when the tree kill fails", async () => {
      treeKillMock.mockRejectedValue(new Error("ENOENT"));
      const child = makeChild({ ownsProcessTree: true });
      signalChildTree(child, "SIGKILL");
      await vi.waitFor(() => expect(child.kill).toHaveBeenCalledTimes(1));
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    });

    it("ends an exited child directly, never tree-killing its reusable PID", () => {
      const child = { ...makeChild({ ownsProcessTree: true }), exitCode: 0 };
      signalChildTree(child, "SIGKILL");
      expect(treeKillMock).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    });

    it("never schedules a group escalation", () => {
      vi.useFakeTimers();
      const child = makeChild({ ownsProcessTree: true });
      scheduleChildTreeEscalation(child, "process", 100);
      vi.advanceTimersByTime(100);
      reapPendingChildTrees();
      expect(treeKillMock).not.toHaveBeenCalled();
      expect(isChildTreeAlive(child)).toBe(false);
    });
  });
});
