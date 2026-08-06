/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render, screen, within, fireEvent, act } from "@testing-library/react";

const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
  });
});
afterAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: originalScrollIntoView,
    configurable: true,
  });
});

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

vi.mock("@/hooks/useKeybinding", () => ({
  useKeybindingDisplay: () => "⌘P",
  useEffectiveCombo: () => undefined,
}));

vi.mock("@/hooks", () => ({
  useOverlayState: () => {},
  useOverlayClaim: () => {},
}));

vi.mock("@/store/paletteStore", () => ({
  usePaletteStore: { getState: () => ({ activePaletteId: null }) },
}));

vi.mock("@/store/uiStore", () => ({
  useUIStore: () => 0,
}));

vi.mock("@/components/ui/AppPaletteDialog", () => {
  const Header = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="palette-header">{children}</div>
  );
  const Input = ({
    inputRef,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & {
    inputRef?: React.Ref<HTMLInputElement>;
  }) => <input ref={inputRef} data-testid="palette-input" {...props} />;
  const Body = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="palette-body">{children}</div>
  );
  const Footer = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="palette-footer">{children}</div>
  );

  const Dialog = ({
    isOpen,
    children,
    ariaLabel,
  }: {
    isOpen: boolean;
    children: React.ReactNode;
    ariaLabel: string;
  }) =>
    isOpen ? (
      <div role="dialog" aria-modal="true" aria-label={ariaLabel}>
        {children}
      </div>
    ) : null;
  Dialog.Header = Header;
  Dialog.Input = Input;
  Dialog.Body = Body;
  Dialog.Footer = Footer;
  Dialog.Divider = (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />;

  return {
    AppPaletteDialog: Dialog,
    KBD_CLASS: "px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-daintree-border text-daintree-text/60",
    PALETTE_SURFACE_WIDTHS: {
      // Sentinel values, not the production pixels: this mock only has to satisfy
      // the real AppPalettePopover's width lookup, and copying the shipped
      // classes here would couple every future resize to six mock factories.
      anchored: "mock-anchored-width",
      command: "mock-command-width",
    },
  };
});

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: () => null,
  ContextMenuItem: () => null,
  ContextMenuSeparator: () => null,
  ContextMenuRadioGroup: () => null,
  ContextMenuRadioItem: () => null,
}));

vi.mock("@/hooks/useModifierKeys", () => ({
  useModifierKeys: () => ({ meta: false, alt: false }),
}));

vi.mock("@/utils/timeAgo", () => ({
  formatTimeAgo: (ts: number) => `${Math.round((Date.now() - ts) / 3600000)}h ago`,
}));

import type {
  ProjectSwitcherProjectRow,
  ProjectSwitcherScratchRow,
  SearchableProject,
  SearchableScratch,
} from "@/hooks/useProjectSwitcherPalette";
import { SCRATCH_CLEANUP_TTL_MS } from "@shared/config/scratchCleanup";

const { ProjectSwitcherPalette } = await import("../ProjectSwitcherPalette");

function makeProject(overrides: Partial<SearchableProject> = {}): ProjectSwitcherProjectRow {
  // Deliberately dumb: `section` defaults to "other" and must be stated
  // explicitly by band tests. Deriving it here would restate the hook's
  // classification rules, so a fixture could keep rendering the intended bands
  // while the real `sectionForProject` drifted — the component tests would stay
  // green either way. Classification is owned by the hook's own suite.
  return {
    kind: "project",
    id: "proj-1",
    name: "Test Project",
    path: "/tmp/test",
    emoji: "🚀",
    lastOpened: 0,
    frecencyScore: 3.0,
    status: "closed",
    isActive: false,
    isBackground: false,
    isMissing: false,
    isPinned: false,
    processCount: 0,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    section: "other",
    displayPath:
      (overrides.path ?? "/tmp/test").replace(/\\/g, "/").split("/").filter(Boolean).pop() ??
      overrides.path ??
      "/tmp/test",
    ...overrides,
  };
}

