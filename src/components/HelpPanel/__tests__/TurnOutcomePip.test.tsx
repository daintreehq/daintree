// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));

import { TurnOutcomePip } from "../TurnOutcomePip";

describe("TurnOutcomePip", () => {
  it("renders nothing when there is no pending outcome", () => {
    const { container } = render(<TurnOutcomePip outcome={null} onDismiss={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("labels agent-stuck distinctly from reasoning-loop", () => {
    const { rerender } = render(<TurnOutcomePip outcome="agent-stuck" onDismiss={vi.fn()} />);
    expect(screen.getByText("Stopped early")).toBeTruthy();

    rerender(<TurnOutcomePip outcome="reasoning-loop" onDismiss={vi.fn()} />);
    expect(screen.getByText("Repeating steps")).toBeTruthy();
  });

  it("calls onDismiss when clicked", () => {
    const onDismiss = vi.fn();
    render(<TurnOutcomePip outcome="agent-stuck" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("exposes an accessible label describing the outcome", () => {
    const { rerender } = render(<TurnOutcomePip outcome="reasoning-loop" onDismiss={vi.fn()} />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toMatch(
      /repeating the same step/i
    );

    rerender(<TurnOutcomePip outcome="agent-stuck" onDismiss={vi.fn()} />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toMatch(
      /stopped early without finishing/i
    );
  });
});
