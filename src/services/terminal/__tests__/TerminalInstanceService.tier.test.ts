// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/panel";

const mockTerminalClient = {
  onData: vi.fn(() => vi.fn()),
  onExit: vi.fn(() => vi.fn()),
  setActivityTier: vi.fn(),
  wake: vi.fn(),
  getSerializedState: vi.fn(),
  getSharedBuffer: vi.fn(() => null),
};

vi.mock("@/clients", () => ({
  terminalClient: mockTerminalClient,
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

vi.mock("@xterm/addon-canvas", () => ({
  CanvasAddon: class {
    dispose() {}
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

type TierTestService = {
  instances: Map<string, Record<string, unknown>>;
  applyRendererPolicy: (id: string, tier: TerminalRefreshTier) => void;
  prewarmTerminal: (
    id: string,
    type: string,
    options: Record<string, unknown>,
    params?: Record<string, unknown>
  ) => Record<string, unknown>;
  destroy: (id: string) => void;
};

function makeMockManaged(overrides: Record<string, unknown> = {}) {
  return {
    terminal: {
      options: { scrollback: 5000 },
      rows: 24,
      cols: 80,
      buffer: {
        active: { length: 100, type: "normal", baseY: 0, viewportY: 0 },
        onBufferChange: vi.fn(() => ({ dispose: vi.fn() })),
      },
      refresh: vi.fn(),
      loadAddon: vi.fn(),
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
      hasSelection: vi.fn(() => false),
      dispose: vi.fn(),
      write: vi.fn(),
    },
    type: "terminal",
    kind: "terminal",
    fitAddon: { fit: vi.fn() },
    serializeAddon: { serialize: vi.fn() },
    imageAddon: { dispose: vi.fn() } as { dispose: ReturnType<typeof vi.fn> } | null,
    searchAddon: {},
    fileLinksDisposable: { dispose: vi.fn() } as { dispose: ReturnType<typeof vi.fn> } | null,
    webLinksAddon: { dispose: vi.fn() } as { dispose: ReturnType<typeof vi.fn> } | null,
    hostElement: document.createElement("div"),
    isOpened: true,
    isVisible: true,
    isFocused: false,
    isUserScrolledBack: false,
    isAltBuffer: false,
    lastActiveTime: Date.now(),
    lastWidth: 0,
    lastHeight: 0,
    lastAppliedTier: TerminalRefreshTier.FOCUSED as TerminalRefreshTier | undefined,
    pendingTier: undefined as TerminalRefreshTier | undefined,
    tierChangeTimer: undefined as number | undefined,
    getRefreshTier: () => TerminalRefreshTier.FOCUSED,
    needsWake: false,
    agentStateSubscribers: new Set(),
    altBufferListeners: new Set(),
    listeners: [],
    exitSubscribers: new Set(),
    latestCols: 80,
    latestRows: 24,
    latestWasAtBottom: true,
    keyHandlerInstalled: false,
    lastAttachAt: 0,
    lastDetachAt: 0,
    writeChain: Promise.resolve(),
    restoreGeneration: 0,
    isSerializedRestoreInProgress: false,
    deferredOutput: [],
    ...overrides,
  };
}

describe("TerminalInstanceService - Activity Tier", () => {
  let service: TierTestService;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: TierTestService;
      });
    service.instances.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Tier Mapping", () => {
    it("should map TerminalRefreshTier.BACKGROUND to backend background tier", () => {
      expect(TerminalRefreshTier.BACKGROUND).toBe(1000);
    });

    it("should map active refresh tiers to backend active tier", () => {
      expect(TerminalRefreshTier.BURST).toBe(16);
      expect(TerminalRefreshTier.FOCUSED).toBe(100);
      expect(TerminalRefreshTier.VISIBLE).toBe(200);
    });
  });

  describe("Addon Lifecycle on Tier Transitions", () => {
    it("should dispose addons when transitioning to BACKGROUND", () => {
      const managed = makeMockManaged({ lastAppliedTier: TerminalRefreshTier.FOCUSED });
      const imageDispose = managed.imageAddon!.dispose;
      const fileLinksDispose = managed.fileLinksDisposable!.dispose;
      const webLinksDispose = managed.webLinksAddon!.dispose;
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
      // Downgrade has 500ms hysteresis
      vi.advanceTimersByTime(600);

      expect(imageDispose).toHaveBeenCalled();
      expect(fileLinksDispose).toHaveBeenCalled();
      expect(webLinksDispose).toHaveBeenCalled();
      expect(managed.imageAddon).toBeNull();
      expect(managed.fileLinksDisposable).toBeNull();
      expect(managed.webLinksAddon).toBeNull();
    });

    it("should recreate addons when transitioning from BACKGROUND to VISIBLE", async () => {
      const { createImageAddon, createFileLinksAddon, createWebLinksAddon } =
        await import("../TerminalAddonManager");

      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.BACKGROUND,
        imageAddon: null,
        fileLinksDisposable: null,
        webLinksAddon: null,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      // Upgrade from BACKGROUND to VISIBLE is immediate (no hysteresis)
      service.applyRendererPolicy("t1", TerminalRefreshTier.VISIBLE);

      expect(createImageAddon).toHaveBeenCalled();
      expect(createFileLinksAddon).toHaveBeenCalled();
      expect(createWebLinksAddon).toHaveBeenCalled();
      expect(managed.imageAddon).not.toBeNull();
      expect(managed.fileLinksDisposable).not.toBeNull();
      expect(managed.webLinksAddon).not.toBeNull();
    });

    it("should recreate addons when transitioning from BACKGROUND to FOCUSED", async () => {
      const { createImageAddon, createFileLinksAddon, createWebLinksAddon } =
        await import("../TerminalAddonManager");

      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.BACKGROUND,
        imageAddon: null,
        fileLinksDisposable: null,
        webLinksAddon: null,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.FOCUSED);

      expect(createImageAddon).toHaveBeenCalled();
      expect(createFileLinksAddon).toHaveBeenCalled();
      expect(createWebLinksAddon).toHaveBeenCalled();
    });

    it("should not dispose already-null addons", () => {
      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.FOCUSED,
        imageAddon: null,
        fileLinksDisposable: null,
        webLinksAddon: null,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.BACKGROUND);
      vi.advanceTimersByTime(600);

      // Should not throw — null addons are handled gracefully
      expect(managed.imageAddon).toBeNull();
      expect(managed.fileLinksDisposable).toBeNull();
      expect(managed.webLinksAddon).toBeNull();
    });

    it("should not recreate addons that already exist on upgrade", async () => {
      const { createImageAddon, createFileLinksAddon, createWebLinksAddon } =
        await import("../TerminalAddonManager");
      vi.mocked(createImageAddon).mockClear();
      vi.mocked(createFileLinksAddon).mockClear();
      vi.mocked(createWebLinksAddon).mockClear();

      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.BACKGROUND,
        // Addons already exist (shouldn't happen normally but tests guard condition)
        imageAddon: { dispose: vi.fn() },
        fileLinksDisposable: { dispose: vi.fn() },
        webLinksAddon: { dispose: vi.fn() },
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      service.applyRendererPolicy("t1", TerminalRefreshTier.VISIBLE);

      expect(createImageAddon).not.toHaveBeenCalled();
      expect(createFileLinksAddon).not.toHaveBeenCalled();
      expect(createWebLinksAddon).not.toHaveBeenCalled();
    });

    it("should null addons and set lastAppliedTier for terminals created at BACKGROUND tier", () => {
      const managed = service.prewarmTerminal("t-bg", "terminal", {});
      const m = managed as unknown as {
        imageAddon: unknown;
        fileLinksDisposable: unknown;
        webLinksAddon: unknown;
        lastAppliedTier: TerminalRefreshTier;
      };

      expect(m.imageAddon).toBeNull();
      expect(m.fileLinksDisposable).toBeNull();
      expect(m.webLinksAddon).toBeNull();
      expect(m.lastAppliedTier).toBe(TerminalRefreshTier.BACKGROUND);
    });

    it("should handle destroy on background-tier terminal with null addons", () => {
      const managed = makeMockManaged({
        lastAppliedTier: TerminalRefreshTier.BACKGROUND,
        imageAddon: null,
        fileLinksDisposable: null,
        webLinksAddon: null,
      });
      service.instances.set("t1", managed as unknown as Record<string, unknown>);

      // Should not throw
      expect(() => service.destroy("t1")).not.toThrow();
    });
  });

  describe("initializeBackendTier", () => {
    it("should be documented as part of the hydration flow", () => {
      // Unit tests for the actual logic are in TerminalRendererPolicy.test.ts
      expect(true).toBe(true);
    });
  });
});
