import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import path from "path";
import Module from "module";

const mockRebuild = vi.fn();
const mockExecSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

const originalExitCode = process.exitCode;

const POSTINSTALL_CMD = "node node_modules/node-pty/scripts/post-install.js";
const SWALLOW_DEFINE = "NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS";
const BINDING_GYP = path.resolve(__dirname, "..", "node_modules", "node-pty", "binding.gyp");
const UNPATCHED_GYP = "{\n  'target_defaults': {\n    'dependencies': [],\n  },\n}\n";
const PATCHED_GYP = `{\n  'target_defaults': {\n    'defines': ['${SWALLOW_DEFINE}'],\n    'dependencies': [],\n  },\n}\n`;

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
      if (id === "fs") {
        return { readFileSync: mockReadFileSync, writeFileSync: mockWriteFileSync };
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
    mockRebuild.mockReset().mockResolvedValue(undefined);
    mockExecSync.mockReturnValue(undefined);
    mockReadFileSync.mockReset().mockReturnValue(UNPATCHED_GYP);
    mockWriteFileSync.mockReset();
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

  it("should rebuild the three project native modules and skip better-sqlite3", async () => {
    await runPostinstall();

    // better-sqlite3 (v13+, N-API) loads from its packaged prebuilds and is
    // deliberately absent — an @electron/rebuild pass would be a no-op.
    expect(mockRebuild).toHaveBeenCalledTimes(3);
    expect(rebuiltModules()).toEqual(["node-pty", "win-job-object", "posix-pty-reaper"]);
  });

  it("should pass electronVersion and buildPath to every rebuild call", async () => {
    await runPostinstall();

    for (let i = 1; i <= 3; i++) {
      expect(mockRebuild).toHaveBeenNthCalledWith(
        i,
        expect.objectContaining({
          electronVersion: "42.3.3",
          buildPath: path.resolve(__dirname, ".."),
          force: true,
          buildFromSource: true,
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
    // patch-package (or other) step being reintroduced ahead of it. The
    // binding.gyp patch runs in-process.
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it("should continue rebuilding when the first module fails", async () => {
    mockRebuild.mockRejectedValueOnce(new Error("node-pty build failed"));

    await runPostinstall();

    expect(mockRebuild).toHaveBeenCalledTimes(3);
    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("should continue rebuilding when a middle module fails", async () => {
    mockRebuild.mockResolvedValueOnce(undefined);
    mockRebuild.mockRejectedValueOnce(new Error("win-job-object failed"));

    await runPostinstall();

    expect(mockRebuild).toHaveBeenCalledTimes(3);
    expect(process.exitCode).toBe(1);

    const errorCalls = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(errorCalls).toMatch(/win-job-object/);
    expect(errorCalls).not.toMatch(/node-pty/);
  });

  it("should continue when the last module fails", async () => {
    mockRebuild
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("posix-pty-reaper build failed"));

    await runPostinstall();

    expect(mockRebuild).toHaveBeenCalledTimes(3);
    expect(process.exitCode).toBe(1);

    const errorCalls = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(errorCalls).toMatch(/posix-pty-reaper/);
  });

  it("should report all failures when all modules fail", async () => {
    mockRebuild.mockRejectedValue(new Error("rebuild failed"));

    await runPostinstall();

    expect(mockRebuild).toHaveBeenCalledTimes(3);
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

    expect(mockRebuild).toHaveBeenCalledTimes(3);
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

  it("patches node-pty's binding.gyp before rebuilding node-pty", async () => {
    await runPostinstall();

    expect(mockReadFileSync).toHaveBeenCalledWith(BINDING_GYP, "utf8");
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const [writtenPath, written] = mockWriteFileSync.mock.calls[0];
    expect(writtenPath).toBe(BINDING_GYP);
    expect(written).toContain(`'defines': ['${SWALLOW_DEFINE}'],`);
    expect(mockWriteFileSync.mock.invocationCallOrder[0]).toBeLessThan(
      mockRebuild.mock.invocationCallOrder[0]
    );
    expect(rebuiltModules()[0]).toBe("node-pty");
    expect(process.exitCode).toBeUndefined();
  });

  it("leaves an already-patched binding.gyp untouched", async () => {
    mockReadFileSync.mockReturnValue(PATCHED_GYP);

    await runPostinstall();

    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockRebuild).toHaveBeenCalledTimes(3);
    expect(process.exitCode).toBeUndefined();
  });

  it("fails the install but still rebuilds everything when the patch cannot apply", async () => {
    mockReadFileSync.mockReturnValue("{\n  'targets': [],\n}\n");

    await runPostinstall();

    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(rebuiltModules()).toEqual(["node-pty", "win-job-object", "posix-pty-reaper"]);
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);

    const errorCalls = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(errorCalls).toMatch(/node-pty binding\.gyp patch/);
    expect(errorCalls).toMatch(/target_defaults/);
  });

  it("fails the install when binding.gyp cannot be read", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    await runPostinstall();

    expect(mockRebuild).toHaveBeenCalledTimes(3);
    expect(process.exitCode).toBe(1);

    const errorCalls = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(errorCalls).toMatch(/node-pty binding\.gyp patch: ENOENT/);
  });

  it("fails the install when the patched binding.gyp cannot be written", async () => {
    mockWriteFileSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    await runPostinstall();

    expect(mockRebuild).toHaveBeenCalledTimes(3);
    expect(process.exitCode).toBe(1);

    const errorCalls = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(errorCalls).toMatch(/node-pty binding\.gyp patch: EACCES/);
  });

  it("reports a patch failure alongside a rebuild failure", async () => {
    mockReadFileSync.mockReturnValue("{}\n");
    mockRebuild.mockResolvedValueOnce(undefined);
    mockRebuild.mockRejectedValueOnce(new Error("win-job-object failed"));

    await runPostinstall();

    expect(process.exitCode).toBe(1);
    const errorCalls = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(errorCalls).toMatch(/Postinstall failures \(2\)/);
    expect(errorCalls).toMatch(/node-pty binding\.gyp patch/);
    expect(errorCalls).toMatch(/win-job-object/);
  });
});
