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

  beforeEach(() => {
    vi.clearAllMocks();
    spawnMock.mockReset();
    process.env.SHELL = "/bin/bash";
    process.env.HOME = "/home/tester";
    process.env.CI = "true";
  });

  afterEach(() => {
    process.env.SHELL = originalShell;
    process.env.HOME = originalHome;
    process.env.CI = originalCi;
  });

  it("falls back to default pool size when configured pool size is invalid", () => {
    const pool = new PtyPool({ poolSize: -2 });
    expect(pool.getMaxPoolSize()).toBe(2);
    pool.dispose();
  });

  it("ignores blank cwd updates from setDefaultCwd", async () => {
    spawnMock.mockReturnValue(createFakeProcess(101));
    const pool = new PtyPool({ poolSize: 1, defaultCwd: "/initial" });

    pool.setDefaultCwd("   ");
    await pool.warmPool();

    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ cwd: "/initial" })
    );
    pool.dispose();
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
    expect(spawnOptions.env?.LC_ALL).toBe("en_US.UTF-8");
    pool.dispose();
  });
});
