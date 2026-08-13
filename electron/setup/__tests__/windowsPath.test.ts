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
      const key = args[1];
      const value = key.startsWith("HKLM") ? values.hklm : values.hkcu;
      if (value === null) return cb(new Error("reg query failed"), "");
      cb(null, `\r\n${key}\r\n    Path    REG_SZ    ${value}\r\n\r\n`);
    }
  );
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
  let now = 1_000_000;

  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    spawnMock.mockReset();
    now = 1_000_000;
    // Date.now rather than fake timers: the module is loaded via a dynamic
    // import inside each test, and installing fake timers before one of those
    // hangs the hook.
    vi.spyOn(Date, "now").mockImplementation(() => now);
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
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
      Object.defineProperty(process, "platform", { value: "darwin", writable: true });
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
      now += 4_000;
      await refreshWindowsPathForSpawn();

      expect(registryReadCount()).toBe(afterFirst);
    });

    it("re-reads once the TTL has elapsed, picking up a newly installed tool", async () => {
      stubRegistry({ hklm: "C:\\Windows", hkcu: "" });
      const { refreshWindowsPathForSpawn } = await importWindowsPath();

      await refreshWindowsPathForSpawn();
      expect(process.env.PATH).toBe("C:\\Windows");

      stubRegistry({ hklm: "C:\\Windows;C:\\Python313", hkcu: "" });
      now += 6_000;
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

    it("joins an in-flight read rather than skipping on the previous stamp", async () => {
      stubRegistry({ hklm: "C:\\Windows", hkcu: "" });
      const { resolveWindowsRegistryPath, refreshWindowsPathForSpawn } = await importWindowsPath();

      await resolveWindowsRegistryPath();
      now += 6_000;
      stubRegistry({ hklm: "C:\\Windows;C:\\Python313", hkcu: "" });

      // A refresh already in flight is strictly newer than the stamp it has not
      // written yet, so the spawn must await it instead of reading the old one.
      const inFlight = resolveWindowsRegistryPath();
      await refreshWindowsPathForSpawn();
      await inFlight;

      // Two reads for the startup refresh, two for the in-flight one the spawn
      // joined — not six, which is what a spawn issuing its own would cost.
      expect(registryReadCount()).toBe(4);
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

      now += 1_000;
      await refreshWindowsPathForSpawn();
      expect(registryReadCount()).toBe(afterFailure);

      now += 6_000;
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
  });
});
