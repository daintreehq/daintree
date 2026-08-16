/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
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
import { useProjectSettingsStore } from "@/store/projectSettingsStore";

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
    snoozedAgentCount: 0,
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

  // A row with nothing running has nothing to report, and twenty of those in a
  // row were most of the palette's height and none of its meaning (#11692).
  it("gives a row with nothing to report no second line at all", () => {
    const twoHoursAgo = Date.now() - 2 * 3600000;
    render(
      <ProjectSwitcherPalette {...baseProps} results={[makeProject({ lastOpened: twoHoursAgo })]} />
    );
    expect(screen.queryByText(/^Opened /)).toBeNull();
    expect(screen.queryByText("Not opened yet")).toBeNull();
  });

  it("stays silent rather than echoing a path for a never-opened project", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[makeProject({ path: "/home/user/my-project", displayPath: "my-project" })]}
      />
    );
    expect(screen.queryByText("Not opened yet")).toBeNull();
    // The name is still the row — silence removes the status line, not the row.
    expect(screen.getByRole("option", { name: /Test Project/ })).toBeTruthy();
  });

  // The hint tells two same-named folders apart, so it is identity rather than
  // status: it outlives the line the dormant row no longer draws.
  it("keeps the disambiguating path on a row that has gone quiet", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[
          makeProject({
            lastOpened: Date.now() - 2 * 3600000,
            displayPath: "payments/api",
          }),
        ]}
      />
    );

    const hint = screen.getByText("payments/api");
    expect(hint).toBeTruthy();
    // No orphaned separator: the "·" only joins the hint to a status sentence,
    // and there is no sentence here to join it to.
    expect(hint.textContent).not.toContain("·");
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
    // Muted, but still a fact the row earned — it keeps its line and its mark.
    expect(screen.getByTestId("workspace-status-dot")).toBeTruthy();
  });

  it("says nothing at all for a closed project without the parked marker", () => {
    const twoHoursAgo = Date.now() - 2 * 3600000;
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[makeProject({ status: "closed", lastOpened: twoHoursAgo })]}
      />
    );
    // Closed on its own is not a reason: without the auto-park marker the row
    // falls through to the opened-time fallback, which no longer prints.
    expect(screen.queryByText("Suspended to free memory")).toBeNull();
    expect(screen.queryByText(/^Opened /)).toBeNull();
  });
});

/**
 * The leading dot marks rows that have something to say. It used to sit on
 * every row as a hollow ring, which made the most common mark in the list the
 * one carrying no information — and left it competing with the filled dots that
 * do (#11692).
 */
describe("ProjectSwitcherPalette status dot", () => {
  it("marks a row with something to report and leaves a quiet one unmarked", () => {
    const { rerender } = render(
      <ProjectSwitcherPalette {...baseProps} results={[makeProject({ waitingAgentCount: 1 })]} />
    );
    expect(screen.getByTestId("workspace-status-dot")).toBeTruthy();

    rerender(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[makeProject({ lastOpened: Date.now() - 2 * 3600000 })]}
      />
    );
    expect(screen.queryByTestId("workspace-status-dot")).toBeNull();
  });

  /*
   * Structural only — jsdom does no layout, so this pins that the slot element
   * survives on a quiet row, not that it still measures 6px. What it rules out
   * is the tempting simplification: dropping the whole slot instead of just its
   * dot, which would pull every quiet row's tile left of the busy ones.
   */
  it("keeps the indicator slot on an unmarked row and empties it instead", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[
          makeProject({ id: "busy", name: "Busy", waitingAgentCount: 1 }),
          makeProject({ id: "quiet", name: "Quiet", lastOpened: Date.now() - 2 * 3600000 }),
        ]}
      />
    );

    const slotIn = (row: HTMLElement) => row.querySelector("[data-testid='workspace-status-slot']");
    const busy = screen.getByRole("option", { name: /Busy/ });
    const quiet = screen.getByRole("option", { name: /Quiet/ });

    expect(slotIn(busy)).toBeTruthy();
    expect(slotIn(quiet)).toBeTruthy();
    expect(slotIn(busy)!.querySelector("[data-testid='workspace-status-dot']")).toBeTruthy();
    expect(slotIn(quiet)!.querySelector("[data-testid='workspace-status-dot']")).toBeNull();
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
    // A folder that has gone missing is the loudest thing a row can report, so
    // it keeps both the line and the mark the quiet rows gave up.
    expect(screen.getByTestId("workspace-status-dot")).toBeTruthy();
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

