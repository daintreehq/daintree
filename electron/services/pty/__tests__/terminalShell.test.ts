import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import {
  findWindowsShell,
  getDefaultShell,
  getDefaultShellArgs,
  prewarmWindowsShell,
  resetWindowsShellCache,
  waitForWindowsShell,
} from "../terminalShell.js";
import {
  invalidateWindowsExecutableCache,
  isWindowsLaunchFileAsync,
  lookupWindowsExecutable,
  windowsPathEntriesReadable,
  windowsSystemTool,
  type WindowsExecutableLookup,
} from "../../../utils/windowsExecutable.js";

vi.mock("child_process", () => ({ execFileSync: vi.fn() }));

// The PATH lookup reads the host's real filesystem; each case decides what it finds.
vi.mock("../../../utils/windowsExecutable.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/windowsExecutable.js")>()),
  lookupWindowsExecutable: vi.fn(async () => ({ file: null, skipped: [] })),
  isWindowsLaunchFileAsync: vi.fn(async () => false),
  windowsPathEntriesReadable: vi.fn(() => new Promise<void>(() => {})),
}));

const execFileSyncMock = vi.mocked(execFileSync);
const resolveWindowsExecutableMock = vi.mocked(lookupWindowsExecutable);
const isWindowsLaunchFileAsyncMock = vi.mocked(isWindowsLaunchFileAsync);
const windowsPathEntriesReadableMock = vi.mocked(windowsPathEntriesReadable);

function found(file: string | null, skipped: string[] = []): WindowsExecutableLookup {
  return { file, skipped };
}

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

