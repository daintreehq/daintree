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
    imageAddon: {},
    searchAddon: {},
    fileLinksDisposable: { dispose: vi.fn() },
  })),
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

interface MockMarker {
  line: number;
  isDisposed: boolean;
  dispose: ReturnType<typeof vi.fn>;
}

interface MockTerminal {
  scrollToBottom: ReturnType<typeof vi.fn>;
  scrollToLine: ReturnType<typeof vi.fn>;
  registerMarker: ReturnType<typeof vi.fn>;
  buffer: { active: { viewportY: number; baseY: number; type: string } };
  write: (data: string | Uint8Array, cb?: () => void) => void;
}

interface MockManaged {
  terminal: MockTerminal;
  lastActivityMarker?: MockMarker;
  isAltBuffer?: boolean;
  isSerializedRestoreInProgress: boolean;
  isUserScrolledBack: boolean;
  pendingWrites?: number;
}

type LastActivityTestService = {
  instances: Map<string, unknown>;
  scrollToLastActivity: (id: string) => void;
  scrollToBottom: (id: string) => void;
  writeToTerminal: (id: string, data: string | Uint8Array) => void;
};

function makeMockMarker(overrides: Partial<MockMarker> = {}): MockMarker {
  return {
    line: 100,
    isDisposed: false,
    dispose: vi.fn(),
    ...overrides,
  };
}

function makeMockManaged(overrides: Partial<MockManaged> = {}): MockManaged {
  return {
    terminal: {
      scrollToBottom: vi.fn(),
      scrollToLine: vi.fn(),
      registerMarker: vi.fn(() => makeMockMarker()),
      buffer: { active: { viewportY: 0, baseY: 200, type: "normal" } },
      write: (_data: string | Uint8Array, cb?: () => void) => {
        if (cb) cb();
      },
    },
    isAltBuffer: false,
    isSerializedRestoreInProgress: false,
    isUserScrolledBack: false,
    ...overrides,
  };
}

describe("TerminalInstanceService - scrollToLastActivity", () => {
  let service: LastActivityTestService;

  beforeEach(async () => {
    vi.clearAllMocks();

    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: LastActivityTestService;
      });
    service.instances.clear();
  });

  it("falls back to scrollToBottom when no marker exists", () => {
    const managed = makeMockManaged();
    service.instances.set("t1", managed);

    service.scrollToLastActivity("t1");

    expect(managed.terminal.scrollToBottom).toHaveBeenCalled();
    expect(managed.terminal.scrollToLine).not.toHaveBeenCalled();
  });

  it("falls back to scrollToBottom when marker is disposed", () => {
    const marker = makeMockMarker({ isDisposed: true });
    const managed = makeMockManaged({ lastActivityMarker: marker });
    service.instances.set("t1", managed);

    service.scrollToLastActivity("t1");

    expect(managed.terminal.scrollToBottom).toHaveBeenCalled();
    expect(managed.terminal.scrollToLine).not.toHaveBeenCalled();
  });

  it("falls back to scrollToBottom when marker line is -1", () => {
    const marker = makeMockMarker({ line: -1 });
    const managed = makeMockManaged({ lastActivityMarker: marker });
    service.instances.set("t1", managed);

    service.scrollToLastActivity("t1");

    expect(managed.terminal.scrollToBottom).toHaveBeenCalled();
    expect(managed.terminal.scrollToLine).not.toHaveBeenCalled();
  });

  it("scrolls to marker line when marker is valid", () => {
    const marker = makeMockMarker({ line: 150 });
    const managed = makeMockManaged({ lastActivityMarker: marker });
    managed.terminal.buffer.active.viewportY = 0;
    service.instances.set("t1", managed);

    service.scrollToLastActivity("t1");

    expect(managed.terminal.scrollToLine).toHaveBeenCalledWith(150);
    expect(managed.terminal.scrollToBottom).not.toHaveBeenCalled();
  });

  it("falls back to scrollToBottom when viewport is already near marker", () => {
    const marker = makeMockMarker({ line: 100 });
    const managed = makeMockManaged({ lastActivityMarker: marker });
    managed.terminal.buffer.active.viewportY = 101;
    service.instances.set("t1", managed);

    service.scrollToLastActivity("t1");

    expect(managed.terminal.scrollToBottom).toHaveBeenCalled();
    expect(managed.terminal.scrollToLine).not.toHaveBeenCalled();
  });

  it("no-ops for unknown terminal ID", () => {
    service.scrollToLastActivity("nonexistent");
    // Should not throw
  });
});

describe("TerminalInstanceService - lastActivityMarker write tracking", () => {
  let service: LastActivityTestService;

  beforeEach(async () => {
    vi.clearAllMocks();

    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: LastActivityTestService;
      });
    service.instances.clear();
  });

  it("disposes previous marker before creating new one", () => {
    const oldMarker = makeMockMarker();
    const newMarker = makeMockMarker({ line: 200 });

    const managed = makeMockManaged({
      lastActivityMarker: oldMarker,
    });
    managed.terminal.registerMarker = vi.fn(() => newMarker);
    service.instances.set("t1", managed);

    // Use the service's writeToTerminal to trigger the marker-update callback
    (service as unknown as { writeToTerminal: (id: string, data: string) => void }).writeToTerminal(
      "t1",
      "test"
    );

    expect(oldMarker.dispose).toHaveBeenCalled();
  });

  it("does not update marker when in alt buffer mode", () => {
    const marker = makeMockMarker();
    const managed = makeMockManaged({
      isAltBuffer: true,
      lastActivityMarker: marker,
    });
    service.instances.set("t1", managed);

    (service as unknown as { writeToTerminal: (id: string, data: string) => void }).writeToTerminal(
      "t1",
      "test"
    );

    expect(marker.dispose).not.toHaveBeenCalled();
    expect(managed.terminal.registerMarker).not.toHaveBeenCalled();
  });
});
