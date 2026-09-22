// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CliAvailability, AgentSettings, HibernationConfig } from "@shared/types";
import { getBuildChannelLabel } from "@shared/config/distribution";

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
  subtabPanelProps: (group: string, activeId: string) => ({
    role: "tabpanel",
    id: `settings-subtabpanel-${group}-${activeId}`,
    "aria-labelledby": `settings-subtab-${group}-${activeId}`,
    tabIndex: -1,
  }),
}));

vi.mock("@/components/Settings/SettingsSwitchCard", () => ({
  SettingsSwitchCard: () => null,
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
    color: "#888888",
    // Identifiable so a test can prove the row actually rendered THIS agent's mark
    // rather than some other glyph that happens to be an svg.
    icon: () => <svg data-brand-mark={id} />,
  }),
  // GeneralTab now renders each row through AgentCard's `resolveIdentity`, which reads
  // the brand mark, colour and blurb as well as the name.
  AGENT_DESCRIPTIONS: {} as Record<string, string>,
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

async function renderGeneralTab(appVersion = "1.0.0") {
  const { GeneralTab } = await import("../GeneralTab");
  return render(
    <GeneralTab
      appVersion={appVersion}
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

  it("renders all installed agents (hides uninstalled)", async () => {
    setupDispatchMock(
      {
        claude: "ready",
        gemini: "ready",
        codex: "missing",
        opencode: "missing",
        cursor: "missing",
      },
      { agents: { claude: { pinned: true }, gemini: { pinned: true } } } as unknown as AgentSettings
    );

    await renderGeneralTab();

    await waitFor(() => {
      expect(screen.getByText("Claude")).toBeTruthy();
      expect(screen.getByText("Gemini")).toBeTruthy();
    });

    expect(screen.queryByText("Codex")).toBeNull();
    expect(screen.queryByText("Opencode")).toBeNull();
    expect(screen.queryByText("Cursor")).toBeNull();
    // Ready is the expected state, so neither row is labelled at all
    expect(screen.queryByText("Ready")).toBeNull();
    expect(screen.queryByText("Needs setup")).toBeNull();
  });

  it("shows installed agents regardless of pin state (issue #5117)", async () => {
    setupDispatchMock(
      { claude: "ready", gemini: "ready", codex: "ready", opencode: "missing", cursor: "missing" },
      {
        agents: { claude: { pinned: true }, codex: { pinned: true }, gemini: { pinned: false } },
      } as unknown as AgentSettings
    );

    await renderGeneralTab();

    await waitFor(() => {
      expect(screen.getByText("Claude")).toBeTruthy();
    });

    // Gemini is installed but unpinned — it MUST appear in System Status.
    expect(screen.getByText("Gemini")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
  });

  it("shows ALL installed agents when none are pinned (issue #5117, adversarial)", async () => {
    setupDispatchMock(
      { claude: "ready", gemini: "ready", codex: "ready", opencode: "missing", cursor: "missing" },
      {
        agents: {
          claude: { pinned: false },
          gemini: { pinned: false },
          codex: { pinned: false },
        },
      } as unknown as AgentSettings
    );

    await renderGeneralTab();

    await waitFor(() => {
      expect(screen.getByText("Claude")).toBeTruthy();
    });

    expect(screen.getByText("Gemini")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.queryByText("Opencode")).toBeNull();
    expect(screen.queryByText("Cursor")).toBeNull();
  });

  it("hides pinned-but-missing agents (pin alone doesn't make an agent appear)", async () => {
    setupDispatchMock(
      {
        claude: "missing",
        gemini: "missing",
        codex: "ready",
        opencode: "missing",
        cursor: "missing",
      },
      {
        agents: {
          claude: { pinned: true },
          gemini: { pinned: true },
          codex: { pinned: true },
        },
      } as unknown as AgentSettings
    );

    await renderGeneralTab();

    await waitFor(() => {
      expect(screen.getByText("Codex")).toBeTruthy();
    });

    // Pinned but missing → must NOT appear.
    expect(screen.queryByText("Claude")).toBeNull();
    expect(screen.queryByText("Gemini")).toBeNull();
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
      { agents: { claude: { pinned: true }, gemini: { pinned: true } } } as unknown as AgentSettings
    );

    await renderGeneralTab();

    await waitFor(() => {
      expect(screen.getByText(/Daintree supports 3 more agents/)).toBeTruthy();
    });
  });

  it("uses singular 'agent' when hiddenCount is 1", async () => {
    setupDispatchMock(
      { claude: "ready", gemini: "ready", codex: "ready", opencode: "ready", cursor: "missing" },
      {
        agents: {
          claude: { pinned: true },
          gemini: { pinned: true },
          codex: { pinned: true },
          opencode: { pinned: true },
        },
      } as unknown as AgentSettings
    );

    await renderGeneralTab();

    await waitFor(() => {
      expect(screen.getByText(/Daintree supports 1 more agent\b/)).toBeTruthy();
    });
  });

  it("hides summary when all agents are installed", async () => {
    setupDispatchMock(
      { claude: "ready", gemini: "ready", codex: "ready", opencode: "ready", cursor: "ready" },
      {
        agents: {
          claude: { pinned: true },
          gemini: { pinned: true },
          codex: { pinned: true },
          opencode: { pinned: true },
          cursor: { pinned: true },
        },
      } as unknown as AgentSettings
    );

    await renderGeneralTab();

    await waitFor(() => {
      expect(screen.getByText("Claude")).toBeTruthy();
    });

    expect(screen.queryByText(/Daintree supports/)).toBeNull();
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
      { agents: { claude: { pinned: true }, gemini: { pinned: true } } } as unknown as AgentSettings
    );

    await renderGeneralTab();

    await waitFor(() => {
      expect(screen.getByText("Claude")).toBeTruthy();
      expect(screen.getByText("Gemini")).toBeTruthy();
    });

    expect(screen.getByText("Needs setup")).toBeTruthy();
    // Only the agent needing attention is labelled; the ready one stays quiet.
    expect(screen.queryByText("Ready")).toBeNull();
  });

  // Green ambient chrome is gone (issue #12002), so colour can no longer be
  // what separates these rows — each attention state has to carry its own
  // glyph, and the expected state has to carry nothing at all.
  it("gives every attention state its own glyph and leaves ready rows bare", async () => {
    setupDispatchMock(
      {
        claude: "blocked",
        gemini: "unauthenticated",
        codex: "installed",
        opencode: "ready",
        cursor: "missing",
      },
      {
        agents: {
          claude: { pinned: true },
          gemini: { pinned: true },
          codex: { pinned: true },
          opencode: { pinned: true },
        },
      } as unknown as AgentSettings
    );

    await renderGeneralTab();

    const rowFor = (name: string) => screen.getByLabelText(new RegExp(`^${name} \u2014 `));
    const attention = [
      { name: "Claude", label: "Blocked" },
      { name: "Gemini", label: "No credentials detected" },
      { name: "Codex", label: "Needs setup" },
    ];

    await waitFor(() => {
      expect(rowFor("Claude").textContent).toContain("Blocked");
    });

    // Each attention state must own both its label and a glyph nothing else uses.
    const glyphs = attention.map(({ name, label }) => {
      const row = rowFor(name);
      const chip = row.querySelector("[data-agent-status]");
      expect(chip).toBeTruthy();
      expect(chip!.getAttribute("data-agent-status")).toBe(label);
      expect(chip!.textContent).toContain(label);
      // The row's aria-label overrides its inner text for assistive tech, so
      // the state has to be repeated there or it is announced as nothing.
      expect(row.getAttribute("aria-label")).toContain(label);
      const svg = chip!.querySelector("svg");
      expect(svg).toBeTruthy();
      return svg!.innerHTML;
    });
    expect(new Set(glyphs).size).toBe(3);

    // Ready is the expected state and carries no chip at all — the section's summary
    // line is where "these are fine" gets said, once, rather than on every row.
    const readyRow = rowFor("Opencode");
    expect(readyRow.querySelector("[data-agent-status]")).toBeNull();
    for (const { label } of attention) {
      expect(readyRow.textContent).not.toContain(label);
      expect(readyRow.getAttribute("aria-label")).not.toContain(label);
    }
  });

  // The row used to be a bare name. Eighteen unfamiliar brands is a reading task
  // without a mark to recognise, so every row must carry its own — and it must be
  // ITS own, not a shared fallback glyph.
  it("renders each agent's own brand mark in its row", async () => {
    setupDispatchMock(
      {
        claude: "ready",
        gemini: "unauthenticated",
        codex: "ready",
        opencode: "missing",
        cursor: "missing",
      },
      { agents: {} } as unknown as AgentSettings
    );

    await renderGeneralTab();

    const rowFor = (name: string) => screen.getByLabelText(new RegExp(`^${name} \u2014 `));

    await waitFor(() => {
      expect(rowFor("Claude")).toBeTruthy();
    });

    for (const [name, id] of [
      ["Claude", "claude"],
      ["Gemini", "gemini"],
      ["Codex", "codex"],
    ] as const) {
      const mark = rowFor(name).querySelector(`[data-brand-mark="${id}"]`);
      expect(mark).toBeTruthy();
    }
  });

  // The rows a user can act on are why they opened the section, so they lead — but
  // within each group the registry order holds, or the roster reshuffles between visits.
  it("lists agents needing attention before ready ones, preserving registry order within each", async () => {
    // Registry order (from the mock): claude, gemini, codex, opencode, cursor.
    setupDispatchMock(
      {
        claude: "ready",
        gemini: "unauthenticated",
        codex: "ready",
        opencode: "blocked",
        cursor: "ready",
      },
      { agents: {} } as unknown as AgentSettings
    );

    await renderGeneralTab();

    await waitFor(() => {
      expect(screen.getAllByRole("listitem").length).toBe(5);
    });
    const order = screen
      .getAllByRole("listitem")
      .map((li) => li.querySelector("[data-agent-row]")!.getAttribute("data-agent-row"));
    expect(order).toEqual(["gemini", "opencode", "claude", "codex", "cursor"]);
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
      expect(screen.getByText(/No agent CLIs found on this machine/)).toBeTruthy();
    });

    expect(screen.getByText("Run setup wizard")).toBeTruthy();
    expect(screen.getByText("Browse available agents")).toBeTruthy();
    // Should NOT list any agent rows
    expect(screen.queryByText("Claude")).toBeNull();
  });

  it("setup wizard button dispatches daintree:open-agent-setup-wizard CustomEvent", async () => {
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
      ([event]) => event instanceof CustomEvent && event.type === "daintree:open-agent-setup-wizard"
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
      { agents: { claude: { pinned: true }, gemini: { pinned: true } } } as unknown as AgentSettings
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
      expect(screen.getByText(/Daintree supports 3 more agents/)).toBeTruthy();
    });

    fireEvent.click(screen.getByText(/Daintree supports 3 more agents/));
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
      { agents: { claude: { pinned: true }, gemini: { pinned: true } } } as unknown as AgentSettings
    );

    await renderGeneralTab();

    await waitFor(() => {
      const desc = screen.getByTestId("section-desc-System status");
      // Two installed, both ready. The rule: the description reports what the probe
      // actually returned rather than asserting a fixed claim, and it never uses
      // dependency-check framing ("requirements", "missing dependencies").
      expect(desc.textContent).toContain("2");
      expect(desc.textContent).toMatch(/ready/i);
      expect(desc.textContent).not.toMatch(/depend|requirement|missing/i);
    });
  });

  it("reports the attention count in the section description when agents need it", async () => {
    setupDispatchMock(
      {
        claude: "ready",
        gemini: "unauthenticated",
        codex: "blocked",
        opencode: "missing",
        cursor: "missing",
      },
      { agents: {} } as unknown as AgentSettings
    );

    await renderGeneralTab();

    await waitFor(() => {
      const desc = screen.getByTestId("section-desc-System status");
      // Three installed, one ready, two wanting something. The description has to
      // separate those two numbers — a single total would hide the problem.
      expect(desc.textContent).toContain("1");
      expect(desc.textContent).toContain("3");
      expect(desc.textContent).toContain("2");
      expect(desc.textContent).toMatch(/attention/i);
    });
  });
});

