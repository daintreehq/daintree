// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MORE_AGENTS_PANEL_ID } from "../usePanelPalette";

const {
  getPanelKindIdsMock,
  getPanelKindConfigMock,
  hasPanelComponentMock,
  getEffectiveAgentIdsMock,
  getEffectiveAgentConfigMock,
} = vi.hoisted(() => ({
  getPanelKindIdsMock: vi.fn(),
  getPanelKindConfigMock: vi.fn(),
  hasPanelComponentMock: vi.fn(),
  getEffectiveAgentIdsMock: vi.fn(),
  getEffectiveAgentConfigMock: vi.fn(),
}));

vi.mock("@shared/config/panelKindRegistry", () => ({
  getPanelKindIds: getPanelKindIdsMock,
  getPanelKindConfig: getPanelKindConfigMock,
}));

vi.mock("@/registry/panelComponentRegistry", () => ({
  hasPanelComponent: hasPanelComponentMock,
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
      settings: { agents: Record<string, { selected?: boolean }> } | null;
    }) => unknown
  ) =>
    selector({ settings: { agents: { claude: { selected: true }, gemini: { selected: true } } } }),
}));

import { usePanelPalette } from "../usePanelPalette";

describe("usePanelPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    getPanelKindIdsMock.mockReturnValue(["browser"]);
    getPanelKindConfigMock.mockImplementation((id: string) =>
      id === "browser"
        ? {
            name: "Browser",
            iconId: "browser",
            color: "#aaa",
            showInPalette: true,
            shortcut: "Cmd+B",
          }
        : null
    );
    hasPanelComponentMock.mockReturnValue(true);
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
        type: "canopy:open-agent-setup-wizard",
        detail: { returnToPanelPalette: true },
      })
    );
    dispatchSpy.mockRestore();
  });
});
