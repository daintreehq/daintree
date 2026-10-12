import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  executableForSpawn,
  resetWindowsExecutableCache,
  resolveWindowsExecutable,
  windowsSystemRoot,
  windowsSystemTool,
} from "../windowsExecutable.js";

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
    expect(resolveWindowsExecutable("git", { PATH: ".;bin;" })).toBe("git");
    expect(resolveWindowsExecutable("git", { PATH: "" })).toBe("git");
    expect(resolveWindowsExecutable("git", {})).toBe("git");
  });

  it("tries .exe then .com for a bare name, and only the given name when it has an extension", () => {
    const both = dir("both");
    const exe = touch(both, "tool.exe");
    touch(both, "tool.com");
    const comOnly = dir("com-only");
    const com = touch(comOnly, "other.com");
    const scripts = dir("scripts");
    touch(scripts, "plain");
    touch(scripts, "shim.cmd");

    expect(resolveWindowsExecutable("tool", { PATH: both })).toBe(exe);
    expect(resolveWindowsExecutable("other", { PATH: comOnly })).toBe(com);
    // An extensionless file and a batch shim are not what a bare name launches.
    expect(resolveWindowsExecutable("plain", { PATH: scripts })).toBe("plain");
    expect(resolveWindowsExecutable("shim", { PATH: scripts })).toBe("shim");
    expect(resolveWindowsExecutable("shim.cmd", { PATH: scripts })).toBe(
      path.join(scripts, "shim.cmd")
    );
    expect(resolveWindowsExecutable("tool.exe", { PATH: both })).toBe(exe);
  });

  it("strips quotes from a PATH entry", () => {
    const quoted = dir("with space");
    const expected = touch(quoted, "gh.exe");

    expect(resolveWindowsExecutable("gh", { PATH: `"${quoted}"` })).toBe(expected);
  });

  it("leaves a name that is already a path alone", () => {
    const tools = dir("tools");
    touch(tools, "git.exe");

    for (const name of ["./git", "bin\\git", "C:git", path.join(tools, "git.exe")]) {
      expect(resolveWindowsExecutable(name, { PATH: tools })).toBe(name);
    }
  });

  it("caches per PATH value and searches again when PATH changes", () => {
    const first = dir("first");
    const second = dir("second");
    const cached = touch(first, "git.exe");
    const moved = touch(second, "git.exe");

    expect(resolveWindowsExecutable("git", { PATH: first })).toBe(cached);
    fs.rmSync(cached);
    expect(resolveWindowsExecutable("git", { PATH: first })).toBe(cached);
    expect(resolveWindowsExecutable("git", { PATH: `${first};${second}` })).toBe(moved);
  });

  it("does not cache a miss, so a tool installed later is found", () => {
    const tools = dir("tools");

    expect(resolveWindowsExecutable("git", { PATH: tools })).toBe("git");
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
    expect(resolveWindowsExecutable("git", { Path: "C:tools;\\tools;." }, { isFile })).toBe("git");
    expect(isFile).not.toHaveBeenCalled();
    expect(resolveWindowsExecutable("git", { Path: "C:tools;C:\\Tools" }, { isFile })).toBe(
      "C:\\Tools\\git.exe"
    );
    expect(resolveWindowsExecutable("git", { Path: "\\\\server\\share\\bin" }, { isFile })).toBe(
      "\\\\server\\share\\bin\\git.exe"
    );
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
