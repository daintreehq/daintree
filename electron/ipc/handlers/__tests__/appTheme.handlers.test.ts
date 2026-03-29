import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeThemeMock = vi.hoisted(() => ({
  shouldUseDarkColors: true,
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(),
    getFocusedWindow: vi.fn(),
    getAllWindows: vi.fn(() => []),
  },
  nativeTheme: nativeThemeMock,
}));

const storeState = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
}));

const storeMock = vi.hoisted(() => ({
  get: vi.fn((key: string) => storeState.data[key]),
  set: vi.fn((key: string, value: unknown) => {
    storeState.data[key] = value;
  }),
}));

vi.mock("../../../store.js", () => ({
  store: storeMock,
}));

vi.mock("../../../utils/appThemeImporter.js", () => ({
  parseAppThemeFile: vi.fn(),
}));

vi.mock("../../../../shared/theme/index.js", () => ({
  resolveAppTheme: vi.fn((id: string) => ({
    id,
    tokens: { "surface-canvas": "#1a1a2e" },
  })),
  normalizeAppColorScheme: vi.fn((s: unknown) => s),
}));

vi.mock("../../utils.js", () => ({
  typedSend: vi.fn(),
}));

const fsMock = vi.hoisted(() => ({
  writeFile: vi.fn(() => Promise.resolve()),
}));

vi.mock("node:fs", () => ({
  promises: fsMock,
}));

import { ipcMain, dialog, BrowserWindow } from "electron";
import { CHANNELS } from "../../channels.js";
import { registerAppThemeHandlers } from "../appTheme.js";
import { typedSend } from "../../utils.js";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): Handler {
  const calls = (ipcMain.handle as unknown as { mock: { calls: Array<[string, Handler]> } }).mock
    .calls;
  const found = calls.find((c) => c[0] === channel);
  if (!found) {
    throw new Error(`Missing handler for ${channel}`);
  }
  return found[1];
}

function getNativeThemeHandler(): () => void {
  const calls = nativeThemeMock.on.mock.calls;
  const found = calls.find((c: unknown[]) => c[0] === "updated");
  if (!found) {
    throw new Error("Missing nativeTheme.on('updated') handler");
  }
  return found[1] as () => void;
}

