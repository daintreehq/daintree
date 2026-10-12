import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  app: { isPackaged: true, getAppPath: () => "/dev/app" },
  nativeImage: { createFromPath: vi.fn() },
}));
vi.mock("electron", () => electron);

const originalPlatform = process.platform;
const resourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, "resourcesPath");

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

async function loadFresh() {
  vi.resetModules();
  return (await import("../linuxWindowIcon.js")).getLinuxWindowIcon;
}

async function loadIconPath() {
  vi.resetModules();
  return (await import("../linuxWindowIcon.js")).getLinuxAppIconPath;
}

beforeEach(() => {
  electron.nativeImage.createFromPath.mockReset();
  Object.defineProperty(process, "resourcesPath", {
    value: "/opt/Daintree/resources",
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  if (resourcesPathDescriptor) {
    Object.defineProperty(process, "resourcesPath", resourcesPathDescriptor);
  } else {
    delete (process as { resourcesPath?: string }).resourcesPath;
  }
  vi.restoreAllMocks();
});

describe("getLinuxWindowIcon", () => {
  it("loads the packaged icon once, scaled to 256px", async () => {
    setPlatform("linux");
    const resized = { isEmpty: () => false };
    const resize = vi.fn(() => resized);
    electron.nativeImage.createFromPath.mockReturnValue({ isEmpty: () => false, resize });
    const getLinuxWindowIcon = await loadFresh();

    expect(getLinuxWindowIcon()).toBe(resized);
    expect(getLinuxWindowIcon()).toBe(resized);
    expect(electron.nativeImage.createFromPath).toHaveBeenCalledTimes(1);
    expect(electron.nativeImage.createFromPath).toHaveBeenCalledWith(
      "/opt/Daintree/resources/icon.png"
    );
    expect(resize).toHaveBeenCalledWith({ width: 256, height: 256, quality: "best" });
  });

  it("leaves the window without an icon when the file is missing or unreadable", async () => {
    setPlatform("linux");
    electron.nativeImage.createFromPath.mockReturnValue({ isEmpty: () => true });
    expect((await loadFresh())()).toBeUndefined();

    electron.nativeImage.createFromPath.mockImplementation(() => {
      throw new Error("boom");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await loadFresh())()).toBeUndefined();
  });

  it("sets nothing on macOS and Windows, which take the icon from the app bundle", async () => {
    for (const platform of ["darwin", "win32"] as const) {
      setPlatform(platform);
      expect((await loadFresh())()).toBeUndefined();
    }
    expect(electron.nativeImage.createFromPath).not.toHaveBeenCalled();
  });
});

describe("getLinuxWindowIconOption", () => {
  async function loadOption() {
    vi.resetModules();
    return (await import("../linuxWindowIcon.js")).getLinuxWindowIconOption;
  }

  // An `icon: undefined` key still reaches Electron's NativeImage converter,
  // which logs a warning for every window on macOS and Windows.
  it("adds no icon key on macOS and Windows", async () => {
    for (const platform of ["darwin", "win32"] as const) {
      setPlatform(platform);
      expect(Object.keys((await loadOption())())).toEqual([]);
    }
  });

  it("adds no icon key when the Linux icon can't be loaded", async () => {
    setPlatform("linux");
    electron.nativeImage.createFromPath.mockReturnValue({ isEmpty: () => true });

    expect(Object.keys((await loadOption())())).toEqual([]);
  });

  it("carries the loaded icon on Linux", async () => {
    setPlatform("linux");
    const resized = { isEmpty: () => false };
    electron.nativeImage.createFromPath.mockReturnValue({
      isEmpty: () => false,
      resize: () => resized,
    });

    expect((await loadOption())()).toEqual({ icon: resized });
  });
});

describe("getLinuxAppIconPath", () => {
  afterEach(() => {
    electron.app.isPackaged = true;
  });

  it("points at the shipped resource when packaged and at the build source in dev", async () => {
    setPlatform("linux");
    expect((await loadIconPath())()).toBe("/opt/Daintree/resources/icon.png");

    electron.app.isPackaged = false;
    expect((await loadIconPath())()).toBe("/dev/app/build/icon.png");
  });

  it("has no path on macOS and Windows", async () => {
    for (const platform of ["darwin", "win32"] as const) {
      setPlatform(platform);
      expect((await loadIconPath())()).toBeUndefined();
    }
  });
});
