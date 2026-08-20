// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The module attaches a suite of __daintree* terminal introspection bridges to
// `window` at eval time. They must only attach when the preload has injected
// `window.__DAINTREE_E2E_MODE__ === true` (E2E, non-packaged builds) and must
// never attach in production sessions. These mocks let the heavy service module
// import cleanly under jsdom without exercising the real PTY/WebGL stack.

vi.mock("@/clients", () => ({
  terminalClient: {
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onTierChanged: vi.fn(() => vi.fn()),
    setActivityTier: vi.fn(),
    wake: vi.fn().mockResolvedValue({ state: null }),
    write: vi.fn(),
    getSerializedState: vi.fn(),
    getSharedBuffer: vi.fn(() => null),
    acknowledgeData: vi.fn(),
    acknowledgePortData: vi.fn(),
    discardPortAcks: vi.fn(),
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
  createImageLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
  createWebLinksAddon: vi.fn(() => ({ dispose: vi.fn() })),
}));

// Every __daintree* bridge attached at module eval — both the window-cast and
// the Object.assign call sites — so we assert the whole surface is gated, not
// just one representative.
const E2E_TERMINAL_GLOBALS = [
  "__daintreeReadTerminalBuffer",
  "__daintreeSelectTerminalAll",
  "__daintreeGetTerminalSelection",
  "__daintreeGetTerminalBufferLength",
  "__daintreeGetTerminalDimensions",
  "__daintreeProposeTerminalDimensions",
  "__daintreeGetTerminalScrollState",
  "__daintreeScrollTerminalLines",
  "__daintreeApplyTerminalTier",
  "__daintreeSimulateTerminalResize",
  "__daintreeTriggerTerminalLink",
  "__daintreeGetTerminalWebGLState",
  "__daintreePromoteTerminalToAgentForE2E",
  "__daintreeGetTerminalForE2E",
] as const;

function windowProp(name: string): unknown {
  return (window as unknown as Record<string, unknown>)[name];
}

function clearGlobals(): void {
  for (const name of E2E_TERMINAL_GLOBALS) {
    delete (window as unknown as Record<string, unknown>)[name];
  }
  delete (window as unknown as Record<string, unknown>).__DAINTREE_E2E_MODE__;
}

async function importServiceWithMode(mode: unknown): Promise<void> {
  clearGlobals();
  if (mode !== undefined) {
    (window as unknown as Record<string, unknown>).__DAINTREE_E2E_MODE__ = mode;
  }
  vi.resetModules();
  await import("../TerminalInstanceService");
}

describe("TerminalInstanceService E2E terminal-bridge gate", () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).electron = {
      terminal: {
        reportTitleState: vi.fn(),
        updateObservedTitle: vi.fn(),
      },
      clipboard: {
        writeSelection: vi.fn().mockResolvedValue(undefined),
        readSelection: vi.fn().mockResolvedValue({ text: "" }),
      },
    };
  });

  afterEach(() => {
    clearGlobals();
    vi.resetModules();
  });

  it("does not attach any terminal bridge when __DAINTREE_E2E_MODE__ is absent", async () => {
    await importServiceWithMode(undefined);
    for (const name of E2E_TERMINAL_GLOBALS) {
      expect(windowProp(name), name).toBeUndefined();
    }
  });

  it("does not attach when __DAINTREE_E2E_MODE__ is false", async () => {
    await importServiceWithMode(false);
    for (const name of E2E_TERMINAL_GLOBALS) {
      expect(windowProp(name), name).toBeUndefined();
    }
  });

  it("rejects truthy-but-not-true values (e.g. string 'true')", async () => {
    await importServiceWithMode("true");
    for (const name of E2E_TERMINAL_GLOBALS) {
      expect(windowProp(name), name).toBeUndefined();
    }
  });

  it("attaches every terminal bridge as a function when __DAINTREE_E2E_MODE__ is true", async () => {
    await importServiceWithMode(true);
    for (const name of E2E_TERMINAL_GLOBALS) {
      expect(typeof windowProp(name), name).toBe("function");
    }
  });

  it("leaves no __daintree*Terminal* bridge on window in production (guards bridges added outside the gate)", async () => {
    // Scoped to the terminal-bridge naming convention rather than every
    // __daintree* key: unrelated modules in the import graph attach their own
    // (separately gated) E2E globals to the shared jsdom window, so a blanket
    // scan would false-positive on those. Every bridge in this module's block
    // contains "Terminal", so this still catches a new one added outside the gate.
    await importServiceWithMode(undefined);
    const leaked = Object.getOwnPropertyNames(window).filter((key) =>
      /^__daintree.*Terminal/.test(key)
    );
    expect(leaked).toEqual([]);
  });
});
