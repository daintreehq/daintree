/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConsoleDrawer } from "../ConsoleDrawer";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { useConsoleCaptureStore } from "@/store/consoleCaptureStore";
import type { SerializedConsoleRow } from "@shared/types/ipc/webviewConsole";

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    setVisible: vi.fn(),
  },
}));

vi.mock("../../Terminal/XtermAdapter", () => ({
  XtermAdapter: vi.fn(({ terminalId, getRefreshTier, restoreOnAttach }) => (
    <div
      data-testid="xterm-adapter"
      data-terminal-id={terminalId}
      data-restore-on-attach={restoreOnAttach ? "true" : "false"}
    >
      {getRefreshTier && <span data-testid="refresh-tier">{getRefreshTier()}</span>}
    </div>
  )),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onSelect} disabled={disabled} role="menuitem">
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr role="separator" />,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuRadioGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuRadioItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuCheckboxItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuShortcut: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockTerminalId = "test-terminal-id";
const mockPaneId = "test-pane-id";

function renderDrawer(props: Partial<React.ComponentProps<typeof ConsoleDrawer>> = {}) {
  return render(<ConsoleDrawer terminalId={mockTerminalId} paneId={mockPaneId} {...props} />);
}

function seedConsoleRow(overrides: Partial<SerializedConsoleRow> = {}): void {
  const level = overrides.level ?? "error";
  const row: SerializedConsoleRow = {
    id: Math.floor(Math.random() * 1e9),
    paneId: mockPaneId,
    level,
    cdpType: level,
    args: [],
    summaryText: "boom",
    timestamp: Date.now(),
    navigationGeneration: 0,
    groupDepth: 0,
    ...overrides,
  };
  useConsoleCaptureStore.getState().addStructuredMessage(row);
}

describe("ConsoleDrawer", () => {
  const getToggleButton = () => screen.getByRole("button", { name: "Toggle output drawer" });

  beforeEach(() => {
    vi.clearAllMocks();
    useConsoleCaptureStore.setState({ messages: new Map(), counters: new Map() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("XtermAdapter mounting", () => {
    it("renders XtermAdapter unconditionally even when closed", () => {
      renderDrawer({ defaultOpen: false });
      const adapter = screen.getByTestId("xterm-adapter");
      expect(adapter).toBeTruthy();
      expect(adapter.getAttribute("data-terminal-id")).toBe(mockTerminalId);
    });

    it("keeps XtermAdapter mounted when drawer is open", () => {
      renderDrawer({ defaultOpen: true });
      const adapter = screen.getByTestId("xterm-adapter");
      expect(adapter).toBeTruthy();
      expect(adapter.getAttribute("data-terminal-id")).toBe(mockTerminalId);
    });

    it("keeps XtermAdapter in DOM after toggling from open to closed", () => {
      renderDrawer({ defaultOpen: true });
      fireEvent.click(getToggleButton());
      expect(screen.getByTestId("xterm-adapter")).toBeTruthy();
    });

    it("keeps XtermAdapter mounted when the Console tab is active", () => {
      renderDrawer({ defaultOpen: true });
      fireEvent.click(screen.getByRole("tab", { name: /console/i }));
      // Output (PTY) must stay mounted so scrollback survives a tab switch.
      expect(screen.getByTestId("xterm-adapter")).toBeTruthy();
    });

    it("enables serialized restore on attach", () => {
      renderDrawer({ defaultOpen: false });
      const adapter = screen.getByTestId("xterm-adapter");
      expect(adapter.getAttribute("data-restore-on-attach")).toBe("true");
    });
  });

  describe("drawer visibility", () => {
    it("collapses to height 0 when closed by default", () => {
      const { container } = renderDrawer({ defaultOpen: false });
      const drawer = container.querySelector<HTMLElement>('[id^="console-drawer-"]');
      expect(drawer?.style.height).toBe("0px");
    });

    it("expands to a fixed height when open by default", () => {
      const { container } = renderDrawer({ defaultOpen: true });
      const drawer = container.querySelector<HTMLElement>('[id^="console-drawer-"]');
      expect(drawer?.style.height).toBe("300px");
    });

    it("toggles height when the button is clicked", () => {
      const { container } = renderDrawer({ defaultOpen: false });
      const drawer = container.querySelector<HTMLElement>('[id^="console-drawer-"]');

      expect(drawer?.style.height).toBe("0px");
      fireEvent.click(getToggleButton());
      expect(drawer?.style.height).toBe("300px");
    });
  });

  describe("toggle button", () => {
    it("uses a stable label that does not change with open state", () => {
      const { rerender } = renderDrawer({ isOpen: false });
      expect(screen.getByRole("button", { name: "Toggle output drawer" })).toBeTruthy();
      rerender(<ConsoleDrawer terminalId={mockTerminalId} paneId={mockPaneId} isOpen={true} />);
      // Same accessible name when open — state is conveyed by aria-expanded + icon.
      expect(screen.getByRole("button", { name: "Toggle output drawer" })).toBeTruthy();
    });

    it("sets aria-expanded to false when closed", () => {
      renderDrawer({ defaultOpen: false });
      expect(getToggleButton().getAttribute("aria-expanded")).toBe("false");
    });

    it("sets aria-expanded to true when open", () => {
      renderDrawer({ defaultOpen: true });
      expect(getToggleButton().getAttribute("aria-expanded")).toBe("true");
    });

    it("toggles aria-expanded on click", () => {
      renderDrawer({ defaultOpen: false });
      const button = getToggleButton();

      expect(button.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(button);
      expect(button.getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(button);
      expect(button.getAttribute("aria-expanded")).toBe("false");
    });

    it("rotates the chevron icon when open", () => {
      renderDrawer({ defaultOpen: false });
      const closedIcon = getToggleButton().querySelector("svg");
      expect(closedIcon?.getAttribute("class")).not.toContain("rotate-180");

      fireEvent.click(getToggleButton());
      const openIcon = getToggleButton().querySelector("svg");
      expect(openIcon?.getAttribute("class")).toContain("rotate-180");
    });
  });

  describe("tabs", () => {
    it("defaults to the Output tab", () => {
      renderDrawer({ defaultOpen: true });
      const outputTab = screen.getByRole("tab", { name: /output/i });
      expect(outputTab.getAttribute("aria-selected")).toBe("true");
    });

    it("activates the Console tab on click (uncontrolled)", () => {
      renderDrawer({ defaultOpen: true });
      const consoleTab = screen.getByRole("tab", { name: /console/i });
      fireEvent.click(consoleTab);
      expect(consoleTab.getAttribute("aria-selected")).toBe("true");
    });

    it("respects the controlled activeTab prop", () => {
      renderDrawer({ defaultOpen: true, activeTab: "console" });
      expect(screen.getByRole("tab", { name: /console/i }).getAttribute("aria-selected")).toBe(
        "true"
      );
    });

    it("calls onTabChange when a tab is selected", () => {
      const onTabChange = vi.fn();
      renderDrawer({ defaultOpen: true, activeTab: "output", onTabChange });
      fireEvent.click(screen.getByRole("tab", { name: /console/i }));
      expect(onTabChange).toHaveBeenCalledWith("console");
    });

    it("supports arrow-key navigation between tabs", () => {
      renderDrawer({ defaultOpen: true });
      const tablist = screen.getByRole("tablist");
      const outputTab = screen.getByRole("tab", { name: /output/i });
      outputTab.focus();
      fireEvent.keyDown(tablist, { key: "ArrowRight" });
      expect(screen.getByRole("tab", { name: /console/i }).getAttribute("aria-selected")).toBe(
        "true"
      );
    });

    it("shows an error-count badge on the Console tab", () => {
      seedConsoleRow({ level: "error" });
      seedConsoleRow({ level: "error" });
      renderDrawer({ defaultOpen: true });
      const consoleTab = screen.getByRole("tab", { name: /console/i });
      expect(consoleTab.textContent).toContain("2");
    });

    it("does not show a badge when there are no errors", () => {
      seedConsoleRow({ level: "warning" });
      renderDrawer({ defaultOpen: true });
      const consoleTab = screen.getByRole("tab", { name: /console/i });
      expect(consoleTab.textContent).toBe("Console");
    });
  });

  describe("tiered restart actions", () => {
    it("does not render restart controls without handler", () => {
      renderDrawer({ defaultOpen: false });
      expect(screen.queryByRole("button", { name: "Restart dev server" })).toBeNull();
      expect(screen.queryByRole("button", { name: "More restart options" })).toBeNull();
    });

    it("renders primary restart button and chevron when handler is provided", () => {
      renderDrawer({ defaultOpen: false, onRestartDevServer: vi.fn(), status: "running" });
      expect(screen.getByRole("button", { name: "Restart dev server" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "More restart options" })).toBeTruthy();
    });

    it("renders all four tier options in dropdown", () => {
      renderDrawer({
        defaultOpen: false,
        onReloadPreview: vi.fn(),
        onRestartDevServer: vi.fn(),
        onRequestRestartAndClearCache: vi.fn(),
        onRequestReinstallAndRestart: vi.fn(),
        status: "running",
      });
      expect(screen.getByRole("menuitem", { name: "Reload preview" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Restart dev server" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Restart and clear cache" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: "Reinstall dependencies" })).toBeTruthy();
    });

    it("calls onRestartDevServer when primary button is clicked", () => {
      const onRestartDevServer = vi.fn();
      renderDrawer({ defaultOpen: false, onRestartDevServer, status: "running" });

      const restartButton = screen.getByRole("button", { name: "Restart dev server" });
      fireEvent.click(restartButton);

      expect(onRestartDevServer).toHaveBeenCalledTimes(1);
    });

    it("calls tier callbacks when dropdown items are selected", () => {
      const onReloadPreview = vi.fn();
      const onRestartDevServer = vi.fn();
      const onRequestRestartAndClearCache = vi.fn();
      const onRequestReinstallAndRestart = vi.fn();

      renderDrawer({
        defaultOpen: false,
        onReloadPreview,
        onRestartDevServer,
        onRequestRestartAndClearCache,
        onRequestReinstallAndRestart,
        status: "running",
      });

      fireEvent.click(screen.getByRole("menuitem", { name: "Reload preview" }));
      expect(onReloadPreview).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("menuitem", { name: "Restart dev server" }));
      expect(onRestartDevServer).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("menuitem", { name: "Restart and clear cache" }));
      expect(onRequestRestartAndClearCache).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("menuitem", { name: "Reinstall dependencies" }));
      expect(onRequestReinstallAndRestart).toHaveBeenCalledTimes(1);
    });

    it("disables primary button and chevron while restarting", () => {
      renderDrawer({
        defaultOpen: false,
        onRestartDevServer: vi.fn(),
        status: "running",
        isRestarting: true,
      });

      const restartButton = screen.getByRole("button", { name: "Restart dev server" });
      expect(restartButton.getAttribute("disabled")).not.toBeNull();
      expect(restartButton.getAttribute("aria-busy")).toBe("true");
      expect(screen.getByText("Restarting")).toBeTruthy();

      const chevron = screen.getByRole("button", { name: "More restart options" });
      expect(chevron.getAttribute("disabled")).not.toBeNull();
    });

    it("disables primary button and chevron while starting", () => {
      renderDrawer({
        defaultOpen: false,
        onRestartDevServer: vi.fn(),
        status: "starting",
      });

      const restartButton = screen.getByRole("button", { name: "Restart dev server" });
      expect(restartButton.getAttribute("disabled")).not.toBeNull();

      const chevron = screen.getByRole("button", { name: "More restart options" });
      expect(chevron.getAttribute("disabled")).not.toBeNull();
    });

    it("enables primary while installing with warning tooltip", () => {
      renderDrawer({
        defaultOpen: false,
        onRestartDevServer: vi.fn(),
        status: "installing",
      });

      const restartButton = screen.getByRole("button", {
        name: "Restart dev server (may interrupt installation)",
      });
      expect(restartButton.getAttribute("disabled")).toBeNull();
    });

    it("disables destructive dropdown items while restarting or installing", () => {
      renderDrawer({
        defaultOpen: false,
        onRestartDevServer: vi.fn(),
        onRequestRestartAndClearCache: vi.fn(),
        onRequestReinstallAndRestart: vi.fn(),
        status: "installing",
      });

      expect(
        screen.getByRole("menuitem", { name: "Restart and clear cache" }).getAttribute("disabled")
      ).not.toBeNull();
      expect(
        screen.getByRole("menuitem", { name: "Reinstall dependencies" }).getAttribute("disabled")
      ).not.toBeNull();
    });
  });

  describe("dev-server status pill", () => {
    it("renders the status pill independently of panel-state frame signal", () => {
      renderDrawer({ defaultOpen: false, status: "running" });
      expect(screen.getByText("Running")).toBeTruthy();
    });
  });

  describe("terminalInstanceService integration", () => {
    it("calls setVisible with false when initially closed", () => {
      renderDrawer({ defaultOpen: false });
      expect(terminalInstanceService.setVisible).toHaveBeenCalledWith(mockTerminalId, false);
    });

    it("calls setVisible with true when open on the Output tab", () => {
      renderDrawer({ defaultOpen: true });
      expect(terminalInstanceService.setVisible).toHaveBeenCalledWith(mockTerminalId, true);
    });

    it("drops the terminal to background when the Console tab is active", () => {
      renderDrawer({ defaultOpen: true });
      vi.clearAllMocks();
      fireEvent.click(screen.getByRole("tab", { name: /console/i }));
      expect(terminalInstanceService.setVisible).toHaveBeenLastCalledWith(mockTerminalId, false);
    });

    it("supports controlled open state", () => {
      const onOpenChange = vi.fn();
      const { rerender } = render(
        <ConsoleDrawer
          terminalId={mockTerminalId}
          paneId={mockPaneId}
          isOpen={false}
          onOpenChange={onOpenChange}
        />
      );

      fireEvent.click(getToggleButton());
      expect(onOpenChange).toHaveBeenCalledWith(true);
      expect(terminalInstanceService.setVisible).toHaveBeenLastCalledWith(mockTerminalId, false);

      rerender(
        <ConsoleDrawer
          terminalId={mockTerminalId}
          paneId={mockPaneId}
          isOpen={true}
          onOpenChange={onOpenChange}
        />
      );
      expect(terminalInstanceService.setVisible).toHaveBeenLastCalledWith(mockTerminalId, true);
    });
  });

  describe("refresh tier management", () => {
    it("provides VISIBLE refresh tier when open on the Output tab", () => {
      renderDrawer({ defaultOpen: true });
      expect(screen.getByTestId("refresh-tier").textContent).toBe(
        TerminalRefreshTier.VISIBLE.toString()
      );
    });

    it("provides BACKGROUND refresh tier when drawer is closed", () => {
      renderDrawer({ defaultOpen: false });
      expect(screen.getByTestId("refresh-tier").textContent).toBe(
        TerminalRefreshTier.BACKGROUND.toString()
      );
    });

    it("drops to BACKGROUND tier when the Console tab is active", () => {
      renderDrawer({ defaultOpen: true });
      fireEvent.click(screen.getByRole("tab", { name: /console/i }));
      expect(screen.getByTestId("refresh-tier").textContent).toBe(
        TerminalRefreshTier.BACKGROUND.toString()
      );
    });
  });

  describe("drawer container", () => {
    it("has overflow-hidden class to prevent content leak", () => {
      const { container } = renderDrawer({ defaultOpen: false });
      const drawer = container.querySelector('[id^="console-drawer-"]');
      expect(drawer?.className).toContain("overflow-hidden");
    });

    it("has transition-[height] for smooth animation", () => {
      const { container } = renderDrawer({ defaultOpen: false });
      const drawer = container.querySelector('[id^="console-drawer-"]');
      expect(drawer?.className).toContain("transition-[height]");
    });

    it("sets correct aria-controls id", () => {
      renderDrawer({ defaultOpen: false });
      expect(getToggleButton().getAttribute("aria-controls")).toBe(
        `console-drawer-${mockTerminalId}`
      );
    });

    it("toggles aria-hidden when drawer state changes", () => {
      const { container } = renderDrawer({ defaultOpen: false });
      const drawer = container.querySelector('[id^="console-drawer-"]');

      expect(drawer?.getAttribute("aria-hidden")).toBe("true");
      fireEvent.click(getToggleButton());
      expect(drawer?.getAttribute("aria-hidden")).toBe("false");
    });
  });
});
