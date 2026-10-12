import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  executableForSpawn,
  findWindowsCommand,
  invalidateWindowsExecutableCache,
  peekWindowsExecutable,
  prewarmWindowsExecutables,
  resetWindowsExecutableCache,
  resolveExecutableForSpawn,
  resolveWindowsExecutable,
  scanWindowsPath,
  splitWindowsPath,
  windowsLaunchExtensions,
  windowsSystemRoot,
  windowsSystemTool,
  type WindowsDirectoryEntry,
  type WindowsPathFs,
} from "../windowsExecutable.js";
import { isMissingGitExecutableError } from "../../../shared/utils/gitOperationErrors.js";

// Pass-through recorders for the synchronous calls a PATH search must never
// make: one against a dead network share blocks the calling loop.
const syncFs = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const record =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      syncFs.calls.push(`${name} ${String(args[0])}`);
      return fn(...args);
    };
  const spied = {
    statSync: record("statSync", actual.statSync),
    lstatSync: record("lstatSync", actual.lstatSync),
    readdirSync: record("readdirSync", actual.readdirSync),
    existsSync: record("existsSync", actual.existsSync),
  };
  return { ...actual, ...spied, default: { ...actual, ...spied } };
});

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

/**
 * A disk of Windows paths for a search running as win32. A directory listed in
 * `hang` never answers, the way one on a dropped network share waits out the
 * SMB timeout.
 */
