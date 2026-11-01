/**
 * A Decisions relay deploy pane (#16023) runs its command once at spawn and
 * keeps none of it, so nothing that replays a pane's command runs the deploy
 * again under the same Worker name.
 */

import { beforeAll, describe, it, expect, beforeEach, vi } from "vitest";
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

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
    prewarmTerminal: vi.fn(),
    setInputLocked: vi.fn(),
    sendPtyResize: vi.fn(),
    invalidatePtyGrid: vi.fn(),
    waitForAttachSettled: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(() => null),
  };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});

vi.mock("@/store/helpPanelStore", () => ({
  useHelpPanelStore: {
    getState: () => ({ width: 500, sessions: {}, activeSlot: 0 }),
  },
  selectActiveSlot: () => ({ terminalId: null, sessionId: null, agentId: null }),
  selectSlotTerminalIds: () => [],
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
    innerHeight: 900,
    electron: {
      globalEnv: {
        get: vi.fn().mockResolvedValue({}),
      },
    },
  };
});

const { usePanelStore } = await import("../../../panelStore");
const { load: loadTerminalService } =
  await import("@/services/terminal/terminalInstanceServiceAccessor");

// The service mock never evaluates the real module, so nothing registers it;
// loading caches the mock for the synchronous peek() call sites.
beforeAll(async () => {
  await loadTerminalService();
});
const { usePanelLimitStore } = await import("@/store/panelLimitStore");
const { terminalClient } = await import("@/clients");
const spawn = vi.mocked(terminalClient.spawn);
function ptyPanel(id: string): PtyPanelData | undefined {
  const panel = usePanelStore.getState().panelsById[id];
  return panel && isPtyPanel(panel) ? panel : undefined;
}

describe("addPanel — a relay deploy pane (#16023)", () => {
  beforeEach(async () => {
    await usePanelStore.getState().reset();
    spawn.mockReset();
    spawn.mockImplementation(async ({ id }) => id ?? "spawn-id");
    usePanelLimitStore.setState({ softWarningLimit: 100, confirmationLimit: 200, hardLimit: 300 });
  });

  it("spawns running the deploy, and the pane keeps no command to run again", async () => {
    const command = "npx --yes @daintreehq/decisions-cli@0.1.0 deploy --name n --bucket n";
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "daintree-decisions-deploy-1",
      cwd: "/home/me",
      command,
      title: "Deploy Decisions relay",
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());

    expect(spawn.mock.calls[0]![0]).toMatchObject({ id: "daintree-decisions-deploy-1", command });
    expect(ptyPanel("daintree-decisions-deploy-1")?.command).toBeUndefined();
  });

  it("keeps any other pane's command, as before", async () => {
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "term-1",
      cwd: "/repo",
      command: "npm run dev",
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());

    expect(ptyPanel("term-1")?.command).toBe("npm run dev");
  });
});
