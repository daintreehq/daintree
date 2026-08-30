// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const { mockUseAnimatedPresence } = vi.hoisted(() => ({
  mockUseAnimatedPresence: vi.fn(),
}));

vi.mock("../../../hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: mockUseAnimatedPresence,
}));

import { ScrollIndicator } from "../ScrollIndicator";

describe("ScrollIndicator", () => {
  const onClick = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAnimatedPresence.mockImplementation(({ isOpen }: { isOpen: boolean }) => ({
      isVisible: isOpen,
      shouldRender: isOpen,
    }));
  });

  it("slides up when exiting in the above direction", () => {
    mockUseAnimatedPresence.mockReturnValue({ isVisible: false, shouldRender: true });
    render(<ScrollIndicator direction="above" count={1} onClick={onClick} />);
    const button = screen.getByRole("button");
    expect(button.className).toContain("opacity-0");
    expect(button.className).toContain("-translate-y-2");
  });

  it("slides down when exiting in the below direction", () => {
    mockUseAnimatedPresence.mockReturnValue({ isVisible: false, shouldRender: true });
    render(<ScrollIndicator direction="below" count={1} onClick={onClick} />);
    const button = screen.getByRole("button");
    expect(button.className).toContain("opacity-0");
    expect(button.className).toContain("translate-y-2");
    expect(button.className.split(/\s+/)).not.toContain("-translate-y-2");
  });

  it("does not render when count is 0", () => {
    const { container } = render(<ScrollIndicator direction="below" count={0} onClick={onClick} />);
    expect(container.innerHTML).toBe("");
  });

  it("does not render when count is negative", () => {
    const { container } = render(
      <ScrollIndicator direction="below" count={-1} onClick={onClick} />
    );
    expect(container.innerHTML).toBe("");
  });

  // The visible pill is chevron + count only, so it stays narrow enough to sit
  // in the trailing gutter without reaching the row's identity text (#12010).
  // Direction is carried by the icon, the edge it sits on, and the aria-label.
  it.each([
    ["below", 3],
    ["above", 5],
  ] as const)("renders only the count for direction %s", (direction, count) => {
    render(<ScrollIndicator direction={direction} count={count} onClick={onClick} />);
    expect(screen.getByRole("button").textContent?.trim()).toBe(String(count));
  });

  it("calls onClick when clicked", () => {
    render(<ScrollIndicator direction="below" count={2} onClick={onClick} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("has correct aria-label for below direction", () => {
    render(<ScrollIndicator direction="below" count={3} onClick={onClick} />);
    expect(screen.getByLabelText("Scroll down, 3 more below")).toBeTruthy();
  });

  it("has correct aria-label for above direction", () => {
    render(<ScrollIndicator direction="above" count={5} onClick={onClick} />);
    expect(screen.getByLabelText("Scroll up, 5 more above")).toBeTruthy();
  });

  it("uses translate-y-0 when visible (below)", () => {
    render(<ScrollIndicator direction="below" count={1} onClick={onClick} />);
    const button = screen.getByRole("button");
    expect(button.className).toContain("translate-y-0");
    expect(button.className).toContain("opacity-100");
  });

  it("forwards tabIndex to the button element", () => {
    render(<ScrollIndicator direction="below" count={1} onClick={onClick} tabIndex={-1} />);
    const button = screen.getByRole("button");
    expect(button.tabIndex).toBe(-1);
  });

  it("defaults button tabIndex to 0 when not specified", () => {
    render(<ScrollIndicator direction="below" count={1} onClick={onClick} />);
    const button = screen.getByRole("button");
    expect(button.tabIndex).toBe(0);
  });

  it("applies aria-hidden on the outer wrapper when ariaHidden is true", () => {
    render(<ScrollIndicator direction="below" count={1} onClick={onClick} ariaHidden />);
    const button = screen.getByRole("button", { hidden: true });
    expect(button.parentElement!.getAttribute("aria-hidden")).toBe("true");
  });

  it("does not render aria-hidden attribute on wrapper when ariaHidden is false or undefined", () => {
    render(<ScrollIndicator direction="below" count={1} onClick={onClick} />);
    const button = screen.getByRole("button");
    expect(button.parentElement!.hasAttribute("aria-hidden")).toBe(false);
  });

  it("keeps showing the last positive count while fading out at count 0 (issue #10316)", () => {
    // Exit state: shouldRender stays true through the close animation while the
    // live count has already dropped to 0. The pill must render the latched
    // count, not a bare "0" — and its aria-label must latch with it.
    mockUseAnimatedPresence.mockReturnValue({ isVisible: false, shouldRender: true });
    const { rerender } = render(<ScrollIndicator direction="below" count={4} onClick={onClick} />);
    expect(screen.getByText("4")).toBeTruthy();

    rerender(<ScrollIndicator direction="below" count={0} onClick={onClick} />);
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
    expect(screen.getByLabelText("Scroll down, 4 more below")).toBeTruthy();
  });

  it("uses scoped transition-[opacity,translate] instead of bare transition", () => {
    // `translate` (not `transform`) because Tailwind v4 translate-* utilities
    // emit the individual `translate` property, which a `transform` entry in
    // the transition list does not cover.
    render(<ScrollIndicator direction="below" count={1} onClick={onClick} />);
    const button = screen.getByRole("button");
    expect(button.className).toContain("transition-[opacity,translate]");
    expect(button.className.split(/\s+/)).not.toContain("transition");
  });
});