describe("getDefaultShellArgs", () => {
  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  it("defers macOS interactive shell startup so PTY listeners can attach", () => {
    setPlatform("darwin");

    expect(getDefaultShellArgs("/tmp/o'hare/zsh")).toEqual([
      "-c",
      "sleep 0.05\nexec '/tmp/o'\\''hare/zsh' -l",
    ]);
  });

  it("keeps the direct login-shell path on non-macOS POSIX platforms", () => {
    setPlatform("linux");

    expect(getDefaultShellArgs("/bin/zsh")).toEqual(["-l"]);
  });

  describe("Windows fallback shells (UTF-8 bootstrap + -NoLogo)", () => {
    const PS_BOOTSTRAP_ARGS = [
      "-NoLogo",
      "-NoExit",
      "-Command",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    ];

    it("forces UTF-8 code page for cmd.exe", () => {
      setPlatform("win32");

      expect(getDefaultShellArgs("cmd.exe")).toEqual(["/K", "chcp 65001 >NUL"]);
    });

    it("forces UTF-8 code page for cmd.exe resolved via COMSPEC path", () => {
      setPlatform("win32");

      expect(getDefaultShellArgs("C:\\Windows\\system32\\cmd.exe")).toEqual([
        "/K",
        "chcp 65001 >NUL",
      ]);
    });

    it("forces UTF-8 console encoding + suppresses banner for Windows PowerShell 5.1", () => {
      setPlatform("win32");

      expect(getDefaultShellArgs("powershell.exe")).toEqual(PS_BOOTSTRAP_ARGS);
    });

    it("forces UTF-8 console encoding + suppresses banner for pwsh.exe (PowerShell 7+)", () => {
      // PowerShell 7+ defaults to UTF-8 internally, but [Console]::OutputEncoding
      // still drives decoding of native tools (git, docker, etc.) — bootstrap
      // is needed for end-to-end UTF-8 reliability.
      setPlatform("win32");

      expect(getDefaultShellArgs("pwsh.exe")).toEqual(PS_BOOTSTRAP_ARGS);
      expect(getDefaultShellArgs("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toEqual(
        PS_BOOTSTRAP_ARGS
      );
    });

    it("matches Windows shell basenames case-insensitively", () => {
      setPlatform("win32");

      expect(getDefaultShellArgs("CMD.EXE")).toEqual(["/K", "chcp 65001 >NUL"]);
      expect(getDefaultShellArgs("PowerShell.EXE")).toEqual(PS_BOOTSTRAP_ARGS);
    });

    it("returns no args for unrecognized Windows shells (e.g. git-bash, nushell)", () => {
      setPlatform("win32");

      expect(getDefaultShellArgs("C:\\tools\\nushell\\nu.exe")).toEqual([]);
      expect(getDefaultShellArgs("C:\\Program Files\\Git\\bin\\bash.exe")).toEqual([]);
    });
  });
});

const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const PATH_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function onPath(shells: Record<string, string>): void {
  resolveWindowsExecutableMock.mockImplementation(async (name: string) =>
    found(shells[name] ?? null)
  );
}

/** The shell `findWindowsShell` settles on once its asynchronous resolution has run. */
async function resolvedShell(): Promise<string> {
  findWindowsShell();
  await prewarmWindowsShell();
  return findWindowsShell();
}

// Shell DISCOVERY (which shell to spawn): PowerShell 7, then Windows PowerShell,
// from PATH; then the in-box Windows PowerShell; then COMSPEC, then cmd.exe.
// The PATH lookup is mocked, so no real filesystem probe runs.
describe("findWindowsShell (Windows shell discovery)", () => {
  const originalComspec = process.env.COMSPEC;
  const originalPath = process.env.PATH;

  beforeEach(() => {
    execFileSyncMock.mockReset();
    resolveWindowsExecutableMock.mockReset().mockImplementation(async () => found(null));
    isWindowsLaunchFileAsyncMock.mockReset().mockImplementation(async () => false);
    windowsPathEntriesReadableMock.mockReset().mockImplementation(() => new Promise(() => {}));
    resetWindowsShellCache();
  });

  afterEach(() => {
    resetWindowsShellCache();
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    if (originalComspec === undefined) {
      delete process.env.COMSPEC;
    } else {
      process.env.COMSPEC = originalComspec;
    }
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  it("answers with the in-box PowerShell at once, then the PATH pwsh once resolved", async () => {
    // A PATH entry on a dead share can hold the search for the SMB timeout; a
    // terminal launched meanwhile must not wait on it.
    let finish: (lookup: WindowsExecutableLookup) => void = () => {};
    resolveWindowsExecutableMock.mockImplementation((name: string) =>
      name === "pwsh.exe"
        ? new Promise<WindowsExecutableLookup>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(found(null))
    );
    // The PATH search is still pending, and the answer is already absolute.
    expect(findWindowsShell()).toBe(windowsSystemTool("powershell.exe"));
    expect(findWindowsShell()).toBe(windowsSystemTool("powershell.exe"));
    expect(isWindowsLaunchFileAsyncMock).not.toHaveBeenCalled();
    // One resolution in flight, however many terminals ask meanwhile.
    expect(
      resolveWindowsExecutableMock.mock.calls.filter(([name]) => name === "pwsh.exe")
    ).toHaveLength(1);

    finish(found(PWSH));
    await prewarmWindowsShell();
    expect(findWindowsShell()).toBe(PWSH);
  });

  it("returns the absolute pwsh.exe PATH holds, without spawning a lookup", async () => {
    onPath({ "pwsh.exe": PWSH, "powershell.exe": PATH_POWERSHELL });

    expect(await resolvedShell()).toBe(PWSH);
    expect(resolveWindowsExecutableMock).toHaveBeenCalledWith("pwsh.exe", process.env);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("resolves the shell once per PATH, however many terminals launch", async () => {
    // getDefaultShell() runs per terminal spawn and per shell-quoting decision;
    // an unmemoized probe is where the reporter's 53 `where.exe` came from.
    onPath({ "pwsh.exe": PWSH });

    expect(await resolvedShell()).toBe(PWSH);
    // Pinned, not captured: a memo that never probed at all would make a
    // "count didn't grow" assertion pass for the wrong reason.
    const lookups = resolveWindowsExecutableMock.mock.calls.length;
    expect(lookups).toBe(2);

    for (let i = 0; i < 20; i++) expect(findWindowsShell()).toBe(PWSH);
    expect(resolveWindowsExecutableMock).toHaveBeenCalledTimes(lookups);
  });

  it("resolves again after a PATH refresh, answering with the previous shell meanwhile", async () => {
    process.env.PATH = "C:\\Windows\\System32";
    onPath({ "powershell.exe": PATH_POWERSHELL });
    expect(await resolvedShell()).toBe(PATH_POWERSHELL);

    // PowerShell 7 installed, and the registry PATH re-read.
    onPath({ "pwsh.exe": PWSH, "powershell.exe": PATH_POWERSHELL });
    invalidateWindowsExecutableCache();
    expect(findWindowsShell()).toBe(PATH_POWERSHELL);
    await prewarmWindowsShell();
    expect(findWindowsShell()).toBe(PWSH);

    process.env.PATH = "C:\\Windows\\System32;C:\\Other";
    onPath({ "powershell.exe": PATH_POWERSHELL });
    expect(await resolvedShell()).toBe(PATH_POWERSHELL);
  });

  it("falls back to powershell.exe from PATH when pwsh.exe is not on PATH", async () => {
    onPath({ "powershell.exe": PATH_POWERSHELL });

    expect(await resolvedShell()).toBe(PATH_POWERSHELL);
    expect(resolveWindowsExecutableMock.mock.calls.map(([name]) => name)).toEqual([
      "pwsh.exe",
      "powershell.exe",
    ]);
  });

  it("uses the in-box Windows PowerShell by absolute path when PATH holds neither", async () => {
    // A PATH lookup that finds nothing never becomes a bare name, which spawn
    // would look for in the working directory first.
    const inbox = windowsSystemTool("powershell.exe");
    isWindowsLaunchFileAsyncMock.mockImplementation(async (file: string) => file === inbox);

    expect(await resolvedShell()).toBe(inbox);
  });

  it("falls back to an absolute COMSPEC when no PowerShell exists", async () => {
    process.env.COMSPEC = "C:\\custom\\cmd.exe";

    expect(await resolvedShell()).toBe("C:\\custom\\cmd.exe");
  });

  it("uses the in-box cmd.exe when COMSPEC is unset or relative", async () => {
    const cmd = windowsSystemTool("cmd.exe");

    delete process.env.COMSPEC;
    expect(await resolvedShell()).toBe(cmd);

    for (const comspec of ["cmd.exe", "C:cmd.exe", "\\Windows\\cmd.exe"]) {
      resetWindowsShellCache();
      process.env.COMSPEC = comspec;
      expect(await resolvedShell()).toBe(cmd);
    }
  });

  it("memoizes the fallback too, so a PowerShell-less box stops probing", async () => {
    process.env.COMSPEC = "C:\\custom\\cmd.exe";

    expect(await resolvedShell()).toBe("C:\\custom\\cmd.exe");
    expect(resolveWindowsExecutableMock).toHaveBeenCalledTimes(2);

    for (let i = 0; i < 5; i++) findWindowsShell();
    expect(resolveWindowsExecutableMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the in-box PowerShell when the resolution itself fails", async () => {
    resolveWindowsExecutableMock.mockImplementation(async () => {
      throw new Error("boom");
    });

    expect(await resolvedShell()).toBe(windowsSystemTool("powershell.exe"));
  });

  it("never lets an older probe that finishes late replace a newer answer", async () => {
    const PWSH_B = "D:\\pwsh7\\pwsh.exe";
    let finishA: (lookup: WindowsExecutableLookup) => void = () => {};
    resolveWindowsExecutableMock.mockImplementation((name: string, env?: NodeJS.ProcessEnv) => {
      if (env?.PATH === "C:\\A") {
        return name === "pwsh.exe"
          ? new Promise<WindowsExecutableLookup>((resolve) => {
              finishA = resolve;
            })
          : Promise.resolve(found(null));
      }
      return Promise.resolve(found(name === "pwsh.exe" ? PWSH_B : null));
    });

    process.env.PATH = "C:\\A";
    findWindowsShell();
    // PATH changes while the first search is still out.
    process.env.PATH = "C:\\B";
    expect(await resolvedShell()).toBe(PWSH_B);

    finishA(found(PWSH));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(findWindowsShell()).toBe(PWSH_B);
    // Nothing went stale either: no further search was started.
    expect(resolveWindowsExecutableMock).toHaveBeenCalledTimes(4);
  });

  it("reads the environment as it was when the probe started", async () => {
    let finish: (lookup: WindowsExecutableLookup) => void = () => {};
    resolveWindowsExecutableMock.mockImplementation((name: string) =>
      name === "pwsh.exe"
        ? new Promise<WindowsExecutableLookup>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(found(null))
    );
    process.env.COMSPEC = "C:\\custom\\cmd.exe";

    const probe = prewarmWindowsShell();
    process.env.COMSPEC = "C:\\other\\cmd.exe";
    finish(found(null));

    await expect(probe).resolves.toBe("C:\\custom\\cmd.exe");
  });

  describe("an answer reached past a PATH entry that did not respond", () => {
    const NAS = "\\\\nas\\tools";

    it("is provisional: resolved again once that entry can be read", async () => {
      let readable: () => void = () => {};
      windowsPathEntriesReadableMock.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            readable = resolve;
          })
      );
      // The share holds PowerShell 7, but did not answer this time.
      resolveWindowsExecutableMock.mockImplementation(async (name: string) =>
        name === "pwsh.exe" ? found(null, [NAS]) : found(PATH_POWERSHELL, [NAS])
      );

      expect(await resolvedShell()).toBe(PATH_POWERSHELL);
      expect(windowsPathEntriesReadableMock).toHaveBeenCalledWith([NAS]);
      for (let i = 0; i < 5; i++) findWindowsShell();
      expect(resolveWindowsExecutableMock).toHaveBeenCalledTimes(2);

      // The share answers.
      onPath({ "pwsh.exe": `${NAS}\\pwsh.exe`, "powershell.exe": PATH_POWERSHELL });
      readable();
      await vi.waitFor(() => expect(findWindowsShell()).toBe(`${NAS}\\pwsh.exe`));
      expect(resolveWindowsExecutableMock).toHaveBeenCalledTimes(4);
    });

    it("stops re-resolving after a few tries while the entry stays silent", async () => {
      windowsPathEntriesReadableMock.mockImplementation(async () => {});
      resolveWindowsExecutableMock.mockImplementation(async (name: string) =>
        name === "pwsh.exe" ? found(null, [NAS]) : found(PATH_POWERSHELL, [NAS])
      );

      expect(await resolvedShell()).toBe(PATH_POWERSHELL);
      await vi.waitFor(() => expect(windowsPathEntriesReadableMock).toHaveBeenCalledTimes(3));
      await new Promise((resolve) => setTimeout(resolve, 10));
      // The first probe and three re-checks, two lookups each.
      expect(resolveWindowsExecutableMock).toHaveBeenCalledTimes(8);
      expect(findWindowsShell()).toBe(PATH_POWERSHELL);
      expect(resolveWindowsExecutableMock).toHaveBeenCalledTimes(8);
    });
  });

  describe("waitForWindowsShell", () => {
    beforeEach(() => setPlatform("win32"));

    it("waits for the first answer, but no longer than it is allowed", async () => {
      vi.useFakeTimers();
      resolveWindowsExecutableMock.mockImplementation(() => new Promise(() => {}));
      let done = false;
      void waitForWindowsShell(2_000).then(() => {
        done = true;
      });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      // Still the in-box PowerShell, as before the wait existed.
      expect(getDefaultShell()).toBe(windowsSystemTool("powershell.exe"));
    });

    it("hands back PowerShell 7 as soon as the search finds it", async () => {
      onPath({ "pwsh.exe": PWSH });

      await waitForWindowsShell(2_000);

      expect(getDefaultShell()).toBe(PWSH);
    });

    it("costs nothing once the shell is settled for this PATH, even after a cache re-read", async () => {
      process.env.PATH = "C:\\Windows\\System32";
      onPath({ "pwsh.exe": PWSH });
      await waitForWindowsShell(2_000);
      resolveWindowsExecutableMock.mockClear();
      resolveWindowsExecutableMock.mockImplementation(() => new Promise(() => {}));

      invalidateWindowsExecutableCache();
      vi.useFakeTimers();
      let done = false;
      void waitForWindowsShell(2_000).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(true);
      expect(getDefaultShell()).toBe(PWSH);
      // Re-resolved in the background all the same.
      expect(resolveWindowsExecutableMock).toHaveBeenCalled();
    });

    it("waits for a PATH the shell has not been resolved against", async () => {
      process.env.PATH = "C:\\Windows\\System32";
      onPath({ "powershell.exe": PATH_POWERSHELL });
      await waitForWindowsShell(2_000);
      expect(getDefaultShell()).toBe(PATH_POWERSHELL);

      // PowerShell 7 installed, its directory adopted into PATH.
      process.env.PATH = "C:\\Program Files\\PowerShell\\7;C:\\Windows\\System32";
      onPath({ "pwsh.exe": PWSH, "powershell.exe": PATH_POWERSHELL });
      await waitForWindowsShell(2_000);

      expect(getDefaultShell()).toBe(PWSH);
    });

    it("does not wait on a provisional answer with nothing in flight to improve it", async () => {
      resolveWindowsExecutableMock.mockImplementation(async (name: string) =>
        name === "pwsh.exe" ? found(null, ["\\\\nas\\x"]) : found(PATH_POWERSHELL, ["\\\\nas\\x"])
      );
      await waitForWindowsShell(2_000);
      resolveWindowsExecutableMock.mockImplementation(() => new Promise(() => {}));

      vi.useFakeTimers();
      let done = false;
      void waitForWindowsShell(2_000).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(true);
    });

    it("never waits off Windows", async () => {
      setPlatform("darwin");
      await waitForWindowsShell(2_000);
      expect(resolveWindowsExecutableMock).not.toHaveBeenCalled();
    });
  });
});

describe("getDefaultShell", () => {
  const originalShell = process.env.SHELL;

  beforeEach(() => {
    execFileSyncMock.mockReset();
    resolveWindowsExecutableMock.mockReset().mockImplementation(async () => found(null));
    resetWindowsShellCache();
  });

  afterEach(() => {
    resetWindowsShellCache();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    if (originalShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = originalShell;
    }
  });

  it("delegates to findWindowsShell on win32 (no POSIX shell resolution)", async () => {
    setPlatform("win32");
    process.env.SHELL = "/bin/zsh"; // must be ignored on Windows
    onPath({ "pwsh.exe": PWSH });

    expect(getDefaultShell()).toBe(windowsSystemTool("powershell.exe"));
    await prewarmWindowsShell();
    expect(getDefaultShell()).toBe(PWSH);
  });

  it("returns process.env.SHELL when set on POSIX", () => {
    setPlatform("linux");
    process.env.SHELL = "/usr/bin/fish";

    expect(getDefaultShell()).toBe("/usr/bin/fish");
  });
});
