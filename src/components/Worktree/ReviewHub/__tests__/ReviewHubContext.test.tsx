/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";

const dispatch = vi.hoisted(() => vi.fn(() => Promise.resolve({ ok: true })));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

const worktrees = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (state: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees }),
}));

const panelsById = vi.hoisted(() => ({}) as Record<string, Record<string, unknown>>);
vi.mock("@/store/panelStore", () => ({
  usePanelStore: (selector: (state: { panelsById: typeof panelsById }) => unknown) =>
    selector({ panelsById }),
}));

import { ReviewHubContext } from "../ReviewHubContext";

const NOW = Date.now();

function terminal(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: "terminal",
    title: `Agent ${id}`,
    location: "grid",
    worktreeId: "wt-1",
    ...extra,
  };
}

beforeEach(() => {
  dispatch.mockClear();
  worktrees.clear();
  for (const k of Object.keys(panelsById)) delete panelsById[k];
  worktrees.set("wt-1", {
    id: "wt-1",
    path: "/repo/wt",
    issueNumber: 42,
    issueTitle: "Fix the thing",
  });
});
afterEach(cleanup);

describe("ReviewHubContext", () => {
  it("renders nothing without an issue or a handback", () => {
    worktrees.set("wt-1", { id: "wt-1", path: "/repo/wt" });
    panelsById.a = terminal("a");
    const { container } = render(<ReviewHubContext worktreePath="/repo/wt" worktreeId="wt-1" />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the linked issue and opens it", () => {
    const { getByTestId } = render(<ReviewHubContext worktreePath="/repo/wt" worktreeId="wt-1" />);
    const btn = getByTestId("review-hub-linked-issue");
    expect(btn.textContent).toContain("#42");
    expect(btn.textContent).toContain("Fix the thing");
    fireEvent.click(btn);
    expect(dispatch).toHaveBeenCalledWith(
      "worktree.openIssue",
      { worktreeId: "wt-1" },
      { source: "user" }
    );
  });

  it("attributes the handback to the agent, notes truncation, and focuses the terminal", () => {
    panelsById.a = terminal("a", {
      lastHandback: { message: "Done <b>x</b>", observedAt: NOW - 5 * 60_000, truncated: true },
    });
    panelsById.b = terminal("b", {
      worktreeId: "other",
      lastHandback: { message: "no", observedAt: NOW, truncated: false },
    });
    panelsById.c = terminal("c");
    const { getAllByTestId, getByText } = render(
      <ReviewHubContext worktreePath="/repo/wt" worktreeId="wt-1" />
    );
    const cards = getAllByTestId("review-hub-handback");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain("Last handback from");
    expect(cards[0]!.textContent).toContain("5 minutes ago");
    expect(cards[0]!.textContent).toContain("The agent said");
    expect(cards[0]!.textContent).toContain("Done <b>x</b>");
    expect(cards[0]!.textContent).toContain("truncated");
    expect(cards[0]!.querySelector("b")).toBeNull();
    fireEvent.click(getByText("Go to terminal"));
    expect(dispatch).toHaveBeenCalledWith("panel.focus", { panelId: "a" }, { source: "user" });
  });

  it("handles a bare handback and orders newest first", () => {
    panelsById.a = terminal("a", {
      lastHandback: { message: "old", observedAt: NOW - 3_600_000, truncated: false },
    });
    panelsById.b = terminal("b", {
      lastHandback: { message: null, observedAt: NOW, truncated: false },
    });
    const { getAllByTestId } = render(
      <ReviewHubContext worktreePath="/repo/wt" worktreeId="wt-1" />
    );
    const cards = getAllByTestId("review-hub-handback");
    expect(cards[0]!.textContent).toContain("no summary");
    expect(cards[1]!.textContent).toContain("old");
  });
});
