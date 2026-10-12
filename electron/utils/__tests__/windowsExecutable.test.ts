import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "child_process";
import {
  executableForSpawn,
  findWindowsExecutables,
  invalidateWindowsExecutableCache,
  resetWindowsExecutableCache,
  resolveWindowsCommand,
  resolveWindowsExecutable,
  splitWindowsPath,
  windowsLaunchExtensions,
  windowsSystemRoot,
  windowsSystemTool,
  windowsWhere,
} from "../windowsExecutable.js";

vi.mock("child_process", () => ({ execFile: vi.fn() }));
const execFileMock = vi.mocked(execFile);
import { isMissingGitExecutableError } from "../../../shared/utils/gitOperationErrors.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalCwd = process.cwd();

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

let root: string;

function dir(name: string): string {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function touch(directory: string, file: string): string {
  const full = path.join(directory, file);
  fs.writeFileSync(full, "");
  return full;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-winexe-")));
  resetWindowsExecutableCache();
});

afterEach(() => {
  process.chdir(originalCwd);
  Object.defineProperty(process, "platform", originalPlatform);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("splitWindowsPath", () => {
  it("splits on semicolons outside double quotes and drops the quotes", () => {
    expect(splitWindowsPath('C:\\a;"C:\\b;c";;"C:\\d"')).toEqual(["C:\\a", "C:\\b;c", "C:\\d"]);
    expect(splitWindowsPath('"C:\\Program Files\\x";D:\\y;')).toEqual([
      "C:\\Program Files\\x",
      "D:\\y",
    ]);
    expect(splitWindowsPath("")).toEqual([]);
  });
});

describe("windowsLaunchExtensions", () => {
  it("keeps PATHEXT's order and spelling, limited to what can be launched", () => {
    expect(windowsLaunchExtensions({ PATHEXT: ".CMD;.JS;.exe;.PS1;.CMD;.Bat" })).toEqual([
      ".CMD",
      ".exe",
      ".Bat",
    ]);
    expect(windowsLaunchExtensions({})).toEqual([".COM", ".EXE", ".BAT", ".CMD"]);
  });
});

describe("resolveWindowsExecutable", () => {
  it("returns the first PATH directory that holds the tool", () => {
    const first = dir("first");
    const second = dir("second");
    touch(second, "git.exe");
    const expected = touch(first, "git.exe");

    expect(resolveWindowsExecutable("git", { PATH: `${first};${second}` })).toBe(expected);
    expect(resolveWindowsExecutable("git", { PATH: `${second};${first}` })).toBe(
      path.join(second, "git.exe")
    );
  });

  it("never runs a same-named file from the working directory or a relative PATH entry", () => {
    const repo = dir("repo");
    touch(repo, "git.exe");
    touch(dir("repo/bin"), "git.exe");
    const tools = dir("tools");
    const real = touch(tools, "git.exe");
    process.chdir(repo);

    expect(resolveWindowsExecutable("git", { PATH: `.;;bin;.\\bin;${tools}` })).toBe(real);
    expect(resolveWindowsExecutable("git", { PATH: ".;bin;" })).toBeNull();
    expect(resolveWindowsExecutable("git", { PATH: "" })).toBeNull();
    expect(resolveWindowsExecutable("git", {})).toBeNull();
  });

  it("tries .com then .exe for a bare name, as process creation does", () => {
    const both = dir("both");
    const com = touch(both, "tool.com");
    const exe = touch(both, "tool.exe");
    const exeOnly = dir("exe-only");
    const other = touch(exeOnly, "other.exe");
    const scripts = dir("scripts");
    touch(scripts, "plain");
    touch(scripts, "shim.cmd");

    expect(resolveWindowsExecutable("tool", { PATH: both })).toBe(com);
    expect(resolveWindowsExecutable("other", { PATH: exeOnly })).toBe(other);
    // An extensionless file and a batch shim are not what a bare name launches.
    expect(resolveWindowsExecutable("plain", { PATH: scripts })).toBeNull();
    expect(resolveWindowsExecutable("shim", { PATH: scripts })).toBeNull();
    // A name with an extension is tried as given first.
    expect(resolveWindowsExecutable("shim.cmd", { PATH: scripts })).toBe(
      path.join(scripts, "shim.cmd")
    );
    expect(resolveWindowsExecutable("tool.exe", { PATH: both })).toBe(exe);
    const versioned = touch(dir("versioned"), "python3.11.exe");
    expect(resolveWindowsExecutable("python3.11", { PATH: path.dirname(versioned) })).toBe(
      versioned
    );
  });

  it("strips quotes from a PATH entry and keeps a quoted semicolon in the directory", () => {
    const quoted = dir("with space");
    const expected = touch(quoted, "gh.exe");
    const semicolon = dir("a;b");
    const inSemicolon = touch(semicolon, "node.exe");

    expect(resolveWindowsExecutable("gh", { PATH: `"${quoted}"` })).toBe(expected);
    expect(resolveWindowsExecutable("node", { PATH: `"${semicolon}"` })).toBe(inSemicolon);
    // Unquoted, the same text is two directories, neither of which holds it.
    expect(resolveWindowsExecutable("node", { PATH: semicolon })).toBeNull();
  });

  it("leaves a name that is already a path alone", () => {
    const tools = dir("tools");
    touch(tools, "git.exe");

    for (const name of ["./git", "bin\\git", "C:git", path.join(tools, "git.exe")]) {
      expect(resolveWindowsExecutable(name, { PATH: tools })).toBe(name);
    }
  });

  it("re-checks a cached hit, so a removed tool is searched for again", () => {
    const first = dir("first");
    const second = dir("second");
    const cached = touch(first, "git.exe");
    const fallback = touch(second, "git.exe");
    const env = { PATH: `${first};${second}` };

    expect(resolveWindowsExecutable("git", env)).toBe(cached);
    fs.rmSync(cached);
    expect(resolveWindowsExecutable("git", env)).toBe(fallback);
    fs.rmSync(fallback);
    expect(resolveWindowsExecutable("git", env)).toBeNull();
  });

  it("finds a newly installed earlier candidate once the cache is invalidated", () => {
    const first = dir("first");
    const second = dir("second");
    const old = touch(second, "git.exe");
    const env = { PATH: `${first};${second}` };

    expect(resolveWindowsExecutable("git", env)).toBe(old);
    const installed = touch(first, "git.exe");
    // Same PATH text, so only the invalidation hook can reveal the new one.
    expect(resolveWindowsExecutable("git", env)).toBe(old);
    invalidateWindowsExecutableCache();
    expect(resolveWindowsExecutable("git", env)).toBe(installed);
  });

  it("caches per PATH value and searches again when PATH changes", () => {
    const first = dir("first");
    const second = dir("second");
    const inFirst = touch(first, "git.exe");
    const inSecond = touch(second, "git.exe");

    expect(resolveWindowsExecutable("git", { PATH: first })).toBe(inFirst);
    expect(resolveWindowsExecutable("git", { PATH: `${second};${first}` })).toBe(inSecond);
  });

  it("does not cache a miss, so a tool installed later is found", () => {
    const tools = dir("tools");

    expect(resolveWindowsExecutable("git", { PATH: tools })).toBeNull();
    const installed = touch(tools, "git.exe");
    expect(resolveWindowsExecutable("git", { PATH: tools })).toBe(installed);
  });

  it("reads PATH under any casing, taking the variant Node would forward", () => {
    const upper = dir("upper");
    const mixed = dir("mixed");
    const fromUpper = touch(upper, "git.exe");
    const fromMixed = touch(mixed, "git.exe");

    expect(resolveWindowsExecutable("git", { Path: mixed })).toBe(fromMixed);
    // Node sorts the keys and forwards the first match: "PATH" sorts before "Path".
    expect(resolveWindowsExecutable("git", { Path: mixed, PATH: upper })).toBe(fromUpper);
  });

  it("only searches drive-qualified or UNC directories on Windows", () => {
    setPlatform("win32");
    const files = new Set(["c:\\tools\\git.exe", "\\\\server\\share\\bin\\git.exe"]);
    const isFile = vi.fn((file: string) => files.has(file.toLowerCase()));

    // `C:tools` and `\tools` are relative to the working directory and drive.
    expect(resolveWindowsExecutable("git", { Path: "C:tools;\\tools;." }, { isFile })).toBeNull();
    expect(isFile).not.toHaveBeenCalled();
    expect(resolveWindowsExecutable("git", { Path: "C:tools;C:\\Tools" }, { isFile })).toBe(
      "C:\\Tools\\git.exe"
    );
    expect(resolveWindowsExecutable("git", { Path: "\\\\server\\share\\bin" }, { isFile })).toBe(
      "\\\\server\\share\\bin\\git.exe"
    );
  });
});

describe("findWindowsExecutables", () => {
  it("lists every PATH match in order, including .cmd shims, for duplicate reporting", () => {
    const npm = dir("npm");
    const scoop = dir("scoop");
    const native = dir("native");
    const npmCmd = touch(npm, "claude.cmd");
    touch(npm, "claude"); // npm's sh script beside the shim
    touch(npm, "claude.ps1");
    const scoopExe = touch(scoop, "claude.exe");
    const nativeExe = touch(native, "claude.exe");
    const nativeCmd = touch(native, "claude.cmd");
    const env = { PATH: `${npm};${scoop};${native}`, PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1" };

    expect(findWindowsExecutables("claude", env)).toEqual([npmCmd, scoopExe, nativeExe, nativeCmd]);
    expect(resolveWindowsCommand("claude", env)).toBe(npmCmd);
  });

  it("never consults the working directory or a relative PATH entry", () => {
    const repo = dir("repo");
    touch(repo, "claude.exe");
    touch(repo, "npm.cmd");
    touch(dir("repo/node_modules/.bin"), "claude.cmd");
    const tools = dir("tools");
    const real = touch(tools, "claude.cmd");
    process.chdir(repo);

    expect(findWindowsExecutables("claude", { PATH: `.;node_modules/.bin;${tools}` })).toEqual([
      real,
    ]);
    expect(findWindowsExecutables("npm", { PATH: "." })).toEqual([]);
    expect(resolveWindowsCommand("npm", { PATH: "" })).toBeNull();
  });

  it("follows PATHEXT, so a .cmd it leaves out is not found", () => {
    const tools = dir("tools");
    const exe = touch(tools, "agent.exe");
    touch(tools, "agent.cmd");

    expect(findWindowsExecutables("agent", { PATH: tools, PATHEXT: ".EXE" })).toEqual([exe]);
  });

  it("looks a name with a launchable extension up as given, and refuses paths", () => {
    const tools = dir("tools");
    const cmd = touch(tools, "agent.cmd");
    touch(tools, "agent.exe");

    expect(findWindowsExecutables("agent.cmd", { PATH: tools })).toEqual([cmd]);
    for (const name of ["", "./agent", "bin\\agent", "C:agent", 'agent"x']) {
      expect(findWindowsExecutables(name, { PATH: tools })).toEqual([]);
    }
  });

  it("handles Windows paths when running on Windows", () => {
    setPlatform("win32");
    const files = new Set(["c:\\npm\\codex.cmd", "d:\\bin\\codex.exe"]);
    const isFile = (file: string) => files.has(file.toLowerCase());

    expect(
      findWindowsExecutables(
        "codex",
        { Path: 'C:npm;"C:\\npm";.;D:\\bin', PATHEXT: ".EXE;.CMD" },
        { isFile }
      )
    ).toEqual(["C:\\npm\\codex.cmd", "D:\\bin\\codex.exe"]);
  });
});

describe("windowsWhere", () => {
  function whereReplies(reply: { stdout?: string; error?: Error }): void {
    execFileMock.mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
      queueMicrotask(() => callback(reply.error ?? null, reply.stdout ?? ""));
      return {};
    }) as never);
  }

  it("keeps only matches in absolute PATH entries, ordered as PATH lists them", async () => {
    whereReplies({
      stdout: [
        // `where` reports its own working directory first, and resolves a
        // relative entry against it: neither is part of PATH.
        "C:\\Windows\\System32\\agent.exe",
        "C:\\Windows\\System32\\rel\\agent.exe",
        "d:\\NPM\\agent.cmd",
        "C:/tools/agent.exe",
        "C:\\tools\\agent.cmd",
        "",
      ].join("\r\n"),
    });
    const env = { Path: '.;rel;"C:\\Tools";D:\\npm\\', SystemRoot: "C:\\Windows" };

    await expect(windowsWhere("agent", env)).resolves.toEqual({
      ok: true,
      paths: ["C:/tools/agent.exe", "C:\\tools\\agent.cmd", "d:\\NPM\\agent.cmd"],
    });
    expect(execFileMock).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\where.exe",
      ["agent"],
      expect.objectContaining({ cwd: "C:\\Windows\\System32", env, windowsHide: true }),
      expect.any(Function)
    );
  });

  it("passes on where's own failure, which is how it reports no match", async () => {
    const error = Object.assign(new Error("exit 1"), { code: 1 });
    whereReplies({ error });

    await expect(windowsWhere("agent", { Path: "C:\\tools" })).resolves.toEqual({
      ok: false,
      error,
    });
  });
});

