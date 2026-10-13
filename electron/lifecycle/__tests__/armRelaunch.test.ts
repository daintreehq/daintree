import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const waiter = { on: vi.fn(), unref: vi.fn() };
  return { waiter, spawn: vi.fn(() => waiter), relaunch: vi.fn() };
});
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("electron", () => ({ app: { relaunch: mocks.relaunch } }));

import {
  armAppImageRelaunch,
  armRelaunch,
  resetArmedRelaunchForTests,
  retargetRelaunch,
  WAIT_THEN_RUN_IMAGE,
} from "../armRelaunch.js";

const originalPlatform = process.platform;
const savedEnvNames = ["APPIMAGE", "APPDIR", "PATH", "LD_LIBRARY_PATH", "APPIMAGE_EXTRACT_AND_RUN"];
const originalEnv = Object.fromEntries(savedEnvNames.map((name) => [name, process.env[name]]));
const originalArgv = process.argv;
const image = "/home/u/Applications/Daintree-1.2.0.AppImage";
const updated = "/home/u/Applications/Daintree-1.3.0.AppImage";

type SpawnCall = [string, string[], { detached: boolean; stdio: string; env: NodeJS.ProcessEnv }];
const spawnCall = (i = 0) => mocks.spawn.mock.calls[i] as unknown as SpawnCall;
const commandFile = (i = 0) => spawnCall(i)[1][3]!;
const waitedPids = (i = 0) => spawnCall(i)[1].slice(4);

/** What the waiter will run, read the way it reads it: NUL-terminated parts. */
function armedCommand(i = 0): string[] {
  return fs.readFileSync(commandFile(i), "utf8").split("\0").slice(0, -1);
}

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

// runningAppImage() requires this binary to sit inside APPDIR, as it does in a mount.
function runFromImage(appDir = path.dirname(process.execPath)) {
  process.env.APPIMAGE = image;
  process.env.APPDIR = appDir;
}

function waiterError(): (error: Error) => void {
  vi.spyOn(console, "error").mockImplementation(() => {});
  return mocks.waiter.on.mock.calls.find(([event]) => event === "error")?.[1] as (
    error: Error
  ) => void;
}

beforeEach(() => {
  vi.clearAllMocks();
  setPlatform("linux");
  process.argv = ["/tmp/.mount_x/daintree", "--no-sandbox", "--host-mode"];
});

afterEach(() => {
  for (const [, argv] of mocks.spawn.mock.calls as unknown as SpawnCall[]) {
    fs.rmSync(path.dirname(argv[3]!), { recursive: true, force: true });
  }
  resetArmedRelaunchForTests();
  vi.restoreAllMocks();
  setPlatform(originalPlatform);
  for (const name of savedEnvNames) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
  process.argv = originalArgv;
});

