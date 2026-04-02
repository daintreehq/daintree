// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

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

function createManagedTerminal(id: string) {
  return terminalInstanceService.getOrCreate(id, "terminal", {
    rows: 24,
    cols: 80,
    allowProposedApi: true,
  });
}

describe("captureBufferText", () => {
  beforeEach(() => {
    // Clean up any existing instances
    terminalInstanceService.dispose();
  });

  it("returns empty string for nonexistent terminal", () => {
    expect(terminalInstanceService.captureBufferText("nonexistent")).toBe("");
  });

  it("returns empty string for empty buffer", () => {
    createManagedTerminal("test-1");
    // Fresh terminal has no content written
    const result = terminalInstanceService.captureBufferText("test-1");
    // Buffer may have empty lines from initialization, but should be blank
    expect(result.trim()).toBe("");
  });

  it("captures written text from the buffer", () => {
    const managed = createManagedTerminal("test-2");
    // Write some plain text to the terminal
    managed.terminal.write("Hello World\r\n");
    managed.terminal.write("Second line\r\n");

    // Allow xterm to process the writes
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const result = terminalInstanceService.captureBufferText("test-2");
        expect(result).toContain("Hello World");
        expect(result).toContain("Second line");
        resolve();
      }, 50);
    });
  });

  it("strips ANSI escape codes from captured text", () => {
    const managed = createManagedTerminal("test-3");
    // Write text with ANSI color codes
    managed.terminal.write("\x1b[31mRed text\x1b[0m\r\n");
    managed.terminal.write("\x1b[1;32mBold green\x1b[0m\r\n");

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const result = terminalInstanceService.captureBufferText("test-3");
        // translateToString already strips most ANSI, but stripAnsiAndOscCodes
        // handles any remaining sequences
        expect(result).not.toContain("\x1b[");
        expect(result).toContain("Red text");
        expect(result).toContain("Bold green");
        resolve();
      }, 50);
    });
  });

  it("truncates to maxChars keeping the tail", () => {
    const managed = createManagedTerminal("test-4");
    // Write enough text to exceed a small maxChars limit
    for (let i = 0; i < 20; i++) {
      managed.terminal.write(`Line number ${i.toString().padStart(3, "0")}\r\n`);
    }

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const result = terminalInstanceService.captureBufferText("test-4", 50);
        expect(result.length).toBeLessThanOrEqual(50);
        // Should contain the tail (later lines), not the head
        expect(result).toContain("019");
        resolve();
      }, 50);
    });
  });

  it("returns empty string for hibernated terminal", () => {
    createManagedTerminal("test-5");
    terminalInstanceService.hibernate("test-5");
    expect(terminalInstanceService.captureBufferText("test-5")).toBe("");
  });
});
