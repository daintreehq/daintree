import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import path from "path";
import Module from "module";

const mockExistsSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockCopyFileSync = vi.fn();
const mockStatSync = vi.fn();
const mockRmSync = vi.fn();
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
          readdirSync: mockReaddirSync,
          mkdirSync: mockMkdirSync,
          copyFileSync: mockCopyFileSync,
          statSync: mockStatSync,
          rmSync: mockRmSync,
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

    it("should succeed when node-pty and native binary exist", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("darwin", "/build/mac"));

      expect(mockExistsSync).toHaveBeenCalledWith(path.join(unpackedBase, "node_modules/node-pty"));
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/node-pty/build/Release/pty.node")
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

    it("should not strip GPU DLLs on macOS", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("darwin", "/build/mac"));

      expect(mockStatSync).not.toHaveBeenCalled();
      expect(mockRmSync).not.toHaveBeenCalled();
    });
  });

  describe("Windows", () => {
    const unpackedBase = "/build/win/resources/app.asar.unpacked";

    it("should succeed with Windows resource path", async () => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockReturnValue({ size: 0 });

      await afterPack(createContext("win32", "/build/win"));

      expect(mockExistsSync).toHaveBeenCalledWith(path.join(unpackedBase, "node_modules/node-pty"));
      // Windows uses ConPTY binaries only (winpty removed in node-pty 1.2.0-beta)
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/node-pty/build/Release/conpty.node")
      );
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/node-pty/build/Release/conpty_console_list.node")
      );
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/node-pty/build/Release/conpty/conpty.dll")
      );
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join(unpackedBase, "node_modules/node-pty/build/Release/conpty/OpenConsole.exe")
      );
    });

    it("should not log signing message on Windows", async () => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockReturnValue({ size: 0 });

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

    it("should throw with compiled binary error when conpty.node is missing", async () => {
      mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);

      await expect(afterPack(createContext("win32", "/build/win"))).rejects.toThrow(
        /Windows node-pty compiled binary not found/
      );
    });

    it("should copy conpty binaries from third_party when missing after rebuild", async () => {
      const nodePtyBase = path.join(unpackedBase, "node_modules/node-pty");
      // node-pty exists, conpty.node exists, conpty_console_list.node exists,
      // conpty/conpty.dll missing (triggers fallback), conpty/OpenConsole.exe missing,
      // third_party exists, source dir exists,
      // then final validation passes
      mockExistsSync
        .mockReturnValueOnce(true) // node-pty dir
        .mockReturnValueOnce(true) // conpty.node
        .mockReturnValueOnce(true) // conpty_console_list.node
        .mockReturnValueOnce(false) // conpty/conpty.dll (missing → triggers fallback)
        .mockReturnValueOnce(true) // third_party/conpty exists
        .mockReturnValueOnce(true) // win10-x64 source dir exists
        .mockReturnValueOnce(true) // final validation: conpty/conpty.dll
        .mockReturnValueOnce(true); // final validation: conpty/OpenConsole.exe
      mockReaddirSync.mockReturnValue(["1.23.251008001"]);
      mockStatSync.mockReturnValue({ size: 0 });

      await afterPack(createContext("win32", "/build/win"));

      expect(mockMkdirSync).toHaveBeenCalledWith(path.join(nodePtyBase, "build/Release/conpty"), {
        recursive: true,
      });
      expect(mockCopyFileSync).toHaveBeenCalledTimes(2);
    });

    describe("GPU DLL stripping", () => {
      const gpuFiles = [
        "vk_swiftshader.dll",
        "vulkan-1.dll",
        "vk_swiftshader_icd.json",
        "d3dcompiler_47.dll",
      ];

      it("should strip all GPU DLLs when present", async () => {
        mockExistsSync.mockReturnValue(true);
        mockStatSync.mockReturnValue({ size: 5_000_000 });

        await afterPack(createContext("win32", "/build/win"));

        for (const file of gpuFiles) {
          expect(mockStatSync).toHaveBeenCalledWith(path.join("/build/win", file));
          expect(mockRmSync).toHaveBeenCalledWith(path.join("/build/win", file));
          expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining(`[afterPack] Stripped ${file}`)
          );
        }
      });

      it("should skip missing GPU DLLs gracefully", async () => {
        mockExistsSync.mockReturnValue(true);
        const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
        enoent.code = "ENOENT";
        mockStatSync.mockImplementation(() => {
          throw enoent;
        });

        await afterPack(createContext("win32", "/build/win"));

        expect(mockRmSync).not.toHaveBeenCalled();
        for (const file of gpuFiles) {
          expect(consoleSpy).toHaveBeenCalledWith(`[afterPack] ${file} not present, skipping`);
        }
      });

      it("should rethrow non-ENOENT errors", async () => {
        mockExistsSync.mockReturnValue(true);
        mockStatSync.mockImplementation(() => {
          throw new Error("EPERM: permission denied");
        });

        await expect(afterPack(createContext("win32", "/build/win"))).rejects.toThrow(
          /EPERM: permission denied/
        );
      });

      it("should log completion message", async () => {
        mockExistsSync.mockReturnValue(true);
        mockStatSync.mockReturnValue({ size: 1_000_000 });

        await afterPack(createContext("win32", "/build/win"));

        expect(consoleSpy).toHaveBeenCalledWith("[afterPack] GPU/Vulkan DLL stripping complete");
      });
    });

    it("should throw when conpty.dll missing and third_party unavailable", async () => {
      // node-pty exists, conpty.node exists, conpty_console_list.node exists,
      // conpty/conpty.dll missing, third_party/conpty missing
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

    it("should not strip GPU DLLs on Linux", async () => {
      mockExistsSync.mockReturnValue(true);

      await afterPack(createContext("linux", "/build/linux"));

      expect(mockStatSync).not.toHaveBeenCalled();
      expect(mockRmSync).not.toHaveBeenCalled();
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
