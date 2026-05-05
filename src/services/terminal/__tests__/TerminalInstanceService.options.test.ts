// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/panel";

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
    onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
  })),
}));

vi.mock("@/clients", () => ({
  terminalClient: {
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    setActivityTier: vi.fn(),
    wake: vi.fn(),
    getSerializedState: vi.fn(),
    getSharedBuffer: vi.fn(() => null),
  },
  systemClient: {
    openExternal: vi.fn(),
  },
  appClient: {
    getHydrationState: vi.fn(),
  },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
  },
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

const mockDocument = {
  createElement: vi.fn(() => ({
    style: {},
    className: "",
    appendChild: vi.fn(),
    removeChild: vi.fn(),
    parentElement: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    remove: vi.fn(),
    getBoundingClientRect: vi.fn(() => ({ width: 800, height: 600 })),
  })),
  body: {
    appendChild: vi.fn(),
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
(global as any).document = mockDocument;

describe("TerminalInstanceService - options", () => {
  it("uses current defaults for non-agent terminals", async () => {
    const { terminalInstanceService } = await import("../TerminalInstanceService");

    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    });

    const managed = terminalInstanceService.getOrCreate(
      "test-options",
      undefined,
      {},
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );

    expect(managed.terminal.options).toEqual(
      expect.objectContaining({
        rescaleOverlappingGlyphs: true,
        customGlyphs: true,
        reflowCursorLine: true,
      })
    );

    terminalInstanceService.destroy("test-options");
  });

  it("disables cosmetic options for agent terminals", async () => {
    const { terminalInstanceService } = await import("../TerminalInstanceService");

    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    });

    const managed = terminalInstanceService.getOrCreate(
      "test-options",
      "claude",
      {},
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );

    expect(managed.terminal.options).toEqual(
      expect.objectContaining({
        cursorBlink: false,
        rescaleOverlappingGlyphs: false,
        customGlyphs: false,
        reflowCursorLine: true,
      })
    );

    terminalInstanceService.destroy("test-options");
  });

  it("preserves agent cosmetic options on terminal.options for hibernation rebuilds", async () => {
    const { terminalInstanceService } = await import("../TerminalInstanceService");

    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    });

    const managed = terminalInstanceService.getOrCreate(
      "test-options",
      "claude",
      {},
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );

    // TerminalHibernationManager.unhibernate() calls new Terminal(managed.terminal.options)
    // so these must be present on the stored options object
    expect(managed.terminal.options).toMatchObject({
      cursorBlink: false,
      rescaleOverlappingGlyphs: false,
      customGlyphs: false,
    });

    terminalInstanceService.destroy("test-options");
  });

  it("preserves agent cosmetic overrides when existing terminal is reused with fresh options", async () => {
    const { terminalInstanceService } = await import("../TerminalInstanceService");

    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    });

    // First creation — agent terminal
    const managed = terminalInstanceService.getOrCreate(
      "test-options",
      "claude",
      {},
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );

    expect(managed.terminal.options.cursorBlink).toBe(false);

    // Simulate XtermAdapter re-rendering with fresh options from getXtermOptions()
    // which includes cursorBlink: true from BASE_TERMINAL_OPTIONS
    terminalInstanceService.getOrCreate(
      "test-options",
      "claude",
      { cursorBlink: true, fontSize: 14 },
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );

    expect(managed.terminal.options).toMatchObject({
      cursorBlink: false,
      rescaleOverlappingGlyphs: false,
      customGlyphs: false,
    });
    expect(managed.terminal.options.fontSize).toBe(14);

    terminalInstanceService.destroy("test-options");
  });
});
