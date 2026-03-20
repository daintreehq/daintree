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

interface MockManaged {
  terminal: {
    buffer: { active: { baseY: number; viewportY: number } };
    scrollToBottom: ReturnType<typeof vi.fn>;
  };
  isUserScrolledBack: boolean;
  isAltBuffer: boolean;
  latestWasAtBottom: boolean;
  _suppressScrollTracking?: boolean;
  _userScrollIntent?: boolean;
  hostElement: HTMLDivElement;
  listeners: Array<() => void>;
}

type ViewportTestService = {
  instances: Map<string, MockManaged>;
  scrollToBottom: (id: string) => void;
  resumeAutoScroll: (id: string) => void;
};

function makeMockManaged(overrides: Partial<MockManaged> = {}): MockManaged {
  const hostElement = document.createElement("div");
  return {
    terminal: {
      buffer: { active: { baseY: 100, viewportY: 100 } },
      scrollToBottom: vi.fn(),
    },
    isUserScrolledBack: false,
    isAltBuffer: false,
    latestWasAtBottom: true,
    hostElement,
    listeners: [],
    ...overrides,
  };
}

describe("TerminalInstanceService - Viewport Pinning", () => {
  let service: ViewportTestService;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: ViewportTestService;
      });
    service.instances.clear();
  });

  describe("scrollToBottom suppression flag", () => {
    it("sets _suppressScrollTracking during scrollToBottom and clears after", () => {
      const managed = makeMockManaged({ isUserScrolledBack: true });
      service.instances.set("t1", managed);

      service.scrollToBottom("t1");

      expect(managed.terminal.scrollToBottom).toHaveBeenCalled();
      expect(managed._suppressScrollTracking).toBe(false);
      expect(managed.isUserScrolledBack).toBe(false);
      expect(managed.latestWasAtBottom).toBe(true);
    });

    it("clears _suppressScrollTracking even if scrollToBottom throws", () => {
      const managed = makeMockManaged();
      managed.terminal.scrollToBottom.mockImplementation(() => {
        throw new Error("boom");
      });
      service.instances.set("t1", managed);

      expect(() => service.scrollToBottom("t1")).toThrow("boom");
      expect(managed._suppressScrollTracking).toBe(false);
    });
  });

  describe("resumeAutoScroll", () => {
    it("resets isUserScrolledBack and scrolls to bottom", () => {
      const managed = makeMockManaged({ isUserScrolledBack: true });
      service.instances.set("t1", managed);

      service.resumeAutoScroll("t1");

      expect(managed.isUserScrolledBack).toBe(false);
      expect(managed.terminal.scrollToBottom).toHaveBeenCalled();
    });
  });
});
