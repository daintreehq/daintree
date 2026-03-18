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

vi.mock("@/store/terminalStore", () => ({
  useTerminalStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ watchedPanels: new Set() as Set<string>, unwatchPanel: vi.fn() }),
}));

vi.mock("@shared/config/panelKindRegistry", () => ({
  panelKindCanRestart: () => false,
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
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
    it("renders with Title Case 'Restore to Grid' and double-click hint", () => {
      render(<PanelHeader {...makeProps({ location: "dock", onRestore: vi.fn() })} />);
      const btn = screen.getByLabelText("Restore to Grid");
      expect(btn).toBeDefined();
      const tooltips = screen.getAllByTestId("tooltip-content");
      const restoreTooltip = tooltips.find(
        (el) =>
          el.textContent?.includes("Restore to Grid") &&
          el.textContent?.includes("double-click header")
      );
      expect(restoreTooltip).toBeDefined();
    });
  });

  describe("Maximize tooltip", () => {
    it("includes double-click header hint", () => {
      render(<PanelHeader {...makeProps({ onToggleMaximize: vi.fn() })} />);
      const tooltips = screen.getAllByTestId("tooltip-content");
      const maximizeTooltip = tooltips.find(
        (el) =>
          el.textContent?.includes("Maximize") && el.textContent?.includes("double-click header")
      );
      expect(maximizeTooltip).toBeDefined();
    });
  });

  describe("Restore Grid View tooltip", () => {
    it("includes double-click header hint when maximized", () => {
      render(<PanelHeader {...makeProps({ onToggleMaximize: vi.fn(), isMaximized: true })} />);
      const tooltips = screen.getAllByTestId("tooltip-content");
      const restoreTooltip = tooltips.find(
        (el) =>
          el.textContent?.includes("Restore Grid View") &&
          el.textContent?.includes("double-click header")
      );
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
