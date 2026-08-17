/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, within, act } from "@testing-library/react";
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

const paletteState = vi.hoisted(() => ({
  nonActiveAgentCounts: { activeAgentCount: 0, waitingAgentCount: 0, waitingProjectCount: 0 },
}));

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
      // Presentation-scoped and deliberately empty: the badge must not read it.
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
      nonActiveAgentCounts: paletteState.nonActiveAgentCounts,
      deleteAllScratchesConfirm: null,
      requestDeleteAllScratches: vi.fn(),
      dismissDeleteAllScratchesConfirm: vi.fn(),
      confirmDeleteAllScratches: vi.fn(),
      isDeletingAllScratches: false,
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

vi.mock("@/store/projectStore", () => ({
  useProjectStore: <T,>(selector: (s: ProjectStoreState) => T) => selector(projectStoreState),
}));

// No active scratch: these cases cover the no-workspace empty states, which only
// render when both pointers are null.
vi.mock("@/store/scratchStore", () => ({
  useScratchStore: <T,>(selector: (s: { currentScratch: null }) => T) =>
    selector({ currentScratch: null }),
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

// The spinner is gated behind useDohertyGate(isLoading) so a sub-threshold
// isLoading flip never flashes on warm-cache project state. Advancing 400ms
// of fake timers inside act() simulates a load that genuinely crosses the
// Doherty threshold.
const DEFER_MS = 400;

function advanceDeferGate() {
  act(() => {
    vi.advanceTimersByTime(DEFER_MS);
  });
}

describe("ProjectSwitcher loading affordance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setStore({
      projects: [],
      currentProject: null,
      isLoading: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loaded-project trigger shows spinner after the deferred-loading gate elapses", () => {
    setStore({
      projects: [makeProject()],
      currentProject: makeProject(),
      isLoading: true,
    });
    const { getByRole } = render(<ProjectSwitcher />);
    let trigger = getByRole("button");
    // Sub-threshold: no spinner flash on the first frame.
    expect(trigger.querySelector(".animate-spin")).toBeNull();

    advanceDeferGate();
    trigger = getByRole("button");
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
    advanceDeferGate();
    const trigger = getByRole("button");
    expect(trigger.querySelector(".animate-spin")).toBeNull();
    expect(trigger.querySelector(".lucide-chevrons-up-down")).not.toBeNull();
  });

  it("'Select Project…' trigger shows spinner after the deferred-loading gate elapses", () => {
    setStore({
      projects: [makeProject()],
      currentProject: null,
      isLoading: true,
    });
    const { getByRole } = render(<ProjectSwitcher />);
    let trigger = getByRole("button", { name: /Select Project/ });
    expect(within(trigger).getByText("Select Project...")).toBeTruthy();
    expect(trigger.querySelector(".animate-spin")).toBeNull();

    advanceDeferGate();
    trigger = getByRole("button", { name: /Select Project/ });
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
    advanceDeferGate();
    const trigger = getByRole("button", { name: /Select Project/ });
    expect(within(trigger).getByText("Select Project...")).toBeTruthy();
    expect(trigger.querySelector(".animate-spin")).toBeNull();
    expect(trigger.querySelector(".lucide-chevrons-up-down")).not.toBeNull();
  });

  it("does not flash the spinner before the 400ms Doherty threshold", () => {
    setStore({
      projects: [makeProject()],
      currentProject: makeProject(),
      isLoading: true,
    });
    const { getByRole } = render(<ProjectSwitcher />);
    expect(getByRole("button").querySelector(".animate-spin")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(DEFER_MS - 1);
    });
    expect(getByRole("button").querySelector(".animate-spin")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(getByRole("button").querySelector(".animate-spin")).not.toBeNull();
  });

  it("'Open Project…' (no projects at all) keeps Plus icon and does not get a spinner", () => {
    setStore({
      projects: [],
      currentProject: null,
      isLoading: true,
    });
    const { getByRole } = render(<ProjectSwitcher />);
    advanceDeferGate();
    const trigger = getByRole("button", { name: /Open Project/ });
    expect(within(trigger).getByText("Open Project...")).toBeTruthy();
    expect(trigger.querySelector(".lucide-plus")).not.toBeNull();
    expect(trigger.querySelector(".animate-spin")).toBeNull();
  });

  it("spinner clears immediately when isLoading drops, without waiting on the gate", () => {
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
    advanceDeferGate();
    trigger = getByRole("button");
    expect(trigger.querySelector(".animate-spin")).not.toBeNull();
    expect(trigger.querySelector(".lucide-chevrons-up-down")).toBeNull();

    // Clearing is instant — useDohertyGate drops the loader the moment
    // isPending goes false, with no timer to advance.
    setStore({ isLoading: false });
    rerender(<ProjectSwitcher />);
    trigger = getByRole("button");
    expect(trigger.querySelector(".animate-spin")).toBeNull();
    expect(trigger.querySelector(".lucide-chevrons-up-down")).not.toBeNull();
  });

  it("trigger disabled tracks the deferred gate, not raw isLoading", () => {
    setStore({
      projects: [makeProject()],
      currentProject: makeProject(),
      isLoading: true,
    });
    const { getByRole } = render(<ProjectSwitcher />);
    // No dim flash: button stays interactive below the threshold.
    expect((getByRole("button") as HTMLButtonElement).disabled).toBe(false);

    act(() => {
      vi.advanceTimersByTime(DEFER_MS - 1);
    });
    expect((getByRole("button") as HTMLButtonElement).disabled).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect((getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("'Open Project…' button disables immediately on isLoading (no spinner alternative)", () => {
    setStore({
      projects: [],
      currentProject: null,
      isLoading: true,
    });
    const { getByRole } = render(<ProjectSwitcher />);
    const trigger = getByRole("button", { name: /Open Project/ }) as HTMLButtonElement;
    // No spinner here, so disabling immediately can't be confused with a
    // warm-cache flash — keep the instant interaction guard.
    expect(trigger.disabled).toBe(true);
  });

  it("never flashes the spinner when isLoading resolves before the threshold", () => {
    setStore({
      projects: [makeProject()],
      currentProject: makeProject(),
      isLoading: true,
    });
    const { rerender, getByRole } = render(<ProjectSwitcher />);
    expect(getByRole("button").querySelector(".animate-spin")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(200);
    });
    setStore({ isLoading: false });
    rerender(<ProjectSwitcher />);

    act(() => {
      vi.advanceTimersByTime(300);
    });
    const trigger = getByRole("button");
    expect(trigger.querySelector(".animate-spin")).toBeNull();
    expect(trigger.querySelector(".lucide-chevrons-up-down")).not.toBeNull();
  });
});

// The badge counts agents on OTHER projects, so it must read the hook's
// uncapped totals — not `results`, which modal browse scopes for presentation
// and can legitimately drop a project whose process count hasn't landed yet
// (agent counts and process counts arrive from separate stats calls).
describe("ProjectSwitcher background-agent badge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setStore({
      projects: [makeProject()],
      currentProject: makeProject(),
      isLoading: false,
    });
    paletteState.nonActiveAgentCounts = {
      activeAgentCount: 0,
      waitingAgentCount: 0,
      waitingProjectCount: 0,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts waiting PROJECTS, not the agents inside them", () => {
    // Eight agents queued in one repo is one place to go, not eight obligations.
    paletteState.nonActiveAgentCounts = {
      activeAgentCount: 0,
      waitingAgentCount: 8,
      waitingProjectCount: 1,
    };
    const { getByRole } = render(<ProjectSwitcher />);
    const label = getByRole("status").getAttribute("aria-label");
    expect(label).toContain("1 project waiting for input");
    expect(label).not.toContain("8");
  });

  it("reports the wait and the work still in flight together", () => {
    // These used to contend for one carrier, so a fleet that was both asking
    // for input AND still churning looked exactly like one that had stalled
    // (#11832). Demand still leads — it is the half that needs the user.
    paletteState.nonActiveAgentCounts = {
      activeAgentCount: 5,
      waitingAgentCount: 1,
      waitingProjectCount: 1,
    };
    const { getByRole, getByTestId } = render(<ProjectSwitcher />);
    const label = getByRole("status").getAttribute("aria-label");
    expect(label).toContain("1 project waiting for input");
    expect(label).toContain("5 background agents working");
    expect(label?.indexOf("waiting")).toBeLessThan(label?.indexOf("working") ?? -1);
    // Hue carries the demand, shape carries the liveness — so the mark is the
    // open glyph even though the colour still says "waiting".
    expect(getByTestId("project-switcher-badge-arc")).toBeTruthy();
  });

  it("closes the badge's shape when the fleet is only waiting", () => {
    paletteState.nonActiveAgentCounts = {
      activeAgentCount: 0,
      waitingAgentCount: 2,
      waitingProjectCount: 2,
    };
    const { getByRole, queryByTestId } = render(<ProjectSwitcher />);
    const badge = getByRole("status");
    expect(badge.getAttribute("aria-label")).toContain("2 projects waiting");
    expect(queryByTestId("project-switcher-badge-arc")).toBeNull();
    // A closed mark is actually drawn — "no arc" would also be satisfied by a
    // badge that had quietly stopped rendering anything at all.
    expect(badge.querySelector("span")).toBeTruthy();
  });

  it("falls back to working agents when none are waiting", () => {
    // Work in progress is not an obligation, so it stays an agent tally.
    paletteState.nonActiveAgentCounts = {
      activeAgentCount: 3,
      waitingAgentCount: 0,
      waitingProjectCount: 0,
    };
    const { getByRole } = render(<ProjectSwitcher />);
    expect(getByRole("status").getAttribute("aria-label")).toContain("3 background agents working");
  });

  it("renders no badge when no other project has agents", () => {
    const { queryByRole } = render(<ProjectSwitcher />);
    expect(queryByRole("status")).toBeNull();
  });
});
