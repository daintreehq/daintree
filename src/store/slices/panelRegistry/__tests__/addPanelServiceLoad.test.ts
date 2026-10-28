/**
 * A panel removed while addPanel waits for the terminal service to load must
 * not be prewarmed once it arrives: removal's destroy found no instance, so a
 * prewarm then would leave an orphaned xterm and its data subscriptions.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const gate = vi.hoisted(() => {
  let release: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release: () => release() };
});

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: {
    setState: vi.fn().mockResolvedValue(undefined),
  },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
  },
  globalEnvClient: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn(),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
  systemClient: {
    getAppMetrics: vi.fn().mockResolvedValue({ totalMemoryMB: 512 }),
  },
}));

const terminalInstanceService = vi.hoisted(() => ({
  cleanup: vi.fn(),
  applyRendererPolicy: vi.fn(),
  onPanelBackgrounded: vi.fn(),
  destroy: vi.fn(),
  prewarmTerminal: vi.fn(),
  getOrCreate: vi.fn(),
  setInputLocked: vi.fn(),
  sendPtyResize: vi.fn(),
  waitForAttachSettled: vi.fn().mockResolvedValue(undefined),
  wake: vi.fn(),
  invalidatePtyGrid: vi.fn(),
  get: vi.fn(() => null),
}));

// The service module resolves only when the test opens the gate, so the load
// addPanel starts stays pending for as long as the test needs.
vi.mock("@/services/TerminalInstanceService", async () => {
  await gate.opened;
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});

vi.mock("../persistence", async () => {
  const actual = await vi.importActual<typeof import("../persistence")>("../persistence");
  return { ...actual, saveNormalized: vi.fn() };
});

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    electron: { globalEnv: { get: vi.fn().mockResolvedValue({}) } },
  };
});

const { usePanelStore } = await import("../../../panelStore");
const { peek: peekTerminalService } =
  await import("@/services/terminal/terminalInstanceServiceAccessor");

describe("addPanel while the terminal service loads", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await usePanelStore.getState().reset();
  });

  it("does not prewarm a panel removed before the service arrived", async () => {
    expect(peekTerminalService()).toBeNull();

    const added = usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "gone-1",
      cwd: "/tmp",
      location: "grid",
    });

    await vi.waitFor(() => expect(usePanelStore.getState().panelsById["gone-1"]).toBeDefined());
    expect(peekTerminalService()).toBeNull();
    usePanelStore.getState().removePanel("gone-1");

    gate.release();
    await added;

    expect(peekTerminalService()).toBe(terminalInstanceService);
    expect(terminalInstanceService.prewarmTerminal).not.toHaveBeenCalled();
    expect(terminalInstanceService.getOrCreate).not.toHaveBeenCalled();
  });
});
