// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    write: vi.fn(),
    setActivityTier: vi.fn(),
    wake: vi.fn(),
    getSerializedState: vi.fn(),
    getSharedBuffers: vi.fn(async () => ({
      visualBuffers: [],
      signalBuffer: null,
    })),
    acknowledgeData: vi.fn(),
    acknowledgePortData: vi.fn(),
  },
  systemClient: { openExternal: vi.fn() },
  appClient: { getHydrationState: vi.fn() },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
    onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
  })),
}));

vi.mock("../TerminalAddonManager", () => ({
  setupTerminalAddons: vi.fn(() => ({
    fitAddon: { fit: vi.fn() },
    serializeAddon: { serialize: vi.fn() },
    imageAddon: { dispose: vi.fn() },
    searchAddon: {},
    fileLinksDisposable: { dispose: vi.fn() },
    webLinksAddon: { dispose: vi.fn() },
  })),
  createImageAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createFileLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createWebLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock("@/store/scrollbackStore", () => ({
  useScrollbackStore: { getState: () => ({ scrollbackLines: 5000 }) },
}));

vi.mock("@/store/performanceModeStore", () => ({
  usePerformanceModeStore: { getState: () => ({ performanceMode: false }) },
}));

vi.mock("@/store/projectSettingsStore", () => ({
  useProjectSettingsStore: { getState: () => ({ settings: null }) },
}));

describe("TerminalInstanceService - Selection-Aware Auto-Scroll Logic", () => {
  it("should check hasSelection before scrolling", () => {
    const hasSelectionMock = vi.fn(() => false);
    const scrollToBottomMock = vi.fn();
    const updateScrollStateMock = vi.fn();

    const managed = {
      terminal: {
        hasSelection: hasSelectionMock,
        buffer: { active: { type: "normal" } },
      },
      isUserScrolledBack: false,
      isAltBuffer: false,
    };

    const id = "test-terminal";

    const writeParsedCallback = () => {
      if (managed && !managed.isUserScrolledBack && !managed.isAltBuffer) {
        if (!managed.terminal.hasSelection()) {
          scrollToBottomMock(managed);
        } else {
          managed.isUserScrolledBack = true;
          updateScrollStateMock(id, true);
        }
      }
    };

    hasSelectionMock.mockReturnValue(false);
    writeParsedCallback();

    expect(hasSelectionMock).toHaveBeenCalled();
    expect(scrollToBottomMock).toHaveBeenCalledWith(managed);
    expect(managed.isUserScrolledBack).toBe(false);
    expect(updateScrollStateMock).not.toHaveBeenCalledWith(id, true);

    scrollToBottomMock.mockClear();
    hasSelectionMock.mockReturnValue(true);
    managed.isUserScrolledBack = false;

    writeParsedCallback();

    expect(hasSelectionMock).toHaveBeenCalled();
    expect(scrollToBottomMock).not.toHaveBeenCalled();
    expect(managed.isUserScrolledBack).toBe(true);
    expect(updateScrollStateMock).toHaveBeenCalledWith(id, true);
  });

  it("should not scroll when already scrolled back", () => {
    const hasSelectionMock = vi.fn(() => true);
    const scrollToBottomMock = vi.fn();
    const updateScrollStateMock = vi.fn();

    const managed = {
      terminal: {
        hasSelection: hasSelectionMock,
        buffer: { active: { type: "normal" } },
      },
      isUserScrolledBack: true,
      isAltBuffer: false,
    };

    const writeParsedCallback = () => {
      if (managed && !managed.isUserScrolledBack && !managed.isAltBuffer) {
        if (!managed.terminal.hasSelection()) {
          scrollToBottomMock(managed);
        } else {
          managed.isUserScrolledBack = true;
          updateScrollStateMock("test-terminal", true);
        }
      }
    };

    writeParsedCallback();

    expect(hasSelectionMock).not.toHaveBeenCalled();
    expect(scrollToBottomMock).not.toHaveBeenCalled();
    expect(updateScrollStateMock).not.toHaveBeenCalledWith("test-terminal", true);
  });

  it("should bypass selection guard in alt-buffer mode", () => {
    const hasSelectionMock = vi.fn(() => true);
    const scrollToBottomMock = vi.fn();
    const updateScrollStateMock = vi.fn();

    const managed = {
      terminal: {
        hasSelection: hasSelectionMock,
        buffer: { active: { type: "alternate" } },
      },
      isUserScrolledBack: false,
      isAltBuffer: true,
    };

    const writeParsedCallback = () => {
      if (managed && !managed.isUserScrolledBack && !managed.isAltBuffer) {
        if (!managed.terminal.hasSelection()) {
          scrollToBottomMock(managed);
        } else {
          managed.isUserScrolledBack = true;
          updateScrollStateMock("test-terminal", true);
        }
      }
    };

    writeParsedCallback();

    expect(hasSelectionMock).not.toHaveBeenCalled();
    expect(scrollToBottomMock).not.toHaveBeenCalled();
    expect(updateScrollStateMock).not.toHaveBeenCalledWith("test-terminal", true);
    expect(managed.isUserScrolledBack).toBe(false);
  });

  it("should resume auto-scroll when selection is cleared", () => {
    const hasSelectionMock = vi.fn(() => false);
    const scrollToBottomMock = vi.fn();
    const updateScrollStateMock = vi.fn();

    const managed = {
      terminal: {
        hasSelection: hasSelectionMock,
        buffer: { active: { type: "normal" } },
      },
      isUserScrolledBack: false,
      isAltBuffer: false,
    };

    const id = "test-terminal";

    const writeParsedCallback = () => {
      if (managed && !managed.isUserScrolledBack && !managed.isAltBuffer) {
        if (!managed.terminal.hasSelection()) {
          scrollToBottomMock(managed);
        } else {
          managed.isUserScrolledBack = true;
          updateScrollStateMock(id, true);
        }
      }
    };

    hasSelectionMock.mockReturnValue(true);
    managed.isUserScrolledBack = false;
    writeParsedCallback();

    expect(scrollToBottomMock).not.toHaveBeenCalled();
    expect(managed.isUserScrolledBack).toBe(true);
    expect(updateScrollStateMock).toHaveBeenCalledWith(id, true);

    hasSelectionMock.mockReturnValue(false);
    managed.isUserScrolledBack = false;
    scrollToBottomMock.mockClear();
    updateScrollStateMock.mockClear();
    writeParsedCallback();

    expect(scrollToBottomMock).toHaveBeenCalledWith(managed);
    expect(managed.isUserScrolledBack).toBe(false);
    expect(updateScrollStateMock).not.toHaveBeenCalledWith(id, true);
  });
});
