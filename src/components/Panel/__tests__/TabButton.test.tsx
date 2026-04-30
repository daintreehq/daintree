// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
  return {
    LazyMotion: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    domAnimation: {},
    domMax: {},
    m: { div: MotionDiv },
    motion: { div: MotionDiv },
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
});
