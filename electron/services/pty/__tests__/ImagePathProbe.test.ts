import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ScheduledCall {
  cmd: string;
  args: readonly string[] | null | undefined;
  options: Record<string, unknown>;
  resolve: (stdout: string) => void;
  reject: (err: Error) => void;
}

const execFileMock = vi.hoisted(() => {
  const calls: ScheduledCall[] = [];
  const fn = (..._args: unknown[]) => {
    throw new Error("execFile mock was called with callback form (unexpected)");
  };
  Object.defineProperty(fn, Symbol.for("nodejs.util.promisify.custom"), {
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

const readlinkMock = vi.hoisted(() => {
  const queue: Array<{ resolve: (value: string) => void; reject: (err: Error) => void }> = [];
  const calls: string[] = [];
  const fn = (target: string) => {
    calls.push(target);
    return new Promise<string>((resolve, reject) => {
      queue.push({ resolve, reject });
    });
  };
  return Object.assign(fn, { queue, calls });
});

vi.mock("child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("node:fs/promises", () => ({
  readlink: readlinkMock,
}));

const { ImagePathProbe } = await import("../ImagePathProbe.js");

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

async function flush(): Promise<void> {
  // Drain microtasks so the async refresh writes back into the cache before
  // we make the next synchronous read.
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("ImagePathProbe", () => {
  beforeEach(() => {
    execFileMock.calls.length = 0;
    readlinkMock.queue.length = 0;
    readlinkMock.calls.length = 0;
    setPlatform("linux");
  });

  afterEach(() => {
    setPlatform(realPlatform);
  });

  it("returns null on first read while the probe is in flight", () => {
    const probe = new ImagePathProbe();
    expect(probe.readBasename(123)).toBeNull();
    expect(readlinkMock.calls).toEqual(["/proc/123/exe"]);
  });

  it("returns null for invalid PIDs without scheduling a probe", () => {
    const probe = new ImagePathProbe();
    expect(probe.readBasename(0)).toBeNull();
    expect(probe.readBasename(-1)).toBeNull();
    expect(probe.readBasename(Number.NaN)).toBeNull();
    expect(readlinkMock.calls).toHaveLength(0);
  });

  it("returns null on unsupported platforms", () => {
    setPlatform("freebsd" as NodeJS.Platform);
    const probe = new ImagePathProbe();
    expect(probe.readBasename(123)).toBeNull();
    expect(readlinkMock.calls).toHaveLength(0);
    expect(execFileMock.calls).toHaveLength(0);
  });

  describe("Linux", () => {
    it("publishes the lowercased basename from /proc/<pid>/exe", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(123);
      readlinkMock.queue[0]!.resolve("/opt/homebrew/bin/claude");
      await flush();

      expect(probe.readBasename(123)).toBe("claude");
    });

    it("strips the trailing ' (deleted)' suffix from procfs symlinks", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(123);
      readlinkMock.queue[0]!.resolve("/usr/local/bin/claude (deleted)");
      await flush();

      expect(probe.readBasename(123)).toBe("claude");
    });

    it("persists null when readlink rejects", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(123);
      readlinkMock.queue[0]!.reject(new Error("ENOENT"));
      await flush();

      expect(probe.readBasename(123)).toBeNull();
    });

    it("does not schedule a refresh while one is already in flight", () => {
      const probe = new ImagePathProbe();
      probe.readBasename(123);
      probe.readBasename(123);
      probe.readBasename(123);
      expect(readlinkMock.calls).toHaveLength(1);
    });

    it("triggers a background refresh past soft-stale but keeps the cached value", async () => {
      vi.useFakeTimers();
      try {
        const probe = new ImagePathProbe();
        probe.readBasename(123);
        readlinkMock.queue[0]!.resolve("/opt/homebrew/bin/claude");
        await flush();

        vi.advanceTimersByTime(600); // past 500ms soft-stale, within 1500ms hard-max

        expect(probe.readBasename(123)).toBe("claude");
        expect(readlinkMock.calls).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("returns null past the hard-max age and schedules a refresh", async () => {
      vi.useFakeTimers();
      try {
        const probe = new ImagePathProbe();
        probe.readBasename(123);
        readlinkMock.queue[0]!.resolve("/opt/homebrew/bin/claude");
        await flush();

        expect(probe.readBasename(123)).toBe("claude");

        vi.advanceTimersByTime(1600); // past 1500ms hard-max
        expect(probe.readBasename(123)).toBeNull();
        expect(readlinkMock.calls).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("macOS", () => {
    beforeEach(() => {
      setPlatform("darwin");
    });

    it("invokes lsof with the expected arguments", () => {
      const probe = new ImagePathProbe();
      probe.readBasename(4242);
      expect(execFileMock.calls).toHaveLength(1);
      expect(execFileMock.calls[0]!.cmd).toBe("lsof");
      expect(execFileMock.calls[0]!.args).toEqual(["-a", "-d", "txt", "-p", "4242", "-Fn"]);
    });

    it("picks the executable basename from a multi-line lsof output", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(4242);

      // Realistic `lsof -Fn` output: each fd record is several lines, with
      // multiple text-segment mappings (the executable plus its dylibs).
      const lsofOutput = [
        "p4242",
        "n/opt/homebrew/bin/claude",
        "f257",
        "n/usr/lib/dyld",
        "f258",
        "n/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
        "f259",
        "n/opt/homebrew/lib/libnode.dylib",
        "",
      ].join("\n");

      execFileMock.calls[0]!.resolve(lsofOutput);
      await flush();

      expect(probe.readBasename(4242)).toBe("claude");
    });

    it("falls back to the first absolute path when every entry is a library", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(4242);
      execFileMock.calls[0]!.resolve(
        ["p4242", "n/usr/lib/dyld", "n/System/Library/Frameworks/Foundation.framework", ""].join(
          "\n"
        )
      );
      await flush();

      expect(probe.readBasename(4242)).toBe("dyld");
    });

    it("returns null on empty output", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(4242);
      execFileMock.calls[0]!.resolve("");
      await flush();
      expect(probe.readBasename(4242)).toBeNull();
    });

    it("persists null when lsof fails (process exited)", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(4242);
      execFileMock.calls[0]!.reject(new Error("lsof: no such process"));
      await flush();
      expect(probe.readBasename(4242)).toBeNull();
    });
  });

  describe("Windows", () => {
    beforeEach(() => {
      setPlatform("win32");
    });

    it("invokes PowerShell with Get-CimInstance", () => {
      const probe = new ImagePathProbe();
      probe.readBasename(5005);
      expect(execFileMock.calls).toHaveLength(1);
      expect(execFileMock.calls[0]!.cmd).toBe("powershell.exe");
      const args = execFileMock.calls[0]!.args ?? [];
      expect(args).toContain("-NoProfile");
      expect(args).toContain("-NonInteractive");
      expect(args[args.length - 1]).toContain("ProcessId=5005");
      expect(args[args.length - 1]).toContain("Win32_Process");
    });

    it("strips .exe and lowercases the result", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(5005);
      execFileMock.calls[0]!.resolve("C:\\Program Files\\Claude\\Claude.exe\r\n");
      await flush();
      expect(probe.readBasename(5005)).toBe("claude");
    });

    it("returns null on empty output", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(5005);
      execFileMock.calls[0]!.resolve("");
      await flush();
      expect(probe.readBasename(5005)).toBeNull();
    });

    it("strips other Windows executable extensions", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(5006);
      execFileMock.calls[0]!.resolve("C:\\npm\\claude.cmd\r\n");
      await flush();
      expect(probe.readBasename(5006)).toBe("claude");
    });
  });

  describe("cache lifecycle", () => {
    it("evict() drops the cached entry so a recycled PID re-probes", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(123);
      readlinkMock.queue[0]!.resolve("/usr/bin/claude");
      await flush();
      expect(probe.readBasename(123)).toBe("claude");

      probe.evict(123);
      expect(probe.readBasename(123)).toBeNull();
      expect(readlinkMock.calls).toHaveLength(2);
    });

    it("dispose() blocks further reads and refreshes", async () => {
      const probe = new ImagePathProbe();
      probe.readBasename(123);
      readlinkMock.queue[0]!.resolve("/usr/bin/claude");
      await flush();

      probe.dispose();
      expect(probe.readBasename(123)).toBeNull();
      // Disposed probe must not schedule a new readlink call for the same PID.
      expect(readlinkMock.calls).toHaveLength(1);
    });

    it("drops stale entries past the 30s eviction TTL on the next read", async () => {
      vi.useFakeTimers();
      try {
        const probe = new ImagePathProbe();
        probe.readBasename(123);
        readlinkMock.queue[0]!.resolve("/usr/bin/claude");
        await flush();

        vi.advanceTimersByTime(35_000);

        // Reading a different PID re-runs eviction; the long-idle 123 entry
        // is dropped, so a subsequent read of 123 must re-probe.
        probe.readBasename(456);
        readlinkMock.queue[0]!.resolve("/usr/bin/codex");
        await flush();

        expect(probe.readBasename(123)).toBeNull();
        expect(readlinkMock.calls).toContain("/proc/123/exe");
        // 123 should appear twice in readlink history: original + post-eviction.
        const calls123 = readlinkMock.calls.filter((c) => c === "/proc/123/exe");
        expect(calls123.length).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
