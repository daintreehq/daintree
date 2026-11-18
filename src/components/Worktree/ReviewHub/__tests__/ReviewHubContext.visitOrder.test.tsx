/**
 * @vitest-environment jsdom
 */
import { StrictMode } from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve({ ok: true })) },
}));

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

const deriveChrome = vi.hoisted(() => vi.fn());
vi.mock("@/utils/terminalChrome", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/terminalChrome")>();
  deriveChrome.mockImplementation(actual.deriveTerminalChrome);
  return { ...actual, deriveTerminalChrome: deriveChrome };
});

const joins = vi.hoisted(() => ({ appendArrivals: vi.fn(), orderRuns: vi.fn() }));
vi.mock("../reviewHubRunOrder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../reviewHubRunOrder")>();
  joins.appendArrivals.mockImplementation(actual.appendArrivals);
  joins.orderRuns.mockImplementation(actual.orderRuns);
  return joins;
});

import { usePreferencesStore } from "@/store/preferencesStore";
import { ReviewHubContext } from "../ReviewHubContext";

const NOW = Date.now();

function run(id: string, observedAt: number, message = `said ${id}`) {
  return {
    id,
    kind: "terminal",
    title: `Agent ${id}`,
    location: "grid",
    worktreeId: "wt-1",
    lastHandback: { message, observedAt, truncated: false },
  };
}

function ui() {
  return <ReviewHubContext worktreePath="/repo/wt" worktreeId="wt-1" />;
}

/** The run titles top to bottom, read off each row's "Go to terminal" control. */
function order(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[aria-label^="Go to terminal: Agent "]')).map(
    (el) => (el.getAttribute("aria-label") ?? "").replace("Go to terminal: Agent ", "")
  );
}

function expanded(container: HTMLElement): Record<string, boolean> {
  const toggles = Array.from(container.querySelectorAll('[data-testid="review-hub-run-toggle"]'));
  const titles = order(container);
  return Object.fromEntries(
    toggles.map((toggle, i) => [titles[i]!, toggle.getAttribute("aria-expanded") === "true"])
  );
}

function toggleOf(container: HTMLElement, id: string): Element {
  const at = order(container).indexOf(id);
  return container.querySelectorAll('[data-testid="review-hub-run-toggle"]')[at]!;
}

beforeEach(() => {
  deriveChrome.mockClear();
  joins.appendArrivals.mockClear();
  joins.orderRuns.mockClear();
  worktrees.clear();
  for (const k of Object.keys(panelsById)) delete panelsById[k];
  worktrees.set("wt-1", { id: "wt-1", path: "/repo/wt" });
});
afterEach(() => {
  cleanup();
  act(() => usePreferencesStore.setState({ showAgentTaskTitles: true }));
});

