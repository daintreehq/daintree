// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, fireEvent } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: TooltipProvider });

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

  // The number is bare on screen; the name is where the noun lives.
  // The action names what the jump lands on: waiting rows win over problems,
  // so with both past the edge it says "needs attention".
  it.each([
    ["below", 3, 0, 0, "3 more worktrees below. Click to show the next page"],
    ["above", 1, 0, 0, "1 more worktree above. Click to show the next page"],
    ["below", 7, 1, 0, "7 more worktrees below, 1 needs attention. Click to show it"],
    [
      "above",
      7,
      2,
      0,
      "7 more worktrees above, 2 need attention. Click to show the nearest that needs attention",
    ],
    ["below", 4, 0, 1, "4 more worktrees below, 1 reports a problem. Click to show it"],
    [
      "below",
      4,
      0,
      2,
      "4 more worktrees below, 2 report a problem. Click to show the nearest problem",
    ],
    [
      "above",
      5,
      1,
      1,
      "5 more worktrees above, 1 needs attention, 1 reports a problem. Click to show the nearest that needs attention",
    ],
  ] as const)(
    "names %s with %i hidden, %i needing attention, %i reporting a problem",
    (direction, count, attentionCount, problemCount, name) => {
      render(
        <ScrollIndicator
          direction={direction}
          count={count}
          attentionCount={attentionCount}
          problemCount={problemCount}
          problemTone={problemCount > 0 ? "warning" : null}
          onClick={onClick}
        />
      );
      expect(screen.getByRole("button").getAttribute("aria-label")).toBe(name);
    }
  );

  it("marks a problem past the edge only when it has a tone to draw", () => {
    const { rerender } = render(
      <ScrollIndicator
        direction="below"
        count={4}
        problemCount={1}
        problemTone="error"
        onClick={onClick}
      />
    );
    expect(screen.queryByTestId("scroll-indicator-problem-mark")).not.toBeNull();

    rerender(<ScrollIndicator direction="below" count={4} problemCount={0} onClick={onClick} />);
    expect(screen.queryByTestId("scroll-indicator-problem-mark")).toBeNull();
  });

  it("draws the error and warning problem marks as different glyphs", () => {
    const markFor = (tone: "error" | "warning") => {
      const { unmount } = render(
        <ScrollIndicator
          direction="below"
          count={4}
          problemCount={1}
          problemTone={tone}
          onClick={onClick}
        />
      );
      const html = screen.getByTestId("scroll-indicator-problem-mark").outerHTML;
      unmount();
      return html;
    };
    expect(markFor("error")).not.toBe(markFor("warning"));
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

  it("applies aria-hidden on the outer wrapper when ariaHidden is true", () => {
    render(<ScrollIndicator direction="below" count={1} onClick={onClick} ariaHidden />);
    const button = screen.getByRole("button", { hidden: true });
    expect(button.parentElement!.getAttribute("aria-hidden")).toBe("true");
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
    expect(screen.getByRole("button").getAttribute("aria-label")).toMatch(
      /^4 more worktrees below\./
    );
  });

  const attentionMark = () => screen.queryByTestId("scroll-indicator-attention-mark");

  it("shows the attention mark only while something past this edge needs it", () => {
    const { rerender } = render(<ScrollIndicator direction="below" count={6} onClick={onClick} />);
    expect(attentionMark()).toBeNull();
    rerender(<ScrollIndicator direction="below" count={6} attentionCount={1} onClick={onClick} />);
    expect(attentionMark()).not.toBeNull();
    // A live pill never keeps a mark for a worktree that no longer needs attention.
    rerender(<ScrollIndicator direction="below" count={6} attentionCount={0} onClick={onClick} />);
    expect(attentionMark()).toBeNull();
  });

  it("latches the attention mark together with the count through the fade-out", () => {
    mockUseAnimatedPresence.mockReturnValue({ isVisible: false, shouldRender: true });
    const { rerender } = render(
      <ScrollIndicator direction="above" count={3} attentionCount={1} onClick={onClick} />
    );
    rerender(<ScrollIndicator direction="above" count={0} attentionCount={0} onClick={onClick} />);
    expect(screen.getByText("3")).toBeTruthy();
    expect(attentionMark()).not.toBeNull();
  });

  it("does not take focus on a pointer press", () => {
    render(<ScrollIndicator direction="below" count={2} onClick={onClick} />);
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    screen.getByRole("button").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  // The band covers rows that are past the list's edge, so a press on it acts
  // on nothing beneath and doesn't move focus, but still reads as an outside
  // press to an open popover. Only the pill acts; a wheel scrolls the list.
  describe("the band the pill sits in", () => {
    const band = () => document.querySelector<HTMLElement>("[data-sidebar-scroll-indicator]")!;

    it("takes a press on its empty part without acting or taking focus", () => {
      render(<ScrollIndicator direction="below" count={2} onClick={onClick} />);
      const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      band().dispatchEvent(press);
      fireEvent.click(band());

      expect(press.defaultPrevented).toBe(true);
      expect(onClick).not.toHaveBeenCalled();
    });

    // Radix dismisses an open popover from a document-level pointerdown.
    it("lets a press reach the document, so an open popover closes", () => {
      const onDocumentPointerDown = vi.fn();
      document.addEventListener("pointerdown", onDocumentPointerDown);
      try {
        render(<ScrollIndicator direction="below" count={2} onClick={onClick} />);
        fireEvent.pointerDown(band());
        fireEvent.pointerDown(screen.getByRole("button"));
        expect(onDocumentPointerDown).toHaveBeenCalledTimes(2);
      } finally {
        document.removeEventListener("pointerdown", onDocumentPointerDown);
      }
    });

    it("hands a wheel anywhere over it to the list", () => {
      const onWheel = vi.fn();
      render(<ScrollIndicator direction="above" count={2} onClick={onClick} onWheel={onWheel} />);
      fireEvent.wheel(band(), { deltaY: 40 });
      fireEvent.wheel(screen.getByRole("button"), { deltaY: -40 });
      expect(onWheel.mock.calls.map(([event]) => event.deltaY)).toEqual([40, -40]);
    });

    // Once the count drops, the rows it is uncovering are back on screen.
    it("goes inert while it fades out", () => {
      const onWheel = vi.fn();
      const { rerender } = render(
        <ScrollIndicator direction="below" count={2} onClick={onClick} onWheel={onWheel} />
      );
      mockUseAnimatedPresence.mockReturnValue({ isVisible: false, shouldRender: true });
      rerender(<ScrollIndicator direction="below" count={0} onClick={onClick} onWheel={onWheel} />);

      fireEvent.click(screen.getByRole("button"));
      fireEvent.wheel(band(), { deltaY: 40 });
      expect(onClick).not.toHaveBeenCalled();
      expect(onWheel).not.toHaveBeenCalled();
    });

    // jsdom doesn't hit-test, so this reads the merged classes: the pill's
    // primitive bakes in `pointer-events-auto`, which must give way on exit.
    it("lets presses fall through to the rows while it fades out", () => {
      const classes = (el: Element) => el.className.split(/\s+/);
      const { rerender } = render(
        <ScrollIndicator direction="below" count={2} onClick={onClick} />
      );
      expect(classes(band())).not.toContain("pointer-events-none");
      expect(classes(screen.getByRole("button"))).toContain("pointer-events-auto");

      mockUseAnimatedPresence.mockReturnValue({ isVisible: false, shouldRender: true });
      rerender(<ScrollIndicator direction="below" count={0} onClick={onClick} />);
      expect(classes(band())).toContain("pointer-events-none");
      expect(classes(screen.getByRole("button"))).not.toContain("pointer-events-auto");
      expect(classes(screen.getByRole("button"))).toContain("pointer-events-none");
    });

    it("leaves with the pill", () => {
      const { rerender, container } = render(
        <ScrollIndicator direction="below" count={2} onClick={onClick} />
      );
      expect(band()).not.toBeNull();
      rerender(<ScrollIndicator direction="below" count={0} onClick={onClick} />);
      expect(container.innerHTML).toBe("");
    });
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
