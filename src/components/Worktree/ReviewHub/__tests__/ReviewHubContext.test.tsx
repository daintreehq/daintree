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

/**
 * jsdom lays nothing out, so give each element a height from its text: a line
 * per newline or per 80 characters, cut to three lines while it carries the
 * clamp. That is what the Full prompt control measures.
 */
function fakeLayout() {
  const LINE = 16;
  const lines = (el: HTMLElement) =>
    (el.textContent ?? "")
      .split("\n")
      .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 80)), 0);
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return lines(this) * LINE;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      const shown = this.classList.contains("line-clamp-3")
        ? Math.min(lines(this), 3)
        : lines(this);
      return shown * LINE;
    },
  });
}

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
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
});

describe("ReviewHubContext", () => {
  it("renders nothing without an issue, a first prompt or a handback", () => {
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
    const { getAllByTestId, getByRole } = render(
      <ReviewHubContext worktreePath="/repo/wt" worktreeId="wt-1" />
    );
    const runs = getAllByTestId("review-hub-run");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.textContent).toContain("Agent a");
    const cards = getAllByTestId("review-hub-handback");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain("Last handback");
    expect(cards[0]!.textContent).toContain("5 minutes ago");
    expect(cards[0]!.textContent).toContain("The agent said");
    expect(cards[0]!.textContent).toContain("Done <b>x</b>");
    expect(cards[0]!.textContent).toContain("first 500 characters kept");
    expect(cards[0]!.querySelector("b")).toBeNull();
    fireEvent.click(getByRole("button", { name: "Go to terminal: Agent a" }));
    expect(dispatch).toHaveBeenCalledWith("panel.focus", { panelId: "a" }, { source: "user" });
  });

  it("handles a bare handback, orders newest first, and opens only the newest", () => {
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
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain("no summary");
    const toggles = getAllByTestId("review-hub-run-toggle");
    expect(toggles.map((t) => t.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
    // The closed run keeps its claim on its one line, attributed to the agent.
    const runs = getAllByTestId("review-hub-run");
    expect(runs[1]!.textContent).toContain("The agent said: “old”");

    fireEvent.click(toggles[1]!);
    expect(getAllByTestId("review-hub-handback")).toHaveLength(2);
  });

  it("shows what the run launched with beside its handback, as plain text", () => {
    panelsById.a = terminal("a", {
      firstPrompt: { text: "Fix <b>login</b>\nthen test", via: "launch", at: NOW - 3_600_000 },
      lastHandback: { message: "Fixed", observedAt: NOW, truncated: false },
    });
    const { getAllByTestId, getByTestId } = render(
      <ReviewHubContext worktreePath="/repo/wt" worktreeId="wt-1" />
    );
    const runs = getAllByTestId("review-hub-run");
    expect(runs).toHaveLength(1);
    const prompt = getByTestId("review-hub-first-prompt");
    expect(prompt.textContent).toContain("Launched with");
    expect(prompt.textContent).toContain("1 hour ago");
    expect(prompt.textContent).toContain("Fix <b>login</b>\nthen test");
    expect(prompt.querySelector("b")).toBeNull();
    expect(runs[0]!.querySelector('[data-testid="review-hub-handback"]')).not.toBeNull();
    expect(runs[0]!.textContent).toContain("Fixed");
  });

  it("labels a prompt that arrived after launch as first sent", () => {
    worktrees.set("wt-1", { id: "wt-1", path: "/repo/wt" });
    panelsById.a = terminal("a", { firstPrompt: { text: "Review this", via: "send", at: NOW } });
    const { getByTestId, queryByTestId } = render(
      <ReviewHubContext worktreePath="/repo/wt" worktreeId="wt-1" />
    );
    expect(getByTestId("review-hub-first-prompt").textContent).toContain("First sent");
    expect(queryByTestId("review-hub-handback")).toBeNull();
  });

  it("says when a long prompt was cut, and clamps it behind Full prompt", () => {
    fakeLayout();
    panelsById.a = terminal("a", {
      firstPrompt: { text: "x".repeat(400), via: "launch", at: NOW, truncated: true },
    });
    const { getByTestId, getByRole } = render(
      <ReviewHubContext worktreePath="/repo/wt" worktreeId="wt-1" />
    );
    const prompt = getByTestId("review-hub-first-prompt");
    expect(prompt.textContent).toContain("first 8,000 characters kept");
    const toggle = getByRole("button", { name: "Full prompt for Agent a" });
    const text = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(text?.className).toContain("line-clamp-3");

    // The label stays put; only the state changes.
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Full prompt");
    expect(text?.className).not.toContain("line-clamp-3");

    fireEvent.click(toggle);
    expect(text?.className).toContain("line-clamp-3");
  });

  it("offers Full prompt only where the clamp cuts the text", () => {
    fakeLayout();
    panelsById.a = terminal("a", {
      firstPrompt: { text: "one\ntwo\nthree\nfour\nfive", via: "launch", at: NOW },
    });
    panelsById.b = terminal("b", { firstPrompt: { text: "Ship it", via: "launch", at: NOW - 1 } });
    const { getAllByRole, getAllByTestId } = render(
      <ReviewHubContext worktreePath="/repo/wt" worktreeId="wt-1" />
    );
    fireEvent.click(getAllByTestId("review-hub-run-toggle")[1]!);
    expect(getAllByTestId("review-hub-first-prompt")).toHaveLength(2);
    const controls = getAllByRole("button", { name: /^Full prompt for / });
    expect(controls.map((c) => c.getAttribute("aria-label"))).toEqual(["Full prompt for Agent a"]);
  });

  it("still shows what a run was asked when a later restart of it fails", () => {
    panelsById.a = terminal("a", {
      spawnStatus: "failed",
      restartKey: 1,
      firstPrompt: { text: "Delivered earlier", via: "launch", at: NOW },
    });
    const { getByTestId } = render(<ReviewHubContext worktreePath="/repo/wt" worktreeId="wt-1" />);
    expect(getByTestId("review-hub-first-prompt").textContent).toContain("Delivered earlier");
  });

  it("shows no prompt for a missing-CLI gate, where nothing ran yet", () => {
    worktrees.set("wt-1", { id: "wt-1", path: "/repo/wt" });
    panelsById.a = terminal("a", {
      spawnStatus: "missing-cli",
      firstPrompt: { text: "Never ran", via: "launch", at: NOW },
    });
    const { container } = render(<ReviewHubContext worktreePath="/repo/wt" worktreeId="wt-1" />);
    expect(container.firstChild).toBeNull();
  });

  it("orders runs by their latest activity, prompt or handback", () => {
    // An old prompt with the newest handback, a run between, and a lone prompt.
    panelsById.a = terminal("a", {
      firstPrompt: { text: "first task", via: "launch", at: NOW - 7_200_000 },
      lastHandback: { message: "newest", observedAt: NOW, truncated: false },
    });
    panelsById.b = terminal("b", {
      lastHandback: { message: "middle", observedAt: NOW - 3_600_000, truncated: false },
    });
    panelsById.c = terminal("c", {
      firstPrompt: { text: "oldest", via: "launch", at: NOW - 5_400_000 },
    });
    const { getAllByTestId } = render(
      <ReviewHubContext worktreePath="/repo/wt" worktreeId="wt-1" />
    );
    const runs = getAllByTestId("review-hub-run").map((run) => run.textContent ?? "");
    expect(runs[0]).toContain("newest");
    expect(runs[1]).toContain("middle");
    expect(runs[2]).toContain("oldest");
  });
});
