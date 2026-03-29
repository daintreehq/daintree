// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PanelHeader } from "../PanelHeader";
import type { PanelHeaderProps } from "../PanelHeader";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});

const mockScrollLeft = vi.fn();
const mockScrollRight = vi.fn();
let mockScrollControls = {
  isOverflowing: false,
  canScrollLeft: false,
  canScrollRight: false,
  scrollLeft: mockScrollLeft,
  scrollRight: mockScrollRight,
};

vi.mock("@/hooks", () => ({
  useBackgroundPanelStats: () => ({ activeCount: 0, workingCount: 0 }),
  useHorizontalScrollControls: () => mockScrollControls,
  useKeybindingDisplay: () => "",
}));

vi.mock("@/components/DragDrop/DragHandleContext", () => ({
  useDragHandle: () => null,
}));

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: (...args: unknown[]) => unknown) => fn,
}));

const mockWatchPanel = vi.fn();
const mockUnwatchPanel = vi.fn();

let mockStoreState: Record<string, unknown> = {
  watchedPanels: new Set<string>(),
  watchPanel: mockWatchPanel,
  unwatchPanel: mockUnwatchPanel,
  terminals: [] as unknown[],
};

vi.mock("@/store/terminalStore", () => ({
  useTerminalStore: (selector: (s: Record<string, unknown>) => unknown) => selector(mockStoreState),
}));

let mockHasPty = false;

vi.mock("@shared/config/panelKindRegistry", () => ({
  panelKindCanRestart: () => false,
  panelKindHasPty: () => mockHasPty,
}));

const mockDispatch = vi.fn().mockResolvedValue({ ok: true });

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => mockDispatch(...args) },
}));

vi.mock("@/lib/watchNotification", () => ({
  fireWatchNotification: vi.fn(),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => <div data-tooltip-open={open}>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  ),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({
    children,
  }: {
    children: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="overflow-menu">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    destructive,
    ...rest
  }: {
    children: React.ReactNode;
    onSelect?: (e: Event) => void;
    destructive?: boolean;
    [key: string]: unknown;
  }) => (
    <button
      data-destructive={destructive || undefined}
      {...rest}
      onClick={() => onSelect?.(new Event("select"))}
    >
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
}));

function makeProps(overrides: Partial<PanelHeaderProps> = {}): PanelHeaderProps {
  return {
    id: "test-panel",
    title: "Test Panel",
    kind: "terminal",
    isFocused: true,
    isEditingTitle: false,
    editingValue: "",
    titleInputRef: { current: null },
    onEditingValueChange: vi.fn(),
    onTitleDoubleClick: vi.fn(),
    onTitleKeyDown: vi.fn(),
    onTitleInputKeyDown: vi.fn(),
    onTitleSave: vi.fn(),
    onClose: vi.fn(),
    onFocus: vi.fn(),
    ...overrides,
  };
}

