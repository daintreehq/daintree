import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn<(path: string) => boolean>(),
}));

const appMock = vi.hoisted(() => ({
  app: {
    isPackaged: false,
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

const originalResourcesPath = process.resourcesPath;

describe("HelpService", () => {
  afterAll(() => {
    Object.defineProperty(process, "resourcesPath", {
      value: originalResourcesPath,
      writable: true,
      configurable: true,
    });
  });

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    appMock.app.isPackaged = false;
    appMock.app.getAppPath.mockReturnValue("/repo");
    Object.defineProperty(process, "resourcesPath", {
      value: "/app/resources",
      writable: true,
      configurable: true,
    });
  });

  it("returns help folder path in dev mode when directory exists", async () => {
    fsMock.existsSync.mockReturnValue(true);

    const { getHelpFolderPath } = await import("../HelpService.js");
    const result = getHelpFolderPath();

    expect(result).toBe(path.join("/repo", "help"));
    expect(fsMock.existsSync).toHaveBeenCalledWith(path.join("/repo", "help"));
  });

  it("returns null with warning in dev mode when directory is missing", async () => {
    fsMock.existsSync.mockReturnValue(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { getHelpFolderPath } = await import("../HelpService.js");
    const result = getHelpFolderPath();

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[HelpService] Help folder not found:")
    );
    warnSpy.mockRestore();
  });

  it("resolves from resourcesPath in packaged mode when directory exists", async () => {
    appMock.app.isPackaged = true;
    fsMock.existsSync.mockReturnValue(true);

    const { getHelpFolderPath } = await import("../HelpService.js");
    const result = getHelpFolderPath();

    expect(result).toBe(path.join("/app/resources", "help"));
    expect(fsMock.existsSync).toHaveBeenCalledWith(path.join("/app/resources", "help"));
  });

  it("returns null in packaged mode when directory is missing", async () => {
    appMock.app.isPackaged = true;
    fsMock.existsSync.mockReturnValue(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { getHelpFolderPath } = await import("../HelpService.js");
    const result = getHelpFolderPath();

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[HelpService] Help folder not found:")
    );
    warnSpy.mockRestore();
  });
});
