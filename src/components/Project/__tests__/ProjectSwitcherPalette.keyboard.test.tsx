/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";

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
vi.mock("@/hooks/useOverlayState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useOverlayState")>()),
  useOverlayState: () => {},
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
  // Mirrors the real Body's focusable-region contract (role/label/active
  // descendant/handler) so the palette's wiring is observable here. Key
  // filtering itself is covered against the real component in
  // src/components/ui/__tests__/AppPaletteDialog.test.tsx.
  const Body = ({
    children,
    ariaLabel,
    activeDescendant,
    onNavigationKeyDown,
  }: {
    children: React.ReactNode;
    ariaLabel?: string;
    activeDescendant?: string;
    onNavigationKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  }) => (
    <div
      data-testid="palette-body"
      tabIndex={0}
      role="group"
      aria-label={ariaLabel}
      aria-activedescendant={activeDescendant}
      onKeyDown={onNavigationKeyDown}
    >
      {children}
    </div>
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
  Dialog.Empty = ({
    query,
    emptyMessage,
    noMatchMessage,
    noMatchContent,
  }: {
    query: string;
    emptyMessage?: string;
    noMatchMessage?: string;
    noMatchContent?: React.ReactNode;
  }) =>
    query.trim() ? (
      <div>
        <p>{noMatchMessage}</p>
        {noMatchContent}
      </div>
    ) : (
      <p>{emptyMessage}</p>
    );

  return {
    AppPaletteDialog: Dialog,
    PaletteNoMatchHint: () => <p>Press Esc to clear the search</p>,
    KBD_CLASS: "px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-border-default text-text-secondary",
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
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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

// Null leaves jsdom's own (non-Mac) platform in place.
const platformState = vi.hoisted(() => ({ mac: null as boolean | null }));
vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return { ...actual, isMac: () => platformState.mac ?? actual.isMac() };
});

const modifierKeysState = { meta: false, alt: false };
vi.mock("@/hooks/useModifierKeys", () => ({
  useModifierKeys: () => modifierKeysState,
}));

vi.mock("@/utils/timeAgo", () => ({
  formatTimeAgo: () => "2h ago",
}));

import type {
  ProjectSwitcherProjectRow,
  ProjectSwitcherRow,
  ProjectSwitcherScratchRow,
  SearchableProject,
} from "@/hooks/useProjectSwitcherPalette";

const {
  ProjectSwitcherPalette,
  canSleepProject,
  formatScratchCleanupCountdown,
  getNewWindowMenuLabel,
  getProjectSwitcherEnterHint,
} = await import("../ProjectSwitcherPalette");

