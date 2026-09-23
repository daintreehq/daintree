// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

let mockHasUnseenOutput = false;

vi.mock("@/hooks/useUnseenOutput", () => ({
  useUnseenOutput: () => ({
    hasUnseenOutput: mockHasUnseenOutput,
    isUserScrolledBack: mockHasUnseenOutput,
  }),
}));

const { mockUseAnimatedPresence } = vi.hoisted(() => ({
  mockUseAnimatedPresence: vi.fn(),
}));

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: mockUseAnimatedPresence,
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    resumeAutoScroll: vi.fn(),
    focus: vi.fn(),
  },
}));

import { TerminalScrollIndicator } from "../TerminalScrollIndicator";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TERMINAL_SCROLLBAR_WIDTH } from "@/config/xtermConfig";

describe("TerminalScrollIndicator", () => {
  beforeEach(() => {
    mockHasUnseenOutput = false;
    vi.clearAllMocks();
    mockUseAnimatedPresence.mockImplementation(({ isOpen }: { isOpen: boolean }) => ({
      isVisible: isOpen,
      shouldRender: isOpen,
    }));
  });

  it("requests instant-hide via animationDuration: 0", () => {
    mockHasUnseenOutput = true;
    render(<TerminalScrollIndicator terminalId="t1" />);
    expect(mockUseAnimatedPresence).toHaveBeenCalledWith(
      expect.objectContaining({ animationDuration: 0 })
    );
  });

  it("does not render when hasUnseenOutput is false", () => {
    mockHasUnseenOutput = false;
    const { container } = render(<TerminalScrollIndicator terminalId="t1" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders pill when hasUnseenOutput is true", () => {
    mockHasUnseenOutput = true;
    render(<TerminalScrollIndicator terminalId="t1" />);
    expect(screen.getByText("New output below")).toBeTruthy();
  });

  it("calls resumeAutoScroll when clicked", () => {
    mockHasUnseenOutput = true;
    render(<TerminalScrollIndicator terminalId="t1" />);
    fireEvent.click(screen.getByRole("button"));
    expect(terminalInstanceService.resumeAutoScroll).toHaveBeenCalledWith("t1");
  });

  it("keeps the visible label at the start of the accessible name (WCAG 2.5.3)", () => {
    mockHasUnseenOutput = true;
    render(<TerminalScrollIndicator terminalId="t1" />);
    const button = screen.getByRole("button");
    const visible = button.textContent?.trim() ?? "";
    expect(visible.length).toBeGreaterThan(0);
    const name = button.getAttribute("aria-label") ?? visible;
    expect(name.toLowerCase().startsWith(visible.toLowerCase())).toBe(true);
  });

  it("keeps the pill clear of xterm's scrollbar track", () => {
    mockHasUnseenOutput = true;
    const { container } = render(<TerminalScrollIndicator terminalId="t1" />);
    const overlay = container.firstElementChild;
    if (!(overlay instanceof HTMLElement)) throw new Error("no overlay rendered");
    // XtermAdapter's `pr-3` wrapper padding, inside which xterm draws the track.
    const XTERM_WRAPPER_PADDING = 12;
    const inset = parseFloat(overlay.style.paddingRight);
    expect(inset).toBeGreaterThan(XTERM_WRAPPER_PADDING + TERMINAL_SCROLLBAR_WIDTH);
    expect(overlay.className.split(/\s+/).some((c) => /^pr-/.test(c))).toBe(false);
  });

  it("restores terminal focus after clicking pill", () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return 0;
    });

    mockHasUnseenOutput = true;
    render(<TerminalScrollIndicator terminalId="t1" />);
    fireEvent.click(screen.getByRole("button"));

    expect(rafCallbacks.length).toBeGreaterThan(0);
    rafCallbacks[rafCallbacks.length - 1]!(0);
    expect(terminalInstanceService.focus).toHaveBeenCalledWith("t1");

    rafSpy.mockRestore();
  });
});