describe("appTheme handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    storeState.data = {};
    nativeThemeMock.shouldUseDarkColors = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers all handlers including new follow-system channels", () => {
    const cleanup = registerAppThemeHandlers();

    const registeredChannels = (
      ipcMain.handle as unknown as { mock: { calls: Array<[string, Handler]> } }
    ).mock.calls.map((c) => c[0]);

    expect(registeredChannels).toContain(CHANNELS.APP_THEME_GET);
    expect(registeredChannels).toContain(CHANNELS.APP_THEME_SET_COLOR_SCHEME);
    expect(registeredChannels).toContain(CHANNELS.APP_THEME_EXPORT);
    expect(registeredChannels).toContain(CHANNELS.APP_THEME_SET_FOLLOW_SYSTEM);
    expect(registeredChannels).toContain(CHANNELS.APP_THEME_SET_PREFERRED_DARK_SCHEME);
    expect(registeredChannels).toContain(CHANNELS.APP_THEME_SET_PREFERRED_LIGHT_SCHEME);
    expect(nativeThemeMock.on).toHaveBeenCalledWith("updated", expect.any(Function));

    cleanup();

    expect(nativeThemeMock.removeListener).toHaveBeenCalledWith("updated", expect.any(Function));
  });

  it("setFollowSystem stores the value", async () => {
    storeState.data.appTheme = { colorSchemeId: "daintree" };
    registerAppThemeHandlers();

    const handler = getHandler(CHANNELS.APP_THEME_SET_FOLLOW_SYSTEM);
    await handler({}, true);

    expect(storeMock.set).toHaveBeenCalledWith(
      "appTheme",
      expect.objectContaining({ followSystem: true, colorSchemeId: "daintree" })
    );
  });

  it("setPreferredDarkScheme stores the scheme id", async () => {
    storeState.data.appTheme = { colorSchemeId: "daintree" };
    registerAppThemeHandlers();

    const handler = getHandler(CHANNELS.APP_THEME_SET_PREFERRED_DARK_SCHEME);
    await handler({}, "custom-dark");

    expect(storeMock.set).toHaveBeenCalledWith(
      "appTheme",
      expect.objectContaining({ preferredDarkSchemeId: "custom-dark" })
    );
  });

  it("setPreferredLightScheme stores the scheme id", async () => {
    storeState.data.appTheme = { colorSchemeId: "bondi" };
    registerAppThemeHandlers();

    const handler = getHandler(CHANNELS.APP_THEME_SET_PREFERRED_LIGHT_SCHEME);
    await handler({}, "custom-light");

    expect(storeMock.set).toHaveBeenCalledWith(
      "appTheme",
      expect.objectContaining({ preferredLightSchemeId: "custom-light" })
    );
  });

  it("nativeTheme updated does nothing when followSystem is false", () => {
    storeState.data.appTheme = { colorSchemeId: "daintree", followSystem: false };
    registerAppThemeHandlers();

    const themeHandler = getNativeThemeHandler();
    themeHandler();
    vi.advanceTimersByTime(300);

    expect(typedSend).not.toHaveBeenCalled();
  });

  it("nativeTheme updated sends push event when followSystem is true", () => {
    const mockWindow = {
      isDestroyed: () => false,
      setBackgroundColor: vi.fn(),
    };
    storeState.data.appTheme = { colorSchemeId: "daintree", followSystem: true };
    nativeThemeMock.shouldUseDarkColors = false;

    registerAppThemeHandlers(mockWindow as never);

    const themeHandler = getNativeThemeHandler();
    themeHandler();
    vi.advanceTimersByTime(300);

    expect(typedSend).toHaveBeenCalledWith(mockWindow, "app-theme:system-appearance-changed", {
      isDark: false,
      schemeId: "bondi",
    });
  });

  it("nativeTheme updated uses preferred scheme ids when set", () => {
    const mockWindow = {
      isDestroyed: () => false,
      setBackgroundColor: vi.fn(),
    };
    storeState.data.appTheme = {
      colorSchemeId: "daintree",
      followSystem: true,
      preferredDarkSchemeId: "custom-dark",
      preferredLightSchemeId: "custom-light",
    };
    nativeThemeMock.shouldUseDarkColors = true;

    registerAppThemeHandlers(mockWindow as never);

    const themeHandler = getNativeThemeHandler();
    themeHandler();
    vi.advanceTimersByTime(300);

    expect(typedSend).toHaveBeenCalledWith(mockWindow, "app-theme:system-appearance-changed", {
      isDark: true,
      schemeId: "custom-dark",
    });
  });

  it("debounces rapid nativeTheme updates to a single push", () => {
    const mockWindow = {
      isDestroyed: () => false,
      setBackgroundColor: vi.fn(),
    };
    storeState.data.appTheme = { colorSchemeId: "daintree", followSystem: true };

    registerAppThemeHandlers(mockWindow as never);

    const themeHandler = getNativeThemeHandler();
    themeHandler();
    vi.advanceTimersByTime(100);
    themeHandler();
    vi.advanceTimersByTime(100);
    themeHandler();
    vi.advanceTimersByTime(300);

    expect(typedSend).toHaveBeenCalledTimes(1);
  });

  it("cleanup cancels pending timer and removes listener", () => {
    const mockWindow = {
      isDestroyed: () => false,
      setBackgroundColor: vi.fn(),
    };
    storeState.data.appTheme = { colorSchemeId: "daintree", followSystem: true };

    const cleanup = registerAppThemeHandlers(mockWindow as never);

    const themeHandler = getNativeThemeHandler();
    themeHandler();
    // Don't advance timers — cleanup before the 300ms fires
    cleanup();
    vi.advanceTimersByTime(300);

    expect(typedSend).not.toHaveBeenCalled();
    expect(nativeThemeMock.removeListener).toHaveBeenCalledWith("updated", themeHandler);
  });

  it("nativeTheme updated updates BrowserWindow background color", () => {
    const mockWindow = {
      isDestroyed: () => false,
      setBackgroundColor: vi.fn(),
    };
    storeState.data.appTheme = { colorSchemeId: "daintree", followSystem: true };
    nativeThemeMock.shouldUseDarkColors = true;

    registerAppThemeHandlers(mockWindow as never);

    const themeHandler = getNativeThemeHandler();
    themeHandler();
    vi.advanceTimersByTime(300);

    expect(mockWindow.setBackgroundColor).toHaveBeenCalledWith("#1a1a2e");
  });

  it("nativeTheme updated does not send when window is destroyed", () => {
    const mockWindow = {
      isDestroyed: () => true,
      setBackgroundColor: vi.fn(),
    };
    storeState.data.appTheme = { colorSchemeId: "daintree", followSystem: true };

    registerAppThemeHandlers(mockWindow as never);

    const themeHandler = getNativeThemeHandler();
    themeHandler();
    vi.advanceTimersByTime(300);

    expect(typedSend).not.toHaveBeenCalled();
    expect(mockWindow.setBackgroundColor).not.toHaveBeenCalled();
  });

  it("nativeTheme updated persists new colorSchemeId to store", () => {
    const mockWindow = {
      isDestroyed: () => false,
      setBackgroundColor: vi.fn(),
    };
    storeState.data.appTheme = { colorSchemeId: "daintree", followSystem: true };
    nativeThemeMock.shouldUseDarkColors = false;

    registerAppThemeHandlers(mockWindow as never);

    const themeHandler = getNativeThemeHandler();
    themeHandler();
    vi.advanceTimersByTime(300);

    expect(storeMock.set).toHaveBeenCalledWith(
      "appTheme",
      expect.objectContaining({ colorSchemeId: "bondi" })
    );
  });

  describe("exportTheme", () => {
    const validScheme = {
      id: "test-theme",
      name: "Test Theme",
      type: "dark" as const,
      builtin: false,
      tokens: { "surface-canvas": "#1a1a2e" } as never,
      location: "/some/path",
    };

    const mockEvent = {
      sender: { id: 1 },
    };

    beforeEach(() => {
      (BrowserWindow.fromWebContents as ReturnType<typeof vi.fn>).mockReturnValue({});
    });

    it("saves theme to chosen file path", async () => {
      (dialog.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValue({
        canceled: false,
        filePath: "/tmp/Test Theme.json",
      });

      registerAppThemeHandlers();
      const handler = getHandler(CHANNELS.APP_THEME_EXPORT);
      const result = await handler(mockEvent, validScheme);

      expect(result).toBe(true);
      expect(fsMock.writeFile).toHaveBeenCalledWith(
        "/tmp/Test Theme.json",
        expect.any(String),
        "utf-8"
      );

      const written = JSON.parse(fsMock.writeFile.mock.calls[0][1] as string);
      expect(written.id).toBe("test-theme");
      expect(written.name).toBe("Test Theme");
      expect(written).not.toHaveProperty("location");
      expect(written).not.toHaveProperty("builtin");
    });

    it("returns false when dialog is cancelled", async () => {
      (dialog.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValue({
        canceled: true,
        filePath: "",
      });

      registerAppThemeHandlers();
      const handler = getHandler(CHANNELS.APP_THEME_EXPORT);
      const result = await handler(mockEvent, validScheme);

      expect(result).toBe(false);
      expect(fsMock.writeFile).not.toHaveBeenCalled();
    });

    it("returns false for invalid scheme", async () => {
      registerAppThemeHandlers();
      const handler = getHandler(CHANNELS.APP_THEME_EXPORT);

      expect(await handler(mockEvent, null)).toBe(false);
      expect(await handler(mockEvent, { id: 123 })).toBe(false);
      expect(await handler(mockEvent, { id: "x" })).toBe(false);
      expect(fsMock.writeFile).not.toHaveBeenCalled();
    });

    it("sanitizes filename from theme name", async () => {
      (dialog.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValue({
        canceled: false,
        filePath: "/tmp/safe.json",
      });

      const schemeWithBadName = {
        ...validScheme,
        name: 'My "Cool" Theme: v2',
      };

      registerAppThemeHandlers();
      const handler = getHandler(CHANNELS.APP_THEME_EXPORT);
      await handler(mockEvent, schemeWithBadName);

      expect(dialog.showSaveDialog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          defaultPath: "My Cool Theme v2.json",
        })
      );
    });
  });
});
