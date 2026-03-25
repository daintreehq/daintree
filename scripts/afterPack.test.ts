import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import path from "path";
import Module from "module";

const mockExistsSync = vi.fn();
const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

afterAll(() => {
  consoleSpy.mockRestore();
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

    const originalRequire = Module.prototype.require;

    Module.prototype.require = function (id: string) {
      if (id === "fs") {
        return {
          existsSync: mockExistsSync,
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
      // node-pty dir exists, pty.node missing
      mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);

      await expect(afterPack(createContext("darwin", "/build/mac"))).rejects.toThrow(
        /native binary not found/
      );
    });

    it("should throw when better-sqlite3 directory is missing", async () => {
      // node-pty dir exists, pty.node exists, better-sqlite3 dir missing
      mockExistsSync
        .mockReturnValueOnce(true) // node-pty dir
        .mockReturnValueOnce(true) // pty.node
        .mockReturnValueOnce(false); // better-sqlite3 dir

      await expect(afterPack(createContext("darwin", "/build/mac"))).rejects.toThrow(
        /better-sqlite3 not found/
      );
    });

    it("should throw when better_sqlite3.node binary is missing", async () => {
      // node-pty dir exists, pty.node exists, better-sqlite3 dir exists, binary missing
      mockExistsSync
        .mockReturnValueOnce(true) // node-pty dir
        .mockReturnValueOnce(true) // pty.node
        .mockReturnValueOnce(true) // better-sqlite3 dir
        .mockReturnValueOnce(false); // better_sqlite3.node

      await expect(afterPack(createContext("darwin", "/build/mac"))).rejects.toThrow(
        /better-sqlite3 native binary not found/
      );
    });
  });

  describe("Windows", () => {
    const unpackedBase = "/build/win/resources/app.asar.unpacked";

    it("should succeed with Windows prebuild paths", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("win32", "/build/win"));

      expect(mockExistsSync).toHaveBeenCalledWith(path.join(unpackedBase, "node_modules/node-pty"));
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/node-pty/prebuilds/win32-x64/conpty.node")
      );
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(
          unpackedBase,
          "node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node"
        )
      );
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll")
      );
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe")
      );
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/better-sqlite3")
      );
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/better-sqlite3/build/Release/better_sqlite3.node")
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

    it("should throw when prebuild file is missing", async () => {
      mockExistsSync
        .mockReturnValueOnce(true) // node-pty dir
        .mockReturnValueOnce(false); // conpty.node prebuild missing

      await expect(afterPack(createContext("win32", "/build/win"))).rejects.toThrow(
        /Windows node-pty prebuild not found/
      );
    });

    it("should throw when conpty.dll prebuild is missing", async () => {
      mockExistsSync
        .mockReturnValueOnce(true) // node-pty dir
        .mockReturnValueOnce(true) // conpty.node
        .mockReturnValueOnce(true) // conpty_console_list.node
        .mockReturnValueOnce(false); // conpty/conpty.dll missing

      await expect(afterPack(createContext("win32", "/build/win"))).rejects.toThrow(
        /Windows node-pty prebuild not found/
      );
    });

    it("should throw when better-sqlite3 directory is missing on Windows", async () => {
      mockExistsSync
        .mockReturnValueOnce(true) // node-pty dir
        .mockReturnValueOnce(true) // conpty.node
        .mockReturnValueOnce(true) // conpty_console_list.node
        .mockReturnValueOnce(true) // conpty/conpty.dll
        .mockReturnValueOnce(true) // conpty/OpenConsole.exe
        .mockReturnValueOnce(false); // better-sqlite3 dir missing

      await expect(afterPack(createContext("win32", "/build/win"))).rejects.toThrow(
        /better-sqlite3 not found/
      );
    });

    it("should throw when better_sqlite3.node binary is missing on Windows", async () => {
      mockExistsSync
        .mockReturnValueOnce(true) // node-pty dir
        .mockReturnValueOnce(true) // conpty.node
        .mockReturnValueOnce(true) // conpty_console_list.node
        .mockReturnValueOnce(true) // conpty/conpty.dll
        .mockReturnValueOnce(true) // conpty/OpenConsole.exe
        .mockReturnValueOnce(true) // better-sqlite3 dir
        .mockReturnValueOnce(false); // better_sqlite3.node missing

      await expect(afterPack(createContext("win32", "/build/win"))).rejects.toThrow(
        /better-sqlite3 native binary not found/
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

    it("should throw when better-sqlite3 directory is missing on Linux", async () => {
      mockExistsSync
        .mockReturnValueOnce(true) // node-pty dir
        .mockReturnValueOnce(true) // pty.node
        .mockReturnValueOnce(false); // better-sqlite3 dir

      await expect(afterPack(createContext("linux", "/build/linux"))).rejects.toThrow(
        /better-sqlite3 not found/
      );
    });

    it("should throw when better_sqlite3.node binary is missing on Linux", async () => {
      mockExistsSync
        .mockReturnValueOnce(true) // node-pty dir
        .mockReturnValueOnce(true) // pty.node
        .mockReturnValueOnce(true) // better-sqlite3 dir
        .mockReturnValueOnce(false); // better_sqlite3.node

      await expect(afterPack(createContext("linux", "/build/linux"))).rejects.toThrow(
        /better-sqlite3 native binary not found/
      );
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
