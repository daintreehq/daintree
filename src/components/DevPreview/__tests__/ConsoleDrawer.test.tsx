/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConsoleDrawer } from "../ConsoleDrawer";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";

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

describe("ConsoleDrawer", () => {
  const mockTerminalId = "test-terminal-id";
  const getToggleButton = () => screen.getByRole("button", { name: /(?:show|hide) terminal/i });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("XtermAdapter mounting", () => {
    it("renders XtermAdapter unconditionally even when closed", () => {
      render(<ConsoleDrawer terminalId={mockTerminalId} defaultOpen={false} />);
      const adapter = screen.getByTestId("xterm-adapter");
      expect(adapter).toBeTruthy();
      expect(adapter.getAttribute("data-terminal-id")).toBe(mockTerminalId);
    });

    it("keeps XtermAdapter mounted when drawer is open", () => {
      render(<ConsoleDrawer terminalId={mockTerminalId} defaultOpen={true} />);
      const adapter = screen.getByTestId("xterm-adapter");
      expect(adapter).toBeTruthy();
      expect(adapter.getAttribute("data-terminal-id")).toBe(mockTerminalId);
    });

    it("keeps XtermAdapter in DOM after toggling from open to closed", () => {
      render(<ConsoleDrawer terminalId={mockTerminalId} defaultOpen={true} />);

      const button = getToggleButton();
      fireEvent.click(button);

      const adapter = screen.getByTestId("xterm-adapter");
      expect(adapter).toBeTruthy();
    });

    it("enables serialized restore on attach", () => {
      render(<ConsoleDrawer terminalId={mockTerminalId} defaultOpen={false} />);
      const adapter = screen.getByTestId("xterm-adapter");
      expect(adapter.getAttribute("data-restore-on-attach")).toBe("true");
    });
  });

  describe("drawer visibility", () => {
    it("renders with h-0 class when closed by default", () => {
      const { container } = render(
        <ConsoleDrawer terminalId={mockTerminalId} defaultOpen={false} />
      );
      const drawer = container.querySelector('[id^="console-drawer-"]');
      expect(drawer?.className).toContain("h-0");
      expect(drawer?.className).not.toContain("h-[300px]");
    });

    it("renders with h-[300px] class when open by default", () => {
      const { container } = render(
        <ConsoleDrawer terminalId={mockTerminalId} defaultOpen={true} />
      );
      const drawer = container.querySelector('[id^="console-drawer-"]');
      expect(drawer?.className).toContain("h-[300px]");
      expect(drawer?.className).not.toContain("h-0");
    });

    it("toggles height class when button is clicked", () => {
      const { container } = render(
        <ConsoleDrawer terminalId={mockTerminalId} defaultOpen={false} />
      );
      const drawer = container.querySelector('[id^="console-drawer-"]');

      expect(drawer?.className).toContain("h-0");

      const button = getToggleButton();
      fireEvent.click(button);

      expect(drawer?.className).toContain("h-[300px]");
      expect(drawer?.className).not.toContain("h-0");
    });

    it("inner container always has h-[300px] class", () => {
      const { container } = render(
        <ConsoleDrawer terminalId={mockTerminalId} defaultOpen={false} />
      );
      const innerContainer = container.querySelector(".h-\\[300px\\].bg-black");
      expect(innerContainer).toBeTruthy();
      expect(innerContainer?.className).toContain("h-[300px]");
    });
  });

  describe("button state", () => {
    it("displays 'Show Terminal' when closed", () => {
      render(<ConsoleDrawer terminalId={mockTerminalId} defaultOpen={false} />);
      expect(screen.getByText("Show Terminal")).toBeTruthy();
    });

    it("displays 'Hide Terminal' when open", () => {
      render(<ConsoleDrawer terminalId={mockTerminalId} defaultOpen={true} />);
      expect(screen.getByText("Hide Terminal")).toBeTruthy();
    });

    it("sets aria-expanded to false when closed", () => {
      render(<ConsoleDrawer terminalId={mockTerminalId} defaultOpen={false} />);
      const button = getToggleButton();
      expect(button.getAttribute("aria-expanded")).toBe("false");
    });

    it("sets aria-expanded to true when open", () => {
      render(<ConsoleDrawer terminalId={mockTerminalId} defaultOpen={true} />);
      const button = getToggleButton();
      expect(button.getAttribute("aria-expanded")).toBe("true");
    });

    it("toggles aria-expanded on click", () => {
      render(<ConsoleDrawer terminalId={mockTerminalId} defaultOpen={false} />);
      const button = getToggleButton();

      expect(button.getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(button);
      expect(button.getAttribute("aria-expanded")).toBe("true");

      fireEvent.click(button);
      expect(button.getAttribute("aria-expanded")).toBe("false");
    });

    it("uses an upward icon for 'Show Terminal' and rotates when open", () => {
      render(<ConsoleDrawer terminalId={mockTerminalId} defaultOpen={false} />);
      const closedButton = getToggleButton();
      const closedIcon = closedButton.querySelector("svg");
      expect(closedIcon?.getAttribute("class")).not.toContain("rotate-180");

      fireEvent.click(closedButton);
      const openButton = getToggleButton();
      const openIcon = openButton.querySelector("svg");
      expect(openIcon?.getAttribute("class")).toContain("rotate-180");
    });
  });

  describe("hard restart action", () => {
    it("does not render restart button without handler", () => {
      render(<ConsoleDrawer terminalId={mockTerminalId} defaultOpen={false} />);
      expect(screen.queryByRole("button", { name: "Hard restart dev preview" })).toBeNull();
    });

    it("renders restart button when handler is provided", () => {
      render(
        <ConsoleDrawer
          terminalId={mockTerminalId}
          defaultOpen={false}
          onHardRestart={vi.fn()}
          status="running"
        />
      );
      expect(screen.getByRole("button", { name: "Hard restart dev preview" })).toBeTruthy();
    });

    it("calls onHardRestart when restart button is clicked", () => {
      const onHardRestart = vi.fn();
      render(
        <ConsoleDrawer
          terminalId={mockTerminalId}
          defaultOpen={false}
          onHardRestart={onHardRestart}
          status="running"
        />
      );

      const restartButton = screen.getByRole("button", { name: "Hard restart dev preview" });
      fireEvent.click(restartButton);

      expect(onHardRestart).toHaveBeenCalledTimes(1);
    });

    it("disables restart button while restarting", () => {
      render(
        <ConsoleDrawer
          terminalId={mockTerminalId}
          defaultOpen={false}
          onHardRestart={vi.fn()}
          status="running"
          isRestarting={true}
        />
      );

      const restartButton = screen.getByRole("button", { name: "Hard restart dev preview" });
      expect(restartButton.getAttribute("disabled")).not.toBeNull();
      expect(restartButton.getAttribute("aria-busy")).toBe("true");
      expect(screen.getByText("Restarting")).toBeTruthy();
    });

    it("disables restart button while starting", () => {
      render(
        <ConsoleDrawer
          terminalId={mockTerminalId}
          defaultOpen={false}
          onHardRestart={vi.fn()}
          status="starting"
        />
      );

      const restartButton = screen.getByRole("button", { name: "Hard restart dev preview" });
      expect(restartButton.getAttribute("disabled")).not.toBeNull();
    });

    it("disables restart button while installing", () => {
      render(
        <ConsoleDrawer
          terminalId={mockTerminalId}
          defaultOpen={false}
          onHardRestart={vi.fn()}
          status="installing"
        />
      );

      const restartButton = screen.getByRole("button", { name: "Hard restart dev preview" });
      expect(restartButton.getAttribute("disabled")).not.toBeNull();
    });
  });

  describe("terminalInstanceService integration", () => {
    it("calls setVisible with false when initially closed", () => {
      render(<ConsoleDrawer terminalId={mockTerminalId} defaultOpen={false} />);
      expect(terminalInstanceService.setVisible).toHaveBeenCalledWith(mockTerminalId, false);
    });

    it("calls setVisible with true when initially open", () => {
      render(<ConsoleDrawer terminalId={mockTerminalId} defaultOpen={true} />);
      expect(terminalInstanceService.setVisible).toHaveBeenCalledWith(mockTerminalId, true);
    });

    it("calls setVisible on toggle from closed to open", () => {
      render(<ConsoleDrawer terminalId={mockTerminalId} defaultOpen={false} />);

      vi.clearAllMocks();

      const button = getToggleButton();
      fireEvent.click(button);

      expect(terminalInstanceService.setVisible).toHaveBeenCalledTimes(1);
      expect(terminalInstanceService.setVisible).toHaveBeenCalledWith(mockTerminalId, true);
    });

    it("calls setVisible bidirectionally (open -> closed -> open)", () => {
      render(<ConsoleDrawer terminalId={mockTerminalId} defaultOpen={true} />);

      vi.clearAllMocks();

      const button = getToggleButton();

      fireEvent.click(button);
      expect(terminalInstanceService.setVisible).toHaveBeenCalledWith(mockTerminalId, false);

      fireEvent.click(button);
      expect(terminalInstanceService.setVisible).toHaveBeenCalledWith(mockTerminalId, true);

      expect(terminalInstanceService.setVisible).toHaveBeenCalledTimes(2);
    });

    it("handles terminalId change while closed", () => {
      const { rerender } = render(<ConsoleDrawer terminalId="terminal-1" defaultOpen={false} />);

      vi.clearAllMocks();

      rerender(<ConsoleDrawer terminalId="terminal-2" defaultOpen={false} />);

      expect(terminalInstanceService.setVisible).toHaveBeenCalledWith("terminal-2", false);
    });

    it("handles terminalId change while open", () => {
      const { rerender } = render(<ConsoleDrawer terminalId="terminal-1" defaultOpen={true} />);

      vi.clearAllMocks();

      rerender(<ConsoleDrawer terminalId="terminal-2" defaultOpen={true} />);

      expect(terminalInstanceService.setVisible).toHaveBeenCalledWith("terminal-2", true);
    });

    it("supports controlled open state", () => {
      const onOpenChange = vi.fn();
      const { rerender } = render(
        <ConsoleDrawer terminalId={mockTerminalId} isOpen={false} onOpenChange={onOpenChange} />
      );

      const button = getToggleButton();
      fireEvent.click(button);

      expect(onOpenChange).toHaveBeenCalledWith(true);
      expect(terminalInstanceService.setVisible).toHaveBeenLastCalledWith(mockTerminalId, false);

      rerender(
        <ConsoleDrawer terminalId={mockTerminalId} isOpen={true} onOpenChange={onOpenChange} />
      );

      expect(terminalInstanceService.setVisible).toHaveBeenLastCalledWith(mockTerminalId, true);
    });
  });

  describe("refresh tier management", () => {
    it("provides VISIBLE refresh tier when drawer is open", () => {
      render(<ConsoleDrawer terminalId={mockTerminalId} defaultOpen={true} />);
      const tierDisplay = screen.getByTestId("refresh-tier");
      expect(tierDisplay.textContent).toBe(TerminalRefreshTier.VISIBLE.toString());
    });

    it("provides BACKGROUND refresh tier when drawer is closed", () => {
      render(<ConsoleDrawer terminalId={mockTerminalId} defaultOpen={false} />);
      const tierDisplay = screen.getByTestId("refresh-tier");
      expect(tierDisplay.textContent).toBe(TerminalRefreshTier.BACKGROUND.toString());
    });

    it("updates refresh tier bidirectionally (closed -> open -> closed)", () => {
      render(<ConsoleDrawer terminalId={mockTerminalId} defaultOpen={false} />);

      let tierDisplay = screen.getByTestId("refresh-tier");
      expect(tierDisplay.textContent).toBe(TerminalRefreshTier.BACKGROUND.toString());

      const button = getToggleButton();
      fireEvent.click(button);

      tierDisplay = screen.getByTestId("refresh-tier");
      expect(tierDisplay.textContent).toBe(TerminalRefreshTier.VISIBLE.toString());

      fireEvent.click(button);

      tierDisplay = screen.getByTestId("refresh-tier");
      expect(tierDisplay.textContent).toBe(TerminalRefreshTier.BACKGROUND.toString());
    });
  });

  describe("drawer container", () => {
    it("has overflow-hidden class to prevent content leak", () => {
      const { container } = render(
        <ConsoleDrawer terminalId={mockTerminalId} defaultOpen={false} />
      );
      const drawer = container.querySelector('[id^="console-drawer-"]');
      expect(drawer?.className).toContain("overflow-hidden");
    });

    it("has transition-[height] for smooth animation", () => {
      const { container } = render(
        <ConsoleDrawer terminalId={mockTerminalId} defaultOpen={false} />
      );
      const drawer = container.querySelector('[id^="console-drawer-"]');
      expect(drawer?.className).toContain("transition-[height]");
    });

    it("sets correct aria-controls id", () => {
      render(<ConsoleDrawer terminalId={mockTerminalId} defaultOpen={false} />);
      const button = getToggleButton();
      expect(button.getAttribute("aria-controls")).toBe(`console-drawer-${mockTerminalId}`);
    });

    it("sets aria-hidden to true when drawer is closed", () => {
      const { container } = render(
        <ConsoleDrawer terminalId={mockTerminalId} defaultOpen={false} />
      );
      const drawer = container.querySelector('[id^="console-drawer-"]');
      expect(drawer?.getAttribute("aria-hidden")).toBe("true");
    });

    it("sets aria-hidden to false when drawer is open", () => {
      const { container } = render(
        <ConsoleDrawer terminalId={mockTerminalId} defaultOpen={true} />
      );
      const drawer = container.querySelector('[id^="console-drawer-"]');
      expect(drawer?.getAttribute("aria-hidden")).toBe("false");
    });

    it("toggles aria-hidden when drawer state changes", () => {
      const { container } = render(
        <ConsoleDrawer terminalId={mockTerminalId} defaultOpen={false} />
      );
      const drawer = container.querySelector('[id^="console-drawer-"]');

      expect(drawer?.getAttribute("aria-hidden")).toBe("true");

      const button = getToggleButton();
      fireEvent.click(button);

      expect(drawer?.getAttribute("aria-hidden")).toBe("false");
    });
  });
});