/**
 * Two things in this list need telling apart: where you are, and where Enter
 * would take you (#11692). They ride separate channels on purpose —
 * `aria-selected` is the sole authority on the Enter target, so "current" is
 * said with a band header, `aria-current`, and a word in the accessible name.
 */
describe("ProjectSwitcherPalette current-project marker", () => {
  // The override map is module state on a real store — left set, it would mute
  // every later fixture that reuses the default project id.
  afterEach(() => {
    useProjectSettingsStore.setState({ notificationOverridesByProjectId: {} });
  });

  const currentAndOther = [
    makeProject({ id: "active", name: "Active Project", isActive: true, section: "current" }),
    makeProject({ id: "other", name: "Other Project", section: "other" }),
  ];

  it("separates where you are from where Enter goes", () => {
    // The hook preselects the first switchable row, so the cursor is on a row
    // the current marker must not also claim.
    render(<ProjectSwitcherPalette {...modalProps} results={currentAndOther} selectedIndex={1} />);

    const current = screen.getByRole("option", { name: /Active Project/ });
    const cursor = screen.getByRole("option", { name: /Other Project/ });

    expect(current.getAttribute("aria-current")).toBe("true");
    expect(current.getAttribute("aria-selected")).toBe("false");
    expect(cursor.getAttribute("aria-selected")).toBe("true");
    expect(cursor.getAttribute("aria-current")).toBeNull();
  });

  it("names the band the current project sits in", () => {
    render(<ProjectSwitcherPalette {...modalProps} results={currentAndOther} />);

    const band = screen.getByRole("group", { name: "Current project" });
    expect(within(band).getByRole("option", { name: /Active Project/ })).toBeTruthy();
    // The band holds only the current project — the rest of the list is
    // elsewhere, which is what makes the header true.
    expect(within(band).getAllByRole("option")).toHaveLength(1);
  });

  // Bands are browse-only, so search leaves the header behind. The row still
  // has to say it — `aria-current` alone goes unannounced inside a listbox
  // often enough that the accessible name has to carry the word too.
  it("keeps saying it in search, where there is no band to say it for the row", () => {
    render(
      <ProjectSwitcherPalette {...modalProps} query="proj" rankedSearch results={currentAndOther} />
    );

    expect(screen.queryByRole("group", { name: "Current project" })).toBeNull();
    const current = screen.getByRole("option", { name: /Active Project, current/ });
    expect(current.getAttribute("aria-current")).toBe("true");
    // Only the one row says it — the word is a marker, not decoration.
    expect(screen.queryByRole("option", { name: /Other Project, current/ })).toBeNull();
  });

  // The two changes meet on this row: the project you are in is usually the one
  // with nothing running, so the marker has to survive the collapse that takes
  // its status line and dot away.
  it("still marks the current project when it is the quietest row in the list", () => {
    render(
      <ProjectSwitcherPalette
        {...modalProps}
        results={[
          makeProject({
            id: "active",
            name: "Active Project",
            isActive: true,
            section: "current",
            lastOpened: Date.now() - 2 * 3600000,
          }),
        ]}
      />
    );

    const row = screen.getByRole("option", { name: /Active Project, current/ });
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(within(row).queryByTestId("workspace-status-dot")).toBeNull();
    expect(screen.queryByText(/^Opened /)).toBeNull();
    expect(screen.getByRole("group", { name: "Current project" })).toBeTruthy();
  });

  /*
   * The row's name is assembled from adjacent nodes, and a labelled icon
   * concatenates straight onto whatever precedes it — so a muted current
   * project once named as "…, currentNotifications muted…". Both markers have
   * to survive together, separated, in either order of arrival.
   */
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("keeps the name readable with isActive=%s muted=%s", (isActive, muted) => {
    useProjectSettingsStore.setState({
      notificationOverridesByProjectId: muted
        ? { "proj-1": { completedEnabled: false, waitingEnabled: false } }
        : {},
    });

    render(
      <ProjectSwitcherPalette
        {...modalProps}
        results={[
          makeProject({ name: "Payments", isActive, section: isActive ? "current" : "other" }),
        ]}
      />
    );

    // Asserted against the accessible NAME, not textContent — the bell is an
    // SVG carrying an aria-label, so it contributes nothing to the latter and
    // the run-together bug is invisible there.
    const marked = screen.queryByRole("option", { name: /Payments, current\b/ }) !== null;
    expect(marked).toBe(isActive);
    // A word ending immediately before the bell's label means the two fused
    // into one — "Payments, currentNotifications muted…". A punctuated join is
    // fine; the name-computation polyfill trims each node, so the separator
    // reliably survives as the comma rather than as the space after it.
    expect(screen.queryByRole("option", { name: /[A-Za-z]Notifications muted/ })).toBeNull();
  });

  // The header is chrome, not a row. Arrow keys walk `results`, and a label
  // that registered as an option would put a dead stop in that walk.
  it("does not add the header to the option count", () => {
    render(<ProjectSwitcherPalette {...modalProps} results={currentAndOther} />);

    const list = screen.getByRole("listbox", { name: "Workspaces" });
    expect(within(list).getAllByRole("option")).toHaveLength(currentAndOther.length);
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
          text === "Current project" ||
          text === "Pinned" ||
          text === "Running" ||
          text === "Other projects"
      );
    // The band you are in leads, then Pinned above Running: an explicit pin
    // outranks the operational fact that something is executing.
    expect(headers[0]).toBe("Current project");
    expect(headers[1]).toBe("Pinned");
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

  it("keeps the footer to the rails the switcher currently names", () => {
    // A ⌘⌫ Remove rail used to sit here and is gone: it overflowed the footer
    // while the anchored tier was 352px, and #11736's widening has not brought
    // it back. Asserted as an absence because jsdom evaluates no container
    // query — a presence assertion here would pass on text no user ever sees.
    render(<ProjectSwitcherPalette {...dropdownProps} results={multiProjects} />);
    const footer = screen.getByTestId("palette-footer");
    expect(footer.textContent).toContain("Switch");
    expect(footer.textContent).not.toContain("Remove");
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
      snoozedAgentCount: 0,
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

    const cursor = screen.getByRole("option", { name: /Spike one/ });
    const active = screen.getByRole("option", { name: /Spike two/ });

    expect(cursor.getAttribute("aria-selected")).toBe("true");
    expect(active.getAttribute("aria-selected")).toBe("false");
    // The other half of the same contract: the row Enter would act on is not
    // the one you are in, and each says only its own fact (#11692).
    expect(active.getAttribute("aria-current")).toBe("true");
    expect(cursor.getAttribute("aria-current")).toBeNull();
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
    // Run on the command tier, the only one that actually paints the
    // context-menu rail — the anchored dropdown's footer stays under the
    // query's threshold even at the wider tier, so the rail is queried away
    // there, and jsdom evaluates no container query, which would let this pass
    // on text the user never sees.
    const commandSearchProps = { ...searchProps, mode: "modal" as const };
    const { rerender } = render(
      <ProjectSwitcherPalette {...commandSearchProps} results={[makeProject({ id: "p1" })]} />
    );
    expect(screen.getByTestId("palette-footer").textContent).toContain("Right-click for more");

    rerender(
      <ProjectSwitcherPalette
        {...commandSearchProps}
        results={[makeScratchRow({ id: "s1", name: "Spike notes" })]}
      />
    );

    // A search-mode scratch row carries no context menu, so pointing at one
    // would name an affordance the highlighted row does not have.
    expect(screen.getByTestId("palette-footer").textContent).not.toContain("Right-click for more");
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
    snoozedAgentCount: 0,
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
    snoozedAgentCount: 0,
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
  // It rides the name because it answers what the row *is*, and because parked
  // on the status line it held that line open on a scratch with nothing to
  // report — the second line #11692 hands back.
  it("keeps the scratch origin legible beside the name", () => {
    render(<ProjectSwitcherPalette {...rankedProps({ activeAgentCount: 1 })} />);

    const nameLine = screen.getByText("Spike notes").parentElement!;
    expect(Array.from(nameLine.children).map((el) => el.textContent!.trim())).toEqual([
      "Spike notes",
      "· Scratch",
    ]);
    // The status keeps its own line rather than sharing the name's.
    expect(nameLine.textContent).not.toContain("Agent running");
    expect(screen.getByText("Agent running")).toBeTruthy();
  });

  it("gives a quiet scratch one line without losing what it is", () => {
    render(<ProjectSwitcherPalette {...rankedProps({ lastOpened: Date.now() - 2 * 3600_000 })} />);

    expect(screen.queryByText(/^Opened /)).toBeNull();
    expect(screen.queryByTestId("workspace-status-dot")).toBeNull();
    // Provenance is identity, not status — it survives the collapse.
    expect(screen.getByText("· Scratch")).toBeTruthy();
  });

  // The lone ranked result is also the cursor, so this is the both-at-once
  // case: the two attributes describe different facts that happen to coincide,
  // and each still has to be stated.
  it("marks the scratch you are in even while it is also the Enter target", () => {
    render(<ProjectSwitcherPalette {...rankedProps({ isActive: true })} />);

    // Queried by accessible name, not textContent — that is what proves the
    // hidden word actually names the option rather than just sitting in it.
    const row = screen.getByRole("option", { name: /Spike notes.*current/ });
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(row.getAttribute("aria-selected")).toBe("true");
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

  it("stays quiet in the pinned section when the scratch has no activity", () => {
    render(<ProjectSwitcherPalette {...browseProps({ lastOpened: Date.now() - 2 * 3600_000 })} />);

    expect(screen.queryByText(/^Opened /)).toBeNull();
    expect(screen.queryByTestId("workspace-status-dot")).toBeNull();
    expect(screen.getByText("Spike notes")).toBeTruthy();
  });

  // Cleanup is the one thing a dormant scratch still has to say: it is about to
  // be deleted, which is exactly the report an idle row can owe you.
  it("keeps the cleanup countdown on a scratch that is otherwise quiet", () => {
    const lastOpened = Date.now() - (SCRATCH_CLEANUP_TTL_MS - 2 * 24 * 3600_000);
    render(<ProjectSwitcherPalette {...browseProps({ lastOpened })} />);

    expect(screen.queryByText(/^Opened /)).toBeNull();
    expect(screen.getByTestId("scratch-cleanup-countdown")).toBeTruthy();
  });

  // This list has no roving cursor, so `aria-selected` is free to mean "the one
  // you're in" and says it alone — a second attribute for the same fact would
  // have a reader announce one state as two.
  it("marks the pinned scratch you are in without doubling the signal", () => {
    render(<ProjectSwitcherPalette {...browseProps({ isActive: true })} />);

    const row = within(screen.getByRole("listbox", { name: "Scratch workspaces" })).getByRole(
      "option"
    );
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(row.getAttribute("aria-current")).toBeNull();
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

/**
 * The "resumes with agents" mark (#11801). It gives the Other Projects band a
 * mark again without reintroducing the permanent ring #11692 removed: it lands
 * only where the slot was already empty, and it says something the row can act
 * on — opening this project brings these agents back.
 */
describe("ProjectSwitcherPalette resumable-agent dot", () => {
  const QUIET = { lastOpened: Date.now() - 2 * 3600000 };

  it("marks a quiet row that would bring agents back", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[makeProject({ ...QUIET, resumableAgentCount: 3 })]}
      />
    );
    expect(screen.getByTestId("workspace-resume-dot")).toBeTruthy();
  });

  it("leaves a row that restores no agents unmarked and unannounced", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[makeProject({ ...QUIET, resumableAgentCount: 0 })]}
      />
    );
    expect(screen.queryByTestId("workspace-resume-dot")).toBeNull();
    // "0 agents will resume" is a sentence nobody needs to hear.
    expect(screen.queryByRole("option", { name: /will resume/i })).toBeNull();
  });

  it("makes no claim for a row main has not counted yet", () => {
    // Absent is not zero, but it is equally not a promise: a row that predates
    // the count must stay silent rather than guess in either direction.
    render(<ProjectSwitcherPalette {...baseProps} results={[makeProject(QUIET)]} />);
    expect(screen.queryByTestId("workspace-resume-dot")).toBeNull();
    expect(screen.queryByRole("option", { name: /will resume/i })).toBeNull();
  });

  it("yields to a row that has a real status to report", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[makeProject({ waitingAgentCount: 1, resumableAgentCount: 2 })]}
      />
    );
    // The status dot says what the project is doing now; the resume dot only
    // says what it would come back with. Two dots in a one-dot slot would be
    // the regression.
    expect(screen.getByTestId("workspace-status-dot")).toBeTruthy();
    expect(screen.queryByTestId("workspace-resume-dot")).toBeNull();
  });

  it("keys off the count rather than the band, so a pinned row keeps the mark", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[
          makeProject({ ...QUIET, isPinned: true, section: "pinned", resumableAgentCount: 1 }),
        ]}
      />
    );
    expect(screen.getByTestId("workspace-resume-dot")).toBeTruthy();
  });

  it("says how many, in the row's name, rather than in colour alone", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[makeProject({ ...QUIET, name: "Marked", resumableAgentCount: 3 })]}
      />
    );
    // Matched with the name attached, so a missing separator ("Marked3 agents")
    // fails here rather than passing on the phrase alone.
    expect(screen.getByRole("option", { name: /Marked, 3 agents will resume/i })).toBeTruthy();
    expect(screen.getByTestId("workspace-resume-dot").getAttribute("aria-hidden")).toBe("true");
  });

  it("speaks of one agent in the singular", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[makeProject({ ...QUIET, name: "Solo", resumableAgentCount: 1 })]}
      />
    );
    // Through the accessible name, not textContent: a phrase that became
    // aria-hidden would still read correctly in the DOM while saying nothing.
    expect(screen.getByRole("option", { name: /Solo, 1 agent will resume/i })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /1 agents will resume/i })).toBeNull();
  });

  it("does not announce itself again on every render", () => {
    // The mark is part of the row's name, not a live region — otherwise
    // rendering the list would re-read every markable row aloud.
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[makeProject({ ...QUIET, name: "Quiet dot", resumableAgentCount: 2 })]}
      />
    );
    const row = screen.getByRole("option", { name: /2 agents will resume/i });
    expect(row.querySelector("[aria-live]")).toBeNull();
    expect(row.querySelector("[role='status'], [role='alert']")).toBeNull();
    expect(row.getAttribute("aria-live")).toBeNull();
  });

  it("does not widen the slot it shares with the status dot", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[
          makeProject({ ...QUIET, id: "resuming", name: "Resuming", resumableAgentCount: 2 }),
          makeProject({ ...QUIET, id: "quiet", name: "Quiet" }),
        ]}
      />
    );
    const slotIn = (row: HTMLElement) => row.querySelector("[data-testid='workspace-status-slot']");
    const marked = slotIn(screen.getByRole("option", { name: /Resuming/ }));
    const unmarked = slotIn(screen.getByRole("option", { name: /Quiet/ }));

    // The mark goes inside the reserved slot, not beside it — so the slot has to
    // both contain the dot and stay the same element it is on an unmarked row.
    expect(marked?.querySelector("[data-testid='workspace-resume-dot']")).toBeTruthy();
    expect(unmarked?.querySelector("[data-testid='workspace-resume-dot']")).toBeNull();
    expect(marked?.className).toBe(unmarked?.className);
  });

  it("never marks the project you are already in", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[
          makeProject({
            ...QUIET,
            name: "Here",
            isActive: true,
            status: "active",
            // A real count — those agents are on screen, not waiting to return.
            resumableAgentCount: 4,
          }),
        ]}
      />
    );
    // The row is otherwise exactly the quiet shape the mark applies to — no
    // status dot of its own — so the suppression is what this proves, rather
    // than a real status having displaced the mark.
    expect(screen.queryByTestId("workspace-status-dot")).toBeNull();
    expect(screen.queryByTestId("workspace-resume-dot")).toBeNull();
    // "…, current, 4 agents will resume" would be the nonsense this rules out.
    expect(screen.queryByRole("option", { name: /will resume/i })).toBeNull();
  });

  it("holds the mark steady while the ticker it no longer depends on keeps running", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // Two rows, because this has to prove two things at once: the predecessor
      // mark decayed against the minute ticker, so the resume dot must survive
      // it — but the ticker itself must still be running, or the test would
      // also pass with the ticker deleted. The waiting row's age is the witness.
      const results = [
        makeProject({ ...QUIET, id: "dot", name: "Dot", resumableAgentCount: 2 }),
        makeProject({
          id: "waiting",
          name: "Waiting",
          waitingAgentCount: 1,
          oldestWaitingSince: Date.now() - 60_000,
        }),
      ];
      render(<ProjectSwitcherPalette {...baseProps} results={results} />);

      const dotRow = () => screen.getByRole("option", { name: /Dot/ });
      expect(dotRow().querySelector("[data-testid='workspace-resume-dot']")).toBeTruthy();
      const ageBefore = screen.getByRole("option", { name: /Waiting/ }).textContent;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(180_000);
      });

      // The clock moved — the wait age says so — and the mark did not.
      expect(screen.getByRole("option", { name: /Waiting/ }).textContent).not.toBe(ageBefore);
      expect(dotRow().querySelector("[data-testid='workspace-resume-dot']")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
