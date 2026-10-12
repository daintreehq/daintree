import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppImageUpdater, BaseUpdater } from "electron-updater";

const armAppImageRelaunch = vi.hoisted(() =>
  vi.fn<(image: string, args: readonly string[], fallback: () => void) => boolean>(() => true)
);
vi.mock("../../lifecycle/armRelaunch.js", () => ({ armAppImageRelaunch }));

import { routeAppImageRelaunchThroughWaiter } from "../appImageUpdateRelaunch.js";

const originalPlatform = process.platform;
const savedEnvNames = ["APPIMAGE", "APPDIR"];
const originalEnv = Object.fromEntries(savedEnvNames.map((name) => [name, process.env[name]]));

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

// runningAppImage() requires this binary to sit inside APPDIR, as it does in a mount.
function runFromImage(image: string) {
  process.env.APPIMAGE = image;
  process.env.APPDIR = path.dirname(process.execPath);
}

beforeEach(() => {
  vi.clearAllMocks();
  armAppImageRelaunch.mockImplementation(() => true);
  setPlatform("linux");
});

afterEach(() => {
  vi.restoreAllMocks();
  setPlatform(originalPlatform);
  for (const name of savedEnvNames) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
});

// electron-updater's own AppImage install, on files in a temp dir: what it
// does before the relaunch, and that the relaunch is the spawn we take over.
describe("AppImageUpdater install", () => {
  let dir: string;
  let installDir: string;
  let cacheDir: string;
  let updater: AppImageUpdater;
  let spawnLog: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "appimage-update-"));
    installDir = path.join(dir, "Applications");
    cacheDir = path.join(dir, "pending");
    fs.mkdirSync(installDir);
    fs.mkdirSync(cacheDir);
    updater = new AppImageUpdater(null, { version: "1.0.0" } as never);
    updater.logger = null;
    spawnLog = vi
      .spyOn(BaseUpdater.prototype as unknown as { spawnLog: () => Promise<boolean> }, "spawnLog")
      .mockResolvedValue(true);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function stage(download: string, installed: string, { downloaded = true } = {}) {
    const installer = path.join(cacheDir, download);
    if (downloaded) fs.writeFileSync(installer, "new image", { mode: 0o755 });
    fs.writeFileSync(path.join(installDir, installed), "old image", { mode: 0o755 });
    runFromImage(path.join(installDir, installed));
    (updater as unknown as { downloadedUpdateHelper: unknown }).downloadedUpdateHelper = {
      file: installer,
      downloadedFileInfo: { isAdminRightsRequired: false },
    };
  }

  // quitAndInstall() is install(false, autoRunAppAfterInstall), and that defaults to true.
  const install = () =>
    routeAppImageRelaunchThroughWaiter(updater, () => updater.install(false, true));

  it("hands the waiter the renamed image, complete and in place, instead of spawning it", () => {
    stage("Daintree-2.0.0.AppImage", "Daintree-1.0.0.AppImage");
    const renamed = vi.fn();
    updater.on("appimage-filename-updated", renamed);
    const seen: Array<{ content: string; oldExists: boolean }> = [];
    armAppImageRelaunch.mockImplementation((image) => {
      seen.push({
        content: fs.readFileSync(image, "utf8"),
        oldExists: fs.existsSync(path.join(installDir, "Daintree-1.0.0.AppImage")),
      });
      return true;
    });

    expect(install()).toBe(true);

    const next = path.join(installDir, "Daintree-2.0.0.AppImage");
    expect(armAppImageRelaunch).toHaveBeenCalledTimes(1);
    expect(armAppImageRelaunch.mock.calls[0]!.slice(0, 2)).toEqual([next, []]);
    expect(seen).toEqual([{ content: "new image", oldExists: false }]);
    // The rename is announced first, so the CLI wrapper already names the new file.
    expect(renamed.mock.invocationCallOrder[0]).toBeLessThan(
      armAppImageRelaunch.mock.invocationCallOrder[0]!
    );
    expect(spawnLog).not.toHaveBeenCalled();
  });

  it("relaunches an image whose name has no version under that same name", () => {
    stage("Daintree-2.0.0.AppImage", "Daintree.AppImage");

    expect(install()).toBe(true);

    const kept = path.join(installDir, "Daintree.AppImage");
    expect(armAppImageRelaunch.mock.calls[0]![0]).toBe(kept);
    expect(fs.readFileSync(kept, "utf8")).toBe("new image");
  });

  // electron-updater deletes the running image before the move, so a failed
  // move leaves neither file: there is nothing safe to run.
  it("arms nothing when the new image never made it into place", () => {
    stage("Daintree-2.0.0.AppImage", "Daintree-1.0.0.AppImage", { downloaded: false });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(install()).toBe(false);

    expect(armAppImageRelaunch).not.toHaveBeenCalled();
    expect(spawnLog).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(installDir, "Daintree-2.0.0.AppImage"))).toBe(false);
  });

  it("falls back to the updater's own spawn when the waiter can't start", () => {
    stage("Daintree-2.0.0.AppImage", "Daintree-1.0.0.AppImage");
    install();

    expect(spawnLog).not.toHaveBeenCalled();
    const fallback = armAppImageRelaunch.mock.calls[0]![2];
    fallback();

    const next = path.join(installDir, "Daintree-2.0.0.AppImage");
    expect(spawnLog).toHaveBeenCalledTimes(1);
    expect(spawnLog.mock.calls[0]!.slice(0, 2)).toEqual([next, []]);
  });

  it("leaves the updater's own spawn in place afterwards", () => {
    stage("Daintree-2.0.0.AppImage", "Daintree-1.0.0.AppImage");
    install();

    expect(Object.hasOwn(updater, "spawnLog")).toBe(false);
  });
});