function makeProject(overrides: Partial<SearchableProject> = {}): ProjectSwitcherProjectRow {
  return {
    kind: "project",
    id: "proj-1",
    name: "Test Project",
    path: "/tmp/test",
    emoji: "🚀",
    lastOpened: 0,
    status: "closed",
    isActive: false,
    isBackground: false,
    isMissing: false,
    isPinned: false,
    frecencyScore: 3.0,
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

describe("ProjectSwitcherPalette keyboard navigation", () => {
  const defaultProps = {
    isOpen: true,
    query: "",
    results: [
      makeProject({ id: "p1", name: "Project 1" }),
      makeProject({ id: "p2", name: "Project 2" }),
    ],
    selectedIndex: 0,
    onQueryChange: vi.fn(),
    onSelectPrevious: vi.fn(),
    onSelectNext: vi.fn(),
    onSelect: vi.fn(),
    onClose: vi.fn(),
    mode: "modal" as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    modifierKeysState.meta = false;
    modifierKeysState.alt = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Tab must keep its native traversal so the controls rendered after the
  // results list (the scratch section) stay keyboard-reachable. Remapping it
  // to selection movement is what commit e7028aeb6 removed.
  it("leaves Tab to native focus traversal instead of moving the selection", () => {
    render(<ProjectSwitcherPalette {...defaultProps} />);
    const input = screen.getByTestId("palette-input");
    const notCancelled = fireEvent.keyDown(input, { key: "Tab" });
    expect(defaultProps.onSelectNext).not.toHaveBeenCalled();
    expect(notCancelled).toBe(true);
  });

  it("leaves Shift+Tab to native focus traversal instead of moving the selection", () => {
    render(<ProjectSwitcherPalette {...defaultProps} />);
    const input = screen.getByTestId("palette-input");
    const notCancelled = fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(defaultProps.onSelectPrevious).not.toHaveBeenCalled();
    expect(notCancelled).toBe(true);
  });

  // #11431: Tab lands on the scrollable results region, so that region has to
  // keep driving the same navigation the input does.
  it("moves the selection when ArrowDown is pressed on the results region", () => {
    render(<ProjectSwitcherPalette {...defaultProps} />);
    fireEvent.keyDown(screen.getByTestId("palette-body"), { key: "ArrowDown" });
    expect(defaultProps.onSelectNext).toHaveBeenCalledTimes(1);
  });

  it("moves the selection when ArrowUp is pressed on the results region", () => {
    render(<ProjectSwitcherPalette {...defaultProps} />);
    fireEvent.keyDown(screen.getByTestId("palette-body"), { key: "ArrowUp" });
    expect(defaultProps.onSelectPrevious).toHaveBeenCalledTimes(1);
  });

  it("confirms the active project when Enter is pressed on the results region", () => {
    render(<ProjectSwitcherPalette {...defaultProps} />);
    fireEvent.keyDown(screen.getByTestId("palette-body"), { key: "Enter" });
    expect(defaultProps.onSelect).toHaveBeenCalledTimes(1);
  });

  it("keeps modifier shortcuts working from the results region", () => {
    // The region forwards the raw event, so Meta+Enter must still reach the
    // new-window branch rather than degrading to a plain switch.
    const onSelectNewWindow = vi.fn();
    render(<ProjectSwitcherPalette {...defaultProps} onSelectNewWindow={onSelectNewWindow} />);
    fireEvent.keyDown(screen.getByTestId("palette-body"), { key: "Enter", metaKey: true });

    expect(onSelectNewWindow).toHaveBeenCalledTimes(1);
    expect(onSelectNewWindow).toHaveBeenCalledWith(defaultProps.results[0]);
    expect(defaultProps.onSelect).not.toHaveBeenCalled();
  });

  it("closes the active project on Meta+Backspace from the results region", () => {
    const onCloseProject = vi.fn();
    render(<ProjectSwitcherPalette {...defaultProps} onCloseProject={onCloseProject} />);
    fireEvent.keyDown(screen.getByTestId("palette-body"), { key: "Backspace", metaKey: true });

    expect(onCloseProject).toHaveBeenCalledWith("p1");
  });

  it("mirrors the input's active descendant onto the results region", () => {
    render(<ProjectSwitcherPalette {...defaultProps} selectedIndex={1} />);
    const activeDescendant = screen
      .getByTestId("palette-input")
      .getAttribute("aria-activedescendant");

    expect(activeDescendant).toBe("project-option-p2");
    expect(screen.getByTestId("palette-body").getAttribute("aria-activedescendant")).toBe(
      activeDescendant
    );
    // The IDREF has to resolve to a real option, or the mirror announces nothing.
    expect(document.getElementById(activeDescendant!)).not.toBeNull();
  });

  it("still calls onSelectNext on ArrowDown", () => {
    render(<ProjectSwitcherPalette {...defaultProps} />);
    const input = screen.getByTestId("palette-input");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(defaultProps.onSelectNext).toHaveBeenCalledTimes(1);
  });

  it("still calls onSelectPrevious on ArrowUp", () => {
    render(<ProjectSwitcherPalette {...defaultProps} />);
    const input = screen.getByTestId("palette-input");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(defaultProps.onSelectPrevious).toHaveBeenCalledTimes(1);
  });

  it("no inline action buttons are rendered in list items", () => {
    render(
      <ProjectSwitcherPalette
        {...defaultProps}
        onTogglePinProject={vi.fn()}
        onCloseProject={vi.fn()}
        onStopProject={vi.fn()}
        onLocateProject={vi.fn()}
      />
    );
    expect(screen.queryByLabelText("Close project")).toBeNull();
    expect(screen.queryByLabelText("Stop project")).toBeNull();
    expect(screen.queryByLabelText("Locate project folder")).toBeNull();
    expect(screen.queryByLabelText("Remove project")).toBeNull();
  });

  it("Alt+Enter performs a normal switch and never triggers new-window", () => {
    const onSelectNewWindow = vi.fn();
    render(<ProjectSwitcherPalette {...defaultProps} onSelectNewWindow={onSelectNewWindow} />);
    const input = screen.getByTestId("palette-input");
    fireEvent.keyDown(input, { key: "Enter", altKey: true });
    expect(defaultProps.onSelect).toHaveBeenCalledTimes(1);
    expect(defaultProps.onSelect).toHaveBeenCalledWith(defaultProps.results[0], "keyboard");
    expect(onSelectNewWindow).not.toHaveBeenCalled();
  });

  it("footer never shows a background hint when Alt is held (modal mode)", () => {
    modifierKeysState.alt = true;
    render(<ProjectSwitcherPalette {...defaultProps} />);
    const footer = screen.getByTestId("palette-footer");
    expect(footer.textContent).not.toContain("Background");
    expect(footer.textContent).not.toContain("⌥↵");
    expect(footer.textContent).toContain("Switch");
  });

  it("footer never shows a background hint when Alt is held (dropdown mode)", () => {
    modifierKeysState.alt = true;
    render(<ProjectSwitcherPalette {...defaultProps} mode="dropdown" />);
    const footer = screen.getByTestId("palette-footer");
    expect(footer.textContent).not.toContain("Background");
    expect(footer.textContent).not.toContain("⌥↵");
    expect(footer.textContent).toContain("Switch");
  });

  it("closes on Escape in modal mode, where the input owns the key", () => {
    const onClose = vi.fn();
    render(<ProjectSwitcherPalette {...defaultProps} onClose={onClose} />);

    fireEvent.keyDown(screen.getByTestId("palette-input"), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves Escape to the anchored shell in dropdown mode", () => {
    // The shell spends the first press clearing the query and vetoes Radix's
    // capture-phase dismissal. This handler runs on bubble, afterwards — closing
    // here would shut the palette on a press meant to filter it.
    const onClose = vi.fn();
    render(<ProjectSwitcherPalette {...defaultProps} mode="dropdown" onClose={onClose} />);

    fireEvent.keyDown(screen.getByTestId("palette-input"), { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
  });
});

// #11071: the palette used to render a narrower list than the one selectedIndex
// walked, so arrowing onto a row the modal had filtered out left
// aria-activedescendant pointing at an id with no DOM node — no highlight, and
// Enter committed an off-screen project. `results` is now the single array the
// hook scopes, renders, and indexes.
describe("ProjectSwitcherPalette active descendant", () => {
  // Deliberately mixed: under the old component-side filter, "closed" would be
  // dropped from the DOM while still occupying index 1 of `results`.
  const mixedResults = [
    makeProject({ id: "active", name: "Active", isActive: true }),
    makeProject({ id: "closed", name: "Closed" }),
    makeProject({ id: "background", name: "Background", isBackground: true }),
  ];

  const mixedProps = {
    isOpen: true,
    query: "",
    results: mixedResults,
    selectedIndex: 0,
    onQueryChange: vi.fn(),
    onSelectPrevious: vi.fn(),
    onSelectNext: vi.fn(),
    onSelect: vi.fn(),
    onClose: vi.fn(),
    mode: "modal" as const,
  };

  it.each(mixedResults.map((project, index) => [index, project.name] as const))(
    "resolves aria-activedescendant to the selected option at index %i",
    (selectedIndex, expectedName) => {
      render(<ProjectSwitcherPalette {...mixedProps} selectedIndex={selectedIndex} />);

      const input = screen.getByTestId("palette-input");
      const activeDescendantId = input.getAttribute("aria-activedescendant");
      expect(activeDescendantId).toBeTruthy();

      // The id must resolve to a real option — under the old two-array split it
      // named a row that had been filtered out of the DOM.
      const activeOption = document.getElementById(activeDescendantId!);
      expect(activeOption).not.toBeNull();
      expect(activeOption!.getAttribute("role")).toBe("option");
      expect(activeOption!.getAttribute("aria-selected")).toBe("true");
      expect(activeOption!.textContent).toContain(expectedName);
    }
  );

  it("marks exactly one option selected for every index", () => {
    for (const [index] of mixedResults.entries()) {
      const { unmount } = render(<ProjectSwitcherPalette {...mixedProps} selectedIndex={index} />);
      const selected = screen
        .getAllByRole("option")
        .filter((option) => option.getAttribute("aria-selected") === "true");
      expect(selected).toHaveLength(1);
      unmount();
    }
  });

  it("Home/End jump to the first and last row, and Shift+End stays with the field", () => {
    function Stateful() {
      const [selectedIndex, setSelectedIndex] = useState(1);
      return (
        <ProjectSwitcherPalette
          {...mixedProps}
          selectedIndex={selectedIndex}
          onHoverRow={(id: string) => setSelectedIndex(mixedResults.findIndex((r) => r.id === id))}
        />
      );
    }
    render(<Stateful />);
    const input = screen.getByTestId("palette-input");
    const active = () => input.getAttribute("aria-activedescendant");

    expect(fireEvent.keyDown(input, { key: "End" })).toBe(false);
    expect(active()).toBe("project-option-background");
    expect(fireEvent.keyDown(input, { key: "Home" })).toBe(false);
    expect(active()).toBe("project-option-active");

    expect(fireEvent.keyDown(input, { key: "End", shiftKey: true })).toBe(true);
    expect(active()).toBe("project-option-active");
  });

  it("Enter selects the project the active descendant points at", () => {
    const onSelect = vi.fn<(row: ProjectSwitcherRow) => void>();
    render(<ProjectSwitcherPalette {...mixedProps} selectedIndex={1} onSelect={onSelect} />);

    const input = screen.getByTestId("palette-input");
    const activeOption = document.getElementById(input.getAttribute("aria-activedescendant")!);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledTimes(1);
    const selectedProject = onSelect.mock.calls[0]![0];
    // Enter must commit the row the user can actually see highlighted. Old code
    // pointed ARIA and Enter at the same *hidden* project — consistently wrong —
    // so this only holds if the highlighted option is really in the DOM.
    expect(activeOption).not.toBeNull();
    expect(activeOption!.textContent).toContain(selectedProject.name);
  });
});

/**
 * Keyboard behaviour on a highlighted scratch row (issue #11466).
 *
 * A scratch reached the arrow-key domain, so the two project-only chords have to
 * stop assuming every row they land on is a project.
 */
describe("ProjectSwitcherPalette keyboard on a scratch row", () => {
  const scratchRow: ProjectSwitcherScratchRow = {
    kind: "scratch",
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

  const scratchProps = {
    isOpen: true,
    query: "spike",
    results: [scratchRow],
    selectedIndex: 0,
    onQueryChange: vi.fn(),
    onSelectPrevious: vi.fn(),
    onSelectNext: vi.fn(),
    onSelect: vi.fn(),
    onClose: vi.fn(),
    mode: "modal" as const,
  };

  beforeEach(() => {
    scratchProps.onSelect.mockClear();
  });

  it("commits the scratch on Enter", () => {
    render(<ProjectSwitcherPalette {...scratchProps} />);
    fireEvent.keyDown(screen.getByTestId("palette-input"), { key: "Enter" });

    expect(scratchProps.onSelect).toHaveBeenCalledWith(scratchRow, "keyboard");
  });

  it("falls back to a plain switch on Meta+Enter instead of swallowing it", () => {
    // A scratch has no second window to open, so the chord must not become a
    // keypress that does nothing.
    const onSelectNewWindow = vi.fn();
    render(<ProjectSwitcherPalette {...scratchProps} onSelectNewWindow={onSelectNewWindow} />);
    fireEvent.keyDown(screen.getByTestId("palette-input"), { key: "Enter", metaKey: true });

    expect(onSelectNewWindow).not.toHaveBeenCalled();
    expect(scratchProps.onSelect).toHaveBeenCalledWith(scratchRow, "keyboard");
  });

  it("leaves Meta+Backspace inert rather than removing by scratch id", () => {
    // onCloseProject removes a PROJECT. Handing it a scratch id would delete
    // the wrong thing, and scratch deletion has no confirm to catch it.
    const onCloseProject = vi.fn();
    render(<ProjectSwitcherPalette {...scratchProps} onCloseProject={onCloseProject} />);
    fireEvent.keyDown(screen.getByTestId("palette-input"), { key: "Backspace", metaKey: true });

    expect(onCloseProject).not.toHaveBeenCalled();
  });
});

describe("ProjectSwitcherPalette with a project open in another window (#12597)", () => {
  const baseProps = {
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

  beforeEach(() => {
    vi.clearAllMocks();
    modifierKeysState.meta = false;
    modifierKeysState.alt = false;
  });

  it("says Go to window instead of Switch for the highlighted row", () => {
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[makeProject({ openInOtherWindow: "foreground" })]}
        onSelectNewWindow={vi.fn()}
      />
    );

    const footer = screen.getByTestId("palette-footer");
    expect(footer.textContent).toContain("Go to window");
    expect(footer.textContent).not.toContain("Switch");
  });

  it("says Go to window, not New window, while ⌘ is held", () => {
    modifierKeysState.meta = true;
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[makeProject({ openInOtherWindow: "foreground" })]}
        onSelectNewWindow={vi.fn()}
      />
    );

    const footer = screen.getByTestId("palette-footer");
    // jsdom reports no Mac platform, so the modifier is the one Windows and
    // Linux press — never a literal ⌘.
    expect(footer.textContent).toContain("Ctrl+↵");
    expect(footer.textContent).not.toContain("⌘");
    expect(footer.textContent).toContain("Go to window");
    expect(footer.textContent).not.toContain("New window");
  });

  it("says Switch, not New window, for a project this window already holds", () => {
    modifierKeysState.meta = true;
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[makeProject({ isOpenInThisWindow: true })]}
        onSelectNewWindow={vi.fn()}
      />
    );

    const footer = screen.getByTestId("palette-footer");
    expect(footer.textContent).toContain("Switch");
    expect(footer.textContent).not.toContain("New window");
  });

  it("says New window, and opens one, for a project this window only keeps cached (#13274)", () => {
    modifierKeysState.meta = true;
    const onSelectNewWindow = vi.fn();
    const row = makeProject({ isOpenInThisWindow: true, isCachedInThisWindow: true });
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[row]}
        onSelectNewWindow={onSelectNewWindow}
      />
    );

    expect(screen.getByTestId("palette-footer").textContent).toContain("New window");
    fireEvent.keyDown(screen.getByTestId("palette-input"), { key: "Enter", metaKey: true });
    expect(onSelectNewWindow).toHaveBeenCalledWith(row);
  });

  it("says New window, and opens one, for a project another window only keeps cached", () => {
    modifierKeysState.meta = true;
    const onSelectNewWindow = vi.fn();
    const row = makeProject({ openInOtherWindow: "cached" });
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[row]}
        onSelectNewWindow={onSelectNewWindow}
      />
    );

    expect(screen.getByTestId("palette-footer").textContent).toContain("New window");
    fireEvent.keyDown(screen.getByTestId("palette-input"), { key: "Enter", metaKey: true });
    expect(onSelectNewWindow).toHaveBeenCalledWith(row);
  });

  it("no longer promises a new window where ⌘↵ can't open one", () => {
    // No new-window handler: ⌘↵ is a plain switch, so the hint says that.
    modifierKeysState.meta = true;
    render(<ProjectSwitcherPalette {...baseProps} results={[makeProject()]} />);

    expect(screen.getByTestId("palette-footer").textContent).not.toContain("New window");
  });

  it("leaves routing to main: the keys dispatch exactly as before", () => {
    // Presence is advisory. Main re-checks ownership when the pick runs, so the
    // palette must not reroute on what it last heard.
    const onSelectNewWindow = vi.fn();
    const row = makeProject({ openInOtherWindow: "foreground" });
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[row]}
        onSelectNewWindow={onSelectNewWindow}
      />
    );
    const input = screen.getByTestId("palette-input");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(baseProps.onSelect).toHaveBeenCalledWith(row, "keyboard");
    expect(onSelectNewWindow).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(onSelectNewWindow).toHaveBeenCalledWith(row);
  });
});

