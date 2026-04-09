import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PtyPool } from "../PtyPool.js";

const spawnMock = vi.fn();

vi.mock("node-pty", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

interface FakePtyProcess {
  pid?: number;
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  emitExit: (exitCode: number) => void;
}

function createFakeProcess(pid: number | "missing" = 100): FakePtyProcess {
  let onExitHandler: ((event: { exitCode: number }) => void) | null = null;
  const process: FakePtyProcess = {
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn((callback: (event: { exitCode: number }) => void) => {
      onExitHandler = callback;
    }),
    kill: vi.fn(),
    emitExit: (exitCode: number) => {
      onExitHandler?.({ exitCode });
    },
  };
  if (pid !== "missing") {
    process.pid = pid;
  }
  return process;
}

describe("PtyPool", () => {
  const originalShell = process.env.SHELL;
  const originalHome = process.env.HOME;
  const originalCi = process.env.CI;
  const originalLang = process.env.LANG;
  const originalLcAll = process.env.LC_ALL;

  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockReset();
    process.env.SHELL = "/bin/bash";
    process.env.HOME = "/home/tester";
    process.env.CI = "true";
    delete process.env.LANG;
    delete process.env.LC_ALL;
  });

  afterEach(() => {
    process.env.SHELL = originalShell;
    process.env.HOME = originalHome;
    process.env.CI = originalCi;
    if (originalLang !== undefined) process.env.LANG = originalLang;
    else delete process.env.LANG;
    if (originalLcAll !== undefined) process.env.LC_ALL = originalLcAll;
    else delete process.env.LC_ALL;
  });

  it("falls back to default pool size when configured pool size is invalid", () => {
    const pool = new PtyPool({ poolSize: -2 });
    expect(pool.getMaxPoolSize()).toBe(2);
    pool.dispose();
  });

  it("ignores blank cwd updates from drainAndRefill", async () => {
    spawnMock.mockReturnValue(createFakeProcess(101));
    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/initial" });
    await pool.warmPool();

    await pool.drainAndRefill("   ");

    expect(pool.getDefaultCwd()).toBe("/initial");
    // Only the initial warm spawn — drainAndRefill with blank cwd is a no-op.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    pool.dispose();
  });

  it("drainAndRefill repoints pool to new cwd and kills stale entries", async () => {
    const initial = createFakeProcess(601);
    const refilled = createFakeProcess(602);
    spawnMock.mockReturnValueOnce(initial).mockReturnValueOnce(refilled);

    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/home/tester" });
    await pool.warmPool();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    await pool.drainAndRefill("/repo");

    expect(pool.getDefaultCwd()).toBe("/repo");
    expect(initial.kill).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1]?.[2]).toMatchObject({ cwd: "/repo" });
    expect(pool.getPoolSize()).toBe(1);
    pool.dispose();
  });

  it("drainAndRefill short-circuits when already warmed at requested cwd", async () => {
    spawnMock.mockReturnValueOnce(createFakeProcess(701));
    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });
    await pool.warmPool();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    await pool.drainAndRefill("/repo");

    // No drain or extra spawn — pool was already at /repo with poolSize entries.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    pool.dispose();
  });

  it("drainAndRefill suppresses onExit refill of drained entries", async () => {
    const initial = createFakeProcess(801);
    const refilled = createFakeProcess(802);
    spawnMock.mockReturnValueOnce(initial).mockReturnValueOnce(refilled);

    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/home/tester" });
    await pool.warmPool();

    await pool.drainAndRefill("/repo");
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // Simulate onExit firing on the (already killed) initial entry after drain.
    // A naive implementation would call refillPool() → extra spawn at the new cwd.
    // The drain epoch guard must prevent that cascade.
    initial.emitExit(0);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(pool.getPoolSize()).toBe(1);
    pool.dispose();
  });

  it("sequential drainAndRefill calls converge to the last cwd", async () => {
    const first = createFakeProcess(901);
    const second = createFakeProcess(902);
    const third = createFakeProcess(903);
    spawnMock
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
      .mockReturnValueOnce(third);

    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/home/tester" });
    await pool.warmPool();

    await pool.drainAndRefill("/repo-a");
    await pool.drainAndRefill("/repo-b");

    expect(pool.getDefaultCwd()).toBe("/repo-b");
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(spawnMock.mock.calls[2]?.[2]).toMatchObject({ cwd: "/repo-b" });
    expect(first.kill).toHaveBeenCalled();
    expect(second.kill).toHaveBeenCalled();
    pool.dispose();
  });

  it("drainAndRefill is a no-op after dispose", async () => {
    spawnMock.mockReturnValueOnce(createFakeProcess(1001));
    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });
    await pool.warmPool();

    pool.dispose();
    await expect(pool.drainAndRefill("/another")).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("drops dead pooled terminals on acquire and refills the pool", async () => {
    spawnMock
      .mockReturnValueOnce(createFakeProcess("missing"))
      .mockReturnValueOnce(createFakeProcess(202));

    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });
    await pool.warmPool();

    const acquired = pool.acquire();
    expect(acquired).toBeNull();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(pool.getPoolSize()).toBe(1);
    pool.dispose();
  });

  it("refills when a pooled terminal exits unexpectedly", async () => {
    const first = createFakeProcess(301);
    const second = createFakeProcess(302);
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });
    await pool.warmPool();

    first.emitExit(1);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(pool.getPoolSize()).toBe(1);
    pool.dispose();
  });

  it("sanitizes spawn environment", async () => {
    spawnMock.mockReturnValue(createFakeProcess(401));
    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });

    await pool.warmPool();

    const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> };
    expect(spawnOptions.env?.CI).toBeUndefined();
    expect(spawnOptions.env?.TERM).toBe("xterm-256color");
    expect(spawnOptions.env?.COLORTERM).toBe("truecolor");
    expect(spawnOptions.env?.LANG).toBe("en_US.UTF-8");
    expect(spawnOptions.env?.LC_ALL).toBeUndefined();
    pool.dispose();
  });

  it("preserves user's UTF-8 LANG instead of overriding to en_US", async () => {
    process.env.LANG = "ja_JP.UTF-8";
    spawnMock.mockReturnValue(createFakeProcess(501));
    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });

    await pool.warmPool();

    const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> };
    expect(spawnOptions.env?.LANG).toBe("ja_JP.UTF-8");
    pool.dispose();
  });

  it("falls back to en_US.UTF-8 when LANG is non-UTF-8", async () => {
    process.env.LANG = "C";
    spawnMock.mockReturnValue(createFakeProcess(502));
    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/repo" });

    await pool.warmPool();

    const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> };
    expect(spawnOptions.env?.LANG).toBe("en_US.UTF-8");
    pool.dispose();
  });
});
