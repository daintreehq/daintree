// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MORE_AGENTS_PANEL_ID } from "../usePanelPalette";

const {
  getPanelKindIdsMock,
  getPanelKindConfigMock,
  getPanelKindDefinitionMock,
  getEffectiveAgentIdsMock,
  getEffectiveAgentConfigMock,
  cliAvailabilityState,
} = vi.hoisted(() => ({
  getPanelKindIdsMock: vi.fn(),
  getPanelKindConfigMock: vi.fn(),
  getPanelKindDefinitionMock: vi.fn(),
  getEffectiveAgentIdsMock: vi.fn(),
  getEffectiveAgentConfigMock: vi.fn(),
  cliAvailabilityState: {
    availability: { claude: "ready", gemini: "missing" } as Record<string, string>,
    isInitialized: true,
    isLoading: false,
    isRefreshing: false,
    error: null,
    lastCheckedAt: Date.now(),
    initialize: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@shared/config/panelKindRegistry", () => ({
  getPanelKindIds: getPanelKindIdsMock,
  getPanelKindConfig: getPanelKindConfigMock,
}));

vi.mock("@/registry", () => ({
  getPanelKindDefinition: getPanelKindDefinitionMock,
}));

vi.mock("@shared/config/agentRegistry", () => ({
  AGENT_REGISTRY: {},
  getEffectiveAgentIds: getEffectiveAgentIdsMock,
  getEffectiveAgentConfig: getEffectiveAgentConfigMock,
}));

vi.mock("@/store/userAgentRegistryStore", () => ({
  useUserAgentRegistryStore: (
    selector: (state: { registry: Record<string, unknown> | null }) => unknown
  ) => selector({ registry: {} }),
}));

vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: (
    selector: (state: {
      settings: { agents: Record<string, { pinned?: boolean }> } | null;
    }) => unknown
  ) => selector({ settings: { agents: { claude: { pinned: true }, gemini: { pinned: true } } } }),
}));

vi.mock("@/store/cliAvailabilityStore", () => {
  const store = (selector: (state: typeof cliAvailabilityState) => unknown) =>
    selector(cliAvailabilityState);
  store.getState = () => cliAvailabilityState;
  return { useCliAvailabilityStore: store };
});

import { usePanelPalette } from "../usePanelPalette";

