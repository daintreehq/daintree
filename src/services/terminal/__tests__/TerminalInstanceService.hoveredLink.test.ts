// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notify } from "@/lib/notify";
import { terminalInstanceService } from "../TerminalInstanceService";

vi.mock("@/lib/notify", () => ({
  notify: vi.fn(),
}));

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

describe("TerminalInstanceService hovered link API", () => {
  const service = terminalInstanceService as unknown as {
    instances: Map<string, unknown>;
    getHoveredLinkText: (id: string) => string | null;
    getHoveredFilePath: (id: string) => string | null;
    openHoveredLink: (id: string, event?: MouseEvent) => Promise<void>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
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

  it("getHoveredFilePath returns null when terminal is missing", () => {
    expect(service.getHoveredFilePath("missing")).toBeNull();
  });

  it("getHoveredFilePath returns the absolute path for a file link", () => {
    const link = {
      kind: "file",
      text: "./src/x.ts",
      absolutePath: "/repo/src/x.ts",
      range: {},
      activate: vi.fn(),
    };
    service.instances.set("t1", { hoveredLink: link });
    expect(service.getHoveredFilePath("t1")).toBe("/repo/src/x.ts");
  });

  it("getHoveredFilePath returns null for a URL link (not a file)", () => {
    const link = { kind: "url", text: "https://example.com", range: {}, activate: vi.fn() };
    service.instances.set("t1", { hoveredLink: link });
    expect(service.getHoveredFilePath("t1")).toBeNull();
  });

  it("openHoveredLink delegates to the link's activate() with link.text", async () => {
    const activate = vi.fn();
    const link = { text: "https://example.com", range: {}, activate };
    service.instances.set("t1", { hoveredLink: link });

    await service.openHoveredLink("t1");

    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate.mock.calls[0]?.[1]).toBe("https://example.com");
    expect(activate.mock.calls[0]?.[0]).toBeInstanceOf(MouseEvent);
  });

  it("openHoveredLink forwards a provided event", async () => {
    const activate = vi.fn();
    const link = { text: "https://example.com", range: {}, activate };
    service.instances.set("t1", { hoveredLink: link });
    const event = new MouseEvent("click", { metaKey: true });

    await service.openHoveredLink("t1", event);

    expect(activate).toHaveBeenCalledWith(event, "https://example.com");
  });

  it("openHoveredLink is a no-op when no link is hovered", async () => {
    service.instances.set("t1", { hoveredLink: null });
    await expect(service.openHoveredLink("t1")).resolves.toBeUndefined();
  });

  it("openHoveredLink surfaces sync throws from activate() via notify() (#9925)", async () => {
    const link = {
      text: "x",
      range: {},
      activate: vi.fn(() => {
        throw new Error("boom");
      }),
    };
    service.instances.set("t1", { hoveredLink: link });

    await expect(service.openHoveredLink("t1")).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(notify).mock.calls[0]?.[0] as {
      type: string;
      title: string;
      message: string;
    };
    expect(payload.type).toBe("error");
    expect(payload.title).toBe("Couldn't open file link");
    expect(payload.message).toContain("boom");
  });

  it("openHoveredLink surfaces async rejections from activate() via notify() (#9925)", async () => {
    const link = {
      text: "/Users/me/project/src/secret.txt",
      range: {},
      activate: vi.fn(() => Promise.reject(new Error("async boom"))),
    };
    service.instances.set("t1", { hoveredLink: link });

    await service.openHoveredLink("t1");

    expect(notify).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(notify).mock.calls[0]?.[0] as {
      type: string;
      title: string;
      message: string;
      action?: { label: string; onClick?: () => void };
    };
    expect(payload.type).toBe("error");
    expect(payload.title).toBe("Couldn't open file link");
    expect(payload.message).toContain("async boom");
    expect(payload.message).toContain("secret.txt");
    expect(payload.action?.label).toBe("Copy path");
  });
});
