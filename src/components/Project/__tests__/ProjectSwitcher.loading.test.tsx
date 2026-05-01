/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, within } from "@testing-library/react";
import type { Project } from "@shared/types";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/lib/colorUtils", () => ({
  getProjectGradient: () => "linear-gradient(red, blue)",
}));

vi.mock("@/lib/notify", () => ({
  notify: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

vi.mock("@/hooks/useKeybinding", () => ({
  useKeybindingDisplay: () => "⌘P",
}));

vi.mock("@/hooks", () => ({
  useProjectSwitcherPalette: () => ({
    isOpen: false,
    mode: "dropdown",
    query: "",
    results: [],
    selectedIndex: 0,
    open: vi.fn(),
    close: vi.fn(),
    toggle: vi.fn(),
    setQuery: vi.fn(),
    selectPrevious: vi.fn(),
    selectNext: vi.fn(),
    selectProject: vi.fn(),
    confirmSelection: vi.fn(),
    addProject: vi.fn(),
    cloneRepo: vi.fn(),
    stopProject: vi.fn(),
    removeProject: vi.fn(),
    locateProject: vi.fn(),
    togglePinProject: vi.fn(),
    stopConfirmProjectId: null,
    setStopConfirmProjectId: vi.fn(),
    confirmStopProject: vi.fn(),
    isStoppingProject: false,
    removeConfirmProject: null,
    setRemoveConfirmProject: vi.fn(),
    confirmRemoveProject: vi.fn(),
    isRemovingProject: false,
    backgroundWaitingCount: 0,
  }),
}));

type ProjectStoreState = {
  projects: Project[];
  currentProject: Project | null;
  isLoading: boolean;
  openCreateFolderDialog: () => void;
};

const projectStoreState: ProjectStoreState = {
  projects: [],
  currentProject: null,
  isLoading: false,
  openCreateFolderDialog: vi.fn(),
};

vi.mock("@/store/projectStore", () => ({
  useProjectStore: <T,>(selector: (s: ProjectStoreState) => T) => selector(projectStoreState),
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

vi.mock("@/components/Project/ProjectSwitcherPalette", () => ({
  ProjectSwitcherPalette: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { ProjectSwitcher } = await import("../ProjectSwitcher");

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    name: "Test Project",
    path: "/tmp/test",
    emoji: "🚀",
    color: "blue",
    status: "active",
    lastOpened: 0,
    ...overrides,
  };
}

function setStore(patch: Partial<ProjectStoreState>) {
  Object.assign(projectStoreState, patch);
}

describe("ProjectSwitcher loading affordance", () => {
  beforeEach(() => {
    setStore({
      projects: [],
      currentProject: null,
      isLoading: false,
    });
  });

  it("loaded-project trigger shows spinner when isLoading is true", () => {
    setStore({
      projects: [makeProject()],
      currentProject: makeProject(),
      isLoading: true,
    });
    const { getByRole } = render(<ProjectSwitcher />);
    const trigger = getByRole("button");
    expect(trigger.querySelector(".animate-spin")).not.toBeNull();
    expect(trigger.querySelector(".lucide-chevrons-up-down")).toBeNull();
  });

  it("loaded-project trigger shows chevron when isLoading is false", () => {
    setStore({
      projects: [makeProject()],
      currentProject: makeProject(),
      isLoading: false,
    });
    const { getByRole } = render(<ProjectSwitcher />);
    const trigger = getByRole("button");
    expect(trigger.querySelector(".animate-spin")).toBeNull();
    expect(trigger.querySelector(".lucide-chevrons-up-down")).not.toBeNull();
  });

  it("'Select Project…' trigger shows spinner when isLoading is true", () => {
    setStore({
      projects: [makeProject()],
      currentProject: null,
      isLoading: true,
    });
    const { getByRole } = render(<ProjectSwitcher />);
    const trigger = getByRole("button", { name: /Select Project/ });
    expect(within(trigger).getByText("Select Project...")).toBeTruthy();
    expect(trigger.querySelector(".animate-spin")).not.toBeNull();
    expect(trigger.querySelector(".lucide-chevrons-up-down")).toBeNull();
  });

  it("'Select Project…' trigger shows chevron when isLoading is false", () => {
    setStore({
      projects: [makeProject()],
      currentProject: null,
      isLoading: false,
    });
    const { getByRole } = render(<ProjectSwitcher />);
    const trigger = getByRole("button", { name: /Select Project/ });
    expect(within(trigger).getByText("Select Project...")).toBeTruthy();
    expect(trigger.querySelector(".animate-spin")).toBeNull();
    expect(trigger.querySelector(".lucide-chevrons-up-down")).not.toBeNull();
  });

  it("'Open Project…' (no projects at all) keeps Plus icon and does not get a spinner", () => {
    setStore({
      projects: [],
      currentProject: null,
      isLoading: true,
    });
    const { getByRole } = render(<ProjectSwitcher />);
    const trigger = getByRole("button", { name: /Open Project/ });
    expect(within(trigger).getByText("Open Project...")).toBeTruthy();
    expect(trigger.querySelector(".lucide-plus")).not.toBeNull();
    expect(trigger.querySelector(".animate-spin")).toBeNull();
  });

  it("swap is reactive when isLoading toggles", () => {
    setStore({
      projects: [makeProject()],
      currentProject: makeProject(),
      isLoading: false,
    });
    const { rerender, getByRole } = render(<ProjectSwitcher />);
    let trigger = getByRole("button");
    expect(trigger.querySelector(".animate-spin")).toBeNull();
    expect(trigger.querySelector(".lucide-chevrons-up-down")).not.toBeNull();

    setStore({ isLoading: true });
    rerender(<ProjectSwitcher />);
    trigger = getByRole("button");
    expect(trigger.querySelector(".animate-spin")).not.toBeNull();
    expect(trigger.querySelector(".lucide-chevrons-up-down")).toBeNull();

    setStore({ isLoading: false });
    rerender(<ProjectSwitcher />);
    trigger = getByRole("button");
    expect(trigger.querySelector(".animate-spin")).toBeNull();
    expect(trigger.querySelector(".lucide-chevrons-up-down")).not.toBeNull();
  });
});
