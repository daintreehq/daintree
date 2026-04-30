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
    acknowledgePortData: vi.fn(),
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

const mockScrollbackStore = { scrollbackLines: 5000 };
vi.mock("@/store/scrollbackStore", () => ({
  useScrollbackStore: { getState: () => mockScrollbackStore },
}));

const mockPerformanceModeStore = { performanceMode: false };
vi.mock("@/store/performanceModeStore", () => ({
  usePerformanceModeStore: { getState: () => mockPerformanceModeStore },
}));

const mockProjectSettingsStore: { settings: Record<string, unknown> | null } = { settings: null };
vi.mock("@/store/projectSettingsStore", () => ({
  useProjectSettingsStore: { getState: () => mockProjectSettingsStore },
}));

type ScrollbackTestService = {
  instances: Map<string, unknown>;
  reduceScrollback: (id: string, targetLines: number) => void;
  restoreScrollback: (id: string) => void;
  reduceScrollbackAllBackground: (targetLines: number) => void;
};

function makeMockManaged(overrides: Record<string, unknown> = {}) {
  const writtenData: string[] = [];
  const managed = {
    terminal: {
      options: { scrollback: 5000 },
      rows: 24,
      buffer: { active: { length: 3000 } },
      write: (data: string) => writtenData.push(data),
      hasSelection: vi.fn(() => false),
    },
    type: "terminal",
    kind: "terminal",
    isFocused: false,
    isUserScrolledBack: false,
    isAltBuffer: false,
    writtenData,
    ...overrides,
  };
  const runtimeManaged = managed as typeof managed & {
    runtimeAgentId?: string;
    launchAgentId?: string;
  };
  if (
    runtimeManaged.runtimeAgentId === undefined &&
    typeof runtimeManaged.launchAgentId === "string"
  ) {
    runtimeManaged.runtimeAgentId = runtimeManaged.launchAgentId;
  }
  return runtimeManaged;
}