describe("armRelaunch", () => {
  // Electron's relauncher runs from the image's mount and dies with it, so a
  // restart from the AppImage never came back.
  it("hands an AppImage restart to a detached shell that runs the image once this process exits", () => {
    runFromImage();
    armRelaunch({ args: ["--reset-data"] });

    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const [command, argv, options] = spawnCall();
    expect(command).toBe("/bin/bash");
    expect(argv.slice(0, 3)).toEqual(["-c", WAIT_THEN_RUN_IMAGE, "daintree-relaunch"]);
    expect(waitedPids()).toEqual([String(process.pid)]);
    expect(armedCommand()).toEqual([image, "--reset-data"]);
    expect(options).toMatchObject({ detached: true, stdio: "ignore" });
    expect(mocks.waiter.unref).toHaveBeenCalled();
  });

  it("keeps the command where only this user can read or replace it", () => {
    runFromImage();
    armRelaunch();

    expect(fs.statSync(commandFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(commandFile())).mode & 0o777).toBe(0o700);
  });

  it("keeps the current args when the caller passes none", () => {
    runFromImage();
    armRelaunch();
    expect(armedCommand()).toEqual([image, "--no-sandbox", "--host-mode"]);
  });

  it("drops the old mount's entries from the path lists AppRun will prefix again", () => {
    const appDir = path.dirname(process.execPath);
    runFromImage(appDir);
    process.env.PATH = `${appDir}:${appDir}/usr/sbin:/usr/local/bin:/usr/bin`;
    process.env.LD_LIBRARY_PATH = `${appDir}/usr/lib`;
    armRelaunch();

    const { env } = spawnCall()[2];
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin");
    expect(env).not.toHaveProperty("LD_LIBRARY_PATH");
    expect(env.APPIMAGE_EXTRACT_AND_RUN).toBeUndefined();
    // The running process keeps its own environment.
    expect(process.env.LD_LIBRARY_PATH).toBe(`${appDir}/usr/lib`);
  });

  function runExtracted(parentExe: string) {
    const appDir = path.join(os.tmpdir(), "appimage_extracted_0123abcd");
    process.env.APPIMAGE = image;
    process.env.APPDIR = appDir;
    vi.spyOn(process, "execPath", "get").mockReturnValue(path.join(appDir, "daintree"));
    vi.spyOn(fs, "readlinkSync").mockImplementation(((p: fs.PathLike) => {
      if (p === `/proc/${process.ppid}/exe`) return parentExe;
      throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
    }) as typeof fs.readlinkSync);
  }

  it("keeps extract-and-run mode and waits for the runtime that deletes the extraction", () => {
    runExtracted(image);
    armRelaunch({ args: ["x"] });

    expect(waitedPids()).toEqual([String(process.pid), String(process.ppid)]);
    expect(armedCommand()).toEqual([image, "x"]);
    expect(spawnCall()[2].env.APPIMAGE_EXTRACT_AND_RUN).toBe("1");
  });

  // An update deletes or replaces the image before it relaunches.
  it("still recognises the runtime once its image is gone", () => {
    runExtracted(`${image} (deleted)`);
    armRelaunch({ args: [] });

    expect(waitedPids()).toEqual([String(process.pid), String(process.ppid)]);
  });

  it("doesn't wait for a parent that isn't the image's runtime", () => {
    runExtracted("/usr/bin/bash");
    armRelaunch({ args: [] });

    expect(waitedPids()).toEqual([String(process.pid)]);
  });

  it("falls back to Electron's relaunch when the waiter can't start", () => {
    runFromImage();
    armRelaunch({ args: ["x"] });
    waiterError()(new Error("ENOENT"));
    expect(mocks.relaunch).toHaveBeenCalledWith({ args: ["x"] });
  });

  it("uses Electron's relaunch outside an AppImage, and for one only inherited", () => {
    delete process.env.APPIMAGE;
    armRelaunch({ args: ["a"] });
    process.env.APPIMAGE = "/home/u/Other.AppImage";
    process.env.APPDIR = "/tmp/.mount_other";
    armRelaunch();
    setPlatform("darwin");
    runFromImage();
    armRelaunch({ args: ["b"] });

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.relaunch.mock.calls).toEqual([[{ args: ["a"] }], [{}], [{ args: ["b"] }]]);
  });
});