const modalProps = {
  isOpen: true,
  query: "",
  selectedIndex: 0,
  onQueryChange: vi.fn(),
  onSelectPrevious: vi.fn(),
  onSelectNext: vi.fn(),
  onSelect: vi.fn(),
  onClose: vi.fn(),
  mode: "modal" as const,
};

const dropdownProps = {
  ...modalProps,
  mode: "dropdown" as const,
  onOpenProjectSettings: vi.fn(),
  onAddProject: vi.fn(),
  onCreateFolder: vi.fn(),
  onTogglePinProject: vi.fn(),
  onCloseProject: vi.fn(),
  onStopProject: vi.fn(),
};

const baseProps = dropdownProps;

describe("ProjectSwitcherPalette secondary text waterfall", () => {
  it("shows 'Directory not found' for missing projects", () => {
    render(<ProjectSwitcherPalette {...baseProps} results={[makeProject({ isMissing: true })]} />);
    expect(screen.getByText("Directory not found")).toBeTruthy();
  });

  it("reports waiting before working, with the count", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[makeProject({ activeAgentCount: 2, waitingAgentCount: 3 })]}
      />
    );
    // A project that needs the user outranks one that is merely busy.
    expect(screen.getByText("3 agents need input")).toBeTruthy();
  });

  it("singularises a lone waiting agent", () => {
    render(
      <ProjectSwitcherPalette {...baseProps} results={[makeProject({ waitingAgentCount: 1 })]} />
    );
    expect(screen.getByText("Agent needs input")).toBeTruthy();
  });

  it("ages the oldest wait", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[
          makeProject({
            waitingAgentCount: 2,
            oldestWaitingSince: Date.now() - 42 * 60_000,
          }),
        ]}
      />
    );
    expect(screen.getByText("2 agents need input · oldest waiting 42m")).toBeTruthy();
  });

  it("reports blocked agents alongside the plain waits, not instead of them", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[makeProject({ waitingAgentCount: 3, blockedAgentCount: 1 })]}
      />
    );
    // An agent stopped on an error is a different ask than one at a prompt, but
    // the two still waiting must not vanish behind it.
    expect(screen.getByText("2 agents need input · 1 blocked")).toBeTruthy();
  });

  it("reports running agents when nothing is waiting", () => {
    render(
      <ProjectSwitcherPalette {...baseProps} results={[makeProject({ activeAgentCount: 2 })]} />
    );
    expect(screen.getByText("2 agents running")).toBeTruthy();
  });

  it("labels the relative time as an opened time when nothing is running", () => {
    const twoHoursAgo = Date.now() - 2 * 3600000;
    render(
      <ProjectSwitcherPalette {...baseProps} results={[makeProject({ lastOpened: twoHoursAgo })]} />
    );
    expect(screen.getByText("Opened 2h ago")).toBeTruthy();
  });

  it("names the state, not the path, when the project was never opened", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[makeProject({ path: "/home/user/my-project", displayPath: "my-project" })]}
      />
    );
    expect(screen.getByText("Not opened yet")).toBeTruthy();
  });

  it("shows 'Suspended to free memory' for an auto-parked closed project", () => {
    const twoHoursAgo = Date.now() - 2 * 3600000;
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[
          makeProject({ status: "closed", autoParkedAt: Date.now(), lastOpened: twoHoursAgo }),
        ]}
      />
    );
    // The parked label wins over the plain time-ago for an auto-closed project.
    expect(screen.getByText("Suspended to free memory")).toBeTruthy();
    expect(screen.queryByText(/Opened 2h ago/)).toBeNull();
  });

  it("shows the opened time (not the parked label) for a closed project without the marker", () => {
    const twoHoursAgo = Date.now() - 2 * 3600000;
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[makeProject({ status: "closed", lastOpened: twoHoursAgo })]}
      />
    );
    expect(screen.getByText("Opened 2h ago")).toBeTruthy();
    expect(screen.queryByText("Suspended to free memory")).toBeNull();
  });
});

