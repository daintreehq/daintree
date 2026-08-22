import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  buildTakeArgs,
  startTake,
  isAlive,
  stopTake,
  teardownDemo,
  type TakeHandle,
} from "../demoTake";
import { snapshotProfile } from "../demoProfile";

let scratch: string;
let projectPath: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "demo-take-"));
  projectPath = path.join(scratch, "project");
  mkdirSync(projectPath, { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * A stand-in for the Electron binary that stays up and ignores the argv the
 * take runner appends. Using a script rather than `sh -c "..."` keeps the
 * arguments switch-only, which is what buildTakeArgs requires.
 */
function makeLongLivedBinary(): string {
  const file = path.join(scratch, "fake-app.sh");
  writeFileSync(file, "#!/bin/sh\nexec sleep 30\n");
  chmodSync(file, 0o755);
  return file;
}

function makeSnapshot(name = "snap"): string {
  const live = path.join(scratch, `${name}-live`);
  mkdirSync(live, { recursive: true });
  writeFileSync(path.join(live, "daintree.db"), "sqlite-main");
  writeFileSync(path.join(live, "config.json"), "{}");
  const snapshot = path.join(scratch, name);
  snapshotProfile(live, snapshot, { slug: "scene", projectPath, worktreePaths: [] });
  return snapshot;
}

describe("buildTakeArgs", () => {
  it("puts the app root last and the profile flag before it", () => {
    // Electron treats the first non-switch argument as the app path, so the
    // ordering here is load-bearing rather than cosmetic.
    const args = buildTakeArgs({ appRoot: "/app", workDir: "/tmp/take" });

    expect(args[args.length - 1]).toBe("/app");
    expect(args).toContain("--user-data-dir=/tmp/take");
    expect(args.indexOf("--user-data-dir=/tmp/take")).toBeLessThan(args.indexOf("/app"));
  });

  it("carries no e2e flags, so a take behaves like a shipped build", () => {
    const args = buildTakeArgs({ appRoot: "/app", workDir: "/tmp/take" });
    expect(args.filter((arg) => arg.includes("daintree-e2e"))).toEqual([]);
    expect(args).not.toContain("--demo-mode");
  });

  it("keeps caller-supplied switches ahead of the app root", () => {
    const args = buildTakeArgs({
      appRoot: "/app",
      workDir: "/tmp/take",
      extraArgs: ["--force-device-scale-factor=2"],
    });

    expect(args.indexOf("--force-device-scale-factor=2")).toBeLessThan(args.indexOf("/app"));
  });

  it("rejects a relative work directory", () => {
    // Electron resolves --user-data-dir against its own cwd, not the harness's,
    // so a relative path silently lands somewhere unintended.
    expect(() => buildTakeArgs({ appRoot: "/app", workDir: "relative/take" })).toThrow(
      /must be absolute/
    );
  });
});

describe("startTake", () => {
  it("refuses to start without a completed snapshot", () => {
    const notASnapshot = path.join(scratch, "empty");
    mkdirSync(notASnapshot, { recursive: true });

    expect(() =>
      startTake({ snapshotDir: notASnapshot, workDir: path.join(scratch, "take") })
    ).toThrow(/no complete snapshot/);
  });

  it("resets the work directory from the snapshot before launching", async () => {
    const snapshot = makeSnapshot();
    const workDir = path.join(scratch, "take");
    let handle: TakeHandle | null = null;
    try {
      // `true` exits immediately; this test is about the reset, not the app.
      handle = startTake({ snapshotDir: snapshot, workDir, electronPath: "/usr/bin/true" });
      expect(readFileSync(path.join(workDir, "daintree.db"), "utf8")).toBe("sqlite-main");
    } finally {
      await handle?.stop();
    }
  });

  it("discards state left by the previous take", async () => {
    const snapshot = makeSnapshot();
    const workDir = path.join(scratch, "take");

    const first = startTake({ snapshotDir: snapshot, workDir, electronPath: "/usr/bin/true" });
    await first.stop();
    writeFileSync(path.join(workDir, "daintree.db"), "mutated by take 1");
    writeFileSync(path.join(workDir, "leftover.json"), "junk");

    const second = startTake({ snapshotDir: snapshot, workDir, electronPath: "/usr/bin/true" });
    await second.stop();

    expect(readFileSync(path.join(workDir, "daintree.db"), "utf8")).toBe("sqlite-main");
    expect(existsSync(path.join(workDir, "leftover.json"))).toBe(false);
  });

  it("outlives the process that started it", async () => {
    // The property the whole take design rests on. Proving it needs a real
    // parent that exits: a take still running while its starter is alive shows
    // nothing, since an attached child would look identical. So start the take
    // from a throwaway Node process, wait for that process to die, and only
    // then check the take is still up.
    const snapshot = makeSnapshot();
    const workDir = path.join(scratch, "take");
    const starter = path.join(scratch, "starter.mts");
    writeFileSync(
      starter,
      `import { startTake } from ${JSON.stringify(path.resolve("e2e/helpers/demoTake.ts"))};
const handle = startTake({
  snapshotDir: ${JSON.stringify(snapshot)},
  workDir: ${JSON.stringify(workDir)},
  electronPath: ${JSON.stringify(makeLongLivedBinary())},
});
process.stdout.write(String(handle.pid));
process.exit(0);
`
    );

    const pid = Number(
      execFileSync(path.resolve("node_modules/.bin/tsx"), [starter], { encoding: "utf8" }).trim()
    );
    expect(Number.isInteger(pid)).toBe(true);

    try {
      // execFileSync returned, so the starter process is gone. Signal 0 probes
      // liveness without touching the process.
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      await stopTake(pid, { graceMs: 2_000 });
    }
  }, 30_000);

  it("stops the take it started", async () => {
    const snapshot = makeSnapshot();
    const handle = startTake({
      snapshotDir: snapshot,
      workDir: path.join(scratch, "take"),
      electronPath: makeLongLivedBinary(),
    });

    await handle.stop({ graceMs: 3_000 });

    // stop() resolves only once the process is actually gone, so no sleep.
    expect(isAlive(handle.pid)).toBe(false);
  });

  it("tolerates being stopped twice and reuses the same stop", async () => {
    const snapshot = makeSnapshot();
    const handle = startTake({
      snapshotDir: snapshot,
      workDir: path.join(scratch, "take"),
      electronPath: "/usr/bin/true",
    });

    const first = handle.stop();
    const second = handle.stop();
    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toBeDefined();
  });
});

describe("stopTake", () => {
  it.each([0, 1, -5, 1.5])("refuses pid %s", async (pid) => {
    // pid 0 signals the caller's own process group; pid 1 becomes kill(-1),
    // which on POSIX reaches every process the user is allowed to signal.
    await expect(stopTake(pid)).rejects.toThrow(/not a take process id/);
  });
});

describe("teardownDemo", () => {
  it("refuses to delete a directory that is not one of its profiles", async () => {
    // Teardown takes paths from a CLI and a scene file, so it must not double
    // as a general recursive-delete primitive.
    const victim = path.join(scratch, "not-a-profile");
    mkdirSync(victim, { recursive: true });
    writeFileSync(path.join(victim, "thesis.txt"), "years of work");

    const result = await teardownDemo({ workDirs: [victim] });

    expect(existsSync(path.join(victim, "thesis.txt"))).toBe(true);
    expect(result.failed).toContain(victim);
    expect(result.removed).toEqual([]);
  });

  it("removes the snapshot, the work profiles and the scene", async () => {
    const snapshot = makeSnapshot();
    const workDir = path.join(scratch, "take");
    await startTake({ snapshotDir: snapshot, workDir, electronPath: "/usr/bin/true" }).stop();
    let sceneRemoved = false;

    const result = await teardownDemo({
      snapshotDir: snapshot,
      workDirs: [workDir],
      sceneCleanup: () => {
        sceneRemoved = true;
      },
    });

    expect(existsSync(snapshot)).toBe(false);
    expect(existsSync(workDir)).toBe(false);
    expect(sceneRemoved).toBe(true);
    expect(result.failed).toEqual([]);
    expect(result.removed).toContain(workDir);
  });

  it("stops running takes before deleting the profile underneath them", async () => {
    const snapshot = makeSnapshot();
    const workDir = path.join(scratch, "take");
    const handle = startTake({
      snapshotDir: snapshot,
      workDir,
      electronPath: makeLongLivedBinary(),
    });

    await teardownDemo({
      takes: [handle],
      snapshotDir: snapshot,
      workDirs: [workDir],
      stop: { graceMs: 3_000 },
    });

    // The wait is the point: deleting the profile while the app is still
    // shutting down leaves it writing into a directory that is gone.
    expect(isAlive(handle.pid)).toBe(false);
    expect(existsSync(workDir)).toBe(false);
  });

  it("skips paths that are already gone instead of failing", async () => {
    const result = await teardownDemo({ workDirs: [path.join(scratch, "never-existed")] });

    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("keeps going when one target cannot be removed", async () => {
    // A teardown that aborts halfway leaves more mess than one that carries on.
    const snapshot = makeSnapshot();
    let sceneRemoved = false;

    const result = await teardownDemo({
      snapshotDir: snapshot,
      sceneCleanup: () => {
        sceneRemoved = true;
        throw new Error("scene already gone");
      },
    });

    expect(existsSync(snapshot)).toBe(false);
    expect(sceneRemoved).toBe(true);
    expect(result.failed).toContain("scene");
  });
});
