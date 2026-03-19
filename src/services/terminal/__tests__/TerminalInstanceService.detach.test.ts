// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("TerminalInstanceService detach blur", () => {
  type DetachTestService = {
    instances: Map<string, unknown>;
    offscreenManager: {
      ensureHiddenContainer: () => HTMLDivElement | null;
      getOffscreenSlot: (id: string) => HTMLDivElement | undefined;
    };
    detach: (id: string, container: HTMLElement | null) => void;
    detachForProjectSwitch: (id: string) => void;
    resizeController: {
      clearResizeJob: (managed: unknown) => void;
      clearSettledTimer: (id: string) => void;
    };
  };

  let service: DetachTestService;

  const makeMockManaged = (id: string) => {
    const hostElement = document.createElement("div");
    return {
      id,
      terminal: {
        blur: vi.fn(),
        buffer: { active: { length: 100 } },
      },
      hostElement,
      isDetached: false,
      isVisible: true,
      lastDetachAt: 0,
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: DetachTestService;
      });
    service.instances.clear();
  });

  afterEach(() => {
    service.instances.clear();
  });

  it("detach() calls terminal.blur()", () => {
    const managed = makeMockManaged("t1");
    const container = document.createElement("div");
    container.appendChild(managed.hostElement);
    service.instances.set("t1", managed);

    vi.spyOn(service.offscreenManager, "getOffscreenSlot").mockReturnValue(undefined);
    vi.spyOn(service.offscreenManager, "ensureHiddenContainer").mockReturnValue(
      document.createElement("div")
    );

    service.detach("t1", container);

    expect(managed.terminal.blur).toHaveBeenCalledTimes(1);
    expect(managed.isDetached).toBe(true);
  });

  it("detachForProjectSwitch() calls terminal.blur()", () => {
    const managed = makeMockManaged("t2");
    const parent = document.createElement("div");
    parent.appendChild(managed.hostElement);
    service.instances.set("t2", managed);

    vi.spyOn(service.offscreenManager, "ensureHiddenContainer").mockReturnValue(
      document.createElement("div")
    );
    vi.spyOn(service.resizeController, "clearResizeJob").mockImplementation(() => {});
    vi.spyOn(service.resizeController, "clearSettledTimer").mockImplementation(() => {});

    service.detachForProjectSwitch("t2");

    expect(managed.terminal.blur).toHaveBeenCalledTimes(1);
    expect(managed.isDetached).toBe(true);
  });
});