describe("ProjectSwitcherPalette pointer cursor", () => {
  const baseProps = {
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

  it("moves the one cursor to the row under the pointer rather than lighting a second row", () => {
    const onHoverRow = vi.fn();
    const onHoverProject = vi.fn();
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        results={[makeProject({ id: "p1", name: "one" }), makeProject({ id: "p2", name: "two" })]}
        onHoverRow={onHoverRow}
        onHoverProject={onHoverProject}
      />
    );

    const second = document.getElementById("project-option-p2")!;
    fireEvent.pointerMove(second);
    expect(onHoverRow).toHaveBeenCalledWith("p2");

    // The row already holding the cursor has nothing to move.
    onHoverRow.mockClear();
    fireEvent.pointerMove(document.getElementById("project-option-p1")!);
    expect(onHoverRow).not.toHaveBeenCalled();

    for (const id of ["p1", "p2"]) {
      const row = document.getElementById(`project-option-${id}`)!;
      expect(row.className.split(/\s+/).filter((t) => t.startsWith("hover:bg-"))).toEqual([]);
    }
  });

  // jsdom reports no Mac platform, so the new-window click is Ctrl, not ⌘.
  it("opens a new window on a modified click, as ⌘↵ does (#13523)", () => {
    const onSelect = vi.fn();
    const onSelectNewWindow = vi.fn();
    const row = makeProject({ id: "p1" });
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        onSelect={onSelect}
        results={[row]}
        onSelectNewWindow={onSelectNewWindow}
      />
    );

    fireEvent.click(document.getElementById("project-option-p1")!, { ctrlKey: true });
    expect(onSelectNewWindow).toHaveBeenCalledWith(row);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("takes ⌘ rather than Ctrl as the new-window click on macOS", () => {
    platformState.mac = true;
    try {
      const onSelect = vi.fn();
      const onSelectNewWindow = vi.fn();
      const row = makeProject({ id: "p1" });
      render(
        <ProjectSwitcherPalette
          {...baseProps}
          onSelect={onSelect}
          results={[row]}
          onSelectNewWindow={onSelectNewWindow}
        />
      );
      const option = document.getElementById("project-option-p1")!;

      fireEvent.click(option, { metaKey: true });
      expect(onSelectNewWindow).toHaveBeenCalledWith(row);
      expect(onSelect).not.toHaveBeenCalled();

      onSelectNewWindow.mockClear();
      fireEvent.click(option, { ctrlKey: true });
      expect(onSelect).toHaveBeenCalledWith(row, "pointer");
      expect(onSelectNewWindow).not.toHaveBeenCalled();
    } finally {
      platformState.mac = null;
    }
  });

  it("keeps a plain click a plain pick", () => {
    const onSelect = vi.fn();
    const onSelectNewWindow = vi.fn();
    const row = makeProject({ id: "p1" });
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        onSelect={onSelect}
        results={[row]}
        onSelectNewWindow={onSelectNewWindow}
      />
    );

    fireEvent.click(document.getElementById("project-option-p1")!);
    expect(onSelect).toHaveBeenCalledWith(row, "pointer");
    expect(onSelectNewWindow).not.toHaveBeenCalled();
  });

  it("ignores the other platform's modifier", () => {
    const onSelect = vi.fn();
    const onSelectNewWindow = vi.fn();
    const row = makeProject({ id: "p1" });
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        onSelect={onSelect}
        results={[row]}
        onSelectNewWindow={onSelectNewWindow}
      />
    );

    fireEvent.click(document.getElementById("project-option-p1")!, { metaKey: true });
    expect(onSelect).toHaveBeenCalledWith(row, "pointer");
    expect(onSelectNewWindow).not.toHaveBeenCalled();
  });

  it.each([
    ["the current project", { isActive: true }],
    ["a missing project", { isMissing: true }],
  ])("falls back to a plain pick for %s, as ⌘↵ does", (_label, overrides) => {
    const onSelect = vi.fn();
    const onSelectNewWindow = vi.fn();
    const row = makeProject({ id: "p1", ...overrides });
    render(
      <ProjectSwitcherPalette
        {...baseProps}
        onSelect={onSelect}
        results={[row]}
        onSelectNewWindow={onSelectNewWindow}
      />
    );

    fireEvent.click(document.getElementById("project-option-p1")!, { ctrlKey: true });
    expect(onSelect).toHaveBeenCalledWith(row, "pointer");
    expect(onSelectNewWindow).not.toHaveBeenCalled();
  });

  it("falls back to a plain pick where no new window can open", () => {
    const onSelect = vi.fn();
    const row = makeProject({ id: "p1" });
    render(<ProjectSwitcherPalette {...baseProps} onSelect={onSelect} results={[row]} />);

    fireEvent.click(document.getElementById("project-option-p1")!, { ctrlKey: true });
    expect(onSelect).toHaveBeenCalledWith(row, "pointer");
  });
});

