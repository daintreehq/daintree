// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryPressureGate } from "../MemoryPressureGate";

vi.mock("@/config/agents", () => ({
  getAgentConfig: (id: string) => (id === "claude" ? { name: "Claude" } : undefined),
}));

describe("MemoryPressureGate", () => {
  it("names the held agent and states the reading", () => {
    render(<MemoryPressureGate agentId="claude" onLaunchAnyway={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText("Waiting to start Claude")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("critical level");
  });

  it("falls back to the agent id when the registry has no name for it", () => {
    render(<MemoryPressureGate agentId="custom" onLaunchAnyway={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText("Waiting to start custom")).toBeTruthy();
  });

  it("launches anyway and cancels from its own buttons", () => {
    const onLaunchAnyway = vi.fn();
    const onCancel = vi.fn();
    render(
      <MemoryPressureGate agentId="claude" onLaunchAnyway={onLaunchAnyway} onCancel={onCancel} />
    );

    fireEvent.click(screen.getByRole("button", { name: "Launch anyway" }));
    expect(onLaunchAnyway).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
