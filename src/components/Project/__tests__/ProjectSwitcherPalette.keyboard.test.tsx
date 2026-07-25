/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
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
}));

const modifierKeysState = { meta: false, alt: false };
vi.mock("@/hooks/useModifierKeys", () => ({
  useModifierKeys: () => modifierKeysState,
}));

vi.mock("@/utils/timeAgo", () => ({
  formatTimeAgo: () => "2h ago",
}));

import type { SearchableProject } from "@/hooks/useProjectSwitcherPalette";

const { ProjectSwitcherPalette } = await import("../ProjectSwitcherPalette");

function makeProject(overrides: Partial<SearchableProject> = {}): SearchableProject {
  return {
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

  it("displays condensed footer with switch and right-click hints in modal mode", () => {
    render(<ProjectSwitcherPalette {...defaultProps} />);
    const footer = screen.getByTestId("palette-footer");
    expect(footer.textContent).toContain("Switch");
    expect(footer.textContent).not.toContain("Remove");
    expect(footer.textContent).toContain("Right-click for more");
  });

  it("Alt+Enter performs a normal switch and never triggers new-window", () => {
    const onSelectNewWindow = vi.fn();
    render(<ProjectSwitcherPalette {...defaultProps} onSelectNewWindow={onSelectNewWindow} />);
    const input = screen.getByTestId("palette-input");
    fireEvent.keyDown(input, { key: "Enter", altKey: true });
    expect(defaultProps.onSelect).toHaveBeenCalledTimes(1);
    expect(defaultProps.onSelect).toHaveBeenCalledWith(defaultProps.results[0]);
    expect(onSelectNewWindow).not.toHaveBeenCalled();
  });

  it("Meta+Enter still triggers the new-window shortcut", () => {
    const onSelectNewWindow = vi.fn();
    render(<ProjectSwitcherPalette {...defaultProps} onSelectNewWindow={onSelectNewWindow} />);
    const input = screen.getByTestId("palette-input");
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(onSelectNewWindow).toHaveBeenCalledTimes(1);
    expect(onSelectNewWindow).toHaveBeenCalledWith(defaultProps.results[0]);
    expect(defaultProps.onSelect).not.toHaveBeenCalled();
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

  it("Enter selects the project the active descendant points at", () => {
    const onSelect = vi.fn<(project: SearchableProject) => void>();
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
