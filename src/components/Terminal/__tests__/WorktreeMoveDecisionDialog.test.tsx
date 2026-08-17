// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

class ResizeObserverStub implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;

const resolveDecision = vi.fn<(request: unknown, outcome: string) => Promise<void>>(() =>
  Promise.resolve()
);

vi.mock("@/services/terminal/worktreeMoveDecision", () => ({
  resolveWorktreeMoveDecision: (request: unknown, outcome: string) =>
    resolveDecision(request, outcome),
}));

import { useWorktreeMoveDecisionStore } from "@/store/worktreeMoveDecisionStore";
import { WorktreeMoveDecisionDialog } from "../WorktreeMoveDecisionDialog";

beforeEach(() => {
  cleanup();
  resolveDecision.mockClear();
  useWorktreeMoveDecisionStore.getState().clear();
});

function stageSingle(): void {
  useWorktreeMoveDecisionStore.getState().request({
    transactionId: 1,
    destinationWorktreeId: "wt-feature",
    destinationWorktreeLabel: "feature",
    sourceWorktreeId: "wt-main",
    lockedPanelIds: ["t1"],
    alignOnlyPanelIds: [],
    members: [
      {
        panelId: "t1",
        title: "Codex",
        alignment: "launch-root-mismatch",
        launchCwd: "/repo",
        launchWorktreeId: "wt-main",
        launchWorktreeLabel: "main",
      },
    ],
    agentLabel: "Codex",
  });
}

function stageGroup(): void {
  useWorktreeMoveDecisionStore.getState().request({
    transactionId: 2,
    destinationWorktreeId: "wt-feature",
    destinationWorktreeLabel: "feature",
    sourceWorktreeId: "wt-main",
    lockedPanelIds: ["t1", "t2"],
    alignOnlyPanelIds: [],
    groupId: "g1",
    members: [
      {
        panelId: "t1",
        title: "Codex one",
        alignment: "launch-root-mismatch",
        launchWorktreeLabel: "main",
      },
      { panelId: "t2", title: "Codex two", alignment: "unknown" },
    ],
  });
}

describe("WorktreeMoveDecisionDialog", () => {
  it("renders nothing until a decision is pending", () => {
    render(<WorktreeMoveDecisionDialog />);
    expect(screen.queryByTestId("worktree-move-decision-dialog")).toBeNull();
  });

  it("names where the process actually runs rather than the abstraction", () => {
    stageSingle();
    render(<WorktreeMoveDecisionDialog />);

    expect(screen.getByText(/still running in main/i)).toBeTruthy();
    expect(screen.getByText(/doesn't change where its commands and commits land/i)).toBeTruthy();
  });

  it("offers all three outcomes and routes each to the resolver", () => {
    stageSingle();
    render(<WorktreeMoveDecisionDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Transfer session" }));
    expect(resolveDecision.mock.calls[0]?.[1]).toBe("transfer");

    cleanup();
    resolveDecision.mockClear();
    stageSingle();
    render(<WorktreeMoveDecisionDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Move panel only" }));
    expect(resolveDecision.mock.calls[0]?.[1]).toBe("move-only");

    cleanup();
    resolveDecision.mockClear();
    stageSingle();
    render(<WorktreeMoveDecisionDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(resolveDecision.mock.calls[0]?.[1]).toBe("cancel");
  });

  it("cancels on Escape rather than accepting the divergence", () => {
    stageSingle();
    render(<WorktreeMoveDecisionDialog />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(resolveDecision.mock.calls[0]?.[1]).toBe("cancel");
  });

  it("resolves a group as one decision while naming every member", () => {
    stageGroup();
    render(<WorktreeMoveDecisionDialog />);

    expect(screen.getByText("Codex one")).toBeTruthy();
    expect(screen.getByText("Codex two")).toBeTruthy();
    // An unresolvable launch root is reported as unknown, never as a location.
    expect(screen.getByText("location unknown")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Transfer session" }));
    expect(resolveDecision).toHaveBeenCalledTimes(1);
  });

  it("ignores repeat clicks while an outcome is in flight", () => {
    stageSingle();
    render(<WorktreeMoveDecisionDialog />);

    const transfer = screen.getByRole("button", { name: "Transfer session" });
    fireEvent.click(transfer);
    fireEvent.click(transfer);

    expect(resolveDecision).toHaveBeenCalledTimes(1);
  });
});
