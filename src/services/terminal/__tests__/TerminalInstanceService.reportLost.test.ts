// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

type ExitCb = (id: string, exitCode: number) => void;

let capturedExitCb: ExitCb | null = null;
const currentGeneration = 0;

vi.mock("@/clients", () => ({
  terminalClient: {
    onReset: vi.fn(() => vi.fn()),
    onResizeResult: vi.fn(() => vi.fn()),
    onData: vi.fn(() => vi.fn()),
    onExit: vi.fn((cb: ExitCb) => {
      capturedExitCb = cb;
      return vi.fn();
    }),
    onTierChanged: vi.fn(() => vi.fn()),
    getPortAckGeneration: vi.fn(() => currentGeneration),
    resize: vi.fn(),
    write: vi.fn(),
    setActivityTier: vi.fn(),
    wake: vi.fn(),
    getSerializedState: vi.fn(),
    getSharedBuffers: vi.fn(async () => ({ visualBuffers: [], signalBuffer: null })),
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

type LostTestService = {
  instances: Map<string, { terminal: { write: (data: string) => void } }>;
  prewarmTerminal: (id: string, type: string, options: Record<string, unknown>) => Promise<unknown>;
  addExitListener: (id: string, cb: (code: number | null) => void) => () => void;
  reportLost: (id: string, note: string) => void;
};

describe("TerminalInstanceService — a terminal its host lost", () => {
  let service: LostTestService;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    capturedExitCb = null;
    // Reached through Reflect: the test drives members the public type hides.
    const mod: object = await import("../TerminalInstanceService");
    service = Reflect.get(mod, "terminalInstanceService");
    service.instances.clear();
  });

  it("tells the pane it exited, with no exit code, and says why in the scrollback", async () => {
    await service.prewarmTerminal("t-lost", "terminal", {});
    const managed = service.instances.get("t-lost")!;
    const write = vi.spyOn(managed.terminal, "write");
    const exits: Array<number | null> = [];
    service.addExitListener("t-lost", (code) => exits.push(code));

    service.reportLost("t-lost", "The host no longer has this terminal");

    expect(exits).toEqual([null]);
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining("[The host no longer has this terminal]")
    );
  });

  it("still delivers a real exit code through the same listener", async () => {
    await service.prewarmTerminal("t-real", "terminal", {});
    const exits: Array<number | null> = [];
    service.addExitListener("t-real", (code) => exits.push(code));

    capturedExitCb?.("t-real", 3);

    expect(exits).toEqual([3]);
  });

  it("ignores a terminal this view never had", () => {
    expect(() => service.reportLost("t-unknown", "gone")).not.toThrow();
  });
});
