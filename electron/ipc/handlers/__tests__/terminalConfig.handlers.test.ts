import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

const storeState = vi.hoisted(() => ({
  data: {
    terminalConfig: {
      scrollbackLines: 1000,
      performanceMode: false,
      fontSize: 12,
      fontFamily: "JetBrains Mono",
      hybridInputEnabled: true,
      hybridInputAutoFocus: false,
    },
  } as Record<string, unknown>,
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

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import { registerTerminalConfigHandlers } from "../terminalConfig.js";

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

describe("terminalConfig handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.data = {
      terminalConfig: {
        scrollbackLines: 1000,
        performanceMode: false,
        fontSize: 12,
        fontFamily: "JetBrains Mono",
        hybridInputEnabled: true,
        hybridInputAutoFocus: false,
        screenReaderMode: "auto",
      },
    };
  });

  it("registers all handlers and cleanup removes them", () => {
    const cleanup = registerTerminalConfigHandlers();

    const registeredChannels = (
      ipcMain.handle as unknown as { mock: { calls: Array<[string, Handler]> } }
    ).mock.calls.map((c) => c[0]);
    expect(registeredChannels).toContain(CHANNELS.TERMINAL_CONFIG_GET);
    expect(registeredChannels).toContain(CHANNELS.TERMINAL_CONFIG_SET_SCROLLBACK);
    expect(registeredChannels).toContain(CHANNELS.TERMINAL_CONFIG_SET_PERFORMANCE_MODE);
    expect(registeredChannels).toContain(CHANNELS.TERMINAL_CONFIG_SET_FONT_SIZE);
    expect(registeredChannels).toContain(CHANNELS.TERMINAL_CONFIG_SET_FONT_FAMILY);
    expect(registeredChannels).toContain(CHANNELS.TERMINAL_CONFIG_SET_HYBRID_INPUT_ENABLED);
    expect(registeredChannels).toContain(CHANNELS.TERMINAL_CONFIG_SET_HYBRID_INPUT_AUTO_FOCUS);
    expect(registeredChannels).toContain(CHANNELS.TERMINAL_CONFIG_SET_SCREEN_READER_MODE);
    expect(registeredChannels).toContain(CHANNELS.TERMINAL_CONFIG_SET_CACHED_PROJECT_VIEWS);

    cleanup();
    const removedChannels = (
      ipcMain.removeHandler as unknown as { mock: { calls: Array<[string]> } }
    ).mock.calls.map((c) => c[0]);
    expect(removedChannels).toEqual(expect.arrayContaining(registeredChannels));
  });

  it("get returns current terminal config", async () => {
    registerTerminalConfigHandlers();
    const handler = getHandler(CHANNELS.TERMINAL_CONFIG_GET);

    await expect(handler({}, undefined)).resolves.toEqual(storeState.data.terminalConfig);
  });

  it("setScrollback accepts valid finite integer in range", async () => {
    registerTerminalConfigHandlers();
    const handler = getHandler(CHANNELS.TERMINAL_CONFIG_SET_SCROLLBACK);

    await handler({}, 5000);

    expect(storeState.data.terminalConfig).toMatchObject({ scrollbackLines: 5000 });
  });

  it("setScrollback rejects invalid values", async () => {
    registerTerminalConfigHandlers();
    const handler = getHandler(CHANNELS.TERMINAL_CONFIG_SET_SCROLLBACK);

    await expect(handler({}, 99)).rejects.toThrow("Invalid scrollback value");
    await expect(handler({}, 10001)).rejects.toThrow("Invalid scrollback value");
    await expect(handler({}, 1.2)).rejects.toThrow("Invalid scrollback value");
    await expect(handler({}, Number.NaN)).rejects.toThrow("Invalid scrollback value");
  });

  it("ignores non-boolean performance mode values", async () => {
    registerTerminalConfigHandlers();
    const handler = getHandler(CHANNELS.TERMINAL_CONFIG_SET_PERFORMANCE_MODE);

    await handler({}, "false");
    expect(storeState.data.terminalConfig).toMatchObject({ performanceMode: false });

    await handler({}, true);
    expect(storeState.data.terminalConfig).toMatchObject({ performanceMode: true });
  });

  it("ignores invalid font size and accepts valid range", async () => {
    registerTerminalConfigHandlers();
    const handler = getHandler(CHANNELS.TERMINAL_CONFIG_SET_FONT_SIZE);

    await handler({}, 7);
    expect(storeState.data.terminalConfig).toMatchObject({ fontSize: 12 });

    await handler({}, 14);
    expect(storeState.data.terminalConfig).toMatchObject({ fontSize: 14 });
  });

  it("trims font family and ignores empty/non-string values", async () => {
    registerTerminalConfigHandlers();
    const handler = getHandler(CHANNELS.TERMINAL_CONFIG_SET_FONT_FAMILY);

    await handler({}, "   ");
    expect(storeState.data.terminalConfig).toMatchObject({ fontFamily: "JetBrains Mono" });

    await handler({}, "  Fira Code  ");
    expect(storeState.data.terminalConfig).toMatchObject({ fontFamily: "Fira Code" });
  });

  it("ignores non-boolean hybrid input toggles", async () => {
    registerTerminalConfigHandlers();
    const enabledHandler = getHandler(CHANNELS.TERMINAL_CONFIG_SET_HYBRID_INPUT_ENABLED);
    const autofocusHandler = getHandler(CHANNELS.TERMINAL_CONFIG_SET_HYBRID_INPUT_AUTO_FOCUS);

    await enabledHandler({}, 1);
    await autofocusHandler({}, "true");
    expect(storeState.data.terminalConfig).toMatchObject({
      hybridInputEnabled: true,
      hybridInputAutoFocus: false,
    });

    await enabledHandler({}, false);
    await autofocusHandler({}, true);
    expect(storeState.data.terminalConfig).toMatchObject({
      hybridInputEnabled: false,
      hybridInputAutoFocus: true,
    });
  });

  it("setScreenReaderMode accepts valid values and rejects invalid", async () => {
    registerTerminalConfigHandlers();
    const handler = getHandler(CHANNELS.TERMINAL_CONFIG_SET_SCREEN_READER_MODE);

    await handler({}, "on");
    expect(storeState.data.terminalConfig).toMatchObject({ screenReaderMode: "on" });

    await handler({}, "off");
    expect(storeState.data.terminalConfig).toMatchObject({ screenReaderMode: "off" });

    await handler({}, "auto");
    expect(storeState.data.terminalConfig).toMatchObject({ screenReaderMode: "auto" });

    // Invalid values should be ignored
    await handler({}, "invalid");
    expect(storeState.data.terminalConfig).toMatchObject({ screenReaderMode: "auto" });

    await handler({}, true);
    expect(storeState.data.terminalConfig).toMatchObject({ screenReaderMode: "auto" });
  });

  it("setCachedProjectViews accepts valid values 1 through 5", async () => {
    registerTerminalConfigHandlers();
    const handler = getHandler(CHANNELS.TERMINAL_CONFIG_SET_CACHED_PROJECT_VIEWS);

    await handler({}, 1);
    expect(storeState.data.terminalConfig).toMatchObject({ cachedProjectViews: 1 });

    await handler({}, 3);
    expect(storeState.data.terminalConfig).toMatchObject({ cachedProjectViews: 3 });

    await handler({}, 5);
    expect(storeState.data.terminalConfig).toMatchObject({ cachedProjectViews: 5 });
  });

  it("setCachedProjectViews rejects out-of-range values", async () => {
    registerTerminalConfigHandlers();
    const handler = getHandler(CHANNELS.TERMINAL_CONFIG_SET_CACHED_PROJECT_VIEWS);

    await expect(handler({}, 0)).rejects.toThrow("Invalid cachedProjectViews value");
    await expect(handler({}, 6)).rejects.toThrow("Invalid cachedProjectViews value");
    await expect(handler({}, -1)).rejects.toThrow("Invalid cachedProjectViews value");
  });

  it("setCachedProjectViews rejects non-integer and non-finite values", async () => {
    registerTerminalConfigHandlers();
    const handler = getHandler(CHANNELS.TERMINAL_CONFIG_SET_CACHED_PROJECT_VIEWS);

    await expect(handler({}, 1.5)).rejects.toThrow("Invalid cachedProjectViews value");
    await expect(handler({}, Number.NaN)).rejects.toThrow("Invalid cachedProjectViews value");
    await expect(handler({}, Infinity)).rejects.toThrow("Invalid cachedProjectViews value");
  });

  it("setCachedProjectViews calls projectViewManager.setCachedViewLimit", async () => {
    const mockPvm = { setCachedViewLimit: vi.fn() };
    registerTerminalConfigHandlers({ projectViewManager: mockPvm } as never);
    const handler = getHandler(CHANNELS.TERMINAL_CONFIG_SET_CACHED_PROJECT_VIEWS);

    await handler({}, 4);
    expect(mockPvm.setCachedViewLimit).toHaveBeenCalledWith(4);
  });

  it("setCachedProjectViews does not crash when deps is absent", async () => {
    registerTerminalConfigHandlers();
    const handler = getHandler(CHANNELS.TERMINAL_CONFIG_SET_CACHED_PROJECT_VIEWS);

    await handler({}, 3);
    expect(storeState.data.terminalConfig).toMatchObject({ cachedProjectViews: 3 });
  });

  it("normalizes malformed terminalConfig shape before writes", async () => {
    storeState.data.terminalConfig = "corrupted";
    registerTerminalConfigHandlers();
    const fontSizeHandler = getHandler(CHANNELS.TERMINAL_CONFIG_SET_FONT_SIZE);

    await fontSizeHandler({}, 16);
    expect(storeState.data.terminalConfig).toEqual({ fontSize: 16 });
  });

  describe("setRecentSchemeIds", () => {
    it("persists a valid string array", async () => {
      registerTerminalConfigHandlers();
      const handler = getHandler(CHANNELS.TERMINAL_CONFIG_SET_RECENT_SCHEME_IDS);

      await handler({}, ["dracula", "monokai"]);

      expect(storeState.data.terminalConfig).toMatchObject({
        recentSchemeIds: ["dracula", "monokai"],
      });
    });

    it("ignores non-array input without mutating store", async () => {
      registerTerminalConfigHandlers();
      const handler = getHandler(CHANNELS.TERMINAL_CONFIG_SET_RECENT_SCHEME_IDS);

      const before = storeState.data.terminalConfig;
      await handler({}, "not-an-array");
      await handler({}, null);
      await handler({}, 123);

      expect(storeState.data.terminalConfig).toEqual(before);
    });

    it("filters non-string entries, trims whitespace, caps at 5", async () => {
      registerTerminalConfigHandlers();
      const handler = getHandler(CHANNELS.TERMINAL_CONFIG_SET_RECENT_SCHEME_IDS);

      await handler({}, ["a", "", "  ", 42, null, " b ", "c", "d", "e", "f", "g"]);

      expect(storeState.data.terminalConfig).toMatchObject({
        recentSchemeIds: ["a", "b", "c", "d", "e"],
      });
    });

    it("preserves other terminalConfig fields when persisting", async () => {
      registerTerminalConfigHandlers();
      const handler = getHandler(CHANNELS.TERMINAL_CONFIG_SET_RECENT_SCHEME_IDS);

      await handler({}, ["dracula"]);

      expect(storeState.data.terminalConfig).toMatchObject({
        scrollbackLines: 1000,
        fontSize: 12,
        fontFamily: "JetBrains Mono",
        recentSchemeIds: ["dracula"],
      });
    });
  });
});