function windowsDisk(
  files: string[],
  options: { hang?: string[] } = {}
): WindowsPathFs & {
  readdir: ReturnType<typeof vi.fn<(directory: string) => Promise<WindowsDirectoryEntry[]>>>;
} {
  const byPath = new Map(files.map((file) => [file.toLowerCase(), file]));
  const hang = new Set((options.hang ?? []).map((entry) => entry.toLowerCase()));
  const entry = (name: string): WindowsDirectoryEntry => ({
    name,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  });
  const missing = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  return {
    readdir: vi.fn(async (directory: string) => {
      const trim = (value: string) => value.replace(/\\+$/, "").toLowerCase();
      const key = trim(directory);
      if (hang.has(key)) return new Promise<WindowsDirectoryEntry[]>(() => {});
      const names = [...byPath.values()]
        .filter((file) => trim(path.win32.dirname(file)) === key)
        .map((file) => entry(path.win32.basename(file)));
      if (names.length === 0) throw missing();
      return names;
    }),
    stat: async (file: string) => {
      if (!byPath.has(file.toLowerCase())) throw missing();
      return { isFile: () => true };
    },
    lstat: async () => {
      throw missing();
    },
  };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-winexe-")));
  resetWindowsExecutableCache();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
  it("returns the first PATH directory that holds the tool", async () => {
    const first = dir("first");
    const second = dir("second");
    touch(second, "git.exe");
    const expected = touch(first, "git.exe");

    await expect(resolveWindowsExecutable("git", { PATH: `${first};${second}` })).resolves.toBe(
      expected
    );
    await expect(resolveWindowsExecutable("git", { PATH: `${second};${first}` })).resolves.toBe(
      path.join(second, "git.exe")
    );
  });

  it("never runs a same-named file from the working directory or a relative PATH entry", async () => {
    const repo = dir("repo");
    touch(repo, "git.exe");
    touch(dir("repo/bin"), "git.exe");
    const tools = dir("tools");
    const real = touch(tools, "git.exe");
    process.chdir(repo);

    await expect(resolveWindowsExecutable("git", { PATH: `.;;bin;.\\bin;${tools}` })).resolves.toBe(
      real
    );
    await expect(resolveWindowsExecutable("git", { PATH: ".;bin;" })).resolves.toBeNull();
    await expect(resolveWindowsExecutable("git", { PATH: "" })).resolves.toBeNull();
    await expect(resolveWindowsExecutable("git", {})).resolves.toBeNull();
  });

  it("tries .com then .exe for a bare name, as process creation does", async () => {
    const both = dir("both");
    const com = touch(both, "tool.com");
    const exe = touch(both, "tool.exe");
    const exeOnly = dir("exe-only");
    const other = touch(exeOnly, "other.exe");
    const scripts = dir("scripts");
    touch(scripts, "plain");
    touch(scripts, "shim.cmd");

    await expect(resolveWindowsExecutable("tool", { PATH: both })).resolves.toBe(com);
    await expect(resolveWindowsExecutable("other", { PATH: exeOnly })).resolves.toBe(other);
    // An extensionless file and a batch shim are not what a bare name launches.
    await expect(resolveWindowsExecutable("plain", { PATH: scripts })).resolves.toBeNull();
    await expect(resolveWindowsExecutable("shim", { PATH: scripts })).resolves.toBeNull();
    // A name with an extension is tried as given first.
    await expect(resolveWindowsExecutable("shim.cmd", { PATH: scripts })).resolves.toBe(
      path.join(scripts, "shim.cmd")
    );
    await expect(resolveWindowsExecutable("tool.exe", { PATH: both })).resolves.toBe(exe);
    const versioned = touch(dir("versioned"), "python3.11.exe");
    await expect(
      resolveWindowsExecutable("python3.11", { PATH: path.dirname(versioned) })
    ).resolves.toBe(versioned);
  });

  it("strips quotes from a PATH entry and keeps a quoted semicolon in the directory", async () => {
    const quoted = dir("with space");
    const expected = touch(quoted, "gh.exe");
    const semicolon = dir("a;b");
    const inSemicolon = touch(semicolon, "node.exe");

    await expect(resolveWindowsExecutable("gh", { PATH: `"${quoted}"` })).resolves.toBe(expected);
    await expect(resolveWindowsExecutable("node", { PATH: `"${semicolon}"` })).resolves.toBe(
      inSemicolon
    );
    // Unquoted, the same text is two directories, neither of which holds it.
    await expect(resolveWindowsExecutable("node", { PATH: semicolon })).resolves.toBeNull();
  });

  it("finds a tool under a non-ASCII directory, as the directory names it", async () => {
    // `where` printed this in the console code page, mangling it past the PATH check.
    const shims = dir("山田/scoop/shims");
    const gh = touch(shims, "gh.exe");

    await expect(resolveWindowsExecutable("gh", { PATH: shims })).resolves.toBe(gh);
    await expect(scanWindowsPath("gh", { PATH: `${dir("empty")};${shims}` })).resolves.toEqual({
      paths: [gh],
      skipped: [],
    });
  });

  it("leaves a name that is already a path alone", async () => {
    const tools = dir("tools");
    touch(tools, "git.exe");

    for (const name of ["./git", "bin\\git", "C:git", path.join(tools, "git.exe")]) {
      await expect(resolveWindowsExecutable(name, { PATH: tools })).resolves.toBe(name);
    }
  });

  it("re-checks a cached hit, so a removed tool is searched for again", async () => {
    const first = dir("first");
    const second = dir("second");
    const cached = touch(first, "git.exe");
    const fallback = touch(second, "git.exe");
    const env = { PATH: `${first};${second}` };

    await expect(resolveWindowsExecutable("git", env)).resolves.toBe(cached);
    fs.rmSync(cached);
    await expect(resolveWindowsExecutable("git", env)).resolves.toBe(fallback);
    fs.rmSync(fallback);
    await expect(resolveWindowsExecutable("git", env)).resolves.toBeNull();
  });

  it("finds a newly installed earlier candidate once the cache is invalidated", async () => {
    const first = dir("first");
    const second = dir("second");
    const old = touch(second, "git.exe");
    const env = { PATH: `${first};${second}` };

    await expect(resolveWindowsExecutable("git", env)).resolves.toBe(old);
    const installed = touch(first, "git.exe");
    // Same PATH text, so only the invalidation hook can reveal the new one.
    await expect(resolveWindowsExecutable("git", env)).resolves.toBe(old);
    invalidateWindowsExecutableCache();
    await expect(resolveWindowsExecutable("git", env)).resolves.toBe(installed);
  });

  it("caches per PATH value and searches again when PATH changes", async () => {
    const first = dir("first");
    const second = dir("second");
    const inFirst = touch(first, "git.exe");
    const inSecond = touch(second, "git.exe");

    await expect(resolveWindowsExecutable("git", { PATH: first })).resolves.toBe(inFirst);
    await expect(resolveWindowsExecutable("git", { PATH: `${second};${first}` })).resolves.toBe(
      inSecond
    );
  });

  it("does not cache a miss, so a tool installed later is found", async () => {
    const tools = dir("tools");

    await expect(resolveWindowsExecutable("git", { PATH: tools })).resolves.toBeNull();
    const installed = touch(tools, "git.exe");
    await expect(resolveWindowsExecutable("git", { PATH: tools })).resolves.toBe(installed);
  });

  it("reads PATH under any casing, taking the variant Node would forward", async () => {
    const upper = dir("upper");
    const mixed = dir("mixed");
    const fromUpper = touch(upper, "git.exe");
    const fromMixed = touch(mixed, "git.exe");

    await expect(resolveWindowsExecutable("git", { Path: mixed })).resolves.toBe(fromMixed);
    // Node sorts the keys and forwards the first match: "PATH" sorts before "Path".
    await expect(resolveWindowsExecutable("git", { Path: mixed, PATH: upper })).resolves.toBe(
      fromUpper
    );
  });

  it("only searches drive-qualified or UNC directories on Windows", async () => {
    setPlatform("win32");
    const disk = windowsDisk(["C:\\Tools\\git.exe", "\\\\server\\share\\bin\\git.exe"]);

    // `C:tools` and `\tools` are relative to the working directory and drive.
    await expect(
      resolveWindowsExecutable("git", { Path: "C:tools;\\tools;." }, { fs: disk })
    ).resolves.toBeNull();
    expect(disk.readdir).not.toHaveBeenCalled();
    await expect(
      resolveWindowsExecutable("git", { Path: "C:tools;C:\\Tools" }, { fs: disk })
    ).resolves.toBe("C:\\Tools\\git.exe");
    await expect(
      resolveWindowsExecutable("git", { Path: "\\\\server\\share\\bin" }, { fs: disk })
    ).resolves.toBe("\\\\server\\share\\bin\\git.exe");
  });

  it("never touches the disk synchronously", async () => {
    const tools = dir("tools");
    const git = touch(tools, "git.exe");
    syncFs.calls.length = 0;

    await expect(resolveWindowsExecutable("git", { PATH: tools })).resolves.toBe(git);
    await expect(resolveWindowsExecutable("git", { PATH: tools })).resolves.toBe(git);
    await expect(scanWindowsPath("git", { PATH: tools })).resolves.toEqual({
      paths: [git],
      skipped: [],
    });
    expect(syncFs.calls).toEqual([]);
  });
});