describe("ProjectSwitcherPalette status conveyance", () => {
  // The dot repeats the status line's tone and nothing else. It carries no
  // accessible name of its own, so status is never announced twice and never
  // depends on telling two hues apart.
  it("conveys status as text rather than a labelled dot", () => {
    render(
      <ProjectSwitcherPalette {...baseProps} results={[makeProject({ waitingAgentCount: 2 })]} />
    );

    expect(screen.getByText("2 agents need input")).toBeTruthy();
    expect(screen.queryByLabelText("Agents waiting")).toBeNull();
    expect(screen.queryByLabelText("Idle")).toBeNull();
  });

  it("keeps a missing project actionable instead of inert", () => {
    const onSelect = vi.fn();
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[makeProject({ isMissing: true })]}
        onSelect={onSelect}
      />
    );

    const row = screen.getByText("Directory not found").closest('[role="option"]');
    expect(row).toBeTruthy();
    expect(row!.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(row!);
    expect(onSelect).toHaveBeenCalled();
  });
});

describe("ProjectSwitcherPalette secondary text edge cases", () => {
  it("isMissing takes priority over active agents", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[makeProject({ isMissing: true, activeAgentCount: 2 })]}
      />
    );
    expect(screen.getByText("Directory not found")).toBeTruthy();
    expect(screen.queryByText("Agent working\u2026")).toBeNull();
  });
});

describe("ProjectSwitcherPalette clone repo button", () => {
  it("renders Clone Repository button when onCloneRepo is provided", () => {
    render(
      <ProjectSwitcherPalette {...baseProps} onCloneRepo={vi.fn()} results={[makeProject()]} />
    );
    expect(screen.getByTestId("project-clone-button")).toBeTruthy();
    expect(screen.getByText("Clone Repository…")).toBeTruthy();
  });

  it("calls onCloneRepo when Clone Repository button is clicked", () => {
    const onCloneRepo = vi.fn();
    render(
      <ProjectSwitcherPalette {...baseProps} onCloneRepo={onCloneRepo} results={[makeProject()]} />
    );

    const btn = screen.getByTestId("project-clone-button");
    btn.click();
    expect(onCloneRepo).toHaveBeenCalledOnce();
  });

  it("does not render Clone Repository button when onCloneRepo is not provided", () => {
    render(<ProjectSwitcherPalette {...baseProps} results={[makeProject()]} />);
    expect(screen.queryByTestId("project-clone-button")).toBeNull();
  });
});

