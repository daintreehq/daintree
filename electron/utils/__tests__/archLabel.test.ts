import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  app: { runningUnderARM64Translation: undefined as boolean | undefined },
}));

vi.mock("electron", () => ({
  app: electronMock.app,
}));

import { buildArchLabel } from "../archLabel.js";

const originalPlatform = process.platform;
const originalArch = process.arch;

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, writable: true });
}

function setArch(value: string) {
  Object.defineProperty(process, "arch", { value, writable: true });
}

describe("buildArchLabel", () => {
  beforeEach(() => {
    electronMock.app.runningUnderARM64Translation = undefined;
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    setArch(originalArch);
  });

  it("labels native Apple Silicon as 'Apple Silicon'", () => {
    setPlatform("darwin");
    setArch("arm64");
    electronMock.app.runningUnderARM64Translation = false;
    expect(buildArchLabel()).toBe("Apple Silicon");
  });

  it("labels native Intel macOS as 'Intel'", () => {
    setPlatform("darwin");
    setArch("x64");
    electronMock.app.runningUnderARM64Translation = false;
    expect(buildArchLabel()).toBe("Intel");
  });

  it("flags Rosetta translation as 'Intel (Rosetta)'", () => {
    setPlatform("darwin");
    setArch("x64");
    electronMock.app.runningUnderARM64Translation = true;
    expect(buildArchLabel()).toBe("Intel (Rosetta)");
  });

  it("prioritizes the Rosetta signal over the raw arch on macOS", () => {
    // The running slice always reports x64 under Rosetta; the label must not
    // collapse to a bare "Intel" and hide the translation state.
    setPlatform("darwin");
    setArch("x64");
    electronMock.app.runningUnderARM64Translation = true;
    expect(buildArchLabel()).not.toBe("Intel");
    expect(buildArchLabel()).toContain("Rosetta");
  });

  it("falls back to the raw arch on non-macOS platforms", () => {
    setPlatform("linux");
    setArch("arm64");
    expect(buildArchLabel()).toBe("arm64");
  });

  it("returns the raw arch for unknown macOS slices", () => {
    setPlatform("darwin");
    setArch("ia32");
    electronMock.app.runningUnderARM64Translation = false;
    expect(buildArchLabel()).toBe("ia32");
  });
});
