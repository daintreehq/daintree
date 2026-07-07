import { afterEach, describe, expect, it } from "vitest";
import { buildCommandLaunchShell } from "../commandLaunch.js";

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

function decodePowerShellEncodedCommand(encoded: string): string {
  return Buffer.from(encoded, "base64").toString("utf16le");
}

describe("buildCommandLaunchShell", () => {
  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  describe("Windows + PowerShell", () => {
    it("returns -NoLogo -NoExit -EncodedCommand with the command encoded as UTF-16LE base64", () => {
      setPlatform("win32");

      const result = buildCommandLaunchShell("claude", "pwsh.exe");

      expect(result).not.toBeNull();
      expect(result?.shell).toBe("pwsh.exe");
      expect(result?.args.slice(0, 3)).toEqual(["-NoLogo", "-NoExit", "-EncodedCommand"]);
      expect(result?.args).toHaveLength(4);
      expect(decodePowerShellEncodedCommand(result!.args[3])).toBe("claude");
    });

    it("preserves Windows-style paths with spaces verbatim through the base64 payload", () => {
      setPlatform("win32");

      const command =
        "claude --mcp-config 'C:\\Users\\Test User\\AppData\\Roaming\\Daintree\\pane.json'";
      const result = buildCommandLaunchShell(command, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");

      expect(result).not.toBeNull();
      expect(decodePowerShellEncodedCommand(result!.args[3])).toBe(command);
    });

    it("preserves paths with embedded apostrophes (PowerShell '' escaping survives intact)", () => {
      setPlatform("win32");

      const command =
        "claude --mcp-config 'C:\\Users\\O''Brien\\AppData\\Roaming\\Daintree\\pane.json'";
      const result = buildCommandLaunchShell(command, "pwsh.exe");

      expect(result).not.toBeNull();
      // The base64 payload round-trips the exact string; PowerShell parses
      // '' inside single-quote strings as a literal '.
      expect(decodePowerShellEncodedCommand(result!.args[3])).toBe(command);
    });

    it("matches powershell.exe (Windows PowerShell 5.1) the same way as pwsh", () => {
      setPlatform("win32");

      const result = buildCommandLaunchShell(
        "claude",
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
      );

      expect(result).not.toBeNull();
      expect(result?.args[0]).toBe("-NoLogo");
      expect(result?.args[1]).toBe("-NoExit");
      expect(result?.args[2]).toBe("-EncodedCommand");
    });
  });

  describe("Windows + cmd.exe", () => {
    it("returns /K with the command as a single argv element", () => {
      setPlatform("win32");

      const result = buildCommandLaunchShell("codex", "cmd.exe");

      expect(result).toEqual({ shell: "cmd.exe", args: ["/K", "codex"] });
    });

    it("passes complex commands with quoting through /K unchanged", () => {
      setPlatform("win32");

      const command = 'codex --mcp-config "C:\\path\\to\\config.json"';
      const result = buildCommandLaunchShell(command, "C:\\Windows\\System32\\cmd.exe");

      expect(result?.shell).toBe("C:\\Windows\\System32\\cmd.exe");
      expect(result?.args).toEqual(["/K", command]);
    });
  });

  describe("Windows fallback", () => {
    it("returns null for unknown Windows shells so the caller falls back to PTY write", () => {
      setPlatform("win32");

      // git-bash on Windows is not pwsh/powershell/cmd — we don't have a
      // recognized command-launch path for it, so let the existing PTY-write
      // fallback handle it rather than guess.
      expect(buildCommandLaunchShell("claude", "C:\\Program Files\\Git\\bin\\bash.exe")).toBeNull();
    });
  });

  describe("POSIX (regression)", () => {
    it("wraps zsh/bash commands in the trap-wrapped interactive script on Linux", () => {
      setPlatform("linux");

      const result = buildCommandLaunchShell("claude", "/bin/zsh");

      expect(result).not.toBeNull();
      expect(result?.shell).toBe("/bin/zsh");
      expect(result?.args[0]).toBe("-lic");
      // The script must contain a trap, the command, and an exec of the login shell.
      expect(result?.args[1]).toContain("trap : INT");
      expect(result?.args[1]).toContain("claude");
      expect(result?.args[1]).toContain("exec '/bin/zsh' -l");
    });

    it("launches macOS through the same direct -lic form as Linux (no sleep wrapper)", () => {
      setPlatform("darwin");

      const result = buildCommandLaunchShell("claude", "/bin/zsh");

      expect(result).not.toBeNull();
      expect(result?.args[0]).toBe("-lic");
      expect(result?.args[1]).not.toContain("sleep");
      expect(result?.args[1]).toContain("trap : INT");
      expect(result?.args[1]).toContain("claude");
      expect(result?.args[1]).toContain("exec '/bin/zsh' -l");
    });

    it("uses -i -c for plain /bin/sh on Linux", () => {
      setPlatform("linux");

      const result = buildCommandLaunchShell("claude", "/bin/sh");

      expect(result).not.toBeNull();
      expect(result?.args.slice(0, 2)).toEqual(["-i", "-c"]);
      expect(result?.args[2]).toContain("trap : INT");
    });

    it("returns null for unsupported POSIX shells (e.g. nushell)", () => {
      setPlatform("linux");

      expect(buildCommandLaunchShell("claude", "/usr/bin/nu")).toBeNull();
    });
  });

  describe("common edge cases", () => {
    it("returns null for empty commands on all platforms", () => {
      setPlatform("win32");
      expect(buildCommandLaunchShell("", "pwsh.exe")).toBeNull();
      expect(buildCommandLaunchShell("", "cmd.exe")).toBeNull();

      setPlatform("linux");
      expect(buildCommandLaunchShell("", "/bin/zsh")).toBeNull();

      setPlatform("darwin");
      expect(buildCommandLaunchShell("", "/bin/zsh")).toBeNull();
    });
  });
});
