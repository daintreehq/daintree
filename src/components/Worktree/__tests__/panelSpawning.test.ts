/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawnPanelsFromRecipe } from "../panelSpawning";
import type { RecipeTerminal } from "@shared/types";

const mockAddPanel = vi.fn();
const mockAgentSettingsGet = vi.fn();
const mockSystemGetTmpDir = vi.fn();
const mockGetAgentConfig = vi.fn();
const mockGenerateAgentCommand = vi.fn();

vi.mock("@/clients", () => ({
  agentSettingsClient: { get: (...args: unknown[]) => mockAgentSettingsGet(...args) },
  systemClient: { getTmpDir: (...args: unknown[]) => mockSystemGetTmpDir(...args) },
}));

vi.mock("@/config/agents", () => ({
  getAgentConfig: (...args: unknown[]) => mockGetAgentConfig(...args),
}));

vi.mock("@shared/types", async (importActual) => {
  const actual = await importActual<typeof import("@shared/types")>();
  return {
    ...actual,
    generateAgentCommand: (...args: unknown[]) => mockGenerateAgentCommand(...args),
  };
});

const mockSetFocused = vi.fn();
const mockBeginSpawnBatch = vi.fn(() => Symbol("spawn-batch"));
const mockFlushSpawnBatch = vi.fn();

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({
      addPanel: (...args: unknown[]) => mockAddPanel(...args),
      panelIds: [],
      panelsById: {},
      beginSpawnBatch: mockBeginSpawnBatch,
      flushSpawnBatch: mockFlushSpawnBatch,
      setFocused: mockSetFocused,
    }),
  },
}));

function makeTerminal(overrides: Partial<RecipeTerminal> = {}): RecipeTerminal {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return {
    type: "terminal",
    title: "Terminal",
    exitBehavior: "keep-alive",
    ...overrides,
  } as RecipeTerminal;
}

function makeDevPreview(overrides: Partial<RecipeTerminal> = {}): RecipeTerminal {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return {
    type: "dev-preview",
    title: "Dev Preview",
    devCommand: "npm run dev",
    exitBehavior: "keep-alive",
    ...overrides,
  } as RecipeTerminal;
}

function makeAgent(overrides: Partial<RecipeTerminal> = {}): RecipeTerminal {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return {
    type: "claude",
    title: "Claude Agent",
    exitBehavior: "keep-alive",
    agentModelId: "sonnet",
    ...overrides,
  } as RecipeTerminal;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAddPanel.mockResolvedValue("panel-id-123");
  mockAgentSettingsGet.mockResolvedValue({ agents: { claude: { modelId: "sonnet" } } });
  mockSystemGetTmpDir.mockResolvedValue("/tmp/daintree");
  mockGetAgentConfig.mockReturnValue({ command: "claude" });
  mockGenerateAgentCommand.mockReturnValue("claude --model sonnet");
});

