/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";

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

  return {
    AppPaletteDialog: Dialog,
    KBD_CLASS: "px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-daintree-border text-daintree-text/60",
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

import type { SearchableProject } from "@/hooks/useProjectSwitcherPalette";

const { ProjectSwitcherPalette } = await import("../ProjectSwitcherPalette");

function makeProject(overrides: Partial<SearchableProject> = {}): SearchableProject {
  // Deliberately dumb: `section` defaults to "other" and must be stated
  // explicitly by band tests. Deriving it here would restate the hook's
  // classification rules, so a fixture could keep rendering the intended bands
  // while the real `sectionForProject` drifted — the component tests would stay
  // green either way. Classification is owned by the hook's own suite.
  return {
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
    const list = screen.getByRole("listbox", { name: "Projects" });
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
    const list = screen.getByRole("listbox", { name: "Projects" });
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

    it("advertises the order once the band is long enough to need it", () => {
      render(<ProjectSwitcherPalette {...dropdownProps} results={withOtherRows(4)} />);
      expect(screen.getByTestId("other-projects-sort-trigger")).toBeTruthy();
    });

    it("stays quiet on a band short enough to read at a glance", () => {
      render(<ProjectSwitcherPalette {...dropdownProps} results={withOtherRows(3)} />);
      expect(screen.queryByTestId("other-projects-sort-trigger")).toBeNull();
    });

    it("puts the control only on the Other band", () => {
      render(<ProjectSwitcherPalette {...dropdownProps} results={withOtherRows(4)} />);
      // Pinned and Running are load-bearing orders this preference must not
      // claim to govern, so neither header may grow a control.
      expect(screen.getAllByTestId("other-projects-sort-trigger")).toHaveLength(1);
    });

    it("keeps the band's accessible name free of the mode it is showing", () => {
      // The header id is the group's aria-labelledby target, and that name is
      // computed from the element's whole subtree — nesting the mode inside it
      // would name the band "Other projects Hottest" to a screen reader.
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
