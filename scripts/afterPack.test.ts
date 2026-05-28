import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import path from "path";
import Module from "module";

const mockExistsSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockCopyFileSync = vi.fn();
const mockAccessSync = vi.fn();
const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

const originalDlopen = process.dlopen;

afterAll(() => {
  consoleSpy.mockRestore();
  warnSpy.mockRestore();
  process.dlopen = originalDlopen;
});

function createContext(platform: string, appOutDir: string, appName = "Daintree") {
  return {
    appOutDir,
    electronPlatformName: platform,
    packager: { appInfo: { productFilename: appName } },
  };
}

describe("afterPack", () => {
  let afterPack: (context: any) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy.mockImplementation(() => {});
    warnSpy.mockImplementation(() => {});
    // Default: both native modules load cleanly.
    //   - better-sqlite3: dlopen throws NODE_MODULE_VERSION mismatch (correct Electron ABI)
    //   - win-job-object: dlopen succeeds and populates assignProcessToHelpJob export
    //   - posix-pty-reaper: accessSync(X_OK) passes
    // Individual tests override these for specific scenarios.
    mockAccessSync.mockImplementation(() => {});

    let dlopenCallCount = 0;
    process.dlopen = ((moduleObj: { exports: Record<string, unknown> }, filename: string) => {
      dlopenCallCount += 1;
      if (filename.includes("win_job_object")) {
        moduleObj.exports.assignProcessToHelpJob = () => true;
        return;
      }
      throw new Error(
        "was compiled against a different Node.js version using NODE_MODULE_VERSION 131"
      );
    }) as typeof process.dlopen;
    // Silence the unused-variable warning while preserving the counter for future debugging.
    void dlopenCallCount;

    const originalRequire = Module.prototype.require;

    Module.prototype.require = function (id: string) {
      if (id === "fs") {
        return {
          existsSync: mockExistsSync,
          readdirSync: mockReaddirSync,
          mkdirSync: mockMkdirSync,
          copyFileSync: mockCopyFileSync,
          accessSync: mockAccessSync,
          constants: { X_OK: 1 },
        };
      }
      return originalRequire.apply(this, [id]);
    };

    try {
      delete require.cache[require.resolve("./afterPack.cjs")];
      const module = require("./afterPack.cjs");
      afterPack = module.default;
    } finally {
      Module.prototype.require = originalRequire;
    }
  });

  describe("macOS", () => {
    const unpackedBase = "/build/mac/Daintree.app/Contents/Resources/app.asar.unpacked";

    it("should succeed when node-pty and better-sqlite3 exist", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("darwin", "/build/mac"));

      expect(mockExistsSync).toHaveBeenCalledWith(path.join(unpackedBase, "node_modules/node-pty"));
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/node-pty/build/Release/pty.node")
      );
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/better-sqlite3")
      );
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/better-sqlite3/build/Release/better_sqlite3.node")
      );
    });

    it("should use productFilename in path construction", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("darwin", "/build/mac", "MyApp"));

      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(
          "/build/mac/MyApp.app/Contents/Resources/app.asar.unpacked",
          "node_modules/node-pty"
        )
      );
    });

    it("should log signing message on macOS", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("darwin", "/build/mac"));

      expect(consoleSpy).toHaveBeenCalledWith(
        "[afterPack] Native modules will be signed during code signing phase"
      );
    });

    it("should throw when node-pty directory is missing", async () => {
      mockExistsSync.mockReturnValue(false);

      await expect(afterPack(createContext("darwin", "/build/mac"))).rejects.toThrow(
        /node-pty not found/
      );
    });

    it("should throw when pty.node binary is missing", async () => {
      mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);

      await expect(afterPack(createContext("darwin", "/build/mac"))).rejects.toThrow(
        /native binary not found/
      );
    });

    it("should throw when better-sqlite3 directory is missing", async () => {
      mockExistsSync
        .mockReturnValueOnce(true) // node-pty dir
        .mockReturnValueOnce(true) // pty.node
        .mockReturnValueOnce(true) // posix-pty-reaper supervisor
        .mockReturnValueOnce(false) // Assets.car (macOS icon injection)
        .mockReturnValueOnce(false); // better-sqlite3 dir

      await expect(afterPack(createContext("darwin", "/build/mac"))).rejects.toThrow(
        /better-sqlite3 not found/
      );
    });

    it("should throw when better_sqlite3.node binary is missing", async () => {
      mockExistsSync
        .mockReturnValueOnce(true) // node-pty dir
        .mockReturnValueOnce(true) // pty.node
        .mockReturnValueOnce(true) // posix-pty-reaper supervisor
        .mockReturnValueOnce(false) // Assets.car (macOS icon injection)
        .mockReturnValueOnce(true) // better-sqlite3 dir
        .mockReturnValueOnce(false); // better_sqlite3.node

      await expect(afterPack(createContext("darwin", "/build/mac"))).rejects.toThrow(
        /better-sqlite3 native binary not found/
      );
    });

    it("should throw when posix-pty-reaper supervisor binary is missing", async () => {
      mockExistsSync
        .mockReturnValueOnce(true) // node-pty dir
        .mockReturnValueOnce(true) // pty.node
        .mockReturnValueOnce(false); // posix-pty-reaper supervisor

      await expect(afterPack(createContext("darwin", "/build/mac"))).rejects.toThrow(
        /posix-pty-reaper supervisor binary not found/
      );
    });

    it("should verify the posix-pty-reaper supervisor binary path", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("darwin", "/build/mac"));

      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(
          unpackedBase,
          "node_modules/posix-pty-reaper/build/Release/daintree_pty_supervisor"
        )
      );
    });
  });

  describe("Windows", () => {
    const unpackedBase = "/build/win/resources/app.asar.unpacked";

    it("should succeed when compiled binaries and conpty exist", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("win32", "/build/win"));

      expect(mockExistsSync).toHaveBeenCalledWith(path.join(unpackedBase, "node_modules/node-pty"));
      // Compiled binaries in build/Release
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/node-pty/build/Release/conpty.node")
      );
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/node-pty/build/Release/conpty_console_list.node")
      );
      // Post-install conpty binaries
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/node-pty/build/Release/conpty/conpty.dll")
      );
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/node-pty/build/Release/conpty/OpenConsole.exe")
      );
    });

    it("should throw when compiled binary is missing", async () => {
      mockExistsSync
        .mockReturnValueOnce(true) // node-pty dir
        .mockReturnValueOnce(false); // conpty.node missing

      await expect(afterPack(createContext("win32", "/build/win"))).rejects.toThrow(
        /Windows node-pty compiled binary not found/
      );
    });

    it("should copy conpty from third_party when missing from build/Release", async () => {
      const nodePtyPath = path.join(unpackedBase, "node_modules/node-pty");
      mockExistsSync
        .mockReturnValueOnce(true) // node-pty dir
        .mockReturnValueOnce(true) // conpty.node
        .mockReturnValueOnce(true) // conpty_console_list.node
        .mockReturnValueOnce(false) // conpty/conpty.dll missing (triggers fallback)
        .mockReturnValueOnce(true) // third_party/conpty exists
        .mockReturnValueOnce(true) // sourceDir exists
        .mockReturnValue(true); // final validation passes

      mockReaddirSync.mockReturnValue(["1.25.260303002"]);

      await afterPack(createContext("win32", "/build/win"));

      expect(mockMkdirSync).toHaveBeenCalledWith(path.join(nodePtyPath, "build/Release/conpty"), {
        recursive: true,
      });
      expect(mockCopyFileSync).toHaveBeenCalledTimes(2);
    });

    it("should throw when third_party/conpty is missing for fallback", async () => {
      mockExistsSync
        .mockReturnValueOnce(true) // node-pty dir
        .mockReturnValueOnce(true) // conpty.node
        .mockReturnValueOnce(true) // conpty_console_list.node
        .mockReturnValueOnce(false) // conpty/conpty.dll missing
        .mockReturnValueOnce(false); // third_party/conpty missing

      await expect(afterPack(createContext("win32", "/build/win"))).rejects.toThrow(
        /third_party\/conpty not found/
      );
    });

    it("should not log signing message on Windows", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("win32", "/build/win"));

      expect(consoleSpy).not.toHaveBeenCalledWith(
        "[afterPack] Native modules will be signed during code signing phase"
      );
    });

    it("should throw when node-pty directory is missing", async () => {
      mockExistsSync.mockReturnValue(false);

      await expect(afterPack(createContext("win32", "/build/win"))).rejects.toThrow(
        /node-pty not found/
      );
    });
  });

  describe("Linux", () => {
    const unpackedBase = "/build/linux/resources/app.asar.unpacked";

    it("should succeed with Linux resource path", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("linux", "/build/linux"));

      expect(mockExistsSync).toHaveBeenCalledWith(path.join(unpackedBase, "node_modules/node-pty"));
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/node-pty/build/Release/pty.node")
      );
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/better-sqlite3")
      );
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/better-sqlite3/build/Release/better_sqlite3.node")
      );
    });

    it("should not log signing message on Linux", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("linux", "/build/linux"));

      expect(consoleSpy).not.toHaveBeenCalledWith(
        "[afterPack] Native modules will be signed during code signing phase"
      );
    });

    it("should throw when node-pty directory is missing", async () => {
      mockExistsSync.mockReturnValue(false);

      await expect(afterPack(createContext("linux", "/build/linux"))).rejects.toThrow(
        /node-pty not found/
      );
    });

    it("should throw when pty.node binary is missing", async () => {
      mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);

      await expect(afterPack(createContext("linux", "/build/linux"))).rejects.toThrow(
        /native binary not found/
      );
    });

    it("should throw when posix-pty-reaper supervisor binary is missing", async () => {
      mockExistsSync
        .mockReturnValueOnce(true) // node-pty dir
        .mockReturnValueOnce(true) // pty.node
        .mockReturnValueOnce(false); // posix-pty-reaper supervisor

      await expect(afterPack(createContext("linux", "/build/linux"))).rejects.toThrow(
        /posix-pty-reaper supervisor binary not found/
      );
    });

    it("should verify the posix-pty-reaper supervisor binary path", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("linux", "/build/linux"));

      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(
          unpackedBase,
          "node_modules/posix-pty-reaper/build/Release/daintree_pty_supervisor"
        )
      );
    });
  });

  describe("better-sqlite3 ABI validation", () => {
    it("should fail when better_sqlite3.node loads under Node (Node-ABI binary)", async () => {
      mockExistsSync.mockReturnValue(true);
      process.dlopen = (() => {
        // Successfully loads — means binary is Node ABI (wrong for Electron)
      }) as typeof process.dlopen;

      await expect(afterPack(createContext("linux", "/build/linux"))).rejects.toThrow(
        /compiled for Node\.js ABI/
      );
    });

    it("should pass when dlopen throws NODE_MODULE_VERSION mismatch (Electron-ABI binary)", async () => {
      mockExistsSync.mockReturnValue(true);
      process.dlopen = (() => {
        throw new Error(
          "was compiled against a different Node.js version using NODE_MODULE_VERSION 131"
        );
      }) as typeof process.dlopen;

      await afterPack(createContext("linux", "/build/linux"));

      expect(consoleSpy).toHaveBeenCalledWith(
        "[afterPack] better-sqlite3 ABI check passed (Electron-ABI binary confirmed)"
      );
    });

    it("should pass when dlopen throws invalid ELF header", async () => {
      mockExistsSync.mockReturnValue(true);
      process.dlopen = (() => {
        throw new Error("invalid ELF header");
      }) as typeof process.dlopen;

      await afterPack(createContext("linux", "/build/linux"));

      expect(consoleSpy).toHaveBeenCalledWith(
        "[afterPack] better-sqlite3 ABI check passed (Electron-ABI binary confirmed)"
      );
    });

    it("should pass when dlopen throws not a valid Win32 application", async () => {
      mockExistsSync.mockReturnValue(true);
      process.dlopen = ((mod: { exports: Record<string, unknown> }, filename: string) => {
        if (filename.includes("win_job_object")) {
          mod.exports.assignProcessToHelpJob = () => true;
          return;
        }
        throw new Error("not a valid Win32 application");
      }) as typeof process.dlopen;

      await afterPack(createContext("win32", "/build/win"));

      expect(consoleSpy).toHaveBeenCalledWith(
        "[afterPack] better-sqlite3 ABI check passed (Electron-ABI binary confirmed)"
      );
    });

    it("should warn when dlopen throws a non-Error object", async () => {
      mockExistsSync.mockReturnValue(true);
      process.dlopen = (() => {
        throw "unexpected string error";
      }) as typeof process.dlopen;

      await afterPack(createContext("linux", "/build/linux"));

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ABI probe inconclusive"));
    });

    it("should warn but continue on inconclusive probe (e.g. missing DLL)", async () => {
      mockExistsSync.mockReturnValue(true);
      process.dlopen = ((mod: { exports: Record<string, unknown> }, filename: string) => {
        if (filename.includes("win_job_object")) {
          mod.exports.assignProcessToHelpJob = () => true;
          return;
        }
        throw new Error("The specified module could not be found");
      }) as typeof process.dlopen;

      await afterPack(createContext("win32", "/build/win"));

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ABI probe inconclusive"));
    });

    it("should run ABI validation on all platforms", async () => {
      mockExistsSync.mockReturnValue(true);
      const dlopenCalls: string[] = [];
      process.dlopen = ((mod: { exports: Record<string, unknown> }, filename: string) => {
        dlopenCalls.push(filename);
        if (filename.includes("win_job_object")) {
          mod.exports.assignProcessToHelpJob = () => true;
          return;
        }
        throw new Error("NODE_MODULE_VERSION mismatch");
      }) as typeof process.dlopen;

      for (const platform of ["darwin", "win32", "linux"]) {
        dlopenCalls.length = 0;
        await afterPack(
          createContext(
            platform,
            platform === "darwin"
              ? "/build/mac"
              : `/build/${platform === "win32" ? "win" : "linux"}`
          )
        );
        // better-sqlite3 ABI probe runs on every platform; win-job-object runs on win32 only.
        const sqliteCalls = dlopenCalls.filter((p) => p.includes("better_sqlite3.node"));
        expect(sqliteCalls.length).toBe(1);
      }
    });
  });

  describe("win-job-object ABI validation", () => {
    it("should pass when dlopen succeeds and assignProcessToHelpJob is exported", async () => {
      mockExistsSync.mockReturnValue(true);
      // beforeEach default already simulates a healthy win-job-object load.

      await afterPack(createContext("win32", "/build/win"));

      expect(consoleSpy).toHaveBeenCalledWith(
        "[afterPack] win-job-object ABI check passed (N-API forward load OK)"
      );
    });

    it("should throw CRITICAL when dlopen fails (missing VCRUNTIME140.dll)", async () => {
      mockExistsSync.mockReturnValue(true);
      process.dlopen = ((_mod: unknown, filename: string) => {
        if (filename.includes("win_job_object")) {
          throw new Error(
            "The specified module could not be found. \\?\\C:\\app\\win_job_object.node"
          );
        }
        throw new Error("NODE_MODULE_VERSION mismatch");
      }) as typeof process.dlopen;

      await expect(afterPack(createContext("win32", "/build/win"))).rejects.toThrow(
        /win-job-object failed to load/
      );
    });

    it("should throw CRITICAL with arch-mismatch hint", async () => {
      mockExistsSync.mockReturnValue(true);
      process.dlopen = ((_mod: unknown, filename: string) => {
        if (filename.includes("win_job_object")) {
          throw new Error("%1 is not a valid Win32 application.");
        }
        throw new Error("NODE_MODULE_VERSION mismatch");
      }) as typeof process.dlopen;

      await expect(afterPack(createContext("win32", "/build/win"))).rejects.toThrow(
        /architecture matches the target/
      );
    });

    it("should throw CRITICAL when dlopen succeeds but export is missing", async () => {
      mockExistsSync.mockReturnValue(true);
      process.dlopen = ((mod: { exports: Record<string, unknown> }, filename: string) => {
        if (filename.includes("win_job_object")) {
          // Loaded but no assignProcessToHelpJob export wired up
          return;
        }
        throw new Error("NODE_MODULE_VERSION mismatch");
      }) as typeof process.dlopen;

      await expect(afterPack(createContext("win32", "/build/win"))).rejects.toThrow(
        /assignProcessToHelpJob export is missing/
      );
    });

    it("should only run on Windows", async () => {
      mockExistsSync.mockReturnValue(true);
      const dlopenCalls: string[] = [];
      process.dlopen = ((mod: { exports: Record<string, unknown> }, filename: string) => {
        dlopenCalls.push(filename);
        if (filename.includes("win_job_object")) {
          mod.exports.assignProcessToHelpJob = () => true;
          return;
        }
        throw new Error("NODE_MODULE_VERSION mismatch");
      }) as typeof process.dlopen;

      await afterPack(createContext("linux", "/build/linux"));
      expect(dlopenCalls.some((p) => p.includes("win_job_object"))).toBe(false);

      dlopenCalls.length = 0;
      await afterPack(createContext("darwin", "/build/mac"));
      expect(dlopenCalls.some((p) => p.includes("win_job_object"))).toBe(false);
    });
  });

  describe("posix-pty-reaper executable check", () => {
    it("should pass when accessSync(X_OK) succeeds", async () => {
      mockExistsSync.mockReturnValue(true);
      // beforeEach default already returns success from accessSync.

      await afterPack(createContext("linux", "/build/linux"));

      expect(mockAccessSync).toHaveBeenCalledWith(
        expect.stringContaining("daintree_pty_supervisor"),
        1 // X_OK from mocked fs.constants
      );
    });

    it("should throw CRITICAL when accessSync throws (binary not executable)", async () => {
      mockExistsSync.mockReturnValue(true);
      mockAccessSync.mockImplementation(() => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      });

      await expect(afterPack(createContext("linux", "/build/linux"))).rejects.toThrow(
        /posix-pty-reaper supervisor exists but is not executable/
      );
    });

    it("should throw CRITICAL on macOS when accessSync fails", async () => {
      mockExistsSync.mockReturnValue(true);
      mockAccessSync.mockImplementation(() => {
        throw new Error("EACCES");
      });

      await expect(afterPack(createContext("darwin", "/build/mac"))).rejects.toThrow(
        /posix-pty-reaper supervisor exists but is not executable/
      );
    });

    it("should not run on Windows", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("win32", "/build/win"));

      // accessSync is only called from the POSIX branch
      expect(mockAccessSync).not.toHaveBeenCalled();
    });
  });

  describe("logging", () => {
    it("should log platform and output directory", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("darwin", "/build/mac"));

      expect(consoleSpy).toHaveBeenCalledWith("[afterPack] Platform: darwin");
      expect(consoleSpy).toHaveBeenCalledWith("[afterPack] Output directory: /build/mac");
    });

    it("should log completion on success", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("darwin", "/build/mac"));

      expect(consoleSpy).toHaveBeenCalledWith("[afterPack] Complete - native modules validated");
    });
  });
});
