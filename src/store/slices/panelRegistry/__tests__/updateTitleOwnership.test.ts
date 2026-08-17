/**
 * Tests the title ownership ladder in `updateTitle`:
 * user rename > automation rename (MCP/assistant) > identity-derived default.
 *
 * - A human rename locks the title (`titleMode: "user"`).
 * - An automation rename pins `titleMode: "custom"` and bounces off a user lock.
 * - An empty rename resets to the identity-derived default and unlocks.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { isPtyPanel, type PanelInstance, type PtyPanelData } from "@shared/types/panel";

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
    updateTitle: vi.fn(),
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

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    // No attached renderer xterm in these tests — spawn falls back to the
    // default/estimated dims path.
    get: vi.fn(() => null),
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
    prewarmTerminal: vi.fn(),
    setInputLocked: vi.fn(),
    sendPtyResize: vi.fn(),
    waitForAttachSettled: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../persistence", async () => {
  const actual = await vi.importActual<typeof import("../persistence")>("../persistence");
  return {
    ...actual,
    saveNormalized: vi.fn(),
  };
});

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    electron: {
      globalEnv: {
        get: vi.fn().mockResolvedValue({}),
      },
    },
  };
});

const { usePanelStore } = await import("../../../panelStore");

function getPtyPanel(id: string): PtyPanelData | undefined {
  const panel = usePanelStore.getState().panelsById[id];
  return panel && isPtyPanel(panel) ? panel : undefined;
}

describe("updateTitle ownership ladder", () => {
  beforeEach(async () => {
    const { reset } = usePanelStore.getState();
    await reset();

    const { terminalClient } = await import("@/clients");
    vi.mocked(terminalClient.spawn).mockReset();
    vi.mocked(terminalClient.spawn).mockImplementation(
      async ({ id }: { id?: string }) => id ?? "spawn-id"
    );

    const { addPanel } = usePanelStore.getState();
    await addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "t1",
      cwd: "/",
      bypassLimits: true,
    });

    // Cleared after the spawn so each test counts only its own renames.
    vi.mocked(terminalClient.updateTitle).mockClear();
  });

  it("defaults to the user rung and locks the title", () => {
    usePanelStore.getState().updateTitle("t1", "My debug shell");
    const panel = getPtyPanel("t1");
    expect(panel?.title).toBe("My debug shell");
    expect(panel?.titleMode).toBe("user");
  });

  it("automation rename pins custom", () => {
    usePanelStore.getState().updateTitle("t1", "Auth worker", "automation");
    const panel = getPtyPanel("t1");
    expect(panel?.title).toBe("Auth worker");
    expect(panel?.titleMode).toBe("custom");
  });

  it("automation bounces off a user lock", () => {
    usePanelStore.getState().updateTitle("t1", "Mine", "user");
    usePanelStore.getState().updateTitle("t1", "Overwritten by MCP", "automation");
    const panel = getPtyPanel("t1");
    expect(panel?.title).toBe("Mine");
    expect(panel?.titleMode).toBe("user");
  });

  it("a user rename replaces an automation title", () => {
    usePanelStore.getState().updateTitle("t1", "Auth worker", "automation");
    usePanelStore.getState().updateTitle("t1", "Mine now", "user");
    const panel = getPtyPanel("t1");
    expect(panel?.title).toBe("Mine now");
    expect(panel?.titleMode).toBe("user");
  });

  it("empty user rename resets to the identity default and unlocks", () => {
    usePanelStore.getState().updateTitle("t1", "Mine", "user");
    usePanelStore.getState().updateTitle("t1", "", "user");
    const panel = getPtyPanel("t1");
    expect(panel?.title).toBe("Claude");
    expect(panel?.titleMode).toBe("default");
  });

  it("automation cannot use an empty rename to unlock a user title", () => {
    usePanelStore.getState().updateTitle("t1", "Mine", "user");
    usePanelStore.getState().updateTitle("t1", "", "automation");
    const panel = getPtyPanel("t1");
    expect(panel?.title).toBe("Mine");
    expect(panel?.titleMode).toBe("user");
  });
});

/**
 * The renderer store drives the panel header, but the fleet overview, session
 * journal and shutdown records read the pty-host's own terminal record. Without
 * this sync that record keeps its launch title and every `titleMode === "user"`
 * branch in main is unreachable for a hand rename (#11830).
 */
describe("updateTitle pty-host sync", () => {
  async function client() {
    const { terminalClient } = await import("@/clients");
    return vi.mocked(terminalClient.updateTitle);
  }

  beforeEach(async () => {
    const { reset } = usePanelStore.getState();
    await reset();

    const { terminalClient } = await import("@/clients");
    vi.mocked(terminalClient.spawn).mockReset();
    vi.mocked(terminalClient.spawn).mockImplementation(
      async ({ id }: { id?: string }) => id ?? "spawn-id"
    );

    await usePanelStore.getState().addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      command: "claude",
      requestedId: "t1",
      cwd: "/",
      bypassLimits: true,
    });

    vi.mocked(terminalClient.updateTitle).mockClear();
  });

  it("sends the committed title and its mode together", async () => {
    usePanelStore.getState().updateTitle("t1", "Add valuation tool");

    const panel = getPtyPanel("t1");
    expect(await client()).toHaveBeenCalledWith("t1", panel?.title, panel?.titleMode);
  });

  it("sends the automation rung's own mode, not the user rung's", async () => {
    usePanelStore.getState().updateTitle("t1", "Auth worker", "automation");

    const mode = getPtyPanel("t1")?.titleMode;
    expect(mode).not.toBe("user");
    expect(await client()).toHaveBeenCalledWith("t1", "Auth worker", mode);
  });

  it("sends the unlock when an empty rename resets to the default", async () => {
    usePanelStore.getState().updateTitle("t1", "Mine", "user");
    (await client()).mockClear();

    usePanelStore.getState().updateTitle("t1", "", "user");

    const panel = getPtyPanel("t1");
    expect(await client()).toHaveBeenCalledWith("t1", panel?.title, "default");
  });

  it("sends nothing when the rename bounces off a user lock", async () => {
    usePanelStore.getState().updateTitle("t1", "Mine", "user");
    (await client()).mockClear();

    usePanelStore.getState().updateTitle("t1", "Overwritten by MCP", "automation");

    expect(await client()).not.toHaveBeenCalled();
  });

  it("sends nothing when the rename changes neither title nor mode", async () => {
    usePanelStore.getState().updateTitle("t1", "Mine", "user");
    (await client()).mockClear();

    usePanelStore.getState().updateTitle("t1", "Mine", "user");

    expect(await client()).not.toHaveBeenCalled();
  });

  it("sends nothing for an unknown panel", async () => {
    usePanelStore.getState().updateTitle("nope", "Ghost");

    expect(await client()).not.toHaveBeenCalled();
  });

  it("sends nothing for a panel with no pty behind it", async () => {
    usePanelStore.setState({
      panelsById: {
        b1: { id: "b1", kind: "browser", title: "Docs", location: "grid" } as PanelInstance,
      },
      panelIds: ["b1"],
    });
    (await client()).mockClear();

    usePanelStore.getState().updateTitle("b1", "Renamed tab");

    expect(usePanelStore.getState().panelsById.b1?.title).toBe("Renamed tab");
    expect(await client()).not.toHaveBeenCalled();
  });
});
