import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import path from "path";
import Module from "module";

const mockRebuild = vi.fn();
const mockExecSync = vi.fn();

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

const originalExitCode = process.exitCode;

afterAll(() => {
  consoleErrorSpy.mockRestore();
  consoleLogSpy.mockRestore();
  process.exitCode = originalExitCode;
});

describe("postinstall", () => {
  let runPostinstall: () => Promise<void>;
  const originalRequire = Module.prototype.require;

  function setupMocks() {
    Module.prototype.require = function (id: string) {
      if (id === "@electron/rebuild") {
        return { rebuild: mockRebuild };
      }
      if (id === "electron/package.json") {
        return { version: "41.7.1" };
      }
      if (id === "child_process") {
        return {
          execSync: mockExecSync,
          exec: vi.fn(),
          spawn: vi.fn(),
          spawnSync: vi.fn(),
        };
      }
      return originalRequire.apply(this, [id]);
    } as typeof Module.prototype.require;
  }

  function restoreMocks() {
    Module.prototype.require = originalRequire;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy.mockImplementation(() => {});
    consoleLogSpy.mockImplementation(() => {});
    mockRebuild.mockResolvedValue(undefined);
    mockExecSync.mockReturnValue(undefined);
    process.exitCode = undefined;

    setupMocks();
    try {
      delete require.cache[require.resolve("./postinstall.cjs")];
      const module = require("./postinstall.cjs");
      runPostinstall = module.runPostinstall;
    } finally {
      restoreMocks();
    }
  });

  afterEach(() => {
    restoreMocks();
  });

  it("should rebuild all three modules sequentially", async () => {
    await runPostinstall();

    expect(mockRebuild).toHaveBeenCalledTimes(3);
    expect(mockRebuild).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        onlyModules: ["node-pty"],
        force: true,
      })
    );
    expect(mockRebuild).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        onlyModules: ["win-job-object"],
      })
    );
    expect(mockRebuild).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        onlyModules: ["posix-pty-reaper"],
      })
    );
  });

  it("should pass electronVersion and buildPath to every rebuild call", async () => {
    await runPostinstall();

    for (let i = 1; i <= 3; i++) {
      expect(mockRebuild).toHaveBeenNthCalledWith(
        i,
        expect.objectContaining({
          electronVersion: "41.7.1",
          buildPath: path.resolve(__dirname, ".."),
          force: true,
        })
      );
    }
  });

  it("should run node-pty post-install after all rebuilds", async () => {
    await runPostinstall();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(
      "node node_modules/node-pty/scripts/post-install.js",
      { stdio: "inherit", cwd: expect.any(String) }
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("should continue rebuilding when the first module fails", async () => {
    mockRebuild.mockRejectedValueOnce(new Error("node-pty build failed"));

    await runPostinstall();

    expect(mockRebuild).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("should continue rebuilding when a middle module fails", async () => {
    mockRebuild.mockResolvedValueOnce(undefined);
    mockRebuild.mockRejectedValueOnce(new Error("win-job-object failed"));

    await runPostinstall();

    expect(mockRebuild).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);

    const errorCalls = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(errorCalls).toMatch(/win-job-object/);
    expect(errorCalls).not.toMatch(/node-pty/);
  });

  it("should continue when the last module fails", async () => {
    mockRebuild.mockResolvedValueOnce(undefined);
    mockRebuild.mockResolvedValueOnce(undefined);
    mockRebuild.mockRejectedValueOnce(new Error("posix-pty-reaper failed"));

    await runPostinstall();

    expect(mockRebuild).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it("should report all failures when all modules fail", async () => {
    mockRebuild.mockRejectedValue(new Error("rebuild failed"));

    await runPostinstall();

    expect(mockRebuild).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("should still run post-install when all rebuilds fail", async () => {
    mockRebuild.mockRejectedValue(new Error("all failed"));

    await runPostinstall();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it("should report post-install failure separately", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("ConPTY fetch failed");
    });

    await runPostinstall();

    expect(mockRebuild).toHaveBeenCalledTimes(3);
    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();

    const errorCalls = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(errorCalls).toMatch(/node-pty post-install/);
    expect(errorCalls).toMatch(/ConPTY fetch failed/);
  });

  it("should exit 0 when everything succeeds", async () => {
    await runPostinstall();

    expect(process.exitCode).toBeUndefined();
  });

  it("should log failure details with module names", async () => {
    mockRebuild.mockRejectedValueOnce(new Error("gyp error"));
    mockRebuild.mockRejectedValueOnce(new Error("link error"));

    await runPostinstall();

    const errorCalls = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(errorCalls).toMatch(/node-pty/);
    expect(errorCalls).toMatch(/win-job-object/);
  });
});
