/**
 * Tests the title ownership ladder in `updateTitle`:
 * user rename > automation rename (MCP/assistant) > identity-derived default.
 *
 * - A human rename locks the title (`titleMode: "user"`).
 * - An automation rename pins `titleMode: "custom"` and bounces off a user lock.
 * - An empty rename resets to the identity-derived default and unlocks.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { isPtyPanel, type PtyPanelData } from "@shared/types/panel";

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

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
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
