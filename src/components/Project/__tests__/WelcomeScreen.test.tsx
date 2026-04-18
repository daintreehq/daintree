// @vitest-environment jsdom
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const { dispatchMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(() => Promise.resolve()),
}));

const { addProjectMock, openCreateFolderDialogMock, switchProjectMock } = vi.hoisted(() => ({
  addProjectMock: vi.fn(() => Promise.resolve()),
  openCreateFolderDialogMock: vi.fn(),
  switchProjectMock: vi.fn(() => Promise.resolve()),
}));

const { getDisplayComboMock } = vi.hoisted(() => ({
  getDisplayComboMock: vi.fn((actionId: string) => {
    const map: Record<string, string> = {
      "panel.palette": "⌘N",
      "nav.quickSwitcher": "⌘P",
      "terminal.new": "⌘⌥T",
      "action.palette.open": "⌘K",
      "help.shortcuts": "⌘/",
      "app.settings": "⌘,",
    };
    return map[actionId] ?? "";
  }),
}));

const { openExternalMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: { getDisplayCombo: getDisplayComboMock },
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/lib/colorUtils", () => ({
  getProjectGradient: (color?: string) => (color ? `gradient(${color})` : undefined),
  getBrandColorHex: () => "#000000",
}));

const {
  markAgentsSeenMock,
  dismissWelcomeCardMock,
  dismissSetupBannerMock,
  setAgentPinnedMock,
  agentDiscoveryState,
  agentSettingsState,
  cliAvailabilityState,
} = vi.hoisted(() => ({
  markAgentsSeenMock: vi.fn(() => Promise.resolve()),
  dismissWelcomeCardMock: vi.fn(() => Promise.resolve()),
  dismissSetupBannerMock: vi.fn(() => Promise.resolve()),
  setAgentPinnedMock: vi.fn(() => Promise.resolve()),
  agentDiscoveryState: {
    loaded: true,
    seenAgentIds: [] as string[],
    welcomeCardDismissed: false,
    setupBannerDismissed: false,
  },
  agentSettingsState: {
    settings: null as { agents: Record<string, { pinned?: boolean }> } | null,
  },
  cliAvailabilityState: {
    availability: {} as Record<string, "ready" | "installed" | "missing">,
    hasRealData: false,
  },
}));

vi.mock("@/hooks/app/useAgentDiscoveryOnboarding", () => ({
  useAgentDiscoveryOnboarding: () => ({
    loaded: agentDiscoveryState.loaded,
    seenAgentIds: agentDiscoveryState.seenAgentIds,
    welcomeCardDismissed: agentDiscoveryState.welcomeCardDismissed,
    setupBannerDismissed: agentDiscoveryState.setupBannerDismissed,
    markAgentsSeen: markAgentsSeenMock,
    dismissWelcomeCard: dismissWelcomeCardMock,
    dismissSetupBanner: dismissSetupBannerMock,
  }),
}));

vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: (
    selector: (
      s: typeof agentSettingsState & { setAgentPinned: typeof setAgentPinnedMock }
    ) => unknown
  ) => selector({ ...agentSettingsState, setAgentPinned: setAgentPinnedMock }),
}));

vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: (selector: (s: typeof cliAvailabilityState) => unknown) =>
    selector(cliAvailabilityState),
}));

vi.mock("@/config/agents", () => ({
  getAgentConfig: (id: string) => ({
    name: id.charAt(0).toUpperCase() + id.slice(1),
    icon: () => null,
    iconId: id,
  }),
}));

vi.mock("@/utils/timeAgo", () => ({
  formatTimeAgo: (value: number) => `${value}ms ago`,
}));

vi.mock("@/components/icons", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/icons")>();
  return {
    ...actual,
    DaintreeIcon: ({ className }: { className?: string }) => (
      <div data-testid="daintree-icon" className={className} />
    ),
  };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
    size?: string;
  }) => (
    <button onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));

// Mock projectStore
const mockProjects = [
  {
    id: "p1",
    name: "Project Alpha",
    path: "/alpha",
    emoji: "🌲",
    lastOpened: 3000,
    frecencyScore: 10.0,
    color: "#ff0000",
  },
  {
    id: "p2",
    name: "Project Beta",
    path: "/beta",
    emoji: "🌿",
    lastOpened: 1000,
    frecencyScore: 2.0,
  },
  {
    id: "p3",
    name: "Project Gamma",
    path: "/gamma",
    emoji: "🌳",
    lastOpened: 2000,
    frecencyScore: 5.0,
  },
];

