import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import path from "path";
import Module from "module";

const mockRebuild = vi.fn();
const mockExecSync = vi.fn();

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

const originalExitCode = process.exitCode;

const POSTINSTALL_CMD = "node node_modules/node-pty/scripts/post-install.js";

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
        return { version: "42.3.3" };
      }
      if (id === "child_process") {
        return { execSync: mockExecSync };
      }
      return originalRequire.apply(this, [id]);
    } as typeof Module.prototype.require;
  }

  function restoreMocks() {
    Module.prototype.require = originalRequire;
  }

  function rebuiltModules() {
    return mockRebuild.mock.calls.map((c) => c[0].onlyModules[0]);
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

  it("should rebuild all four native modules, better-sqlite3 last", async () => {
    await runPostinstall();

    expect(mockRebuild).toHaveBeenCalledTimes(4);
    expect(rebuiltModules()).toEqual([
      "node-pty",
      "win-job-object",
      "posix-pty-reaper",
      "better-sqlite3",
    ]);
  });

  it("should pass electronVersion and buildPath to every rebuild call", async () => {
    await runPostinstall();

    for (let i = 1; i <= 4; i++) {
      expect(mockRebuild).toHaveBeenNthCalledWith(
        i,
        expect.objectContaining({
          electronVersion: "42.3.3",
          buildPath: path.resolve(__dirname, ".."),
          force: true,
        })
      );
    }
  });

  it("should run node-pty post-install after all rebuilds", async () => {
    await runPostinstall();

    expect(mockExecSync).toHaveBeenCalledWith(POSTINSTALL_CMD, {
      stdio: "inherit",
      cwd: path.resolve(__dirname, ".."),
    });
    // node-pty post-install is the only execSync call — guards against a
    // patch-package (or other) step being reintroduced ahead of it.
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it("should continue rebuilding when the first module fails", async () => {
    mockRebuild.mockRejectedValueOnce(new Error("node-pty build failed"));

    await runPostinstall();

    expect(mockRebuild).toHaveBeenCalledTimes(4);
    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("should continue rebuilding when a middle module fails", async () => {
    mockRebuild.mockResolvedValueOnce(undefined);
    mockRebuild.mockRejectedValueOnce(new Error("win-job-object failed"));

    await runPostinstall();

    expect(mockRebuild).toHaveBeenCalledTimes(4);
    expect(process.exitCode).toBe(1);

    const errorCalls = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(errorCalls).toMatch(/win-job-object/);
    expect(errorCalls).not.toMatch(/node-pty/);
  });

  it("should continue when better-sqlite3 rebuild fails", async () => {
    mockRebuild
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("better-sqlite3 V8 build failed"));

    await runPostinstall();

    expect(mockRebuild).toHaveBeenCalledTimes(4);
    expect(process.exitCode).toBe(1);

    const errorCalls = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(errorCalls).toMatch(/better-sqlite3/);
  });

  it("should report all failures when all modules fail", async () => {
    mockRebuild.mockRejectedValue(new Error("rebuild failed"));

    await runPostinstall();

    expect(mockRebuild).toHaveBeenCalledTimes(4);
    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("should still run post-install when all rebuilds fail", async () => {
    mockRebuild.mockRejectedValue(new Error("all failed"));

    await runPostinstall();

    expect(mockExecSync).toHaveBeenCalledWith(POSTINSTALL_CMD, expect.anything());
    expect(process.exitCode).toBe(1);
  });

  it("should report post-install failure separately", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === POSTINSTALL_CMD) throw new Error("ConPTY fetch failed");
      return undefined;
    });

    await runPostinstall();

    expect(mockRebuild).toHaveBeenCalledTimes(4);
    expect(process.exitCode).toBe(1);

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
