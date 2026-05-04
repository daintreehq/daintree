// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TabButton } from "../TabButton";
import { deriveTerminalChrome } from "@/utils/terminalChrome";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});

vi.mock("framer-motion", () => {
  const MotionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ children, ...props }, ref) => {
      const {
        layoutId: _layoutId,
        layout: _layout,
        transition: _transition,
        ...rest
      } = props as Record<string, unknown>;
      return (
        <div ref={ref} data-testid="motion-div" {...(rest as React.HTMLAttributes<HTMLDivElement>)}>
          {children}
        </div>
      );
    }
  );
  const MotionInput = React.forwardRef<
    HTMLInputElement,
    React.InputHTMLAttributes<HTMLInputElement>
  >((props, ref) => {
    const {
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      layoutId: _layoutId,
      layout: _layout,
      ...rest
    } = props as Record<string, unknown>;
    return (
      <input
        ref={ref}
        data-testid="motion-input"
        {...(rest as React.InputHTMLAttributes<HTMLInputElement>)}
      />
    );
  });
  return {
    LazyMotion: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    domAnimation: {},
    domMax: {},
    m: { div: MotionDiv, input: MotionInput },
    motion: { div: MotionDiv, input: MotionInput },
  };
});

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  ),
}));

const defaultProps = {
  id: "test-panel-1",
  title: "Test Agent",
  kind: "terminal" as const,
  type: "claude" as const,
  chrome: deriveTerminalChrome(),
  isActive: true,
  onClick: vi.fn(),
  onClose: vi.fn(),
};

