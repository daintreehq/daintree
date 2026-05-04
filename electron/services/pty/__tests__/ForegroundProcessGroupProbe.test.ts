import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ScheduledCall {
  cmd: string;
  args: readonly string[] | null | undefined;
  options: Record<string, unknown>;
  resolve: (stdout: string) => void;
  reject: (err: Error) => void;
}

// `node-util.promisify(execFile)` resolves with `{ stdout, stderr }` because
// the real `child_process.execFile` carries `[util.promisify.custom]`. Mirror
// that symbol on the mock so the probe sees the same shape.
const execFileMock = vi.hoisted(() => {
  const util = require("node:util") as typeof import("node:util");
  const calls: ScheduledCall[] = [];
  const fn = (..._args: unknown[]) => {
    throw new Error("execFile mock was called with callback form (unexpected)");
  };
  Object.defineProperty(fn, util.promisify.custom, {
    value: (
      cmd: string,
      args: readonly string[] | null | undefined,
      options: Record<string, unknown>
    ) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        calls.push({
          cmd,
          args,
          options,
          resolve: (stdout) => resolve({ stdout, stderr: "" }),
          reject: (err) => reject(err),
        });
      }),
  });
  return Object.assign(fn, { calls });
});

vi.mock("child_process", () => ({
  execFile: execFileMock,
}));

const { ForegroundProcessGroupProbe } = await import("../ForegroundProcessGroupProbe.js");

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

interface MutableHost {
  ptyPid: number | undefined;
  disposed: boolean;
}

function createHost(overrides: Partial<MutableHost> = {}): MutableHost {
  return { ptyPid: 12345, disposed: false, ...overrides };
}

async function flush(): Promise<void> {
  // Microtask drain — the probe schedules `await execFileAsync(...)` then
  // writes back synchronously after the resolved callback fires.
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe("ForegroundProcessGroupProbe", () => {
  beforeEach(() => {
    execFileMock.calls.length = 0;
    setPlatform("darwin");
  });

  afterEach(() => {
    setPlatform(realPlatform);
  });

  it("returns null on win32 without invoking ps", () => {
    setPlatform("win32");
    const probe = new ForegroundProcessGroupProbe(createHost());
    expect(probe.readSnapshot()).toBeNull();
    expect(execFileMock.calls).toHaveLength(0);
  });

  it("returns null when ptyPid is undefined", () => {
    const probe = new ForegroundProcessGroupProbe(createHost({ ptyPid: undefined }));
    expect(probe.readSnapshot()).toBeNull();
    expect(execFileMock.calls).toHaveLength(0);
  });

  it("returns the warm-up sentinel on first read while probe is in flight", () => {
    const probe = new ForegroundProcessGroupProbe(createHost());
    const snapshot = probe.readSnapshot();
    expect(snapshot).toEqual({ shellPgid: 1, foregroundPgid: 2 });
    expect(execFileMock.calls).toHaveLength(1);
    expect(execFileMock.calls[0]!.cmd).toBe("ps");
    expect(execFileMock.calls[0]!.args).toEqual(["-o", "pgid=,tpgid=", "-p", "12345"]);
  });

  it("publishes the parsed snapshot once the probe resolves", async () => {
    const probe = new ForegroundProcessGroupProbe(createHost());
    probe.readSnapshot(); // schedule the probe
    execFileMock.calls[0]!.resolve("4242 4243\n");
    await flush();

    expect(probe.readSnapshot()).toEqual({ shellPgid: 4242, foregroundPgid: 4243 });
  });

  it("persists null when ps fails (process exited / abort) so callers fall back", async () => {
    const probe = new ForegroundProcessGroupProbe(createHost());
    probe.readSnapshot();
    execFileMock.calls[0]!.reject(new Error("kill: no such process"));
    await flush();

    // Cache is now non-empty (updatedAt > 0) with snapshot=null. Within
    // soft-stale, callers see null and fall back to the legacy prompt path.
    expect(probe.readSnapshot()).toBeNull();
  });

  it("returns null past the hard-max age and triggers a background refresh", async () => {
    vi.useFakeTimers();
    try {
      const probe = new ForegroundProcessGroupProbe(createHost());
      probe.readSnapshot();
      execFileMock.calls[0]!.resolve("100 101\n");
      await flush();

      // Within fresh window
      expect(probe.readSnapshot()).toEqual({ shellPgid: 100, foregroundPgid: 101 });

      // Advance past hard-max (1500ms)
      vi.advanceTimersByTime(1600);

      // Past max age -> null returned, but a refresh should have been scheduled.
      const stale = probe.readSnapshot();
      expect(stale).toBeNull();
      expect(execFileMock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedules a background refresh once past soft-stale but keeps returning the cached value", async () => {
    vi.useFakeTimers();
    try {
      const probe = new ForegroundProcessGroupProbe(createHost());
      probe.readSnapshot();
      execFileMock.calls[0]!.resolve("100 101\n");
      await flush();

      const callsBefore = execFileMock.calls.length;
      vi.advanceTimersByTime(600); // past soft-stale (500ms), within hard-max (1500ms)

      // Soft-stale read returns cached value AND triggers refresh
      expect(probe.readSnapshot()).toEqual({ shellPgid: 100, foregroundPgid: 101 });
      expect(execFileMock.calls.length).toBe(callsBefore + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses snapshot writeback when host is disposed before probe resolves", async () => {
    const host = createHost();
    const probe = new ForegroundProcessGroupProbe(host);
    probe.readSnapshot(); // schedules probe, returns sentinel
    host.disposed = true;
    execFileMock.calls[0]!.resolve("999 1000\n");
    await flush();

    // Disposed guard kept updatedAt at 0, so subsequent reads still see
    // hasEverProbed === false → sentinel (and a fresh probe is scheduled).
    expect(probe.readSnapshot()).toEqual({ shellPgid: 1, foregroundPgid: 2 });
  });

  it("ignores malformed ps output (NaN parse)", async () => {
    const probe = new ForegroundProcessGroupProbe(createHost());
    probe.readSnapshot();
    execFileMock.calls[0]!.resolve("not-a-number garbage\n");
    await flush();

    // Parsed as NaN → snapshot stays null but updatedAt is set.
    expect(probe.readSnapshot()).toBeNull();
  });
});
