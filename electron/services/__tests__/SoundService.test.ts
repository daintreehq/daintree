import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn<(path: string) => boolean>(),
  readdirSync: vi.fn<(path: string) => string[]>(),
}));

const playSoundMock = vi.hoisted(() => ({
  playSound: vi.fn(() => ({ cancel: vi.fn() })),
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

vi.mock("../../utils/soundPlayer.js", () => ({
  ...playSoundMock,
}));

const originalResourcesPath = process.resourcesPath;

describe("SoundService", () => {
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

  it("resolves sounds directory from app path in dev mode", async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockReturnValue([]);

    const { soundService } = await import("../SoundService.js");
    soundService.play("chime");

    expect(fsMock.existsSync).toHaveBeenCalledWith(
      path.join("/repo", "electron", "resources", "sounds", "chime.wav")
    );
  });

  it("resolves sounds directory from resourcesPath in packaged mode", async () => {
    appMock.app.isPackaged = true;
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockReturnValue([]);

    const { soundService } = await import("../SoundService.js");
    soundService.play("chime");

    expect(fsMock.existsSync).toHaveBeenCalledWith(
      path.join("/app/resources", "sounds", "chime.wav")
    );
  });

  it("calls playSound with the correct path when file exists", async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockReturnValue([]);

    const { soundService } = await import("../SoundService.js");
    soundService.play("error");

    expect(playSoundMock.playSound).toHaveBeenCalledWith(
      path.join("/repo", "electron", "resources", "sounds", "error.wav")
    );
  });

  it("does not call playSound when file does not exist", async () => {
    fsMock.existsSync.mockReturnValue(false);
    fsMock.readdirSync.mockReturnValue([]);

    const { soundService } = await import("../SoundService.js");
    soundService.play("chime");

    expect(playSoundMock.playSound).not.toHaveBeenCalled();
  });

  it("discovers and uses variants from the sounds directory", async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockReturnValue(["chime.v1.wav", "chime.v2.wav", "other.wav"]);

    const { soundService } = await import("../SoundService.js");
    const variants = soundService.getVariants("chime.wav");

    expect(variants).toEqual(["chime.v1.wav", "chime.v2.wav", "chime.wav"]);
  });

  it("reads variants from the correct directory in packaged mode", async () => {
    appMock.app.isPackaged = true;
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockReturnValue([]);

    const { soundService } = await import("../SoundService.js");
    soundService.getVariants("chime.wav");

    expect(fsMock.readdirSync).toHaveBeenCalledWith(path.join("/app/resources", "sounds"));
  });

  it("cancel is a no-op when no sound is playing", async () => {
    const { soundService } = await import("../SoundService.js");
    expect(() => soundService.cancel()).not.toThrow();
  });

  it("preview plays the base file without variant selection", async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readdirSync.mockReturnValue(["chime.v1.wav", "chime.v2.wav"]);

    const { soundService } = await import("../SoundService.js");
    soundService.preview("chime");

    expect(playSoundMock.playSound).toHaveBeenCalledWith(
      path.join("/repo", "electron", "resources", "sounds", "chime.wav")
    );
  });
});
