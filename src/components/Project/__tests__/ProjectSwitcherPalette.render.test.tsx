/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { render, screen, within, fireEvent, act, cleanup } from "@testing-library/react";

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
  // `trailing` is rendered, not dropped: it is a slot the palette puts real
  // content in, and a mock that swallows it would let the header's summary
  // regress to nothing while this suite stayed green.
  const Header = ({
    children,
    trailing,
  }: {
    children: React.ReactNode;
    trailing?: React.ReactNode;
  }) => (
    <div data-testid="palette-header">
      {trailing}
      {children}
    </div>
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
  ProjectSwitcherBrowseBand,
  ProjectSwitcherProjectRow,
  ProjectSwitcherScratchRow,
  SearchableProject,
  SearchableScratch,
} from "@/hooks/useProjectSwitcherPalette";
import { SCRATCH_CLEANUP_TTL_MS } from "@shared/config/scratchCleanup";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";

const { ProjectSwitcherPalette } = await import("../ProjectSwitcherPalette");
const { usePreferencesStore } = await import("@/store/preferencesStore");

// Band collapse is a persisted, app-global preference now (#11943), so a test
// that folds one hands the fold to every test after it. Reset rather than mock
// the store: these suites exercise the real fold, and a mock would only prove
// the mock folds.
beforeEach(() => {
  usePreferencesStore.setState({ projectSwitcherCollapsedBands: {} });
});

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
    expect(screen.getByText("3 need input")).toBeTruthy();
  });

  it("singularises a lone waiting agent", () => {
    render(
      <ProjectSwitcherPalette {...baseProps} results={[makeProject({ waitingAgentCount: 1 })]} />
    );
    expect(screen.getByText("1 needs input")).toBeTruthy();
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
    expect(screen.getByText("2 need input")).toBeTruthy();
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
    expect(screen.getByText("2 need input · 1 blocked")).toBeTruthy();
  });

  it("reports running agents as a count rather than a sentence", () => {
    render(
      <ProjectSwitcherPalette {...baseProps} results={[makeProject({ activeAgentCount: 2 })]} />
    );
    // Running is the second axis, not a tier of this waterfall — it draws in
    // the row's own column so it survives a wait or a snooze winning the line.
    expect(screen.getByTestId("workspace-running-count").textContent).toBe("2 agents running");
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

  it("keeps the auto-park reason while its ring gives way to the resume mark", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[
          makeProject({
            name: "Parked",
            status: "closed",
            autoParkedAt: Date.now(),
            lastOpened: Date.now() - 2 * 3600000,
            resumableAgentCount: 2,
          }),
        ]}
      />
    );

    // Why it is parked and how much comes back are both facts about this row,
    // and it only has one dot to spend — so the reason stays in the line while
    // the dot goes to the promise (#11822).
    const row = screen.getByRole("option", { name: /Parked, 2 agents will resume/i });
    expect(within(row).getByText("Suspended to free memory")).toBeTruthy();
    expect(within(row).getByTestId("workspace-resume-dot")).toBeTruthy();
    // The slot holds one dot: a fix that left both conditions independent would
    // stack them here rather than swapping.
    expect(within(row).queryByTestId("workspace-status-dot")).toBeNull();
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
 * The leading mark flags rows that have something to say. It used to sit on
 * every row as a hollow ring, which made the most common mark in the list the
 * one carrying no information — and left it competing with the filled dots that
 * do (#11692). Its shape is a second signal now (#11832); these cases cover
 * only whether a mark is drawn at all.
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
   * survives on a quiet row, not that it still measures its nominal width. What
   * it rules out
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

/**
 * Two facts, two carriers (#11832). The row's mark weighs its running agents
 * against the ones asking for something; its line states both counts, running
 * first. The tests below always compare two rows that differ in exactly one of
 * those, so a change that collapsed them back onto one carrier fails here
 * rather than passing by matching a string.
 */
describe("ProjectSwitcherPalette liveness axis", () => {
  const markIn = (row: HTMLElement) => row.querySelector("[data-testid='workspace-status-dot']");
  const shareOf = (row: HTMLElement) => markIn(row)?.getAttribute("data-running-share") ?? null;

  function renderPair(runningCount: number) {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[
          makeProject({ id: "stalled", name: "Stalled", waitingAgentCount: 1 }),
          makeProject({
            id: "churning",
            name: "Churning",
            waitingAgentCount: 1,
            activeAgentCount: runningCount,
          }),
        ]}
      />
    );
    return {
      stalled: screen.getByRole("option", { name: /Stalled/ }),
      churning: screen.getByRole("option", { name: /Churning/ }),
    };
  }

  it("splits the mark on the row that has both, and leaves the stalled one solid", () => {
    const { stalled, churning } = renderPair(3);

    // The original bug in one assertion: these two rows want the same thing and
    // used to draw the same mark, while only one of them was still moving.
    expect(shareOf(stalled)).toBeNull();
    expect(shareOf(churning)).not.toBeNull();
    // Structurally different marks, not just differently classed ones: the
    // split one is a wedge over a full disc, while a row leaning entirely one
    // way stays a plain div. Both shapes are named, and their fills asserted
    // apart, because the wedge alone still renders as a plausible mark — it
    // would just be a slice floating on the row, which is the transparent
    // background the disc underneath exists to prevent.
    expect(markIn(stalled)?.tagName).toBe("DIV");
    expect(markIn(churning)?.tagName).toBe("svg");
    const disc = markIn(churning)?.querySelector("circle");
    const wedge = markIn(churning)?.querySelector("path");
    expect(disc).toBeTruthy();
    expect(wedge).toBeTruthy();
    expect(disc?.getAttribute("fill")).not.toBe(wedge?.getAttribute("fill"));
  });

  it("leans the mark toward whichever side has more agents", () => {
    // Deliberately one agent apart rather than a wide spread. Against one
    // waiting agent these are 3/4 and 2/3 — two ratios the old quarter-snapped
    // mark drew identically, so this fails if the component ever goes back to
    // rendering a pose instead of the counts' own proportion.
    const mostlyRunning = renderPair(3).churning;
    cleanup();
    const nearerEven = renderPair(2).churning;

    expect(Number(shareOf(mostlyRunning))).toBeGreaterThan(Number(shareOf(nearerEven)));
  });

  it("leaves the demand sentence identical on both", () => {
    const { stalled, churning } = renderPair(2);

    // Purely additive: the tier that won the line is unchanged, so a row that
    // gained the count did not lose anything to it.
    const demand = (row: HTMLElement) => within(row).getByText("1 needs input");
    expect(demand(churning).textContent).toBe(demand(stalled).textContent);
    expect(demand(churning).className).toBe(demand(stalled).className);
  });

  it("draws the count on the churning row only", () => {
    const { stalled, churning } = renderPair(2);

    expect(within(churning).getByTestId("workspace-running-count").textContent).toBe(
      "2 agents running"
    );
    expect(within(stalled).queryByTestId("workspace-running-count")).toBeNull();
  });

  it("leads the line with the count and colours it apart from the demand", () => {
    const { churning } = renderPair(2);

    // Running is the figure the switcher gets opened for, so it comes first —
    // and it carries its own hue, because greying it made it read as an
    // afterthought rather than as the answer.
    const count = within(churning).getByTestId("workspace-running-count");
    const demand = within(churning).getByText("1 needs input");
    expect(count.compareDocumentPosition(demand) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(count.className).not.toBe(demand.className);
    expect(count.textContent).not.toContain("need input");
  });

  it("keeps the assistant's phrase out of the hue a launched run wears", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[
          makeProject({ id: "solo", name: "Solo", assistantState: "working" }),
          makeProject({
            id: "helped",
            name: "Helped",
            waitingAgentCount: 1,
            assistantState: "working",
          }),
          makeProject({ id: "worked", name: "Worked", waitingAgentCount: 1, activeAgentCount: 2 }),
        ]}
      />
    );

    const rowOf = (name: RegExp) => screen.getByRole("option", { name });
    const countIn = (row: HTMLElement) => within(row).getByTestId("workspace-running-count");
    // The assistant says the same thing on both rows and only its carrier
    // moves: alone it is the row's sentence, and with a wait beside it the
    // sentence is taken and it lands in the slot the count uses. Compared to
    // itself rather than to a named token, so the invariant is "one fact, one
    // hue" and not whichever class happens to draw it.
    const spokenAlone = within(rowOf(/Solo/)).getByText("Assistant working");
    const spokenBeside = countIn(rowOf(/Helped/));

    expect(spokenBeside.textContent).toBe(spokenAlone.textContent);
    expect(spokenBeside.className).toBe(spokenAlone.className);
    // And never the weight a run the user launched carries (#11806) — the slot
    // used to paint everything that reached it in the worker hue.
    expect(spokenBeside.className).not.toBe(countIn(rowOf(/Worked/)).className);
  });

  it("reaches assistive tech as words, not as a mark", () => {
    renderPair(3);

    // Queried by accessible NAME, not by text content: the mark is
    // `aria-hidden`, so the line is the only carrier left, and a count that was
    // itself hidden from the accessibility tree would still sit in the DOM for
    // `textContent` to find while leaving the mark as the sole encoding.
    const spoken = screen.getByRole("option", { name: /Churning.*3 agents running/s });
    expect(markIn(spoken)?.getAttribute("aria-hidden")).toBe("true");
    expect(
      within(spoken).getByTestId("workspace-running-count").getAttribute("aria-hidden")
    ).toBeNull();
  });

  it("states a row's run exactly once", () => {
    render(
      <ProjectSwitcherPalette {...baseProps} results={[makeProject({ activeAgentCount: 2 })]} />
    );

    const row = screen.getByRole("option", { name: /Test Project/ });
    // A row whose only fact is the run has no demand to state, so the count is
    // the whole line — "2 agents running · 2 agents running" would say it twice.
    expect(within(row).getByTestId("workspace-running-count").textContent).toBe("2 agents running");
    expect(row.textContent?.match(/agents running/g)).toHaveLength(1);
    // It is still marked, and solid: with nothing waiting there is nothing to
    // weigh the run against.
    expect(markIn(row)).toBeTruthy();
    expect(shareOf(row)).toBeNull();
  });

  it("marks a running row differently from a waiting one", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[
          makeProject({ id: "run", name: "Runs", activeAgentCount: 2 }),
          makeProject({ id: "wait", name: "Waits", waitingAgentCount: 2 }),
        ]}
      />
    );

    // Both are solid discs, so hue is the only thing separating them — compared
    // rather than named, so renaming a token is not a test edit.
    const running = markIn(screen.getByRole("option", { name: /Runs/ }));
    const waiting = markIn(screen.getByRole("option", { name: /Waits/ }));
    expect(running?.className).not.toBe(waiting?.className);
  });

  it("keeps the resume promise off a row whose agents never stopped", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[makeProject({ activeAgentCount: 2, resumableAgentCount: 3 })]}
      />
    );

    const row = screen.getByRole("option", { name: /Test Project/ });
    expect(within(row).queryByTestId("workspace-resume-dot")).toBeNull();
    expect(row.textContent).not.toContain("will resume");
    expect(within(row).getByTestId("workspace-running-count")).toBeTruthy();
  });

  it("carries both axes on a scratch row too", () => {
    // The pinned section is its own render path and used to draw the status
    // line as a single toned element, which left it structurally unable to hold
    // a second fragment at all.
    const busyScratch: SearchableScratch = {
      id: "s1",
      name: "Spike",
      path: "/userData/scratch/s1",
      createdAt: 0,
      lastOpened: 0,
      isActive: false,
      activeAgentCount: 2,
      waitingAgentCount: 1,
      blockedAgentCount: 0,
      completedAgentCount: 0,
      unacknowledgedCompletedAgentCount: 0,
      snoozedAgentCount: 0,
      processCount: 0,
    };

    render(<ProjectSwitcherPalette {...baseProps} results={[]} scratchResults={[busyScratch]} />);

    const row = screen.getByRole("option", { name: /Spike.*2 agents running/s });
    expect(within(row).getByText("1 needs input")).toBeTruthy();
    expect(shareOf(row)).not.toBeNull();
  });

  it("carries both axes on a scratch in the ranked list too", () => {
    // A third renderer: a searched scratch is drawn by `ScratchListItem`, not by
    // the pinned section above, and the two used to format their status lines
    // independently of each other and of the project row.
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        query="spike"
        results={[
          {
            kind: "scratch",
            id: "s2",
            name: "Spike",
            path: "/userData/scratch/s2",
            createdAt: 0,
            lastOpened: 0,
            isActive: false,
            activeAgentCount: 2,
            waitingAgentCount: 1,
            blockedAgentCount: 0,
            completedAgentCount: 0,
            unacknowledgedCompletedAgentCount: 0,
            snoozedAgentCount: 0,
            processCount: 0,
          },
        ]}
      />
    );

    const row = screen.getByRole("option", { name: /Spike.*2 agents running/s });
    expect(within(row).getByText("1 needs input")).toBeTruthy();
    expect(shareOf(row)).not.toBeNull();
  });
});

