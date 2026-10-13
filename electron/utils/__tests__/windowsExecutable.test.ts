import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  executableForSpawn,
  findWindowsCommand,
  invalidateWindowsExecutableCache,
  lookupWindowsExecutable,
  peekWindowsExecutable,
  prewarmWindowsExecutables,
  resetWindowsExecutableCache,
  resolveExecutableForSpawn,
  resolveWindowsExecutable,
  scanWindowsPath,
  splitWindowsPath,
  windowsLaunchExtensions,
  windowsPathEntriesReadable,
  windowsSystemRoot,
  windowsSystemTool,
  type WindowsDirectoryEntry,
} from "../windowsExecutable.js";
import { isMissingGitExecutableError } from "../../../shared/utils/gitOperationErrors.js";
import { fakeWindowsPathFs, type FakeWindowsPathFs } from "./helpers/windowsPathFs.js";

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
 * SMB timeout; one in `denyListing` can be traversed but not listed.
 */
const windowsDisk = (
  files: string[],
  options: { hang?: string[]; denyListing?: string[] } = {}
): FakeWindowsPathFs => fakeWindowsPathFs(files, options);

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Directory listings that each wait to be answered or failed by the test, with
 * a count of how many are outstanding at once.
 */
function controlledDisk(files: string[]) {
  const disk = windowsDisk(files);
  const answer = disk.readdir.getMockImplementation()!;
  const calls = new Map<string, Deferred<WindowsDirectoryEntry[]>>();
  const order: string[] = [];
  let outstanding = 0;
  let peak = 0;
  disk.readdir.mockImplementation((directory: string) => {
    outstanding++;
    peak = Math.max(peak, outstanding);
    order.push(directory);
    const call = deferred<WindowsDirectoryEntry[]>();
    calls.set(directory, call);
    const settle = () => {
      outstanding--;
    };
    call.promise.then(settle, settle);
    return call.promise;
  });
  return {
    disk,
    order,
    outstanding: () => outstanding,
    peak: () => peak,
    /** Answer `directory`'s outstanding listing with what the disk holds there. */
    answer: async (directory: string) => {
      const call = calls.get(directory)!;
      await answer(directory).then(call.resolve, call.reject);
    },
    fail: (directory: string) => {
      calls.get(directory)!.reject(Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }));
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

  it("does not cache a miss, so a tool installed later is found once the listing ages out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const tools = dir("tools");

    await expect(resolveWindowsExecutable("git", { PATH: tools })).resolves.toBeNull();
    const installed = touch(tools, "git.exe");
    // The directory's listing answers for a few seconds.
    vi.setSystemTime(Date.now() + 1_000);
    await expect(resolveWindowsExecutable("git", { PATH: tools })).resolves.toBeNull();
    vi.setSystemTime(Date.now() + 3_000);
    await expect(resolveWindowsExecutable("git", { PATH: tools })).resolves.toBe(installed);
  });

  it("drops every listing on a PATH re-read, so an install is found at once", async () => {
    const tools = dir("tools");

    await expect(resolveWindowsExecutable("git", { PATH: tools })).resolves.toBeNull();
    const installed = touch(tools, "git.exe");
    invalidateWindowsExecutableCache();
    await expect(resolveWindowsExecutable("git", { PATH: tools })).resolves.toBe(installed);
  });

  it("reads each directory once for a burst of lookups", async () => {
    setPlatform("win32");
    const disk = windowsDisk([
      "C:\\Windows\\System32\\where.exe",
      "C:\\tools\\git.exe",
      "C:\\npm\\claude.cmd",
    ]);
    const env = { PATH: "C:\\Windows\\System32;C:\\tools;C:\\npm" };

    await scanWindowsPath("claude", env, { fs: disk });
    await scanWindowsPath("codex", env, { fs: disk });
    await resolveWindowsExecutable("git", env, { fs: disk });
    await findWindowsCommand("gemini", env, { fs: disk });

    const reads = disk.readdir.mock.calls.map(([directory]) => directory);
    expect(reads.sort()).toEqual(["C:\\Windows\\System32", "C:\\npm", "C:\\tools"]);
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

describe("PATH-lookup slots", () => {
  const nas = (n: number) => `\\\\nas${n}\\x`;
  const tick = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    setPlatform("win32");
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("keeps two listings outstanding at a time and still reads every directory", async () => {
    const control = controlledDisk([
      "C:\\a\\x.exe",
      "C:\\b\\x.exe",
      "C:\\c\\x.exe",
      "C:\\d\\git.exe",
    ]);
    const found = resolveWindowsExecutable(
      "git",
      { PATH: "C:\\a;C:\\b;C:\\c;C:\\d" },
      { fs: control.disk }
    );
    await tick();
    expect(control.order).toEqual(["C:\\a", "C:\\b"]);
    for (const directory of ["C:\\a", "C:\\b", "C:\\c", "C:\\d"]) {
      await control.answer(directory);
      await tick();
    }

    await expect(found).resolves.toBe("C:\\d\\git.exe");
    expect(control.order).toEqual(["C:\\a", "C:\\b", "C:\\c", "C:\\d"]);
    expect(control.peak()).toBe(2);
  });

  it("holds a slot until its call returns, with one more lane while both slots are overdue", async () => {
    const control = controlledDisk(["C:\\tools\\git.exe", "C:\\tools\\gh.exe"]);
    const env = { PATH: `${nas(1)};${nas(2)};${nas(3)};C:\\tools` };

    const first = scanWindowsPath("git", env, { fs: control.disk });
    await tick();
    expect(control.order).toEqual([nas(1), nas(2)]);

    // Both overdue: one more lane opens, and the third dead share takes it.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(control.order).toEqual([nas(1), nas(2), nas(3)]);
    await vi.advanceTimersByTimeAsync(1_500);
    // Every lane is held by a call past its deadline, so nothing more is
    // read: the search gives up on the rest instead of queueing a fourth.
    await expect(first).resolves.toEqual({
      paths: [],
      skipped: [nas(1), nas(2), nas(3), "C:\\tools"],
    });
    expect(control.outstanding()).toBe(3);
    expect(control.order).not.toContain("C:\\tools");

    // A share's call returning gives its slot back, and the listing waiting
    // for one runs, filling the cache for the next search.
    control.fail(nas(1));
    await tick();
    expect(control.order).toContain("C:\\tools");
    await control.answer("C:\\tools");
    await tick();
    await expect(scanWindowsPath("gh", env, { fs: control.disk })).resolves.toEqual({
      paths: ["C:\\tools\\gh.exe"],
      skipped: [nas(1), nas(2), nas(3)],
    });
    expect(control.peak()).toBe(3);
  });

  it("finds a tool past two dead shares on the first search", async () => {
    const control = controlledDisk(["C:\\tools\\git.exe"]);
    const found = resolveWindowsExecutable(
      "git",
      { PATH: `${nas(1)};${nas(2)};C:\\tools` },
      { fs: control.disk }
    );
    await tick();
    expect(control.order).toEqual([nas(1), nas(2)]);

    await vi.advanceTimersByTimeAsync(1_500);
    await control.answer("C:\\tools");
    await tick();
    await expect(found).resolves.toBe("C:\\tools\\git.exe");
  });

  it("reads a directory that stalled before after every other", async () => {
    const control = controlledDisk(["C:\\a\\x.exe", "C:\\b\\x.exe", "C:\\c\\git.exe"]);
    const env = { PATH: `${nas(1)};C:\\a;C:\\b;C:\\c` };

    const first = resolveWindowsExecutable("git", env, { fs: control.disk });
    await tick();
    for (const directory of ["C:\\a", "C:\\b", "C:\\c"]) {
      await control.answer(directory);
      await tick();
    }
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(first).resolves.toBe("C:\\c\\git.exe");
    // The share fails at last; after the retry window it is asked again.
    control.fail(nas(1));
    await vi.advanceTimersByTimeAsync(30_000);

    control.order.length = 0;
    void resolveWindowsExecutable("gh", env, { fs: control.disk });
    await tick();
    expect(control.order).toEqual(["C:\\a", "C:\\b"]);
    await control.answer("C:\\a");
    await tick();
    expect(control.order).toEqual(["C:\\a", "C:\\b", "C:\\c"]);
    await control.answer("C:\\b");
    await tick();
    expect(control.order).toEqual(["C:\\a", "C:\\b", "C:\\c", nas(1)]);
  });

  it("reports a hit found past a silent entry as provisional, and looks again once it answers", async () => {
    const control = controlledDisk(["\\\\nas\\tools\\pwsh.exe", "C:\\tools\\pwsh.exe"]);
    const env = { PATH: "\\\\nas\\tools;C:\\tools" };

    const first = lookupWindowsExecutable("pwsh.exe", env, { fs: control.disk });
    await tick();
    await control.answer("C:\\tools");
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(first).resolves.toEqual({
      file: "C:\\tools\\pwsh.exe",
      skipped: ["\\\\nas\\tools"],
    });

    let readable = false;
    void windowsPathEntriesReadable(["\\\\nas\\tools"], { fs: control.disk }).then(() => {
      readable = true;
    });
    // Cached meanwhile, and still provisional.
    await expect(lookupWindowsExecutable("pwsh.exe", env, { fs: control.disk })).resolves.toEqual({
      file: "C:\\tools\\pwsh.exe",
      skipped: ["\\\\nas\\tools"],
    });
    expect(readable).toBe(false);

    // The share answers, late but whole: the earlier copy wins from now on.
    await control.answer("\\\\nas\\tools");
    await tick();
    expect(readable).toBe(true);
    await expect(lookupWindowsExecutable("pwsh.exe", env, { fs: control.disk })).resolves.toEqual({
      file: "\\\\nas\\tools\\pwsh.exe",
      skipped: [],
    });
  });
});

describe("a PATH directory that can be entered but not listed", () => {
  beforeEach(() => setPlatform("win32"));

  it("is asked for each candidate by name instead", async () => {
    const disk = windowsDisk(
      ["C:\\locked\\tool.exe", "C:\\locked\\tool.cmd", "C:\\open\\tool.exe"],
      { denyListing: ["C:\\locked"] }
    );
    const env = { PATH: "C:\\locked;C:\\open", PATHEXT: ".EXE;.CMD" };

    await expect(resolveWindowsExecutable("tool", env, { fs: disk })).resolves.toBe(
      "C:\\locked\\tool.exe"
    );
    await expect(scanWindowsPath("tool", env, { fs: disk })).resolves.toEqual({
      paths: ["C:\\locked\\tool.exe", "C:\\locked\\tool.cmd", "C:\\open\\tool.exe"],
      skipped: [],
    });
    await expect(findWindowsCommand("missing", env, { fs: disk })).resolves.toBeNull();
    // The refusal is kept with the listings; only the names are asked for again.
    expect(
      disk.readdir.mock.calls.filter(([directory]) => directory === "C:\\locked")
    ).toHaveLength(1);
    expect(disk.stat.mock.calls.map(([file]) => file)).toContain("C:\\locked\\missing.exe");
  });

  it("is written off like any other when a by-name check does not answer", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const disk = windowsDisk(["C:\\open\\tool.exe"], { denyListing: ["C:\\locked"] });
    disk.stat.mockImplementation(() => new Promise(() => {}));
    const env = { PATH: "C:\\locked;C:\\open", PATHEXT: ".EXE" };

    const scan = scanWindowsPath("tool", env, { fs: disk });
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(scan).resolves.toEqual({ paths: ["C:\\open\\tool.exe"], skipped: ["C:\\locked"] });
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
