// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PanelHeader } from "../PanelHeader";
import type { PanelHeaderProps } from "../PanelHeader";
import { deriveTerminalChrome } from "@/utils/terminalChrome";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});

vi.mock("framer-motion", () => {
  const passthrough = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  const MotionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ children, ...props }, ref) => {
      const {
        layoutId: _layoutId,
        layout: _layout,
        transition: _transition,
        ...rest
      } = props as Record<string, unknown>;
      return (
        <div ref={ref} {...(rest as React.HTMLAttributes<HTMLDivElement>)}>
          {children}
        </div>
      );
    }
  );
  return {
    AnimatePresence: passthrough,
    LayoutGroup: passthrough,
    LazyMotion: passthrough,
    domAnimation: {},
    domMax: {},
    m: { div: MotionDiv },
    motion: { div: MotionDiv },
  };
});

let mockHiddenTabIds: ReadonlySet<string> = new Set();

vi.mock("@/hooks", () => ({
  useBackgroundPanelStats: () => ({ activeCount: 0, workingCount: 0 }),
  useTabOverflow: () => mockHiddenTabIds,
  useKeybindingDisplay: () => "",
  useAriaKeyshortcuts: () => undefined,
}));

let mockDragHandle: {
  listeners: Record<string, (e: unknown) => void> | undefined;
  setActivatorNodeRef?: (node: HTMLElement | null) => void;
} | null = null;

vi.mock("@/components/DragDrop/DragHandleContext", () => ({
  useDragHandle: () => mockDragHandle,
}));

const mockWatchPanel = vi.fn();
const mockUnwatchPanel = vi.fn();

let mockStoreState: Record<string, unknown> = {
  watchedPanels: new Set<string>(),
  watchPanel: mockWatchPanel,
  unwatchPanel: mockUnwatchPanel,
  panelsById: {} as Record<string, unknown>,
  panelIds: [] as string[],
};

vi.mock("@/store/panelStore", () => {
  const usePanelStore = (selector: (s: Record<string, unknown>) => unknown) =>
    selector(mockStoreState);
  usePanelStore.getState = () => mockStoreState;
  return { usePanelStore };
});

let mockHasPty = false;

