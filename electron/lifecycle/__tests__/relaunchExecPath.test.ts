import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withRelaunchExecPath } from "../relaunchExecPath.js";

const originalPlatform = process.platform;
const originalEnv = { APPIMAGE: process.env.APPIMAGE, APPDIR: process.env.APPDIR };
const originalArgv = process.argv;
const image = "/home/u/Applications/Daintree.AppImage";

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function restoreEnv(name: "APPIMAGE" | "APPDIR") {
  if (originalEnv[name] === undefined) delete process.env[name];
  else process.env[name] = originalEnv[name];
}

beforeEach(() => {
  setPlatform("linux");
  process.argv = ["/tmp/.mount_x/daintree", "--no-sandbox", "--host-mode"];
});

afterEach(() => {
  setPlatform(originalPlatform);
  restoreEnv("APPIMAGE");
  restoreEnv("APPDIR");
  process.argv = originalArgv;
});

describe("withRelaunchExecPath", () => {
  // runningAppImage() requires this binary to sit inside APPDIR, as it does in a mount.
  function runFromImage() {
    process.env.APPIMAGE = image;
    process.env.APPDIR = path.dirname(process.execPath);
  }

  it("relaunches an AppImage through the image, keeping the caller's args", () => {
    runFromImage();
    expect(withRelaunchExecPath({ args: ["--reset-data"] })).toEqual({
      args: ["--reset-data"],
      execPath: image,
    });
  });

  // Electron takes execPath as a full argv override: without args it would
  // relaunch with none, dropping --host-mode and friends.
  it("keeps the current args when the caller passes none", () => {
    runFromImage();
    expect(withRelaunchExecPath()).toEqual({
      args: ["--no-sandbox", "--host-mode"],
      execPath: image,
    });
  });

  it("ignores an APPIMAGE inherited from another app's terminal", () => {
    process.env.APPIMAGE = "/home/u/Other.AppImage";
    process.env.APPDIR = "/tmp/.mount_other";
    expect(withRelaunchExecPath()).toEqual({});
  });

  it("leaves a deb install and other platforms on their own executable", () => {
    delete process.env.APPIMAGE;
    expect(withRelaunchExecPath({ args: ["a"] })).toEqual({ args: ["a"] });
    runFromImage();
    setPlatform("darwin");
    expect(withRelaunchExecPath({ args: ["a"] })).toEqual({ args: ["a"] });
  });
});
