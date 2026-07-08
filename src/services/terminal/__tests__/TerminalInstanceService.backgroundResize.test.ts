// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedTerminal } from "../types";

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

type BackgroundResizeTestService = {
  instances: Map<string, ManagedTerminal>;
  applyBackgroundWindowResize: (width: number, height: number) => void;
  resetBackgroundResizeBasis: () => void;
  resizeController: {
    resizePtyOnly: (
      id: string,
      width: number,
      height: number
    ) => { cols: number; rows: number } | null;
  };
};

function makeManaged(overrides: Partial<ManagedTerminal> = {}): ManagedTerminal {
  return {
    isOpened: true,
    lastWidth: 800,
    lastHeight: 600,
    ...overrides,
  } as ManagedTerminal;
}

function setViewport(width: number, height: number, visibility: "visible" | "hidden") {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
  Object.defineProperty(document, "visibilityState", { value: visibility, configurable: true });
}

describe("TerminalInstanceService applyBackgroundWindowResize", () => {
  let service: BackgroundResizeTestService;
  let resizePtyOnlySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: BackgroundResizeTestService;
      });
    service.instances.clear();
    service.resetBackgroundResizeBasis();
    resizePtyOnlySpy = vi
      .spyOn(service.resizeController, "resizePtyOnly")
      .mockReturnValue(null) as ReturnType<typeof vi.spyOn>;
    setViewport(1000, 700, "hidden");
  });

  afterEach(() => {
    service.instances.clear();
    vi.restoreAllMocks();
  });

  it("scales each terminal's last measured size by the window-bounds ratio", () => {
    service.instances.set("a", makeManaged({ lastWidth: 800, lastHeight: 600 }));
    service.instances.set("b", makeManaged({ lastWidth: 400, lastHeight: 300 }));

    service.applyBackgroundWindowResize(1200, 840);

    expect(resizePtyOnlySpy).toHaveBeenCalledTimes(2);
    expect(resizePtyOnlySpy).toHaveBeenCalledWith("a", 800 * 1.2, 600 * 1.2);
    expect(resizePtyOnlySpy).toHaveBeenCalledWith("b", 400 * 1.2, 300 * 1.2);
  });

  it("no-ops when the document is visible — real layout owns geometry", () => {
    setViewport(1000, 700, "visible");
    service.instances.set("a", makeManaged());

    service.applyBackgroundWindowResize(1200, 840);

    expect(resizePtyOnlySpy).not.toHaveBeenCalled();
  });

  it("anchors repeated resizes to the session origin — targets are absolute, never compounded", () => {
    service.instances.set("a", makeManaged({ lastWidth: 800, lastHeight: 600 }));

    service.applyBackgroundWindowResize(1200, 840);
    service.applyBackgroundWindowResize(1500, 700);

    // Both events scale the captured 800x600 origin against the 1000x700
    // viewport snapshot, regardless of what earlier events applied.
    expect(resizePtyOnlySpy).toHaveBeenNthCalledWith(1, "a", 800 * 1.2, 600 * 1.2);
    expect(resizePtyOnlySpy).toHaveBeenNthCalledWith(2, "a", 800 * 1.5, 600 * 1.0);
  });

  it("a terminal skipped in one pass still lands on the correct absolute size in the next", () => {
    const managed = makeManaged({ lastWidth: 800, lastHeight: 600 });
    service.instances.set("a", managed);

    // First pass skipped (e.g. resize-locked) — resizePtyOnly returns null
    // and lastWidth is untouched. The origin snapshot must keep the second
    // pass anchored to the original viewport, not an advanced basis.
    service.applyBackgroundWindowResize(1200, 840);
    service.applyBackgroundWindowResize(1500, 1400);

    expect(resizePtyOnlySpy).toHaveBeenLastCalledWith("a", 800 * 1.5, 600 * 2.0);
  });

  it("resetBackgroundResizeBasis restores the live viewport as the basis", () => {
    service.instances.set("a", makeManaged({ lastWidth: 800, lastHeight: 600 }));

    service.applyBackgroundWindowResize(1200, 840);
    service.resetBackgroundResizeBasis();
    service.applyBackgroundWindowResize(1300, 770);

    expect(resizePtyOnlySpy).toHaveBeenLastCalledWith("a", 800 * 1.3, 600 * 1.1);
  });

  it("a visible-state delivery resets the basis for the next background session", () => {
    service.instances.set("a", makeManaged({ lastWidth: 800, lastHeight: 600 }));

    service.applyBackgroundWindowResize(1200, 840);
    setViewport(1000, 700, "visible");
    service.applyBackgroundWindowResize(1200, 840);
    setViewport(1000, 700, "hidden");
    service.applyBackgroundWindowResize(1300, 770);

    expect(resizePtyOnlySpy).toHaveBeenLastCalledWith("a", 800 * 1.3, 600 * 1.1);
  });

  it("skips unopened and never-measured terminals", () => {
    service.instances.set("unopened", makeManaged({ isOpened: false }));
    service.instances.set("unmeasured", makeManaged({ lastWidth: 0, lastHeight: 0 }));
    service.instances.set("eligible", makeManaged());

    service.applyBackgroundWindowResize(1200, 840);

    expect(resizePtyOnlySpy).toHaveBeenCalledTimes(1);
    expect(resizePtyOnlySpy).toHaveBeenCalledWith(
      "eligible",
      expect.any(Number),
      expect.any(Number)
    );
  });

  it("ignores non-finite and non-positive bounds", () => {
    service.instances.set("a", makeManaged());

    service.applyBackgroundWindowResize(Number.NaN, 840);
    service.applyBackgroundWindowResize(1200, Number.POSITIVE_INFINITY);
    service.applyBackgroundWindowResize(0, 840);
    service.applyBackgroundWindowResize(-100, 840);

    expect(resizePtyOnlySpy).not.toHaveBeenCalled();
  });

  it("invalid bounds do not corrupt the session for a following valid event", () => {
    service.instances.set("a", makeManaged({ lastWidth: 800, lastHeight: 600 }));

    service.applyBackgroundWindowResize(0, 0);
    service.applyBackgroundWindowResize(1200, 840);

    expect(resizePtyOnlySpy).toHaveBeenCalledWith("a", 800 * 1.2, 600 * 1.2);
  });

  it("captures the origin for a terminal measured only after the session started", () => {
    const managed = makeManaged({ lastWidth: 0, lastHeight: 0 });
    service.instances.set("late", managed);

    service.applyBackgroundWindowResize(1200, 840);
    expect(resizePtyOnlySpy).not.toHaveBeenCalled();

    managed.lastWidth = 500;
    managed.lastHeight = 400;
    service.applyBackgroundWindowResize(1500, 700);

    expect(resizePtyOnlySpy).toHaveBeenCalledWith("late", 500 * 1.5, 400 * 1.0);
  });

  it("no-ops when the stale viewport reports zero dimensions", () => {
    setViewport(0, 0, "hidden");
    service.instances.set("a", makeManaged());

    service.applyBackgroundWindowResize(1200, 840);

    expect(resizePtyOnlySpy).not.toHaveBeenCalled();
  });
});
