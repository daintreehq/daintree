// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const { dispatchMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: dispatchMock,
  },
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

import { GettingStartedChecklist } from "../GettingStartedChecklist";
import type { ChecklistState } from "@shared/types/ipc/maps";

const allIncomplete: ChecklistState = {
  dismissed: false,
  celebrationShown: false,
  items: { openedProject: false, launchedAgent: false, createdWorktree: false },
};

const allComplete: ChecklistState = {
  dismissed: false,
  celebrationShown: false,
  items: { openedProject: true, launchedAgent: true, createdWorktree: true },
};

const mixedState: ChecklistState = {
  dismissed: false,
  celebrationShown: false,
  items: { openedProject: true, launchedAgent: false, createdWorktree: false },
};

describe("GettingStartedChecklist", () => {
  const defaultProps = {
    collapsed: false,
    onDismiss: vi.fn(),
    onToggleCollapse: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders incomplete steps as buttons", () => {
    render(<GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />);

    const buttons = screen.getAllByRole("button", {
      name: /open a project|launch an ai agent|create a worktree/i,
    });
    expect(buttons).toHaveLength(3);
  });

  it("renders completed steps as non-interactive divs that still show labels", () => {
    render(<GettingStartedChecklist {...defaultProps} checklist={allComplete} />);

    const stepButtons = screen.queryAllByRole("button", {
      name: /open a project|launch an ai agent|create a worktree/i,
    });
    expect(stepButtons).toHaveLength(0);

    expect(screen.getByText("Open a project")).toBeTruthy();
    expect(screen.getByText("Launch an AI agent")).toBeTruthy();
    expect(screen.getByText("Create a worktree")).toBeTruthy();
  });

  it("renders mixed state correctly — only incomplete steps are buttons", () => {
    render(<GettingStartedChecklist {...defaultProps} checklist={mixedState} />);

    const stepButtons = screen.getAllByRole("button", {
      name: /launch an ai agent|create a worktree/i,
    });
    expect(stepButtons).toHaveLength(2);

    const completedButton = screen.queryByRole("button", { name: /open a project/i });
    expect(completedButton).toBeNull();
  });

  it("dispatches project.openDialog when 'Open a project' is clicked", () => {
    render(<GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />);

    fireEvent.click(screen.getByRole("button", { name: /open a project/i }));
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith("project.openDialog", undefined, { source: "user" });
  });

  it("dispatches panel.palette when 'Launch an AI agent' is clicked", () => {
    render(<GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />);

    fireEvent.click(screen.getByRole("button", { name: /launch an ai agent/i }));
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith("panel.palette", undefined, { source: "user" });
  });

  it("dispatches worktree.createDialog.open when 'Create a worktree' is clicked", () => {
    render(<GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />);

    fireEvent.click(screen.getByRole("button", { name: /create a worktree/i }));
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith("worktree.createDialog.open", undefined, {
      source: "user",
    });
  });

  it("does not call onDismiss or onToggleCollapse when a step is clicked", () => {
    render(<GettingStartedChecklist {...defaultProps} checklist={allIncomplete} />);

    fireEvent.click(screen.getByRole("button", { name: /open a project/i }));
    expect(defaultProps.onDismiss).not.toHaveBeenCalled();
    expect(defaultProps.onToggleCollapse).not.toHaveBeenCalled();
  });
});
