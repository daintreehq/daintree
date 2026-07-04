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
  worktreeState,
  projectState,
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
  worktreeState: { worktrees: new Map<string, { id: string; name: string; branch?: string }>() },
  projectState: { currentProject: { id: "proj-1" } as { id: string } | null },
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

vi.mock("@/store/cliAvailabilityStore", () => {
  const store = (selector: (state: typeof cliAvailabilityState) => unknown) =>
    selector(cliAvailabilityState);
  store.getState = () => cliAvailabilityState;
  return { useCliAvailabilityStore: store };
});

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (s: typeof worktreeState) => unknown) => selector(worktreeState),
}));

vi.mock("@/store/projectStore", () => {
  const store = (selector: (s: typeof projectState) => unknown) => selector(projectState);
  store.getState = () => projectState;
  return { useProjectStore: store };
});

// The panel palette reads its open state from the palette store; mark it active
// so the session-history fetch (now gated on `isOpen`) runs under test.
vi.mock("@/store/paletteStore", () => {
  const state = { activePaletteId: "panel" as const };
  const getState = () => ({
    ...state,
    openPalette: vi.fn(),
    closePalette: vi.fn(),
  });
  const store = (selector: (s: typeof state) => unknown) => selector(state);
  store.getState = getState;
  return { usePaletteStore: store };
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

    worktreeState.worktrees = new Map();
    projectState.currentProject = { id: "proj-1" };

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
        projectId: "proj-1",
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

  it("filters out resume sessions with missing sessionId", async () => {
    (window.electron!.agentSessionHistory!.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        sessionId: "",
        agentId: "claude",
        worktreeId: null,
        title: "Fixing bug",
        projectId: "proj-1",
        savedAt: Date.now() - 1000,
      },
      {
        sessionId: "valid-session",
        agentId: "claude",
        worktreeId: null,
        title: null,
        projectId: "proj-1",
        savedAt: Date.now() - 2000,
      },
    ]);

    const { result, rerender } = renderHook(() => usePanelPalette());
    await vi.waitFor(() => {
      rerender();
      const resumeItems = result.current.results.filter((item) => item.id.startsWith("resume:"));
      expect(resumeItems).toHaveLength(1);
      expect(resumeItems[0]!.id).toBe("resume:valid-session");
    });
  });

  it("prefers a meaningful session title in the resume label", async () => {
    (window.electron!.agentSessionHistory!.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        sessionId: "with-title",
        agentId: "claude",
        worktreeId: null,
        title: "Fixing auth bug",
        projectId: "proj-1",
        savedAt: Date.now() - 1000,
      },
    ]);

    const { result, rerender } = renderHook(() => usePanelPalette());
    await vi.waitFor(() => {
      rerender();
      const resume = result.current.results.find((item) => item.id.startsWith("resume:"));
      expect(resume).toBeDefined();
      expect(resume!.name).toBe("Resume: Fixing auth bug");
    });
  });

  it("falls back to agent name when session title is useless", async () => {
    (window.electron!.agentSessionHistory!.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        sessionId: "useless-title",
        agentId: "claude",
        worktreeId: null,
        title: "claude",
        projectId: "proj-1",
        savedAt: Date.now() - 1000,
      },
    ]);

    const { result, rerender } = renderHook(() => usePanelPalette());
    await vi.waitFor(() => {
      rerender();
      const resume = result.current.results.find((item) => item.id.startsWith("resume:"));
      expect(resume).toBeDefined();
      expect(resume!.name).toBe("Resume Claude");
    });
  });

  it("formats resume session description with model and time", async () => {
    (window.electron!.agentSessionHistory!.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        sessionId: "abc12345-6789",
        agentId: "claude",
        worktreeId: null,
        title: null,
        projectId: "proj-1",
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

  describe("browsable resume list (#10851)", () => {
    const makeSession = (overrides: Record<string, unknown>) => ({
      agentId: "claude",
      worktreeId: null,
      title: null,
      projectId: "proj-1",
      savedAt: Date.now() - 1000,
      ...overrides,
    });

    it("caps the resume shelf at the 5 most recent sessions", async () => {
      (window.electron!.agentSessionHistory!.list as ReturnType<typeof vi.fn>).mockResolvedValue(
        Array.from({ length: 8 }, (_, i) =>
          makeSession({ sessionId: `s-${i}`, savedAt: Date.now() - i * 1000 })
        )
      );

      const { result, rerender } = renderHook(() => usePanelPalette());
      await vi.waitFor(() => {
        rerender();
        const resume = result.current.results.filter((item) => item.id.startsWith("resume:"));
        expect(resume).toHaveLength(5);
        // Records arrive newest-first; the shelf keeps the head of the list.
        expect(resume.map((item) => item.id)).toEqual([
          "resume:s-0",
          "resume:s-1",
          "resume:s-2",
          "resume:s-3",
          "resume:s-4",
        ]);
      });
    });

    it("fetches sessions across all worktrees (unscoped list call)", async () => {
      const listSpy = window.electron!.agentSessionHistory!.list as ReturnType<typeof vi.fn>;
      renderHook(() => usePanelPalette());
      await vi.waitFor(() => {
        expect(listSpy).toHaveBeenCalled();
      });
      // No worktree-id argument — the renderer no longer scopes to the active worktree.
      expect(listSpy.mock.calls[0]?.[0]).toBeUndefined();
    });

    it("excludes sessions belonging to another project", async () => {
      (window.electron!.agentSessionHistory!.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeSession({ sessionId: "mine", projectId: "proj-1" }),
        makeSession({ sessionId: "theirs", projectId: "other-proj" }),
      ]);

      const { result, rerender } = renderHook(() => usePanelPalette());
      await vi.waitFor(() => {
        rerender();
        const ids = result.current.results.map((item) => item.id);
        expect(ids).toContain("resume:mine");
        expect(ids).not.toContain("resume:theirs");
      });
    });

    it("keeps legacy null-project records only when their worktree resolves", async () => {
      worktreeState.worktrees = new Map([["wt-1", { id: "wt-1", name: "Feature X" }]]);
      (window.electron!.agentSessionHistory!.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeSession({ sessionId: "legacy-live", projectId: null, worktreeId: "wt-1" }),
        makeSession({ sessionId: "legacy-gone", projectId: null, worktreeId: "wt-missing" }),
        makeSession({ sessionId: "legacy-none", projectId: null, worktreeId: null }),
      ]);

      const { result, rerender } = renderHook(() => usePanelPalette());
      await vi.waitFor(() => {
        rerender();
        const ids = result.current.results.map((item) => item.id);
        expect(ids).toContain("resume:legacy-live");
        expect(ids).not.toContain("resume:legacy-gone");
        expect(ids).not.toContain("resume:legacy-none");
      });
    });

    it("excludes a record whose worktree was removed from the shelf", async () => {
      (window.electron!.agentSessionHistory!.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeSession({ sessionId: "orphan", worktreeId: "wt-removed", branch: "old-branch" }),
        makeSession({ sessionId: "fresh", projectId: "proj-1" }),
      ]);

      const { result, rerender } = renderHook(() => usePanelPalette());
      await vi.waitFor(() => {
        rerender();
        const ids = result.current.results.map((item) => item.id);
        // Stale entries can't launch, so the short shelf drops them; the
        // dedicated resume palette is where they remain visible (greyed).
        expect(ids).toContain("resume:fresh");
        expect(ids).not.toContain("resume:orphan");
      });
    });

    it("resolves live worktree name and branch", async () => {
      worktreeState.worktrees = new Map([
        ["wt-1", { id: "wt-1", name: "Feature X", branch: "feature/x" }],
      ]);
      (window.electron!.agentSessionHistory!.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeSession({ sessionId: "live", worktreeId: "wt-1" }),
      ]);

      const { result, rerender } = renderHook(() => usePanelPalette());
      await vi.waitFor(() => {
        rerender();
        const resume = result.current.results.find((item) => item.id === "resume:live");
        expect(resume).toBeDefined();
        expect(resume!.isStale).toBe(false);
        expect(resume!.worktreeName).toBe("Feature X");
        expect(resume!.branchName).toBe("feature/x");
      });
    });

    it("broadens search aliases to agent, branch, and worktree name", async () => {
      worktreeState.worktrees = new Map([
        ["wt-1", { id: "wt-1", name: "Feature X", branch: "feature/x" }],
      ]);
      (window.electron!.agentSessionHistory!.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeSession({ sessionId: "aliased", worktreeId: "wt-1", title: "Some title" }),
      ]);

      const { result, rerender } = renderHook(() => usePanelPalette());
      await vi.waitFor(() => {
        rerender();
        const resume = result.current.results.find((item) => item.id === "resume:aliased");
        expect(resume).toBeDefined();
        expect(resume!.searchAliases).toEqual(
          expect.arrayContaining(["claude", "Claude", "Feature X", "feature/x"])
        );
      });
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

    it("omits missing agents from the palette once availability is initialized", () => {
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
      expect(gemini).toBeUndefined();
    });

    it("shows a plugin agent with undefined availability as installed=false, not hidden (#10560)", () => {
      // A plugin-contributed agent that CliAvailabilityService has not probed
      // has no availability entry. It must surface greyed-out, not vanish the
      // way an uninstalled built-in does.
      getEffectiveAgentIdsMock.mockReturnValue(["acme-agent"]);
      getEffectiveAgentConfigMock.mockReturnValue({
        name: "Acme Agent",
        iconId: "terminal",
        color: "#3366ff",
        tooltip: "Acme plugin agent",
      });
      cliAvailabilityState.availability = {};

      const { result } = renderHook(() => usePanelPalette());

      const acme = result.current.results.find((item) => item.id === "agent:acme-agent");
      expect(acme).toBeDefined();
      expect(acme?.installed).toBe(false);
    });

    it("shows a plugin agent even when its command is probed as missing (#10560)", () => {
      getEffectiveAgentIdsMock.mockReturnValue(["acme-agent"]);
      getEffectiveAgentConfigMock.mockReturnValue({
        name: "Acme Agent",
        iconId: "terminal",
        color: "#3366ff",
      });
      cliAvailabilityState.availability = { "acme-agent": "missing" };

      const { result } = renderHook(() => usePanelPalette());

      const acme = result.current.results.find((item) => item.id === "agent:acme-agent");
      expect(acme).toBeDefined();
      expect(acme?.installed).toBe(false);
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

    it("still defensively routes handleSelect to setup wizard when installed=false is passed", () => {
      // Missing agents are now filtered out of the palette entirely (issue #5117), but the
      // handleSelect branch guarding against `installed === false` is kept as a defensive
      // fallback — e.g. for stale options held in closures or future code paths.
      const dispatchSpy = vi.spyOn(window, "dispatchEvent");
      const { result } = renderHook(() => usePanelPalette());
      const syntheticOption = {
        id: "agent:gemini",
        name: "Gemini",
        iconId: "gemini",
        color: "#4285f4",
        category: "agent" as const,
        installed: false,
      };

      const selected = result.current.handleSelect(syntheticOption);
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

  describe("pin-independent visibility (issue #5117)", () => {
    it("shows installed agents regardless of pin state", () => {
      getEffectiveAgentIdsMock.mockReturnValue(["claude", "gemini"]);
      getEffectiveAgentConfigMock.mockImplementation((id: string) => ({
        name: id.charAt(0).toUpperCase() + id.slice(1),
        iconId: id,
        color: "#000",
        tooltip: `${id} agent`,
      }));
      cliAvailabilityState.availability = { claude: "ready", gemini: "installed" };

      const { result } = renderHook(() => usePanelPalette());

      const ids = result.current.results.map((item) => item.id);
      expect(ids).toContain("agent:claude");
      expect(ids).toContain("agent:gemini");
    });

    it("hides missing agents once availability is initialized", () => {
      getEffectiveAgentIdsMock.mockReturnValue(["claude", "gemini"]);
      getEffectiveAgentConfigMock.mockImplementation((id: string) => ({
        name: id,
        iconId: id,
        color: "#000",
        tooltip: id,
      }));
      cliAvailabilityState.availability = { claude: "ready", gemini: "missing" };

      const { result } = renderHook(() => usePanelPalette());

      const ids = result.current.results.map((item) => item.id);
      expect(ids).toContain("agent:claude");
      expect(ids).not.toContain("agent:gemini");
    });

    it("shows all agents before availability initializes (no premature filter)", () => {
      getEffectiveAgentIdsMock.mockReturnValue(["claude", "gemini"]);
      getEffectiveAgentConfigMock.mockImplementation((id: string) => ({
        name: id,
        iconId: id,
        color: "#000",
        tooltip: id,
      }));
      cliAvailabilityState.isInitialized = false;
      cliAvailabilityState.availability = {};

      const { result } = renderHook(() => usePanelPalette());

      const ids = result.current.results.map((item) => item.id);
      expect(ids).toContain("agent:claude");
      expect(ids).toContain("agent:gemini");
    });
  });
});