describe("ProjectSwitcherPalette fleet summary", () => {
  it("reports what is running across every workspace", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        fleetLiveness={{ runningAgentCount: 4, workingAssistantCount: 0 }}
        results={[makeProject()]}
      />
    );

    expect(screen.getByTestId("fleet-liveness-summary").textContent).toContain("4");
  });

  it("disappears when nothing is executing anywhere", () => {
    // Its absence is the answer to "is it safe to look away?" — a standing zero
    // would make the reader parse a number to learn there is nothing to learn.
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        fleetLiveness={{ runningAgentCount: 0, workingAssistantCount: 0 }}
        results={[makeProject()]}
      />
    );

    expect(screen.queryByTestId("fleet-liveness-summary")).toBeNull();
  });

  it("stays silent for a caller that has no totals to give", () => {
    render(<ProjectSwitcherPalette {...baseProps} results={[makeProject()]} />);

    expect(screen.queryByTestId("fleet-liveness-summary")).toBeNull();
  });

  it("reaches the header through the modal path too", () => {
    // The palette has two hosts and the outer component re-lists every prop by
    // hand into each. Covering only the dropdown left the modal's chain free to
    // drop the summary silently — which is exactly how it shipped broken the
    // first time.
    render(
      <ProjectSwitcherPalette
        {...modalProps}
        fleetLiveness={{ runningAgentCount: 4, workingAssistantCount: 0 }}
        results={[makeProject()]}
      />
    );

    expect(screen.getByTestId("fleet-liveness-summary").textContent).toContain("4");
  });
});

