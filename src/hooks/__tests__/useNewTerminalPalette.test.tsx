// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getEffectiveAgentIdsMock, getLaunchOptionsMock, cliAvailabilityState } = vi.hoisted(() => ({
  getEffectiveAgentIdsMock: vi.fn(),
  getLaunchOptionsMock: vi.fn(),
  cliAvailabilityState: {
    availability: {} as Record<string, string>,
    isInitialized: true,
  },
}));

vi.mock("@shared/config/agentRegistry", () => ({
  getEffectiveAgentIds: getEffectiveAgentIdsMock,
}));

vi.mock("@/components/TerminalPalette/launchOptions", () => ({
  getLaunchOptions: getLaunchOptionsMock,
  getMoreAgentsOption: () => ({
    id: "more-agents",
    type: "terminal",
    label: "More agents...",
    description: "Configure which agents appear in this menu",
    icon: null,
  }),
}));

vi.mock("@/store", () => ({
  useWorktreeSelectionStore: (selector: (state: { activeWorktreeId: string | null }) => unknown) =>
    selector({ activeWorktreeId: null }),
  usePanelStore: (selector: (state: { addPanel: typeof vi.fn }) => unknown) =>
    selector({ addPanel: vi.fn() }),
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: { currentProject: null }) => unknown) =>
    selector({ currentProject: null }),
}));

vi.mock("@/store/cliAvailabilityStore", () => {
  const store = (selector: (state: typeof cliAvailabilityState) => unknown) =>
    selector(cliAvailabilityState);
  store.getState = () => cliAvailabilityState;
  return { useCliAvailabilityStore: store };
});

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

import { useNewTerminalPalette } from "../useNewTerminalPalette";

function makeOption(id: string) {
  return {
    id,
    type: id,
    label: id,
    description: `${id} description`,
    icon: null,
  };
}

describe("useNewTerminalPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cliAvailabilityState.isInitialized = true;
    cliAvailabilityState.availability = {};

    getEffectiveAgentIdsMock.mockReturnValue(["claude", "gemini", "codex"]);
    getLaunchOptionsMock.mockReturnValue([
      makeOption("claude"),
      makeOption("gemini"),
      makeOption("codex"),
      makeOption("terminal"),
      makeOption("browser"),
    ]);
  });

  function render() {
    return renderHook(() =>
      useNewTerminalPalette({
        launchAgent: vi.fn().mockResolvedValue(null),
        worktreeMap: new Map(),
      })
    );
  }

  it("shows installed agent regardless of pin state (issue #5117)", () => {
    cliAvailabilityState.availability = {
      claude: "ready",
      gemini: "installed",
      codex: "missing",
    };

    const { result } = render();

    const ids = result.current.results.map((opt) => opt.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("gemini");
    expect(ids).not.toContain("codex");
  });

  it("includes non-agent options (terminal, browser) regardless of availability", () => {
    cliAvailabilityState.availability = {
      claude: "missing",
      gemini: "missing",
      codex: "missing",
    };

    const { result } = render();

    const ids = result.current.results.map((opt) => opt.id);
    expect(ids).toContain("terminal");
    expect(ids).toContain("browser");
  });

  it("shows all agents before availability is initialized", () => {
    cliAvailabilityState.isInitialized = false;
    cliAvailabilityState.availability = {};

    const { result } = render();

    const ids = result.current.results.map((opt) => opt.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("gemini");
    expect(ids).toContain("codex");
  });

  it("always includes the more-agents entry at the end", () => {
    cliAvailabilityState.availability = { claude: "ready", gemini: "ready", codex: "ready" };

    const { result } = render();

    const ids = result.current.results.map((opt) => opt.id);
    expect(ids[ids.length - 1]).toBe("more-agents");
  });
});
