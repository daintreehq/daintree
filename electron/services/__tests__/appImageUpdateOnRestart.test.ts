import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppImageUpdater, BaseUpdater } from "electron-updater";

// Only the waiter's spawn is faked; electron-updater's own `mv` and run of the
// new image are real, on files in a temp dir.
const mocks = vi.hoisted(() => {
  const waiter = { on: vi.fn(), unref: vi.fn() };
  return { waiter, spawn: vi.fn(() => waiter), relaunch: vi.fn() };
});
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("electron", () => ({ app: { relaunch: mocks.relaunch } }));
vi.mock("../CliInstallService.js", () => ({ repointAppImageWrapper: vi.fn(() => true) }));

import { armRelaunch, resetArmedRelaunchForTests } from "../../lifecycle/armRelaunch.js";
import { notifyAppImageRelocated } from "../appImageRelocation.js";
import { routeAppImageRelaunchThroughWaiter } from "../appImageUpdateRelaunch.js";

const originalPlatform = process.platform;
const savedEnvNames = ["APPIMAGE", "APPDIR"];
const originalEnv = Object.fromEntries(savedEnvNames.map((name) => [name, process.env[name]]));

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

/** Each waiter started, as the command it will run. */
function waiterCommands(): string[][] {
  return mocks.spawn.mock.calls.map((call) => {
    const file = (call as unknown as [string, string[]])[1][3]!;
    return fs.readFileSync(file, "utf8").split("\0").slice(0, -1);
  });
}

// The real `mv` and the run of a `#!/bin/sh` image need a POSIX host.
describe.skipIf(process.platform === "win32")("an AppImage restart with an update staged", () => {
  let dir: string;
  let installDir: string;
  let oldImage: string;
  let newImage: string;
  let updater: AppImageUpdater;
  let quitHandlers: Array<(exitCode: number) => void>;
  let updaterSpawn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform("linux");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "appimage-restart-"));
    installDir = path.join(dir, "Applications");
    fs.mkdirSync(installDir);
    fs.mkdirSync(path.join(dir, "pending"));
    oldImage = path.join(installDir, "Daintree-1.2.0.AppImage");
    newImage = path.join(installDir, "Daintree-1.3.0.AppImage");
    fs.writeFileSync(oldImage, "old image", { mode: 0o755 });
    // install-on-quit runs the new image once (APPIMAGE_EXIT_AFTER_INSTALL); this one just exits.
    const download = path.join(dir, "pending", "Daintree-1.3.0.AppImage");
    fs.writeFileSync(download, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    // runningAppImage() requires this binary to sit inside APPDIR, as it does in a mount.
    process.env.APPIMAGE = oldImage;
    process.env.APPDIR = path.dirname(process.execPath);

    quitHandlers = [];
    updater = new AppImageUpdater(null, {
      version: "1.2.0",
      onQuit: (handler: (exitCode: number) => void) => quitHandlers.push(handler),
    } as never);
    updater.logger = null;
    (updater as unknown as { downloadedUpdateHelper: unknown }).downloadedUpdateHelper = {
      file: download,
      downloadedFileInfo: { isAdminRightsRequired: false },
    };
    // What a finished download does: install on quit unless something installs first.
    (updater as unknown as { addQuitHandler(): void }).addQuitHandler();
    // AutoUpdaterService's listener, which outlives the shutdown chain.
    updater.on("appimage-filename-updated", (next: string) =>
      notifyAppImageRelocated({ previous: process.env.APPIMAGE!, next })
    );
    updaterSpawn = vi
      .spyOn(BaseUpdater.prototype as unknown as { spawnLog: () => Promise<boolean> }, "spawnLog")
      .mockResolvedValue(true);
  });

  afterEach(() => {
    for (const call of mocks.spawn.mock.calls) {
      const file = (call as unknown as [string, string[]])[1][3]!;
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
    resetArmedRelaunchForTests();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    setPlatform(originalPlatform);
    for (const name of savedEnvNames) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  });

  // Toggling hardware acceleration, a data reset: armRelaunch, then app.exit(0),
  // whose `quit` event runs electron-updater's install-on-quit.
  it("comes back as the installed update, once, with the restart's args", () => {
    armRelaunch({ args: ["--disable-gpu"] });
    expect(waiterCommands()).toEqual([[oldImage, "--disable-gpu"]]);

    for (const handler of quitHandlers) handler(0);

    expect(fs.existsSync(oldImage)).toBe(false);
    expect(fs.existsSync(newImage)).toBe(true);
    expect(waiterCommands()).toEqual([[newImage, "--disable-gpu"]]);
    expect(updaterSpawn).not.toHaveBeenCalled();
  });

  it("comes back on the same image when the update keeps its name", () => {
    const unversioned = path.join(installDir, "Daintree.AppImage");
    fs.renameSync(oldImage, unversioned);
    process.env.APPIMAGE = unversioned;

    armRelaunch({ args: [] });
    for (const handler of quitHandlers) handler(0);

    expect(fs.readFileSync(unversioned, "utf8")).toContain("exit 0");
    expect(waiterCommands()).toEqual([[unversioned]]);
  });

  // "Restart to update": the update's own relaunch, then the quit it triggers.
  it("starts one instance when the install is the restart", () => {
    routeAppImageRelaunchThroughWaiter(updater, () => updater.install(false, true));
    for (const handler of quitHandlers) handler(0);

    expect(waiterCommands()).toEqual([[newImage]]);
    expect(updaterSpawn).not.toHaveBeenCalled();
  });
});
