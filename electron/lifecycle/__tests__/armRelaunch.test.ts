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

import { armRelaunch, WAIT_THEN_RUN_IMAGE } from "../armRelaunch.js";

const originalPlatform = process.platform;
const savedEnvNames = ["APPIMAGE", "APPDIR", "PATH", "LD_LIBRARY_PATH", "APPIMAGE_EXTRACT_AND_RUN"];
const originalEnv = Object.fromEntries(savedEnvNames.map((name) => [name, process.env[name]]));
const originalArgv = process.argv;
const image = "/home/u/Applications/Daintree.AppImage";

type SpawnCall = [string, string[], { detached: boolean; stdio: string; env: NodeJS.ProcessEnv }];
const spawnCall = (i = 0) => mocks.spawn.mock.calls[i] as unknown as SpawnCall;

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

// runningAppImage() requires this binary to sit inside APPDIR, as it does in a mount.
function runFromImage(appDir = path.dirname(process.execPath)) {
  process.env.APPIMAGE = image;
  process.env.APPDIR = appDir;
}

beforeEach(() => {
  vi.clearAllMocks();
  setPlatform("linux");
  process.argv = ["/tmp/.mount_x/daintree", "--no-sandbox", "--host-mode"];
});

afterEach(() => {
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
    expect(argv.slice(2)).toEqual([
      "daintree-relaunch",
      image,
      String(process.pid),
      "--",
      "--reset-data",
    ]);
    expect(options).toMatchObject({ detached: true, stdio: "ignore" });
    expect(mocks.waiter.unref).toHaveBeenCalled();
  });

  it("keeps the current args when the caller passes none", () => {
    runFromImage();
    armRelaunch();
    expect(spawnCall()[1].slice(-3)).toEqual(["--", "--no-sandbox", "--host-mode"]);
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

  it("keeps extract-and-run mode and waits for the runtime that deletes the extraction", () => {
    const appDir = path.join(os.tmpdir(), "appimage_extracted_0123abcd");
    process.env.APPIMAGE = image;
    process.env.APPDIR = appDir;
    vi.spyOn(process, "execPath", "get").mockReturnValue(path.join(appDir, "daintree"));
    vi.spyOn(fs, "realpathSync").mockImplementation(((p: fs.PathLike) =>
      p === `/proc/${process.ppid}/exe` ? image : String(p)) as typeof fs.realpathSync);
    armRelaunch({ args: ["x"] });

    const [, argv, { env }] = spawnCall();
    expect(argv.slice(3)).toEqual([image, String(process.pid), String(process.ppid), "--", "x"]);
    expect(env.APPIMAGE_EXTRACT_AND_RUN).toBe("1");
  });

  it("falls back to Electron's relaunch when the waiter can't start", () => {
    runFromImage();
    armRelaunch({ args: ["x"] });
    const onError = mocks.waiter.on.mock.calls.find(([event]) => event === "error")?.[1] as (
      error: Error
    ) => void;
    vi.spyOn(console, "error").mockImplementation(() => {});
    onError(new Error("ENOENT"));
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

  it("closes inherited descriptors, waits for every pid, then runs the image with the args intact", async () => {
    const out = path.join(dir, "out");
    const fakeImage = path.join(dir, "Fake.AppImage");
    fs.writeFileSync(
      fakeImage,
      [
        "#!/bin/bash",
        `ls /proc/$$/fd > "${out}.fds"`,
        `if kill -0 "$WAITED_A" 2>/dev/null || kill -0 "$WAITED_B" 2>/dev/null; then echo alive > "${out}.waited"; else echo gone > "${out}.waited"; fi`,
        `printf '%s\\n' "$@" > "${out}.tmp" && mv "${out}.tmp" "${out}"`,
      ].join("\n"),
      { mode: 0o755 }
    );
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
      [
        "-c",
        WAIT_THEN_RUN_IMAGE,
        "daintree-relaunch",
        fakeImage,
        a,
        b,
        "--",
        "a b",
        "",
        "$(touch pwned)",
      ],
      {
        cwd: dir,
        env: { ...process.env, WAITED_A: a, WAITED_B: b },
        stdio: ["ignore", "ignore", "ignore", held, ...Array(8).fill("ignore"), held],
      }
    );
    children.push(waiter);
    fs.closeSync(held);

    expect(await waitForFile(out)).toBe("a b\n\n$(touch pwned)\n");
    expect(fs.readFileSync(`${out}.waited`, "utf8").trim()).toBe("gone");
    // bash keeps the script it runs open on 255; nothing of Daintree's survives.
    const fds = fs.readFileSync(`${out}.fds`, "utf8").split("\n").filter(Boolean);
    expect(fds.filter((fd) => !["0", "1", "2", "255"].includes(fd))).toEqual([]);
    expect(fs.existsSync(path.join(dir, "pwned"))).toBe(false);
  });
});
