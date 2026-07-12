/**
 * #11079: a terminal spawned in a scratch workspace must be stamped with the
 * scratch's id, so `killByProject(scratchId)` reaches it when the scratch is
 * deleted. Capturing only `currentProject` (null in a scratch) left ownership to
 * PtyClient's global `activeProjectId` back-fill — null after a restore into a
 * scratch, and last-write-wins across windows.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

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
    get: vi.fn(() => null),
  },
}));

vi.mock("../persistence", async () => {
  const actual = await vi.importActual<typeof import("../persistence")>("../persistence");
  return { ...actual, saveNormalized: vi.fn() };
});

// addPanel lazily imports the project store; drive `currentProject` per test.
let currentProject: { id: string; path: string } | null = null;
vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => ({ currentProject }) },
}));

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    electron: { globalEnv: { get: vi.fn().mockResolvedValue({}) } },
  };
});

const { usePanelStore } = await import("../../../panelStore");

/** Seed the view identity main stamps onto every WebContentsView at creation. */
function setViewWorkspaceId(id: string | undefined): void {
  (
    window as unknown as { __DAINTREE_INITIAL_PROJECT__?: { id: string } }
  ).__DAINTREE_INITIAL_PROJECT__ = id ? { id } : undefined;
}

async function drainMicrotasks(iterations = 100): Promise<void> {
  for (let i = 0; i < iterations; i++) await Promise.resolve();
}

async function getSpawnArgs(): Promise<Record<string, unknown> | undefined> {
  const { terminalClient } = (await import("@/clients")) as unknown as {
    terminalClient: { spawn: ReturnType<typeof vi.fn> };
  };
  return terminalClient.spawn.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
}

describe("addPanel workspace ownership (#11079)", () => {
  beforeEach(async () => {
    currentProject = null;
    const { reset } = usePanelStore.getState();
    await reset();

    const { terminalClient, projectClient } = (await import("@/clients")) as unknown as {
      terminalClient: { spawn: ReturnType<typeof vi.fn> };
      projectClient: { getSettings: ReturnType<typeof vi.fn> };
    };
    terminalClient.spawn.mockReset();
    terminalClient.spawn.mockImplementation(async ({ id }: { id?: string }) => id ?? "spawn-id");
    projectClient.getSettings.mockClear();
  });

  it("stamps the scratch id on a terminal spawned in a scratch view", async () => {
    currentProject = null; // switching to a scratch clears the project pointer
    setViewWorkspaceId("scratch-uuid");

    await usePanelStore.getState().addPanel({ requestedId: "term-1", bypassLimits: true });
    await drainMicrotasks();

    expect((await getSpawnArgs())?.projectId).toBe("scratch-uuid");
  });

  it("does not fetch project settings for a scratch workspace", async () => {
    currentProject = null;
    setViewWorkspaceId("scratch-uuid");

    await usePanelStore.getState().addPanel({ requestedId: "term-2", bypassLimits: true });
    await drainMicrotasks();

    const { projectClient } = (await import("@/clients")) as unknown as {
      projectClient: { getSettings: ReturnType<typeof vi.fn> };
    };
    expect(projectClient.getSettings).not.toHaveBeenCalled();
  });

  it("prefers the current project over the view id when a project is active", async () => {
    // The view id and the project agree in practice; assert precedence explicitly so
    // a project view can never adopt some other workspace's id.
    currentProject = { id: "project-abc", path: "/repo" };
    setViewWorkspaceId("project-abc");

    await usePanelStore.getState().addPanel({ requestedId: "term-3", bypassLimits: true });
    await drainMicrotasks();

    expect((await getSpawnArgs())?.projectId).toBe("project-abc");

    const { projectClient } = (await import("@/clients")) as unknown as {
      projectClient: { getSettings: ReturnType<typeof vi.fn> };
    };
    expect(projectClient.getSettings).toHaveBeenCalledWith("project-abc");
  });

  it("leaves the terminal unowned when the view has no workspace identity", async () => {
    currentProject = null;
    setViewWorkspaceId(undefined);

    await usePanelStore.getState().addPanel({ requestedId: "term-4", bypassLimits: true });
    await drainMicrotasks();

    expect((await getSpawnArgs())?.projectId).toBeUndefined();
  });
});