describe("a PATH entry that does not answer", () => {
  beforeEach(() => {
    setPlatform("win32");
    vi.useFakeTimers();
  });

  it("is searched past after the timeout, logged once, and not asked again while it hangs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const disk = windowsDisk(["C:\\tools\\git.exe", "C:\\npm\\claude.cmd"], {
      hang: ["\\\\nas\\tools"],
    });
    const env = { PATH: "\\\\nas\\tools;C:\\tools;C:\\npm" };

    let settled = false;
    const first = resolveWindowsExecutable("git", env, { fs: disk }).then((file) => {
      settled = true;
      return file;
    });
    // A search started meanwhile shares the same hung listing.
    const scan = scanWindowsPath("claude", env, { fs: disk });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(500);

    await expect(first).resolves.toBe("C:\\tools\\git.exe");
    await expect(scan).resolves.toEqual({
      paths: ["C:\\npm\\claude.cmd"],
      skipped: ["\\\\nas\\tools"],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("\\\\nas\\tools");

    // Written off: later searches skip it at once, without queueing another call.
    const hungListings = () =>
      disk.readdir.mock.calls.filter(([directory]) => directory === "\\\\nas\\tools").length;
    expect(hungListings()).toBe(1);
    await expect(findWindowsCommand("claude", env, { fs: disk })).resolves.toBe(
      "C:\\npm\\claude.cmd"
    );
    await expect(scanWindowsPath("git", env, { fs: disk })).resolves.toEqual({
      paths: ["C:\\tools\\git.exe"],
      skipped: ["\\\\nas\\tools"],
    });
    expect(hungListings()).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not hold up a directory that answers, even when it comes first", async () => {
    const disk = windowsDisk(["C:\\tools\\git.exe"], { hang: ["\\\\nas\\tools"] });

    let file: string | null | undefined;
    void resolveWindowsExecutable("git", { PATH: "C:\\tools;\\\\nas\\tools" }, { fs: disk }).then(
      (found) => {
        file = found;
      }
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(file).toBe("C:\\tools\\git.exe");
  });

  it("is tried again once its hung call fails and the retry window passes, or as soon as it answers", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const disk = windowsDisk(["C:\\tools\\git.exe", "\\\\nas\\tools\\gh.exe"]);
    let failHung: (error: Error) => void = () => {};
    let answerHung: (entries: WindowsDirectoryEntry[]) => void = () => {};
    const listNas = vi.fn(
      () =>
        new Promise<WindowsDirectoryEntry[]>((resolve, reject) => {
          failHung = reject;
          answerHung = resolve;
        })
    );
    const answer = disk.readdir.getMockImplementation()!;
    disk.readdir.mockImplementation((directory: string) =>
      directory === "\\\\nas\\tools" ? listNas() : answer(directory)
    );
    const env = { PATH: "\\\\nas\\tools;C:\\tools" };

    const first = scanWindowsPath("git", env, { fs: disk });
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(first).resolves.toMatchObject({ skipped: ["\\\\nas\\tools"] });

    // The share gives up (the SMB timeout): still skipped for the retry window.
    failHung(Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }));
    await vi.advanceTimersByTimeAsync(29_000);
    await scanWindowsPath("git", env, { fs: disk });
    expect(listNas).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    const retried = scanWindowsPath("gh", env, { fs: disk });
    expect(listNas).toHaveBeenCalledTimes(2);

    // This time it answers, late but whole: written off for that search only.
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(retried).resolves.toEqual({ paths: [], skipped: ["\\\\nas\\tools"] });
    answerHung(await answer("\\\\nas\\tools"));
    await vi.advanceTimersByTimeAsync(0);
    disk.readdir.mockImplementation(answer);
    await expect(findWindowsCommand("gh", env, { fs: disk })).resolves.toBe(
      "\\\\nas\\tools\\gh.exe"
    );
  });

  it("counts as holding nothing, so a tool only there is not found", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const disk = windowsDisk(["\\\\nas\\tools\\git.exe"], { hang: ["\\\\nas\\tools"] });

    const result = resolveWindowsExecutable("git", { PATH: "\\\\nas\\tools" }, { fs: disk });
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(result).resolves.toBeNull();
  });
});