describe("armAppImageRelaunch", () => {
  it("runs the image an update put in place through the same waiter", () => {
    const appDir = path.dirname(process.execPath);
    runFromImage(appDir);
    process.env.LD_LIBRARY_PATH = `${appDir}/usr/lib`;
    const fallback = vi.fn();

    expect(armAppImageRelaunch(updated, [], fallback)).toBe(true);

    const [command, , options] = spawnCall();
    expect(command).toBe("/bin/bash");
    expect(armedCommand()).toEqual([updated]);
    expect(waitedPids()).toEqual([String(process.pid)]);
    expect(options).toMatchObject({ detached: true, stdio: "ignore" });
    expect(options.env).not.toHaveProperty("LD_LIBRARY_PATH");
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("runs the caller's fallback, not Electron's relaunch, when the waiter can't start", () => {
    runFromImage();
    const fallback = vi.fn();
    armAppImageRelaunch(updated, [], fallback);
    waiterError()(new Error("ENOENT"));

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it("arms nothing outside an AppImage", () => {
    delete process.env.APPIMAGE;
    expect(armAppImageRelaunch(updated, [], vi.fn())).toBe(false);
    runFromImage();
    setPlatform("darwin");
    expect(armAppImageRelaunch(updated, [], vi.fn())).toBe(false);

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });
});

// One waiter per process, so one new instance, whatever asks for it.
describe("a relaunch already armed", () => {
  it("is replaced by a later request rather than joined by a second waiter", () => {
    runFromImage();
    armRelaunch({ args: ["--reset-data"] });
    const fallback = vi.fn();
    armAppImageRelaunch(updated, [], fallback);

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(armedCommand()).toEqual([updated]);
    // The latest request's fallback is the one that runs.
    waiterError()(new Error("ENOENT"));
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it("starts afresh once the waiter it had couldn't start", () => {
    runFromImage();
    armRelaunch({ args: ["a"] });
    waiterError()(new Error("ENOENT"));
    armRelaunch({ args: ["b"] });

    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(armedCommand(1)).toEqual([image, "b"]);
  });

  // A restart with an update staged: Electron's `quit` (which app.exit() emits
  // too) runs electron-updater's install-on-quit after the restart was armed,
  // and that deletes the image the restart was going to run.
  it("follows the image to the name an update installed it under, keeping its args", () => {
    runFromImage();
    armRelaunch({ args: ["--disable-gpu"] });

    retargetRelaunch(image, updated);

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(armedCommand()).toEqual([updated, "--disable-gpu"]);
  });

  it("ignores a move of some other image, or with nothing armed", () => {
    retargetRelaunch(image, updated);
    expect(mocks.spawn).not.toHaveBeenCalled();

    runFromImage();
    armAppImageRelaunch(updated, [], vi.fn());
    retargetRelaunch(image, "/home/u/Applications/Daintree-9.9.9.AppImage");
    expect(armedCommand()).toEqual([updated]);
  });
});

// The command can hold the user's args; a relaunch that never happens must not
// leave it in the temp dir.
describe("a relaunch that can't be armed", () => {
  function createdDirs(spy: { mock: { results: Array<{ type: string; value: unknown }> } }) {
    return spy.mock.results.filter((r) => r.type === "return").map((r) => r.value as string);
  }

  function failOnce(method: "writeFileSync" | "renameSync") {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(fs, method).mockImplementationOnce(() => {
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    });
  }

  it.each(["writeFileSync", "renameSync"] as const)(
    "removes its private dir when %s fails, and falls back",
    (method) => {
      runFromImage();
      const mkdtemp = vi.spyOn(fs, "mkdtempSync");
      failOnce(method);
      armRelaunch({ args: ["x"] });

      const [dir] = createdDirs(mkdtemp);
      expect(dir).toBeDefined();
      expect(fs.existsSync(dir!)).toBe(false);
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(mocks.relaunch).toHaveBeenCalledWith({ args: ["x"] });
    }
  );

  it("removes the command when the waiter can't start", () => {
    runFromImage();
    armRelaunch();
    const dir = path.dirname(commandFile());
    waiterError()(new Error("ENOENT"));

    expect(fs.existsSync(dir)).toBe(false);
  });

  it("removes the command when spawn throws, then arms afresh", () => {
    runFromImage();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.spawn.mockImplementationOnce(() => {
      throw new Error("EAGAIN");
    });
    armRelaunch({ args: ["x"] });

    expect(fs.existsSync(path.dirname(commandFile()))).toBe(false);
    expect(mocks.relaunch).toHaveBeenCalledWith({ args: ["x"] });
    armRelaunch({ args: ["y"] });
    expect(armedCommand(1)).toEqual([image, "y"]);
  });

  it("keeps the armed command, and no partial one, when a change can't be written", () => {
    runFromImage();
    armRelaunch({ args: ["a"] });
    failOnce("renameSync");
    armAppImageRelaunch(updated, [], vi.fn());

    expect(armedCommand()).toEqual([image, "a"]);
    expect(fs.readdirSync(path.dirname(commandFile()))).toEqual(["command"]);
  });
});

// The command file is NUL-separated: a NUL inside a part would split it in two.
describe("a NUL byte", () => {
  it("is refused before anything is armed", () => {
    runFromImage();

    expect(() => armRelaunch({ args: ["--a\0--b"] })).toThrow(TypeError);
    expect(() => armAppImageRelaunch(`${updated}\0x`, [], vi.fn())).toThrow(TypeError);
    expect(() => armAppImageRelaunch(updated, ["\0"], vi.fn())).toThrow(TypeError);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it("can't be moved into an armed command", () => {
    runFromImage();
    armRelaunch({ args: ["a"] });

    expect(() => retargetRelaunch(image, `${updated}\0--evil`)).toThrow(TypeError);
    expect(armedCommand()).toEqual([image, "a"]);
  });
});

// The script itself, under real bash and /proc.
describe.runIf(originalPlatform === "linux")("WAIT_THEN_RUN_IMAGE", () => {
  let dir: string;
  let children: ChildProcess[] = [];
  let realSpawn: typeof import("node:child_process").spawn;

  beforeAll(async () => {
    ({ spawn: realSpawn } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process"));
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "arm-relaunch-"));
  });

  afterEach(() => {
    for (const child of children) child.kill("SIGKILL");
    children = [];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function waitForFile(file: string): Promise<string> {
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`${file} never appeared`);
  }

  function fakeImage(name: string, out: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(
      file,
      [
        "#!/bin/bash",
        `ls /proc/$$/fd > "${out}.fds"`,
        `if kill -0 "$WAITED_A" 2>/dev/null || kill -0 "$WAITED_B" 2>/dev/null; then echo alive > "${out}.waited"; else echo gone > "${out}.waited"; fi`,
        `printf '%s\\n' "$0" "$@" > "${out}.tmp" && mv "${out}.tmp" "${out}"`,
      ].join("\n"),
      { mode: 0o755 }
    );
    return file;
  }

  function writeCommand(file: string, parts: string[]) {
    fs.writeFileSync(file, parts.map((part) => `${part}\0`).join(""));
  }

  it("closes inherited descriptors, waits for every pid, then runs the command it reads last", async () => {
    const out = path.join(dir, "out");
    const before = fakeImage("Daintree-1.2.0.AppImage", out);
    const after = fakeImage("Daintree-1.3.0.AppImage", out);
    const target = path.join(dir, "relaunch", "command");
    fs.mkdirSync(path.dirname(target));
    writeCommand(target, [before, "a b", "", "$(touch pwned)"]);
    const sleeper = (seconds: string) => {
      const child = realSpawn("sleep", [seconds], { stdio: "ignore" });
      children.push(child);
      return String(child.pid);
    };
    const a = sleeper("0.3");
    const b = sleeper("0.6");
    const held = fs.openSync(path.join(dir, "held"), "w");
    const waiter = realSpawn(
      "/bin/bash",
      ["-c", WAIT_THEN_RUN_IMAGE, "daintree-relaunch", target, a, b],
      {
        cwd: dir,
        env: { ...process.env, WAITED_A: a, WAITED_B: b },
        stdio: ["ignore", "ignore", "ignore", held, ...Array(8).fill("ignore"), held],
      }
    );
    children.push(waiter);
    fs.closeSync(held);
    // The update moves the image while the waiter is waiting.
    writeCommand(target, [after, "a b", "", "$(touch pwned)"]);

    expect(await waitForFile(out)).toBe(`${after}\na b\n\n$(touch pwned)\n`);
    expect(fs.readFileSync(`${out}.waited`, "utf8").trim()).toBe("gone");
    // bash keeps the script it runs open on 255; nothing of Daintree's survives.
    const fds = fs.readFileSync(`${out}.fds`, "utf8").split("\n").filter(Boolean);
    expect(fds.filter((fd) => !["0", "1", "2", "255"].includes(fd))).toEqual([]);
    expect(fs.existsSync(path.join(dir, "pwned"))).toBe(false);
    expect(fs.existsSync(path.dirname(target))).toBe(false);
  });

  function exitOf(child: ChildProcess): Promise<number | null> {
    return new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  }

  it("runs nothing and leaves nothing behind when the command can't be read", async () => {
    const target = path.join(dir, "relaunch", "command");
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(`${target}.tmp`, "partial");
    const waiter = realSpawn(
      "/bin/bash",
      ["-c", WAIT_THEN_RUN_IMAGE, "daintree-relaunch", target],
      {
        stdio: "ignore",
      }
    );
    children.push(waiter);

    expect(await exitOf(waiter)).not.toBe(0);
    expect(fs.existsSync(path.dirname(target))).toBe(false);
  });

  it("runs nothing and leaves nothing behind when it's stopped while waiting", async () => {
    const out = path.join(dir, "out");
    const target = path.join(dir, "relaunch", "command");
    fs.mkdirSync(path.dirname(target));
    writeCommand(target, [fakeImage("Daintree.AppImage", out), "--secret-arg"]);
    const sleeper = realSpawn("sleep", ["30"], { stdio: "ignore" });
    children.push(sleeper);
    const waiter = realSpawn(
      "/bin/bash",
      ["-c", WAIT_THEN_RUN_IMAGE, "daintree-relaunch", target, String(sleeper.pid)],
      { stdio: "ignore" }
    );
    children.push(waiter);
    await new Promise((resolve) => setTimeout(resolve, 300));
    waiter.kill("SIGTERM");

    expect(await exitOf(waiter)).not.toBe(0);
    expect(fs.existsSync(path.dirname(target))).toBe(false);
    expect(fs.existsSync(out)).toBe(false);
  });
});
