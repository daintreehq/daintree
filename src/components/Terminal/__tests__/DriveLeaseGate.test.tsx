// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DriveLeaseGate } from "../DriveLeaseGate";

vi.mock("@/config/agents", () => ({
  getAgentConfig: (id: string) => (id === "claude" ? { name: "Claude" } : undefined),
}));

describe("DriveLeaseGate", () => {
  it("names the waiting agent and what it waits for", () => {
    render(<DriveLeaseGate agentId="claude" />);

    expect(screen.getByRole("status").textContent).toContain(
      "Claude starts here once this window has control of the project."
    );
  });

  it("falls back to the agent id when the registry has no name for it", () => {
    render(<DriveLeaseGate agentId="custom" />);

    expect(screen.getByRole("status").textContent).toContain("custom starts here");
  });

  it("speaks of the terminal for a plain shell", () => {
    render(<DriveLeaseGate />);

    expect(screen.getByRole("status").textContent).toContain("The terminal starts here");
  });

  it("offers no action of its own: Take control is the pane strip's", () => {
    render(<DriveLeaseGate agentId="claude" />);

    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
