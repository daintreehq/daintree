// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  getEffectiveAgentIds: getEffectiveAgentIdsMock,
  getEffectiveAgentConfig: getEffectiveAgentConfigMock,
}));

vi.mock("@/store/userAgentRegistryStore", () => ({
  useUserAgentRegistryStore: (selector: (state: { registry: Record<string, unknown> | null }) => unknown) =>
    selector({ registry: {} }),
}));

import { usePanelPalette } from "../usePanelPalette";

describe("usePanelPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    getPanelKindIdsMock.mockReturnValue(["terminal"]);
    getPanelKindConfigMock.mockImplementation((id: string) =>
      id === "terminal"
        ? {
            name: "Terminal",
            iconId: "terminal",
            color: "#aaa",
            showInPalette: true,
            shortcut: "Cmd+T",
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
});
