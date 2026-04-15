// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../../../hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

import { ScrollIndicator } from "../ScrollIndicator";

describe("ScrollIndicator", () => {
  const onClick = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
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

  it("renders pill when count > 0 with direction below", () => {
    render(<ScrollIndicator direction="below" count={3} onClick={onClick} />);
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("more below")).toBeTruthy();
  });

  it("renders pill when count > 0 with direction above", () => {
    render(<ScrollIndicator direction="above" count={5} onClick={onClick} />);
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("more above")).toBeTruthy();
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

  it("uses pointer-events-none on container and pointer-events-auto on button", () => {
    render(<ScrollIndicator direction="below" count={1} onClick={onClick} />);
    const button = screen.getByRole("button");
    const container = button.parentElement!;
    expect(container.className).toContain("pointer-events-none");
    expect(button.className).toContain("pointer-events-auto");
  });

  it("applies bottom-0 positioning for below direction", () => {
    render(<ScrollIndicator direction="below" count={1} onClick={onClick} />);
    const button = screen.getByRole("button");
    const container = button.parentElement!;
    expect(container.className).toContain("bottom-0");
  });

  it("applies top-0 positioning for above direction", () => {
    render(<ScrollIndicator direction="above" count={1} onClick={onClick} />);
    const button = screen.getByRole("button");
    const container = button.parentElement!;
    expect(container.className).toContain("top-0");
  });

  it("applies pill styling classes", () => {
    render(<ScrollIndicator direction="below" count={1} onClick={onClick} />);
    const button = screen.getByRole("button");
    expect(button.className).toContain("rounded-full");
    expect(button.className).toContain("bg-daintree-bg/90");
  });

  it("uses translate-y-0 when visible (below)", () => {
    render(<ScrollIndicator direction="below" count={1} onClick={onClick} />);
    const button = screen.getByRole("button");
    expect(button.className).toContain("translate-y-0");
    expect(button.className).toContain("opacity-100");
  });
});
