/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, cleanup, fireEvent } from "@testing-library/react";
import { renderWorkspaceRootMenu, renderWorktreeMenu, zeroCounts } from "./worktreeMenuHarness";

afterEach(cleanup);

const liveCounts = { ...zeroCounts, active: 3, all: 3, grid: 3 };

function item(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name: new RegExp(`^${name}, \\d+$`) }) as HTMLButtonElement;
}

describe("WorktreeMenuItems — Park agents / Unpark agents (#13236)", () => {
  it("counts each row by the agents it would change", () => {
    renderWorktreeMenu({
      counts: liveCounts,
      parking: { parked: 1, unparked: 2 },
      onParkAgents: vi.fn(),
      onUnparkAgents: vi.fn(),
    });

    expect(item("Park agents").getAttribute("aria-label")).toBe("Park agents, 2");
    expect(item("Unpark agents").getAttribute("aria-label")).toBe("Unpark agents, 1");
    expect(item("Park agents").disabled).toBe(false);
    expect(item("Unpark agents").disabled).toBe(false);
  });

  it("runs the matching callback with no confirmation step", () => {
    const onParkAgents = vi.fn();
    const onUnparkAgents = vi.fn();
    renderWorktreeMenu({
      counts: liveCounts,
      parking: { parked: 1, unparked: 2 },
      onParkAgents,
      onUnparkAgents,
    });

    fireEvent.click(item("Park agents"));
    fireEvent.click(item("Unpark agents"));

    expect(onParkAgents).toHaveBeenCalledTimes(1);
    expect(onUnparkAgents).toHaveBeenCalledTimes(1);
  });

  it("disables the side with nothing to change but keeps the inverse visible", () => {
    renderWorktreeMenu({
      counts: liveCounts,
      parking: { parked: 0, unparked: 2 },
      onParkAgents: vi.fn(),
      onUnparkAgents: vi.fn(),
    });

    expect(item("Park agents").disabled).toBe(false);
    expect(item("Unpark agents").disabled).toBe(true);
  });

  it("omits the group when the worktree has no agents on the fleet", () => {
    renderWorktreeMenu({
      counts: liveCounts,
      parking: { parked: 0, unparked: 0 },
      onParkAgents: vi.fn(),
      onUnparkAgents: vi.fn(),
    });

    expect(screen.queryByText("Park agents")).toBeNull();
    expect(screen.queryByText("Parking")).toBeNull();
  });

  it("omits the group for a caller that passes no parking state", () => {
    renderWorktreeMenu({ counts: liveCounts });

    expect(screen.queryByText("Park agents")).toBeNull();
  });

  it("omits the group on a workspace root", () => {
    renderWorkspaceRootMenu({
      parking: { parked: 1, unparked: 1 },
      onParkAgents: vi.fn(),
      onUnparkAgents: vi.fn(),
    });

    expect(screen.queryByText("Park agents")).toBeNull();
  });
});
