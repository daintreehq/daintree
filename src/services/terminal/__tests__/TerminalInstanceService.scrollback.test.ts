// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logInfo } from "@/utils/logger";
import { TerminalRefreshTier } from "../../../../shared/types/panel";
import { TERMINAL_RETENTION_BUDGETS } from "../../../../shared/config/terminalRetention";
import { getScrollbackForType, setAgentScrollbackMaxLines } from "@/utils/scrollbackConfig";

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

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

type ScrollbackTestService = {
  instances: Map<string, unknown>;
  reduceScrollback: (id: string, targetLines: number) => void;
  restoreScrollback: (id: string) => void;
  restoreScrollbackAllForeground: () => void;
};

function makeMockManaged(overrides: Record<string, unknown> = {}) {
  const writtenData: string[] = [];
  const managed = {
    terminal: {
      options: { scrollback: 5000 },
      rows: 24,
      buffer: { active: { length: 3000 } },
      write: (data: string) => writtenData.push(data),
      resize: vi.fn(),
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

    it("reduces scrollback and logs info without writing to terminal when content exceeds target", () => {
      const managed = makeMockManaged();
      // 3000 total - 24 viewport = 2976 scrollback lines > 500 target
      managed.terminal.buffer.active.length = 3000;
      service.instances.set("t1", managed);

      service.reduceScrollback("t1", 500);

      expect(managed.terminal.options.scrollback).toBe(500);
      expect(managed.writtenData).toHaveLength(0);
      expect(logInfo).toHaveBeenCalledTimes(1);
      expect(logInfo).toHaveBeenCalledWith(
        "Terminal scrollback reduced under memory pressure",
        expect.objectContaining({
          targetLines: 500,
          scrollbackUsed: 2976,
          previousScrollback: 5000,
          rows: 24,
        })
      );
    });

    it("reduces scrollback without logging when scrollback content is within target", () => {
      const managed = makeMockManaged();
      // 100 total - 24 viewport = 76 scrollback lines < 500 target
      managed.terminal.buffer.active.length = 100;
      service.instances.set("t1", managed);

      service.reduceScrollback("t1", 500);

      expect(managed.terminal.options.scrollback).toBe(500);
      expect(managed.writtenData).toHaveLength(0);
      expect(logInfo).not.toHaveBeenCalled();
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

  describe("host retention budgets ↔ renderer policy contract", () => {
    it("the host mirror caps for working/settled tiers match the renderer's agent/plain ceilings", () => {
      // If these drift, a view-eviction restore would silently serve less
      // history than the renderer's own xterm would have retained (working
      // tier), or hold more than the renderer can ever display (settled).
      // getScrollbackForType(_, 0) returns the policy's effective maxLines.
      expect(TERMINAL_RETENTION_BUDGETS.working.mirrorScrollbackLines).toBe(
        getScrollbackForType(true, 0)
      );
      expect(TERMINAL_RETENTION_BUDGETS.settled.mirrorScrollbackLines).toBe(
        getScrollbackForType(false, 0)
      );
    });
  });

  describe("restoreScrollbackAllForeground (resource-profile ceiling changes)", () => {
    afterEach(() => {
      // Module-level policy ceiling — reset to the balanced default so the
      // change can't leak into other tests in this file.
      setAgentScrollbackMaxLines(5000);
    });

    function makeAgentManaged(overrides: Record<string, unknown> = {}) {
      return makeMockManaged({
        kind: "terminal",
        launchAgentId: "claude",
        lastAppliedTier: TerminalRefreshTier.FOCUSED,
        ...overrides,
      });
    }

    it("applies a lowered agent ceiling to foreground agent terminals", () => {
      const managed = makeAgentManaged();
      // Content fits inside the new ceiling → the shrink evicts nothing.
      managed.terminal.buffer.active.length = 100;
      service.instances.set("t1", managed);

      setAgentScrollbackMaxLines(2500);
      service.restoreScrollbackAllForeground();

      expect(managed.terminal.options.scrollback).toBe(2500);
    });

    it("never touches background terminals mid-stream", () => {
      const background = makeAgentManaged({ lastAppliedTier: TerminalRefreshTier.BACKGROUND });
      background.terminal.options.scrollback = 500; // previously reduced
      background.terminal.buffer.active.length = 100;
      const foreground = makeAgentManaged();
      foreground.terminal.buffer.active.length = 100;
      service.instances.set("bg", background);
      service.instances.set("fg", foreground);

      setAgentScrollbackMaxLines(2500);
      service.restoreScrollbackAllForeground();

      // The background pane's deliberately-reduced scrollback stays put (the
      // tier-upgrade path owns its restore); the foreground pane re-derives.
      expect(background.terminal.options.scrollback).toBe(500);
      expect(foreground.terminal.options.scrollback).toBe(2500);
    });

    it("skips hibernated terminals", () => {
      const hibernated = makeAgentManaged({ isHibernated: true });
      hibernated.terminal.options.scrollback = 500;
      service.instances.set("t1", hibernated);

      setAgentScrollbackMaxLines(2500);
      service.restoreScrollbackAllForeground();

      expect(hibernated.terminal.options.scrollback).toBe(500);
    });

    it("defers an evicting shrink on a scrolled-back terminal (no history yanked mid-read)", () => {
      const managed = makeAgentManaged({ isUserScrolledBack: true });
      // 3000 - 24 = 2976 used lines > 2500 target → the shrink would evict.
      managed.terminal.buffer.active.length = 3000;
      service.instances.set("t1", managed);

      setAgentScrollbackMaxLines(2500);
      service.restoreScrollbackAllForeground();

      expect(managed.terminal.options.scrollback).toBe(5000);
    });

    it("defers an evicting shrink while an alt-screen TUI is active (no stateful-TUI reset)", () => {
      const managed = makeAgentManaged({ isAltBuffer: true });
      managed.terminal.buffer.active.length = 3000;
      service.instances.set("t1", managed);

      setAgentScrollbackMaxLines(2500);
      service.restoreScrollbackAllForeground();

      expect(managed.terminal.options.scrollback).toBe(5000);
    });

    it("only rewrites the scrollback option — never writes to or resizes the terminal (no mid-stream rewrap)", () => {
      const shrunk = makeAgentManaged();
      shrunk.terminal.buffer.active.length = 100;
      const grown = makeAgentManaged();
      grown.terminal.options.scrollback = 2500;
      grown.terminal.buffer.active.length = 100;
      service.instances.set("shrunk", shrunk);
      service.instances.set("grown", grown);

      setAgentScrollbackMaxLines(2500);
      service.restoreScrollbackAllForeground();
      setAgentScrollbackMaxLines(5000);
      service.restoreScrollbackAllForeground();

      for (const managed of [shrunk, grown]) {
        expect(managed.writtenData).toHaveLength(0);
        expect(managed.terminal.resize).not.toHaveBeenCalled();
      }
    });
  });
});
