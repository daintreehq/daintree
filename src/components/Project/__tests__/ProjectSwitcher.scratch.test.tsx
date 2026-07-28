/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Project, Scratch } from "@shared/types";

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

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

vi.mock("@/hooks/useKeybinding", () => ({
  useKeybindingDisplay: () => "⌘P",
}));

const openDropdown = vi.fn();

// Mutable so a spec can model a bulk-delete confirm being open across a render.
const paletteState: { deleteAllScratchesConfirm: { id: string; name: string }[] | null } = {
  deleteAllScratchesConfirm: null,
};

vi.mock("@/hooks", async () => {
  const deferred = await vi.importActual<typeof import("@/hooks/useDeferredLoading")>(
    "@/hooks/useDeferredLoading"
  );
  return {
    useDohertyGate: deferred.useDohertyGate,
    useProjectSwitcherPalette: () => ({
      isOpen: false,
      mode: "dropdown",
      query: "",
      results: [],
      selectedIndex: 0,
      open: openDropdown,
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
      nonActiveAgentCounts: { activeAgentCount: 0, waitingAgentCount: 0, waitingProjectCount: 0 },
      scratchResults: [],
      createScratch: vi.fn(),
      selectScratch: vi.fn(),
      removeScratchAction: vi.fn(),
      deleteAllScratchesConfirm: paletteState.deleteAllScratchesConfirm,
      requestDeleteAllScratches: vi.fn(),
      dismissDeleteAllScratchesConfirm: vi.fn(),
      confirmDeleteAllScratches: vi.fn(),
      isDeletingAllScratches: false,
      renameScratch: vi.fn(),
    }),
  };
});

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

const scratchStoreState: { currentScratch: Scratch | null } = { currentScratch: null };

vi.mock("@/store/projectStore", () => ({
  useProjectStore: <T,>(selector: (s: ProjectStoreState) => T) => selector(projectStoreState),
}));

vi.mock("@/store/scratchStore", () => ({
  useScratchStore: <T,>(selector: (s: typeof scratchStoreState) => T) =>
    selector(scratchStoreState),
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({ ConfirmDialog: () => null }));

// A sentinel, not a passthrough: it marks its own presence and surfaces the pending
// confirm it was handed, so a spec can prove the palette is genuinely mounted with
// the bulk-delete state — not merely that some button with the right label rendered.
vi.mock("@/components/Project/ProjectSwitcherPalette", () => ({
  ProjectSwitcherPalette: ({
    children,
    deleteAllScratchesConfirm,
  }: {
    children: React.ReactNode;
    deleteAllScratchesConfirm?: unknown;
  }) => (
    <div data-testid="project-switcher-palette">
      {children}
      {deleteAllScratchesConfirm ? <div data-testid="bulk-scratch-confirm" /> : null}
    </div>
  ),
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

function makeScratch(name: string): Scratch {
  return {
    id: "scratch-1",
    path: "/tmp/scratches/scratch-1",
    name,
    createdAt: Date.now(),
    lastOpened: Date.now(),
  };
}

// The card also renders the path's basename, so keep it distinct from the name —
// otherwise a getByText(name) would match two nodes.
function makeProject(name: string): Project {
  return {
    id: "project-1",
    path: "/repo/checkout",
    name,
    emoji: "🌲",
    lastOpened: Date.now(),
  };
}

// Names are generated, not hardcoded, so an assertion can't pass against a literal
// that happens to live in the component.
let nameCounter = 0;
const uniqueName = (prefix: string) => `${prefix} ${++nameCounter}`;

beforeEach(() => {
  vi.clearAllMocks();
  projectStoreState.projects = [];
  projectStoreState.currentProject = null;
  scratchStoreState.currentScratch = null;
  paletteState.deleteAllScratchesConfirm = null;
});

describe("ProjectSwitcher with an active scratch", () => {
  it("shows the scratch's name instead of the pick-a-project prompt", () => {
    const name = uniqueName("Spike");
    scratchStoreState.currentScratch = makeScratch(name);

    render(<ProjectSwitcher />);

    expect(screen.getByText(name)).toBeTruthy();
    expect(screen.queryByText("Select Project...")).toBeNull();
    expect(screen.queryByText("Open Project...")).toBeNull();
  });

  it("labels the trigger as a scratch, not a project", () => {
    const name = uniqueName("Throwaway");
    scratchStoreState.currentScratch = makeScratch(name);

    render(<ProjectSwitcher />);

    const trigger = screen.getByRole("button", { name: /scratch/i });
    expect(trigger.getAttribute("aria-label")).toContain(name);
  });

  it("still surfaces the scratch when projects exist but none is open", () => {
    const name = uniqueName("Active scratch");
    projectStoreState.projects = [makeProject("Some project")];
    scratchStoreState.currentScratch = makeScratch(name);

    render(<ProjectSwitcher />);

    // The "projects exist, none open" fallback must not win over an active scratch.
    expect(screen.queryByText("Select Project...")).toBeNull();
    expect(screen.getByText(name)).toBeTruthy();
  });

  it("opens the switcher when the scratch card is clicked", () => {
    scratchStoreState.currentScratch = makeScratch("Clickable");

    render(<ProjectSwitcher />);
    screen.getByRole("button", { name: /scratch/i }).click();

    expect(openDropdown).toHaveBeenCalled();
  });

  it("keeps the empty state when no workspace is active at all", () => {
    render(<ProjectSwitcher />);

    expect(screen.getByText("Open Project...")).toBeTruthy();
  });

  it("keeps the palette and its pending confirm mounted through a bulk scratch delete", () => {
    // Deleting the last scratch nulls `currentScratch` mid-run. With no projects to
    // fall back on, the empty-state branch would take over and unmount the palette —
    // taking the confirm dialog, still spinning on the delete, with it.
    scratchStoreState.currentScratch = makeScratch(uniqueName("Doomed"));
    const { rerender } = render(<ProjectSwitcher />);

    // The run starts, then the last removal lands and clears the active pointer.
    paletteState.deleteAllScratchesConfirm = [{ id: "scratch-1", name: "Spike" }];
    scratchStoreState.currentScratch = null;
    rerender(<ProjectSwitcher />);

    expect(screen.getByTestId("project-switcher-palette")).toBeTruthy();
    expect(screen.getByTestId("bulk-scratch-confirm")).toBeTruthy();
  });

  it("drops back to the empty state once the bulk delete resolves", () => {
    // The other half of the guard: it must not pin the palette open forever.
    paletteState.deleteAllScratchesConfirm = null;

    render(<ProjectSwitcher />);

    expect(screen.queryByTestId("project-switcher-palette")).toBeNull();
  });

  it("prefers an open project over a lingering scratch pointer", () => {
    const projectName = uniqueName("Real project");
    const scratchName = uniqueName("Should not show");
    projectStoreState.currentProject = makeProject(projectName);
    scratchStoreState.currentScratch = makeScratch(scratchName);

    render(<ProjectSwitcher />);

    expect(screen.getByText(projectName)).toBeTruthy();
    expect(screen.queryByText(scratchName)).toBeNull();
  });
});
