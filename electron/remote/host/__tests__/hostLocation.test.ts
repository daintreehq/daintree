import { afterEach, describe, expect, it, vi } from "vitest";

const app = vi.hoisted(() => ({
  isPackaged: true,
  getPath: vi.fn((_name: string) => "/Users/g/Library/Application Support/Daintree"),
  getAppPath: vi.fn(() => "/Users/g/src/daintree"),
}));

vi.mock("electron", () => ({ app }));

import { hostLaunchCommand } from "../hostLocation.js";

const realPlatform = process.platform;

function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(() => {
  onPlatform(realPlatform);
  app.isPackaged = true;
});

describe("hostLaunchCommand", () => {
  it("tells the bridge which profile a macOS Host listens in", () => {
    onPlatform("darwin");
    expect(hostLaunchCommand()).toEqual([
      process.execPath,
      "--user-data-dir=/Users/g/Library/Application Support/Daintree",
    ]);
    app.isPackaged = false;
    expect(hostLaunchCommand()).toEqual([
      process.execPath,
      "/Users/g/src/daintree",
      "--user-data-dir=/Users/g/Library/Application Support/Daintree",
    ]);
  });

  it("adds nothing on Linux, where the socket isn't in the profile", () => {
    onPlatform("linux");
    expect(hostLaunchCommand()).toEqual([process.execPath]);
  });
});
