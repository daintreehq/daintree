// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TabButton } from "../TabButton";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});

vi.mock("framer-motion", () => ({
  motion: {
    div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
      ({ children, ...props }, ref) => {
        const {
          layoutId: _layoutId,
          layout: _layout,
          transition: _transition,
          ...rest
        } = props as Record<string, unknown>;
        return (
          <div
            ref={ref}
            data-testid="motion-div"
            {...(rest as React.HTMLAttributes<HTMLDivElement>)}
          >
            {children}
          </div>
        );
      }
    ),
  },
}));

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
  agentId: "claude",
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
});