describe("PanelHeader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasPty = false;
    mockScrollControls = {
      isOverflowing: false,
      canScrollLeft: false,
      canScrollRight: false,
      scrollLeft: mockScrollLeft,
      scrollRight: mockScrollRight,
    };
    mockStoreState = {
      watchedPanels: new Set<string>(),
      watchPanel: mockWatchPanel,
      unwatchPanel: mockUnwatchPanel,
      terminals: [],
    };
  });

  describe("overflow menu tooltip", () => {
    it("renders 'More panel actions' tooltip on the overflow button", () => {
      render(<PanelHeader {...makeProps({ headerActions: <div>custom</div> })} />);
      const btn = screen.getByLabelText("More panel actions");
      expect(btn).toBeDefined();
      const tooltips = screen.getAllByTestId("tooltip-content");
      const overflowTooltip = tooltips.find((el) => el.textContent === "More panel actions");
      expect(overflowTooltip).toBeDefined();
    });
  });

  describe("overflow menu items", () => {
    const findMenuButton = (menu: HTMLElement, label: string) =>
      Array.from(menu.querySelectorAll("button")).find((btn) => btn.textContent?.trim() === label);

    it("always renders the overflow button (Rename/Duplicate/Trash always available)", () => {
      render(<PanelHeader {...makeProps()} />);
      expect(screen.getByLabelText("More panel actions")).toBeDefined();
    });

    it("renders Rename and Duplicate for all panel kinds", () => {
      render(<PanelHeader {...makeProps({ kind: "browser" })} />);
      const menu = screen.getByTestId("overflow-menu");
      expect(findMenuButton(menu, "Rename")).toBeDefined();
      expect(findMenuButton(menu, "Duplicate")).toBeDefined();
    });

    it("renders Lock Input and View Terminal Info for PTY panels", () => {
      mockHasPty = true;
      render(<PanelHeader {...makeProps({ kind: "terminal" })} />);
      const menu = screen.getByTestId("overflow-menu");
      expect(findMenuButton(menu, "Lock Input")).toBeDefined();
      expect(findMenuButton(menu, "View Terminal Info")).toBeDefined();
    });

    it("does not render Lock Input or View Terminal Info for non-PTY panels", () => {
      mockHasPty = false;
      render(<PanelHeader {...makeProps({ kind: "browser" })} />);
      const menu = screen.getByTestId("overflow-menu");
      expect(findMenuButton(menu, "Lock Input")).toBeUndefined();
      expect(findMenuButton(menu, "View Terminal Info")).toBeUndefined();
    });

    it("renders Watch for unwatched agent panels", () => {
      render(<PanelHeader {...makeProps({ agentId: "claude" })} />);
      const menu = screen.getByTestId("overflow-menu");
      expect(findMenuButton(menu, "Watch")).toBeDefined();
      expect(findMenuButton(menu, "Cancel Watch")).toBeUndefined();
    });

    it("renders Cancel Watch when agent panel is watched", () => {
      mockStoreState = {
        ...mockStoreState,
        watchedPanels: new Set(["test-panel"]),
      };
      render(<PanelHeader {...makeProps({ agentId: "claude" })} />);
      const menu = screen.getByTestId("overflow-menu");
      expect(findMenuButton(menu, "Cancel Watch")).toBeDefined();
      expect(findMenuButton(menu, "Watch")).toBeUndefined();
    });

    it("does not render Watch for non-agent panels", () => {
      render(<PanelHeader {...makeProps({ kind: "terminal" })} />);
      const menu = screen.getByTestId("overflow-menu");
      expect(findMenuButton(menu, "Watch")).toBeUndefined();
      expect(findMenuButton(menu, "Cancel Watch")).toBeUndefined();
    });

    it("renders Trash with destructive styling", () => {
      render(<PanelHeader {...makeProps()} />);
      const menu = screen.getByTestId("overflow-menu");
      const trashButton = findMenuButton(menu, "Trash");
      expect(trashButton).toBeDefined();
      expect(trashButton?.getAttribute("data-destructive")).toBe("true");
    });

    it("dispatches terminal.rename when clicking Rename", () => {
      render(<PanelHeader {...makeProps()} />);
      const menu = screen.getByTestId("overflow-menu");
      findMenuButton(menu, "Rename")?.click();
      expect(mockDispatch).toHaveBeenCalledWith(
        "terminal.rename",
        { terminalId: "test-panel" },
        { source: "menu" }
      );
    });

    it("dispatches terminal.duplicate when clicking Duplicate", () => {
      render(<PanelHeader {...makeProps()} />);
      const menu = screen.getByTestId("overflow-menu");
      findMenuButton(menu, "Duplicate")?.click();
      expect(mockDispatch).toHaveBeenCalledWith(
        "terminal.duplicate",
        { terminalId: "test-panel" },
        { source: "menu" }
      );
    });

    it("dispatches terminal.toggleInputLock when clicking Lock Input", () => {
      mockHasPty = true;
      render(<PanelHeader {...makeProps({ kind: "terminal" })} />);
      const menu = screen.getByTestId("overflow-menu");
      findMenuButton(menu, "Lock Input")?.click();
      expect(mockDispatch).toHaveBeenCalledWith(
        "terminal.toggleInputLock",
        { terminalId: "test-panel" },
        { source: "menu" }
      );
    });

    it("dispatches terminal.viewInfo when clicking View Terminal Info", () => {
      mockHasPty = true;
      render(<PanelHeader {...makeProps({ kind: "terminal" })} />);
      const menu = screen.getByTestId("overflow-menu");
      findMenuButton(menu, "View Terminal Info")?.click();
      expect(mockDispatch).toHaveBeenCalledWith(
        "terminal.viewInfo",
        { terminalId: "test-panel" },
        { source: "menu" }
      );
    });

    it("dispatches terminal.trash when clicking Trash", () => {
      render(<PanelHeader {...makeProps()} />);
      const menu = screen.getByTestId("overflow-menu");
      findMenuButton(menu, "Trash")?.click();
      expect(mockDispatch).toHaveBeenCalledWith(
        "terminal.trash",
        { terminalId: "test-panel" },
        { source: "menu" }
      );
    });

    it("calls watchPanel when clicking Watch on unwatched agent panel", () => {
      render(<PanelHeader {...makeProps({ agentId: "claude" })} />);
      const menu = screen.getByTestId("overflow-menu");
      findMenuButton(menu, "Watch")?.click();
      expect(mockWatchPanel).toHaveBeenCalledWith("test-panel");
    });

    it("calls unwatchPanel when clicking Cancel Watch on watched agent panel", () => {
      mockStoreState = {
        ...mockStoreState,
        watchedPanels: new Set(["test-panel"]),
      };
      render(<PanelHeader {...makeProps({ agentId: "claude" })} />);
      const menu = screen.getByTestId("overflow-menu");
      findMenuButton(menu, "Cancel Watch")?.click();
      expect(mockUnwatchPanel).toHaveBeenCalledWith("test-panel");
    });

    it("shows Unlock Input when terminal is input locked", () => {
      mockHasPty = true;
      mockStoreState = {
        ...mockStoreState,
        terminals: [{ id: "test-panel", isInputLocked: true }],
      };
      render(<PanelHeader {...makeProps({ kind: "terminal" })} />);
      const menu = screen.getByTestId("overflow-menu");
      expect(findMenuButton(menu, "Unlock Input")).toBeDefined();
      expect(findMenuButton(menu, "Lock Input")).toBeUndefined();
    });

    it("renders headerActions slot in the menu", () => {
      render(
        <PanelHeader
          {...makeProps({ headerActions: <div data-testid="custom-action">Agent Settings</div> })}
        />
      );
      const menu = screen.getByTestId("overflow-menu");
      expect(menu.querySelector("[data-testid='custom-action']")).toBeDefined();
    });
  });

  describe("Collapse to Dock button", () => {
    it("renders when location is dock and onMinimize is provided", () => {
      const onMinimize = vi.fn();
      render(<PanelHeader {...makeProps({ location: "dock", onMinimize })} />);
      const btn = screen.getByTestId("panel-collapse-to-dock");
      expect(btn).toBeDefined();
      expect(btn.getAttribute("aria-label")).toBe("Collapse to Dock");
    });

    it("calls onMinimize when clicked", () => {
      const onMinimize = vi.fn();
      render(<PanelHeader {...makeProps({ location: "dock", onMinimize })} />);
      const btn = screen.getByTestId("panel-collapse-to-dock");
      btn.click();
      expect(onMinimize).toHaveBeenCalledTimes(1);
    });

    it("does not render when location is grid", () => {
      const onMinimize = vi.fn();
      render(<PanelHeader {...makeProps({ location: "grid", onMinimize })} />);
      expect(screen.queryByTestId("panel-collapse-to-dock")).toBeNull();
    });

    it("does not render when onMinimize is not provided", () => {
      render(<PanelHeader {...makeProps({ location: "dock" })} />);
      expect(screen.queryByTestId("panel-collapse-to-dock")).toBeNull();
    });
  });

  describe("Restore to Grid in overflow menu", () => {
    it("renders 'Restore to Grid' menu item when docked with onRestore", () => {
      render(<PanelHeader {...makeProps({ location: "dock", onRestore: vi.fn() })} />);
      const menuItem = screen.getByText("Restore to Grid");
      expect(menuItem).toBeDefined();
    });
  });

  describe("Maximize tooltip", () => {
    it("does not include double-click header hint", () => {
      render(<PanelHeader {...makeProps({ onToggleMaximize: vi.fn() })} />);
      const tooltips = screen.getAllByTestId("tooltip-content");
      const maximizeTooltip = tooltips.find((el) => el.textContent?.includes("Maximize"));
      expect(maximizeTooltip).toBeDefined();
      expect(maximizeTooltip!.textContent).not.toContain("double-click header");
    });
  });

  describe("Restore Grid View tooltip", () => {
    it("does not include double-click header hint when maximized", () => {
      render(<PanelHeader {...makeProps({ onToggleMaximize: vi.fn(), isMaximized: true })} />);
      const tooltips = screen.getAllByTestId("tooltip-content");
      const restoreTooltip = tooltips.find((el) => el.textContent?.includes("Restore Grid View"));
      expect(restoreTooltip).toBeDefined();
      expect(restoreTooltip!.textContent).not.toContain("double-click header");
    });
  });

  describe("Move to Dock button", () => {
    it("does not render when location is dock", () => {
      render(<PanelHeader {...makeProps({ location: "dock", onMinimize: vi.fn() })} />);
      expect(screen.queryByTestId("panel-move-to-dock")).toBeNull();
    });
  });

  describe("tab scroll arrows", () => {
    const twoTabs = [
      { id: "t1", title: "Tab 1", kind: "terminal" as const, isActive: true },
      { id: "t2", title: "Tab 2", kind: "terminal" as const, isActive: false },
    ];

    it("renders scroll arrows when tabs overflow", () => {
      mockScrollControls = {
        ...mockScrollControls,
        canScrollLeft: true,
        canScrollRight: true,
      };
      render(<PanelHeader {...makeProps({ tabs: twoTabs, onTabClick: vi.fn() })} />);
      expect(screen.getByLabelText("Scroll left")).toBeDefined();
      expect(screen.getByLabelText("Scroll right")).toBeDefined();
    });

    it("does not render scroll arrows when tabs do not overflow", () => {
      render(<PanelHeader {...makeProps({ tabs: twoTabs, onTabClick: vi.fn() })} />);
      expect(screen.queryByLabelText("Scroll left")).toBeNull();
      expect(screen.queryByLabelText("Scroll right")).toBeNull();
    });

    it("calls scrollLeft/scrollRight when arrows are clicked", () => {
      mockScrollControls = {
        ...mockScrollControls,
        canScrollLeft: true,
        canScrollRight: true,
      };
      render(<PanelHeader {...makeProps({ tabs: twoTabs, onTabClick: vi.fn() })} />);
      screen.getByLabelText("Scroll left").click();
      expect(mockScrollLeft).toHaveBeenCalledTimes(1);
      screen.getByLabelText("Scroll right").click();
      expect(mockScrollRight).toHaveBeenCalledTimes(1);
    });

    it("renders only the right arrow when scrolled to the start", () => {
      mockScrollControls = {
        ...mockScrollControls,
        canScrollLeft: false,
        canScrollRight: true,
      };
      render(<PanelHeader {...makeProps({ tabs: twoTabs, onTabClick: vi.fn() })} />);
      expect(screen.queryByLabelText("Scroll left")).toBeNull();
      expect(screen.getByLabelText("Scroll right")).toBeDefined();
    });
  });

  describe("header double-click behavior", () => {
    it("dispatches nav.toggleFocusMode when double-clicking header in grid mode", () => {
      const { container } = render(
        <PanelHeader {...makeProps({ location: "grid", onToggleMaximize: vi.fn() })} />
      );
      const header = container.firstElementChild as HTMLElement;
      fireEvent.dblClick(header);
      expect(mockDispatch).toHaveBeenCalledWith("nav.toggleFocusMode");
    });

    it("calls onRestore when double-clicking header in dock mode", () => {
      const onRestore = vi.fn();
      const { container } = render(<PanelHeader {...makeProps({ location: "dock", onRestore })} />);
      const header = container.firstElementChild as HTMLElement;
      fireEvent.dblClick(header);
      expect(onRestore).toHaveBeenCalledTimes(1);
      expect(mockDispatch).not.toHaveBeenCalledWith("nav.toggleFocusMode");
    });

    it("does not dispatch when double-clicking a button within the header", () => {
      render(<PanelHeader {...makeProps({ location: "grid", onToggleMaximize: vi.fn() })} />);
      const closeButton = screen.getByTestId("panel-close");
      fireEvent.dblClick(closeButton);
      expect(mockDispatch).not.toHaveBeenCalledWith("nav.toggleFocusMode");
    });
  });
});
