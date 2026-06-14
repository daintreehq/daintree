import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  app: { runningUnderARM64Translation: undefined as boolean | undefined },
}));

vi.mock("electron", () => ({
  app: electronMock.app,
}));

import { isRunningUnderRosetta } from "../rosettaDetection.js";

const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, writable: true });
}

describe("isRunningUnderRosetta", () => {
  beforeEach(() => {
    electronMock.app.runningUnderARM64Translation = undefined;
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it("returns true on macOS when the translation flag is set", () => {
    setPlatform("darwin");
    electronMock.app.runningUnderARM64Translation = true;
    expect(isRunningUnderRosetta()).toBe(true);
  });

  it("returns false on macOS when running natively", () => {
    setPlatform("darwin");
    electronMock.app.runningUnderARM64Translation = false;
    expect(isRunningUnderRosetta()).toBe(false);
  });

  it("returns false on macOS when the flag is unavailable", () => {
    setPlatform("darwin");
    expect(isRunningUnderRosetta()).toBe(false);
  });

  it("excludes Windows ARM x64 translation (WOW64 also sets the flag)", () => {
    setPlatform("win32");
    electronMock.app.runningUnderARM64Translation = true;
    expect(isRunningUnderRosetta()).toBe(false);
  });

  it("returns false on Linux where the flag is undefined", () => {
    setPlatform("linux");
    expect(isRunningUnderRosetta()).toBe(false);
  });
});