describe("spawnPanelsFromRecipe", () => {
  it("spawns a dev-preview panel", async () => {
    const cb = vi.fn();
    await spawnPanelsFromRecipe({
      terminals: [makeDevPreview()],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
      onPanelSpawned: cb,
    });

    expect(mockAddPanel).toHaveBeenCalledTimes(1);
    expect(mockAddPanel).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "dev-preview", devCommand: "npm run dev" })
    );
    expect(cb).toHaveBeenCalledWith(0, "panel-id-123");
  });

  it("spawns a terminal panel", async () => {
    const cb = vi.fn();
    await spawnPanelsFromRecipe({
      terminals: [makeTerminal({ command: "echo hello" })],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
      onPanelSpawned: cb,
    });

    expect(mockAddPanel).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal", command: "echo hello" })
    );
    expect(cb).toHaveBeenCalledWith(0, "panel-id-123");
  });

  it("spawns an agent panel with regenerated command", async () => {
    const cb = vi.fn();
    await spawnPanelsFromRecipe({
      terminals: [makeAgent()],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
      agentSettings: { agents: { claude: { modelId: "sonnet" } } },
      clipboardDirectory: "/tmp/daintree/daintree-clipboard",
      onPanelSpawned: cb,
    });

    expect(mockGetAgentConfig).toHaveBeenCalledWith("claude");
    expect(mockGenerateAgentCommand).toHaveBeenCalledWith(
      "claude",
      { modelId: "sonnet" },
      "claude",
      {
        clipboardDirectory: "/tmp/daintree/daintree-clipboard",
        modelId: "sonnet",
        globalSkipPermissions: false,
        globalUseAltScreen: false,
      }
    );
    expect(mockAddPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "terminal",
        launchAgentId: "claude",
        command: "claude --model sonnet",
      })
    );
    expect(cb).toHaveBeenCalledWith(0, "panel-id-123");
  });

  it("persists computed launch flags so resume reproduces the launch (#9650)", async () => {
    // Real buildAgentLaunchFlags runs (only generateAgentCommand is mocked),
    // so the dangerous flag and recipe args must surface in agentLaunchFlags.
    await spawnPanelsFromRecipe({
      terminals: [makeAgent({ args: "--recipe-arg value" })],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
      agentSettings: { agents: { claude: { dangerousEnabled: true } } },
      clipboardDirectory: "/tmp/daintree/daintree-clipboard",
    });

    const call = mockAddPanel.mock.calls[0]?.[0] as { agentLaunchFlags?: string[] };
    expect(call.agentLaunchFlags).toEqual(
      expect.arrayContaining(["--dangerously-skip-permissions", "--recipe-arg", "value"])
    );
    // Never the stale (always-undefined) recipe-terminal field.
    expect(call.agentLaunchFlags).not.toBeUndefined();
  });

  it("forwards recipe args to the initial command (#9650)", async () => {
    await spawnPanelsFromRecipe({
      terminals: [makeAgent({ args: "--recipe-arg" })],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
      agentSettings: { agents: { claude: {} } },
      clipboardDirectory: "/tmp/daintree/daintree-clipboard",
    });

    expect(mockGenerateAgentCommand).toHaveBeenCalledWith(
      "claude",
      {},
      "claude",
      expect.objectContaining({ recipeArgs: "--recipe-arg" })
    );
  });

  it("produces no blank flag tokens when recipe args are empty (#9650)", async () => {
    await spawnPanelsFromRecipe({
      terminals: [makeAgent({ args: "   " })],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
      agentSettings: { agents: { claude: { dangerousEnabled: true } } },
      clipboardDirectory: "/tmp/daintree/daintree-clipboard",
    });

    const call = mockAddPanel.mock.calls[0]?.[0] as { agentLaunchFlags?: string[] };
    expect(call.agentLaunchFlags).toEqual(
      expect.arrayContaining(["--dangerously-skip-permissions"])
    );
    expect(call.agentLaunchFlags?.every((f) => f.trim().length > 0)).toBe(true);
  });

  it("fetches agent settings internally when not provided", async () => {
    await spawnPanelsFromRecipe({
      terminals: [makeAgent()],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
    });

    expect(mockAgentSettingsGet).toHaveBeenCalledTimes(1);
    expect(mockSystemGetTmpDir).toHaveBeenCalledTimes(1);
    expect(mockGenerateAgentCommand).toHaveBeenCalled();
  });

  it("skips internal fetch when agentSettings is provided", async () => {
    await spawnPanelsFromRecipe({
      terminals: [makeAgent()],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
      agentSettings: { agents: {} },
      clipboardDirectory: "/some/dir",
    });

    expect(mockAgentSettingsGet).not.toHaveBeenCalled();
    expect(mockSystemGetTmpDir).not.toHaveBeenCalled();
  });

  it("skips agent pre-fetch when no agent panels are present", async () => {
    await spawnPanelsFromRecipe({
      terminals: [makeTerminal(), makeDevPreview()],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
    });

    expect(mockAgentSettingsGet).not.toHaveBeenCalled();
    expect(mockSystemGetTmpDir).not.toHaveBeenCalled();
  });

  it("continues spawning after addPanel returns null", async () => {
    mockAddPanel.mockResolvedValueOnce(null).mockResolvedValueOnce("panel-2");
    const cb = vi.fn();

    await spawnPanelsFromRecipe({
      terminals: [makeTerminal({ title: "T1" }), makeTerminal({ title: "T2" })],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
      onPanelSpawned: cb,
    });

    expect(mockAddPanel).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenCalledWith(0, null, expect.any(Error));
    expect(cb).toHaveBeenCalledWith(1, "panel-2");
  });

  it("continues spawning after addPanel throws", async () => {
    const err = new Error("spawn failed");
    mockAddPanel.mockRejectedValueOnce(err).mockResolvedValueOnce("panel-2");
    const cb = vi.fn();

    await spawnPanelsFromRecipe({
      terminals: [makeTerminal({ title: "T1" }), makeTerminal({ title: "T2" })],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
      onPanelSpawned: cb,
    });

    expect(mockAddPanel).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenCalledWith(0, null, err);
    expect(cb).toHaveBeenCalledWith(1, "panel-2");
  });

  it("aborts before any spawns when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await spawnPanelsFromRecipe({
      terminals: [makeTerminal()],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
      signal: controller.signal,
    });

    expect(mockAddPanel).not.toHaveBeenCalled();
  });

  it("aborts mid-loop when signal fires between spawns", async () => {
    const controller = new AbortController();
    mockAddPanel.mockImplementation(() => {
      controller.abort();
      return "panel-1";
    });

    await spawnPanelsFromRecipe({
      terminals: [makeTerminal({ title: "T1" }), makeTerminal({ title: "T2" })],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
      signal: controller.signal,
    });

    expect(mockAddPanel).toHaveBeenCalledTimes(1);
  });

  it("does not invoke onPanelSpawned when callback is omitted", async () => {
    await spawnPanelsFromRecipe({
      terminals: [makeTerminal()],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
    });

    expect(mockAddPanel).toHaveBeenCalledTimes(1);
  });

  it("handles systemClient.getTmpDir rejection gracefully", async () => {
    mockSystemGetTmpDir.mockRejectedValue(new Error("no tmp"));
    mockAgentSettingsGet.mockResolvedValue({ agents: {} });

    await spawnPanelsFromRecipe({
      terminals: [makeAgent()],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
    });

    expect(mockGenerateAgentCommand).toHaveBeenCalledWith(
      "claude",
      {},
      "claude",
      expect.objectContaining({ clipboardDirectory: undefined })
    );
  });

  it("throws AggregateError when addPanel returns null and no callback is provided", async () => {
    mockAddPanel.mockResolvedValue(null);

    await expect(
      spawnPanelsFromRecipe({
        terminals: [makeTerminal()],
        worktreeId: "wt-1",
        cwd: "/path/to/wt",
      })
    ).rejects.toThrow(AggregateError);
  });

  it("throws AggregateError when addPanel throws and no callback is provided", async () => {
    mockAddPanel.mockRejectedValue(new Error("boom"));

    await expect(
      spawnPanelsFromRecipe({
        terminals: [makeTerminal()],
        worktreeId: "wt-1",
        cwd: "/path/to/wt",
      })
    ).rejects.toThrow(AggregateError);
  });

  it("does not throw when errors occur but callback is provided", async () => {
    mockAddPanel.mockRejectedValue(new Error("boom"));
    const cb = vi.fn();

    await spawnPanelsFromRecipe({
      terminals: [makeTerminal()],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
      onPanelSpawned: cb,
    });

    expect(cb).toHaveBeenCalledWith(0, null, expect.any(Error));
  });

  it("does not double-fire callback when success callback throws", async () => {
    const cb = vi.fn().mockImplementation(() => {
      throw new Error("callback error");
    });

    await spawnPanelsFromRecipe({
      terminals: [makeTerminal()],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
      onPanelSpawned: cb,
    });

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("opens one spawn batch and flushes it once for a multi-panel recipe", async () => {
    await spawnPanelsFromRecipe({
      terminals: [makeTerminal({ title: "T1" }), makeTerminal({ title: "T2" })],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
    });

    expect(mockBeginSpawnBatch).toHaveBeenCalledTimes(1);
    expect(mockFlushSpawnBatch).toHaveBeenCalledTimes(1);
    // Flush receives the token returned by begin.
    expect(mockFlushSpawnBatch).toHaveBeenCalledWith(mockBeginSpawnBatch.mock.results[0]?.value);
    expect(mockAddPanel).toHaveBeenCalledTimes(2);
    // EVERY panel bypasses the per-call limit (the batch gated the whole burst).
    expect(
      mockAddPanel.mock.calls.every(
        (c) => (c[0] as { bypassLimits?: boolean })?.bypassLimits === true
      )
    ).toBe(true);
  });

  it("flushes the spawn batch even when a panel spawn throws", async () => {
    mockAddPanel.mockRejectedValue(new Error("boom"));

    await spawnPanelsFromRecipe({
      terminals: [makeTerminal()],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
      onPanelSpawned: vi.fn(),
    });

    expect(mockFlushSpawnBatch).toHaveBeenCalledTimes(1);
  });

  it("forwards dock location to addPanel for all panel kinds (#9764)", async () => {
    await spawnPanelsFromRecipe({
      terminals: [
        makeTerminal({ location: "dock" }),
        makeAgent({ location: "dock" }),
        makeDevPreview({ location: "dock" }),
      ],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
      agentSettings: { agents: { claude: {} } },
      clipboardDirectory: "/tmp/daintree/daintree-clipboard",
    });

    expect(mockAddPanel).toHaveBeenCalledTimes(3);
    expect(
      mockAddPanel.mock.calls.every((c) => (c[0] as { location?: string })?.location === "dock")
    ).toBe(true);
  });

  it("leaves location undefined for terminals without one (grid default)", async () => {
    await spawnPanelsFromRecipe({
      terminals: [makeTerminal()],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
    });

    const call = mockAddPanel.mock.calls[0]?.[0] as { location?: string };
    expect(call.location).toBeUndefined();
  });

  it("focuses the last grid panel, skipping dock panels (#9764)", async () => {
    mockAddPanel.mockResolvedValueOnce("panel-grid").mockResolvedValueOnce("panel-dock");

    await spawnPanelsFromRecipe({
      terminals: [
        makeTerminal({ title: "Grid" }),
        makeTerminal({ title: "Docked", location: "dock" }),
      ],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
    });

    expect(mockSetFocused).toHaveBeenCalledTimes(1);
    expect(mockSetFocused).toHaveBeenCalledWith("panel-grid");
  });

  it("focuses the last grid panel in a mixed dock/grid interleaving (#9764)", async () => {
    mockAddPanel
      .mockResolvedValueOnce("panel-dock-1")
      .mockResolvedValueOnce("panel-grid-1")
      .mockResolvedValueOnce("panel-dock-2")
      .mockResolvedValueOnce("panel-grid-2");

    await spawnPanelsFromRecipe({
      terminals: [
        makeTerminal({ title: "D1", location: "dock" }),
        makeTerminal({ title: "G1" }),
        makeTerminal({ title: "D2", location: "dock" }),
        makeTerminal({ title: "G2" }),
      ],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
    });

    const locations = mockAddPanel.mock.calls.map((c) => (c[0] as { location?: string }).location);
    expect(locations).toEqual(["dock", undefined, "dock", undefined]);
    expect(mockSetFocused).toHaveBeenCalledTimes(1);
    expect(mockSetFocused).toHaveBeenCalledWith("panel-grid-2");
  });

  it("does not steal focus when only dock panels spawn (#9764)", async () => {
    await spawnPanelsFromRecipe({
      terminals: [makeTerminal({ location: "dock" })],
      worktreeId: "wt-1",
      cwd: "/path/to/wt",
    });

    expect(mockSetFocused).not.toHaveBeenCalled();
  });

  it("collects errors from multiple panels and throws single AggregateError", async () => {
    mockAddPanel.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("fail"));

    await expect(
      spawnPanelsFromRecipe({
        terminals: [makeTerminal({ title: "T1" }), makeTerminal({ title: "T2" })],
        worktreeId: "wt-1",
        cwd: "/path/to/wt",
      })
    ).rejects.toThrow(AggregateError);
  });
});
