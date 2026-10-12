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

  it("unwraps npm's full current template and refuses one with extra lines", () => {
    const head = [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      "",
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ") ELSE (",
      '  SET "_prog=node"',
      ")",
      "",
    ];
    const call =
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\node_modules\\codex\\cli.js" %*';
    const script = "C:\\tools\\node_modules\\codex\\cli.js";
    const files = (source: string) =>
      filesystem({
        "C:\\tools\\codex.CMD": source,
        [script]: "",
        "C:\\Program Files\\node\\node.exe": "",
      });

    expect(
      cliSpawnTarget("codex", ["--version"], "win32", files([...head, call].join("\r\n")))
    ).toEqual({
      command: "C:\\Program Files\\node\\node.exe",
      args: [script, "--version"],
      shell: false,
    });

    // cmd.exe would run C:\\other\\node_modules\\codex\\cli.js here.
    const redirected = [...head.slice(0, 8), 'SET "dp0=C:\\other\\"', ...head.slice(8), call];
    const target = cliSpawnTarget("codex", ["--version"], "win32", files(redirected.join("\r\n")));
    expect(target.command).not.toBe("C:\\Program Files\\node\\node.exe");
    expect(target.windowsVerbatimArguments).toBe(true);
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

  describe("classic and hand-written shims", () => {
    const crlf = (...lines: string[]) => lines.map((line) => `${line}\r\n`).join("");
    const pathNode = "C:\\Program Files\\node\\node.exe";
    const script = "C:\\lib\\agent\\cli.js";
    const userArgs = ["--print", 'x&echo hacked%PATH%" ^caret'];
    const localNodeBlock = (call: string, setlocal = false) => [
      '@IF EXIST "%~dp0\\node.exe" (',
      `  "%~dp0\\node.exe" ${call}`,
      ") ELSE (",
      ...(setlocal ? ["  @SETLOCAL"] : []),
      "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
      `  node ${call}`,
      ")",
    ];
    const pnpmNodePath =
      "C:\\tools\\global\\5\\.pnpm\\agent@1.0.0\\node_modules;C:\\tools\\global\\5\\.pnpm\\node_modules";
    const pnpmShim = crlf(
      "@SETLOCAL",
      "@IF NOT DEFINED NODE_PATH (",
      `  @SET "NODE_PATH=${pnpmNodePath}"`,
      ") ELSE (",
      `  @SET "NODE_PATH=${pnpmNodePath};%NODE_PATH%"`,
      ")",
      ...localNodeBlock(' "%~dp0\\..\\lib\\agent\\cli.js" %*')
    );

    it("runs a pnpm global shim's script under Node with the shim's NODE_PATH", () => {
      const options = filesystem({
        "C:\\tools\\agent.CMD": pnpmShim,
        [script]: "",
        [pathNode]: "",
      });
      expect(cliSpawnTarget("agent", userArgs, "win32", options)).toEqual({
        command: pathNode,
        args: [script, ...userArgs],
        shell: false,
        env: { NODE_PATH: pnpmNodePath },
      });

      options.env = { ...options.env, Node_Path: "C:\\mine" };
      expect(cliSpawnTarget("agent", [], "win32", options).env).toEqual({
        Node_Path: `${pnpmNodePath};C:\\mine`,
      });
    });

    it("keeps flags and script arguments in place and applies the PATH prepend", () => {
      const source = crlf(
        "@SETLOCAL",
        '@SET "PATH=C:\\runtime\\a;C:\\runtime\\b;%PATH%"',
        ...localNodeBlock('--no-warnings "%~dp0\\..\\lib\\agent\\cli.js" --stdio %*')
      );
      const options = filesystem({
        "C:\\tools\\agent.CMD": source,
        [script]: "",
        "C:\\runtime\\b\\node.exe": "",
      });
      expect(cliSpawnTarget("agent", ["--version"], "win32", options)).toEqual({
        command: "C:\\runtime\\b\\node.exe",
        args: ["--no-warnings", script, "--stdio", "--version"],
        shell: false,
        env: { Path: "C:\\runtime\\a;C:\\runtime\\b;C:\\tools;C:\\Program Files\\node" },
      });

      const withLocal = filesystem({
        "C:\\tools\\agent.CMD": source,
        [script]: "",
        "C:\\runtime\\b\\node.exe": "",
        "C:\\tools\\node.exe": "",
      });
      expect(cliSpawnTarget("agent", [], "win32", withLocal).command).toBe("C:\\tools\\node.exe");
    });

    it("applies a colon-joined PATH prepend literally, as cmd.exe does", () => {
      // `C:\runtime\b:C:\tools` is one directory name to Windows, so the Node
      // behind it is as unreachable for us as for the shim.
      const source = crlf(
        "@SETLOCAL",
        '@SET "PATH=C:\\runtime\\b:%PATH%"',
        'node "%~dp0\\..\\lib\\agent\\cli.js" %*'
      );
      const options = filesystem({
        "C:\\tools\\agent.CMD": source,
        [script]: "",
        "C:\\runtime\\b\\node.exe": "",
        "C:\\Program Files\\node\\node.exe": "",
      });
      expect(cliSpawnTarget("agent", [], "win32", options)).toEqual({
        command: "C:\\Program Files\\node\\node.exe",
        args: [script],
        shell: false,
        env: { Path: "C:\\runtime\\b:C:\\tools;C:\\Program Files\\node" },
      });
    });

    it("runs a baked Node path and a native target directly", () => {
      const baked = "C:\\Program Files\\nodejs\\node.exe";
      const options = filesystem({
        "C:\\tools\\agent.CMD": crlf(
          "@SETLOCAL",
          `@"${baked}"  "%~dp0\\..\\lib\\agent\\cli.js" %*`
        ),
        "C:\\tools\\native.CMD": crlf("@SETLOCAL", '@"%~dp0\\..\\lib\\agent\\bin\\agent.exe"   %*'),
        [script]: "",
        [baked]: "",
        "C:\\lib\\agent\\bin\\agent.exe": "",
      });
      expect(cliSpawnTarget("agent", userArgs, "win32", options)).toEqual({
        command: baked,
        args: [script, ...userArgs],
        shell: false,
      });
      expect(cliSpawnTarget("native", userArgs, "win32", options)).toEqual({
        command: "C:\\lib\\agent\\bin\\agent.exe",
        args: userArgs,
        shell: false,
      });
    });

    it("unwraps the npm 6 and Yarn classic layout", () => {
      const options = filesystem({
        // Their generator leaves the closing parenthesis without a line break.
        "C:\\tools\\agent.CMD": localNodeBlock(' "%~dp0\\..\\lib\\agent\\cli.js" %*', true).join(
          "\r\n"
        ),
        [script]: "",
        [pathNode]: "",
      });
      expect(cliSpawnTarget("agent", userArgs, "win32", options)).toEqual({
        command: pathNode,
        args: [script, ...userArgs],
        shell: false,
      });
    });

    it("reads pnpm 11's code page wrapper and escaped percent signs", () => {
      const options = filesystem({
        "C:\\tools\\agent.CMD": crlf(
          "@SETLOCAL",
          '@SET "_PNPM_CODEPAGE="',
          `@FOR /F "tokens=2 delims=:" %%a IN ('"%SystemRoot%\\System32\\chcp.com"') DO @SET "_PNPM_CODEPAGE=%%a"`,
          '@"%SystemRoot%\\System32\\chcp.com" 65001 >NUL',
          '@SET "ERRORLEVEL="',
          '@"%~dp0\\José\\50%% off\\agent.exe"   %*',
          '@SET "_PNPM_EXIT_CODE=%ERRORLEVEL%"',
          '@IF DEFINED _PNPM_CODEPAGE @"%SystemRoot%\\System32\\chcp.com" %_PNPM_CODEPAGE% >NUL',
          "@EXIT /B %_PNPM_EXIT_CODE%"
        ),
        "C:\\tools\\José\\50% off\\agent.exe": "",
      });
      expect(cliSpawnTarget("agent", ["%PATH%"], "win32", options)).toEqual({
        command: "C:\\tools\\José\\50% off\\agent.exe",
        args: ["%PATH%"],
        shell: false,
      });
    });

    it.each([
      ["claude.js", "C:\\tools\\claude.js"],
      ["\\claude.js", "C:\\tools\\claude.js"],
      [".\\claude.js", "C:\\tools\\claude.js"],
      ["..\\lib\\claude.js", "C:\\lib\\claude.js"],
    ])("unwraps hand-written wrappers that run %%~dp0%s", (relative, resolved) => {
      const baked = "C:\\Program Files\\nodejs\\node.exe";
      const options = filesystem({
        "C:\\tools\\bare.CMD": crlf("@echo off", `node "%~dp0${relative}" %*`),
        "C:\\tools\\baked.CMD": crlf("@echo off", `"${baked}" "%~dp0${relative}" %*`),
        [resolved]: "",
        [baked]: "",
        [pathNode]: "",
      });
      expect(cliSpawnTarget("bare", userArgs, "win32", options)).toEqual({
        command: pathNode,
        args: [resolved, ...userArgs],
        shell: false,
      });
      expect(cliSpawnTarget("baked", userArgs, "win32", options)).toEqual({
        command: baked,
        args: [resolved, ...userArgs],
        shell: false,
      });
    });

    it.each([
      ["an unknown line", pnpmShim.replace("@SETLOCAL", '@SETLOCAL\r\n@SET "NODE_OPTIONS=-r x"')],
      ["branches that disagree", pnpmShim.replace('node  "%~dp0\\..', 'node  "%~dp0\\..\\..')],
      ["NODE_PATH lines that disagree", pnpmShim.replace(";%NODE_PATH%", ";C:\\x;%NODE_PATH%")],
      ["another interpreter", pnpmShim.replaceAll("node.exe", "sh.exe")],
      ["a baked interpreter other than Node", crlf('"C:\\py\\python.exe" "%~dp0claude.js" %*')],
      ["a variable in the script path", crlf('node "%~dp0%AGENT%\\cli.js" %*')],
      ["a drive-relative script after %~dp0", crlf('node "%~dp0C:claude.js" %*')],
      ["a non-flag shim argument", crlf('node "%~dp0claude.js" extra&calc %*')],
      ["a call without %*", crlf('node "%~dp0claude.js"')],
      ["a line after the call", crlf("@echo off", 'node "%~dp0claude.js" %*', "@echo done")],
      ["a native target that is not an executable", crlf('@"%~dp0\\tool.ps1" %*')],
    ])("leaves %s to the cmd.exe fallback", (_label, source) => {
      const options = filesystem({
        "C:\\tools\\agent.CMD": source,
        "C:\\tools\\claude.js": "",
        "C:\\tools\\tool.ps1": "",
        [script]: "",
        [pathNode]: "",
        "C:\\py\\python.exe": "",
      });
      const target = cliSpawnTarget("agent", ["--help"], "win32", options);
      expect(target.command).toBe("C:\\Windows\\System32\\cmd.exe");
      expect(target.windowsVerbatimArguments).toBe(true);
    });

    it("reports a recognised shim whose script is missing", () => {
      const options = filesystem({ "C:\\tools\\agent.CMD": pnpmShim, [pathNode]: "" });
      expect(() => cliSpawnTarget("agent", [], "win32", options)).toThrow(
        expect.objectContaining({ code: "ENOENT", path: script })
      );
    });
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