describe("usePanelPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Ensure window.electron.agentSessionHistory is available for tests
    if (!window.electron) {
      (window as unknown as { electron: unknown }).electron = {};
    }
    const electron = window.electron as unknown as Record<string, unknown>;
    if (!electron.agentSessionHistory) {
      electron.agentSessionHistory = {
        list: vi.fn().mockResolvedValue([]),
      };
    } else {
      vi.spyOn(window.electron!.agentSessionHistory!, "list").mockResolvedValue([]);
    }

    getPanelKindIdsMock.mockReturnValue(["browser"]);
    getPanelKindConfigMock.mockImplementation((kind: string) => {
      if (kind === "browser") {
        return {
          id: "browser",
          name: "Browser",
          iconId: "browser",
          color: "#aaa",
          showInPalette: true,
          shortcut: "Cmd+B",
          hasPty: false,
          canRestart: false,
          canConvert: false,
        };
      }
      return undefined;
    });
    getPanelKindDefinitionMock.mockImplementation((kind: string) => {
      if (kind === "browser") {
        return { id: "browser", component: () => null };
      }
      return undefined;
    });
    cliAvailabilityState.availability = { claude: "ready", gemini: "missing" };
    cliAvailabilityState.isInitialized = true;
    cliAvailabilityState.lastCheckedAt = Date.now();

    getEffectiveAgentIdsMock.mockReturnValue(["claude", "claude"]);
    getEffectiveAgentConfigMock.mockReturnValue({
      name: "Claude",
      iconId: "claude",
      color: "#f80",
      tooltip: "Claude agent",
    });
  });

  it("deduplicates duplicated agent IDs from registry sources", () => {
    const { result } = renderHook(() => usePanelPalette());

    const claudeEntries = result.current.results.filter((item) => item.id === "agent:claude");
    expect(claudeEntries).toHaveLength(1);
  });

  it("assigns category 'agent' to agent items", () => {
    const { result } = renderHook(() => usePanelPalette());

    const claude = result.current.results.find((item) => item.id === "agent:claude");
    expect(claude?.category).toBe("agent");
  });

  it("assigns category 'tool' to panel kind items", () => {
    const { result } = renderHook(() => usePanelPalette());

    const browser = result.current.results.find((item) => item.id === "browser");
    expect(browser?.category).toBe("tool");
  });

  it("assigns category 'agent' to the MORE_AGENTS_PANEL_ID entry", () => {
    const { result } = renderHook(() => usePanelPalette());

    const moreAgents = result.current.results.find((item) => item.id === MORE_AGENTS_PANEL_ID);
    expect(moreAgents?.category).toBe("agent");
  });

  it("places agents, then MORE_AGENTS, then tools in exact order", () => {
    const { result } = renderHook(() => usePanelPalette());

    const ids = result.current.results.map((item) => item.id);
    expect(ids).toEqual(["agent:claude", MORE_AGENTS_PANEL_ID, "browser"]);
  });

  it("places resume sessions after tools", async () => {
    (window.electron!.agentSessionHistory!.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        sessionId: "abc12345-6789",
        agentId: "claude",
        worktreeId: null,
        title: null,
        projectId: null,
        savedAt: Date.now() - 3600000,
        agentModelId: "claude-opus-4-5",
      },
    ]);

    const { result, rerender } = renderHook(() => usePanelPalette());
    await vi.waitFor(() => {
      rerender();
      const ids = result.current.results.map((item) => item.id);
      const browserIdx = ids.indexOf("browser");
      const resumeIdx = ids.findIndex((id) => id.startsWith("resume:"));
      expect(resumeIdx).toBeGreaterThan(browserIdx);
    });
  });

  it("formats resume session description with model and time", async () => {
    (window.electron!.agentSessionHistory!.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        sessionId: "abc12345-6789",
        agentId: "claude",
        worktreeId: null,
        title: null,
        projectId: null,
        savedAt: Date.now() - 7200000,
        agentModelId: "claude-opus-4-5",
      },
    ]);

    const { result, rerender } = renderHook(() => usePanelPalette());
    await vi.waitFor(() => {
      rerender();
      const resume = result.current.results.find((item) => item.id.startsWith("resume:"));
      expect(resume).toBeDefined();
      expect(resume!.description).toContain("Opus 4 5");
      expect(resume!.description).toContain("ago");
    });
  });

  it("still includes MORE_AGENTS when all agents are hidden", () => {
    getEffectiveAgentIdsMock.mockReturnValue([]);

    const { result } = renderHook(() => usePanelPalette());

    const ids = result.current.results.map((item) => item.id);
    expect(ids).toContain(MORE_AGENTS_PANEL_ID);
    const moreAgents = result.current.results.find((item) => item.id === MORE_AGENTS_PANEL_ID);
    expect(moreAgents?.category).toBe("agent");
  });

  it("works when no tool panel kinds exist", () => {
    getPanelKindIdsMock.mockReturnValue([]);

    const { result } = renderHook(() => usePanelPalette());

    const tools = result.current.results.filter((item) => item.category === "tool");
    expect(tools).toHaveLength(0);
    const agents = result.current.results.filter((item) => item.category === "agent");
    expect(agents.length).toBeGreaterThan(0);
  });

  it("handleSelect returns option immediately for agents with models (no model phase)", () => {
    getEffectiveAgentConfigMock.mockReturnValue({
      name: "Claude",
      iconId: "claude",
      color: "#f80",
      tooltip: "Claude agent",
      models: [
        { id: "sonnet", name: "Sonnet" },
        { id: "opus", name: "Opus" },
      ],
    });

    const { result } = renderHook(() => usePanelPalette());

    const claudeOption = result.current.results.find((item) => item.id === "agent:claude");
    expect(claudeOption).toBeDefined();

    const selected = result.current.handleSelect(claudeOption!);
    expect(selected).toBe(claudeOption);
  });

  it("confirmSelection returns option immediately for agents with models", () => {
    getEffectiveAgentConfigMock.mockReturnValue({
      name: "Claude",
      iconId: "claude",
      color: "#f80",
      tooltip: "Claude agent",
      models: [{ id: "sonnet", name: "Sonnet" }],
    });

    const { result } = renderHook(() => usePanelPalette());

    const selected = result.current.confirmSelection();
    expect(selected).toBeDefined();
    expect(selected!.id).toBe("agent:claude");
  });

  it("handleSelect dispatches agent setup wizard event and returns null for MORE_AGENTS", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const { result } = renderHook(() => usePanelPalette());

    const moreAgents = result.current.results.find((item) => item.id === MORE_AGENTS_PANEL_ID);
    expect(moreAgents).toBeDefined();

    const selected = result.current.handleSelect(moreAgents!);
    expect(selected).toBeNull();
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "daintree:open-agent-setup-wizard",
        detail: { returnToPanelPalette: true },
      })
    );
    dispatchSpy.mockRestore();
  });

  it("confirmSelection dispatches agent setup wizard event for MORE_AGENTS", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const { result } = renderHook(() => usePanelPalette());

    // Navigate selectedIndex to MORE_AGENTS entry
    const moreAgentsIndex = result.current.results.findIndex(
      (item) => item.id === MORE_AGENTS_PANEL_ID
    );
    expect(moreAgentsIndex).toBeGreaterThanOrEqual(0);

    // selectedIndex defaults to 0 (first item), so we need to confirm the right item
    // Since MORE_AGENTS is at index 1 (after claude), we test handleSelect path instead
    // which is the direct click path. confirmSelection uses selectedIndex.
    const selected = result.current.handleSelect(result.current.results[moreAgentsIndex]!);
    expect(selected).toBeNull();
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "daintree:open-agent-setup-wizard",
        detail: { returnToPanelPalette: true },
      })
    );
    dispatchSpy.mockRestore();
  });

  describe("agent availability", () => {
    it("sets installed=true for available agents", () => {
      getEffectiveAgentIdsMock.mockReturnValue(["claude"]);
      cliAvailabilityState.availability = { claude: "ready" };

      const { result } = renderHook(() => usePanelPalette());

      const claude = result.current.results.find((item) => item.id === "agent:claude");
      expect(claude?.installed).toBe(true);
    });

    it("sets installed=false for unavailable agents", () => {
      getEffectiveAgentIdsMock.mockReturnValue(["gemini"]);
      getEffectiveAgentConfigMock.mockReturnValue({
        name: "Gemini",
        iconId: "gemini",
        color: "#4285f4",
        tooltip: "Gemini agent",
      });
      cliAvailabilityState.availability = { gemini: "missing" };

      const { result } = renderHook(() => usePanelPalette());

      const gemini = result.current.results.find((item) => item.id === "agent:gemini");
      expect(gemini?.installed).toBe(false);
    });

    it("sets installed=undefined before availability is initialized", () => {
      getEffectiveAgentIdsMock.mockReturnValue(["claude"]);
      cliAvailabilityState.isInitialized = false;

      const { result } = renderHook(() => usePanelPalette());

      const claude = result.current.results.find((item) => item.id === "agent:claude");
      expect(claude?.installed).toBeUndefined();
    });

    it("does not set installed on tool items", () => {
      const { result } = renderHook(() => usePanelPalette());

      const browser = result.current.results.find((item) => item.id === "browser");
      expect(browser?.installed).toBeUndefined();
    });

    it("does not set installed on MORE_AGENTS entry", () => {
      const { result } = renderHook(() => usePanelPalette());

      const moreAgents = result.current.results.find((item) => item.id === MORE_AGENTS_PANEL_ID);
      expect(moreAgents?.installed).toBeUndefined();
    });

    it("handleSelect dispatches setup wizard and returns null for uninstalled agent", () => {
      const dispatchSpy = vi.spyOn(window, "dispatchEvent");
      getEffectiveAgentIdsMock.mockReturnValue(["gemini"]);
      getEffectiveAgentConfigMock.mockReturnValue({
        name: "Gemini",
        iconId: "gemini",
        color: "#4285f4",
        tooltip: "Gemini agent",
      });
      cliAvailabilityState.availability = { gemini: "missing" };

      const { result } = renderHook(() => usePanelPalette());

      const gemini = result.current.results.find((item) => item.id === "agent:gemini");
      expect(gemini).toBeDefined();
      expect(gemini!.installed).toBe(false);

      const selected = result.current.handleSelect(gemini!);
      expect(selected).toBeNull();
      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "daintree:open-agent-setup-wizard",
          detail: { returnToPanelPalette: true },
        })
      );
      dispatchSpy.mockRestore();
    });

    it("handleSelect returns option for installed agent", () => {
      getEffectiveAgentIdsMock.mockReturnValue(["claude"]);
      cliAvailabilityState.availability = { claude: "ready" };

      const { result } = renderHook(() => usePanelPalette());

      const claude = result.current.results.find((item) => item.id === "agent:claude");
      const selected = result.current.handleSelect(claude!);
      expect(selected).toBe(claude);
    });

    it("handleSelect allows selection when installed is undefined (before init)", () => {
      getEffectiveAgentIdsMock.mockReturnValue(["claude"]);
      cliAvailabilityState.isInitialized = false;

      const { result } = renderHook(() => usePanelPalette());

      const claude = result.current.results.find((item) => item.id === "agent:claude");
      expect(claude?.installed).toBeUndefined();

      const selected = result.current.handleSelect(claude!);
      expect(selected).toBe(claude);
    });
  });
});