describe("ProjectSwitcherPalette status conveyance", () => {
  // The mark carries no accessible name of its own, so status is never
  // announced twice and never depends on telling two hues — or two shapes —
  // apart. Everything it shows is also stated in the sentence beside it.
  it("conveys status as text rather than a labelled dot", () => {
    render(
      <ProjectSwitcherPalette {...baseProps} results={[makeProject({ waitingAgentCount: 2 })]} />
    );

    expect(screen.getByText("2 need input")).toBeTruthy();
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
    expect(screen.getByText("Clone repository…")).toBeTruthy();
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
    // pointed at "Add project…" would name a button that isn't there.
    const { unmount } = render(<ProjectSwitcherPalette {...modalProps} results={[]} />);
    const modalCopy = screen.getByTestId("project-empty-state").textContent;
    expect(screen.queryByText("Add project…")).toBeNull();
    unmount();

    render(<ProjectSwitcherPalette {...dropdownProps} results={[]} />);
    expect(screen.getByText("Add project…")).toBeTruthy();
    expect(screen.getByTestId("project-empty-state").textContent).not.toBe(modalCopy);
  });

  it("does not show management action buttons in modal mode", () => {
    render(<ProjectSwitcherPalette {...modalProps} results={multiProjects} />);
    expect(screen.queryByText("Project settings…")).toBeNull();
    expect(screen.queryByText("Add project…")).toBeNull();
    expect(screen.queryByText("Clone repository…")).toBeNull();
    expect(screen.queryByText("Create new folder…")).toBeNull();
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

    expect(screen.getByText("2 need input")).toBeTruthy();
  });

  it("states agent activity on a pinned scratch row", () => {
    render(<ProjectSwitcherPalette {...browseProps({ waitingAgentCount: 2 })} />);

    expect(screen.getByText("2 need input")).toBeTruthy();
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
    // The running count keeps the row's trailing edge rather than sharing the
    // name's line.
    expect(nameLine.textContent).not.toContain("running");
    expect(screen.getByTestId("workspace-running-count").textContent).toBe("1 agent running");
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

    expect(screen.getByTestId("workspace-running-count").textContent).toBe("1 agent running");
    expect(screen.getByTestId("scratch-cleanup-countdown")).toBeTruthy();
  });

  // Same contract the project rows hold: the dot repeats the tone and carries
  // no accessible name, so status is never colour-only nor announced twice.
  it("conveys scratch status as text rather than a labelled dot", () => {
    render(<ProjectSwitcherPalette {...browseProps({ blockedAgentCount: 1 })} />);

    expect(screen.getByText("1 blocked")).toBeTruthy();
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

      expect(screen.getByText("waiting 1m")).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(screen.getByText("waiting 2m")).toBeTruthy();
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

  it("does not read an open project's finished agents as a resume promise", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[
          makeProject({
            name: "Open elsewhere",
            status: "background",
            isBackground: true,
            completedAgentCount: 1,
            resumableAgentCount: 2,
          }),
        ]}
      />
    );

    // "Agent finished" is muted like the parked line, so gating the mark on
    // tone would light this row up — and its agents finished in a window that
    // is still open, not on disk waiting to be brought back.
    const row = screen.getByRole("option", { name: /Open elsewhere/i });
    expect(within(row).getByText(/1 finished/)).toBeTruthy();
    expect(within(row).getByTestId("workspace-status-dot")).toBeTruthy();
    expect(within(row).queryByTestId("workspace-resume-dot")).toBeNull();
    expect(screen.queryByRole("option", { name: /will resume/i })).toBeNull();
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

/**
 * The same mark on scratch rows (#11821). Scratches are dormant far more often
 * than projects are — they exist to be abandoned and come back to — so the row
 * that most needs "opening this brings your agents back" was the one that never
 * said it.
 *
 * Both surfaces are covered because they are genuinely separate renderers: the
 * ranked row in the search listbox, and the pinned browse section's own button.
 * A fix applied to one and not the other is the shape this bug already took.
 */
describe("ProjectSwitcherPalette scratch resumable-agent dot", () => {
  function scratchRow(
    overrides: Partial<ProjectSwitcherScratchRow> & { id: string; name: string }
  ): ProjectSwitcherScratchRow {
    return {
      kind: "scratch",
      path: `/userData/scratch/${overrides.id}`,
      createdAt: 0,
      // Long enough ago that the row falls back to dormant with nothing to say,
      // which is the only state the mark is allowed to occupy.
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

  /** The ranked list — a scratch among projects while searching. */
  function renderRanked(scratch: ProjectSwitcherScratchRow) {
    return render(
      <ProjectSwitcherPalette
        {...dropdownProps}
        query="spike"
        results={[scratch]}
        onCreateScratch={vi.fn()}
        onSelectScratch={vi.fn()}
      />
    );
  }

  /** The pinned browse section — its own button, its own markup. */
  function renderBrowse(scratch: ProjectSwitcherScratchRow) {
    return render(
      <ProjectSwitcherPalette
        {...dropdownProps}
        query=""
        results={[]}
        scratchResults={[scratch]}
        onCreateScratch={vi.fn()}
        onSelectScratch={vi.fn()}
      />
    );
  }

  describe.each([
    ["ranked search row", renderRanked],
    ["pinned browse row", renderBrowse],
  ])("%s", (_label, renderScratch) => {
    it("marks a quiet scratch that would bring agents back", () => {
      renderScratch(scratchRow({ id: "s1", name: "Spike notes", resumableAgentCount: 3 }));
      expect(screen.getByTestId("workspace-resume-dot")).toBeTruthy();
    });

    it("says the count rather than leaving it to the colour", () => {
      // Part of the row's own name — the ranked row's "· Scratch" origin hint
      // sits between the two, which is why this matches across it rather than
      // pinning the phrase directly to the name.
      renderScratch(scratchRow({ id: "s1", name: "Spike notes", resumableAgentCount: 3 }));
      expect(
        screen.getByRole("option", { name: /Spike notes.*3 agents will resume/i })
      ).toBeTruthy();
      expect(screen.getByTestId("workspace-resume-dot").getAttribute("aria-hidden")).toBe("true");
    });

    it("counts one agent in the singular", () => {
      renderScratch(scratchRow({ id: "s1", name: "Solo", resumableAgentCount: 1 }));
      expect(screen.getByRole("option", { name: /Solo.*1 agent will resume/i })).toBeTruthy();
      expect(screen.queryByRole("option", { name: /1 agents will resume/i })).toBeNull();
    });

    it("leaves a scratch that restores no agents unmarked and unannounced", () => {
      renderScratch(scratchRow({ id: "s1", name: "Spike notes", resumableAgentCount: 0 }));
      expect(screen.queryByTestId("workspace-resume-dot")).toBeNull();
      expect(screen.queryByRole("option", { name: /will resume/i })).toBeNull();
    });

    it("makes no claim for a scratch main has not counted yet", () => {
      // Absent is not zero, but it is equally not a promise.
      renderScratch(scratchRow({ id: "s1", name: "Spike notes" }));
      expect(screen.queryByTestId("workspace-resume-dot")).toBeNull();
      expect(screen.queryByRole("option", { name: /will resume/i })).toBeNull();
    });

    it("yields to a scratch that has a real status to report", () => {
      // One dot in the one-dot slot: what it is doing now outranks what it
      // would come back with.
      renderScratch(
        scratchRow({
          id: "s1",
          name: "Spike notes",
          waitingAgentCount: 1,
          resumableAgentCount: 2,
        })
      );
      expect(screen.getByTestId("workspace-status-dot")).toBeTruthy();
      expect(screen.queryByTestId("workspace-resume-dot")).toBeNull();
      // The phrase has to go with the dot. Suppressing only the dot would leave
      // a reader hearing a promise the row no longer shows.
      expect(screen.queryByRole("option", { name: /will resume/i })).toBeNull();
    });

    it("says nothing on the scratch you are already standing in", () => {
      // Its agents are on screen, not waiting to return — the row would
      // otherwise read ", current, 4 agents will resume".
      renderScratch(
        scratchRow({ id: "s1", name: "Spike notes", isActive: true, resumableAgentCount: 4 })
      );
      expect(screen.queryByTestId("workspace-resume-dot")).toBeNull();
      expect(screen.queryByRole("option", { name: /will resume/i })).toBeNull();
    });
  });

  it("marks only the scratches that carry a count", () => {
    render(
      <ProjectSwitcherPalette
        {...dropdownProps}
        query=""
        results={[]}
        scratchResults={[
          scratchRow({ id: "s1", name: "Marked", resumableAgentCount: 2 }),
          scratchRow({ id: "s2", name: "Unmarked", resumableAgentCount: 0 }),
        ]}
        onCreateScratch={vi.fn()}
      />
    );

    const marked = screen.getByRole("option", { name: /Marked/ });
    const unmarked = screen.getByRole("option", { name: /Unmarked/ });
    expect(marked.querySelector("[data-testid='workspace-resume-dot']")).toBeTruthy();
    expect(unmarked.querySelector("[data-testid='workspace-resume-dot']")).toBeNull();
  });
});

/**
 * Folding a band (#11943). The component is handed `results` and `browseBands`
 * separately — the hook filters the first and declares the second — so these
 * drive both by hand the way the real hosts do.
 */
describe("ProjectSwitcherPalette band collapse", () => {
  const banded = [
    makeProject({ id: "active", name: "Active Project", isActive: true, section: "current" }),
    makeProject({ id: "run-1", name: "Running One", section: "running" }),
    makeProject({ id: "other-1", name: "Other One", section: "other" }),
  ];

  function bandsFor(collapsedKeys: string[] = []): ProjectSwitcherBrowseBand[] {
    const bands: ProjectSwitcherBrowseBand[] = [
      { key: "current", label: "Current project", itemCount: 1, collapsed: false },
      { key: "running", label: "Running", itemCount: 1, collapsed: false },
      { key: "other", label: "Other projects", itemCount: 1, collapsed: false },
    ];
    return bands.map((band) => ({ ...band, collapsed: collapsedKeys.includes(band.key) }));
  }

  function toggleFor(key: string): HTMLElement {
    return screen.getByTestId(`band-collapse-toggle-${key}`);
  }

  function makeScratchRow(id: string, name: string): ProjectSwitcherScratchRow {
    return {
      kind: "scratch",
      id,
      name,
      path: `/userData/scratch/${id}`,
      createdAt: 0,
      lastOpened: 0,
      isActive: false,
      processCount: 0,
      activeAgentCount: 0,
      waitingAgentCount: 0,
      blockedAgentCount: 0,
      completedAgentCount: 0,
      unacknowledgedCompletedAgentCount: 0,
      snoozedAgentCount: 0,
    };
  }

  it("gives every band the affordance that used to be Scratch's alone", () => {
    render(<ProjectSwitcherPalette {...modalProps} results={banded} browseBands={bandsFor()} />);

    // Named by band rather than counted, so this still fails if the chevron
    // lands on some bands and not others.
    for (const key of ["current", "running", "other"]) {
      expect(toggleFor(key).getAttribute("aria-expanded")).toBe("true");
    }
  });

  it("points each toggle at the rows it actually controls", () => {
    render(<ProjectSwitcherPalette {...modalProps} results={banded} browseBands={bandsFor()} />);

    // Resolving to *something* is not enough — three toggles all naming the
    // same element would pass that. Each target has to hold its own band's row
    // and none of a neighbour's.
    const rowNames: Record<string, string> = {
      current: "Active Project",
      running: "Running One",
      other: "Other One",
    };
    for (const [key, ownRow] of Object.entries(rowNames)) {
      const controls = toggleFor(key).getAttribute("aria-controls");
      const target = controls ? document.getElementById(controls) : null;
      expect(target).toBeTruthy();
      const rendered = within(target!)
        .getAllByRole("option")
        .map((option) => option.textContent ?? "");
      expect(rendered).toHaveLength(1);
      expect(rendered[0]).toContain(ownRow);
    }
  });

  it("refuses the pointer focus that would take the keyboard off the search box", () => {
    render(<ProjectSwitcherPalette {...modalProps} results={banded} browseBands={bandsFor()} />);

    // `tabIndex={-1}` keeps the chevron out of the tab order but does not stop a
    // press from focusing it, and the header outlives the fold — so a click
    // would otherwise leave typing, arrow-stepping and Enter all pointed at a
    // chevron instead of the palette. `fireEvent` returns false when the
    // handler cancelled the event.
    expect(fireEvent.mouseDown(toggleFor("running"))).toBe(false);

    // The veto must not cost the click itself.
    fireEvent.click(toggleFor("running"));
    expect(usePreferencesStore.getState().projectSwitcherCollapsedBands).toEqual({
      running: true,
    });
  });

  it("keeps arrow-key order when a band's rows arrive in two separate runs", () => {
    // The map from key to run keeps only the last run, so honouring this
    // metadata would render the first `current` row nowhere while the arrow
    // keys could still reach it.
    const split = [
      makeProject({ id: "a", name: "First Current", section: "current" }),
      makeProject({ id: "b", name: "Middle Running", section: "running" }),
      makeProject({ id: "c", name: "Second Current", section: "current" }),
    ];
    render(
      <ProjectSwitcherPalette
        {...modalProps}
        results={split}
        browseBands={[
          { key: "current", label: "Current project", itemCount: 2, collapsed: false },
          { key: "running", label: "Running", itemCount: 1, collapsed: false },
        ]}
      />
    );

    const rendered = screen.getAllByRole("option").map((option) => option.textContent ?? "");
    expect(rendered).toHaveLength(3);
    expect(rendered[0]).toContain("First Current");
    expect(rendered[1]).toContain("Middle Running");
    expect(rendered[2]).toContain("Second Current");
  });

  it("keeps arrow-key order when the declared bands are ordered differently", () => {
    render(
      <ProjectSwitcherPalette
        {...modalProps}
        results={banded}
        browseBands={[
          { key: "other", label: "Other projects", itemCount: 1, collapsed: false },
          { key: "current", label: "Current project", itemCount: 1, collapsed: false },
          { key: "running", label: "Running", itemCount: 1, collapsed: false },
        ]}
      />
    );

    const rendered = screen.getAllByRole("option").map((option) => option.textContent ?? "");
    expect(rendered[0]).toContain("Active Project");
    expect(rendered[1]).toContain("Running One");
    expect(rendered[2]).toContain("Other One");
  });

  it("refuses a duplicated band key rather than colliding on its ids", () => {
    render(
      <ProjectSwitcherPalette
        {...modalProps}
        results={banded}
        browseBands={[
          { key: "current", label: "Current project", itemCount: 1, collapsed: false },
          { key: "current", label: "Current project", itemCount: 1, collapsed: false },
          { key: "running", label: "Running", itemCount: 1, collapsed: false },
          { key: "other", label: "Other projects", itemCount: 1, collapsed: false },
        ]}
      />
    );

    // One id per band or `aria-labelledby` and `aria-controls` both go
    // ambiguous, so the whole band layout stands down.
    expect(document.querySelectorAll("#project-section-current")).toHaveLength(0);
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("records the fold in the preference the palette reads back on reopen", () => {
    render(<ProjectSwitcherPalette {...modalProps} results={banded} browseBands={bandsFor()} />);

    fireEvent.click(toggleFor("running"));

    // The store, not local state: the point of the issue is that reopening the
    // palette finds the band the way the user left it.
    expect(usePreferencesStore.getState().projectSwitcherCollapsedBands).toEqual({
      running: true,
    });
  });

  it("unfolds a folded band on a second click rather than folding it harder", () => {
    render(
      <ProjectSwitcherPalette
        {...modalProps}
        results={banded.filter((p) => p.section !== "running")}
        browseBands={bandsFor(["running"])}
      />
    );

    expect(toggleFor("running").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggleFor("running"));

    expect(usePreferencesStore.getState().projectSwitcherCollapsedBands).toEqual({
      running: false,
    });
  });

  it("keeps a folded band's named group and header with none of its rows", () => {
    render(
      <ProjectSwitcherPalette
        {...modalProps}
        results={banded.filter((p) => p.section !== "running")}
        browseBands={bandsFor(["running"])}
      />
    );

    // The group has to survive: it is the only thing left to click to get the
    // rows back, and an unnamed or absent one strands them.
    const band = screen.getByRole("group", { name: "Running" });
    expect(within(band).queryAllByRole("option")).toHaveLength(0);
    expect(screen.queryByRole("option", { name: /Running One/ })).toBeNull();
    // Its neighbours are untouched.
    expect(screen.getByRole("option", { name: /Other One/ })).toBeTruthy();
  });

  it("says how much a folded band is holding, and stays quiet when it is open", () => {
    const { rerender } = render(
      <ProjectSwitcherPalette
        {...modalProps}
        results={banded.filter((p) => p.section !== "other")}
        browseBands={[
          { key: "current", label: "Current project", itemCount: 1, collapsed: false },
          { key: "running", label: "Running", itemCount: 1, collapsed: false },
          { key: "other", label: "Other projects", itemCount: 7, collapsed: true },
        ]}
      />
    );

    // Folded, the count is the only thing left that reports the band's size.
    expect(
      within(screen.getByRole("group", { name: "Other projects" })).getByText("7")
    ).toBeTruthy();

    rerender(<ProjectSwitcherPalette {...modalProps} results={banded} browseBands={bandsFor()} />);
    expect(
      within(screen.getByRole("group", { name: "Other projects" })).queryByText("7")
    ).toBeNull();
  });

  it("does not lend the chevron's label to the band's accessible name", () => {
    render(<ProjectSwitcherPalette {...modalProps} results={banded} browseBands={bandsFor()} />);

    // The `id` has to stay on a leaf holding only the label text, or the count
    // and the chevron would join the name the group announces.
    expect(screen.getByRole("group", { name: "Running" })).toBeTruthy();
  });

  it("shows the bands rather than the no-projects empty state when all of them fold", () => {
    render(
      <ProjectSwitcherPalette
        {...modalProps}
        results={[]}
        browseBands={bandsFor(["current", "running", "other"])}
      />
    );

    // "Add a project to get started" here would be a lie the user cannot argue
    // with — and it would take away the headers that are the only way back.
    expect(screen.queryByTestId("project-empty-state")).toBeNull();
    expect(screen.getByRole("group", { name: "Running" })).toBeTruthy();
    expect(toggleFor("other").getAttribute("aria-expanded")).toBe("false");
  });

  it("offers no fold control on a surface that declares no bands", () => {
    // Without declared bands the component reads them off `results`, where a
    // fold would have to drop rows the arrow keys can still reach. Better no
    // affordance than one that writes a preference nothing honours.
    render(<ProjectSwitcherPalette {...modalProps} results={banded} />);

    expect(screen.queryByTestId("band-collapse-toggle-running")).toBeNull();
    // The headers themselves still name their bands.
    expect(screen.getByRole("group", { name: "Running" })).toBeTruthy();
  });

  it("still names an empty project list when there are genuinely no projects", () => {
    render(<ProjectSwitcherPalette {...modalProps} results={[]} browseBands={[]} />);
    expect(screen.getByTestId("project-empty-state")).toBeTruthy();
  });

  it("renders a row the metadata claims is folded rather than hiding it", () => {
    // Contradictory props: `running` says folded while its row is still in
    // `results`. Honouring the metadata would strand that row — on screen
    // nowhere, yet still reachable by arrow keys and committable by Enter.
    render(
      <ProjectSwitcherPalette
        {...modalProps}
        results={banded}
        browseBands={bandsFor(["running"])}
      />
    );

    expect(screen.getByRole("option", { name: /Running One/ })).toBeTruthy();
  });

  it("keeps results in their arrow-key order when the metadata is incomplete", () => {
    render(
      <ProjectSwitcherPalette
        {...modalProps}
        results={banded}
        browseBands={[{ key: "current", label: "Current project", itemCount: 1, collapsed: false }]}
      />
    );

    // Reordering rows to match a partial band list would make Arrow Down jump
    // around the screen. Rendering flat keeps DOM order and key order equal.
    const rendered = screen.getAllByRole("option").map((option) => option.textContent ?? "");
    expect(rendered).toHaveLength(3);
    expect(rendered[0]).toContain("Active Project");
    expect(rendered[1]).toContain("Running One");
    expect(rendered[2]).toContain("Other One");
  });

  it("renders every result even if the declared bands do not account for it", () => {
    // Defensive: a row that renders nowhere is bug #11071 again — the highlight
    // would address it while nothing on screen carried it.
    render(
      <ProjectSwitcherPalette
        {...modalProps}
        results={banded}
        browseBands={[{ key: "current", label: "Current project", itemCount: 1, collapsed: false }]}
      />
    );

    expect(screen.getByRole("option", { name: /Running One/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Other One/ })).toBeTruthy();
  });

  it("keeps the Scratch fold across a full unmount, which local state never did", () => {
    const scratch = makeScratchRow("scratch-1", "Spike");
    const props = { ...modalProps, results: banded, scratchResults: [scratch] };

    const { unmount } = render(<ProjectSwitcherPalette {...props} />);
    const header = screen.getByRole("button", { name: /Scratch/ });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(header);

    // Closing the palette really does unmount it, which is exactly what used to
    // reseed the local `collapsed` from the scratch count.
    unmount();
    render(<ProjectSwitcherPalette {...props} />);

    expect(screen.getByRole("button", { name: /Scratch/ }).getAttribute("aria-expanded")).toBe(
      "false"
    );
  });

  it("holds an empty Scratch open once the user says so, against its own default", () => {
    // The default is "folded while empty", so an expand here is the case a
    // delete-on-default setter would silently undo.
    const props = { ...modalProps, results: banded, scratchResults: [], onCreateScratch: vi.fn() };

    const { unmount } = render(<ProjectSwitcherPalette {...props} />);
    const header = screen.getByRole("button", { name: /Scratch/ });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(header);

    unmount();
    render(<ProjectSwitcherPalette {...props} />);

    expect(screen.getByRole("button", { name: /Scratch/ }).getAttribute("aria-expanded")).toBe(
      "true"
    );
  });

  it("keeps Scratch folded through its first entry once the user has folded it", () => {
    // The mirror of the test below: the derived default replaced an effect that
    // forced the section open on 0 -> 1, and it must not do that over a fold the
    // user chose.
    const props = { ...modalProps, results: banded, onCreateScratch: vi.fn() };
    const { rerender } = render(<ProjectSwitcherPalette {...props} scratchResults={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Scratch/ }));
    fireEvent.click(screen.getByRole("button", { name: /Scratch/ }));
    expect(screen.getByRole("button", { name: /Scratch/ }).getAttribute("aria-expanded")).toBe(
      "false"
    );

    rerender(
      <ProjectSwitcherPalette {...props} scratchResults={[makeScratchRow("scratch-1", "Spike")]} />
    );

    expect(screen.getByRole("button", { name: /Scratch/ }).getAttribute("aria-expanded")).toBe(
      "false"
    );
  });

  it("opens Scratch on its first entry without a stored preference", () => {
    // The derived default replaces the effect that used to force this open, so
    // it has to keep tracking the count on its own.
    const scratch = makeScratchRow("scratch-1", "Spike");
    const { rerender } = render(
      <ProjectSwitcherPalette
        {...modalProps}
        results={banded}
        scratchResults={[]}
        onCreateScratch={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: /Scratch/ }).getAttribute("aria-expanded")).toBe(
      "false"
    );

    rerender(
      <ProjectSwitcherPalette
        {...modalProps}
        results={banded}
        scratchResults={[scratch]}
        onCreateScratch={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: /Scratch/ }).getAttribute("aria-expanded")).toBe(
      "true"
    );
  });
});
