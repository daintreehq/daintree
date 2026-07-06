// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

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

async function importFresh() {
  vi.resetModules();
  const serviceModule = await import("../TerminalInstanceService");
  const compositorModule = await import("../paintFabric/PaintFabricCompositor");
  const configModule = await import("../paintFabric/paintFabricConfig");
  return {
    terminalInstanceService: serviceModule.terminalInstanceService,
    PaintFabricCompositor: compositorModule.PaintFabricCompositor,
    PRIMARY_SURFACE_ID: configModule.PRIMARY_SURFACE_ID,
  };
}

describe("paint fabric construction seam", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("exports the bare single-surface service when the flag is off", async () => {
    vi.stubEnv("DAINTREE_PAINT_FABRIC", "");
    const { terminalInstanceService, PaintFabricCompositor } = await importFresh();
    expect(terminalInstanceService).not.toBeInstanceOf(PaintFabricCompositor);
    terminalInstanceService.dispose();
  });

  it("exports the compositor fronting one primary surface when the flag is on", async () => {
    vi.stubEnv("DAINTREE_PAINT_FABRIC", "1");
    const { terminalInstanceService, PaintFabricCompositor, PRIMARY_SURFACE_ID } =
      await importFresh();
    expect(terminalInstanceService).toBeInstanceOf(PaintFabricCompositor);

    const compositor = terminalInstanceService as InstanceType<typeof PaintFabricCompositor>;
    const registry = compositor.getRegistryForTests();
    expect(registry.surfaceCount()).toBe(1);
    expect(registry.defaultSurface().id).toBe(PRIMARY_SURFACE_ID);
    terminalInstanceService.dispose();
  });

  it("behaves identically through the compositor at surface-count 1", async () => {
    vi.stubEnv("DAINTREE_PAINT_FABRIC", "1");
    const { terminalInstanceService, PaintFabricCompositor, PRIMARY_SURFACE_ID } =
      await importFresh();
    expect(terminalInstanceService).toBeInstanceOf(PaintFabricCompositor);

    const managed = await terminalInstanceService.getOrCreate("fabric-parity-1", undefined, {
      rows: 24,
      cols: 80,
      allowProposedApi: true,
    });
    expect(managed).toBeTruthy();
    expect(terminalInstanceService.get("fabric-parity-1")).toBe(managed);

    const compositor = terminalInstanceService as InstanceType<typeof PaintFabricCompositor>;
    expect(compositor.getRegistryForTests().surfaceFor("fabric-parity-1")?.id).toBe(
      PRIMARY_SURFACE_ID
    );

    await new Promise<void>((resolve) => managed.terminal.write("echo parity\r\n", resolve));
    expect(terminalInstanceService.captureBufferText("fabric-parity-1")).toContain("echo parity");

    terminalInstanceService.destroy("fabric-parity-1");
    expect(terminalInstanceService.get("fabric-parity-1")).toBeNull();
    expect(compositor.getRegistryForTests().surfaceFor("fabric-parity-1")).toBeNull();

    terminalInstanceService.dispose();
  });
});
