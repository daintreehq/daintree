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
    onResizeResult: vi.fn(() => vi.fn()),
    onTierChanged: vi.fn(() => vi.fn()),
    setActivityTier: vi.fn(),
    wake: vi.fn(),
    resize: vi.fn(),
    getSerializedState: vi.fn(),
    getSharedBuffer: vi.fn(() => null),
    discardPortAcks: vi.fn(),
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
    fitAddon: {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
    },
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
    checkVisibility: vi.fn(() => true),
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

    const managed = await terminalInstanceService.getOrCreate(
      "test-options",
      undefined,
      {},
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );

    expect(managed.terminal.options).toEqual(
      expect.objectContaining({
        rescaleOverlappingGlyphs: true,
        reflowCursorLine: false,
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

    const managed = await terminalInstanceService.getOrCreate(
      "test-options",
      "claude",
      {},
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );

    expect(managed.terminal.options).toEqual(
      expect.objectContaining({
        cursorBlink: false,
        rescaleOverlappingGlyphs: true,
        reflowCursorLine: false,
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

    const managed = await terminalInstanceService.getOrCreate(
      "test-options",
      "claude",
      {},
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );

    // The stored options object must carry the agent cosmetic overrides so a
    // later Terminal re-creation (e.g. font-grid repair) keeps them.
    expect(managed.terminal.options).toMatchObject({
      cursorBlink: false,
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
    const managed = await terminalInstanceService.getOrCreate(
      "test-options",
      "claude",
      {},
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );

    expect(managed.terminal.options.cursorBlink).toBe(false);

    // Simulate XtermAdapter re-rendering with fresh options from getXtermOptions()
    // which includes cursorBlink: true from BASE_TERMINAL_OPTIONS
    await terminalInstanceService.getOrCreate(
      "test-options",
      "claude",
      { cursorBlink: true, fontSize: 14 },
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );

    expect(managed.terminal.options).toMatchObject({
      cursorBlink: false,
    });
    expect(managed.terminal.options.fontSize).toBe(14);

    terminalInstanceService.destroy("test-options");
  });

  it("updateOptions with theme calls refresh but not fit", async () => {
    const { terminalInstanceService } = await import("../TerminalInstanceService");

    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    });

    const managed = await terminalInstanceService.getOrCreate(
      "test-options-theme",
      undefined,
      {},
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );

    const refreshSpy = vi.spyOn(managed.terminal, "refresh");
    const fitSpy = vi.spyOn(managed.fitAddon, "proposeDimensions");

    terminalInstanceService.updateOptions("test-options-theme", {
      theme: { foreground: "#ffffff", background: "#000000" },
    });

    expect(refreshSpy).toHaveBeenCalledWith(0, managed.terminal.rows - 1);
    expect(fitSpy).not.toHaveBeenCalled();

    terminalInstanceService.destroy("test-options-theme");
  });

  it("updateOptions with fontSize calls fit but not refresh", async () => {
    const { terminalInstanceService } = await import("../TerminalInstanceService");

    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    });

    const managed = await terminalInstanceService.getOrCreate(
      "test-options-font",
      undefined,
      {},
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );

    const refreshSpy = vi.spyOn(managed.terminal, "refresh");
    const fitSpy = vi.spyOn(managed.fitAddon, "proposeDimensions");

    terminalInstanceService.updateOptions("test-options-font", { fontSize: 16 });

    expect(fitSpy).toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();

    terminalInstanceService.destroy("test-options-font");
  });

  it("updateOptions with both theme and fontSize calls both", async () => {
    const { terminalInstanceService } = await import("../TerminalInstanceService");

    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    });

    const managed = await terminalInstanceService.getOrCreate(
      "test-options-both",
      undefined,
      {},
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );

    const refreshSpy = vi.spyOn(managed.terminal, "refresh");
    const fitSpy = vi.spyOn(managed.fitAddon, "proposeDimensions");

    terminalInstanceService.updateOptions("test-options-both", {
      theme: { foreground: "#ffffff", background: "#000000" },
      fontSize: 16,
    });

    expect(refreshSpy).toHaveBeenCalled();
    expect(fitSpy).toHaveBeenCalled();

    terminalInstanceService.destroy("test-options-both");
  });

  it("applyGlobalOptions with theme calls refresh on each instance", async () => {
    const { terminalInstanceService } = await import("../TerminalInstanceService");

    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    });

    const m1 = await terminalInstanceService.getOrCreate(
      "test-global-1",
      undefined,
      {},
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );
    const m2 = await terminalInstanceService.getOrCreate(
      "test-global-2",
      undefined,
      {},
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );

    const r1 = vi.spyOn(m1.terminal, "refresh");
    const r2 = vi.spyOn(m2.terminal, "refresh");

    terminalInstanceService.applyGlobalOptions({
      theme: { foreground: "#ffffff", background: "#000000" },
    });

    expect(r1).toHaveBeenCalled();
    expect(r2).toHaveBeenCalled();

    terminalInstanceService.destroy("test-global-1");
    terminalInstanceService.destroy("test-global-2");
  });

  it("applyGlobalOptions with fontSize calls fit on each instance", async () => {
    const { terminalInstanceService } = await import("../TerminalInstanceService");

    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    });

    const m1 = await terminalInstanceService.getOrCreate(
      "test-global-font-1",
      undefined,
      {},
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );
    const m2 = await terminalInstanceService.getOrCreate(
      "test-global-font-2",
      undefined,
      {},
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );

    const f1 = vi.spyOn(m1.fitAddon, "proposeDimensions");
    const f2 = vi.spyOn(m2.fitAddon, "proposeDimensions");

    terminalInstanceService.applyGlobalOptions({ fontSize: 18 });

    expect(f1).toHaveBeenCalled();
    expect(f2).toHaveBeenCalled();

    terminalInstanceService.destroy("test-global-font-1");
    terminalInstanceService.destroy("test-global-font-2");
  });
});
