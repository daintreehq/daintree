import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import path from "path";
import Module from "module";

const mockExistsSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockCopyFileSync = vi.fn();
const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

const originalDlopen = process.dlopen;

afterAll(() => {
  consoleSpy.mockRestore();
  warnSpy.mockRestore();
  process.dlopen = originalDlopen;
});

function createContext(platform: string, appOutDir: string, appName = "Canopy") {
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

    // Default: simulate Electron-ABI binary (correct) — dlopen throws ABI mismatch
    process.dlopen = (() => {
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
    const unpackedBase = "/build/mac/Canopy.app/Contents/Resources/app.asar.unpacked";

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
        .mockReturnValueOnce(false) // Assets.car (macOS icon injection)
        .mockReturnValueOnce(true) // better-sqlite3 dir
        .mockReturnValueOnce(false); // better_sqlite3.node

      await expect(afterPack(createContext("darwin", "/build/mac"))).rejects.toThrow(
        /better-sqlite3 native binary not found/
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
      process.dlopen = (() => {
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
      process.dlopen = (() => {
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
        expect(dlopenCalls.length).toBe(1);
        expect(dlopenCalls[0]).toContain("better_sqlite3.node");
      }
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
