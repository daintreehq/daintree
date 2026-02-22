import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import Module from "module";

const mockFlipFuses = vi.fn();
const mockExistsSync = vi.fn();

const originalRequire = Module.prototype.require;

describe("afterPack", () => {
  let afterPack: (context: any) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFlipFuses.mockResolvedValue(undefined);

    Module.prototype.require = function (id: string) {
      if (id === "@electron/fuses") {
        return {
          flipFuses: mockFlipFuses,
          FuseVersion: { V1: "V1" },
          FuseV1Options: {
            RunAsNode: "RunAsNode",
            EnableCookieEncryption: "EnableCookieEncryption",
            EnableNodeOptionsEnvironmentVariable: "EnableNodeOptionsEnvironmentVariable",
            EnableNodeCliInspectArguments: "EnableNodeCliInspectArguments",
            EnableEmbeddedAsarIntegrityValidation: "EnableEmbeddedAsarIntegrityValidation",
            OnlyLoadAppFromAsar: "OnlyLoadAppFromAsar",
            LoadBrowserProcessSpecificV8Snapshot: "LoadBrowserProcessSpecificV8Snapshot",
            GrantFileProtocolExtraPrivileges: "GrantFileProtocolExtraPrivileges",
          },
        };
      }
      if (id === "fs") {
        return {
          existsSync: mockExistsSync,
        };
      }
      return originalRequire.apply(this, [id]);
    };

    delete require.cache[require.resolve("./afterPack.cjs")];
    const module = require("./afterPack.cjs");
    afterPack = module.default;

    Module.prototype.require = originalRequire;
  });

  describe("macOS", () => {
    it("should validate node-pty and flip fuses successfully", async () => {
      mockExistsSync.mockReturnValue(true);

      const context = {
        appOutDir: "/build/mac",
        electronPlatformName: "darwin",
        packager: {
          appInfo: {
            productFilename: "Canopy",
          },
          executableName: "canopy-app",
        },
      };

      await afterPack(context);

      const expectedNodePtyPath = path.join(
        "/build/mac/Canopy.app/Contents/Resources/app.asar.unpacked",
        "node_modules/node-pty"
      );
      expect(mockExistsSync).toHaveBeenCalledWith(expectedNodePtyPath);

      const expectedBinaryPath = path.join(
        "/build/mac/Canopy.app/Contents/Resources/app.asar.unpacked",
        "node_modules/node-pty/build/Release/pty.node"
      );
      expect(mockExistsSync).toHaveBeenCalledWith(expectedBinaryPath);

      const expectedElectronPath = "/build/mac/Canopy.app/Contents/MacOS/Canopy";
      expect(mockFlipFuses).toHaveBeenCalledWith(expectedElectronPath, {
        version: "V1",
        strictlyRequireAllFuses: true,
        resetAdHocDarwinSignature: true,
        RunAsNode: false,
        EnableCookieEncryption: true,
        EnableNodeOptionsEnvironmentVariable: false,
        EnableNodeCliInspectArguments: false,
        EnableEmbeddedAsarIntegrityValidation: true,
        OnlyLoadAppFromAsar: true,
        LoadBrowserProcessSpecificV8Snapshot: true,
        GrantFileProtocolExtraPrivileges: false,
      });
    });

    it("should throw error when node-pty is missing", async () => {
      mockExistsSync.mockReturnValue(false);

      const context = {
        appOutDir: "/build/mac",
        electronPlatformName: "darwin",
        packager: {
          appInfo: {
            productFilename: "Canopy",
          },
          executableName: "canopy-app",
        },
      };

      await expect(afterPack(context)).rejects.toThrow(/node-pty not found/);
      expect(mockFlipFuses).not.toHaveBeenCalled();
    });

    it("should throw error when node-pty native binary is missing", async () => {
      mockExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);

      const context = {
        appOutDir: "/build/mac",
        electronPlatformName: "darwin",
        packager: {
          appInfo: {
            productFilename: "Canopy",
          },
          executableName: "canopy-app",
        },
      };

      await expect(afterPack(context)).rejects.toThrow(/native binary not found/);
      expect(mockFlipFuses).not.toHaveBeenCalled();
    });
  });

  describe("Windows", () => {
    it("should validate node-pty and flip fuses successfully", async () => {
      mockExistsSync.mockReturnValue(true);

      const context = {
        appOutDir: "/build/win",
        electronPlatformName: "win32",
        packager: {
          appInfo: {
            productFilename: "Canopy",
          },
          executableName: "canopy-app",
        },
      };

      await afterPack(context);

      const expectedElectronPath = "/build/win/Canopy.exe";
      expect(mockFlipFuses).toHaveBeenCalledWith(
        expectedElectronPath,
        expect.objectContaining({
          version: "V1",
          strictlyRequireAllFuses: true,
          resetAdHocDarwinSignature: false,
        })
      );
    });
  });

  describe("Linux", () => {
    it("should validate node-pty and flip fuses successfully", async () => {
      mockExistsSync.mockReturnValue(true);

      const context = {
        appOutDir: "/build/linux",
        electronPlatformName: "linux",
        packager: {
          appInfo: {
            productFilename: "Canopy",
          },
          executableName: "canopy-app",
        },
      };

      await afterPack(context);

      const expectedElectronPath = "/build/linux/canopy-app";
      expect(mockFlipFuses).toHaveBeenCalledWith(
        expectedElectronPath,
        expect.objectContaining({
          version: "V1",
          strictlyRequireAllFuses: true,
          resetAdHocDarwinSignature: false,
        })
      );
    });
  });

  describe("Fuse configuration", () => {
    it("should configure all security fuses correctly", async () => {
      mockExistsSync.mockReturnValue(true);

      const context = {
        appOutDir: "/build/mac",
        electronPlatformName: "darwin",
        packager: {
          appInfo: {
            productFilename: "Canopy",
          },
          executableName: "canopy-app",
        },
      };

      await afterPack(context);

      const fuseConfig = mockFlipFuses.mock.calls[0][1];

      expect(fuseConfig.RunAsNode).toBe(false);
      expect(fuseConfig.EnableCookieEncryption).toBe(true);
      expect(fuseConfig.EnableNodeOptionsEnvironmentVariable).toBe(false);
      expect(fuseConfig.EnableNodeCliInspectArguments).toBe(false);
      expect(fuseConfig.EnableEmbeddedAsarIntegrityValidation).toBe(true);
      expect(fuseConfig.OnlyLoadAppFromAsar).toBe(true);
      expect(fuseConfig.LoadBrowserProcessSpecificV8Snapshot).toBe(true);
      expect(fuseConfig.GrantFileProtocolExtraPrivileges).toBe(false);
    });
  });

  describe("Error handling", () => {
    it("should throw error for unsupported platforms", async () => {
      mockExistsSync.mockReturnValue(true);

      const context = {
        appOutDir: "/build/freebsd",
        electronPlatformName: "freebsd",
        packager: {
          appInfo: {
            productFilename: "Canopy",
          },
          executableName: "canopy-app",
        },
      };

      await expect(afterPack(context)).rejects.toThrow(/Unsupported platform: freebsd/);
      expect(mockFlipFuses).not.toHaveBeenCalled();
    });

    it("should throw error when Electron binary is missing", async () => {
      mockExistsSync
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      const context = {
        appOutDir: "/build/mac",
        electronPlatformName: "darwin",
        packager: {
          appInfo: {
            productFilename: "Canopy",
          },
          executableName: "canopy-app",
        },
      };

      await expect(afterPack(context)).rejects.toThrow(/Electron binary not found/);
      expect(mockFlipFuses).not.toHaveBeenCalled();
    });
  });
});
