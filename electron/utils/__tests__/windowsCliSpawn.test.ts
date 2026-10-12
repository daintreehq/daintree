import { describe, expect, it } from "vitest";
import {
  cliSpawnTarget,
  isShellInertInvocation,
  isWindowsShellShim,
  pickWindowsLaunchable,
  resolveWindowsCli,
  type WindowsCliResolveOptions,
} from "../windowsCliSpawn.js";

function filesystem(files: Record<string, string>): WindowsCliResolveOptions {
  return {
    cwd: "C:\\project",
    env: {
      Path: "C:\\tools;C:\\Program Files\\node",
      PATHEXT: ".EXE;.CMD",
      SystemRoot: "C:\\Windows",
    },
    isFile: (file) => Object.keys(files).some((name) => name.toLowerCase() === file.toLowerCase()),
    readFile: (file) => files[file] ?? "",
  };
}

const shim =
  '@ECHO off\r\nSET "_prog=node"\r\n"%_prog%" "%dp0%\\node_modules\\codex\\cli.js" %*\r\n';

describe("Windows CLI resolution", () => {
  it("skips extensionless npm shell scripts", () => {
    expect(pickWindowsLaunchable(["C:\\npm\\codex", "C:\\npm\\codex.cmd"])).toBe(
      "C:\\npm\\codex.cmd"
    );
    expect(isWindowsShellShim("C:\\npm\\codex.CMD")).toBe(true);
    expect(isWindowsShellShim("codex.exe")).toBe(false);
  });

  it("resolves native files instead of cmd builtins", () => {
    const options = filesystem({
      "C:\\tools\\echo.EXE": "",
      "C:\\tools\\set.EXE": "",
      "C:\\tools\\start.EXE": "",
    });
    for (const command of ["echo", "set", "start"]) {
      expect(cliSpawnTarget(command, ["a&b", "%HOME%"], "win32", options)).toEqual({
        command: `C:\\tools\\${command}.EXE`,
        args: ["a&b", "%HOME%"],
        shell: false,
      });
    }
  });

  it("uses the same case-insensitive environment key as Node spawning", () => {
    const options = filesystem({ "C:\\override\\agent.EXE": "" });
    options.env = { Path: "C:\\old", PATH: "C:\\override", PATHEXT: ".EXE" };
    expect(resolveWindowsCli("agent", options)).toBe("C:\\override\\agent.EXE");
  });

  it("resolves a relative PATH entry against the launch directory", () => {
    const options = filesystem({ "C:\\project\\node_modules\\.bin\\agent.EXE": "" });
    options.env = { Path: ".\\node_modules\\.bin;C:\\tools", PATHEXT: ".EXE" };
    expect(resolveWindowsCli("agent", options)).toBe("C:\\project\\node_modules\\.bin\\agent.EXE");
  });

  it("preserves structured missing-file errors and rejects drive-relative commands", () => {
    const options = filesystem({});
    expect(() => resolveWindowsCli("codex", options)).toThrow(
      expect.objectContaining({ code: "ENOENT" })
    );
    for (const command of ["C:", "C:codex", ":label", "a=b", "-command", "/c"]) {
      expect(() => resolveWindowsCli(command, options)).toThrow();
    }
  });

  it("uses the real Node script with arbitrary arguments for npm shims", () => {
    const options = filesystem({
      "C:\\tools\\codex.CMD": shim,
      "C:\\tools\\node_modules\\codex\\cli.js": "",
      "C:\\Program Files\\node\\node.exe": "",
    });
    const args = ["app-server", "--listen", "stdio://", 'x&echo hacked%PATH%"'];
    expect(cliSpawnTarget("codex", args, "win32", options)).toEqual({
      command: "C:\\Program Files\\node\\node.exe",
      args: ["C:\\tools\\node_modules\\codex\\cli.js", ...args],
      shell: false,
    });
  });

  it("bypasses npm shims that invoke a bundled native executable", () => {
    const options = filesystem({
      "C:\\tools\\claude.CMD":
        '@ECHO off\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\claude\\bin\\claude.exe"   %*\r\n',
      "C:\\tools\\node_modules\\claude\\bin\\claude.exe": "",
    });
    expect(cliSpawnTarget("claude", ["a&b", "%PATH%"], "win32", options)).toEqual({
      command: "C:\\tools\\node_modules\\claude\\bin\\claude.exe",
      args: ["a&b", "%PATH%"],
      shell: false,
    });
  });

  it("prefers a shim's sibling Node and retains inert shebang flags", () => {
    const options = filesystem({
      "C:\\tools\\codex.CMD": shim.replace('"%_prog%" ', '"%_prog%" --no-warnings '),
      "C:\\tools\\node_modules\\codex\\cli.js": "",
      "C:\\tools\\node.exe": "",
    });
    expect(cliSpawnTarget("codex", ["--version"], "win32", options).args).toEqual([
      "--no-warnings",
      "C:\\tools\\node_modules\\codex\\cli.js",
      "--version",
    ]);
  });

  it("allows only inert arguments for confirmed non-Node batch files", () => {
    const options = filesystem({ "C:\\tools\\agent.CMD": "@echo off\r\ncustom %*" });
    const target = cliSpawnTarget("agent", ["--help", "stdio://"], "win32", options);
    expect(target.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(target.shell).toBe(false);
    expect(target.windowsVerbatimArguments).toBe(true);
    for (const value of ["a&b", "%HOME%", "a b", 'say "hi"']) {
      expect(() => cliSpawnTarget("agent", [value], "win32", options)).toThrow(
        expect.objectContaining({ code: "EINVAL" })
      );
    }
  });

  it("rejects shell syntax in probe tokens", () => {
    for (const bad of ["a&b", "a|b", "%PATH%", "^x", '"q"', "a b", "a>b", "(x)", "!x"]) {
      expect(isShellInertInvocation("codex", [bad])).toBe(false);
    }
    expect(isShellInertInvocation("codex", ["stdio://"])).toBe(true);
  });

  it("leaves POSIX spawning unchanged", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(cliSpawnTarget("codex", ["--version"], platform)).toEqual({
        command: "codex",
        args: ["--version"],
        shell: false,
      });
    }
  });
});