describe("scanWindowsPath / findWindowsCommand", () => {
  it("lists every PATH match in order, including .cmd shims, for duplicate reporting", async () => {
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

    await expect(scanWindowsPath("claude", env)).resolves.toEqual({
      paths: [npmCmd, scoopExe, nativeExe, nativeCmd],
      skipped: [],
    });
    await expect(findWindowsCommand("claude", env)).resolves.toBe(npmCmd);
  });

  it("searches a directory PATH lists twice once", async () => {
    const npm = dir("npm");
    const shim = touch(npm, "codex.cmd");

    await expect(scanWindowsPath("codex", { PATH: `${npm};${npm}` })).resolves.toEqual({
      paths: [shim],
      skipped: [],
    });
  });

  it("never consults the working directory or a relative PATH entry", async () => {
    const repo = dir("repo");
    touch(repo, "claude.exe");
    touch(repo, "npm.cmd");
    touch(dir("repo/node_modules/.bin"), "claude.cmd");
    const tools = dir("tools");
    const real = touch(tools, "claude.cmd");
    process.chdir(repo);

    await expect(
      scanWindowsPath("claude", { PATH: `.;node_modules/.bin;${tools}` })
    ).resolves.toEqual({ paths: [real], skipped: [] });
    await expect(scanWindowsPath("npm", { PATH: "." })).resolves.toEqual({
      paths: [],
      skipped: [],
    });
    await expect(findWindowsCommand("npm", { PATH: "" })).resolves.toBeNull();
  });

  it("follows PATHEXT, so a .cmd it leaves out is not found", async () => {
    const tools = dir("tools");
    const exe = touch(tools, "agent.exe");
    touch(tools, "agent.cmd");

    await expect(scanWindowsPath("agent", { PATH: tools, PATHEXT: ".EXE" })).resolves.toEqual({
      paths: [exe],
      skipped: [],
    });
  });

  it("looks a name with a launchable extension up as given, and refuses paths", async () => {
    const tools = dir("tools");
    const cmd = touch(tools, "agent.cmd");
    touch(tools, "agent.exe");

    await expect(findWindowsCommand("agent.cmd", { PATH: tools })).resolves.toBe(cmd);
    for (const name of ["", "./agent", "bin\\agent", "C:agent", 'agent"x']) {
      await expect(scanWindowsPath(name, { PATH: tools })).resolves.toEqual({
        paths: [],
        skipped: [],
      });
    }
  });

  it("handles Windows paths when running on Windows", async () => {
    setPlatform("win32");
    const disk = windowsDisk(["C:\\npm\\codex.cmd", "D:\\bin\\codex.exe"]);

    await expect(
      scanWindowsPath(
        "codex",
        { Path: 'C:npm;"C:\\npm";.;D:\\bin', PATHEXT: ".EXE;.CMD" },
        { fs: disk }
      )
    ).resolves.toEqual({ paths: ["C:\\npm\\codex.cmd", "D:\\bin\\codex.exe"], skipped: [] });
  });
});

