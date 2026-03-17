// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockActivateTerminal = vi.fn();
const mockSelectWorktree = vi.fn();
const mockTrackTerminalFocus = vi.fn();

const { useWaitingTerminalsMock, useConflictedWorktreesMock } = vi.hoisted(() => ({
  useWaitingTerminalsMock: vi.fn((): Record<string, unknown>[] => []),
  useConflictedWorktreesMock: vi.fn((): Record<string, unknown>[] => []),
}));

vi.mock("@/hooks/useTerminalSelectors", () => ({
  useWaitingTerminals: useWaitingTerminalsMock,
  useConflictedWorktrees: useConflictedWorktreesMock,
}));

vi.mock("@/store/terminalStore", () => ({
  useTerminalStore: {
    getState: () => ({
      activateTerminal: mockActivateTerminal,
    }),
  },
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => ({
      activeWorktreeId: "wt-active",
      selectWorktree: mockSelectWorktree,
      trackTerminalFocus: mockTrackTerminalFocus,
    }),
  },
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

import { AttentionBar } from "../AttentionBar";

function makeTerminal(overrides: Record<string, unknown> = {}) {
  return {
    id: "t-1",
    title: "Claude Agent",
    worktreeId: "wt-active",
    agentState: "waiting",
    location: "grid",
    ...overrides,
  };
}

function makeWorktree(overrides: Record<string, unknown> = {}) {
  return {
    id: "wt-conflict",
    worktreeId: "wt-conflict",
    name: "feature-branch",
    branch: "feature/fix-bug",
    worktreeChanges: {
      changes: [{ status: "conflicted", path: "file.ts", insertions: null, deletions: null }],
    },
    lastActivityTimestamp: Date.now(),
    ...overrides,
  };
}

describe("AttentionBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWaitingTerminalsMock.mockReturnValue([]);
    useConflictedWorktreesMock.mockReturnValue([]);
  });

  it("renders nothing when no items exist", () => {
    const { container } = render(<AttentionBar />);
    expect(container.innerHTML).toBe("");
  });

  it("shows a blocked agent item", () => {
    useWaitingTerminalsMock.mockReturnValue([makeTerminal()]);

    render(<AttentionBar />);
    expect(screen.getByText("Claude Agent")).toBeTruthy();
  });

  it("shows a conflict item with branch name", () => {
    useConflictedWorktreesMock.mockReturnValue([makeWorktree()]);

    render(<AttentionBar />);
    expect(screen.getByText("feature/fix-bug")).toBeTruthy();
  });

  it("shows agents before conflicts", () => {
    useWaitingTerminalsMock.mockReturnValue([makeTerminal({ id: "t-1", title: "Agent A" })]);
    useConflictedWorktreesMock.mockReturnValue([makeWorktree()]);

    render(<AttentionBar />);
    const buttons = screen.getAllByRole("listitem");
    expect(buttons[0].textContent).toContain("Agent A");
    expect(buttons[1].textContent).toContain("feature/fix-bug");
  });

  it("limits visible items to 3 and shows overflow count", () => {
    useWaitingTerminalsMock.mockReturnValue([
      makeTerminal({ id: "t-1", title: "Agent 1" }),
      makeTerminal({ id: "t-2", title: "Agent 2" }),
      makeTerminal({ id: "t-3", title: "Agent 3" }),
      makeTerminal({ id: "t-4", title: "Agent 4" }),
    ]);

    render(<AttentionBar />);
    const allItems = screen.getAllByRole("listitem");
    const chipButtons = allItems.filter((el) => el.tagName === "BUTTON");
    expect(chipButtons).toHaveLength(3);
    expect(screen.getByText("+1 more")).toBeTruthy();
  });

  it("calls activateTerminal when clicking an agent item on same worktree", () => {
    useWaitingTerminalsMock.mockReturnValue([makeTerminal({ id: "t-1", worktreeId: "wt-active" })]);

    render(<AttentionBar />);
    fireEvent.click(screen.getByText("Claude Agent"));
    expect(mockActivateTerminal).toHaveBeenCalledWith("t-1");
    expect(mockTrackTerminalFocus).not.toHaveBeenCalled();
  });

  it("switches worktree then activates terminal when agent is on different worktree", () => {
    useWaitingTerminalsMock.mockReturnValue([makeTerminal({ id: "t-1", worktreeId: "wt-other" })]);

    render(<AttentionBar />);
    fireEvent.click(screen.getByText("Claude Agent"));
    expect(mockTrackTerminalFocus).toHaveBeenCalledWith("wt-other", "t-1");
    expect(mockSelectWorktree).toHaveBeenCalledWith("wt-other");
    expect(mockActivateTerminal).toHaveBeenCalledWith("t-1");
  });

  it("calls selectWorktree when clicking a conflict item", () => {
    useConflictedWorktreesMock.mockReturnValue([makeWorktree()]);

    render(<AttentionBar />);
    fireEvent.click(screen.getByText("feature/fix-bug"));
    expect(mockSelectWorktree).toHaveBeenCalledWith("wt-conflict");
  });

  it("falls back to worktree name when branch is not set", () => {
    useConflictedWorktreesMock.mockReturnValue([
      makeWorktree({ branch: undefined, name: "my-worktree" }),
    ]);

    render(<AttentionBar />);
    expect(screen.getByText("my-worktree")).toBeTruthy();
  });
});
