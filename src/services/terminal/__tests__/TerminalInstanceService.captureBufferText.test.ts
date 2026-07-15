// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onTierChanged: vi.fn(() => vi.fn()),
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

  it("returns empty string for nonexistent terminal", () => {
    expect(terminalInstanceService.captureBufferText("nonexistent")).toBe("");
  });

  it("returns empty string for empty buffer", async () => {
    await createManagedTerminal("test-1");
    // Fresh terminal has no content written
    const result = terminalInstanceService.captureBufferText("test-1");
    // Buffer may have empty lines from initialization, but should be blank
    expect(result.trim()).toBe("");
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

  it("strips ANSI escape codes from captured text", async () => {
    const managed = await createManagedTerminal("test-3");
    // Write text with ANSI color codes
    managed.terminal.write("\x1b[31mRed text\x1b[0m\r\n");
    managed.terminal.write("\x1b[1;32mBold green\x1b[0m\r\n");
    await flushWrites(managed.terminal);

    const result = terminalInstanceService.captureBufferText("test-3");
    // translateToString already strips most ANSI, but stripAnsiAndOscCodes
    // handles any remaining sequences
    expect(result).not.toContain("\x1b[");
    expect(result).toContain("Red text");
    expect(result).toContain("Bold green");
  });

  it("truncates to maxChars keeping the tail", async () => {
    const managed = await createManagedTerminal("test-4");
    // Write enough text to exceed a small maxChars limit
    for (let i = 0; i < 20; i++) {
      managed.terminal.write(`Line number ${i.toString().padStart(3, "0")}\r\n`);
    }
    await flushWrites(managed.terminal);

    const result = terminalInstanceService.captureBufferText("test-4", 50);
    expect(result.length).toBeLessThanOrEqual(50);
    // Should contain the tail (later lines), not the head
    expect(result).toContain("019");
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
