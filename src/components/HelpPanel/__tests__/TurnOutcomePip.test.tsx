// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));

// Passthrough tooltip: the footer mounts the provider, which a unit render of
// this component alone does not have.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: unknown }) => children,
  TooltipTrigger: ({ children }: { children: unknown }) => children,
  TooltipContent: () => null,
}));

import { TurnOutcomePip } from "../TurnOutcomePip";

describe("TurnOutcomePip", () => {
  it("renders nothing when there is no pending outcome", () => {
    const { container } = render(<TurnOutcomePip outcome={null} onDismiss={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("labels agent-stuck distinctly from reasoning-loop", () => {
    const { rerender } = render(<TurnOutcomePip outcome="agent-stuck" onDismiss={vi.fn()} />);
    const stuck = screen.getByRole("button").querySelector(".font-medium")!.textContent;

    rerender(<TurnOutcomePip outcome="reasoning-loop" onDismiss={vi.fn()} />);
    const loop = screen.getByRole("button").querySelector(".font-medium")!.textContent;
    expect(stuck).toBeTruthy();
    expect(loop).toBeTruthy();
    expect(stuck).not.toBe(loop);
  });

  it("calls onDismiss when clicked", () => {
    const onDismiss = vi.fn();
    render(<TurnOutcomePip outcome="agent-stuck" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it.each(["agent-stuck", "reasoning-loop"] as const)(
    "keeps the visible %s label inside the accessible name and names the dismiss action",
    (outcome) => {
      render(<TurnOutcomePip outcome={outcome} onDismiss={vi.fn()} />);
      const button = screen.getByRole("button");
      const visible = button.querySelector(".font-medium")!.textContent!.trim().toLowerCase();
      const name = button.getAttribute("aria-label")!.toLowerCase();
      expect(name).toContain(visible);
      expect(name).toMatch(/dismiss/);
      const description = document.getElementById(button.getAttribute("aria-describedby")!);
      expect(description?.textContent).toMatch(/click to dismiss/i);
    }
  );
});
