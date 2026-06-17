import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import { findWindowsShell, getDefaultShell, getDefaultShellArgs } from "../terminalShell.js";

vi.mock("child_process", () => ({ execFileSync: vi.fn() }));

const execFileSyncMock = vi.mocked(execFileSync);

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

function throwOnce(): never {
  throw new Error("where: not found");
}

// Shell DISCOVERY (which shell to spawn) was untested — only getDefaultShellArgs
// (args for an already-resolved shell) had coverage. These tests drive the
// Windows fallback chain `where pwsh.exe` → `where powershell.exe` → COMSPEC →
// cmd.exe under a mocked execFileSync, so no real `where.exe` runs.
describe("findWindowsShell (Windows shell discovery)", () => {
  const originalComspec = process.env.COMSPEC;

  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    if (originalComspec === undefined) {
      delete process.env.COMSPEC;
    } else {
      process.env.COMSPEC = originalComspec;
    }
  });

  it("returns pwsh.exe when 'where pwsh.exe' succeeds", () => {
    execFileSyncMock.mockReturnValue(Buffer.from("") as never);

    expect(findWindowsShell()).toBe("pwsh.exe");
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock).toHaveBeenCalledWith("where", ["pwsh.exe"], {
      stdio: "ignore",
      timeout: 3000,
    });
  });

  it("falls back to powershell.exe when pwsh.exe is not on PATH", () => {
    execFileSyncMock.mockImplementationOnce(throwOnce).mockReturnValue(Buffer.from("") as never);

    expect(findWindowsShell()).toBe("powershell.exe");
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    expect(execFileSyncMock.mock.calls[1]?.[1]).toEqual(["powershell.exe"]);
  });

  it("falls back to COMSPEC when neither PowerShell is on PATH", () => {
    execFileSyncMock.mockImplementation(throwOnce);
    process.env.COMSPEC = "C:\\custom\\cmd.exe";

    expect(findWindowsShell()).toBe("C:\\custom\\cmd.exe");
  });

  it("falls back to cmd.exe when both PowerShell probes fail and COMSPEC is unset", () => {
    execFileSyncMock.mockImplementation(throwOnce);
    delete process.env.COMSPEC;

    expect(findWindowsShell()).toBe("cmd.exe");
  });
});

describe("getDefaultShell", () => {
  const originalShell = process.env.SHELL;

  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
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
    execFileSyncMock.mockReturnValue(Buffer.from("") as never);

    expect(getDefaultShell()).toBe("pwsh.exe");
    // Proves the win32 short-circuit: the POSIX $SHELL branch never runs.
    expect(execFileSyncMock).toHaveBeenCalledWith("where", ["pwsh.exe"], expect.anything());
  });

  it("returns process.env.SHELL when set on POSIX", () => {
    setPlatform("linux");
    process.env.SHELL = "/usr/bin/fish";

    expect(getDefaultShell()).toBe("/usr/bin/fish");
  });
});
