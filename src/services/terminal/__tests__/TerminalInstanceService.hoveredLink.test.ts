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

describe("TerminalInstanceService hovered link API", () => {
  type HoveredLinkTestService = {
    instances: Map<string, unknown>;
    getHoveredLinkText: (id: string) => string | null;
    openHoveredLink: (id: string, event?: MouseEvent) => void;
  };

  let service: HoveredLinkTestService;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ terminalInstanceService: service } =
      (await import("../TerminalInstanceService")) as unknown as {
        terminalInstanceService: HoveredLinkTestService;
      });
    service.instances.clear();
  });

  afterEach(() => {
    service.instances.clear();
  });

  it("getHoveredLinkText returns null when terminal is missing", () => {
    expect(service.getHoveredLinkText("missing")).toBeNull();
  });

  it("getHoveredLinkText returns null when no link is hovered", () => {
    service.instances.set("t1", { hoveredLink: null });
    expect(service.getHoveredLinkText("t1")).toBeNull();
  });

  it("getHoveredLinkText returns the text of the currently hovered link", () => {
    const link = { text: "https://example.com", range: {}, activate: vi.fn() };
    service.instances.set("t1", { hoveredLink: link });
    expect(service.getHoveredLinkText("t1")).toBe("https://example.com");
  });

  it("openHoveredLink delegates to the link's activate() with link.text", () => {
    const activate = vi.fn();
    const link = { text: "https://example.com", range: {}, activate };
    service.instances.set("t1", { hoveredLink: link });

    service.openHoveredLink("t1");

    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate.mock.calls[0]?.[1]).toBe("https://example.com");
    expect(activate.mock.calls[0]?.[0]).toBeInstanceOf(MouseEvent);
  });

  it("openHoveredLink forwards a provided event", () => {
    const activate = vi.fn();
    const link = { text: "https://example.com", range: {}, activate };
    service.instances.set("t1", { hoveredLink: link });
    const event = new MouseEvent("click", { metaKey: true });

    service.openHoveredLink("t1", event);

    expect(activate).toHaveBeenCalledWith(event, "https://example.com");
  });

  it("openHoveredLink is a no-op when no link is hovered", () => {
    service.instances.set("t1", { hoveredLink: null });
    expect(() => service.openHoveredLink("t1")).not.toThrow();
  });

  it("openHoveredLink swallows errors thrown by activate()", () => {
    const link = {
      text: "x",
      range: {},
      activate: vi.fn(() => {
        throw new Error("boom");
      }),
    };
    service.instances.set("t1", { hoveredLink: link });
    expect(() => service.openHoveredLink("t1")).not.toThrow();
  });
});
