import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Full surface for every mocked builtin: a factory missing an export throws for
// each consumer at collection while vitest still exits 0.
vi.mock("fs", () => ({
  default: { existsSync: vi.fn(() => false) },
  existsSync: vi.fn(() => false),
}));

vi.mock("os", () => ({
  default: { homedir: () => "/home/testuser" },
  homedir: () => "/home/testuser",
}));

// The module under test parses and joins Windows PATH strings, so it needs
// Windows path semantics — above all `delimiter === ";"`. On a POSIX host the
// real module splits `C:\Windows;C:\Tools` on ":" and shreds it, which would
// make every assertion below about merged output meaningless.
vi.mock("path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("path")>();
  return { ...actual.win32, default: actual.win32 };
});

const execFileMock = vi.fn();
const spawnMock = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

type ExecFileCallback = (err: Error | null, stdout: string) => void;

/**
 * Stand in for `reg query <key> /v Path`, keyed on the registry key so the two
 * concurrent reads can return different values. `null` makes that key fail.
 */
function stubRegistry(values: { hklm: string | null; hkcu: string | null }): void {
  execFileMock.mockImplementation(
    (_cmd: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
      respond(args[1], values, cb);
    }
  );
}

/**
 * Like `stubRegistry`, but holds every `reg query` open until the returned
 * `settle()` runs. `stubRegistry` answers synchronously, which leaves a read
 * "in flight" for barely a microtask — too short to test what a caller does
 * while one is genuinely outstanding.
 */
function stubRegistryDeferred(values: { hklm: string | null; hkcu: string | null }): () => void {
  const pending: Array<() => void> = [];
  execFileMock.mockImplementation(
    (_cmd: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
      pending.push(() => respond(args[1], values, cb));
    }
  );
  return () => {
    for (const respondNow of pending.splice(0)) respondNow();
  };
}

function respond(
  key: string,
  values: { hklm: string | null; hkcu: string | null },
  cb: ExecFileCallback
): void {
  const value = key.startsWith("HKLM") ? values.hklm : values.hkcu;
  if (value === null) return cb(new Error("reg query failed"), "");
  cb(null, `\r\n${key}\r\n    Path    REG_SZ    ${value}\r\n\r\n`);
}

/** Registry key reads issued so far, ignoring which key each targeted. */
function registryReadCount(): number {
  return execFileMock.mock.calls.length;
}

async function importWindowsPath() {
  return import("../windowsPath.js");
}

