import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn<(path: string) => boolean>(),
  lstatSync: vi.fn<(path: string) => { isSymbolicLink: () => boolean }>(),
  realpathSync: vi.fn<(path: string) => string>(),
  readFileSync: vi.fn<(path: string, encoding: string) => string>(),
  symlinkSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

const appMock = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getVersion: vi.fn(() => "1.2.3"),
    getAppPath: vi.fn(() => "/repo"),
  },
}));

vi.mock("fs", () => ({
  default: fsMock,
  ...fsMock,
}));

vi.mock("electron", () => ({
  ...appMock,
}));

vi.mock("os", () => ({
  default: {
    homedir: () => "/home/test",
  },
  homedir: () => "/home/test",
}));

const originalPlatform = process.platform;

// Use path.join so the separator matches what CliInstallService produces at runtime
const SOURCE_SCRIPT = path.join("/repo", "scripts", "daintree-cli.sh");

describe("CliInstallService", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    appMock.app.isPackaged = false;
    appMock.app.getAppPath.mockReturnValue("/repo");
    fsMock.lstatSync.mockImplementation(() => ({ isSymbolicLink: () => false }));
    fsMock.realpathSync.mockImplementation((target) => target);
    Object.defineProperty(process, "platform", {
      value: "darwin",
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  it("installs by creating a symlink from app.getAppPath() in development mode", async () => {
    fsMock.existsSync.mockImplementation(
      (target) => target === SOURCE_SCRIPT || target === "/usr/local/bin"
    );

    const { install } = await import("../CliInstallService.js");
    const result = await install();

    expect(appMock.app.getAppPath).toHaveBeenCalled();
    expect(fsMock.existsSync).toHaveBeenCalledWith(SOURCE_SCRIPT);
    expect(fsMock.symlinkSync).toHaveBeenCalledWith(SOURCE_SCRIPT, "/usr/local/bin/daintree");
    expect(result).toEqual({
      installed: true,
      upToDate: true,
      path: "/usr/local/bin/daintree",
    });
  });

  it("falls back to ~/.local/bin when /usr/local/bin is not writable", async () => {
    fsMock.existsSync.mockImplementation(
      (target) => target === SOURCE_SCRIPT || target === "/usr/local/bin"
    );
    fsMock.symlinkSync.mockImplementation((_sourcePath, targetPath) => {
      if (targetPath === "/usr/local/bin/daintree") {
        throw new Error("EACCES");
      }
    });

    const { install } = await import("../CliInstallService.js");
    const result = await install();

    expect(fsMock.mkdirSync).toHaveBeenCalledWith("/home/test/.local/bin", { recursive: true });
    expect(fsMock.symlinkSync).toHaveBeenCalledWith(
      SOURCE_SCRIPT,
      "/home/test/.local/bin/daintree"
    );
    expect(result.path).toBe("/home/test/.local/bin/daintree");
  });

  it("reports up-to-date status when installed symlink matches source", async () => {
    fsMock.existsSync.mockImplementation((target) => target === "/usr/local/bin/daintree");
    fsMock.lstatSync.mockImplementation((targetPath) => ({
      isSymbolicLink: () => targetPath === "/usr/local/bin/daintree",
    }));
    fsMock.realpathSync.mockImplementation((targetPath) => {
      if (targetPath === "/usr/local/bin/daintree") return SOURCE_SCRIPT;
      return targetPath;
    });

    const { getStatus } = await import("../CliInstallService.js");
    const status = getStatus();

    expect(status).toEqual({
      installed: true,
      upToDate: true,
      path: "/usr/local/bin/daintree",
    });
  });

  it("reports outdated status for legacy copied installs that differ from source", async () => {
    fsMock.existsSync.mockImplementation((target) => target === "/usr/local/bin/daintree");
    fsMock.readFileSync.mockImplementation((targetPath) => {
      if (targetPath === SOURCE_SCRIPT) return "new script";
      if (targetPath === "/usr/local/bin/daintree") return "old script";
      throw new Error("ENOENT");
    });

    const { getStatus } = await import("../CliInstallService.js");
    const status = getStatus();

    expect(status).toEqual({
      installed: true,
      upToDate: false,
      path: "/usr/local/bin/daintree",
    });
  });

  describe("AppImage mode (Linux)", () => {
    const APPIMAGE_PATH = "/home/test/Daintree-x86_64.AppImage";
    const WRAPPER_DIR = path.join("/home/test", ".local", "share", "daintree");
    const WRAPPER_PATH = path.join(WRAPPER_DIR, "daintree-cli.sh");

    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: "linux", writable: true });
      process.env.APPIMAGE = APPIMAGE_PATH;
      appMock.app.isPackaged = true;
      fsMock.symlinkSync.mockReset();
    });

    afterEach(() => {
      delete process.env.APPIMAGE;
      delete process.env.XDG_DATA_HOME;
    });

    it("generates a stable wrapper and symlinks to it instead of the FUSE mount path", async () => {
      fsMock.existsSync.mockImplementation(
        (target) => target === WRAPPER_PATH || target === "/usr/local/bin"
      );

      const { install } = await import("../CliInstallService.js");
      const result = await install();

      expect(fsMock.mkdirSync).toHaveBeenCalledWith(WRAPPER_DIR, { recursive: true });
      expect(fsMock.writeFileSync).toHaveBeenCalledWith(
        WRAPPER_PATH,
        expect.stringContaining(APPIMAGE_PATH),
        { mode: 0o755 }
      );
      expect(fsMock.symlinkSync).toHaveBeenCalledWith(WRAPPER_PATH, "/usr/local/bin/daintree");
      expect(result).toEqual({
        installed: true,
        upToDate: true,
        path: "/usr/local/bin/daintree",
      });
    });

    it("shell-escapes AppImage paths containing single quotes", async () => {
      process.env.APPIMAGE = "/home/test/it's a Daintree.AppImage";
      fsMock.existsSync.mockImplementation(
        (target) => target === WRAPPER_PATH || target === "/usr/local/bin"
      );

      const { install } = await import("../CliInstallService.js");
      await install();

      const writeCall = fsMock.writeFileSync.mock.calls.find((call) => call[0] === WRAPPER_PATH);
      expect(writeCall).toBeDefined();
      const content = writeCall![1] as string;
      expect(content).toContain("it'\\''s a Daintree");
    });

    it("respects XDG_DATA_HOME override", async () => {
      process.env.XDG_DATA_HOME = "/custom/data";
      const customWrapperDir = path.join("/custom/data", "daintree");
      const customWrapperPath = path.join(customWrapperDir, "daintree-cli.sh");

      fsMock.existsSync.mockImplementation(
        (target) => target === customWrapperPath || target === "/usr/local/bin"
      );

      const { install } = await import("../CliInstallService.js");
      await install();

      expect(fsMock.mkdirSync).toHaveBeenCalledWith(customWrapperDir, { recursive: true });
      expect(fsMock.writeFileSync).toHaveBeenCalledWith(
        customWrapperPath,
        expect.stringContaining(APPIMAGE_PATH),
        { mode: 0o755 }
      );
    });

    it("reports up-to-date when symlink points to stable wrapper path", async () => {
      fsMock.existsSync.mockImplementation((target) => target === "/usr/local/bin/daintree");
      fsMock.lstatSync.mockImplementation((targetPath) => ({
        isSymbolicLink: () => targetPath === "/usr/local/bin/daintree",
      }));
      fsMock.realpathSync.mockImplementation((targetPath) => {
        if (targetPath === "/usr/local/bin/daintree") return WRAPPER_PATH;
        return targetPath;
      });

      const { getStatus } = await import("../CliInstallService.js");
      const status = getStatus();

      expect(status).toEqual({
        installed: true,
        upToDate: true,
        path: "/usr/local/bin/daintree",
      });
    });

    it("does not use AppImage path when APPIMAGE env is not set (deb regression guard)", async () => {
      delete process.env.APPIMAGE;

      const PACKAGED_SOURCE = path.join("/mock-resources", "daintree-cli.sh");
      Object.defineProperty(process, "resourcesPath", {
        value: "/mock-resources",
        writable: true,
        configurable: true,
      });
      fsMock.existsSync.mockImplementation(
        (target) => target === PACKAGED_SOURCE || target === "/usr/local/bin"
      );

      const { install } = await import("../CliInstallService.js");
      const result = await install();

      expect(fsMock.symlinkSync).toHaveBeenCalledWith(PACKAGED_SOURCE, "/usr/local/bin/daintree");
      expect(result.path).toBe("/usr/local/bin/daintree");
    });

    it("wrapper content includes --cli-path argument forwarding", async () => {
      fsMock.existsSync.mockImplementation(
        (target) => target === WRAPPER_PATH || target === "/usr/local/bin"
      );

      const { install } = await import("../CliInstallService.js");
      await install();

      const writeCall = fsMock.writeFileSync.mock.calls.find((call) => call[0] === WRAPPER_PATH);
      const content = writeCall![1] as string;
      expect(content).toContain("#!/usr/bin/env bash");
      expect(content).toContain("--cli-path");
      expect(content).toContain("set -euo pipefail");
    });
  });
});
