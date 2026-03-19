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

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    resumeAutoScroll: vi.fn(),
  },
}));

import { TerminalScrollIndicator } from "../TerminalScrollIndicator";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

describe("TerminalScrollIndicator", () => {
  beforeEach(() => {
    mockHasUnseenOutput = false;
    vi.clearAllMocks();
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

  it("has correct accessible label", () => {
    mockHasUnseenOutput = true;
    render(<TerminalScrollIndicator terminalId="t1" />);
    expect(screen.getByLabelText("Scroll to latest output")).toBeTruthy();
  });

  it("uses pointer-events-none on container and pointer-events-auto on button", () => {
    mockHasUnseenOutput = true;
    render(<TerminalScrollIndicator terminalId="t1" />);
    const button = screen.getByRole("button");
    const container = button.parentElement!;
    expect(container.className).toContain("pointer-events-none");
    expect(button.className).toContain("pointer-events-auto");
  });
});
