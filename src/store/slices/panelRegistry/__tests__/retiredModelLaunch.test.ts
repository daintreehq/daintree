/**
 * Launches that replay a saved Copilot model through `addPanel` (#15652): a
 * recipe, a duplicate, a reconnect. The real recipe store, duplication builder
 * and `addPanel` run against a mocked transport, so what reaches the spawn is
 * what would run.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn().mockResolvedValue(undefined),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
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
  agentSettingsClient: { get: vi.fn().mockResolvedValue({ agents: {} }) },
  systemClient: {
    getAppMetrics: vi.fn().mockResolvedValue({ totalMemoryMB: 512 }),
    getTmpDir: vi.fn().mockResolvedValue("/tmp"),
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
    fetchAndRestore: vi.fn().mockResolvedValue(true),
    setAgentState: vi.fn(),
    wake: vi.fn(),
    wakeForFocus: vi.fn(),
    get: vi.fn(() => null),
  };
  return { createTerminalPaintPlane: () => terminalInstanceService };
});

vi.mock("../persistence", async () => {
  const actual = await vi.importActual<typeof import("../persistence")>("../persistence");
  return { ...actual, saveNormalized: vi.fn() };
});

vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: {
    getState: vi.fn(() => ({ details: {}, refresh: vi.fn(async () => {}) })),
  },
}));

const notifyRetiredModelDroppedMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/terminal/retiredModelNotice", () => ({
  notifyRetiredModelDropped: notifyRetiredModelDroppedMock,
}));

(globalThis as { window?: unknown }).window = {
  electron: {
    globalEnv: { get: vi.fn().mockResolvedValue({}) },
    runHistory: { append: vi.fn().mockResolvedValue(undefined) },
  },
};

const { usePanelStore } = await import("../../../panelStore");
const { saveNormalized } = await import("../persistence");
const { useRecipeStore } = await import("../../../recipeStore");
const { buildPanelDuplicateOptions } = await import("@/services/terminal/panelDuplicationService");
const { load: loadTerminalService } =
  await import("@/services/terminal/terminalInstanceServiceAccessor");
const { terminalClient } = (await import("@/clients")) as unknown as {
  terminalClient: { spawn: ReturnType<typeof vi.fn> };
};

beforeAll(async () => {
  await loadTerminalService();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

function copilotPanes(): PtyPanelData[] {
  return Object.values(usePanelStore.getState().panelsById).filter(
    (panel): panel is PtyPanelData => "launchAgentId" in panel && panel.launchAgentId === "copilot"
  );
}

/** The saved launch and what the spawn was handed, for each Copilot pane. */
async function launchedCopilot(): Promise<
  Array<{ pane: PtyPanelData; spawn: Record<string, unknown> }>
> {
  await settle();
  return copilotPanes().map((pane) => ({
    pane,
    spawn: terminalClient.spawn.mock.calls.find(
      ([payload]) => (payload as { id: string }).id === pane.id
    )?.[0] as Record<string, unknown>,
  }));
}

function expectNoModel(launch: { pane: PtyPanelData; spawn: Record<string, unknown> }) {
  for (const source of [launch.pane, launch.spawn]) {
    expect(source.agentModelId).toBeUndefined();
    expect(source.agentLaunchFlags).not.toContain("--model");
    expect(source.command).not.toMatch(/--model/);
  }
}

function runRecipe(terminal: Record<string, unknown>) {
  useRecipeStore.setState({
    recipes: [
      {
        id: "recipe-1",
        name: "Copilot",
        projectId: "project-1",
        terminals: [{ type: "copilot", title: "GitHub Copilot", env: {}, ...terminal }],
        createdAt: Date.now(),
      },
    ],
    isLoading: false,
    currentProjectId: "project-1",
  } as never);
  return useRecipeStore.getState().runRecipeWithResults("recipe-1", "/repo", "wt-1");
}

