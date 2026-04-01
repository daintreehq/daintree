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
}));

vi.mock("@/hooks", () => ({
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
  const Body = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="palette-body">{children}</div>
  );
  const Footer = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="palette-footer">{children}</div>
  );

  const Dialog = () => null;
  Dialog.Header = Header;
  Dialog.Input = Input;
  Dialog.Body = Body;
  Dialog.Footer = Footer;

  return { AppPaletteDialog: Dialog };
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

vi.mock("@/hooks/useModifierKeys", () => ({
  useModifierKeys: () => ({ meta: false, alt: false }),
}));

vi.mock("./ProjectActionRow", () => ({
  ProjectActionRow: () => null,
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
    onOpenProjectSettings: vi.fn(),
    onAddProject: vi.fn(),
    onCreateFolder: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not call onSelectNext when Tab is pressed on the input", () => {
    render(<ProjectSwitcherPalette {...defaultProps} />);
    const input = screen.getByTestId("palette-input");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(defaultProps.onSelectNext).not.toHaveBeenCalled();
  });

  it("does not call onSelectPrevious when Shift+Tab is pressed on the input", () => {
    render(<ProjectSwitcherPalette {...defaultProps} />);
    const input = screen.getByTestId("palette-input");
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(defaultProps.onSelectPrevious).not.toHaveBeenCalled();
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

  it("row action buttons have tabIndex={-1}", () => {
    render(
      <ProjectSwitcherPalette
        {...defaultProps}
        onTogglePinProject={vi.fn()}
        onCloseProject={vi.fn()}
        onStopProject={vi.fn()}
      />
    );
    const closeButtons = screen.getAllByLabelText("Close project");
    for (const btn of closeButtons) {
      expect(btn.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("Tab from last footer button wraps focus to the input (focus trap)", () => {
    render(<ProjectSwitcherPalette {...defaultProps} />);

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();

    const focusable = dialog!.querySelectorAll<HTMLElement>(
      'input, button, [tabindex]:not([tabindex="-1"])'
    );
    expect(focusable.length).toBeGreaterThanOrEqual(2);

    const lastEl = focusable[focusable.length - 1];
    lastEl.focus();
    expect(document.activeElement).toBe(lastEl);

    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(focusable[0]);
  });

  it("Shift+Tab from input wraps focus to last footer button (focus trap)", () => {
    render(<ProjectSwitcherPalette {...defaultProps} />);

    const dialog = document.querySelector('[role="dialog"]');
    const focusable = dialog!.querySelectorAll<HTMLElement>(
      'input, button, [tabindex]:not([tabindex="-1"])'
    );

    const firstEl = focusable[0];
    firstEl.focus();
    expect(document.activeElement).toBe(firstEl);

    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(focusable[focusable.length - 1]);
  });

  it("displays condensed footer with dynamic modifier hints", () => {
    render(<ProjectSwitcherPalette {...defaultProps} />);
    const footer = screen.getByTestId("palette-footer");
    expect(footer.textContent).toContain("Switch");
    expect(footer.textContent).toContain("Remove");
    expect(footer.textContent).toContain("Right-click for more");
  });
});