describe("GeneralTab — build architecture line (issue #10501)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupElectron();
    setupDispatchMock(
      {
        claude: "ready",
        gemini: "missing",
        codex: "missing",
        opencode: "missing",
        cursor: "missing",
      },
      { agents: { claude: { pinned: true } } } as unknown as AgentSettings
    );
  });

  it("renders the architecture line when buildArch is provided", async () => {
    const { GeneralTab } = await import("../GeneralTab");
    render(
      <GeneralTab
        appVersion="1.0.0"
        buildArch="Intel (Rosetta)"
        onNavigateToAgents={vi.fn()}
        activeSubtab="overview"
        onSubtabChange={vi.fn()}
      />
    );

    const archLine = await screen.findByTestId("about-build-arch");
    // Assert the provided value is surfaced verbatim, not a hardcoded label.
    expect(archLine.textContent).toBe("Intel (Rosetta)");
  });

  it("omits the architecture line when buildArch is absent", async () => {
    const { GeneralTab } = await import("../GeneralTab");
    render(
      <GeneralTab
        appVersion="1.0.0"
        onNavigateToAgents={vi.fn()}
        activeSubtab="overview"
        onSubtabChange={vi.fn()}
      />
    );

    // The version label still renders, so the card is present — only the arch line is gated.
    await waitFor(() => {
      expect(screen.getByText("v1.0.0")).toBeTruthy();
    });
    expect(screen.queryByTestId("about-build-arch")).toBeNull();
  });
});

describe("GeneralTab — build channel badge (#11121)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupElectron();
    setupDispatchMock(
      {
        claude: "ready",
        gemini: "missing",
        codex: "missing",
        opencode: "missing",
        cursor: "missing",
      },
      { agents: { claude: { pinned: true } } } as unknown as AgentSettings
    );
  });

  it("shows no channel badge for a stable build and renders the plain version", async () => {
    await renderGeneralTab("1.0.0");

    await waitFor(() => {
      expect(screen.getByText("v1.0.0")).toBeTruthy();
    });
    expect(screen.queryByTestId("about-build-channel")).toBeNull();
  });

  it.each(["0.25.0-nightly.20260713120000.abc1234", "1.0.0-beta.1", "1.0.0-rc.2"])(
    "labels the prerelease build %s with its channel and keeps the full version",
    async (version) => {
      await renderGeneralTab(version);

      // Assert the component renders whatever the shared helper produces (wiring),
      // rather than duplicating the canonical label strings.
      const badge = await screen.findByTestId("about-build-channel");
      expect(badge.textContent).toBe(getBuildChannelLabel(version));
      // The full prerelease-tagged version stays visible for traceability.
      expect(screen.getByText(`v${version}`)).toBeTruthy();
    }
  );
});