describe("launches replaying a retired Copilot model (#15652)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    useRecipeStore.getState().reset();
    await usePanelStore.getState().reset();
    usePanelStore.setState({ panelsById: {}, panelIds: [], focusedId: null });
  });

  it("starts a recipe's step on the CLI default when it saved a retired model", async () => {
    await runRecipe({
      agentModelId: "claude-opus-4.6",
      agentLaunchFlags: ["--model", "claude-opus-4.6"],
    });

    const launches = await launchedCopilot();
    expect(launches).toHaveLength(1);
    expectNoModel(launches[0]!);
    expect(launches[0]!.spawn.command).toMatch(/^copilot\b/);
    // What goes to disk is the cleaned launch, so a later restore can't bring it back.
    const saves = vi.mocked(saveNormalized).mock.calls;
    expect(saves.length).toBeGreaterThan(0);
    const saved = saves.at(-1)![0][launches[0]!.pane.id] as PtyPanelData;
    expect(saved.agentModelId).toBeUndefined();
    expect(saved.agentLaunchFlags).not.toContain("claude-opus-4.6");
    expect(saved.command).not.toMatch(/--model/);
    expect(notifyRetiredModelDroppedMock).toHaveBeenCalledWith(
      "copilot",
      ["claude-opus-4.6"],
      expect.objectContaining({ panelId: launches[0]!.pane.id })
    );
  });

  it("drops a retired model a recipe passes in its args", async () => {
    await runRecipe({ args: "--model gpt-5.4 --allow-all-tools" });

    const [launch] = await launchedCopilot();
    expectNoModel(launch!);
    expect(launch!.pane.agentLaunchFlags).toContain("--allow-all-tools");
    expect(launch!.spawn.command).toContain("--allow-all-tools");
    expect(notifyRetiredModelDroppedMock).toHaveBeenCalledWith(
      "copilot",
      ["gpt-5.4"],
      expect.anything()
    );
  });

  it("launches a recipe's offered model with the same --model", async () => {
    await runRecipe({ agentModelId: "gpt-6.1-sol" });

    const [launch] = await launchedCopilot();
    expect(launch!.pane.agentModelId).toBe("gpt-6.1-sol");
    expect(launch!.pane.agentLaunchFlags).toEqual(
      expect.arrayContaining(["--model", "gpt-6.1-sol"])
    );
    expect(launch!.spawn.command).toContain("--model gpt-6.1-sol");
    expect(notifyRetiredModelDroppedMock).not.toHaveBeenCalled();
  });

  it("launches a recipe step with no model on the CLI default, adding no --model", async () => {
    await runRecipe({});

    const [launch] = await launchedCopilot();
    expectNoModel(launch!);
    expect(notifyRetiredModelDroppedMock).not.toHaveBeenCalled();
  });

  it("duplicates a pane saved with a retired model onto the CLI default, as restart does", async () => {
    const source = {
      id: "source-1",
      kind: "terminal",
      launchAgentId: "copilot",
      title: "GitHub Copilot",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      location: "grid",
      worktreeId: "wt-1",
      agentState: "idle",
      agentModelId: "claude-opus-4.6",
      agentLaunchFlags: ["--model", "claude-opus-4.6"],
      command: "copilot --model claude-opus-4.6",
    } as unknown as PtyPanelData;

    const options = await buildPanelDuplicateOptions(source, "grid");
    await usePanelStore.getState().addPanel(options);

    const [launch] = await launchedCopilot();
    expectNoModel(launch!);
    expect(notifyRetiredModelDroppedMock).toHaveBeenCalledWith(
      "copilot",
      ["claude-opus-4.6"],
      expect.anything()
    );
  });

  it("leaves a reconnect to a run that is still going exactly as it was", async () => {
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      existingId: "live-1",
      launchAgentId: "copilot",
      title: "GitHub Copilot",
      cwd: "/repo",
      agentModelId: "claude-opus-4.6",
      agentLaunchFlags: ["--model", "claude-opus-4.6"],
      command: "copilot --model claude-opus-4.6",
    });

    const pane = copilotPanes()[0]!;
    expect(pane.agentModelId).toBe("claude-opus-4.6");
    expect(pane.agentLaunchFlags).toEqual(["--model", "claude-opus-4.6"]);
    expect(notifyRetiredModelDroppedMock).not.toHaveBeenCalled();
  });
});
