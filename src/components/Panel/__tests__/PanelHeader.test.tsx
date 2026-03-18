// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PanelHeader } from "../PanelHeader";
import type { PanelHeaderProps } from "../PanelHeader";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});

vi.mock("@/hooks", () => ({
  useBackgroundPanelStats: () => ({ activeCount: 0, workingCount: 0 }),
  useHorizontalScrollControls: () => ({
    containerRef: { current: null },
    canScrollLeft: false,
    canScrollRight: false,
    scrollBy: vi.fn(),
  }),
}));

vi.mock("@/components/DragDrop/DragHandleContext", () => ({
  useDragHandle: () => null,
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
    it("always renders the overflow button (Rename/Duplicate/Trash always available)", () => {
      render(<PanelHeader {...makeProps()} />);
      expect(screen.getByLabelText("More panel actions")).toBeDefined();
    });

    it("renders Rename and Duplicate for all panel kinds", () => {
      render(<PanelHeader {...makeProps({ kind: "browser" })} />);
      const menu = screen.getByTestId("overflow-menu");
      expect(menu.textContent).toContain("Rename");
      expect(menu.textContent).toContain("Duplicate");
    });

    it("renders Lock Input and View Terminal Info for PTY panels", () => {
      mockHasPty = true;
      render(<PanelHeader {...makeProps({ kind: "terminal" })} />);
      const menu = screen.getByTestId("overflow-menu");
      expect(menu.textContent).toContain("Lock Input");
      expect(menu.textContent).toContain("View Terminal Info");
    });

    it("does not render Lock Input or View Terminal Info for non-PTY panels", () => {
      mockHasPty = false;
      render(<PanelHeader {...makeProps({ kind: "browser" })} />);
      const menu = screen.getByTestId("overflow-menu");
      expect(menu.textContent).not.toContain("Lock Input");
      expect(menu.textContent).not.toContain("View Terminal Info");
    });

    it("renders Watch for agent panels", () => {
      render(<PanelHeader {...makeProps({ agentId: "claude" })} />);
      const menu = screen.getByTestId("overflow-menu");
      expect(menu.textContent).toContain("Watch");
    });

    it("renders Cancel Watch when agent panel is watched", () => {
      mockStoreState = {
        ...mockStoreState,
        watchedPanels: new Set(["test-panel"]),
      };
      render(<PanelHeader {...makeProps({ agentId: "claude" })} />);
      const menu = screen.getByTestId("overflow-menu");
      expect(menu.textContent).toContain("Cancel Watch");
    });

    it("does not render Watch for non-agent panels", () => {
      render(<PanelHeader {...makeProps({ kind: "terminal" })} />);
      const menu = screen.getByTestId("overflow-menu");
      expect(menu.textContent).not.toContain("Watch");
    });

    it("renders Trash with destructive styling", () => {
      render(<PanelHeader {...makeProps()} />);
      const menu = screen.getByTestId("overflow-menu");
      const trashButton = Array.from(menu.querySelectorAll("button")).find((btn) =>
        btn.textContent?.includes("Trash")
      );
      expect(trashButton).toBeDefined();
      expect(trashButton?.getAttribute("data-destructive")).toBe("true");
    });

    it("dispatches terminal.rename when clicking Rename", () => {
      render(<PanelHeader {...makeProps()} />);
      const menu = screen.getByTestId("overflow-menu");
      const renameButton = Array.from(menu.querySelectorAll("button")).find((btn) =>
        btn.textContent?.includes("Rename")
      );
      renameButton?.click();
      expect(mockDispatch).toHaveBeenCalledWith(
        "terminal.rename",
        { terminalId: "test-panel" },
        { source: "menu" }
      );
    });

    it("dispatches terminal.trash when clicking Trash", () => {
      render(<PanelHeader {...makeProps()} />);
      const menu = screen.getByTestId("overflow-menu");
      const trashButton = Array.from(menu.querySelectorAll("button")).find((btn) =>
        btn.textContent?.includes("Trash")
      );
      trashButton?.click();
      expect(mockDispatch).toHaveBeenCalledWith(
        "terminal.trash",
        { terminalId: "test-panel" },
        { source: "menu" }
      );
    });

    it("shows Unlock Input when terminal is input locked", () => {
      mockHasPty = true;
      mockStoreState = {
        ...mockStoreState,
        terminals: [{ id: "test-panel", isInputLocked: true }],
      };
      render(<PanelHeader {...makeProps({ kind: "terminal" })} />);
      const menu = screen.getByTestId("overflow-menu");
      expect(menu.textContent).toContain("Unlock Input");
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

  describe("Restore to Grid casing", () => {
    it("renders with Title Case 'Restore to Grid'", () => {
      render(<PanelHeader {...makeProps({ location: "dock", onRestore: vi.fn() })} />);
      const btn = screen.getByLabelText("Restore to Grid");
      expect(btn).toBeDefined();
      const tooltips = screen.getAllByTestId("tooltip-content");
      const restoreTooltip = tooltips.find((el) => el.textContent === "Restore to Grid");
      expect(restoreTooltip).toBeDefined();
    });
  });

  describe("Move to Dock button", () => {
    it("does not render when location is dock", () => {
      render(<PanelHeader {...makeProps({ location: "dock", onMinimize: vi.fn() })} />);
      expect(screen.queryByTestId("panel-move-to-dock")).toBeNull();
    });
  });
});
