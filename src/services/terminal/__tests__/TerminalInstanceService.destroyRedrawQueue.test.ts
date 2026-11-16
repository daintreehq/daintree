// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { TerminalRefreshTier } from "../../../../shared/types/panel";

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
    onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
  })),
}));

vi.mock("@/clients", () => ({
  terminalClient: {
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    onResizeResult: vi.fn(() => vi.fn()),
    onTierChanged: vi.fn(() => vi.fn()),
    onReset: vi.fn(() => vi.fn()),
    setActivityTier: vi.fn(),
    wake: vi.fn(),
    resize: vi.fn(),
    getSerializedState: vi.fn(),
    getSharedBuffer: vi.fn(() => null),
    discardPortAcks: vi.fn(),
  },
  systemClient: {
    openExternal: vi.fn(),
  },
  appClient: {
    getHydrationState: vi.fn(),
  },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../TerminalAddonManager", () => ({
  setupTerminalAddons: vi.fn(() => ({
    fitAddon: {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
    },
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

const mockDocument = {
  createElement: vi.fn(() => ({
    style: {},
    className: "",
    appendChild: vi.fn(),
    removeChild: vi.fn(),
    parentElement: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    remove: vi.fn(),
    checkVisibility: vi.fn(() => true),
    getBoundingClientRect: vi.fn(() => ({ width: 800, height: 600 })),
  })),
  body: {
    appendChild: vi.fn(),
  },
};

vi.stubGlobal("document", mockDocument);

describe("TerminalInstanceService - destroy", () => {
  it("drops the id from the project-switch redraw queue immediately", async () => {
    const terminalInstanceService = await (
      await import("../terminalInstanceServiceAccessor")
    ).load();

    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    });

    const managed = await terminalInstanceService.getOrCreate(
      "test-destroy-queue",
      "terminal",
      {},
      () => TerminalRefreshTier.FOCUSED,
      undefined
    );

    const queue = (
      terminalInstanceService as unknown as { projectSwitchRedrawQueue: Map<string, unknown> }
    ).projectSwitchRedrawQueue;
    queue.set("test-destroy-queue", managed);
    queue.set("other-queued", managed);
    expect(queue.has("test-destroy-queue")).toBe(true);

    terminalInstanceService.destroy("test-destroy-queue");

    expect(queue.has("test-destroy-queue")).toBe(false);
    expect(queue.has("other-queued")).toBe(true);
    queue.clear();
  });
});
