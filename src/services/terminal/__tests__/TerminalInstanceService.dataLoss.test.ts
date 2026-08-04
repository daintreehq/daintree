// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onResizeResult: vi.fn(() => vi.fn()),
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

// The marker reaches the buffer over two async xterm parse hops (OSC write →
// microtask → visible-line write → parse). A fixed sleep flakes on slow CI, so
// poll the captured buffer until the expected text lands (or time out).
async function waitForBufferText(id: string, needle: string, timeoutMs = 2000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    text = terminalInstanceService.captureBufferText(id);
    if (text.includes(needle)) return text;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return text;
}

describe("injectDataLossMarker", () => {
  beforeEach(() => {
    terminalInstanceService.dispose();
  });

  it("writes a structured OSC 57301 sequence, not a raw ANSI line", async () => {
    const managed = await createManagedTerminal("dl-1");
    const writeSpy = vi.spyOn(managed.terminal, "write");

    terminalInstanceService.injectDataLossMarker("dl-1", 1234);

    const oscWrite = writeSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("\x1b]57301;"));
    expect(oscWrite).toBeDefined();
    // Leading CAN cancels any partial in-flight sequence; OSC carries the
    // byte count + reason code and is BEL-terminated. Presentation (the
    // yellow ANSI line) must NOT be on the wire.
    const CAN = String.fromCharCode(0x18);
    const BEL = String.fromCharCode(0x07);
    const expectedPattern = `${CAN}\x1b]57301;1234;backpressure${BEL}`;
    expect(oscWrite).toBe(expectedPattern);
    expect(oscWrite).not.toContain("Output dropped");
    expect(oscWrite).not.toContain("\x1b[33m");
  });

  it("is a no-op for an unknown terminal id", () => {
    expect(() => terminalInstanceService.injectDataLossMarker("nope", 10)).not.toThrow();
  });

  it("renders the yellow marker via the OSC handler round-trip", async () => {
    await createManagedTerminal("dl-3");
    terminalInstanceService.injectDataLossMarker("dl-3", 2048);

    const text = await waitForBufferText("dl-3", "Output dropped (~2048 bytes)");
    expect(text).toContain("Output dropped (~2048 bytes)");
    // The raw OSC sequence is consumed by the handler and never reaches the
    // buffer as visible text.
    expect(text).not.toContain("57301");
  });

  it("uses a generic label when the dropped byte count is zero", async () => {
    await createManagedTerminal("dl-4");
    terminalInstanceService.injectDataLossMarker("dl-4", 0);

    const text = await waitForBufferText("dl-4", "Output dropped (output)");
    expect(text).toContain("Output dropped (output)");
  });
});