describe("windowsPath", () => {
  const originalPlatform = process.platform;
  const originalPath = process.env.PATH;

  // Both derived from the module's throttle window rather than restated: what
  // matters is which side of it a call lands on, not the number itself.
  const WITHIN_THROTTLE_MS = 1_000;
  const BEYOND_THROTTLE_MS = 30_000;

  let now = 1_000_000;

  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    spawnMock.mockReset();
    now = 1_000_000;
    // Stubbing the clock rather than installing fake timers: the module is
    // loaded via a dynamic import inside each test, and fake timers installed
    // before one of those hang the hook (#11661).
    vi.spyOn(performance, "now").mockImplementation(() => now);
    // configurable, NOT writable: Node ships `platform` as non-writable, and
    // flipping that leaks the loosened descriptor into whichever file reuses
    // this worker. Restoring the value alone would not put it back.
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  describe("resolveWindowsRegistryPath", () => {
    it("merges the machine and user PATH, machine first", async () => {
      stubRegistry({ hklm: "C:\\Windows;C:\\Windows\\System32", hkcu: "C:\\Users\\me\\bin" });
      const { resolveWindowsRegistryPath } = await importWindowsPath();

      expect(await resolveWindowsRegistryPath()).toBe(
        "C:\\Windows;C:\\Windows\\System32;C:\\Users\\me\\bin"
      );
    });

    it("drops case-insensitive duplicate entries", async () => {
      stubRegistry({ hklm: "C:\\Windows;C:\\Tools", hkcu: "c:\\windows;C:\\Users\\me\\bin" });
      const { resolveWindowsRegistryPath } = await importWindowsPath();

      expect(await resolveWindowsRegistryPath()).toBe("C:\\Windows;C:\\Tools;C:\\Users\\me\\bin");
    });

    it("keeps the surviving key when the other one errors", async () => {
      stubRegistry({ hklm: null, hkcu: "C:\\Users\\me\\bin" });
      const { resolveWindowsRegistryPath } = await importWindowsPath();

      expect(await resolveWindowsRegistryPath()).toBe("C:\\Users\\me\\bin");
    });

    it("returns null when neither key yields a value", async () => {
      stubRegistry({ hklm: null, hkcu: null });
      const { resolveWindowsRegistryPath } = await importWindowsPath();

      expect(await resolveWindowsRegistryPath()).toBeNull();
    });

    it("collapses concurrent callers onto one pair of registry reads", async () => {
      stubRegistry({ hklm: "C:\\Windows", hkcu: "C:\\Users\\me\\bin" });
      const { resolveWindowsRegistryPath } = await importWindowsPath();

      const [a, b, c] = await Promise.all([
        resolveWindowsRegistryPath(),
        resolveWindowsRegistryPath(),
        resolveWindowsRegistryPath(),
      ]);

      expect(registryReadCount()).toBe(2);
      expect(a).toBe(b);
      expect(b).toBe(c);
    });

    it("re-reads once the previous call has settled", async () => {
      stubRegistry({ hklm: "C:\\Windows", hkcu: "" });
      const { resolveWindowsRegistryPath } = await importWindowsPath();

      await resolveWindowsRegistryPath();
      stubRegistry({ hklm: "C:\\Windows;C:\\Python313", hkcu: "" });
      expect(await resolveWindowsRegistryPath()).toBe("C:\\Windows;C:\\Python313");
    });
  });

  describe("refreshWindowsPathForSpawn", () => {
    it("does nothing off Windows", async () => {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      process.env.PATH = "/usr/bin";
      stubRegistry({ hklm: "C:\\Windows", hkcu: "" });
      const { refreshWindowsPathForSpawn } = await importWindowsPath();

      await refreshWindowsPathForSpawn();

      expect(registryReadCount()).toBe(0);
      expect(process.env.PATH).toBe("/usr/bin");
    });

    it("adopts the registry PATH on the first call", async () => {
      process.env.PATH = "C:\\Windows";
      stubRegistry({ hklm: "C:\\Windows;C:\\Python313", hkcu: "" });
      const { refreshWindowsPathForSpawn } = await importWindowsPath();

      await refreshWindowsPathForSpawn();

      expect(process.env.PATH).toBe("C:\\Windows;C:\\Python313");
    });

    it("skips the registry entirely for a second spawn inside the TTL", async () => {
      stubRegistry({ hklm: "C:\\Windows", hkcu: "" });
      const { refreshWindowsPathForSpawn } = await importWindowsPath();

      await refreshWindowsPathForSpawn();
      const afterFirst = registryReadCount();
      now += WITHIN_THROTTLE_MS;
      await refreshWindowsPathForSpawn();

      expect(registryReadCount()).toBe(afterFirst);
    });

    it("re-reads once the TTL has elapsed, picking up a newly installed tool", async () => {
      stubRegistry({ hklm: "C:\\Windows", hkcu: "" });
      const { refreshWindowsPathForSpawn } = await importWindowsPath();

      await refreshWindowsPathForSpawn();
      expect(process.env.PATH).toBe("C:\\Windows");

      stubRegistry({ hklm: "C:\\Windows;C:\\Python313", hkcu: "" });
      now += BEYOND_THROTTLE_MS;
      await refreshWindowsPathForSpawn();

      expect(process.env.PATH).toBe("C:\\Windows;C:\\Python313");
    });

    it("counts a startup registry read against the TTL", async () => {
      stubRegistry({ hklm: "C:\\Windows", hkcu: "" });
      const { resolveWindowsRegistryPath, refreshWindowsPathForSpawn } = await importWindowsPath();

      // Stands in for the app-start refresh, which resolves through the same
      // single-flight; a restore burst right after it must not re-query.
      await resolveWindowsRegistryPath();
      const afterStartup = registryReadCount();
      await refreshWindowsPathForSpawn();

      expect(registryReadCount()).toBe(afterStartup);
    });

    it("joins an in-flight read even though the previous stamp is still fresh", async () => {
      stubRegistry({ hklm: "C:\\Windows", hkcu: "" });
      const { resolveWindowsRegistryPath, refreshWindowsPathForSpawn } = await importWindowsPath();
      await resolveWindowsRegistryPath();
      const afterStartup = registryReadCount();

      // Inside the throttle window, so the TTL alone would say "skip" — but a
      // read is outstanding, and it is by definition newer than the stamp it
      // has not written yet. Skipping here would hand this spawn the previous
      // answer while a fresher one was moments away.
      now += WITHIN_THROTTLE_MS;
      const settle = stubRegistryDeferred({ hklm: "C:\\Windows;C:\\Python313", hkcu: "" });
      const inFlight = resolveWindowsRegistryPath();
      const joined = refreshWindowsPathForSpawn();

      settle();
      await Promise.all([inFlight, joined]);

      expect(registryReadCount()).toBe(afterStartup * 2);
      expect(process.env.PATH).toBe("C:\\Windows;C:\\Python313");
    });

    it("collapses concurrent spawns onto a single registry read", async () => {
      const settle = stubRegistryDeferred({ hklm: "C:\\Windows;C:\\Python313", hkcu: "" });
      const { refreshWindowsPathForSpawn } = await importWindowsPath();

      // Six panes opening at once — a recipe launch — must not mean six
      // `reg.exe` pairs.
      const spawns = Array.from({ length: 6 }, () => refreshWindowsPathForSpawn());
      settle();
      await Promise.all(spawns);

      expect(registryReadCount()).toBe(2);
      expect(process.env.PATH).toBe("C:\\Windows;C:\\Python313");
    });

    it("leaves PATH alone when the registry yields nothing", async () => {
      process.env.PATH = "C:\\Windows";
      stubRegistry({ hklm: null, hkcu: null });
      const { refreshWindowsPathForSpawn } = await importWindowsPath();

      await refreshWindowsPathForSpawn();

      expect(process.env.PATH).toBe("C:\\Windows");
    });

    it("throttles a failing registry read, then retries after the TTL", async () => {
      stubRegistry({ hklm: null, hkcu: null });
      const { refreshWindowsPathForSpawn } = await importWindowsPath();

      await refreshWindowsPathForSpawn();
      const afterFailure = registryReadCount();

      now += WITHIN_THROTTLE_MS;
      await refreshWindowsPathForSpawn();
      expect(registryReadCount()).toBe(afterFailure);

      now += BEYOND_THROTTLE_MS;
      await refreshWindowsPathForSpawn();
      expect(registryReadCount()).toBeGreaterThan(afterFailure);
    });

    it("never rejects when the registry read throws", async () => {
      process.env.PATH = "C:\\Windows";
      execFileMock.mockImplementation(() => {
        throw new Error("spawn ENOENT");
      });
      const { refreshWindowsPathForSpawn } = await importWindowsPath();

      await expect(refreshWindowsPathForSpawn()).resolves.toBeUndefined();
      expect(process.env.PATH).toBe("C:\\Windows");
    });

    it("throttles a throwing registry read too, rather than retrying per pane", async () => {
      execFileMock.mockImplementation(() => {
        throw new Error("spawn ENOENT");
      });
      const { refreshWindowsPathForSpawn } = await importWindowsPath();

      await refreshWindowsPathForSpawn();
      const afterThrow = registryReadCount();

      // A missing or broken `reg.exe` is a persistent condition; paying for it
      // on every terminal open would be the worst version of this feature.
      now += WITHIN_THROTTLE_MS;
      await refreshWindowsPathForSpawn();

      expect(registryReadCount()).toBe(afterThrow);
    });

    it("throttles on monotonic time, not the wall clock", async () => {
      stubRegistry({ hklm: "C:\\Windows", hkcu: "" });
      const { refreshWindowsPathForSpawn } = await importWindowsPath();

      await refreshWindowsPathForSpawn();
      const afterFirst = registryReadCount();

      // The wall clock jumps backwards (NTP correction, a timezone fix) while
      // monotonic time moves on past the throttle window. A `Date.now()` gate
      // would compute negative elapsed, read it as "just refreshed", and
      // suppress every registry read until real time caught up.
      vi.spyOn(Date, "now").mockReturnValue(0);
      now += BEYOND_THROTTLE_MS;
      await refreshWindowsPathForSpawn();

      expect(registryReadCount()).toBeGreaterThan(afterFirst);
    });
  });
});