vi.mock("@shared/config/panelKindRegistry", () => ({
  panelKindCanRestart: () => false,
  panelKindHasPty: () => mockHasPty,
  getPanelKindConfig: (kind: string) =>
    kind === "browser"
      ? { id: "browser", name: "Browser", iconId: "globe", color: "#38bdf8" }
      : kind === "dev-preview"
        ? { id: "dev-preview", name: "Dev Preview", iconId: "monitor-play", color: "#38bdf8" }
        : { id: "terminal", name: "Terminal", iconId: "terminal", color: "#9ca3af" },
  getPanelKindColor: () => "#9ca3af",
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
  DropdownMenuContent: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
    align?: string;
  }) => (
    <div data-testid="overflow-menu" className={className}>
      {children}
    </div>
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
  const chrome =
    overrides.chrome ??
    deriveTerminalChrome({
      kind: overrides.kind ?? "terminal",
      presetColor: overrides.presetColor,
    });
  return {
    id: "test-panel",
    title: "Test Panel",
    kind: "terminal",
    chrome,
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
    mockHiddenTabIds = new Set();
    mockStoreState = {
      watchedPanels: new Set<string>(),
      watchPanel: mockWatchPanel,
      unwatchPanel: mockUnwatchPanel,
      panelsById: {},
      panelIds: [],
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

  describe("headerContent slot", () => {
    it("defaults to trailing placement — slot renders after the close button", () => {
      render(
        <PanelHeader
          {...makeProps({ headerContent: <div data-testid="custom-header-content" /> })}
        />
      );
      const content = screen.getByTestId("custom-header-content");
      const closeButton = screen.getByTestId("panel-close");
      // Trailing keeps the slot (e.g. the terminal Activity Indicator) all the
      // way right, so the close button precedes it in document order.
      expect(
        closeButton.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });

    it("renders before the overflow menu when placement is leading", () => {
      render(
        <PanelHeader
          {...makeProps({
            headerContent: <div data-testid="custom-header-content" />,
            headerContentPlacement: "leading",
          })}
        />
      );
      const content = screen.getByTestId("custom-header-content");
      const overflowButton = screen.getByLabelText("More panel actions");
      expect(
        content.compareDocumentPosition(overflowButton) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
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

    it("renders Lock Input for PTY panels", () => {
      mockHasPty = true;
      render(<PanelHeader {...makeProps({ kind: "terminal" })} />);
      const menu = screen.getByTestId("overflow-menu");
      expect(findMenuButton(menu, "Lock Input")).toBeDefined();
    });

    it("does not render View Terminal Info on any panel kind (#5957)", () => {
      mockHasPty = true;
      render(<PanelHeader {...makeProps({ kind: "terminal" })} />);
      const menu = screen.getByTestId("overflow-menu");
      expect(findMenuButton(menu, "View Terminal Info")).toBeUndefined();
    });

    it("does not render Lock Input for non-PTY panels", () => {
      mockHasPty = false;
      render(<PanelHeader {...makeProps({ kind: "browser" })} />);
      const menu = screen.getByTestId("overflow-menu");
      expect(findMenuButton(menu, "Lock Input")).toBeUndefined();
    });

    it("renders Watch for unwatched agent panels", () => {
      render(
        <PanelHeader
          {...makeProps({
            agentId: "claude",
            chrome: deriveTerminalChrome({ detectedAgentId: "claude" }),
          })}
        />
      );
      const menu = screen.getByTestId("overflow-menu");
      expect(findMenuButton(menu, "Watch")).toBeDefined();
      expect(findMenuButton(menu, "Cancel Watch")).toBeUndefined();
    });

    it("renders Cancel Watch when agent panel is watched", () => {
      mockStoreState = {
        ...mockStoreState,
        watchedPanels: new Set(["test-panel"]),
      };
      render(
        <PanelHeader
          {...makeProps({
            agentId: "claude",
            chrome: deriveTerminalChrome({ detectedAgentId: "claude" }),
          })}
        />
      );
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
      render(
        <PanelHeader
          {...makeProps({
            agentId: "claude",
            chrome: deriveTerminalChrome({ detectedAgentId: "claude" }),
          })}
        />
      );
      const menu = screen.getByTestId("overflow-menu");
      findMenuButton(menu, "Watch")?.click();
      expect(mockWatchPanel).toHaveBeenCalledWith("test-panel");
    });

    it("calls unwatchPanel when clicking Cancel Watch on watched agent panel", () => {
      mockStoreState = {
        ...mockStoreState,
        watchedPanels: new Set(["test-panel"]),
      };
      render(
        <PanelHeader
          {...makeProps({
            agentId: "claude",
            chrome: deriveTerminalChrome({ detectedAgentId: "claude" }),
          })}
        />
      );
      const menu = screen.getByTestId("overflow-menu");
      findMenuButton(menu, "Cancel Watch")?.click();
      expect(mockUnwatchPanel).toHaveBeenCalledWith("test-panel");
    });

    it("shows Unlock Input when terminal is input locked", () => {
      mockHasPty = true;
      mockStoreState = {
        ...mockStoreState,
        panelsById: { "test-panel": { id: "test-panel", isInputLocked: true } },
        panelIds: ["test-panel"],
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

  describe("Collapse to Dock button (removed — collapse via Escape/outside-click/chip)", () => {
    it("never renders a dedicated collapse button on docked panels", () => {
      const onMinimize = vi.fn();
      render(<PanelHeader {...makeProps({ location: "dock", onMinimize })} />);
      expect(screen.queryByTestId("panel-collapse-to-dock")).toBeNull();
    });
  });

  describe("close button dismiss-vs-destroy copy (#11186)", () => {
    const tooltipTexts = () =>
      screen.getAllByTestId("tooltip-content").map((el) => el.textContent ?? "");

    it("labels the grid close button as a destructive close", () => {
      render(<PanelHeader {...makeProps({ location: "grid" })} />);
      const closeBtn = screen.getByTestId("panel-close");
      expect(closeBtn.getAttribute("aria-label")).toMatch(/close session/i);
      expect(closeBtn.getAttribute("aria-label")).not.toMatch(/dismiss/i);
      expect(tooltipTexts().some((t) => /close session/i.test(t))).toBe(true);
    });

    it("labels the dock close button as a non-destructive dismiss, not a close", () => {
      // The dock X only collapses the preview (the PTY keeps running), so its
      // accessible name and tooltip must not read as a destructive "close".
      render(<PanelHeader {...makeProps({ location: "dock" })} />);
      const closeBtn = screen.getByTestId("panel-close");
      expect(closeBtn.getAttribute("aria-label")).toMatch(/dismiss preview/i);
      expect(closeBtn.getAttribute("aria-label")).not.toMatch(/close session/i);
      const texts = tooltipTexts();
      expect(texts.some((t) => /dismiss preview/i.test(t))).toBe(true);
      expect(texts.every((t) => !/close session/i.test(t))).toBe(true);
    });

    it("keeps the Alt+Click force-close affordance on both surfaces", () => {
      // Relabeling the dock X as "dismiss" must not drop the escape hatch that
      // still lets the user force-kill (Alt+Click) — nothing loses the ability
      // to be destroyed.
      for (const location of ["grid", "dock"] as const) {
        const { unmount } = render(<PanelHeader {...makeProps({ location })} />);
        expect(screen.getByTestId("panel-close").getAttribute("aria-label")).toMatch(
          /force close/i
        );
        unmount();
      }
    });
  });

  describe("Move to grid button", () => {
    it("renders when docked with onRestore and showRestoreControl", () => {
      const onRestore = vi.fn();
      render(
        <PanelHeader {...makeProps({ location: "dock", onRestore, showRestoreControl: true })} />
      );
      const btn = screen.getByTestId("panel-move-to-grid");
      expect(btn).toBeDefined();
      expect(btn.getAttribute("aria-label")).toBe("Move to grid");
    });

    it("calls onRestore when clicked", () => {
      const onRestore = vi.fn();
      render(
        <PanelHeader {...makeProps({ location: "dock", onRestore, showRestoreControl: true })} />
      );
      screen.getByTestId("panel-move-to-grid").click();
      expect(onRestore).toHaveBeenCalledTimes(1);
    });

    it("does not render when showRestoreControl is false (grouped dock panel)", () => {
      const onRestore = vi.fn();
      render(
        <PanelHeader {...makeProps({ location: "dock", onRestore, showRestoreControl: false })} />
      );
      expect(screen.queryByTestId("panel-move-to-grid")).toBeNull();
    });

    it("does not render when onRestore is not provided", () => {
      render(
        <PanelHeader
          {...makeProps({ location: "dock", onMinimize: vi.fn(), showRestoreControl: true })}
        />
      );
      expect(screen.queryByTestId("panel-move-to-grid")).toBeNull();
    });

    it("does not render when location is grid", () => {
      const onRestore = vi.fn();
      render(
        <PanelHeader {...makeProps({ location: "grid", onRestore, showRestoreControl: true })} />
      );
      expect(screen.queryByTestId("panel-move-to-grid")).toBeNull();
    });

    it("fires only onRestore, never onMinimize, when clicked", () => {
      const onRestore = vi.fn();
      const onMinimize = vi.fn();
      render(
        <PanelHeader
          {...makeProps({
            location: "dock",
            onRestore,
            onMinimize,
            showRestoreControl: true,
          })}
        />
      );
      screen.getByTestId("panel-move-to-grid").click();
      expect(onRestore).toHaveBeenCalledTimes(1);
      expect(onMinimize).not.toHaveBeenCalled();
    });
  });

  describe("Move to grid in overflow menu", () => {
    it("renders 'Move to grid' menu item when docked with onRestore", () => {
      render(<PanelHeader {...makeProps({ location: "dock", onRestore: vi.fn() })} />);
      const menuItem = screen.getByText("Move to grid");
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

    it("renders restore button with standardized labels (no 'Focus' wording)", () => {
      render(<PanelHeader {...makeProps({ onToggleMaximize: vi.fn(), isMaximized: true })} />);
      const restoreBtn = screen.getByRole("button", { name: "Restore grid view" });
      expect(restoreBtn).toBeDefined();
      expect(restoreBtn.textContent).toContain("Restore");
      expect(screen.queryByText("Exit Focus")).toBeNull();
    });
  });

  describe("Move to dock button", () => {
    it("does not render when location is dock", () => {
      render(<PanelHeader {...makeProps({ location: "dock", onMinimize: vi.fn() })} />);
      expect(screen.queryByTestId("panel-move-to-dock")).toBeNull();
    });
  });

  describe("tab overflow menu (#6429)", () => {
    const threeTabs = [
      {
        id: "t1",
        title: "Tab 1",
        kind: "terminal" as const,
        chrome: deriveTerminalChrome(),
        isActive: true,
      },
      {
        id: "t2",
        title: "Tab 2",
        kind: "terminal" as const,
        chrome: deriveTerminalChrome(),
        isActive: false,
      },
      {
        id: "t3",
        title: "Tab 3",
        kind: "terminal" as const,
        chrome: deriveTerminalChrome(),
        isActive: false,
      },
    ];

    it("does not render the overflow trigger when no tabs are hidden", () => {
      render(<PanelHeader {...makeProps({ tabs: threeTabs, onTabClick: vi.fn() })} />);
      expect(screen.queryByLabelText("Show hidden tabs")).toBeNull();
      expect(screen.queryByTestId("panel-tabs-overflow")).toBeNull();
    });

    it("renders the overflow trigger when one or more tabs are hidden", () => {
      mockHiddenTabIds = new Set(["t2", "t3"]);
      render(<PanelHeader {...makeProps({ tabs: threeTabs, onTabClick: vi.fn() })} />);
      const trigger = screen.getByLabelText("Show hidden tabs");
      expect(trigger).toBeDefined();
      expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    });

    it("lists hidden tabs by full title in the dropdown", () => {
      mockHiddenTabIds = new Set(["t2", "t3"]);
      render(<PanelHeader {...makeProps({ tabs: threeTabs, onTabClick: vi.fn() })} />);
      const menus = screen.getAllByTestId("overflow-menu");
      const tabsMenu = menus.find((m) => m.textContent?.includes("Tab 2"));
      expect(tabsMenu).toBeDefined();
      expect(tabsMenu!.textContent).toContain("Tab 2");
      expect(tabsMenu!.textContent).toContain("Tab 3");
      expect(tabsMenu!.textContent).not.toContain("Tab 1");
    });

    it("calls onTabClick with the hidden tab id when a menu item is selected", () => {
      mockHiddenTabIds = new Set(["t2", "t3"]);
      const onTabClick = vi.fn();
      render(<PanelHeader {...makeProps({ tabs: threeTabs, onTabClick })} />);
      const menus = screen.getAllByTestId("overflow-menu");
      const tabsMenu = menus.find((m) => m.textContent?.includes("Tab 2"))!;
      const tab2Item = Array.from(tabsMenu.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Tab 2")
      );
      tab2Item?.click();
      expect(onTabClick).toHaveBeenCalledWith("t2");
    });

    it("marks an active hidden tab with aria-current and font-medium", () => {
      mockHiddenTabIds = new Set(["t1", "t2"]);
      render(<PanelHeader {...makeProps({ tabs: threeTabs, onTabClick: vi.fn() })} />);
      const menus = screen.getAllByTestId("overflow-menu");
      const tabsMenu = menus.find((m) => m.textContent?.includes("Tab 1"))!;
      const items = Array.from(tabsMenu.querySelectorAll("button"));
      const activeItem = items.find((b) => b.textContent?.includes("Tab 1"));
      expect(activeItem?.getAttribute("aria-current")).toBe("true");
      expect(activeItem?.className).toContain("font-medium");
      const inactiveItem = items.find((b) => b.textContent?.includes("Tab 2"));
      expect(inactiveItem?.getAttribute("aria-current")).toBeNull();
    });
  });

  describe("header double-click behavior", () => {
    it("calls onToggleMaximize when double-clicking header in grid mode", () => {
      const onToggleMaximize = vi.fn();
      const { container } = render(
        <PanelHeader {...makeProps({ location: "grid", onToggleMaximize })} />
      );
      const header = container.firstElementChild as HTMLElement;
      fireEvent.dblClick(header);
      expect(onToggleMaximize).toHaveBeenCalledTimes(1);
      expect(mockDispatch).not.toHaveBeenCalledWith("nav.toggleFocusMode");
    });

    it("calls onRestore when double-clicking header in dock mode", () => {
      const onRestore = vi.fn();
      const onToggleMaximize = vi.fn();
      const { container } = render(
        <PanelHeader {...makeProps({ location: "dock", onRestore, onToggleMaximize })} />
      );
      const header = container.firstElementChild as HTMLElement;
      fireEvent.dblClick(header);
      expect(onRestore).toHaveBeenCalledTimes(1);
      expect(onToggleMaximize).not.toHaveBeenCalled();
    });

    it("does not call onToggleMaximize when double-clicking a button within the header", () => {
      const onToggleMaximize = vi.fn();
      render(<PanelHeader {...makeProps({ location: "grid", onToggleMaximize })} />);
      const closeButton = screen.getByTestId("panel-close");
      fireEvent.dblClick(closeButton);
      expect(onToggleMaximize).not.toHaveBeenCalled();
    });

    it("does not throw when onToggleMaximize is undefined", () => {
      const { container } = render(<PanelHeader {...makeProps({ location: "grid" })} />);
      const header = container.firstElementChild as HTMLElement;
      expect(() => fireEvent.dblClick(header)).not.toThrow();
    });
  });

  describe("mousedown handling", () => {
    it("does not call preventDefault on a double-click mousedown (#7279)", () => {
      // Calling preventDefault on the second mousedown of a double-click
      // suppressed the resulting click and left armed-fleet panels stuck
      // unclickable. Text-selection prevention is handled by the `select-none`
      // CSS class on the container instead — see #6978 / #7279.
      const { container } = render(<PanelHeader {...makeProps({ location: "grid" })} />);
      const header = container.firstElementChild as HTMLElement;
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 2 });
      header.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    });

    it("forwards all mousedowns to the dnd-kit drag listener", () => {
      const dragMouseDown = vi.fn();
      mockDragHandle = { listeners: { onMouseDown: dragMouseDown } };
      try {
        const { container } = render(<PanelHeader {...makeProps({ location: "grid" })} />);
        const header = container.firstElementChild as HTMLElement;
        fireEvent.mouseDown(header, { detail: 1 });
        fireEvent.mouseDown(header, { detail: 2 });
        expect(dragMouseDown).toHaveBeenCalledTimes(2);
      } finally {
        mockDragHandle = null;
      }
    });

    it("applies select-none to the header container (#6978 selection guard)", () => {
      const { container } = render(<PanelHeader {...makeProps({ location: "grid" })} />);
      const header = container.firstElementChild as HTMLElement;
      expect(header.className).toContain("select-none");
    });
  });

  describe("multi-select title bar", () => {
    it("does not tag the header when isSelected is false", () => {
      const { container } = render(<PanelHeader {...makeProps({ isFocused: false })} />);
      const header = container.firstElementChild as HTMLElement;
      expect(header.getAttribute("data-selected")).toBeNull();
      expect(header.className).toContain("bg-[var(--panel-header-bg,transparent)]");
    });

    it("tags selected panes with data-selected and lifts the header bg", () => {
      const { container } = render(
        <PanelHeader {...makeProps({ isFocused: false, isSelected: true })} />
      );
      const header = container.firstElementChild as HTMLElement;
      expect(header.getAttribute("data-selected")).toBe("true");
      // Selected header matches the focused overlay tint — one unified
      // "active" title bar treatment for both focus and selection.
      expect(header.className).toContain(
        "bg-[var(--panel-header-focus-bg,var(--color-overlay-subtle))]"
      );
      expect(header.className).not.toContain("bg-[var(--panel-header-bg,transparent)]");
    });

    it("does not add an accent border or accent title on selected panes", () => {
      const { container } = render(
        <PanelHeader {...makeProps({ isFocused: true, isSelected: true })} />
      );
      const header = container.firstElementChild as HTMLElement;
      expect(header.className).not.toContain("panel-fleet-primary");
      expect(header.className).not.toContain("panel-fleet-member");
      const title = screen
        .getAllByText("Test Panel")
        .find((el) => el.className.includes("font-medium"));
      expect(title?.className).not.toContain("text-accent-primary");
    });

    it("does not apply selection bg when the pane is maximized", () => {
      const { container } = render(
        <PanelHeader {...makeProps({ isSelected: true, isMaximized: true })} />
      );
      const header = container.firstElementChild as HTMLElement;
      expect(header.className).not.toContain(
        "bg-[var(--panel-header-focus-bg,var(--color-overlay-subtle))]"
      );
    });
  });

  describe("keyboard drag activation (#7262)", () => {
    it("registers setActivatorNodeRef on the header div when drag listeners are present", () => {
      // KeyboardSensor watches whichever element receives setActivatorNodeRef.
      // The whole header is the drag surface, so the ref must land there.
      const setActivatorNodeRef = vi.fn();
      mockDragHandle = {
        listeners: { onMouseDown: vi.fn() },
        setActivatorNodeRef,
      };
      try {
        const { container } = render(<PanelHeader {...makeProps({ location: "grid" })} />);
        const header = container.firstElementChild as HTMLElement;
        expect(setActivatorNodeRef).toHaveBeenCalledWith(header);
      } finally {
        mockDragHandle = null;
      }
    });

    it("makes the header focusable (tabIndex=0) and groups it for screen readers when draggable", () => {
      mockDragHandle = {
        listeners: { onMouseDown: vi.fn() },
        setActivatorNodeRef: vi.fn(),
      };
      try {
        const { container } = render(<PanelHeader {...makeProps({ location: "grid" })} />);
        const header = container.firstElementChild as HTMLElement;
        expect(header.getAttribute("tabindex")).toBe("0");
        expect(header.getAttribute("role")).toBe("group");
        expect(header.getAttribute("aria-roledescription")).toContain("Draggable");
      } finally {
        mockDragHandle = null;
      }
    });

    it("does not make the header focusable when no drag listeners are attached", () => {
      // Without dragListeners (e.g. maximized panel), the header is not a drag
      // surface — leaving tabIndex unset preserves the existing tab order so
      // every panel chrome doesn't become a Tab stop.
      mockDragHandle = null;
      const { container } = render(<PanelHeader {...makeProps({ location: "grid" })} />);
      const header = container.firstElementChild as HTMLElement;
      expect(header.getAttribute("tabindex")).toBeNull();
      expect(header.getAttribute("role")).toBeNull();
      expect(header.getAttribute("aria-roledescription")).toBeNull();
    });
  });

  describe("dangerous flags indicator", () => {
    it("shows red dot indicator when agentLaunchFlags contain dangerous flag", () => {
      render(
        <PanelHeader
          {...makeProps({
            agentLaunchFlags: ["--dangerously-skip-permissions"],
          })}
        />
      );

      const indicator = screen.getByLabelText("Launched with dangerous permissions");
      expect(indicator).toBeDefined();
      expect(indicator.className).toContain("bg-status-danger");
    });

    it("shows red dot indicator for all dangerous flag types", () => {
      const dangerousFlags = [
        ["--dangerously-skip-permissions"],
        ["--yolo"],
        ["--dangerously-bypass-approvals-and-sandbox"],
        ["--force"],
      ];

      for (const flags of dangerousFlags) {
        const { unmount } = render(<PanelHeader {...makeProps({ agentLaunchFlags: flags })} />);
        const indicator = screen.getByLabelText("Launched with dangerous permissions");
        expect(indicator).toBeDefined();
        unmount();
      }
    });

    it("does not show indicator when agentLaunchFlags does not contain dangerous flag", () => {
      render(<PanelHeader {...makeProps({ agentLaunchFlags: ["--model", "claude-3-7"] })} />);

      const indicator = screen.queryByLabelText("Launched with dangerous permissions");
      expect(indicator).toBeNull();
    });

    it("does not show indicator when agentLaunchFlags is undefined", () => {
      render(<PanelHeader {...makeProps()} />);

      const indicator = screen.queryByLabelText("Launched with dangerous permissions");
      expect(indicator).toBeNull();
    });

    it("does not show indicator when agentLaunchFlags is empty array", () => {
      render(<PanelHeader {...makeProps({ agentLaunchFlags: [] })} />);

      const indicator = screen.queryByLabelText("Launched with dangerous permissions");
      expect(indicator).toBeNull();
    });

    it("shows tooltip with correct text for dangerous flags", () => {
      render(<PanelHeader {...makeProps({ agentLaunchFlags: ["--yolo"] })} />);

      const tooltipContent = screen.queryByText(
        "Launched with dangerous permissions — agent can modify files without prompting"
      );
      expect(tooltipContent).toBeDefined();
    });
  });

  describe("title edit input styling (#7926)", () => {
    const getRenameInput = () => screen.getByLabelText("Edit terminal title") as HTMLInputElement;

    it("matches the static label font size (text-xs)", () => {
      render(<PanelHeader {...makeProps({ isEditingTitle: true, editingValue: "Test" })} />);
      expect(getRenameInput().className).toContain("text-xs");
      expect(getRenameInput().className).not.toContain("text-sm");
    });

    it("uses a transparent border and subtle background lift instead of a heavy chrome", () => {
      render(<PanelHeader {...makeProps({ isEditingTitle: true, editingValue: "Test" })} />);
      const cls = getRenameInput().className;
      expect(cls).toContain("border-transparent");
      expect(cls).toContain("bg-overlay-soft");
      expect(cls).not.toContain("border-border-strong");
      expect(cls).not.toContain("bg-daintree-bg/60");
    });

    it("does not use the accent color for any focus indicator", () => {
      render(<PanelHeader {...makeProps({ isEditingTitle: true, editingValue: "Test" })} />);
      const cls = getRenameInput().className;
      expect(cls).not.toMatch(/(outline|ring|border)-daintree-accent/);
      expect(cls).toContain("focus:outline-hidden");
    });
  });

  describe("fleet preview kinetic cue", () => {
    it("renders the preview-enter overlay when isFleetPreviewed is true", () => {
      const { container } = render(<PanelHeader {...makeProps({ isFleetPreviewed: true })} />);
      const overlay = container.querySelector(".fleet-preview-enter-overlay");
      expect(overlay).not.toBeNull();
      expect(overlay?.getAttribute("aria-hidden")).toBe("true");
    });

    it("does not render the overlay when isFleetPreviewed is false", () => {
      const { container } = render(<PanelHeader {...makeProps({ isFleetPreviewed: false })} />);
      expect(container.querySelector(".fleet-preview-enter-overlay")).toBeNull();
    });

    it("coexists with the selected state without replacing the selected background", () => {
      // isFocused: false isolates the bg cascade so isSelected wins the class
      // (the focus-bg hook) — the kinetic overlay is additive, not a replacement.
      const { container } = render(
        <PanelHeader
          {...makeProps({ isFleetPreviewed: true, isSelected: true, isFocused: false })}
        />
      );
      const overlay = container.querySelector(".fleet-preview-enter-overlay");
      expect(overlay).not.toBeNull();
      const header = container.querySelector("[data-pane-chrome]");
      expect(header?.getAttribute("data-selected")).toBe("true");
      expect(header?.className).toContain(
        "bg-[var(--panel-header-focus-bg,var(--color-overlay-subtle))]"
      );
    });

    it("still renders the overlay when the pane is focused", () => {
      // A focused, previewed pane gets the focus-bg hook via the isFocused
      // branch — the overlay must not be gated on focus/selection state.
      const { container } = render(
        <PanelHeader {...makeProps({ isFleetPreviewed: true, isFocused: true })} />
      );
      expect(container.querySelector(".fleet-preview-enter-overlay")).not.toBeNull();
    });

    it("mounts/unmounts the overlay across preview enter→exit→enter, replaying the cue", () => {
      const { container, rerender } = render(
        <PanelHeader {...makeProps({ isFleetPreviewed: false })} />
      );
      expect(container.querySelector(".fleet-preview-enter-overlay")).toBeNull();

      rerender(<PanelHeader {...makeProps({ isFleetPreviewed: true })} />);
      const first = container.querySelector(".fleet-preview-enter-overlay");
      expect(first).not.toBeNull();

      rerender(<PanelHeader {...makeProps({ isFleetPreviewed: false })} />);
      expect(container.querySelector(".fleet-preview-enter-overlay")).toBeNull();

      // Re-entering remounts a fresh node so the one-shot animation replays.
      rerender(<PanelHeader {...makeProps({ isFleetPreviewed: true })} />);
      const second = container.querySelector(".fleet-preview-enter-overlay");
      expect(second).not.toBeNull();
      expect(second).not.toBe(first);
    });

    it("syncs the data-fleet-previewed attribute with the preview state", () => {
      const { container, rerender } = render(
        <PanelHeader {...makeProps({ isFleetPreviewed: true })} />
      );
      const header = container.querySelector("[data-pane-chrome]");
      expect(header?.getAttribute("data-fleet-previewed")).toBe("true");

      rerender(<PanelHeader {...makeProps({ isFleetPreviewed: false })} />);
      expect(header?.hasAttribute("data-fleet-previewed")).toBe(false);
    });
  });
});