describe("ReviewHubContext visit order", () => {
  it("opens newest first and appends a run that arrives after it, whatever its age", () => {
    panelsById.b = run("b", NOW - 3_000);
    panelsById.a = run("a", NOW - 2_000);
    const { container, rerender } = render(ui());
    expect(order(container)).toEqual(["a", "b"]);

    panelsById.d = run("d", NOW - 9_000);
    panelsById.c = run("c", NOW);
    rerender(ui());
    expect(order(container)).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps an earlier arrival ahead of a later one, however much newer the later is", () => {
    panelsById.a = run("a", NOW - 3_000);
    panelsById.b = run("b", NOW - 4_000);
    const { container, rerender } = render(ui());

    panelsById.c = run("c", NOW - 2_000);
    rerender(ui());
    expect(order(container)).toEqual(["a", "b", "c"]);

    panelsById.d = run("d", NOW);
    rerender(ui());
    expect(order(container)).toEqual(["a", "b", "c", "d"]);

    panelsById.e = run("e", NOW + 1_000);
    rerender(ui());
    expect(order(container)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("does not move a row when a handback lands on another run", () => {
    panelsById.a = run("a", NOW - 2_000);
    panelsById.b = run("b", NOW - 3_000);
    const { container, rerender } = render(ui());

    panelsById.b = run("b", NOW, "a later summary");
    rerender(ui());
    expect(order(container)).toEqual(["a", "b"]);
    expect(expanded(container)).toEqual({ a: true, b: false });
    expect(container.textContent).toContain("a later summary");
    expect(container.textContent).not.toContain("said b");
  });

  it("gives a run that leaves and comes back its old place", () => {
    panelsById.a = run("a", NOW - 1_000);
    panelsById.b = run("b", NOW - 2_000);
    panelsById.c = run("c", NOW - 3_000);
    const { container, rerender } = render(ui());

    const b = panelsById.b!;
    delete panelsById.b;
    rerender(ui());
    expect(order(container)).toEqual(["a", "c"]);

    panelsById.d = run("d", NOW);
    rerender(ui());
    expect(order(container)).toEqual(["a", "c", "d"]);

    panelsById.b = b;
    rerender(ui());
    expect(order(container)).toEqual(["a", "b", "c", "d"]);
  });

  it("opens the first run still present when the one the hub opened with leaves", () => {
    panelsById.a = run("a", NOW - 1_000);
    panelsById.b = run("b", NOW - 2_000);
    const { container, rerender } = render(ui());
    expect(expanded(container)).toEqual({ a: true, b: false });

    const a = panelsById.a!;
    delete panelsById.a;
    rerender(ui());
    expect(expanded(container)).toEqual({ b: true });

    panelsById.a = a;
    rerender(ui());
    expect(expanded(container)).toEqual({ a: true, b: false });
  });

  it("keeps rows expanded or closed by hand through an arrival", () => {
    panelsById.a = run("a", NOW - 1_000);
    panelsById.b = run("b", NOW - 2_000);
    const { container, rerender } = render(ui());

    fireEvent.click(toggleOf(container, "b"));
    fireEvent.click(toggleOf(container, "a"));
    expect(expanded(container)).toEqual({ a: false, b: true });

    panelsById.c = run("c", NOW);
    rerender(ui());
    expect(order(container)).toEqual(["a", "b", "c"]);
    expect(expanded(container)).toEqual({ a: false, b: true, c: false });
  });

  it("remembers a row closed by hand while it is away", () => {
    panelsById.a = run("a", NOW - 1_000);
    panelsById.b = run("b", NOW - 2_000);
    const { container, rerender } = render(ui());

    fireEvent.click(toggleOf(container, "a"));
    expect(expanded(container)).toEqual({ a: false, b: false });

    const a = panelsById.a!;
    delete panelsById.a;
    rerender(ui());
    expect(expanded(container)).toEqual({ b: true });

    panelsById.a = a;
    rerender(ui());
    expect(order(container)).toEqual(["a", "b"]);
    expect(expanded(container)).toEqual({ a: false, b: false });
  });

  it("keeps the hand-set rows and the visit's order through a departure with an arrival, under StrictMode", () => {
    panelsById.a = run("a", NOW - 1_000);
    panelsById.b = run("b", NOW - 2_000);
    panelsById.d = run("d", NOW - 3_000);
    const strict = () => <StrictMode>{ui()}</StrictMode>;
    const { container, rerender } = render(strict());
    expect(order(container)).toEqual(["a", "b", "d"]);

    fireEvent.click(toggleOf(container, "d"));
    expect(expanded(container)).toEqual({ a: true, b: false, d: true });

    const a = panelsById.a!;
    delete panelsById.a;
    panelsById.c = run("c", NOW);
    rerender(strict());
    expect(order(container)).toEqual(["b", "d", "c"]);
    expect(expanded(container)).toEqual({ b: true, d: true, c: false });

    panelsById.a = a;
    rerender(strict());
    expect(order(container)).toEqual(["a", "b", "d", "c"]);
    expect(expanded(container)).toEqual({ a: true, b: false, d: true, c: false });
  });

  it("keeps a long visit in order through arrivals and departures", () => {
    const n = 200;
    for (let i = 0; i < n; i++) panelsById[`r${i}`] = run(`r${i}`, NOW - i * 1_000);
    const { container, rerender } = render(ui());
    const initial = Array.from({ length: n }, (_, i) => `r${i}`);
    expect(order(container)).toEqual(initial);

    for (let i = 0; i < n; i += 2) delete panelsById[`r${i}`];
    panelsById.late = run("late", NOW + 1_000);
    rerender(ui());
    expect(order(container)).toEqual([...initial.filter((_, i) => i % 2 === 1), "late"]);

    panelsById.r0 = run("r0", NOW - 5);
    rerender(ui());
    expect(order(container)).toEqual(["r0", ...initial.filter((_, i) => i % 2 === 1), "late"]);
  });
});

describe("ReviewHubContext derived rows", () => {
  function longVisit(n: number) {
    for (let i = 0; i < n; i++) panelsById[`r${i}`] = run(`r${i}`, NOW - i * 1_000);
  }

  it("reuses the rows and the order when a row is expanded", () => {
    longVisit(200);
    const { container } = render(ui());
    expect(deriveChrome).toHaveBeenCalledTimes(200);
    expect(joins.appendArrivals).toHaveBeenCalled();
    expect(joins.orderRuns).toHaveBeenCalled();
    deriveChrome.mockClear();
    joins.appendArrivals.mockClear();
    joins.orderRuns.mockClear();

    fireEvent.click(toggleOf(container, "r5"));
    expect(expanded(container).r5).toBe(true);
    fireEvent.click(toggleOf(container, "r5"));
    expect(expanded(container).r5).toBe(false);
    expect(deriveChrome).not.toHaveBeenCalled();
    expect(joins.appendArrivals).not.toHaveBeenCalled();
    expect(joins.orderRuns).not.toHaveBeenCalled();
  });

  it("reuses the rows and the order when the panels haven't changed", () => {
    longVisit(50);
    const { rerender } = render(ui());
    expect(joins.appendArrivals).toHaveBeenCalled();
    expect(joins.orderRuns).toHaveBeenCalled();
    deriveChrome.mockClear();
    joins.appendArrivals.mockClear();
    joins.orderRuns.mockClear();

    rerender(ui());
    expect(deriveChrome).not.toHaveBeenCalled();
    expect(joins.appendArrivals).not.toHaveBeenCalled();
    expect(joins.orderRuns).not.toHaveBeenCalled();
  });

  it("rebuilds the rows when a panel changes", () => {
    longVisit(50);
    const { container, rerender } = render(ui());
    deriveChrome.mockClear();

    panelsById.r3 = run("r3", NOW, "a fresh summary");
    rerender(ui());
    expect(deriveChrome).toHaveBeenCalledTimes(50);
    expect(order(container)).toHaveLength(50);
    expect(order(container).slice(0, 5)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
    expect(container.textContent).toContain("a fresh summary");
  });

  it("rebuilds the titles when the task-title preference changes", () => {
    panelsById.a = {
      ...run("a", NOW),
      detectedAgentId: "claude",
      agentState: "working",
      lastObservedTitle: "Fix the login bug",
    };
    const { container } = render(ui());
    const label = () =>
      container.querySelector('[aria-label^="Go to terminal: "]')?.getAttribute("aria-label");
    expect(label()).toContain("Fix the login bug");

    act(() => usePreferencesStore.setState({ showAgentTaskTitles: false }));
    expect(label()).toBeTruthy();
    expect(label()).not.toContain("Fix the login bug");
  });
});
