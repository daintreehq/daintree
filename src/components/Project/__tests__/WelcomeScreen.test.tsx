// @vitest-environment jsdom
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// The app root supplies the TooltipProvider; render tooltips inline here.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const { dispatchMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(() => Promise.resolve()),
}));

const {
  addProjectMock,
  addProjectByPathMock,
  openCreateFolderDialogMock,
  openCloneRepoDialogMock,
  switchProjectMock,
} = vi.hoisted(() => ({
  addProjectMock: vi.fn(() => Promise.resolve()),
  addProjectByPathMock: vi.fn((_path: string, _options?: unknown) => Promise.resolve()),
  openCreateFolderDialogMock: vi.fn(),
  openCloneRepoDialogMock: vi.fn(),
  switchProjectMock: vi.fn(() => Promise.resolve()),
}));

const { getDisplayComboMock } = vi.hoisted(() => ({
  getDisplayComboMock: vi.fn((actionId: string) => {
    const map: Record<string, string> = {
      "panel.palette": "Cmd+N",
      "nav.quickSwitcher": "Cmd+P",
      "terminal.new": "Cmd+Alt+T",
      "action.palette.open": "Cmd+K",
      "help.shortcuts": "Cmd+/",
      "app.settings": "Cmd+,",
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
  keybindingService: {
    getDisplayCombo: getDisplayComboMock,
    getEffectiveCombo: getDisplayComboMock,
  },
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
const mockProjects: Array<{
  id: string;
  name: string;
  path: string;
  emoji: string;
  lastOpened: number;
  frecencyScore: number;
  lastAccessedAt?: number;
  color?: string;
}> = [
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
  addProjectByPath: addProjectByPathMock,
  openCreateFolderDialog: openCreateFolderDialogMock,
  openCloneRepoDialog: openCloneRepoDialogMock,
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

import { WelcomeScreen, isAgentWelcomeCardEligible } from "../WelcomeScreen";
import type { GettingStartedChecklistState } from "@/hooks/app/useGettingStartedChecklist";
import type { ChecklistState } from "@shared/types/ipc/maps";
import { usePreferencesStore } from "@/store/preferencesStore";
import { DEFAULT_OTHER_PROJECTS_SORT_MODE, type OtherProjectsSortMode } from "@/lib/projectSort";

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
    getDisplayComboMock.mockImplementation((actionId: string) => {
      const map: Record<string, string> = {
        "panel.palette": "Cmd+N",
        "nav.quickSwitcher": "Cmd+P",
        "terminal.new": "Cmd+Alt+T",
        "action.palette.open": "Cmd+K",
        "help.shortcuts": "Cmd+/",
        "app.settings": "Cmd+,",
      };
      return map[actionId] ?? "";
    });
    storeState = {
      projects: mockProjects,
      isLoading: false,
      addProject: addProjectMock,
      addProjectByPath: addProjectByPathMock,
      openCreateFolderDialog: openCreateFolderDialogMock,
      openCloneRepoDialog: openCloneRepoDialogMock,
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

  it("renders hero section with icon, title, and tagline for first-time users", () => {
    storeState = { ...storeState, projects: [] };
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    expect(screen.getByTestId("daintree-icon")).toBeTruthy();
    expect(screen.getByText("Welcome to Daintree")).toBeTruthy();
    expect(screen.getByText("A habitat for your AI agents.")).toBeTruthy();
  });

  it("suppresses hero for returning users with projects", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    expect(screen.queryByText("Welcome to Daintree")).toBeNull();
    expect(screen.queryByText("A habitat for your AI agents.")).toBeNull();
  });

  // --- Top projects ---

  it("renders the project list sorted by effective frecency descending", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    // "Your projects", not "Recent projects" — the list is ranked by decayed
    // use, so a recency label would misdescribe the order it sits above.
    expect(screen.getByText("Your projects")).toBeTruthy();

    const projectNames = screen
      .getAllByText(/Project (Alpha|Beta|Gamma)/)
      .map((el) => el.textContent);
    expect(projectNames).toEqual(["Project Alpha", "Project Gamma", "Project Beta"]);
  });

  it("ranks a fresh score above a stale snapshot that reads higher raw", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    storeState = {
      ...storeState,
      projects: [
        {
          id: "stale",
          name: "Project Stale",
          path: "/stale",
          emoji: "🌲",
          lastOpened: now - 30 * DAY,
          frecencyScore: 20.0,
          // Frozen a month ago — must decay at read time, not rank raw.
          lastAccessedAt: now - 30 * DAY,
        },
        {
          id: "fresh",
          name: "Project Fresh",
          path: "/fresh",
          emoji: "🌿",
          lastOpened: now,
          frecencyScore: 4.0,
          lastAccessedAt: now,
        },
      ],
    };
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    const projectNames = screen.getAllByText(/Project (Stale|Fresh)/).map((el) => el.textContent);
    expect(projectNames).toEqual(["Project Fresh", "Project Stale"]);
  });

  // The switcher's Other band and this list carry a standing promise never to
  // disagree on order, so this list follows the same preference (#11455).
  describe("follows the project switcher's Other band sort mode — issue #11455", () => {
    // Alpha is the most used, Beta the most recently opened, Gamma neither —
    // so the three modes produce three different orders.
    const conflicting = [
      { name: "Project Alpha", lastOpened: 3000, frecencyScore: 10.0 },
      { name: "Project Beta", lastOpened: 9000, frecencyScore: 2.0 },
      { name: "Project Gamma", lastOpened: 2000, frecencyScore: 5.0 },
    ];

    function renderWithMode(mode: OtherProjectsSortMode): (string | null)[] {
      usePreferencesStore.getState().setProjectSwitcherOtherSortMode(mode);
      storeState = {
        ...storeState,
        projects: conflicting.map((p, i) => ({
          id: `c${i}`,
          path: `/c${i}`,
          emoji: "🌲",
          ...p,
        })),
      };
      render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);
      return screen.getAllByText(/Project (Alpha|Beta|Gamma)/).map((el) => el.textContent);
    }

    afterEach(() => {
      usePreferencesStore
        .getState()
        .setProjectSwitcherOtherSortMode(DEFAULT_OTHER_PROJECTS_SORT_MODE);
    });

    it("ranks by decayed score in most used", () => {
      expect(renderWithMode("mostUsed")).toEqual([
        "Project Alpha",
        "Project Gamma",
        "Project Beta",
      ]);
    });

    it("ranks by last opened in recent", () => {
      expect(renderWithMode("recent")).toEqual(["Project Beta", "Project Alpha", "Project Gamma"]);
    });

    it("ranks by name in alphabetical", () => {
      expect(renderWithMode("alphabetical")).toEqual([
        "Project Alpha",
        "Project Beta",
        "Project Gamma",
      ]);
    });

    it("applies the cap after sorting, not before", () => {
      // Slicing first would cap the frecency order and then re-rank those five,
      // so the list would show whichever projects frecency happened to surface
      // rather than the five this mode actually ranks top.
      usePreferencesStore.getState().setProjectSwitcherOtherSortMode("recent");
      // The five most recent are 7,6,5,4,3 — all sitting PAST the cap in array
      // order, and the array is in ascending recency so a cap-then-sort would
      // return 0..4, the five LEAST recent. Only sorting first can find them.
      storeState = {
        ...storeState,
        projects: Array.from({ length: 8 }, (_, i) => ({
          id: `p${i}`,
          name: `Project ${i}`,
          path: `/path/${i}`,
          emoji: "🌲",
          lastOpened: (i + 1) * 1000,
          // Score runs opposite to recency, so a stray frecency comparison
          // would also produce a different set.
          frecencyScore: 8 - i,
        })),
      };
      render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

      const names = screen.getAllByText(/Project \d/).map((el) => el.textContent);
      expect(names).toEqual(["Project 7", "Project 6", "Project 5", "Project 4", "Project 3"]);
    });
  });

  it("does not render the project list section when no projects exist", () => {
    storeState = { ...storeState, projects: [] };
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    expect(screen.queryByText("Your projects")).toBeNull();
  });

  it("calls switchProject when a recent project is clicked", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    fireEvent.click(screen.getByText("Project Alpha"));
    expect(switchProjectMock).toHaveBeenCalledWith("p1");
  });

  it("shows project path and time ago for listed projects", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    expect(screen.getByText("/alpha")).toBeTruthy();
    expect(screen.getByText("3000ms ago")).toBeTruthy();
  });

  it("limits the project list to the top 5 by effective score", () => {
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
    expect(screen.getByText("Getting started")).toBeTruthy();
  });

  it("shows correct progress ratio with endowed item", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(oneComplete)} />);

    // 1 endowed + 1 completed = 2/5
    expect(screen.getByText("2/5")).toBeTruthy();
  });

  it("reports progress without offering its own actions — the cards own them", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(allIncomplete)} />);

    // No project is open on this screen, so a row that acted would act on
    // nothing; the one row that could is the Open project card's job.
    expect(
      screen.queryAllByRole("button", {
        name: /open your project|launch your first agent|start a parallel task|run two agents/i,
      })
    ).toHaveLength(0);
    expect(screen.getByText("Open your project")).toBeTruthy();
    expect(screen.getByText("Run two agents in parallel")).toBeTruthy();
  });

  it("describes only the next step and marks it current", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(oneComplete)} />);

    const current = document.querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toContain("Launch your first agent");
    // The next step says what it involves; the rest wait their turn.
    expect(current[0]!.textContent).toContain("Then ask it");
    expect(screen.queryByText("Work on two things at once without switching branches")).toBeNull();
    expect(screen.queryByText(/Connect a local folder/)).toBeNull();
  });

  it("announces completed items as done", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(oneComplete)} />);

    const done = Array.from(document.querySelectorAll("li"))
      .filter((li) => li.textContent?.startsWith("Done: "))
      .map((li) => li.textContent);
    expect(done).toEqual(["Done: Install Daintree", "Done: Open your project"]);
  });

  it("hides from the checklist's own header through the persisted dismissal", () => {
    const gettingStarted = makeGettingStarted(allIncomplete);
    render(<WelcomeScreen gettingStarted={gettingStarted} />);

    fireEvent.click(screen.getByRole("button", { name: "Hide getting started" }));
    expect(gettingStarted.dismiss).toHaveBeenCalledTimes(1);
  });

  it("hides checklist when dismissed", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(dismissed)} />);

    expect(screen.queryByText("Getting started")).toBeNull();
    expect(screen.queryByText("Install Daintree")).toBeNull();
  });

  it("hides checklist when all items are complete", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(allComplete)} />);

    expect(screen.queryByText("Getting started")).toBeNull();
  });

  it("hides checklist when checklist is null", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(null)} />);

    expect(screen.queryByText("Getting started")).toBeNull();
  });

  it("hides checklist when visible is false", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(allIncomplete, false)} />);

    expect(screen.queryByText("Getting started")).toBeNull();
    expect(screen.queryByText("Install Daintree")).toBeNull();
  });

  it("shows 5/5 progress when all items are complete", () => {
    // The checklist is hidden when all done, so test through NudgeSequencer
    // by simulating that the checklist would show.
    agentDiscoveryState.loaded = true;
    agentDiscoveryState.setupBannerDismissed = true;
    agentDiscoveryState.welcomeCardDismissed = true;
    cliAvailabilityState.hasRealData = false;

    render(<WelcomeScreen gettingStarted={makeGettingStarted(allComplete)} />);
    // All done — checklist is hidden (showChecklist is false when allDone)
    expect(screen.queryByText("Getting started")).toBeNull();
  });

  it("renders progress at 100% width when all items complete", () => {
    agentDiscoveryState.loaded = true;
    agentDiscoveryState.setupBannerDismissed = true;
    agentDiscoveryState.welcomeCardDismissed = true;
    cliAvailabilityState.hasRealData = false;

    // Use 3 of 4 complete — checklist still shows, progress is 4/5 = 80%
    const threeComplete: ChecklistState = {
      dismissed: false,
      celebrationShown: false,
      items: {
        openedProject: true,
        launchedAgent: true,
        createdWorktree: true,
        ranSecondParallelAgent: false,
      },
    };
    render(<WelcomeScreen gettingStarted={makeGettingStarted(threeComplete)} />);
    expect(screen.getByText("4/5")).toBeTruthy();
  });

  it("renders progress bar at correct width for 1/5, 2/5, and 4/5", () => {
    agentDiscoveryState.loaded = true;
    agentDiscoveryState.setupBannerDismissed = true;
    agentDiscoveryState.welcomeCardDismissed = true;
    cliAvailabilityState.hasRealData = false;

    const scenarios = [
      { state: allIncomplete, expected: "20%" },
      { state: oneComplete, expected: "40%" },
    ];
    for (const { state, expected } of scenarios) {
      const { unmount } = render(<WelcomeScreen gettingStarted={makeGettingStarted(state)} />);
      const bar = screen.getByRole("progressbar").firstElementChild as HTMLElement;
      expect(bar?.style.width).toBe(expected);
      unmount();
    }
  });

  it("marks the only remaining incomplete item as the current step", () => {
    const onlyLastIncomplete: ChecklistState = {
      dismissed: false,
      celebrationShown: false,
      items: {
        openedProject: true,
        launchedAgent: true,
        createdWorktree: true,
        ranSecondParallelAgent: false,
      },
    };
    render(<WelcomeScreen gettingStarted={makeGettingStarted(onlyLastIncomplete)} />);

    const current = document.querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain("Run two agents in parallel");
  });

  // --- Cold-start flash (agentSettings hydration) ---

  it("does not render welcome card when agentSettings is null", () => {
    agentDiscoveryState.loaded = true;
    agentDiscoveryState.setupBannerDismissed = true;
    agentDiscoveryState.welcomeCardDismissed = false;
    cliAvailabilityState.hasRealData = true;
    cliAvailabilityState.availability = { claude: "ready" };
    agentSettingsState.settings = null;

    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    expect(screen.queryByText(/Installed agents found/)).toBeNull();
  });

  it("does not render welcome card when agentSettings is undefined", () => {
    agentDiscoveryState.loaded = true;
    agentDiscoveryState.setupBannerDismissed = true;
    agentDiscoveryState.welcomeCardDismissed = false;
    cliAvailabilityState.hasRealData = true;
    cliAvailabilityState.availability = { claude: "ready" };
    agentSettingsState.settings = undefined as unknown as null;

    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    expect(screen.queryByText(/Installed agents found/)).toBeNull();
  });

  it("renders welcome card after agentSettings hydrates with no pinned agents", () => {
    agentDiscoveryState.loaded = true;
    agentDiscoveryState.setupBannerDismissed = true;
    agentDiscoveryState.welcomeCardDismissed = false;
    cliAvailabilityState.hasRealData = true;
    cliAvailabilityState.availability = { claude: "ready" };
    agentSettingsState.settings = { agents: {} };

    render(<WelcomeScreen gettingStarted={makeGettingStarted(null)} />);

    expect(screen.getByText(/Installed agents found/)).toBeTruthy();
  });

  // --- Keyboard Shortcuts empty state ---

  it("suppresses Keyboard Shortcuts section when all combos are empty", () => {
    getDisplayComboMock.mockReturnValue("");

    render(<WelcomeScreen gettingStarted={makeGettingStarted(null)} />);

    expect(screen.queryByText("Keyboard shortcuts")).toBeNull();
  });

  it("renders Keyboard Shortcuts section when only one combo is available", () => {
    getDisplayComboMock.mockImplementation((actionId: string) => {
      if (actionId === "panel.palette") return "Cmd+N";
      return "";
    });

    render(<WelcomeScreen gettingStarted={makeGettingStarted(null)} />);

    expect(screen.getByText("Keyboard shortcuts")).toBeTruthy();
    // The visible chips, as this (non-mac) test platform prints them.
    expect(screen.getByText("New panel").parentElement?.textContent).toContain("Ctrl+N");
    expect(screen.queryByText("Quick switcher")).toBeNull();
  });

  // --- Quick Actions ---

  it("renders quick action cards with sentence-case labels and descriptions", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    expect(screen.getByText("Open project")).toBeTruthy();
    expect(screen.getByText("Create project")).toBeTruthy();
    expect(screen.getByText("Clone repository")).toBeTruthy();
    // No projectless agent launch: it would start the agent in the home folder.
    expect(screen.queryByText("Launch agent")).toBeNull();

    // Each secondary action carries a short description to tell them apart.
    expect(screen.getByText("Open an existing project on your machine")).toBeTruthy();
    expect(screen.getByText("Start fresh in a new folder")).toBeTruthy();
    expect(screen.getByText("Pull a repo from a Git URL")).toBeTruthy();
  });

  it("groups quick actions in an accessible region with described cards", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    const group = screen.getByTestId("quick-actions");
    expect(group.getAttribute("role")).toBe("group");

    const openFolder = screen.getByText("Open project").closest("button")!;
    const describedBy = openFolder.getAttribute("aria-describedby");
    expect(describedBy).toBe("qa-desc-open-folder");
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      "Open an existing project on your machine"
    );
  });

  it("calls addProject when Open project is clicked", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    fireEvent.click(screen.getByText("Open project"));
    expect(addProjectMock).toHaveBeenCalledTimes(1);
  });

  it("offers Open project in a new window as a secondary action (#12594)", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    const secondary = screen.getByRole("button", { name: "Open in new window…" });
    // A sibling of the card, never nested inside its button.
    expect(secondary.parentElement?.closest("button")).toBeNull();
    expect(screen.getByText("Open project").closest("button")!.contains(secondary)).toBe(false);

    fireEvent.click(secondary);

    expect(addProjectByPathMock).toHaveBeenCalledExactlyOnceWith("", { disposition: "new" });
    expect(addProjectMock).not.toHaveBeenCalled();
  });

  it("calls openCreateFolderDialog when Create project is clicked", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    fireEvent.click(screen.getByText("Create project"));
    expect(openCreateFolderDialogMock).toHaveBeenCalledTimes(1);
  });

  it("calls openCloneRepoDialog when Clone repository is clicked", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    fireEvent.click(screen.getByText("Clone repository"));
    expect(openCloneRepoDialogMock).toHaveBeenCalledTimes(1);
  });

  it("does not disable quick action buttons when isLoading is true", () => {
    storeState = { ...storeState, isLoading: true };
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    const openFolder = screen.getByText("Open project").closest("button")!;
    const createProject = screen.getByText("Create project").closest("button")!;
    const cloneRepository = screen.getByText("Clone repository").closest("button")!;

    expect(openFolder.disabled).toBe(false);
    expect(createProject.disabled).toBe(false);
    expect(cloneRepository.disabled).toBe(false);
  });

  it("lifts the Open project card and hides the heading for first-time users", () => {
    storeState = { ...storeState, projects: [] };
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    // No "Quick actions" heading competes with the hero copy for new users.
    expect(screen.queryByText("Quick actions")).toBeNull();

    const group = screen.getByTestId("quick-actions");
    expect(group.getAttribute("aria-label")).toBe("Quick actions");

    const openFolder = screen.getByText("Open project").closest("button")!;
    expect(openFolder.className).toContain("bg-surface-panel-elevated/95");

    // Only the primary card is lifted — the secondary cards are not.
    for (const label of ["Create project", "Clone repository"]) {
      const card = screen.getByText(label).closest("button")!;
      expect(card.className).not.toContain("bg-surface-panel-elevated/95");
    }
  });

  it("adds a muted heading and demotes the Open project card for returning users", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    expect(screen.getByText("Quick actions")).toBeTruthy();

    const group = screen.getByTestId("quick-actions");
    expect(group.getAttribute("aria-labelledby")).toBe("quick-actions-heading");

    // With recents present the list owns the primary path — no card lift.
    const openFolder = screen.getByText("Open project").closest("button")!;
    expect(openFolder.className).not.toContain("bg-surface-panel-elevated/95");
  });

  // --- Keyboard Shortcuts ---

  it("renders keyboard shortcuts as key chips beside sentence-case labels", () => {
    const { container } = render(<WelcomeScreen gettingStarted={makeGettingStarted(null)} />);

    expect(screen.getAllByText("Keyboard shortcuts").length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll("kbd").length).toBeGreaterThanOrEqual(6);
    expect(screen.getByText("Command palette").parentElement?.textContent).toContain("Ctrl+K");
  });

  it("keeps the shortcut list off the screen while the checklist is teaching", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(allIncomplete)} />);

    expect(screen.getByText("Getting started")).toBeTruthy();
    expect(screen.queryByText("Keyboard shortcuts")).toBeNull();
  });

  // --- Footer ---

  it("renders newsletter footer link", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    const newsletterButton = screen.getByText("Newsletter");
    expect(newsletterButton).toBeTruthy();

    fireEvent.click(newsletterButton);
    expect(openExternalMock).toHaveBeenCalledWith("https://daintree.org/newsletter");
  });

  it("offers a way back into agent setup once the banner is gone", () => {
    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener("daintree:open-agent-setup-wizard", listener);
    try {
      render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);
      fireEvent.click(screen.getByRole("button", { name: "Set up agents" }));
      expect(events).toHaveLength(1);
      expect(events[0]!.detail).toEqual({ isFirstRun: false });
    } finally {
      window.removeEventListener("daintree:open-agent-setup-wizard", listener);
    }
  });

  it("keeps the footer entry out of the way while the setup banner is still up", () => {
    agentDiscoveryState.setupBannerDismissed = false;
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    // The banner's own button is the only setup entry on screen.
    expect(screen.getAllByRole("button", { name: /set up agents/i })).toHaveLength(1);
  });

  // --- Adaptive Layout ---

  it("shows the project list before the checklist for returning users", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(allIncomplete)} />);

    const projectList = screen.getByText("Your projects");

    // The project list should appear before Getting Started in DOM order
    const container = projectList.closest("[class*='max-w-2xl']")!;
    const headings = Array.from(container.querySelectorAll("h3"));
    const projectsIdx = headings.findIndex((h) => h.textContent?.includes("Your projects"));
    const checklistIdx = headings.findIndex((h) => h.textContent?.includes("Getting started"));
    expect(projectsIdx).toBeLessThan(checklistIdx);
  });

  it("shows checklist without a project list for first-time users", () => {
    storeState = { ...storeState, projects: [] };
    render(<WelcomeScreen gettingStarted={makeGettingStarted(allIncomplete)} />);

    expect(screen.queryByText("Recent projects")).toBeNull();
    expect(screen.getByText("Getting started")).toBeTruthy();
  });

  // --- Container-scaled layout (#12438) ---

  // jsdom evaluates no container queries, so these pin the invariants the
  // queries depend on rather than the rendered sizes.
  const MEASURE_SCALE = ["xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl"];
  // The widest default display on a current MacBook; laptop layouts stay put.
  const WIDEST_LAPTOP_PX = 1728;
  const welcomeTier = /^@min-\[(\d+)px\]\/welcome:(.+)$/;
  const layoutCases: Array<[string, typeof mockProjects, boolean]> = [
    ["returning users", mockProjects, true],
    ["first-time users", [], true],
    ["users yet to set up agents", [], false],
  ];

  it.each(layoutCases)(
    "scales off an uncapped container wrapping the scroller for %s",
    (_, projects, setupBannerDismissed) => {
      storeState = { ...storeState, projects };
      agentDiscoveryState.setupBannerDismissed = setupBannerDismissed;
      const { container } = render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

      const roots = container.querySelectorAll<HTMLElement>('[class*="@container/welcome"]');
      expect(roots).toHaveLength(1);
      const root = roots[0]!;
      expect(root).toBe(container.firstElementChild);

      // As the scroller, the query would measure a width that changes as the
      // scrollbar comes and goes, and a surface on a tier boundary could flip.
      expect(root.classList.contains("overflow-y-auto")).toBe(false);
      const scroller = root.firstElementChild;
      expect(scroller?.classList.contains("overflow-y-auto")).toBe(true);

      // A root capped at the column's width could never satisfy a wider query.
      expect(Array.from(root.classList).some((token) => token.startsWith("max-w-"))).toBe(false);

      const column = scroller!.firstElementChild!;
      expect(column.contains(screen.getByTestId("quick-actions"))).toBe(true);

      // Every wider tier must widen the column past the tier before it.
      const tokens = Array.from(column.classList);
      const baseMeasure = tokens.flatMap((token) => /^max-w-(\w+)$/.exec(token)?.[1] ?? []);
      expect(baseMeasure).toHaveLength(1);
      const steps = tokens
        .flatMap((token) => {
          const match = welcomeTier.exec(token);
          const measure = match?.[2]?.match(/^max-w-(\w+)$/)?.[1];
          return match && measure ? [{ px: Number(match[1]), measure }] : [];
        })
        .sort((a, b) => a.px - b.px);
      expect(steps.length).toBeGreaterThan(0);
      const ranks = [...baseMeasure, ...steps.map((step) => step.measure)].map((measure) =>
        MEASURE_SCALE.indexOf(measure)
      );
      expect(ranks).not.toContain(-1);
      for (let i = 1; i < ranks.length; i++) {
        expect(ranks[i]).toBeGreaterThan(ranks[i - 1]!);
      }

      // No tier anywhere on the surface may engage at a laptop's width.
      const thresholds = Array.from(root.querySelectorAll("*")).flatMap((element) =>
        Array.from(element.classList).flatMap((token) => {
          const px = welcomeTier.exec(token)?.[1];
          return px ? [Number(px)] : [];
        })
      );
      expect(thresholds.length).toBeGreaterThan(0);
      expect(Math.min(...thresholds)).toBeGreaterThan(WIDEST_LAPTOP_PX);
    }
  );

  // --- Agent Welcome Card (#5111) ---

  describe("agent welcome card", () => {
    it("does not render while availability has no real data", () => {
      cliAvailabilityState.hasRealData = false;
      cliAvailabilityState.availability = { claude: "ready" };
      render(<WelcomeScreen gettingStarted={makeGettingStarted(null)} />);
      expect(screen.queryByText(/Installed agents found/)).toBeNull();
    });

    it("does not render when no agents are ready", () => {
      cliAvailabilityState.hasRealData = true;
      cliAvailabilityState.availability = { claude: "missing", codex: "missing" };
      render(<WelcomeScreen gettingStarted={makeGettingStarted(null)} />);
      expect(screen.queryByText(/Installed agents found/)).toBeNull();
    });

    it("does not render when any agent is already pinned", () => {
      cliAvailabilityState.hasRealData = true;
      cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
      agentSettingsState.settings = { agents: { claude: { pinned: true } } };
      render(<WelcomeScreen gettingStarted={makeGettingStarted(null)} />);
      expect(screen.queryByText(/Installed agents found/)).toBeNull();
    });

    it("does not render when the card has been dismissed", () => {
      cliAvailabilityState.hasRealData = true;
      cliAvailabilityState.availability = { claude: "ready" };
      agentSettingsState.settings = { agents: {} };
      agentDiscoveryState.welcomeCardDismissed = true;
      render(<WelcomeScreen gettingStarted={makeGettingStarted(null)} />);
      expect(screen.queryByText(/Installed agents found/)).toBeNull();
    });

    it("renders with ready agent names when conditions are met", () => {
      cliAvailabilityState.hasRealData = true;
      cliAvailabilityState.availability = {
        claude: "ready",
        codex: "ready",
        gemini: "missing",
      };
      agentSettingsState.settings = { agents: {} };
      render(<WelcomeScreen gettingStarted={makeGettingStarted(null)} />);
      expect(screen.getByText(/Installed agents found/)).toBeTruthy();
      expect(screen.getByText("Claude")).toBeTruthy();
      expect(screen.getByText("Codex")).toBeTruthy();
      expect(screen.queryByText("Gemini")).toBeNull();
    });

    it("pins all ready agents then dismisses when Pin all is clicked", async () => {
      cliAvailabilityState.hasRealData = true;
      cliAvailabilityState.availability = { claude: "ready", codex: "ready" };
      agentSettingsState.settings = { agents: {} };
      render(<WelcomeScreen gettingStarted={makeGettingStarted(null)} />);

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
      render(<WelcomeScreen gettingStarted={makeGettingStarted(null)} />);

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

      render(<WelcomeScreen gettingStarted={makeGettingStarted(null)} />);
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

  // --- Nudge sequencing (#6757) ---

  describe("nudge sequencing", () => {
    it("shows only the setup banner when banner, welcome card, and checklist are all eligible", () => {
      agentDiscoveryState.loaded = true;
      agentDiscoveryState.setupBannerDismissed = false;
      agentDiscoveryState.welcomeCardDismissed = false;
      cliAvailabilityState.hasRealData = true;
      cliAvailabilityState.availability = { claude: "ready" };
      agentSettingsState.settings = { agents: {} };

      render(<WelcomeScreen gettingStarted={makeGettingStarted(allIncomplete)} />);

      expect(screen.getByTestId("agent-setup-banner")).toBeTruthy();
      expect(screen.queryByText(/Installed agents found/)).toBeNull();
      expect(screen.queryByText("Getting started")).toBeNull();
    });

    it("shows progress before asking another setup question once the banner is dismissed", () => {
      agentDiscoveryState.loaded = true;
      agentDiscoveryState.setupBannerDismissed = true;
      agentDiscoveryState.welcomeCardDismissed = false;
      cliAvailabilityState.hasRealData = true;
      cliAvailabilityState.availability = { claude: "ready" };
      agentSettingsState.settings = { agents: {} };

      render(<WelcomeScreen gettingStarted={makeGettingStarted(allIncomplete)} />);

      expect(screen.getByText("Getting started")).toBeTruthy();
      expect(screen.queryByText(/Installed agents found/)).toBeNull();
    });

    it("offers pinning once the checklist is out of the way", () => {
      agentDiscoveryState.loaded = true;
      agentDiscoveryState.setupBannerDismissed = true;
      agentDiscoveryState.welcomeCardDismissed = false;
      cliAvailabilityState.hasRealData = true;
      cliAvailabilityState.availability = { claude: "ready" };
      agentSettingsState.settings = { agents: {} };

      render(<WelcomeScreen gettingStarted={makeGettingStarted(dismissed)} />);

      expect(screen.getByText(/Installed agents found/)).toBeTruthy();
    });

    it("falls through to the checklist when no agents are installed and the banner is dismissed", () => {
      agentDiscoveryState.loaded = true;
      agentDiscoveryState.setupBannerDismissed = true;
      agentDiscoveryState.welcomeCardDismissed = false;
      cliAvailabilityState.hasRealData = false;

      render(<WelcomeScreen gettingStarted={makeGettingStarted(allIncomplete)} />);

      expect(screen.getByText("Getting started")).toBeTruthy();
    });

    it("falls through to the checklist when scan finished but no agents are launchable", () => {
      agentDiscoveryState.loaded = true;
      agentDiscoveryState.setupBannerDismissed = true;
      agentDiscoveryState.welcomeCardDismissed = false;
      cliAvailabilityState.hasRealData = true;
      cliAvailabilityState.availability = { claude: "missing", codex: "missing" };

      render(<WelcomeScreen gettingStarted={makeGettingStarted(allIncomplete)} />);

      expect(screen.queryByText(/Installed agents found/)).toBeNull();
      expect(screen.getByText("Getting started")).toBeTruthy();
    });

    it("falls through to the checklist when an agent is already pinned", () => {
      agentDiscoveryState.loaded = true;
      agentDiscoveryState.setupBannerDismissed = true;
      agentDiscoveryState.welcomeCardDismissed = false;
      cliAvailabilityState.hasRealData = true;
      cliAvailabilityState.availability = { claude: "ready" };
      agentSettingsState.settings = { agents: { claude: { pinned: true } } };

      render(<WelcomeScreen gettingStarted={makeGettingStarted(allIncomplete)} />);

      expect(screen.queryByText(/Installed agents found/)).toBeNull();
      expect(screen.getByText("Getting started")).toBeTruthy();
    });

    it("renders nothing while onboarding state is hydrating", () => {
      agentDiscoveryState.loaded = false;
      agentDiscoveryState.setupBannerDismissed = false;
      agentDiscoveryState.welcomeCardDismissed = false;
      cliAvailabilityState.hasRealData = true;
      cliAvailabilityState.availability = { claude: "ready" };
      agentSettingsState.settings = { agents: {} };

      render(<WelcomeScreen gettingStarted={makeGettingStarted(allIncomplete)} />);

      expect(screen.queryByTestId("agent-setup-banner")).toBeNull();
      expect(screen.queryByText(/Installed agents found/)).toBeNull();
      expect(screen.queryByText("Getting started")).toBeNull();
    });
  });

  describe("isAgentWelcomeCardEligible", () => {
    it("returns false when agentSettings is null", () => {
      expect(
        isAgentWelcomeCardEligible({
          agentSettings: null,
          hasRealData: true,
          welcomeCardDismissed: false,
          availability: { claude: "ready" },
        })
      ).toBe(false);
    });

    it("returns false when hasRealData is false", () => {
      expect(
        isAgentWelcomeCardEligible({
          agentSettings: { agents: {} },
          hasRealData: false,
          welcomeCardDismissed: false,
          availability: { claude: "ready" },
        })
      ).toBe(false);
    });

    it("returns false when welcomeCardDismissed is true", () => {
      expect(
        isAgentWelcomeCardEligible({
          agentSettings: { agents: {} },
          hasRealData: true,
          welcomeCardDismissed: true,
          availability: { claude: "ready" },
        })
      ).toBe(false);
    });

    it("returns false when no built-in agent is launchable", () => {
      expect(
        isAgentWelcomeCardEligible({
          agentSettings: { agents: {} },
          hasRealData: true,
          welcomeCardDismissed: false,
          availability: { claude: "missing", codex: "missing" },
        })
      ).toBe(false);
    });

    it("returns false when a built-in agent is already pinned", () => {
      expect(
        isAgentWelcomeCardEligible({
          agentSettings: { agents: { claude: { pinned: true } } },
          hasRealData: true,
          welcomeCardDismissed: false,
          availability: { claude: "ready" },
        })
      ).toBe(false);
    });

    it("returns true when ready agents exist and none are pinned", () => {
      expect(
        isAgentWelcomeCardEligible({
          agentSettings: { agents: {} },
          hasRealData: true,
          welcomeCardDismissed: false,
          availability: { claude: "ready", codex: "ready" },
        })
      ).toBe(true);
    });

    it("returns true for unauthenticated agent (launchable)", () => {
      expect(
        isAgentWelcomeCardEligible({
          agentSettings: { agents: {} },
          hasRealData: true,
          welcomeCardDismissed: false,
          availability: { claude: "unauthenticated" },
        })
      ).toBe(true);
    });

    it("returns false for blocked agent (not launchable)", () => {
      expect(
        isAgentWelcomeCardEligible({
          agentSettings: { agents: {} },
          hasRealData: true,
          welcomeCardDismissed: false,
          availability: { claude: "blocked" },
        })
      ).toBe(false);
    });

    it("ignores custom agent pins when checking built-in eligibility", () => {
      expect(
        isAgentWelcomeCardEligible({
          agentSettings: { agents: { "my-custom-agent": { pinned: true } } },
          hasRealData: true,
          welcomeCardDismissed: false,
          availability: { claude: "ready" },
        })
      ).toBe(true);
    });
  });
});