describe("ProjectSwitcherPalette modal mode", () => {
  const now = Date.now();
  // Section-ordered exactly as the hook hands it over: the component's only job
  // is to cut headers where `section` changes.
  const multiProjects = [
    makeProject({
      id: "active",
      name: "Active Project",
      isActive: true,
      section: "current",
      lastOpened: now,
    }),
    makeProject({
      id: "pinned",
      name: "Pinned Project",
      isPinned: true,
      section: "pinned",
      lastOpened: now - 3600000,
    }),
    makeProject({
      id: "pinned2",
      name: "Second Pinned",
      isPinned: true,
      section: "pinned",
      lastOpened: now - 4000000,
    }),
    makeProject({
      id: "bg",
      name: "Background Project",
      isBackground: true,
      activeAgentCount: 1,
      processCount: 1,
      section: "running",
      lastOpened: now - 1800000,
    }),
    makeProject({
      id: "recent",
      name: "Recent Project",
      section: "other",
      lastOpened: now - 7200000,
    }),
    makeProject({
      id: "old",
      name: "Old Project",
      section: "other",
      lastOpened: now - 14 * 24 * 3600000,
    }),
  ];

  // Scoping modal browse to switchable projects is the hook's job
  // (useProjectSwitcherPalette's `results` memo). The component renders what
  // it is handed, verbatim — re-filtering here is what stranded the keyboard
  // selection on a row that was never in the DOM (#11071).
  it("renders every supplied result as an option in modal mode", () => {
    render(<ProjectSwitcherPalette {...modalProps} results={multiProjects} />);
    const list = screen.getByRole("listbox", { name: "Workspaces" });
    const options = within(list).getAllByRole("option");

    expect(options).toHaveLength(multiProjects.length);
    multiProjects.forEach((project, index) => {
      expect(options[index]!.textContent).toContain(project.name);
    });
  });

  it("sections the modal exactly like the dropdown", () => {
    // The two surfaces used to disagree about both scope and grouping, so the
    // same keystroke showed a different universe depending on how it was opened.
    render(<ProjectSwitcherPalette {...modalProps} results={multiProjects} />);
    expect(screen.getByText("Pinned")).toBeTruthy();
    expect(screen.queryByText("Today")).toBeNull();
    expect(screen.queryByText("This Week")).toBeNull();
    expect(screen.queryByText("Older")).toBeNull();
  });

  it("names an action the surface it is rendered in can actually perform", () => {
    // The modal mounts without the add/clone callbacks, so an empty state that
    // pointed at "Add Project…" would name a button that isn't there.
    const { unmount } = render(<ProjectSwitcherPalette {...modalProps} results={[]} />);
    const modalCopy = screen.getByTestId("project-empty-state").textContent;
    expect(screen.queryByText("Add Project…")).toBeNull();
    unmount();

    render(<ProjectSwitcherPalette {...dropdownProps} results={[]} />);
    expect(screen.getByText("Add Project…")).toBeTruthy();
    expect(screen.getByTestId("project-empty-state").textContent).not.toBe(modalCopy);
  });

  it("does not show management action buttons in modal mode", () => {
    render(<ProjectSwitcherPalette {...modalProps} results={multiProjects} />);
    expect(screen.queryByText("Project Settings…")).toBeNull();
    expect(screen.queryByText("Add Project…")).toBeNull();
    expect(screen.queryByText("Clone Repository…")).toBeNull();
    expect(screen.queryByText("Create New Folder…")).toBeNull();
  });

  it("shows Right-click hint but not Remove shortcut in modal mode footer", () => {
    render(<ProjectSwitcherPalette {...modalProps} results={multiProjects} />);
    const footer = screen.getByTestId("palette-footer");
    expect(footer.textContent).toContain("Switch");
    expect(footer.textContent).not.toContain("Remove");
    expect(footer.textContent).toContain("Right-click for more");
  });

  it("shows section bands in dropdown mode", () => {
    render(<ProjectSwitcherPalette {...dropdownProps} results={multiProjects} />);
    expect(screen.getByText("Pinned")).toBeTruthy();
  });

  it("emits one header for a multi-row band, not one per row", () => {
    render(<ProjectSwitcherPalette {...dropdownProps} results={multiProjects} />);
    // Two pinned projects sit in one contiguous run, so "Pinned" is printed once.
    expect(screen.getByText("Second Pinned")).toBeTruthy();
    expect(screen.getAllByText("Pinned")).toHaveLength(1);
  });

  it("prints each band header in the order the results arrive", () => {
    render(<ProjectSwitcherPalette {...dropdownProps} results={multiProjects} />);
    const list = screen.getByRole("listbox", { name: "Workspaces" });
    const headers = Array.from(list.querySelectorAll("div"))
      .map((el) => el.textContent?.trim())
      .filter(
        (text): text is string =>
          text === "Pinned" || text === "Running" || text === "Other projects"
      );
    // Pinned above Running: an explicit pin outranks the operational fact
    // that something is executing.
    expect(headers[0]).toBe("Pinned");
    expect(headers).toContain("Running");
    expect(headers).toContain("Other projects");
  });

  describe("Other band sort control — issue #11455", () => {
    function withOtherRows(count: number) {
      return [
        ...multiProjects.filter((project) => project.section !== "other"),
        ...Array.from({ length: count }, (_, i) =>
          makeProject({
            id: `other-${i}`,
            name: `Other ${i}`,
            section: "other",
            lastOpened: now - (i + 1) * 3600000,
          })
        ),
      ];
    }

    it.each([
      [0, false],
      [3, false],
      [4, true],
      [6, true],
    ])("with %i Other rows, shows the control: %s", (rows, shown) => {
      render(<ProjectSwitcherPalette {...dropdownProps} results={withOtherRows(rows)} />);
      expect(screen.queryByTestId("other-projects-sort-trigger") !== null).toBe(shown);
    });

    it("puts the control on the Other band and nowhere else", () => {
      render(<ProjectSwitcherPalette {...dropdownProps} results={withOtherRows(4)} />);
      // Pinned and Running are load-bearing orders this preference must not
      // claim to govern, so neither header may grow a control. Scoped by group
      // rather than counted globally, which would pass if it had moved bands.
      const other = screen.getByRole("group", { name: "Other projects" });
      expect(within(other).getByTestId("other-projects-sort-trigger")).toBeTruthy();
      for (const band of ["Pinned", "Running"]) {
        const group = screen.getByRole("group", { name: band });
        expect(within(group).queryByTestId("other-projects-sort-trigger")).toBeNull();
      }
    });

    it("keeps the band's accessible name free of the mode it is showing", () => {
      // The header id is the group's aria-labelledby target, and that name is
      // computed from the element's whole subtree — nesting the mode inside it
      // would name the band "Other projects Most used" to a screen reader.
      render(<ProjectSwitcherPalette {...dropdownProps} results={withOtherRows(4)} />);
      expect(screen.getByRole("group", { name: "Other projects" })).toBeTruthy();
    });

    it("keeps the trigger out of the Tab order", () => {
      // Section headers live inside the listbox, where a focusable child is
      // invalid; arrow keys move aria-activedescendant across rows only.
      render(<ProjectSwitcherPalette {...dropdownProps} results={withOtherRows(4)} />);
      expect(screen.getByTestId("other-projects-sort-trigger").getAttribute("tabindex")).toBe("-1");
    });
  });

  it("shows Remove hint in dropdown mode footer", () => {
    render(<ProjectSwitcherPalette {...dropdownProps} results={multiProjects} />);
    const footer = screen.getByTestId("palette-footer");
    expect(footer.textContent).toContain("Remove");
    expect(footer.textContent).toContain("Right-click for more");
  });

  it("shows all projects in dropdown mode including closed ones", () => {
    render(<ProjectSwitcherPalette {...dropdownProps} results={multiProjects} />);
    expect(screen.getByText("Active Project")).toBeTruthy();
    expect(screen.getByText("Background Project")).toBeTruthy();
    expect(screen.getByText("Pinned Project")).toBeTruthy();
    expect(screen.getByText("Recent Project")).toBeTruthy();
    expect(screen.getByText("Old Project")).toBeTruthy();
  });
});

