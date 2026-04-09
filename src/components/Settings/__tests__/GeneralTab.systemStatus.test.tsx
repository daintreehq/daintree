// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CliAvailability, AgentSettings, HibernationConfig } from "@shared/types";

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));

vi.mock("../SettingsSection", () => ({
  SettingsSection: ({
    children,
    title,
    description,
  }: {
    children: React.ReactNode;
    title: string;
    description?: string;
  }) => (
    <section data-testid={`section-${title}`}>
      <h3>{title}</h3>
      {description && <p data-testid={`section-desc-${title}`}>{description}</p>}
      {children}
    </section>
  ),
}));

vi.mock("../SettingsSubtabBar", () => ({
  SettingsSubtabBar: () => null,
}));

vi.mock("@/components/Settings/SettingsSwitchCard", () => ({
  SettingsSwitchCard: () => null,
}));

vi.mock("@/components/icons", () => ({
  CanopyIcon: () => null,
  ProjectPulseIcon: () => null,
}));

vi.mock("@/store", () => ({
  usePreferencesStore: (selector: (state: Record<string, boolean>) => unknown) =>
    selector({
      showProjectPulse: true,
      showDeveloperTools: false,
      showGridAgentHighlights: true,
      showDockAgentHighlights: true,
    }),
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    subscribe: vi.fn(() => () => {}),
    loadOverrides: vi.fn(() => Promise.resolve()),
    getBinding: vi.fn(() => null),
    getEffectiveCombo: vi.fn(() => null),
    formatComboForDisplay: vi.fn(() => ""),
  },
}));

vi.mock("@/config/agents", () => ({
  getAgentIds: () => ["claude", "gemini", "codex", "opencode", "cursor"],
  getAgentConfig: (id: string) => ({
    name: id.charAt(0).toUpperCase() + id.slice(1),
  }),
}));

const mockDispatch = vi.fn();
vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (actionId: string, ...rest: unknown[]) => mockDispatch(actionId, ...rest),
  },
}));

function setupDispatchMock(cliAvailability: CliAvailability, agentSettings: AgentSettings) {
  mockDispatch.mockImplementation(async (actionId: string) => {
    if (actionId === "cliAvailability.get") {
      return { ok: true, result: cliAvailability };
    }
    if (actionId === "agentSettings.get") {
      return { ok: true, result: agentSettings };
    }
    if (actionId === "hibernation.getConfig") {
      return {
        ok: true,
        result: { enabled: false, inactiveThresholdHours: 24 } as HibernationConfig,
      };
    }
    return { ok: true, result: undefined };
  });
}

function setupElectron() {
  (window as unknown as { electron: unknown }).electron = {
    update: {
      getChannel: vi.fn().mockResolvedValue("stable"),
      setChannel: vi.fn().mockResolvedValue("stable"),
    },
  };
}

async function renderGeneralTab() {
  const { GeneralTab } = await import("../GeneralTab");
  return render(
    <GeneralTab
      appVersion="1.0.0"
      onNavigateToAgents={vi.fn()}
      activeSubtab="overview"
      onSubtabChange={vi.fn()}
    />
  );
}

