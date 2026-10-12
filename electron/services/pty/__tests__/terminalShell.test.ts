import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import {
  findWindowsShell,
  getDefaultShell,
  getDefaultShellArgs,
  resetWindowsShellCache,
} from "../terminalShell.js";
import {
  isWindowsLaunchFile,
  resolveWindowsExecutable,
  windowsSystemTool,
} from "../../../utils/windowsExecutable.js";

vi.mock("child_process", () => ({ execFileSync: vi.fn() }));

// The PATH lookup reads the host's real filesystem; each case decides what it finds.
vi.mock("../../../utils/windowsExecutable.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/windowsExecutable.js")>()),
  resolveWindowsExecutable: vi.fn(() => null),
  isWindowsLaunchFile: vi.fn(() => false),
}));

const execFileSyncMock = vi.mocked(execFileSync);
const resolveWindowsExecutableMock = vi.mocked(resolveWindowsExecutable);
const isWindowsLaunchFileMock = vi.mocked(isWindowsLaunchFile);

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

    it("forces UTF-8 console encoding for fully-qualified PowerShell path", () => {
      setPlatform("win32");

      expect(
        getDefaultShellArgs("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
      ).toEqual(PS_BOOTSTRAP_ARGS);
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

function onPath(found: Record<string, string>): void {
  resolveWindowsExecutableMock.mockImplementation((name: string) => found[name] ?? null);
}

// Shell DISCOVERY (which shell to spawn): PowerShell 7, then Windows PowerShell,
// from PATH; then the in-box Windows PowerShell; then COMSPEC, then cmd.exe.
// The PATH lookup is mocked, so no real `where.exe` or filesystem probe runs.
describe("findWindowsShell (Windows shell discovery)", () => {
  const originalComspec = process.env.COMSPEC;

  beforeEach(() => {
    execFileSyncMock.mockReset();
    resolveWindowsExecutableMock.mockReset().mockImplementation(() => null);
    isWindowsLaunchFileMock.mockReset().mockImplementation(() => false);
    resetWindowsShellCache();
  });

  afterEach(() => {
    resetWindowsShellCache();
    if (originalComspec === undefined) {
      delete process.env.COMSPEC;
    } else {
      process.env.COMSPEC = originalComspec;
    }
  });

  it("returns the absolute pwsh.exe PATH holds, without spawning a lookup", () => {
    onPath({ "pwsh.exe": PWSH, "powershell.exe": PATH_POWERSHELL });

    expect(findWindowsShell()).toBe(PWSH);
    expect(resolveWindowsExecutableMock).toHaveBeenCalledWith("pwsh.exe");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("probes the shell once, however many terminals launch", () => {
    // getDefaultShell() runs per terminal spawn and per shell-quoting decision;
    // an unmemoized probe is where the reporter's 53 `where.exe` came from.
    onPath({ "pwsh.exe": PWSH });

    expect(findWindowsShell()).toBe(PWSH);
    // Pinned, not captured: a memo that never probed at all would make a
    // "count didn't grow" assertion pass for the wrong reason.
    expect(resolveWindowsExecutableMock).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 20; i++) expect(findWindowsShell()).toBe(PWSH);
    expect(resolveWindowsExecutableMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to powershell.exe from PATH when pwsh.exe is not on PATH", () => {
    onPath({ "powershell.exe": PATH_POWERSHELL });

    expect(findWindowsShell()).toBe(PATH_POWERSHELL);
    expect(resolveWindowsExecutableMock.mock.calls.map(([name]) => name)).toEqual([
      "pwsh.exe",
      "powershell.exe",
    ]);
  });

  it("uses the in-box Windows PowerShell by absolute path when PATH holds neither", () => {
    // A PATH lookup that finds nothing never becomes a bare name, which spawn
    // would look for in the working directory first.
    const inbox = windowsSystemTool("powershell.exe");
    isWindowsLaunchFileMock.mockImplementation((file: string) => file === inbox);

    expect(findWindowsShell()).toBe(inbox);
  });

  it("falls back to an absolute COMSPEC when no PowerShell exists", () => {
    process.env.COMSPEC = "C:\\custom\\cmd.exe";

    expect(findWindowsShell()).toBe("C:\\custom\\cmd.exe");
  });

  it("uses the in-box cmd.exe when COMSPEC is unset or relative", () => {
    const cmd = windowsSystemTool("cmd.exe");

    delete process.env.COMSPEC;
    expect(findWindowsShell()).toBe(cmd);

    for (const comspec of ["cmd.exe", "C:cmd.exe", "\\Windows\\cmd.exe"]) {
      resetWindowsShellCache();
      process.env.COMSPEC = comspec;
      expect(findWindowsShell()).toBe(cmd);
    }
  });

  it("memoizes the fallback too, so a PowerShell-less box stops probing", () => {
    process.env.COMSPEC = "C:\\custom\\cmd.exe";

    expect(findWindowsShell()).toBe("C:\\custom\\cmd.exe");
    expect(resolveWindowsExecutableMock).toHaveBeenCalledTimes(2);

    for (let i = 0; i < 5; i++) findWindowsShell();
    expect(resolveWindowsExecutableMock).toHaveBeenCalledTimes(2);
  });
});

describe("getDefaultShell", () => {
  const originalShell = process.env.SHELL;

  beforeEach(() => {
    execFileSyncMock.mockReset();
    resolveWindowsExecutableMock.mockReset().mockImplementation(() => null);
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

  it("delegates to findWindowsShell on win32 (no POSIX shell resolution)", () => {
    setPlatform("win32");
    process.env.SHELL = "/bin/zsh"; // must be ignored on Windows
    onPath({ "pwsh.exe": PWSH });

    expect(getDefaultShell()).toBe(PWSH);
  });

  it("returns process.env.SHELL when set on POSIX", () => {
    setPlatform("linux");
    process.env.SHELL = "/usr/bin/fish";

    expect(getDefaultShell()).toBe("/usr/bin/fish");
  });
});
