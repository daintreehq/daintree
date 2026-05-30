import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import path from "path";
import Module from "module";

const mockExistsSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockCopyFileSync = vi.fn();
const mockSpawnSync = vi.fn();
const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

const originalDlopen = process.dlopen;

afterAll(() => {
  consoleSpy.mockRestore();
  warnSpy.mockRestore();
  process.dlopen = originalDlopen;
});

function createContext(platform: string, appOutDir: string, appName = "Daintree", arch?: number) {
  return {
    appOutDir,
    electronPlatformName: platform,
    arch,
    packager: { appInfo: { productFilename: appName } },
  };
}

describe("afterPack", () => {
  let afterPack: (context: any) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy.mockImplementation(() => {});
    warnSpy.mockImplementation(() => {});

    // Default: posix-pty-reaper supervisor execs cleanly (status 0, no error).
    mockSpawnSync.mockReturnValue({
      status: 0,
      error: null,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    });

    // Default dlopen branches by binary: better-sqlite3 (NAN/V8-raw) throwing an
    // ABI mismatch under Node means the binary is correctly built for Electron,
    // so the better-sqlite3 probe passes. win-job-object (N-API, ABI-stable)
    // must load successfully under Node, so its probe expects no throw.
    process.dlopen = ((_module: unknown, filename: string) => {
      if (filename.includes("win_job_object")) return;
      throw new Error(
        "was compiled against a different Node.js version using NODE_MODULE_VERSION 131"
      );
    }) as typeof process.dlopen;

    const originalRequire = Module.prototype.require;

    Module.prototype.require = function (id: string) {
      if (id === "fs") {
        return {
          existsSync: mockExistsSync,
          readdirSync: mockReaddirSync,
          mkdirSync: mockMkdirSync,
          copyFileSync: mockCopyFileSync,
        };
      }
      if (id === "child_process" || id === "node:child_process") {
        return { spawnSync: mockSpawnSync };
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
        "[afterPack] better-sqlite3 ABI check passed (compiled for Electron, not Node)"
      );
    });

    it("should pass when dlopen throws invalid ELF header", async () => {
      mockExistsSync.mockReturnValue(true);
      process.dlopen = (() => {
        throw new Error("invalid ELF header");
      }) as typeof process.dlopen;

      await afterPack(createContext("linux", "/build/linux"));

      expect(consoleSpy).toHaveBeenCalledWith(
        "[afterPack] better-sqlite3 ABI check passed (compiled for Electron, not Node)"
      );
    });

    it("should pass when dlopen throws not a valid Win32 application", async () => {
      mockExistsSync.mockReturnValue(true);
      // win-job-object (N-API) still loads; only the better-sqlite3 probe sees
      // the cross-arch error that proves it was built for Electron.
      process.dlopen = ((_mod: unknown, filename: string) => {
        if (filename.includes("win_job_object")) return;
        throw new Error("not a valid Win32 application");
      }) as typeof process.dlopen;

      await afterPack(createContext("win32", "/build/win"));

      expect(consoleSpy).toHaveBeenCalledWith(
        "[afterPack] better-sqlite3 ABI check passed (compiled for Electron, not Node)"
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
      // win-job-object loads fine; only the better-sqlite3 probe is inconclusive.
      process.dlopen = ((_mod: unknown, filename: string) => {
        if (filename.includes("win_job_object")) return;
        throw new Error("The specified module could not be found");
      }) as typeof process.dlopen;

      await afterPack(createContext("win32", "/build/win"));

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ABI probe inconclusive"));
    });

    it("should run ABI validation on all platforms", async () => {
      mockExistsSync.mockReturnValue(true);
      const dlopenCalls: string[] = [];
      process.dlopen = ((_mod: any, path: string) => {
        dlopenCalls.push(path);
        if (path.includes("win_job_object")) return; // N-API addon loads under Node
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
        // The better-sqlite3 ABI probe runs on every platform.
        expect(dlopenCalls.some((c) => c.includes("better_sqlite3.node"))).toBe(true);
        // The win-job-object load probe runs only on Windows.
        if (platform === "win32") {
          expect(dlopenCalls.some((c) => c.includes("win_job_object"))).toBe(true);
          expect(dlopenCalls.length).toBe(2);
        } else {
          expect(dlopenCalls.length).toBe(1);
        }
      }
    });
  });

  describe("win-job-object load validation", () => {
    it("should pass on Windows when win_job_object.node dlopens successfully", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("win32", "/build/win"));

      expect(consoleSpy).toHaveBeenCalledWith(
        "[afterPack] win-job-object load check passed (all transitive dependencies resolved)"
      );
    });

    it("should dlopen the exact win_job_object.node path", async () => {
      mockExistsSync.mockReturnValue(true);
      const dlopenCalls: string[] = [];
      process.dlopen = ((_mod: unknown, filename: string) => {
        dlopenCalls.push(filename);
        if (filename.includes("win_job_object")) return;
        throw new Error("NODE_MODULE_VERSION mismatch");
      }) as typeof process.dlopen;

      await afterPack(createContext("win32", "/build/win"));

      expect(dlopenCalls).toContain(
        path.join(
          "/build/win/resources/app.asar.unpacked",
          "node_modules/win-job-object/build/Release/win_job_object.node"
        )
      );
    });

    it("should throw when win_job_object.node fails to load (missing transitive DLL)", async () => {
      mockExistsSync.mockReturnValue(true);
      process.dlopen = ((_mod: unknown, filename: string) => {
        if (filename.includes("win_job_object")) {
          throw new Error("The specified module could not be found");
        }
        throw new Error("NODE_MODULE_VERSION mismatch");
      }) as typeof process.dlopen;

      await expect(afterPack(createContext("win32", "/build/win"))).rejects.toThrow(
        /win-job-object failed to load/
      );
    });

    it("should skip win-job-object dlopen when packaging a different Windows arch", async () => {
      mockExistsSync.mockReturnValue(true);
      const crossArch = process.arch === "arm64" ? 1 : 3;
      const dlopenCalls: string[] = [];
      process.dlopen = ((_mod: unknown, filename: string) => {
        dlopenCalls.push(filename);
        if (filename.includes("win_job_object")) {
          throw new Error("not a valid Win32 application");
        }
        throw new Error("NODE_MODULE_VERSION mismatch");
      }) as typeof process.dlopen;

      await afterPack(createContext("win32", "/build/win", "Daintree", crossArch));

      expect(dlopenCalls.some((c) => c.includes("win_job_object"))).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Skipping win-job-object load check")
      );
    });

    it("should not probe win-job-object on non-Windows platforms", async () => {
      mockExistsSync.mockReturnValue(true);
      const dlopenCalls: string[] = [];
      process.dlopen = ((_mod: unknown, filename: string) => {
        dlopenCalls.push(filename);
        if (filename.includes("win_job_object")) return;
        throw new Error("NODE_MODULE_VERSION mismatch");
      }) as typeof process.dlopen;

      await afterPack(createContext("linux", "/build/linux"));

      expect(dlopenCalls.some((c) => c.includes("win_job_object"))).toBe(false);
    });
  });

  describe("posix-pty-reaper exec validation", () => {
    it("should exec the supervisor with empty stdin on macOS/Linux", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("linux", "/build/linux"));

      expect(mockSpawnSync).toHaveBeenCalledWith(
        path.join(
          "/build/linux/resources/app.asar.unpacked",
          "node_modules/posix-pty-reaper/build/Release/daintree_pty_supervisor"
        ),
        [],
        expect.objectContaining({ input: "", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 })
      );
      expect(consoleSpy).toHaveBeenCalledWith("[afterPack] posix-pty-reaper exec check passed");
    });

    it("should exec the supervisor with the exact macOS supervisor path", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("darwin", "/build/mac"));

      expect(mockSpawnSync).toHaveBeenCalledWith(
        path.join(
          "/build/mac/Daintree.app/Contents/Resources/app.asar.unpacked",
          "node_modules/posix-pty-reaper/build/Release/daintree_pty_supervisor"
        ),
        [],
        expect.objectContaining({ input: "", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 })
      );
    });

    it("should throw when the supervisor fails to exec (spawn error)", async () => {
      mockExistsSync.mockReturnValue(true);
      mockSpawnSync.mockReturnValue({
        status: null,
        error: new Error("spawn ENOENT"),
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
      });

      await expect(afterPack(createContext("darwin", "/build/mac"))).rejects.toThrow(
        /posix-pty-reaper supervisor failed to exec/
      );
    });

    it("should throw when the supervisor exits with a non-zero status", async () => {
      mockExistsSync.mockReturnValue(true);
      mockSpawnSync.mockReturnValue({
        status: 1,
        error: null,
        stdout: Buffer.from(""),
        stderr: Buffer.from("dyld: missing symbol"),
      });

      await expect(afterPack(createContext("linux", "/build/linux"))).rejects.toThrow(
        /posix-pty-reaper supervisor exited with status 1/
      );
    });

    it("should not exec the supervisor on Windows", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("win32", "/build/win"));

      expect(mockSpawnSync).not.toHaveBeenCalled();
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

  describe("VAD native dependencies (#9177)", () => {
    const unpackedBase = "/build/mac/Daintree.app/Contents/Resources/app.asar.unpacked";

    it("verifies onnxruntime-node and avr-vad are unpacked", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("darwin", "/build/mac"));

      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/onnxruntime-node")
      );
      expect(mockExistsSync).toHaveBeenCalledWith(path.join(unpackedBase, "node_modules/avr-vad"));
      expect(consoleSpy).toHaveBeenCalledWith(
        `[afterPack] onnxruntime-node verified: ${path.join(unpackedBase, "node_modules/onnxruntime-node")}`
      );
    });

    it("throws when onnxruntime-node is not unpacked", async () => {
      // Everything present except onnxruntime-node.
      mockExistsSync.mockImplementation(
        (p) => !String(p).endsWith(path.join("node_modules", "onnxruntime-node"))
      );

      await expect(afterPack(createContext("darwin", "/build/mac"))).rejects.toThrow(
        /onnxruntime-node not found/
      );
    });
  });
});
