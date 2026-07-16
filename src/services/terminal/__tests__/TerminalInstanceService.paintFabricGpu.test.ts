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
  // Pin the whole-fleet WebGL flip thresholds so this test's count logic — the
  // 13th want crosses a single surface's threshold; a round-robin split keeps
  // each surface under it — is independent of the RAM-tiered bootstrap default.
  // resetModules() re-seeds that default from system memory (now 18/15), which
  // would otherwise let all 13 wants stay in WebGL. 12/10 restores the "13th
  // flips" boundary this scenario was written around.
  const webglConfigModule = await import("../TerminalWebGLConfig");
  webglConfigModule.setWebglThresholds(12, 10);
  return {
    terminalInstanceService: serviceModule.terminalInstanceService,
    PaintFabricCompositor: compositorModule.PaintFabricCompositor,
    PRIMARY_SURFACE_ID: configModule.PRIMARY_SURFACE_ID,
    MAX_PAINT_FABRIC_SURFACES: configModule.MAX_PAINT_FABRIC_SURFACES,
    paintFabricAuxSurfaceId: configModule.paintFabricAuxSurfaceId,
    terminalClient: clientsModule.terminalClient,
  };
}

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
    const bare = await importFresh();
    await promoteAll(bare.terminalInstanceService);
    const bareState = bare.terminalInstanceService.getWebGLStateForE2E("gpu-0");
    bare.terminalInstanceService.dispose();
    document.body.innerHTML = "";

    // Flag-on, two surfaces: round-robin keeps every surface under the
    // threshold - the primary sustains WebGL mode and the flip never fires.
    vi.stubEnv("DAINTREE_PAINT_FABRIC", "1");
    vi.stubEnv("DAINTREE_PAINT_FABRIC_SURFACES", "2");
    const fabric = await importFresh();
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