let storeState = {
  projects: mockProjects,
  isLoading: false,
  addProject: addProjectMock,
  openCreateFolderDialog: openCreateFolderDialogMock,
  switchProject: switchProjectMock,
};

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

// Mock window.electron
Object.defineProperty(window, "electron", {
  value: {
    system: { openExternal: openExternalMock },
  },
  writable: true,
});

import { WelcomeScreen } from "../WelcomeScreen";
import type { GettingStartedChecklistState } from "@/hooks/app/useGettingStartedChecklist";
import type { ChecklistState } from "@shared/types/ipc/maps";

const allIncomplete: ChecklistState = {
  dismissed: false,
  celebrationShown: false,
  items: {
    openedProject: false,
    launchedAgent: false,
    createdWorktree: false,
    ranSecondParallelAgent: false,
  },
};

const oneComplete: ChecklistState = {
  dismissed: false,
  celebrationShown: false,
  items: {
    openedProject: true,
    launchedAgent: false,
    createdWorktree: false,
    ranSecondParallelAgent: false,
  },
};

const allComplete: ChecklistState = {
  dismissed: false,
  celebrationShown: false,
  items: {
    openedProject: true,
    launchedAgent: true,
    createdWorktree: true,
    ranSecondParallelAgent: true,
  },
};

const dismissed: ChecklistState = {
  dismissed: true,
  celebrationShown: false,
  items: {
    openedProject: false,
    launchedAgent: false,
    createdWorktree: false,
    ranSecondParallelAgent: false,
  },
};

function makeGettingStarted(
  checklist: ChecklistState | null = allIncomplete,
  visible = true
): GettingStartedChecklistState {
  return {
    visible,
    collapsed: false,
    checklist,
    showCelebration: false,
    dismiss: vi.fn(),
    toggleCollapse: vi.fn(),
    notifyOnboardingComplete: vi.fn(),
    markItem: vi.fn(),
  };
}

