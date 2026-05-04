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

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({ addPanel: (...args: unknown[]) => mockAddPanel(...args) }),
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
      { clipboardDirectory: "/tmp/daintree/daintree-clipboard", modelId: "sonnet" }
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
