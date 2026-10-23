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

describe("MemoryPressureGate at the host's agent limit (#14221)", () => {
  const observation = {
    kernelCritical: false,
    runningAgents: 8,
    startingAgents: 0,
    agentLaunchLimit: 8,
    memoryTotalBytes: 36 * 1024 ** 3,
  };

  it("states the host's count and the memory its limit comes from", () => {
    render(
      <MemoryPressureGate
        agentId="claude"
        detail={{ reason: "agent-capacity", observation }}
        onLaunchAnyway={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    const status = screen.getByRole("status").textContent ?? "";
    expect(status).toContain("8 agents are running on this host");
    expect(status).toContain("36 GB of memory");
    expect(status).not.toContain("critical");
    expect(screen.getByRole("button", { name: "Launch anyway" })).toBeTruthy();
  });

  it("counts launches the host has started but not yet seen running", () => {
    render(
      <MemoryPressureGate
        agentId="claude"
        detail={{
          reason: "agent-capacity",
          observation: { ...observation, runningAgents: 7, startingAgents: 1 },
        }}
        onLaunchAnyway={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByRole("status").textContent).toContain(
      "8 agents are running or starting on this host"
    );
  });

  it("states the kernel reading for a pressure hold", () => {
    render(
      <MemoryPressureGate
        agentId="claude"
        detail={{ reason: "kernel-critical", observation: { ...observation, kernelCritical: true } }}
        onLaunchAnyway={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByRole("status").textContent).toContain("critical level");
  });
});