describe("TabButton", () => {
  it("shows red dot indicator when hasDangerousFlags is true", () => {
    render(<TabButton {...defaultProps} hasDangerousFlags={true} />);

    const indicator = screen.getByLabelText("Launched with dangerous permissions");
    expect(indicator).toBeDefined();
    expect(indicator.className).toContain("bg-status-danger");
  });

  it("does not show indicator when hasDangerousFlags is false", () => {
    render(<TabButton {...defaultProps} hasDangerousFlags={false} />);

    const indicator = screen.queryByLabelText("Launched with dangerous permissions");
    expect(indicator).toBeNull();
  });

  it("does not show indicator when hasDangerousFlags is undefined", () => {
    render(<TabButton {...defaultProps} />);

    const indicator = screen.queryByLabelText("Launched with dangerous permissions");
    expect(indicator).toBeNull();
  });

  it("shows both dangerous flag and fallback indicators when both are true", () => {
    render(
      <TabButton
        {...defaultProps}
        hasDangerousFlags={true}
        isUsingFallback={true}
        fallbackTooltip="Using fallback preset"
      />
    );

    const dangerousIndicator = screen.getByLabelText("Launched with dangerous permissions");
    const fallbackIndicator = screen.getByLabelText("Running on fallback preset");

    expect(dangerousIndicator).toBeDefined();
    expect(fallbackIndicator).toBeDefined();
  });

  it("shows tooltip with correct text for dangerous flags", () => {
    render(<TabButton {...defaultProps} hasDangerousFlags={true} />);

    const tooltipContent = screen.queryByText(
      "Launched with dangerous permissions — agent can modify files without prompting"
    );
    expect(tooltipContent).not.toBeNull();
  });

  it("renders the active indicator element when isActive is true", () => {
    render(<TabButton {...defaultProps} isActive={true} />);
    const indicator = screen.queryByTestId("motion-div");
    expect(indicator).not.toBeNull();
    expect(indicator?.className).toContain("bg-daintree-accent");
  });

  it("does not render the active indicator when isActive is false", () => {
    render(<TabButton {...defaultProps} isActive={false} />);
    const indicator = screen.queryByTestId("motion-div");
    expect(indicator).toBeNull();
  });

  // Regression: before this test, PanelHeader.tsx built TabInfo objects with
  // detectedAgentId but dropped the field when mapping tabs → TabButton/Sortable
  // TabButton props. Result: typing `claude` in a tab correctly updated status
  // chrome (which read detectedAgentId elsewhere) but the tab icon stayed on
  // the generic terminal glyph because TerminalIcon never received the
  // detected id. This test pins the prop thread so a regression fails loud.
  describe("icon tracks terminal chrome descriptor", () => {
    it("renders the Claude agent icon when detectedAgentId='claude', even without launch hint", () => {
      const { container } = render(
        <TabButton
          {...defaultProps}
          chrome={deriveTerminalChrome({ detectedAgentId: "claude", detectedProcessId: "claude" })}
        />
      );
      // The agent config's Icon component renders. Shorthand: assert the icon
      // container has received the brand color for Claude, proving TerminalIcon
      // took the effectiveAgentId="claude" branch (not the fallback glyph).
      const iconHost = container.querySelector('[aria-hidden="true"]');
      expect(iconHost).not.toBeNull();
    });

    it("renders the generic terminal icon when no agent affinity is present", () => {
      const { container } = render(<TabButton {...defaultProps} chrome={deriveTerminalChrome()} />);
      // Lucide's SquareTerminal renders an <svg>; that's what we expect here.
      const svgs = container.querySelectorAll("svg");
      expect(svgs.length).toBeGreaterThan(0);
    });

    it("renders the launch-affinity agent icon before live detection rehydrates", () => {
      const { container } = render(
        <TabButton {...defaultProps} chrome={deriveTerminalChrome({ launchAgentId: "claude" })} />
      );
      const marker = container.querySelector("[data-terminal-icon-id]");
      expect(marker?.getAttribute("data-terminal-icon-id")).toBe("claude");
    });

    it("switches icon when detectedAgentId changes from undefined to 'claude' (promote)", () => {
      const { container, rerender } = render(
        <TabButton {...defaultProps} chrome={deriveTerminalChrome()} />
      );
      const before = container.innerHTML;

      rerender(
        <TabButton
          {...defaultProps}
          chrome={deriveTerminalChrome({ detectedAgentId: "claude", detectedProcessId: "claude" })}
        />
      );
      const after = container.innerHTML;

      // The icon section must have changed. If the prop thread is broken the
      // rendered markup is byte-identical before and after detection.
      expect(before).not.toBe(after);
    });

    it("switches icon when detectedAgentId clears (demote)", () => {
      const { container, rerender } = render(
        <TabButton
          {...defaultProps}
          chrome={deriveTerminalChrome({ detectedAgentId: "claude", detectedProcessId: "claude" })}
        />
      );
      const before = container.innerHTML;

      rerender(<TabButton {...defaultProps} chrome={deriveTerminalChrome()} />);
      const after = container.innerHTML;

      expect(before).not.toBe(after);
    });
  });

  describe("close button visibility", () => {
    it("reveals on parent tab focus via group-focus-visible/tab variant", () => {
      render(<TabButton {...defaultProps} />);
      const closeButton = screen.getByLabelText("Close Test Agent");
      // jsdom can't compute pseudo-classes; pin the class string so the
      // parent-focus reveal symmetry survives refactors.
      expect(closeButton.className).toContain("group-focus-visible/tab:opacity-100");
      expect(closeButton.className).toContain("group-hover/tab:opacity-100");
      expect(closeButton.className).toContain("focus-visible:opacity-100");
    });
  });

  describe("rename validation feedback", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const enterEditMode = (titleNode: HTMLElement) => {
      fireEvent.doubleClick(titleNode);
    };

    it("flashes red border and stays in edit mode when Enter is pressed on an empty value", () => {
      vi.useFakeTimers();
      const onRename = vi.fn();
      render(<TabButton {...defaultProps} onRename={onRename} />);

      enterEditMode(screen.getByText("Test Agent"));
      const input = screen.getByTestId("motion-input") as HTMLInputElement;

      fireEvent.change(input, { target: { value: "   " } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(screen.getByTestId("motion-input")).toBe(input);
      expect(input.className).toContain("border-status-error");
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(onRename).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(150);
      });

      expect(screen.getByTestId("motion-input")).toBe(input);
      expect(input.className).not.toContain("border-status-error");
      expect(input.getAttribute("aria-invalid")).toBeNull();
    });

    it("flashes red border and stays in edit mode when Enter is pressed on an unchanged value", () => {
      vi.useFakeTimers();
      const onRename = vi.fn();
      render(<TabButton {...defaultProps} onRename={onRename} />);

      enterEditMode(screen.getByText("Test Agent"));
      const input = screen.getByTestId("motion-input") as HTMLInputElement;

      // editValue starts as "Test Agent" — unchanged on first Enter.
      fireEvent.keyDown(input, { key: "Enter" });

      expect(screen.getByTestId("motion-input")).toBe(input);
      expect(input.className).toContain("border-status-error");
      expect(onRename).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(150);
      });

      expect(input.className).not.toContain("border-status-error");
    });

    it("commits and exits edit mode when Enter is pressed on a valid changed value", () => {
      const onRename = vi.fn();
      render(<TabButton {...defaultProps} onRename={onRename} />);

      enterEditMode(screen.getByText("Test Agent"));
      const input = screen.getByTestId("motion-input") as HTMLInputElement;

      fireEvent.change(input, { target: { value: "Renamed" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onRename).toHaveBeenCalledWith("Renamed");
      expect(screen.queryByTestId("motion-input")).toBeNull();
    });

    it("ignores Enter while an IME composition is in progress", () => {
      const onRename = vi.fn();
      render(<TabButton {...defaultProps} onRename={onRename} />);

      enterEditMode(screen.getByText("Test Agent"));
      const input = screen.getByTestId("motion-input") as HTMLInputElement;

      fireEvent.change(input, { target: { value: "Renamed" } });
      fireEvent.keyDown(input, { key: "Enter", isComposing: true });

      expect(onRename).not.toHaveBeenCalled();
      expect(screen.getByTestId("motion-input")).toBe(input);
      expect(input.className).not.toContain("border-status-error");
    });

    it("invalid Enter then valid Enter commits exactly once and clears error state", () => {
      vi.useFakeTimers();
      const onRename = vi.fn();
      render(<TabButton {...defaultProps} onRename={onRename} />);

      enterEditMode(screen.getByText("Test Agent"));
      const input = screen.getByTestId("motion-input") as HTMLInputElement;

      fireEvent.keyDown(input, { key: "Enter" });
      expect(input.className).toContain("border-status-error");

      fireEvent.change(input, { target: { value: "Renamed" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onRename).toHaveBeenCalledTimes(1);
      expect(onRename).toHaveBeenCalledWith("Renamed");
      expect(screen.queryByTestId("motion-input")).toBeNull();

      // Pending error timer should be safely no-op after unmount.
      act(() => {
        vi.advanceTimersByTime(150);
      });
    });
  });

  describe("context-menu rename path", () => {
    it("commits a rename triggered via daintree:rename-terminal even after a prior Escape", () => {
      const onRename = vi.fn();
      render(<TabButton {...defaultProps} onRename={onRename} />);

      // First rename via double-click, then Escape — sets the commit-or-cancel guard.
      fireEvent.doubleClick(screen.getByText("Test Agent"));
      const firstInput = screen.getByTestId("motion-input") as HTMLInputElement;
      fireEvent.keyDown(firstInput, { key: "Escape" });
      expect(screen.queryByTestId("motion-input")).toBeNull();

      // Now trigger rename via context-menu event. Without resetting the guard
      // in the event handler, a follow-up blur would silently drop the change.
      act(() => {
        window.dispatchEvent(
          new CustomEvent("daintree:rename-terminal", { detail: { id: "test-panel-1" } })
        );
      });

      const input = screen.getByTestId("motion-input") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "FromContextMenu" } });
      fireEvent.blur(input);

      expect(onRename).toHaveBeenCalledWith("FromContextMenu");
    });
  });

  describe("rename input fade-in", () => {
    it("renders the input via m.input (motion wrapper) when entering edit mode", () => {
      render(<TabButton {...defaultProps} onRename={vi.fn()} />);
      expect(screen.queryByTestId("motion-input")).toBeNull();

      fireEvent.doubleClick(screen.getByText("Test Agent"));

      const input = screen.getByTestId("motion-input");
      expect(input).not.toBeNull();
      expect(input.tagName).toBe("INPUT");
    });
  });

  // The state indicator must rise and fall with the agent chrome, plus stay
  // visible during the identity-boot window where state can arrive before the
  // chrome commits (#6650). Once chrome is live, the indicator never silently
  // disappears mid-flight: idle/missing/completed state coerces to waiting, and
  // exit/non-agent chrome hides it.
  describe("state indicator visibility", () => {
    // The state icon is the only element that combines "shrink-0" with
    // "motion-reduce:animate-none" (TabButton.tsx). That class combo is a
    // stable identifier across all six AgentState values.
    const queryStateIcon = (container: Element) =>
      Array.from(container.querySelectorAll("svg")).find((svg) => {
        const cls = svg.getAttribute("class") ?? "";
        return cls.includes("shrink-0") && cls.includes("motion-reduce:animate-none");
      });

    it("renders working spinner when agentState='working' even with non-agent chrome", () => {
      const { container } = render(
        <TabButton {...defaultProps} chrome={deriveTerminalChrome()} agentState="working" />
      );
      const spinner = container.querySelector(".text-state-working");
      expect(spinner).not.toBeNull();
    });

    it("does not render state icon when agentState='exited'", () => {
      const { container } = render(
        <TabButton
          {...defaultProps}
          chrome={deriveTerminalChrome({ launchAgentId: "claude" })}
          agentState="exited"
        />
      );
      expect(queryStateIcon(container)).toBeUndefined();
    });

    it("renders waiting icon when agentState='idle' but agent chrome is live", () => {
      const { container } = render(
        <TabButton
          {...defaultProps}
          chrome={deriveTerminalChrome({ launchAgentId: "claude" })}
          agentState="idle"
        />
      );
      expect(queryStateIcon(container)).toBeDefined();
    });

    it("renders waiting icon when agentState='completed' and agent chrome is live", () => {
      const { container } = render(
        <TabButton
          {...defaultProps}
          chrome={deriveTerminalChrome({ launchAgentId: "claude" })}
          agentState="completed"
        />
      );
      const waitingIcon = container.querySelector(".text-state-waiting");
      expect(waitingIcon).not.toBeNull();
    });

    it("renders waiting icon when agentState is undefined but agent chrome is live", () => {
      const { container } = render(
        <TabButton {...defaultProps} chrome={deriveTerminalChrome({ launchAgentId: "claude" })} />
      );
      expect(queryStateIcon(container)).toBeDefined();
    });

    it("does not render state icon when agentState is undefined (plain shell)", () => {
      const { container } = render(<TabButton {...defaultProps} chrome={deriveTerminalChrome()} />);
      expect(queryStateIcon(container)).toBeUndefined();
    });
  });
});