describe("routeAppImageRelaunchThroughWaiter", () => {
  const image = "/home/u/Applications/Daintree-1.0.0.AppImage";

  function fakeUpdater() {
    return { spawnLog: vi.fn((..._args: unknown[]) => Promise.resolve(true)) };
  }

  it("passes on a spawn that isn't an image beside the running one", async () => {
    runFromImage(image);
    const updater = fakeUpdater();
    const original = updater.spawnLog;

    await routeAppImageRelaunchThroughWaiter(updater, () =>
      updater.spawnLog("/opt/elsewhere/Daintree.AppImage", [])
    );

    expect(armAppImageRelaunch).not.toHaveBeenCalled();
    expect(original).toHaveBeenCalledWith(
      "/opt/elsewhere/Daintree.AppImage",
      [],
      undefined,
      undefined
    );
    expect(updater.spawnLog).toBe(original);
  });

  it("spawns directly when the waiter declines", async () => {
    runFromImage(image);
    armAppImageRelaunch.mockReturnValue(false);
    const updater = fakeUpdater();
    const original = updater.spawnLog;
    const next = "/home/u/Applications/Daintree-2.0.0.AppImage";

    await routeAppImageRelaunchThroughWaiter(updater, () => updater.spawnLog(next, [], { A: "1" }));

    expect(original).toHaveBeenCalledWith(next, [], { A: "1" }, undefined);
  });

  it("restores the spawn even when the install throws", () => {
    runFromImage(image);
    const updater = fakeUpdater();
    const original = updater.spawnLog;

    expect(() =>
      routeAppImageRelaunchThroughWaiter(updater, () => {
        throw new Error("mv failed");
      })
    ).toThrow("mv failed");
    expect(updater.spawnLog).toBe(original);
  });

  it("leaves other platforms and non-AppImage installs alone", () => {
    const updater = fakeUpdater();
    const original = updater.spawnLog;
    const seen: unknown[] = [];
    const install = () => seen.push(updater.spawnLog);

    delete process.env.APPIMAGE;
    routeAppImageRelaunchThroughWaiter(updater, install);
    runFromImage(image);
    setPlatform("darwin");
    routeAppImageRelaunchThroughWaiter(updater, install);

    expect(seen).toEqual([original, original]);
  });
});
