// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

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

async function importFreshWithPinnedWebglThresholds() {
  const modules = await importFresh();
  // Pin the whole-fleet WebGL flip thresholds so this test's count logic — the
  // 13th want crosses a single surface's threshold; a round-robin split keeps
  // each surface under it — is independent of the RAM-tiered bootstrap default.
  // resetModules() re-seeds that default from system memory (now 18/15), which
  // would otherwise let all 13 wants stay in WebGL. 12/10 restores the "13th
  // flips" boundary this scenario was written around.
  const webglConfigModule = await import("../TerminalWebGLConfig");
  webglConfigModule.setWebglThresholds(12, 10);
  return modules;
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
    vi.mocked(terminalClient.getSerializedState).mockResolvedValue({
      data: "restored-across-surfaces\r\n",
      cols: 80,
      rows: 24,
    });

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

describe("paint fabric GPU mode isolation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the DOM-flip from firing when placement spreads WebGL wants across surfaces", async () => {
    // Criterion 2's mechanism (docs/architecture/terminal-paint-fabric.md):
    // the count-based DOM-flip is per WebGL manager, and each surface owns
    // its own manager. Flag-off, the 13th WebGL-wanting terminal flips the
    // ENTIRE fleet to DOM; flag-on with round-robin placement, no surface
    // crosses the threshold and the flip never fires.
    const TERMINAL_COUNT = 13;
    const options = { rows: 24, cols: 80, allowProposedApi: true };
    const { TerminalRefreshTier } = await import("@/types");

    // jsdom lacks the media/observer APIs xterm's open() touches.
    window.matchMedia ??= ((query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    const elementProto = Element.prototype as Element & { checkVisibility?: () => boolean };
    elementProto.checkVisibility ??= function checkVisibility() {
      return true;
    };

    const promoteAll = async (service: {
      getOrCreate: (
        id: string,
        agent: undefined,
        options: object
      ) => Promise<{ terminal: unknown }>;
      attach: (id: string, container: HTMLElement) => unknown;
      setVisible: (id: string, visible: boolean) => void;
      applyRendererPolicy: (id: string, tier: number) => void;
      applyAgentPromotion: (id: string, agentId: string) => void;
      getWebGLStateForE2E: (id: string) => { wantsSize: number; mode: string };
    }) => {
      for (let i = 0; i < TERMINAL_COUNT; i += 1) {
        const id = `gpu-${i}`;
        await service.getOrCreate(id, undefined, options);
        const container = document.createElement("div");
        document.body.appendChild(container);
        service.attach(id, container);
        // The production want-registration gates: on-screen + eligible tier
        // + agent promotion (mirrors the E2E promotion bridge).
        service.setVisible(id, true);
        service.applyRendererPolicy(id, TerminalRefreshTier.FOCUSED);
        service.applyAgentPromotion(id, `agent-${i}`);
      }
      // Want registration rides the visibility-restore debounce (100 ms) and
      // rAF-scheduled tier application. Wait for convergence, bounded.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const total = Array.from({ length: TERMINAL_COUNT }, (_, i) =>
          service.getWebGLStateForE2E(`gpu-${i}`)
        ).reduce((max, state) => Math.max(max, state.wantsSize), 0);
        if (total >= Math.ceil(TERMINAL_COUNT / 2)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };

    // Flag-off baseline: one manager, 13 wants → whole-fleet DOM flip.
    vi.stubEnv("DAINTREE_PAINT_FABRIC", "");
    const bare = await importFreshWithPinnedWebglThresholds();
    await promoteAll(bare.terminalInstanceService);
    const bareState = bare.terminalInstanceService.getWebGLStateForE2E("gpu-0");
    bare.terminalInstanceService.dispose();
    document.body.innerHTML = "";

    // Flag-on, two surfaces: round-robin keeps every surface under the
    // threshold - the primary sustains WebGL mode and the flip never fires.
    vi.stubEnv("DAINTREE_PAINT_FABRIC", "1");
    vi.stubEnv("DAINTREE_PAINT_FABRIC_SURFACES", "2");
    const fabric = await importFreshWithPinnedWebglThresholds();
    await promoteAll(fabric.terminalInstanceService);
    const compositor = fabric.terminalInstanceService as InstanceType<
      typeof fabric.PaintFabricCompositor
    >;
    const registry = compositor.getRegistryForTests();
    const primaryIds = registry.placementsFor(fabric.PRIMARY_SURFACE_ID);
    const primaryState = primaryIds.length
      ? fabric.terminalInstanceService.getWebGLStateForE2E(primaryIds[0]!)
      : { wantsSize: -1, active: false, mode: "missing" };

    expect({
      bareWants: bareState.wantsSize,
      bareMode: bareState.mode,
      primaryCount: primaryIds.length,
      primaryWants: primaryState.wantsSize,
      primaryMode: primaryState.mode,
    }).toEqual({
      // Flag-off: the 13th want flips the whole fleet to DOM.
      bareWants: TERMINAL_COUNT,
      bareMode: "dom",
      // Flag-on: placement spreads wants; the primary never crosses the
      // threshold, so the DOM-flip does not fire.
      primaryCount: 7,
      primaryWants: 7,
      primaryMode: "webgl",
    });

    fabric.terminalInstanceService.dispose();
    document.body.innerHTML = "";
  });
});
