// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/panel";

const MOCK_FONT_FAMILY = "MockMono, monospace";

// Capture the callback the service registers in its constructor so the tests can
// simulate JetBrains Mono arriving after the startup timeout (#9776) without
// touching the real `document.fonts` load path.
let registeredLateArrivalCallback: (() => void) | null = null;
vi.mock("@/config/terminalFont", () => ({
  DEFAULT_TERMINAL_FONT_FAMILY: MOCK_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE: 12,
  ensureTerminalFontLoaded: () => Promise.resolve(),
  terminalFontReady: Promise.resolve(),
  onTerminalFontArrivedLate: (cb: () => void) => {
    registeredLateArrivalCallback = cb;
    return () => {};
  },
}));

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

function stubMatchMedia(): void {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  });
}

describe("TerminalInstanceService - repairFontGrid (#9776)", () => {
  it("registers a late-font-arrival callback in its constructor", async () => {
    await import("../TerminalInstanceService");
    expect(typeof registeredLateArrivalCallback).toBe("function");
  });

  it("remeasures every non-hibernated instance", async () => {
    const { terminalInstanceService } = await import("../TerminalInstanceService");
    stubMatchMedia();

    const m1 = await terminalInstanceService.getOrCreate(
      "repair-fit-1",
      undefined,
      {},
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );
    const m2 = await terminalInstanceService.getOrCreate(
      "repair-fit-2",
      undefined,
      {},
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );

    const f1 = vi.spyOn(m1.fitAddon, "proposeDimensions");
    const f2 = vi.spyOn(m2.fitAddon, "proposeDimensions");

    terminalInstanceService.repairFontGrid();

    expect(f1).toHaveBeenCalled();
    expect(f2).toHaveBeenCalled();

    terminalInstanceService.destroy("repair-fit-1");
    terminalInstanceService.destroy("repair-fit-2");
  });

  it("pokes fontFamily to a distinct value then restores the original", async () => {
    const { terminalInstanceService } = await import("../TerminalInstanceService");
    stubMatchMedia();

    const managed = await terminalInstanceService.getOrCreate(
      "repair-poke",
      undefined,
      {},
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );

    const original = "Original Mono, monospace";
    // Replace the real OptionsService getter/setter so we can observe the exact
    // sequence of values written — the dedup-defeating poke must set a string
    // different from the current one (else xterm's OptionsService no-ops it),
    // then restore the original.
    let stored = original;
    const setLog: string[] = [];
    Object.defineProperty(managed.terminal.options, "fontFamily", {
      configurable: true,
      get: () => stored,
      set: (value: string) => {
        setLog.push(value);
        stored = value;
      },
    });

    terminalInstanceService.repairFontGrid();

    expect(setLog).toHaveLength(2);
    expect(setLog[0]).not.toBe(original); // genuine change defeats same-value dedup
    expect(setLog[1]).toBe(original); // restored
    expect(stored).toBe(original); // final value is the original

    terminalInstanceService.destroy("repair-poke");
  });

  it("falls back to the default font family when none is set", async () => {
    const { terminalInstanceService } = await import("../TerminalInstanceService");
    stubMatchMedia();

    const managed = await terminalInstanceService.getOrCreate(
      "repair-default",
      undefined,
      {},
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );

    let stored: string | undefined = undefined;
    const setLog: string[] = [];
    Object.defineProperty(managed.terminal.options, "fontFamily", {
      configurable: true,
      get: () => stored,
      set: (value: string) => {
        setLog.push(value);
        stored = value;
      },
    });

    terminalInstanceService.repairFontGrid();

    expect(setLog).toHaveLength(2);
    expect(setLog[1]).toBe(MOCK_FONT_FAMILY); // restored to the default

    terminalInstanceService.destroy("repair-default");
  });

  it("refreshes the cached host dimensions while repairing the grid", async () => {
    const { terminalInstanceService } = await import("../TerminalInstanceService");
    stubMatchMedia();

    const managed = await terminalInstanceService.getOrCreate(
      "repair-dims",
      undefined,
      {},
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );
    managed.lastWidth = 640;
    managed.lastHeight = 480;

    terminalInstanceService.repairFontGrid();

    expect(managed.lastWidth).toBe(800);
    expect(managed.lastHeight).toBe(600);

    terminalInstanceService.destroy("repair-dims");
  });

  it("repairs every live grid when the late-arrival callback fires", async () => {
    const { terminalInstanceService } = await import("../TerminalInstanceService");
    stubMatchMedia();

    expect(registeredLateArrivalCallback).toBeTypeOf("function");

    const managed = await terminalInstanceService.getOrCreate(
      "repair-callback",
      undefined,
      {},
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );
    const fit = vi.spyOn(managed.fitAddon, "proposeDimensions");

    registeredLateArrivalCallback?.();

    expect(fit).toHaveBeenCalled();

    terminalInstanceService.destroy("repair-callback");
  });
});
