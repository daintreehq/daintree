// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/clients", () => ({
  terminalClient: {
    resize: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
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
    imageAddon: {},
    searchAddon: {},
    fileLinksDisposable: { dispose: vi.fn() },
    webLinksAddon: { dispose: vi.fn() },
  })),
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

import { terminalInstanceService as service } from "../TerminalInstanceService";

describe("TerminalInstanceService - user input epoch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.destroy("t1");
    service.destroy("t2");
  });

  afterEach(() => {
    service.destroy("t1");
    service.destroy("t2");
  });

  it("advances on input the user sent, per terminal", () => {
    expect(service.getUserInputEpoch("t1")).toBe(0);
    service.notifyUserInput("t1");
    service.notifyUserInput("t1", "x");
    expect(service.getUserInputEpoch("t1")).toBe(2);
    expect(service.getUserInputEpoch("t2")).toBe(0);
  });

  it("stays put for a path a drop typed in on its own", () => {
    service.notifyUserInput("t1", "", { automatic: true });
    expect(service.getUserInputEpoch("t1")).toBe(0);
  });

  it("stays put for a terminal reply or mouse report relayed as input", () => {
    // What a fleet follower is told when the origin's xterm answers a query.
    service.notifyUserInput("t1", "\x1b[12;4R");
    service.notifyUserInput("t1", "\x1b[<0;10;5M");
    expect(service.getUserInputEpoch("t1")).toBe(0);
  });

  it("forgets a terminal once it is destroyed", () => {
    service.notifyUserInput("t1");
    service.destroy("t1");
    expect(service.getUserInputEpoch("t1")).toBe(0);
  });
});