describe("WelcomeScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState = {
      projects: mockProjects,
      isLoading: false,
      addProject: addProjectMock,
      openCreateFolderDialog: openCreateFolderDialogMock,
      switchProject: switchProjectMock,
    };
    agentDiscoveryState.loaded = true;
    agentDiscoveryState.seenAgentIds = [];
    agentDiscoveryState.welcomeCardDismissed = false;
    // Default to dismissed in existing card/layout suites so they continue
    // to exercise only the behavior they were written for.
    agentDiscoveryState.setupBannerDismissed = true;
    agentSettingsState.settings = null;
    cliAvailabilityState.availability = {};
    cliAvailabilityState.hasRealData = false;
  });

  it("renders hero section with icon, title, and tagline", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    expect(screen.getByTestId("daintree-icon")).toBeTruthy();
    expect(screen.getByText("Welcome to Daintree")).toBeTruthy();
    expect(screen.getByText("A habitat for your AI agents.")).toBeTruthy();
  });

  // --- Recent Projects ---

  it("renders recent projects sorted by frecencyScore descending", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    expect(screen.getByText("Recent Projects")).toBeTruthy();

    const projectNames = screen
      .getAllByText(/Project (Alpha|Beta|Gamma)/)
      .map((el) => el.textContent);
    expect(projectNames).toEqual(["Project Alpha", "Project Gamma", "Project Beta"]);
  });

  it("does not render recent projects section when no projects exist", () => {
    storeState = { ...storeState, projects: [] };
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    expect(screen.queryByText("Recent Projects")).toBeNull();
  });

  it("calls switchProject when a recent project is clicked", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    fireEvent.click(screen.getByText("Project Alpha"));
    expect(switchProjectMock).toHaveBeenCalledWith("p1");
  });

  it("shows project path and time ago for recent projects", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    expect(screen.getByText("/alpha")).toBeTruthy();
    expect(screen.getByText("3000ms ago")).toBeTruthy();
  });

  it("limits recent projects to 5 most recent in descending order", () => {
    const manyProjects = Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`,
      name: `Project ${i}`,
      path: `/path/${i}`,
      emoji: "🌲",
      lastOpened: i * 1000,
      frecencyScore: i,
    }));
    storeState = { ...storeState, projects: manyProjects };
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    const projectNames = screen.getAllByText(/Project \d/).map((el) => el.textContent);
    expect(projectNames).toHaveLength(5);
    // Should be the 5 highest frecencyScore in descending order (7, 6, 5, 4, 3)
    expect(projectNames).toEqual(["Project 7", "Project 6", "Project 5", "Project 4", "Project 3"]);
  });

  // --- Checklist ---

  it("shows Install Daintree as completed first item", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    expect(screen.getByText("Install Daintree")).toBeTruthy();
    expect(screen.getByText("Getting Started")).toBeTruthy();
  });

  it("shows correct progress ratio with endowed item", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(oneComplete)} />);

    // 1 endowed + 1 completed = 2/4
    expect(screen.getByText("2/4")).toBeTruthy();
  });

  it("renders incomplete items as clickable buttons", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(allIncomplete)} />);

    const buttons = screen.getAllByRole("button", {
      name: /open your project|ask ai to help with your code|start a parallel task/i,
    });
    expect(buttons).toHaveLength(3);
  });

  it("dispatches project.openDialog when Open your project is clicked", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(allIncomplete)} />);

    fireEvent.click(screen.getByRole("button", { name: /open your project/i }));
    expect(dispatchMock).toHaveBeenCalledWith("project.openDialog", undefined, {
      source: "user",
    });
  });

  it("dispatches panel.palette when Ask AI to help with your code is clicked", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(allIncomplete)} />);

    fireEvent.click(screen.getByRole("button", { name: /ask ai to help with your code/i }));
    expect(dispatchMock).toHaveBeenCalledWith("panel.palette", undefined, {
      source: "user",
    });
  });

  it("dispatches worktree.createDialog.open when Start a parallel task is clicked", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(allIncomplete)} />);

    fireEvent.click(screen.getByRole("button", { name: /start a parallel task/i }));
    expect(dispatchMock).toHaveBeenCalledWith("worktree.createDialog.open", undefined, {
      source: "user",
    });
  });

  it("renders completed items as non-interactive", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(oneComplete)} />);

    // openedProject is complete — should not be a button
    const openProjectButton = screen.queryByRole("button", { name: /open your project/i });
    expect(openProjectButton).toBeNull();
    expect(screen.getByText("Open your project")).toBeTruthy();
  });

  it("hides checklist when dismissed", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(dismissed)} />);

    expect(screen.queryByText("Getting Started")).toBeNull();
    expect(screen.queryByText("Install Daintree")).toBeNull();
  });

  it("hides checklist when all items are complete", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(allComplete)} />);

    expect(screen.queryByText("Getting Started")).toBeNull();
  });

  it("hides checklist when checklist is null", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(null)} />);

    expect(screen.queryByText("Getting Started")).toBeNull();
  });

  it("hides checklist when visible is false", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(allIncomplete, false)} />);

    expect(screen.queryByText("Getting Started")).toBeNull();
    expect(screen.queryByText("Install Daintree")).toBeNull();
  });

  // --- Quick Actions ---

  it("renders quick action buttons", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    expect(screen.getByText("Open Folder")).toBeTruthy();
    expect(screen.getByText("Create Project")).toBeTruthy();
    expect(screen.getByText("Launch Agent")).toBeTruthy();
  });

  it("calls addProject when Open Folder is clicked", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    fireEvent.click(screen.getByText("Open Folder"));
    expect(addProjectMock).toHaveBeenCalledTimes(1);
  });

  it("calls openCreateFolderDialog when Create Project is clicked", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    fireEvent.click(screen.getByText("Create Project"));
    expect(openCreateFolderDialogMock).toHaveBeenCalledTimes(1);
  });

  it("does not disable quick action buttons when isLoading is true", () => {
    storeState = { ...storeState, isLoading: true };
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    const openFolder = screen.getByText("Open Folder").closest("button")!;
    const createProject = screen.getByText("Create Project").closest("button")!;
    const launchAgent = screen.getByText("Launch Agent").closest("button")!;

    expect(openFolder.disabled).toBe(false);
    expect(createProject.disabled).toBe(false);
    expect(launchAgent.disabled).toBe(false);
  });

  it("dispatches panel.palette when Launch Agent is clicked", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    fireEvent.click(screen.getByText("Launch Agent"));
    expect(dispatchMock).toHaveBeenCalledWith("panel.palette", undefined, { source: "user" });
  });

  // --- Keyboard Shortcuts ---

  it("renders keyboard shortcuts inside kbd elements", () => {
    const { container } = render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    expect(screen.getAllByText("Keyboard Shortcuts").length).toBeGreaterThanOrEqual(1);

    const kbdElements = container.querySelectorAll("kbd");
    expect(kbdElements.length).toBeGreaterThanOrEqual(6);

    const kbdTexts = Array.from(kbdElements).map((el) => el.textContent);
    expect(kbdTexts).toContain("⌘N");
    expect(kbdTexts).toContain("⌘P");
    expect(kbdTexts).toContain("⌘K");
  });

  // --- Footer ---

  it("renders newsletter footer link", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    const newsletterButton = screen.getByText("Newsletter");
    expect(newsletterButton).toBeTruthy();

    fireEvent.click(newsletterButton);
    expect(openExternalMock).toHaveBeenCalledWith("https://daintree.org/newsletter");
  });

  // --- Adaptive Layout ---

  it("shows recent projects before checklist for returning users", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(allIncomplete)} />);

    const recentProjects = screen.getByText("Recent Projects");

    // Recent Projects should appear before Getting Started in DOM order
    const container = recentProjects.closest("[class*='max-w-2xl']")!;
    const headings = Array.from(container.querySelectorAll("h3"));
    const recentIdx = headings.findIndex((h) => h.textContent?.includes("Recent Projects"));
    const checklistIdx = headings.findIndex((h) => h.textContent?.includes("Getting Started"));
    expect(recentIdx).toBeLessThan(checklistIdx);
  });

  it("shows checklist without recent projects for first-time users", () => {
    storeState = { ...storeState, projects: [] };
    render(<WelcomeScreen gettingStarted={makeGettingStarted(allIncomplete)} />);

    expect(screen.queryByText("Recent Projects")).toBeNull();
    expect(screen.getByText("Getting Started")).toBeTruthy();
  });

  // --- Agent Welcome Card (#5111) ---

  describe("agent welcome card", () => {
    it("does not render while availability has no real data", () => {
      cliAvailabilityState.hasRealData = false;
      cliAvailabilityState.availability = { claude: "ready" };
      render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);
      expect(screen.queryByText(/We detected your installed agents/)).toBeNull();
    });

    it("does not render when no agents are ready", () => {
      cliAvailabilityState.hasRealData = true;
      cliAvailabilityState.availability = { claude: "missing", codex: "missing" };
      render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);
      expect(screen.queryByText(/We detected your installed agents/)).toBeNull();
    });

    it("does not render when any agent is already pinned", () => {
      cliAvailabilityState.hasRealData = true;
      cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
      agentSettingsState.settings = { agents: { claude: { pinned: true } } };
      render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);
      expect(screen.queryByText(/We detected your installed agents/)).toBeNull();
    });

    it("does not render when the card has been dismissed", () => {
      cliAvailabilityState.hasRealData = true;
      cliAvailabilityState.availability = { claude: "ready" };
      agentSettingsState.settings = { agents: {} };
      agentDiscoveryState.welcomeCardDismissed = true;
      render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);
      expect(screen.queryByText(/We detected your installed agents/)).toBeNull();
    });

    it("renders with ready agent names when conditions are met", () => {
      cliAvailabilityState.hasRealData = true;
      cliAvailabilityState.availability = {
        claude: "ready",
        codex: "ready",
        gemini: "missing",
      };
      agentSettingsState.settings = { agents: {} };
      render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);
      expect(screen.getByText(/We detected your installed agents/)).toBeTruthy();
      expect(screen.getByText("Claude")).toBeTruthy();
      expect(screen.getByText("Codex")).toBeTruthy();
      expect(screen.queryByText("Gemini")).toBeNull();
    });

    it("pins all ready agents then dismisses when Pin all is clicked", async () => {
      cliAvailabilityState.hasRealData = true;
      cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
      agentSettingsState.settings = { agents: {} };
      render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

      const btn = screen.getByTestId("welcome-card-pin-all");
      await act(async () => {
        fireEvent.click(btn);
      });

      expect(setAgentPinnedMock).toHaveBeenCalledWith("claude", true);
      expect(setAgentPinnedMock).toHaveBeenCalledWith("codex", true);
      expect(markAgentsSeenMock).toHaveBeenCalled();
      expect(dismissWelcomeCardMock).toHaveBeenCalled();
    });

    it("does not pin agents when the Not now link is clicked but still dismisses", async () => {
      cliAvailabilityState.hasRealData = true;
      cliAvailabilityState.availability = { claude: "ready" };
      agentSettingsState.settings = { agents: {} };
      render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

      await act(async () => {
        fireEvent.click(screen.getByText("Not now"));
      });
      expect(setAgentPinnedMock).not.toHaveBeenCalled();
      expect(markAgentsSeenMock).toHaveBeenCalled();
      expect(dismissWelcomeCardMock).toHaveBeenCalled();
    });

    it("keeps the card visible and surfaces an error if any pin fails", async () => {
      cliAvailabilityState.hasRealData = true;
      cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
      agentSettingsState.settings = { agents: {} };
      setAgentPinnedMock.mockImplementationOnce(() => Promise.reject(new Error("IPC down")));

      render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId("welcome-card-pin-all"));
      });

      // First call rejected — card should stay visible with an inline error,
      // and dismiss should NOT have been called.
      expect(screen.getByTestId("welcome-card-pin-error")).toBeTruthy();
      expect(dismissWelcomeCardMock).not.toHaveBeenCalled();
      expect(markAgentsSeenMock).not.toHaveBeenCalled();
    });
  });

  // --- Agent Setup Banner (#5131) ---

  describe("agent setup banner", () => {
    it("does not render until onboarding state is hydrated", () => {
      agentDiscoveryState.loaded = false;
      agentDiscoveryState.setupBannerDismissed = false;
      render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);
      expect(screen.queryByTestId("agent-setup-banner")).toBeNull();
    });

    it("renders when hydrated and not dismissed", () => {
      agentDiscoveryState.loaded = true;
      agentDiscoveryState.setupBannerDismissed = false;
      render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);
      expect(screen.getByTestId("agent-setup-banner")).toBeTruthy();
      expect(screen.getByText("Set up your AI agents")).toBeTruthy();
    });

    it("does not render when dismissed", () => {
      agentDiscoveryState.loaded = true;
      agentDiscoveryState.setupBannerDismissed = true;
      render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);
      expect(screen.queryByTestId("agent-setup-banner")).toBeNull();
    });

    it("calls dismissSetupBanner when the X button is clicked", async () => {
      agentDiscoveryState.loaded = true;
      agentDiscoveryState.setupBannerDismissed = false;
      render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId("agent-setup-banner-dismiss"));
      });
      expect(dismissSetupBannerMock).toHaveBeenCalled();
    });

    it("calls dismissSetupBanner when the Not now link is clicked", async () => {
      agentDiscoveryState.loaded = true;
      agentDiscoveryState.setupBannerDismissed = false;
      render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

      await act(async () => {
        fireEvent.click(screen.getByText("Not now"));
      });
      expect(dismissSetupBannerMock).toHaveBeenCalled();
    });

    it("dispatches daintree:open-agent-setup-wizard with isFirstRun: true when CTA is clicked", async () => {
      agentDiscoveryState.loaded = true;
      agentDiscoveryState.setupBannerDismissed = false;

      const dispatched: CustomEvent[] = [];
      const dispatchSpy = vi.spyOn(window, "dispatchEvent").mockImplementation((e: Event) => {
        dispatched.push(e as CustomEvent);
        return true;
      });

      try {
        render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);
        await act(async () => {
          fireEvent.click(screen.getByTestId("agent-setup-banner-cta"));
        });

        const openEvt = dispatched.find((e) => e.type === "daintree:open-agent-setup-wizard");
        expect(openEvt).toBeTruthy();
        expect(openEvt?.detail).toEqual({ isFirstRun: true });
      } finally {
        dispatchSpy.mockRestore();
      }
    });
  });
});