describe("executableForSpawn / resolveExecutableForSpawn", () => {
  it("keeps the bare name off Windows even when PATH holds the tool", async () => {
    const tools = dir("tools");
    touch(tools, "git.exe");

    expect(executableForSpawn("git", { PATH: tools }, "darwin")).toBe("git");
    expect(executableForSpawn("git", { PATH: tools }, "linux")).toBe("git");
    await expect(resolveExecutableForSpawn("git", { PATH: tools }, "linux")).resolves.toBe("git");
    await expect(resolveExecutableForSpawn("git", { PATH: tools }, "win32")).resolves.toBe(
      path.join(tools, "git.exe")
    );
  });

  it("rejects with spawn's ENOENT on Windows instead of handing spawn the bare name", async () => {
    const repo = dir("repo");
    touch(repo, "git.exe");
    process.chdir(repo);

    await expect(resolveExecutableForSpawn("git", { PATH: "." }, "linux")).resolves.toBe("git");
    const error = await resolveExecutableForSpawn("git", { PATH: "." }, "win32").catch(
      (caught: unknown) => caught
    );
    expect(error).toMatchObject({
      code: "ENOENT",
      syscall: "spawn git",
      path: "git",
      message: "spawn git ENOENT",
    });
    // What the app's "Git executable not found" reporting keys on.
    expect(isMissingGitExecutableError(error)).toBe(true);
  });

  it("answers synchronously from what an asynchronous lookup cached, never searching PATH itself", async () => {
    const tools = dir("tools");
    const git = touch(tools, "git.exe");
    const env = { PATH: tools };
    syncFs.calls.length = 0;

    // Off Windows there is nothing to prewarm.
    await prewarmWindowsExecutables(["git"], env);
    expect(peekWindowsExecutable("git", env)).toBeUndefined();
    // Cold: a miss for now (never a bare name), with the lookup started.
    expect(() => executableForSpawn("git", env, "win32")).toThrow(
      expect.objectContaining({ code: "ENOENT", syscall: "spawn git" })
    );
    await expect(resolveExecutableForSpawn("git", env, "win32")).resolves.toBe(git);
    expect(peekWindowsExecutable("git", env)).toBe(git);
    expect(executableForSpawn("git", env, "win32")).toBe(git);
    expect(syncFs.calls).toEqual([]);

    // A PATH refresh drops it until it is resolved again.
    invalidateWindowsExecutableCache();
    expect(peekWindowsExecutable("git", env)).toBeUndefined();
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
    expect(windowsSystemTool("cmd.exe", {})).toBe("C:\\Windows\\System32\\cmd.exe");
  });
});
