// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeState } from "@/types";

const {
  dispatchMock,
  addPanelMock,
  getEffectiveAgentIdsMock,
  getLaunchOptionsMock,
  closePaletteMock,
  cliAvailabilityState,
  paletteState,
} = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  addPanelMock: vi.fn(),
  getEffectiveAgentIdsMock: vi.fn(),
  getLaunchOptionsMock: vi.fn(),
  closePaletteMock: vi.fn(),
  cliAvailabilityState: {
    availability: {} as Record<string, string>,
    isInitialized: true,
  },
  paletteState: { activePaletteId: null as string | null },
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
    selector({ activeWorktreeId: "wt-1" }),
  usePanelStore: (selector: (state: { addPanel: typeof addPanelMock }) => unknown) =>
    selector({ addPanel: addPanelMock }),
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: { currentProject: { path: string } | null }) => unknown) =>
    selector({ currentProject: { path: "/repo" } }),
}));

vi.mock("@/store/cliAvailabilityStore", () => {
  const store = (selector: (state: typeof cliAvailabilityState) => unknown) =>
    selector(cliAvailabilityState);
  store.getState = () => cliAvailabilityState;
  return { useCliAvailabilityStore: store };
});

vi.mock("@/store/paletteStore", () => {
  const store = Object.assign(
    (selector: (state: { activePaletteId: string | null }) => unknown) => selector(paletteState),
    {
      getState: () => ({
        activePaletteId: paletteState.activePaletteId,
        openPalette: (id: string) => {
          paletteState.activePaletteId = id;
        },
        closePalette: (id: string) => {
          closePaletteMock(id);
          if (paletteState.activePaletteId === id) paletteState.activePaletteId = null;
        },
      }),
    }
  );
  return { usePaletteStore: store };
});

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

import { useNewTerminalPalette, MORE_AGENTS_TERMINAL_ID } from "../useNewTerminalPalette";

function makeOption(id: string, overrides: { type?: string; kind?: string } = {}) {
  return {
    id,
    type: overrides.type ?? id,
    kind: overrides.kind,
    label: id,
    description: `${id} description`,
    icon: null,
  };
}

function makeWorktreeMap(): Map<string, WorktreeState> {
  const map = new Map<string, WorktreeState>();
  map.set("wt-1", {
    id: "wt-1",
    worktreeId: "wt-1",
    path: "/repo/wt-1",
    name: "wt-1",
    branch: "main",
    isCurrent: false,
    isMainWorktree: false,
    worktreeChanges: null,
    lastActivityTimestamp: null,
  });
  return map;
}

describe("useNewTerminalPalette", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    cliAvailabilityState.isInitialized = true;
    cliAvailabilityState.availability = {
      claude: "ready",
      gemini: "ready",
      codex: "ready",
    };
    paletteState.activePaletteId = null;

    getEffectiveAgentIdsMock.mockReturnValue(["claude", "gemini", "codex"]);
    getLaunchOptionsMock.mockReturnValue([
      makeOption("claude"),
      makeOption("gemini"),
      makeOption("codex"),
      makeOption("terminal"),
      makeOption("browser", { type: "terminal", kind: "browser" }),
    ]);

    dispatchMock.mockResolvedValue({ ok: true, result: { terminalId: "term-1" } });
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  function render() {
    return renderHook(() =>
      useNewTerminalPalette({
        worktreeMap: makeWorktreeMap(),
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
    const { result } = render();

    const ids = result.current.results.map((opt) => opt.id);
    expect(ids[ids.length - 1]).toBe("more-agents");
  });

  it("dispatches agent.launch through the ActionService when an agent option is selected", async () => {
    const { result } = render();
    const option = result.current.results.find((r) => r.id === "claude");
    expect(option).toBeDefined();

    await act(async () => {
      await result.current.handleSelect(option!);
    });

    expect(dispatchMock).toHaveBeenCalledWith(
      "agent.launch",
      {
        agentId: "claude",
        worktreeId: "wt-1",
        cwd: "/repo/wt-1",
        location: "grid",
      },
      { source: "user" }
    );
    expect(addPanelMock).not.toHaveBeenCalled();
  });

  it("adds a browser panel without dispatching agent.launch for the browser option", async () => {
    addPanelMock.mockResolvedValueOnce("term-browser");
    const { result } = render();
    const option = result.current.results.find((r) => r.kind === "browser");
    expect(option).toBeDefined();

    await act(async () => {
      await result.current.handleSelect(option!);
    });

    expect(addPanelMock).toHaveBeenCalledWith({
      kind: "browser",
      cwd: "/repo/wt-1",
      worktreeId: "wt-1",
      location: "grid",
    });
    expect(dispatchMock).not.toHaveBeenCalledWith(
      "agent.launch",
      expect.anything(),
      expect.anything()
    );
  });

  it("opens the agents settings tab for MORE_AGENTS_TERMINAL_ID and does not dispatch agent.launch", async () => {
    const { result } = render();
    const option = result.current.results.find((r) => r.id === MORE_AGENTS_TERMINAL_ID);
    expect(option).toBeDefined();

    await act(async () => {
      await result.current.handleSelect(option!);
    });

    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "agents" },
      { source: "user" }
    );
    expect(dispatchMock).not.toHaveBeenCalledWith(
      "agent.launch",
      expect.anything(),
      expect.anything()
    );
  });

  it("logs an error and still closes when agent.launch dispatch fails", async () => {
    dispatchMock.mockResolvedValueOnce({
      ok: false,
      error: { code: "NOT_FOUND", message: "Action not found" },
    });

    const { result } = render();
    const option = result.current.results.find((r) => r.id === "claude");

    await act(async () => {
      await result.current.handleSelect(option!);
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to launch claude terminal:",
      expect.objectContaining({ message: "Action not found" })
    );
  });
});