describe("GeneralTab — System Status filtering (issue #5072)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupElectron();
  });

  it("renders only installed, enabled agents (hides uninstalled)", async () => {
    setupDispatchMock(
      {
        claude: "ready",
        gemini: "ready",
        codex: "missing",
        opencode: "missing",
        cursor: "missing",
      },
      { agents: {} } as unknown as AgentSettings
    );

    await renderGeneralTab();

    await waitFor(() => {
      expect(screen.getByText("Claude")).toBeTruthy();
      expect(screen.getByText("Gemini")).toBeTruthy();
    });

    expect(screen.queryByText("Codex")).toBeNull();
    expect(screen.queryByText("Opencode")).toBeNull();
    expect(screen.queryByText("Cursor")).toBeNull();
    // Both visible rows render the "Ready" badge
    expect(screen.getAllByText("Ready")).toHaveLength(2);
  });

  it("hides installed but user-disabled agents", async () => {
    setupDispatchMock(
      { claude: "ready", gemini: "ready", codex: "ready", opencode: "missing", cursor: "missing" },
      { agents: { gemini: { selected: false } } } as unknown as AgentSettings
    );

    await renderGeneralTab();

    await waitFor(() => {
      expect(screen.getByText("Claude")).toBeTruthy();
    });

    expect(screen.queryByText("Gemini")).toBeNull();
    expect(screen.getByText("Codex")).toBeTruthy();
  });

  it("shows summary for hidden agents with correct count and pluralization", async () => {
    setupDispatchMock(
      {
        claude: "ready",
        gemini: "ready",
        codex: "missing",
        opencode: "missing",
        cursor: "missing",
      },
      { agents: {} } as unknown as AgentSettings
    );

    await renderGeneralTab();

    await waitFor(() => {
      expect(screen.getByText(/Canopy supports 3 more agents/)).toBeTruthy();
    });
  });

  it("uses singular 'agent' when hiddenCount is 1", async () => {
    setupDispatchMock(
      { claude: "ready", gemini: "ready", codex: "ready", opencode: "ready", cursor: "missing" },
      { agents: {} } as unknown as AgentSettings
    );

    await renderGeneralTab();

    await waitFor(() => {
      expect(screen.getByText(/Canopy supports 1 more agent\b/)).toBeTruthy();
    });
  });

  it("hides summary when all agents installed", async () => {
    setupDispatchMock(
      { claude: "ready", gemini: "ready", codex: "ready", opencode: "ready", cursor: "ready" },
      { agents: {} } as unknown as AgentSettings
    );

    await renderGeneralTab();

    await waitFor(() => {
      expect(screen.getByText("Claude")).toBeTruthy();
    });

    expect(screen.queryByText(/Canopy supports/)).toBeNull();
  });

  it("shows 'Needs setup' label for installed-but-not-ready agents", async () => {
    setupDispatchMock(
      {
        claude: "installed",
        gemini: "ready",
        codex: "missing",
        opencode: "missing",
        cursor: "missing",
      },
      { agents: {} } as unknown as AgentSettings
    );

    await renderGeneralTab();

    await waitFor(() => {
      expect(screen.getByText("Claude")).toBeTruthy();
      expect(screen.getByText("Gemini")).toBeTruthy();
    });

    expect(screen.getByText("Needs setup")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
  });

  it("renders empty-state CTA when no agents installed", async () => {
    setupDispatchMock(
      {
        claude: "missing",
        gemini: "missing",
        codex: "missing",
        opencode: "missing",
        cursor: "missing",
      },
      { agents: {} } as unknown as AgentSettings
    );

    await renderGeneralTab();

    await waitFor(() => {
      expect(screen.getByText("No agents installed yet.")).toBeTruthy();
    });

    expect(screen.getByText("Run setup wizard")).toBeTruthy();
    expect(screen.getByText("Browse available agents")).toBeTruthy();
    // Should NOT list any agent rows
    expect(screen.queryByText("Claude")).toBeNull();
  });

  it("setup wizard button dispatches canopy:open-agent-setup-wizard CustomEvent", async () => {
    setupDispatchMock(
      {
        claude: "missing",
        gemini: "missing",
        codex: "missing",
        opencode: "missing",
        cursor: "missing",
      },
      { agents: {} } as unknown as AgentSettings
    );

    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    await renderGeneralTab();

    await waitFor(() => {
      expect(screen.getByText("Run setup wizard")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Run setup wizard"));

    const wizardEvent = dispatchSpy.mock.calls.find(
      ([event]) => event instanceof CustomEvent && event.type === "canopy:open-agent-setup-wizard"
    );
    expect(wizardEvent).toBeTruthy();

    dispatchSpy.mockRestore();
  });

  it("summary link calls onNavigateToAgents without an agent id", async () => {
    setupDispatchMock(
      {
        claude: "ready",
        gemini: "ready",
        codex: "missing",
        opencode: "missing",
        cursor: "missing",
      },
      { agents: {} } as unknown as AgentSettings
    );

    const onNavigate = vi.fn();
    const { GeneralTab } = await import("../GeneralTab");
    render(
      <GeneralTab
        appVersion="1.0.0"
        onNavigateToAgents={onNavigate}
        activeSubtab="overview"
        onSubtabChange={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/Canopy supports 3 more agents/)).toBeTruthy();
    });

    fireEvent.click(screen.getByText(/Canopy supports 3 more agents/));
    expect(onNavigate).toHaveBeenCalledWith();
  });

  it("shows neutral section description, not dependency-check framing", async () => {
    setupDispatchMock(
      {
        claude: "ready",
        gemini: "ready",
        codex: "missing",
        opencode: "missing",
        cursor: "missing",
      },
      { agents: {} } as unknown as AgentSettings
    );

    await renderGeneralTab();

    await waitFor(() => {
      const desc = screen.getByTestId("section-desc-System Status");
      expect(desc.textContent).toBe("Agents ready to use on your system.");
    });
  });
});