describe("TerminalInstanceService - Scrollback", () => {
  let service: ScrollbackTestService;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockScrollbackStore.scrollbackLines = 5000;
    mockPerformanceModeStore.performanceMode = false;
    mockProjectSettingsStore.settings = null;

    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: ScrollbackTestService;
      });
    service.instances.clear();
  });

  describe("reduceScrollback", () => {
    it("no-ops for unknown terminal ID", () => {
      service.reduceScrollback("nonexistent", 500);
    });

    it("skips focused terminals", () => {
      const managed = makeMockManaged({ isFocused: true });
      service.instances.set("t1", managed);

      service.reduceScrollback("t1", 500);
      expect(managed.terminal.options.scrollback).toBe(5000);
    });

    it("skips user-scrolled-back terminals", () => {
      const managed = makeMockManaged({ isUserScrolledBack: true });
      service.instances.set("t1", managed);

      service.reduceScrollback("t1", 500);
      expect(managed.terminal.options.scrollback).toBe(5000);
    });

    it("skips terminals in alt buffer mode", () => {
      const managed = makeMockManaged({ isAltBuffer: true });
      service.instances.set("t1", managed);

      service.reduceScrollback("t1", 500);
      expect(managed.terminal.options.scrollback).toBe(5000);
      expect(managed.writtenData).toHaveLength(0);
    });

    it("skips terminals with active text selection", () => {
      const managed = makeMockManaged();
      managed.terminal.hasSelection = vi.fn(() => true);
      service.instances.set("t1", managed);

      service.reduceScrollback("t1", 500);
      expect(managed.terminal.options.scrollback).toBe(5000);
      expect(managed.writtenData).toHaveLength(0);
    });

    it("skips when current scrollback already at or below target", () => {
      const managed = makeMockManaged();
      managed.terminal.options.scrollback = 300;
      service.instances.set("t1", managed);

      service.reduceScrollback("t1", 500);
      expect(managed.terminal.options.scrollback).toBe(300);
    });

    it("reduces scrollback and writes notice when scrollback content exceeds target", () => {
      const managed = makeMockManaged();
      // 3000 total - 24 viewport = 2976 scrollback lines > 500 target
      managed.terminal.buffer.active.length = 3000;
      service.instances.set("t1", managed);

      service.reduceScrollback("t1", 500);

      expect(managed.terminal.options.scrollback).toBe(500);
      expect(managed.writtenData).toHaveLength(1);
      expect(managed.writtenData[0]).toContain("Scrollback reduced to 500 lines");
    });

    it("reduces scrollback without notice when scrollback content is within target", () => {
      const managed = makeMockManaged();
      // 100 total - 24 viewport = 76 scrollback lines < 500 target
      managed.terminal.buffer.active.length = 100;
      service.instances.set("t1", managed);

      service.reduceScrollback("t1", 500);

      expect(managed.terminal.options.scrollback).toBe(500);
      expect(managed.writtenData).toHaveLength(0);
    });
  });

  describe("restoreScrollback", () => {
    it("no-ops for unknown terminal ID", () => {
      service.restoreScrollback("nonexistent");
    });

    it("restores to PERFORMANCE_MODE_SCROLLBACK when performance mode is on", () => {
      mockPerformanceModeStore.performanceMode = true;
      const managed = makeMockManaged();
      managed.terminal.options.scrollback = 50;
      service.instances.set("t1", managed);

      service.restoreScrollback("t1");

      // PERFORMANCE_MODE_SCROLLBACK = 100
      expect(managed.terminal.options.scrollback).toBe(100);
    });

    it("restores using getScrollbackForType for normal terminals", () => {
      const managed = makeMockManaged({ type: "terminal" });
      managed.terminal.options.scrollback = 500;
      service.instances.set("t1", managed);

      service.restoreScrollback("t1");

      // getScrollbackForType("terminal", 5000) = min(2000, max(200, floor(5000*0.3))) = 1500
      expect(managed.terminal.options.scrollback).toBe(1500);
    });

    it("uses project-level scrollback override for non-agent terminals", () => {
      mockProjectSettingsStore.settings = { terminalSettings: { scrollbackLines: 2000 } };
      const managed = makeMockManaged({ type: "terminal", kind: "terminal" });
      managed.terminal.options.scrollback = 100;
      service.instances.set("t1", managed);

      service.restoreScrollback("t1");

      // getScrollbackForType("terminal", 2000) = min(2000, max(200, floor(2000*0.3))) = 600
      expect(managed.terminal.options.scrollback).toBe(600);
    });

    it("ignores project override for agent terminals", () => {
      mockProjectSettingsStore.settings = { terminalSettings: { scrollbackLines: 2000 } };
      const managed = makeMockManaged({ kind: "terminal", launchAgentId: "claude" });
      managed.terminal.options.scrollback = 100;
      service.instances.set("t1", managed);

      service.restoreScrollback("t1");

      // getScrollbackForType(true, 5000) = min(5000, max(500, floor(5000*1.5))) = 5000
      expect(managed.terminal.options.scrollback).toBe(5000);
    });
  });

  describe("reduceScrollbackAllBackground", () => {
    it("reduces scrollback on non-focused background terminals", () => {
      const bg1 = makeMockManaged({ isFocused: false });
      bg1.terminal.buffer.active.length = 3000;
      const bg2 = makeMockManaged({ isFocused: false });
      bg2.terminal.buffer.active.length = 3000;
      service.instances.set("t1", bg1);
      service.instances.set("t2", bg2);

      service.reduceScrollbackAllBackground(500);

      expect(bg1.terminal.options.scrollback).toBe(500);
      expect(bg2.terminal.options.scrollback).toBe(500);
    });

    it("skips focused terminals", () => {
      const focused = makeMockManaged({ isFocused: true });
      service.instances.set("t1", focused);

      service.reduceScrollbackAllBackground(500);

      expect(focused.terminal.options.scrollback).toBe(5000);
    });

    it("skips hibernated terminals", () => {
      const hibernated = makeMockManaged({ isHibernated: true });
      service.instances.set("t1", hibernated);

      service.reduceScrollbackAllBackground(500);

      expect(hibernated.terminal.options.scrollback).toBe(5000);
    });

    it("skips active agent terminals but reduces completed agents", () => {
      const working = makeMockManaged({
        kind: "terminal",
        launchAgentId: "claude",
        canonicalAgentState: "working",
      });
      working.terminal.buffer.active.length = 3000;
      const completed = makeMockManaged({
        kind: "terminal",
        launchAgentId: "claude",
        canonicalAgentState: "completed",
      });
      completed.terminal.buffer.active.length = 3000;
      service.instances.set("t1", working);
      service.instances.set("t2", completed);

      service.reduceScrollbackAllBackground(500);

      expect(working.terminal.options.scrollback).toBe(5000);
      expect(completed.terminal.options.scrollback).toBe(500);
    });
  });
});
