/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
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
    status: "open",
    lastOpened: 0,
    ...overrides,
  } as Project;
}

function setStore(patch: Partial<ProjectStoreState>) {
  Object.assign(projectStoreState, patch);
}

describe("ProjectSwitcher loading affordance", () => {
  it("loaded-project trigger shows spinner when isLoading is true", () => {
    setStore({
      projects: [makeProject()],
      currentProject: makeProject(),
      isLoading: true,
    });
    const { container } = render(<ProjectSwitcher />);
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    expect(container.querySelector(".lucide-chevrons-up-down")).toBeNull();
  });

  it("loaded-project trigger shows chevron when isLoading is false", () => {
    setStore({
      projects: [makeProject()],
      currentProject: makeProject(),
      isLoading: false,
    });
    const { container } = render(<ProjectSwitcher />);
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(container.querySelector(".lucide-chevrons-up-down")).not.toBeNull();
  });

  it("'Select Project…' trigger shows spinner when isLoading is true", () => {
    setStore({
      projects: [makeProject()],
      currentProject: null,
      isLoading: true,
    });
    const { container, getByText } = render(<ProjectSwitcher />);
    expect(getByText("Select Project...")).toBeTruthy();
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    expect(container.querySelector(".lucide-chevrons-up-down")).toBeNull();
  });

  it("'Select Project…' trigger shows chevron when isLoading is false", () => {
    setStore({
      projects: [makeProject()],
      currentProject: null,
      isLoading: false,
    });
    const { container, getByText } = render(<ProjectSwitcher />);
    expect(getByText("Select Project...")).toBeTruthy();
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(container.querySelector(".lucide-chevrons-up-down")).not.toBeNull();
  });

  it("'Open Project…' (no projects at all) does not get a spinner", () => {
    setStore({
      projects: [],
      currentProject: null,
      isLoading: true,
    });
    const { container, getByText } = render(<ProjectSwitcher />);
    expect(getByText("Open Project...")).toBeTruthy();
    expect(container.querySelector(".animate-spin")).toBeNull();
  });
});
