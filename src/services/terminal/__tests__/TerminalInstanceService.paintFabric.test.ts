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
  const clientsModule = await import("@/clients");
  return {
    terminalInstanceService: serviceModule.terminalInstanceService,
    PaintFabricCompositor: compositorModule.PaintFabricCompositor,
    PRIMARY_SURFACE_ID: configModule.PRIMARY_SURFACE_ID,
    MAX_PAINT_FABRIC_SURFACES: configModule.MAX_PAINT_FABRIC_SURFACES,
    paintFabricAuxSurfaceId: configModule.paintFabricAuxSurfaceId,
    terminalClient: clientsModule.terminalClient,
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

  it("builds K in-process surfaces from the env, clamped to the ceiling", async () => {
    vi.stubEnv("DAINTREE_PAINT_FABRIC", "1");
    vi.stubEnv("DAINTREE_PAINT_FABRIC_SURFACES", "3");
    const three = await importFresh();
    const compositor3 = three.terminalInstanceService as InstanceType<
      typeof three.PaintFabricCompositor
    >;
    const registry3 = compositor3.getRegistryForTests();
    expect(registry3.surfaceCount()).toBe(3);
    expect(registry3.defaultSurface().id).toBe(three.PRIMARY_SURFACE_ID);
    expect(registry3.surfaceById(three.paintFabricAuxSurfaceId(1))).not.toBeNull();
    expect(registry3.surfaceById(three.paintFabricAuxSurfaceId(2))).not.toBeNull();
    three.terminalInstanceService.dispose();

    vi.stubEnv("DAINTREE_PAINT_FABRIC_SURFACES", "99");
    const clamped = await importFresh();
    const compositorMax = clamped.terminalInstanceService as InstanceType<
      typeof clamped.PaintFabricCompositor
    >;
    expect(compositorMax.getRegistryForTests().surfaceCount()).toBe(
      clamped.MAX_PAINT_FABRIC_SURFACES
    );
    clamped.terminalInstanceService.dispose();
  });

  it("round-robins real terminals across surfaces and forces aux surfaces to DOM rendering", async () => {
    vi.stubEnv("DAINTREE_PAINT_FABRIC", "1");
    vi.stubEnv("DAINTREE_PAINT_FABRIC_SURFACES", "2");
    const { terminalInstanceService, PaintFabricCompositor, PRIMARY_SURFACE_ID } =
      await importFresh();
    const compositor = terminalInstanceService as InstanceType<typeof PaintFabricCompositor>;
    const registry = compositor.getRegistryForTests();

    const options = { rows: 24, cols: 80, allowProposedApi: true };
    await terminalInstanceService.getOrCreate("rr-1", undefined, options);
    await terminalInstanceService.getOrCreate("rr-2", undefined, options);

    const surface1 = registry.surfaceFor("rr-1")!.id;
    const surface2 = registry.surfaceFor("rr-2")!.id;
    expect(surface1).not.toBe(surface2);
    expect([surface1, surface2].sort()).toEqual([PRIMARY_SURFACE_ID, "surface-aux-1"].sort());

    // Both are live, independently-owned real terminals behind one facade.
    expect(terminalInstanceService.get("rr-1")).toBeTruthy();
    expect(terminalInstanceService.get("rr-2")).toBeTruthy();

    // In-process aux surfaces must never compete for the window's shared
    // 16-context budget: their WebGL manager is hardware-off → DOM mode.
    const auxTerminalId = surface1 === "surface-aux-1" ? "rr-1" : "rr-2";
    expect(terminalInstanceService.getWebGLStateForE2E(auxTerminalId).mode).toBe("dom");

    terminalInstanceService.dispose();
  });

  it("transfers a real terminal across surfaces, restoring through the real pipeline", async () => {
    vi.stubEnv("DAINTREE_PAINT_FABRIC", "1");
    vi.stubEnv("DAINTREE_PAINT_FABRIC_SURFACES", "2");
    const { terminalInstanceService, PaintFabricCompositor, terminalClient, PRIMARY_SURFACE_ID } =
      await importFresh();
    const compositor = terminalInstanceService as InstanceType<typeof PaintFabricCompositor>;
    const registry = compositor.getRegistryForTests();

    const managed = await terminalInstanceService.getOrCreate("move-me", undefined, {
      rows: 24,
      cols: 80,
      allowProposedApi: true,
    });
    expect(registry.surfaceFor("move-me")!.id).toBe(PRIMARY_SURFACE_ID);
    await new Promise<void>((resolve) => managed.terminal.write("pre-move content", resolve));

    // The pty-host owns the canonical scrollback; the transfer restores it.
    vi.mocked(terminalClient.getSerializedState).mockResolvedValue("restored-across-surfaces\r\n");

    const moved = await compositor.transferTerminal("move-me", "surface-aux-1");
    expect(moved).toBe(true);
    expect(registry.surfaceFor("move-me")!.id).toBe("surface-aux-1");

    // The re-created terminal is live on the new surface with the host's
    // state written through the real restore path. The restore write rides
    // xterm's async WriteBuffer; a sentinel write behind it (FIFO) proves it
    // has landed.
    const movedManaged = terminalInstanceService.get("move-me");
    expect(movedManaged).toBeTruthy();
    await new Promise<void>((resolve) => movedManaged!.terminal.write("", resolve));
    expect(terminalInstanceService.captureBufferText("move-me")).toContain(
      "restored-across-surfaces"
    );

    terminalInstanceService.dispose();
  });
});
