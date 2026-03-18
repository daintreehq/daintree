// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
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
      "action.palette": "⌘K",
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
}));

vi.mock("@/utils/timeAgo", () => ({
  formatTimeAgo: (value: number) => `${value}ms ago`,
}));

vi.mock("@/components/icons", () => ({
  CanopyIcon: ({ className }: { className?: string }) => (
    <div data-testid="canopy-icon" className={className} />
  ),
}));

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
    color: "#ff0000",
  },
  { id: "p2", name: "Project Beta", path: "/beta", emoji: "🌿", lastOpened: 1000 },
  { id: "p3", name: "Project Gamma", path: "/gamma", emoji: "🌳", lastOpened: 2000 },
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
  items: { openedProject: false, launchedAgent: false, createdWorktree: false },
};

const oneComplete: ChecklistState = {
  dismissed: false,
  items: { openedProject: true, launchedAgent: false, createdWorktree: false },
};

const allComplete: ChecklistState = {
  dismissed: false,
  items: { openedProject: true, launchedAgent: true, createdWorktree: true },
};

const dismissed: ChecklistState = {
  dismissed: true,
  items: { openedProject: false, launchedAgent: false, createdWorktree: false },
};

function makeGettingStarted(
  checklist: ChecklistState | null = allIncomplete,
  visible = true
): GettingStartedChecklistState {
  return {
    visible,
    collapsed: false,
    checklist,
    dismiss: vi.fn(),
    toggleCollapse: vi.fn(),
    notifyOnboardingComplete: vi.fn(),
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
  });

  it("renders hero section with icon, title, and tagline", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    expect(screen.getByTestId("canopy-icon")).toBeTruthy();
    expect(screen.getByText("Welcome to Canopy")).toBeTruthy();
    expect(screen.getByText("A habitat for your AI agents.")).toBeTruthy();
  });

  // --- Recent Projects ---

  it("renders recent projects sorted by lastOpened descending", () => {
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
    }));
    storeState = { ...storeState, projects: manyProjects };
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    const projectNames = screen.getAllByText(/Project \d/).map((el) => el.textContent);
    expect(projectNames).toHaveLength(5);
    // Should be the 5 most recent in descending order (7000, 6000, 5000, 4000, 3000)
    expect(projectNames).toEqual(["Project 7", "Project 6", "Project 5", "Project 4", "Project 3"]);
  });

  // --- Checklist ---

  it("shows Install Canopy as completed first item", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted()} />);

    expect(screen.getByText("Install Canopy")).toBeTruthy();
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
      name: /open a project|launch an ai agent|create a worktree/i,
    });
    expect(buttons).toHaveLength(3);
  });

  it("dispatches project.openDialog when Open a project is clicked", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(allIncomplete)} />);

    fireEvent.click(screen.getByRole("button", { name: /open a project/i }));
    expect(dispatchMock).toHaveBeenCalledWith("project.openDialog", undefined, {
      source: "user",
    });
  });

  it("dispatches panel.palette when Launch an AI agent is clicked", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(allIncomplete)} />);

    fireEvent.click(screen.getByRole("button", { name: /launch an ai agent/i }));
    expect(dispatchMock).toHaveBeenCalledWith("panel.palette", undefined, {
      source: "user",
    });
  });

  it("dispatches worktree.createDialog.open when Create a worktree is clicked", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(allIncomplete)} />);

    fireEvent.click(screen.getByRole("button", { name: /create a worktree/i }));
    expect(dispatchMock).toHaveBeenCalledWith("worktree.createDialog.open", undefined, {
      source: "user",
    });
  });

  it("renders completed items as non-interactive", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(oneComplete)} />);

    // openedProject is complete — should not be a button
    const openProjectButton = screen.queryByRole("button", { name: /open a project/i });
    expect(openProjectButton).toBeNull();
    expect(screen.getByText("Open a project")).toBeTruthy();
  });

  it("hides checklist when dismissed", () => {
    render(<WelcomeScreen gettingStarted={makeGettingStarted(dismissed)} />);

    expect(screen.queryByText("Getting Started")).toBeNull();
    expect(screen.queryByText("Install Canopy")).toBeNull();
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
    expect(screen.queryByText("Install Canopy")).toBeNull();
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
    expect(openExternalMock).toHaveBeenCalledWith("https://subscribepage.io/canopy");
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
});
