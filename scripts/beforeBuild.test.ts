import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

afterAll(() => {
  consoleSpy.mockRestore();
});

function createContext(platformNodeName: string) {
  return {
    appDir: "/app",
    electronVersion: "40.0.0",
    platform: { nodeName: platformNodeName },
    arch: "x64",
  };
}

describe("beforeBuild", () => {
  let beforeBuild: (context: any) => Promise<boolean | void>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy.mockImplementation(() => {});

    delete require.cache[require.resolve("./beforeBuild.cjs")];
    const module = require("./beforeBuild.cjs");
    beforeBuild = module.default;
  });

  it("should return false on Windows to skip rebuild", async () => {
    const result = await beforeBuild(createContext("win32"));

    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith(
      "[beforeBuild] Windows detected — skipping native module rebuild (using prebuilds)"
    );
  });

  it("should return undefined on macOS to allow rebuild", async () => {
    const result = await beforeBuild(createContext("darwin"));

    expect(result).toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      "[beforeBuild] Platform: darwin — allowing native module rebuild"
    );
  });

  it("should return undefined on Linux to allow rebuild", async () => {
    const result = await beforeBuild(createContext("linux"));

    expect(result).toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      "[beforeBuild] Platform: linux — allowing native module rebuild"
    );
  });
});