/**
 * Scratches in the ranked search list (issue #11466).
 *
 * The hook decides membership; what the component owes is that a scratch row
 * joins the SAME listbox and roving-selection domain the project rows use, that
 * the pinned browse section stops competing with it, and that nothing on screen
 * still claims the search covered projects only.
 */
describe("ProjectSwitcherPalette scratch search rows", () => {
  function makeScratchRow(
    overrides: Partial<ProjectSwitcherScratchRow> & { id: string; name: string }
  ): ProjectSwitcherScratchRow {
    return {
      kind: "scratch",
      path: `/userData/scratch/${overrides.id}`,
      createdAt: 0,
      lastOpened: 0,
      isActive: false,
      activeAgentCount: 0,
      waitingAgentCount: 0,
      blockedAgentCount: 0,
      completedAgentCount: 0,
      unacknowledgedCompletedAgentCount: 0,
      processCount: 0,
      ...overrides,
    };
  }

  const searchProps = {
    ...dropdownProps,
    query: "spike",
    onCreateScratch: vi.fn(),
    onSelectScratch: vi.fn(),
  };

  it("puts a scratch row in the same listbox the input drives, addressed by the same id scheme", () => {
    const project = makeProject({ id: "p1", name: "Spike Project" });
    const scratch = makeScratchRow({ id: "s1", name: "Spike notes" });
    render(
      <ProjectSwitcherPalette {...searchProps} results={[project, scratch]} selectedIndex={1} />
    );

    // The whole fix rests on one array in one listbox: the row the input's
    // active descendant names must resolve INSIDE the listbox it controls, or
    // the highlight is addressing something the arrow keys don't walk (#11071).
    const input = screen.getByTestId("palette-input");
    const listbox = document.getElementById(input.getAttribute("aria-controls")!)!;
    const active = document.getElementById(input.getAttribute("aria-activedescendant")!);

    expect(active).not.toBeNull();
    expect(listbox.contains(active)).toBe(true);
    expect(active!.textContent).toContain("Spike notes");
    expect(within(listbox).getAllByRole("option")).toHaveLength(2);
  });

  it("marks the highlighted row selected rather than the active workspace", () => {
    const rows = [
      makeScratchRow({ id: "s1", name: "Spike one" }),
      makeScratchRow({ id: "s2", name: "Spike two", isActive: true }),
    ];
    render(<ProjectSwitcherPalette {...searchProps} results={rows} selectedIndex={0} />);

    expect(screen.getByRole("option", { name: /Spike one/ }).getAttribute("aria-selected")).toBe(
      "true"
    );
    expect(screen.getByRole("option", { name: /Spike two/ }).getAttribute("aria-selected")).toBe(
      "false"
    );
  });

  it("keeps a scratch row out of the tab order so the arrow keys stay in charge", () => {
    render(
      <ProjectSwitcherPalette
        {...searchProps}
        results={[makeScratchRow({ id: "s1", name: "Spike notes" })]}
      />
    );

    // The behavioural contract, not the tag: a focusable row would take a Tab
    // stop away from the pinned section and split the arrow-key domain.
    expect(screen.getByRole("option", { name: /Spike notes/ }).tabIndex).toBe(-1);
  });

  it("names the row's origin without spending the accent on it", () => {
    render(
      <ProjectSwitcherPalette
        {...searchProps}
        results={[makeScratchRow({ id: "s1", name: "Spike notes" })]}
      />
    );

    const row = screen.getByRole("option", { name: /Spike notes/ });
    expect(row.textContent).toContain("Scratch");
  });

  it("commits a scratch row through the same select handler as a project row", () => {
    const onSelect = vi.fn();
    const scratch = makeScratchRow({ id: "s1", name: "Spike notes" });
    render(<ProjectSwitcherPalette {...searchProps} results={[scratch]} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("option", { name: /Spike notes/ }));

    expect(onSelect).toHaveBeenCalledWith(scratch);
  });

  it("hides the pinned scratch section while searching so rows are listed once", () => {
    const scratch = makeScratchRow({ id: "s1", name: "Spike notes" });
    const { rerender } = render(
      <ProjectSwitcherPalette
        {...dropdownProps}
        query=""
        results={[]}
        scratchResults={[scratch]}
        onCreateScratch={vi.fn()}
      />
    );
    expect(screen.queryByRole("listbox", { name: "Scratch workspaces" })).toBeTruthy();

    rerender(
      <ProjectSwitcherPalette
        {...dropdownProps}
        query="spike"
        results={[scratch]}
        scratchResults={[scratch]}
        onCreateScratch={vi.fn()}
      />
    );

    // Hidden, not unmounted — remounting would reset the collapse state the
    // user set. Either way it must be gone from the accessibility tree, or the
    // same scratch would be announced twice.
    expect(screen.queryByRole("listbox", { name: "Scratch workspaces" })).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("restores the pinned scratch section when the query is cleared", () => {
    const scratch = makeScratchRow({ id: "s1", name: "Spike notes" });
    const { rerender } = render(
      <ProjectSwitcherPalette
        {...dropdownProps}
        query="spike"
        results={[scratch]}
        scratchResults={[scratch]}
        onCreateScratch={vi.fn()}
      />
    );
    rerender(
      <ProjectSwitcherPalette
        {...dropdownProps}
        query=""
        results={[]}
        scratchResults={[scratch]}
        onCreateScratch={vi.fn()}
      />
    );

    expect(screen.queryByRole("listbox", { name: "Scratch workspaces" })).toBeTruthy();
  });

  it("names both kinds in the empty state now that both were searched", () => {
    render(<ProjectSwitcherPalette {...searchProps} results={[]} />);

    // Positively: the umbrella term, not merely the absence of the old copy —
    // "No bananas match spike" would satisfy a negative-only assertion.
    expect(screen.getByTestId("project-empty-state").textContent).toBe(
      'No workspaces match "spike"'
    );
  });

  it("drops the project-only shortcut hints while a scratch is highlighted", () => {
    const { rerender } = render(
      <ProjectSwitcherPalette {...searchProps} results={[makeProject({ id: "p1" })]} />
    );
    expect(screen.getByTestId("palette-footer").textContent).toContain("Remove");

    rerender(
      <ProjectSwitcherPalette
        {...searchProps}
        results={[makeScratchRow({ id: "s1", name: "Spike notes" })]}
      />
    );

    // ⌘⌫ removes a project and does nothing to a scratch, so advertising it
    // here would name a key that has no effect on the highlighted row.
    expect(screen.getByTestId("palette-footer").textContent).not.toContain("Remove");
  });
});

/**
 * The pinned scratch section across a search round-trip (issue #11466).
 *
 * Hiding rather than unmounting keeps the section's own state alive, which is
 * the point — and also the risk, since a hidden subtree's effects and escape
 * claims keep running.
 */
describe("ProjectSwitcherPalette scratch section across search", () => {
  const scratch = {
    id: "s1",
    name: "Spike notes",
    path: "/userData/scratch/s1",
    createdAt: 0,
    lastOpened: 0,
    isActive: false,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    processCount: 0,
  };

  const browseProps = {
    ...dropdownProps,
    query: "",
    results: [],
    scratchResults: [scratch],
    onCreateScratch: vi.fn(),
    onRenameScratch: vi.fn(),
  };

  it("closes an open create editor when the ranked search takes over", () => {
    const { rerender } = render(<ProjectSwitcherPalette {...browseProps} />);
    fireEvent.click(screen.getByTestId("scratch-create-button"));
    expect(screen.getByTestId("scratch-create-input")).toBeTruthy();

    rerender(<ProjectSwitcherPalette {...browseProps} query="spike" rankedSearch />);

    // Left mounted, the editor keeps its claim on the escape stack — Escape
    // would cancel an edit nobody can see instead of closing the palette.
    expect(screen.queryByTestId("scratch-create-input")).toBeNull();
  });

  it("does not resurrect the editor when the query is cleared again", () => {
    const { rerender } = render(<ProjectSwitcherPalette {...browseProps} />);
    fireEvent.click(screen.getByTestId("scratch-create-button"));

    rerender(<ProjectSwitcherPalette {...browseProps} query="spike" rankedSearch />);
    rerender(<ProjectSwitcherPalette {...browseProps} />);

    expect(screen.queryByTestId("scratch-create-input")).toBeNull();
    expect(screen.getByTestId("scratch-create-button")).toBeTruthy();
  });

  it("keeps a collapsed section collapsed across a search round-trip", () => {
    const { rerender } = render(<ProjectSwitcherPalette {...browseProps} />);
    const header = screen.getByRole("button", { name: /Scratch/ });
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");

    rerender(<ProjectSwitcherPalette {...browseProps} query="spike" rankedSearch />);
    rerender(<ProjectSwitcherPalette {...browseProps} />);

    // Unmounting instead would reseed `collapsed` from the scratch count and
    // spring the section back open under a user who deliberately shut it.
    expect(screen.getByRole("button", { name: /Scratch/ }).getAttribute("aria-expanded")).toBe(
      "false"
    );
  });

  it("keeps the section visible while the ranking is still catching up", () => {
    // A non-empty box whose ranked results have not landed yet: the scratches
    // are not in `results`, so hiding the section here would leave them in
    // neither list and read as "no matches".
    render(<ProjectSwitcherPalette {...browseProps} query="spike" rankedSearch={false} />);

    expect(screen.queryByRole("listbox", { name: "Scratch workspaces" })).toBeTruthy();
  });
});

/**
 * Scratch rows carry the same status line project rows do (issue #11518).
 *
 * What the component owes: the agent-activity sentence reaches BOTH scratch
 * surfaces — the ranked search row and the pinned browse section — and the
 * facts each surface already showed (origin in search, cleanup countdown in
 * browse) survive alongside it.
 */
describe("ProjectSwitcherPalette scratch status treatment", () => {
  const scratchBase = {
    id: "s1",
    name: "Spike notes",
    path: "/userData/scratch/s1",
    createdAt: 0,
    lastOpened: 0,
    isActive: false,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    processCount: 0,
  };

  function rankedProps(overrides: Partial<SearchableScratch>) {
    return {
      ...dropdownProps,
      query: "spike",
      rankedSearch: true,
      results: [{ kind: "scratch" as const, ...scratchBase, ...overrides }],
      onSelectScratch: vi.fn(),
    };
  }

  function browseProps(overrides: Partial<SearchableScratch>) {
    return {
      ...dropdownProps,
      query: "",
      results: [],
      scratchResults: [{ ...scratchBase, ...overrides }],
      onCreateScratch: vi.fn(),
    };
  }

  it("states agent activity on a ranked scratch row", () => {
    render(<ProjectSwitcherPalette {...rankedProps({ waitingAgentCount: 2 })} />);

    expect(screen.getByText("2 agents need input")).toBeTruthy();
  });

  it("states agent activity on a pinned scratch row", () => {
    render(<ProjectSwitcherPalette {...browseProps({ waitingAgentCount: 2 })} />);

    expect(screen.getByText("2 agents need input")).toBeTruthy();
  });

  // In the ranked list a scratch sits among projects with no section header to
  // place it, so losing the origin would make it indistinguishable from one.
  it("keeps the scratch origin legible in search once status takes the line", () => {
    render(<ProjectSwitcherPalette {...rankedProps({ activeAgentCount: 1 })} />);

    const line = screen.getByText("Agent running").parentElement!;
    // Order matters: the origin trails the status, and the separator is what
    // keeps them one readable line rather than two adjacent labels.
    expect(Array.from(line.children).map((el) => el.textContent!.trim())).toEqual([
      "Agent running",
      "· Scratch",
    ]);
  });

  it("keeps the cleanup countdown beside the status line", () => {
    // Opened just inside the countdown window, so both facts are due at once.
    const lastOpened = Date.now() - (SCRATCH_CLEANUP_TTL_MS - 2 * 24 * 3600_000);
    render(<ProjectSwitcherPalette {...browseProps({ lastOpened, activeAgentCount: 1 })} />);

    expect(screen.getByText("Agent running")).toBeTruthy();
    expect(screen.getByTestId("scratch-cleanup-countdown")).toBeTruthy();
  });

  // Same contract the project rows hold: the dot repeats the tone and carries
  // no accessible name, so status is never colour-only nor announced twice.
  it("conveys scratch status as text rather than a labelled dot", () => {
    render(<ProjectSwitcherPalette {...browseProps({ blockedAgentCount: 1 })} />);

    expect(screen.getByText("Agent blocked")).toBeTruthy();
    expect(screen.queryByLabelText("Agents waiting")).toBeNull();
    expect(screen.queryByLabelText("Idle")).toBeNull();
  });

  it("falls back to the opened time when the scratch has no activity", () => {
    render(<ProjectSwitcherPalette {...browseProps({ lastOpened: Date.now() - 2 * 3600_000 })} />);

    expect(screen.getByText(/^Opened /)).toBeTruthy();
  });

  // The tick lives at the palette level, not inside the project list. Moved
  // back down, the pinned section — a sibling of that list — would never
  // re-render, and a wait age there would read "just now" forever.
  it("advances a pinned scratch's wait age without any prop change", async () => {
    vi.useFakeTimers();
    try {
      const waitingSince = Date.now() - 60_000;
      render(
        <ProjectSwitcherPalette
          {...browseProps({ waitingAgentCount: 1, oldestWaitingSince: waitingSince })}
        />
      );

      expect(screen.getByText("Agent needs input · waiting 1m")).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(screen.getByText("Agent needs input · waiting 2m")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  // Placement is explicitly unchanged by #11518: the section stays below the
  // project list rather than being promoted alongside it.
  it("leaves the pinned section below the project list", () => {
    render(
      <ProjectSwitcherPalette
        {...browseProps({ waitingAgentCount: 1 })}
        results={[makeProject({ id: "p1", name: "Payments" })]}
      />
    );

    const projectRow = screen.getByRole("option", { name: /Payments/ });
    const scratchList = screen.getByRole("listbox", { name: "Scratch workspaces" });
    expect(
      projectRow.compareDocumentPosition(scratchList) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
