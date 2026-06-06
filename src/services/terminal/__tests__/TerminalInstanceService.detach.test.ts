// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      hoveredLink: null as unknown,
      latestCols: 0,
      latestRows: 0,
      targetCols: undefined as number | undefined,
      targetRows: undefined as number | undefined,
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

  it("detach() clears hoveredLink", () => {
    const managed = makeMockManaged("t3");
    managed.hoveredLink = { text: "https://example.com", range: {}, activate: vi.fn() };
    const container = document.createElement("div");
    container.appendChild(managed.hostElement);
    service.instances.set("t3", managed);

    vi.spyOn(service.offscreenManager, "getOffscreenSlot").mockReturnValue(undefined);
    vi.spyOn(service.offscreenManager, "ensureHiddenContainer").mockReturnValue(
      document.createElement("div")
    );

    service.detach("t3", container);

    expect(managed.hoveredLink).toBeNull();
  });

  it("detachForProjectSwitch() clears hoveredLink", () => {
    const managed = makeMockManaged("t4");
    managed.hoveredLink = { text: "/file.tsx:1:1", range: {}, activate: vi.fn() };
    const parent = document.createElement("div");
    parent.appendChild(managed.hostElement);
    service.instances.set("t4", managed);

    vi.spyOn(service.offscreenManager, "ensureHiddenContainer").mockReturnValue(
      document.createElement("div")
    );
    vi.spyOn(service.resizeController, "clearResizeJob").mockImplementation(() => {});
    vi.spyOn(service.resizeController, "clearSettledTimer").mockImplementation(() => {});

    service.detachForProjectSwitch("t4");

    expect(managed.hoveredLink).toBeNull();
  });

  it("detachForProjectSwitch() backfills target dims from latest geometry when unset (#10070)", () => {
    const managed = makeMockManaged("t5");
    managed.latestCols = 120;
    managed.latestRows = 40;
    const parent = document.createElement("div");
    parent.appendChild(managed.hostElement);
    service.instances.set("t5", managed);

    vi.spyOn(service.offscreenManager, "ensureHiddenContainer").mockReturnValue(
      document.createElement("div")
    );
    vi.spyOn(service.resizeController, "clearResizeJob").mockImplementation(() => {});
    vi.spyOn(service.resizeController, "clearSettledTimer").mockImplementation(() => {});

    service.detachForProjectSwitch("t5");

    // Background-tier resizes only update latest dims; the warm-attach path
    // needs target dims, so detach must seed them so reattach paints at size.
    expect(managed.targetCols).toBe(120);
    expect(managed.targetRows).toBe(40);
  });

  it("detachForProjectSwitch() preserves existing target dims (#10070)", () => {
    const managed = makeMockManaged("t6");
    managed.latestCols = 120;
    managed.latestRows = 40;
    managed.targetCols = 100;
    managed.targetRows = 30;
    const parent = document.createElement("div");
    parent.appendChild(managed.hostElement);
    service.instances.set("t6", managed);

    vi.spyOn(service.offscreenManager, "ensureHiddenContainer").mockReturnValue(
      document.createElement("div")
    );
    vi.spyOn(service.resizeController, "clearResizeJob").mockImplementation(() => {});
    vi.spyOn(service.resizeController, "clearSettledTimer").mockImplementation(() => {});

    service.detachForProjectSwitch("t6");

    // An explicit saved target (e.g. from setTargetSize) must not be clobbered.
    expect(managed.targetCols).toBe(100);
    expect(managed.targetRows).toBe(30);
  });

  it("detachForProjectSwitch() leaves target dims unset when no geometry was measured (#10070)", () => {
    const managed = makeMockManaged("t7");
    // latestCols/latestRows stay 0 — terminal was never measured.
    const parent = document.createElement("div");
    parent.appendChild(managed.hostElement);
    service.instances.set("t7", managed);

    vi.spyOn(service.offscreenManager, "ensureHiddenContainer").mockReturnValue(
      document.createElement("div")
    );
    vi.spyOn(service.resizeController, "clearResizeJob").mockImplementation(() => {});
    vi.spyOn(service.resizeController, "clearSettledTimer").mockImplementation(() => {});

    service.detachForProjectSwitch("t7");

    // A 0-width backfill would poison the cold-seed resize before open().
    expect(managed.targetCols).toBeUndefined();
    expect(managed.targetRows).toBeUndefined();
  });
});
