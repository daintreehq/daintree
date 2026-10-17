// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onResizeResult: vi.fn(() => vi.fn()),
    onTierChanged: vi.fn(() => vi.fn()),
    onReset: vi.fn(() => vi.fn()),
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
    getPortAckGeneration: vi.fn(() => 0),
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

const { terminalInstanceService } = await import("../TerminalInstanceService");

async function createManagedTerminal(id: string) {
  return await terminalInstanceService.getOrCreate(id, undefined, {
    rows: 24,
    cols: 80,
    allowProposedApi: true,
  });
}

function flushWrites(terminal: { write(data: string, callback?: () => void): void }) {
  return new Promise<void>((resolve) => terminal.write("", resolve));
}

describe("captureBufferText", () => {
  beforeEach(() => {
    // Clean up any existing instances
    terminalInstanceService.dispose();
  });

  it("captures written text from the buffer", async () => {
    const managed = await createManagedTerminal("test-2");
    // Write some plain text to the terminal
    managed.terminal.write("Hello World\r\n");
    managed.terminal.write("Second line\r\n");
    await flushWrites(managed.terminal);

    const result = terminalInstanceService.captureBufferText("test-2");
    expect(result).toContain("Hello World");
    expect(result).toContain("Second line");
  });

  it("preserves head lines when the whole buffer fits within maxChars", async () => {
    const managed = await createManagedTerminal("test-head");
    managed.terminal.write("FIRST line marker\r\n");
    managed.terminal.write("middle line\r\n");
    managed.terminal.write("LAST line marker\r\n");
    await flushWrites(managed.terminal);

    const result = terminalInstanceService.captureBufferText("test-head", 20000);
    // Tail-scan must still walk all the way up when the buffer is small —
    // the head must not be dropped, and order must be top-to-bottom.
    expect(result).toContain("FIRST line marker");
    expect(result).toContain("LAST line marker");
    expect(result.indexOf("FIRST line marker")).toBeLessThan(result.indexOf("LAST line marker"));
  });

  it("fills maxChars from the tail when visible content exceeds it", async () => {
    const managed = await createManagedTerminal("test-fill");
    // ~50 lines of plain text — well over a small maxChars budget.
    for (let i = 0; i < 50; i++) {
      managed.terminal.write(`row ${i.toString().padStart(3, "0")} payload\r\n`);
    }
    await flushWrites(managed.terminal);

    const result = terminalInstanceService.captureBufferText("test-fill", 100);
    // The window must widen until the stripped tail fills the budget — never
    // stop short — and keep the most recent line.
    expect(result.length).toBe(100);
    expect(result).toContain("row 049");
    expect(result).not.toContain("row 000");
  });
});