describe("executableForSpawn", () => {
  it("keeps the bare name off Windows even when PATH holds the tool", () => {
    const tools = dir("tools");
    touch(tools, "git.exe");

    expect(executableForSpawn("git", { PATH: tools }, "darwin")).toBe("git");
    expect(executableForSpawn("git", { PATH: tools }, "linux")).toBe("git");
    expect(executableForSpawn("git", { PATH: tools }, "win32")).toBe(path.join(tools, "git.exe"));
  });

  it("throws spawn's ENOENT on Windows instead of handing spawn the bare name", () => {
    const repo = dir("repo");
    touch(repo, "git.exe");
    process.chdir(repo);

    expect(executableForSpawn("git", { PATH: "." }, "linux")).toBe("git");
    let error: unknown;
    try {
      executableForSpawn("git", { PATH: "." }, "win32");
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: "ENOENT",
      syscall: "spawn git",
      path: "git",
      message: "spawn git ENOENT",
    });
    // What the app's "Git executable not found" reporting keys on.
    expect(isMissingGitExecutableError(error)).toBe(true);
  });
});

describe("windowsSystemTool", () => {
  it("builds in-box tool paths under SystemRoot, read case-insensitively", () => {
    const env = { SYSTEMROOT: "D:\\Win" };
    expect(windowsSystemTool("powershell.exe", env)).toBe(
      "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    );
    expect(windowsSystemTool("reg.exe", { systemroot: "D:\\Win\\" })).toBe(
      "D:\\Win\\System32\\reg.exe"
    );
    expect(windowsSystemTool("wsl.exe", env)).toBe("D:\\Win\\System32\\wsl.exe");
  });

  it("falls back to windir, then C:\\Windows, and never to a relative root", () => {
    expect(windowsSystemRoot({ windir: "E:\\Windows" })).toBe("E:\\Windows");
    expect(windowsSystemRoot({ SystemRoot: "Windows", windir: "E:\\Windows" })).toBe("E:\\Windows");
    expect(windowsSystemRoot({ SystemRoot: "C:Windows" })).toBe("C:\\Windows");
    expect(windowsSystemTool("where.exe", {})).toBe("C:\\Windows\\System32\\where.exe");
  });
});