describe("ProjectSwitcherPalette current workspace mark", () => {
  it("labels the workspace you are in, apart from the cursor fill", () => {
    render(
      <ProjectSwitcherPalette
        isOpen
        query="pro"
        selectedIndex={1}
        onQueryChange={vi.fn()}
        onSelectPrevious={vi.fn()}
        onSelectNext={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        mode="modal"
        rankedSearch
        results={[
          makeProject({ id: "here", name: "project here", isActive: true }),
          makeProject({ id: "there", name: "project there" }),
        ]}
      />
    );

    const here = document.getElementById("project-option-here")!;
    const there = document.getElementById("project-option-there")!;
    expect(here.textContent).toContain("Current");
    expect(there.textContent).not.toContain("Current");
    // A check read as "done" among agent status; the switcher says it in words.
    expect(here.querySelector("svg.lucide-check")).toBeNull();
    // The cursor is on the other row; the label is not the cursor.
    expect(there.getAttribute("aria-selected")).toBe("true");
    expect(here.getAttribute("aria-selected")).toBe("false");
  });
});

function projectRow(overrides: Partial<ProjectSwitcherProjectRow> = {}): ProjectSwitcherProjectRow {
  return {
    kind: "project",
    id: "p1",
    name: "Project",
    path: "/repo/p1",
    emoji: "🌲",
    lastOpened: 0,
    frecencyScore: 3,
    status: "background",
    isActive: false,
    isBackground: true,
    isMissing: false,
    isPinned: false,
    processCount: 0,
    activeAgentCount: 0,
    waitingAgentCount: 0,
    blockedAgentCount: 0,
    completedAgentCount: 0,
    unacknowledgedCompletedAgentCount: 0,
    snoozedAgentCount: 0,
    displayPath: "p1",
    section: "other",
    ...overrides,
  };
}

const presenceScratchRow: ProjectSwitcherScratchRow = {
  kind: "scratch",
  id: "s1",
  name: "Scratch",
  path: "/scratch/s1",
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

describe("getNewWindowMenuLabel (#12597)", () => {
  it("offers a new window for a project nobody holds", () => {
    expect(getNewWindowMenuLabel(projectRow())).toBe("Open in new window");
  });

  it("says where the item goes for a project another window shows or is activating", () => {
    // Under #12596 a new-window request for it brings the owner forward.
    for (const state of ["foreground", "activating"] as const) {
      expect(getNewWindowMenuLabel(projectRow({ openInOtherWindow: state }))).toBe("Go to window");
    }
  });

  it("offers a new window for a project another window only keeps cached (#13274)", () => {
    expect(getNewWindowMenuLabel(projectRow({ openInOtherWindow: "cached" }))).toBe(
      "Open in new window"
    );
  });

  it("offers nothing for a project this window is activating, whatever another window caches", () => {
    expect(
      getNewWindowMenuLabel(projectRow({ isOpenInThisWindow: true, openInOtherWindow: "cached" }))
    ).toBeNull();
    const row = projectRow({ isOpenInThisWindow: true, openInOtherWindow: "cached" });
    expect(getProjectSwitcherEnterHint(row, true, true, true)).toEqual({
      keys: "↵",
      label: "Switch",
    });
    expect(getProjectSwitcherEnterHint(row, false, true)).toEqual({ keys: "↵", label: "Switch" });
  });

  it("offers nothing for a project this window shows or is activating", () => {
    // The request would switch here — which clicking the row already does.
    expect(getNewWindowMenuLabel(projectRow({ isOpenInThisWindow: true }))).toBeNull();
  });

  it("offers a new window for a project this window only keeps cached (#13274)", () => {
    expect(
      getNewWindowMenuLabel(projectRow({ isOpenInThisWindow: true, isCachedInThisWindow: true }))
    ).toBe("Open in new window");
  });

  it("keeps the current and missing rows' existing guards", () => {
    expect(getNewWindowMenuLabel(projectRow({ isActive: true }))).toBeNull();
    expect(getNewWindowMenuLabel(projectRow({ isMissing: true }))).toBeNull();
    expect(
      getNewWindowMenuLabel(projectRow({ isMissing: true, openInOtherWindow: "foreground" }))
    ).toBeNull();
  });
});

describe("getProjectSwitcherEnterHint (#12597)", () => {
  it("names nothing with nothing highlighted", () => {
    expect(getProjectSwitcherEnterHint(undefined, false, true)).toBeNull();
    expect(getProjectSwitcherEnterHint(undefined, true, true)).toBeNull();
  });

  it("keeps Switch and New window for a project nobody holds", () => {
    expect(getProjectSwitcherEnterHint(projectRow(), false, true)).toEqual({
      keys: "↵",
      label: "Switch",
    });
    expect(getProjectSwitcherEnterHint(projectRow(), true, true, true)).toEqual({
      keys: "⌘↵",
      label: "New window",
    });
  });

  it("names the modifier each platform actually has", () => {
    const row = projectRow();
    expect(getProjectSwitcherEnterHint(row, true, true, true)?.keys).toBe("⌘↵");
    const other = getProjectSwitcherEnterHint(row, true, true, false)?.keys;
    expect(other).toBe("Ctrl+↵");
    expect(other).not.toContain("⌘");
    const elsewhere = projectRow({ openInOtherWindow: "cached" });
    expect(getProjectSwitcherEnterHint(elsewhere, true, true, false)?.keys).not.toContain("⌘");
  });

  it("says Go to window on either key for a project another window shows", () => {
    const row = projectRow({ openInOtherWindow: "foreground" });
    expect(getProjectSwitcherEnterHint(row, false, true)).toEqual({
      keys: "↵",
      label: "Go to window",
    });
    expect(getProjectSwitcherEnterHint(row, true, true, true)).toEqual({
      keys: "⌘↵",
      label: "Go to window",
    });
  });

  it("switches here to a project another window only keeps cached, or takes it to a new one (#13291)", () => {
    const row = projectRow({ openInOtherWindow: "cached" });
    expect(getProjectSwitcherEnterHint(row, false, true)).toEqual({
      keys: "↵",
      label: "Switch",
    });
    expect(getProjectSwitcherEnterHint(row, true, true, true)).toEqual({
      keys: "⌘↵",
      label: "New window",
    });
  });

  it("says Switch on either key for a project this window shows or is activating", () => {
    const row = projectRow({ isOpenInThisWindow: true });
    expect(getProjectSwitcherEnterHint(row, true, true)).toEqual({ keys: "↵", label: "Switch" });
  });

  it("switches here, or takes it to a new window, for a project this window keeps cached", () => {
    const row = projectRow({ isOpenInThisWindow: true, isCachedInThisWindow: true });
    expect(getProjectSwitcherEnterHint(row, false, true)).toEqual({ keys: "↵", label: "Switch" });
    expect(getProjectSwitcherEnterHint(row, true, true, true)).toEqual({
      keys: "⌘↵",
      label: "New window",
    });
  });

  it("never promises a new window the keypress can't open", () => {
    // Each of these falls through to the plain switch in the keyboard handler.
    expect(getProjectSwitcherEnterHint(projectRow(), true, false)).toEqual({
      keys: "↵",
      label: "Switch",
    });
    expect(getProjectSwitcherEnterHint(projectRow({ isActive: true }), true, true)).toEqual({
      keys: "↵",
      label: "Switch",
    });
    // A missing project's Enter opens the relocation dialog, and says so.
    expect(getProjectSwitcherEnterHint(projectRow({ isMissing: true }), true, true)).toEqual({
      keys: "↵",
      label: "Locate",
    });
    expect(getProjectSwitcherEnterHint(presenceScratchRow, true, true)).toEqual({
      keys: "↵",
      label: "Switch",
    });
  });

  it("never marks the current row as elsewhere, whatever presence says", () => {
    const row = projectRow({ isActive: true, openInOtherWindow: "foreground" });
    expect(getProjectSwitcherEnterHint(row, false, true)).toEqual({ keys: "↵", label: "Switch" });
  });

  it("keeps ↵ for an owned row when there is no new-window handler", () => {
    const row = projectRow({ openInOtherWindow: "foreground" });
    expect(getProjectSwitcherEnterHint(row, true, false)).toEqual({
      keys: "↵",
      label: "Go to window",
    });
  });
});

describe("canSleepProject", () => {
  it("offers Sleep for the project on screen", () => {
    // The point of #11802: "Free memory", which this replaces, hid itself for
    // the active project, leaving the one you're looking at with no way to shut
    // down short of destroying its layout.
    expect(canSleepProject({ isMissing: false, status: "active" })).toBe(true);
  });

  it("hides Sleep for a project that is already asleep", () => {
    // Better than the silent no-op the old action gave a closed project.
    expect(canSleepProject({ isMissing: false, status: "closed" })).toBe(false);
  });

  it("hides Sleep for a missing project", () => {
    // Nothing is loaded to shut down, whatever its last-known status was.
    expect(canSleepProject({ isMissing: true, status: "background" })).toBe(false);
    expect(canSleepProject({ isMissing: true, status: "active" })).toBe(false);
  });

  it("offers Sleep when the status is unknown", () => {
    // A row with no status is not proof the project is shut, and refusing on
    // that basis would silently strip the action off a live project.
    expect(canSleepProject({ isMissing: false })).toBe(true);
  });
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
const TTL_DAYS = 30;

describe("formatScratchCleanupCountdown", () => {
  it("returns null for fresh scratches outside the visibility window", () => {
    // 25 days left -> outside the 7-day window
    const lastOpened = NOW - 5 * DAY;
    expect(formatScratchCleanupCountdown(lastOpened, NOW)).toBeNull();
  });

  it("renders 'in N days' inside the visibility window", () => {
    // 5 days left
    const lastOpened = NOW - (TTL_DAYS - 5) * DAY;
    expect(formatScratchCleanupCountdown(lastOpened, NOW)).toBe("Auto-cleanup in 5 days");
  });

  it("renders 'tomorrow' when 1 day left", () => {
    const lastOpened = NOW - (TTL_DAYS - 1) * DAY;
    expect(formatScratchCleanupCountdown(lastOpened, NOW)).toBe("Auto-cleanup tomorrow");
  });

  it("renders 'today' when 0 days left", () => {
    const lastOpened = NOW - TTL_DAYS * DAY;
    expect(formatScratchCleanupCountdown(lastOpened, NOW)).toBe("Auto-cleanup today");
  });

  it("clamps negative remaining time to 'today'", () => {
    const lastOpened = NOW - (TTL_DAYS + 5) * DAY;
    expect(formatScratchCleanupCountdown(lastOpened, NOW)).toBe("Auto-cleanup today");
  });

  it("returns null for falsy lastOpened (defensive against bad data)", () => {
    expect(formatScratchCleanupCountdown(0, NOW)).toBeNull();
  });
});
