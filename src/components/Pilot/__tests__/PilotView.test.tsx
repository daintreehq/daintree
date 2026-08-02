// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";

// The palette body is a ScrollShadow, which observes its own scroller.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
  });
});

afterAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: originalScrollIntoView,
    configurable: true,
  });
});

vi.mock("@/utils/safeFireAndForget", () => ({ safeFireAndForget: vi.fn() }));

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));

import { PilotView } from "../PilotView";
import { useGlobalEscapeDispatcher } from "@/hooks/useGlobalEscapeDispatcher";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { usePilotStore } from "@/store/pilotStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";

const NOW = 1_830_000_000_000;

/**
 * The zero-data title. Named rather than inlined so the several tests that must
 * distinguish "fleet clear" from "not reported yet" cannot drift apart — the
 * assertion is that the states differ, not that the wording is any given string.
 */
const EMPTY_FLEET_COPY = "Start an agent in any project";

/** Timer advance wrapped so the resulting state change reaches the DOM. */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function run(overrides: Partial<FleetSnapshot["runs"][number]> = {}) {
  return {
    runId: "t1",
    workspaceId: "p1",
    spawnedAt: NOW - 3_600_000,
    cwd: "/repo/feature-x",
    ...overrides,
  };
}

function seed(
  runs: FleetSnapshot["runs"] | null,
  health: Partial<Pick<FleetSnapshot, "degraded" | "lastSuccessfulAt">> = {}
) {
  useFleetSnapshotStore.setState({
    snapshot:
      runs === null
        ? null
        : { runs, changedAt: NOW, degraded: false, lastSuccessfulAt: NOW, ...health },
  });
}

/**
 * The workspace identity main seeds into the view at creation. Read through
 * `getViewWorkspaceId`, which is the only view-local identity in the renderer —
 * the replicated current-project pointer answers for the whole app, not for
 * this view.
 */
function seedViewWorkspace(id: string | null): void {
  if (id === null) {
    delete (window as { __DAINTREE_INITIAL_PROJECT__?: unknown }).__DAINTREE_INITIAL_PROJECT__;
    return;
  }
  (window as { __DAINTREE_INITIAL_PROJECT__?: unknown }).__DAINTREE_INITIAL_PROJECT__ = { id };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dispatchMock.mockClear();
  seedViewWorkspace(null);
  seed(null);
  usePilotStore.setState({ isOpen: true, collapsedWorkspaceIds: [] });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test carrier: only id/name are read
  useProjectStore.setState({ projects: [{ id: "p1", name: "daintree" }] } as Partial<
    ReturnType<typeof useProjectStore.getState>
  >);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test carrier: only id/name are read
  useScratchStore.setState({ scratches: [{ id: "s1", name: "spike" }] } as Partial<
    ReturnType<typeof useScratchStore.getState>
  >);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PilotView", () => {
  it("shows nothing at all for a fleet read that resolves inside the Doherty gate", () => {
    seed(null);
    render(<PilotView />);

    // A read that lands in 80ms must not flash a skeleton on its way past.
    advance(80);
    expect(screen.queryByTestId("pilot-skeleton")).toBeNull();
  });

  it("shows a skeleton, not an all-clear, once the wait is worth reporting", () => {
    seed(null);
    render(<PilotView />);
    advance(500);

    // Claiming "no agents running" from an unreported fleet would be a lie the
    // user acts on — the two states must not render the same.
    expect(screen.getByTestId("pilot-skeleton")).toBeTruthy();
    expect(screen.queryByText(EMPTY_FLEET_COPY)).toBeNull();
  });

  it("claims all-clear only once a genuinely empty fleet is delivered", () => {
    seed([]);
    render(<PilotView />);

    expect(screen.queryByTestId("pilot-skeleton")).toBeNull();
    expect(screen.getByText(EMPTY_FLEET_COPY)).toBeTruthy();
  });

  it("stays quiet when the fleet is busy but asking nothing", () => {
    seed([run({ agentState: "working", since: NOW - 60_000 })]);
    render(<PilotView />);

    expect(screen.getByText(/Nothing needs you/)).toBeTruthy();
  });

  it("never calls an idle or exited run 'working' in the summary", () => {
    // The row total is not a running-agent count. Reporting it as one is the
    // fastest way for a supervision surface to stop being believed.
    seed([
      run({ runId: "a", agentState: "working", since: NOW - 60_000 }),
      run({ runId: "b", agentState: "exited", since: NOW - 60_000 }),
      run({ runId: "c", agentState: "idle", since: NOW - 60_000 }),
    ]);
    render(<PilotView />);

    expect(screen.getByText("Nothing needs you · 1 agent working")).toBeTruthy();
  });

  it("renders each run's own brand mark, not one generic glyph for all agents", () => {
    // `TerminalIcon` stamps the resolved id/colour on the DOM, so two different
    // agents must not come out identical the way a shared terminal glyph would.
    seed([
      run({ runId: "a", agentId: "claude", agentState: "working", since: NOW - 60_000 }),
      run({ runId: "b", agentId: "codex", agentState: "working", since: NOW - 60_000 }),
    ]);
    render(<PilotView />);

    const iconIds = screen
      .getAllByTestId("pilot-row")
      .map((row) =>
        row.querySelector("[data-terminal-icon-id]")?.getAttribute("data-terminal-icon-id")
      );

    expect(iconIds).toHaveLength(2);
    expect(iconIds[0]).toBeTruthy();
    expect(new Set(iconIds).size).toBe(2);
  });

  it("makes every run's state available as text, not just as a glyph", () => {
    // Waiting and idle are both hollow circles; shape alone cannot separate
    // them. The neutral states gave up their visible word, so the word has to
    // survive in the option's accessible name — never colour or shape alone.
    seed([
      run({ runId: "a", agentState: "waiting", title: "one", since: NOW - 60_000 }),
      run({ runId: "b", agentState: "idle", title: "two", since: NOW - 60_000 }),
    ]);
    render(<PilotView />);

    expect(screen.getByRole("option", { name: /Needs you/ }).textContent).toContain("one");
    expect(screen.getByRole("option", { name: /Idle/ }).textContent).toContain("two");
  });

  it("names a row as a sentence rather than a run of jammed-together facts", () => {
    // Left to the name-from-content computation these inline spans concatenate
    // with no separators — "Fix authWorkingfeature-x2m". Naming the parts is
    // what keeps the row a phrase, and what lets the age be read as an age.
    seed([
      run({
        runId: "a",
        agentState: "waiting",
        title: "Fix auth",
        cwd: "/repo/feature-x",
        since: NOW - 120_000,
      }),
    ]);
    render(<PilotView />);

    expect(screen.getByTestId("pilot-row").getAttribute("aria-label")).toBe(
      "Fix auth, Needs you, feature-x, 2m ago"
    );
  });

  it("leaves no dangling separator when a run has no age to report", () => {
    seed([run({ runId: "a", agentState: "working", title: "Fix auth", cwd: "/repo/feature-x" })]);
    render(<PilotView />);

    expect(screen.getByTestId("pilot-row").getAttribute("aria-label")).toBe(
      "Fix auth, Working, feature-x"
    );
  });

  it("spends colour only on the agents that are actually asking for something", () => {
    // The whole point of the surface. One blocked agent among six working ones
    // has to be the only status word on screen — six green labels beside one
    // amber one is the wall this replaced, where nothing stood out because
    // everything was shouting.
    seed([
      run({
        runId: "blocked",
        agentState: "waiting",
        waitingReason: "error",
        title: "stuck",
        since: NOW - 60_000,
      }),
      ...Array.from({ length: 6 }, (_, i) =>
        run({ runId: `w${i}`, agentState: "working", title: `work ${i}`, since: NOW - 60_000 })
      ),
    ]);
    render(<PilotView />);

    const rows = screen.getAllByTestId("pilot-row");
    expect(rows).toHaveLength(7);

    // Rendered text is what the eye sees, and only the demand row spends a
    // word on its state — the six working rows say nothing visible about
    // theirs.
    const withVisibleStatus = rows.filter((row) => /Blocked|Working/.test(row.textContent ?? ""));
    expect(withVisibleStatus).toHaveLength(1);
    expect(withVisibleStatus[0]!.textContent).toContain("Blocked");

    // ...and every one of the seven still says what it is doing, in text.
    expect(screen.getAllByRole("option", { name: /Working/ })).toHaveLength(6);
    expect(screen.getAllByRole("option", { name: /Blocked/ })).toHaveLength(1);
  });

  it("marks the workspace this view already owns", () => {
    // Opening a run here costs nothing; opening one elsewhere swaps the whole
    // view. Which is which is worth a word.
    seedViewWorkspace("p1");
    seed([
      run({ runId: "a", workspaceId: "p1", agentState: "working", since: NOW - 60_000 }),
      run({ runId: "b", workspaceId: "s1", agentState: "working", since: NOW - 60_000 }),
    ]);
    render(<PilotView />);

    const headers = screen.getAllByTestId("pilot-group-header").map((h) => h.textContent ?? "");
    expect(headers.filter((h) => h.includes("Current"))).toHaveLength(1);
    expect(headers.find((h) => h.includes("Current"))).toContain("daintree");
  });

  it("says it cannot see the fleet rather than showing an endless skeleton", () => {
    // A pty-host that is unreachable from boot never produces a first snapshot.
    // Spinning forever tells the user nothing and looks like a hang.
    seed([], { degraded: true, lastSuccessfulAt: null });
    render(<PilotView />);

    expect(screen.queryByTestId("pilot-skeleton")).toBeNull();
    expect(screen.queryByText(EMPTY_FLEET_COPY)).toBeNull();
    expect(screen.getByTestId("pilot-unavailable")).toBeTruthy();
  });

  it("captions retained runs as stale instead of presenting them as current", () => {
    seed([run({ agentState: "waiting", title: "one", since: NOW - 60_000 })], {
      degraded: true,
      lastSuccessfulAt: NOW - 12 * 60_000,
    });
    render(<PilotView />);

    // The rows still render — they are the best available answer — but the
    // ticking ages must not make a dead feed look actively maintained.
    expect(screen.getByTestId("pilot-row")).toBeTruthy();
    expect(screen.getByTestId("pilot-stale").textContent).toContain("12m");
  });

  it("leads with the demand count when agents need the user", () => {
    seed([
      run({ runId: "a", agentState: "waiting", waitingReason: "error", since: NOW - 60_000 }),
      run({ runId: "b", agentState: "waiting", since: NOW - 30_000 }),
      run({ runId: "c", agentState: "working", since: NOW - 10_000 }),
    ]);
    render(<PilotView />);

    expect(screen.getByText("2 agents need you")).toBeTruthy();
  });

  it("groups rows under their project, most urgent project first", () => {
    seed([
      run({ runId: "w", workspaceId: "p1", agentState: "working", since: NOW - 10_000 }),
      run({
        runId: "b",
        workspaceId: "s1",
        agentState: "waiting",
        waitingReason: "error",
        since: NOW - 60_000,
      }),
    ]);
    render(<PilotView />);

    const headers = screen.getAllByTestId("pilot-group-header").map((h) => h.textContent ?? "");
    // "spike" holds the blocked run, so it leads despite "daintree" sorting first.
    expect(headers[0]).toContain("spike");
    expect(headers[1]).toContain("daintree");
  });

  it("navigates to the run when a row is clicked", () => {
    seed([run({ runId: "t9", workspaceId: "p1", agentState: "waiting", since: NOW - 60_000 })]);
    render(<PilotView />);

    screen.getByTestId("pilot-row").click();

    expect(dispatchMock).toHaveBeenCalledWith("pilot.openRun", {
      runId: "t9",
      workspaceId: "p1",
    });
  });

  it("shows the panel title as the row's primary label", () => {
    seed([
      run({ agentState: "working", title: "Rebuild the fleet snapshot", since: NOW - 10_000 }),
    ]);
    render(<PilotView />);

    expect(screen.getByText("Rebuild the fleet snapshot")).toBeTruthy();
  });

  it("collapses a project's rows while keeping its header", () => {
    seed([run({ agentState: "working", since: NOW - 10_000 })]);
    render(<PilotView />);
    expect(screen.getAllByTestId("pilot-row")).toHaveLength(1);

    const toggle = screen.getByTestId("pilot-group-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);

    expect(screen.queryByTestId("pilot-row")).toBeNull();
    expect(screen.getByTestId("pilot-group-header")).toBeTruthy();
    expect(screen.getByTestId("pilot-group-toggle").getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the project out of the tab order", () => {
    // The search box owns the keyboard. A focusable disclosure inside the list
    // would put a tab stop between the query and the results.
    seed([run({ agentState: "working", since: NOW - 10_000 })]);
    render(<PilotView />);

    expect(screen.getByTestId("pilot-group-toggle").getAttribute("tabindex")).toBe("-1");
  });

  it("filters rows by title and drops projects left with nothing", () => {
    seed([
      run({ runId: "a", workspaceId: "p1", agentState: "working", title: "auth refactor" }),
      run({ runId: "b", workspaceId: "s1", agentState: "working", title: "docs pass" }),
    ]);
    render(<PilotView />);
    expect(screen.getAllByTestId("pilot-group-header")).toHaveLength(2);

    fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "auth" } });

    expect(screen.getAllByTestId("pilot-group-header")).toHaveLength(1);
    expect(screen.getByText("auth refactor")).toBeTruthy();
    expect(screen.queryByText("docs pass")).toBeNull();
  });

  it("reveals matches inside a collapsed project rather than hiding them", () => {
    seed([run({ agentState: "working", title: "auth refactor" })]);
    usePilotStore.setState({ isOpen: true, collapsedWorkspaceIds: ["p1"] });
    render(<PilotView />);
    expect(screen.queryByTestId("pilot-row")).toBeNull();

    fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "auth" } });

    // Making someone click to reveal what they just searched for is the search
    // failing to do its job.
    expect(screen.getByText("auth refactor")).toBeTruthy();
  });

  it("restores the collapsed state when the search is cleared", () => {
    seed([run({ agentState: "working", title: "auth refactor" })]);
    usePilotStore.setState({ isOpen: true, collapsedWorkspaceIds: ["p1"] });
    render(<PilotView />);

    const search = screen.getByTestId("pilot-search");
    fireEvent.change(search, { target: { value: "auth" } });
    expect(screen.getByText("auth refactor")).toBeTruthy();

    fireEvent.change(search, { target: { value: "" } });
    expect(screen.queryByTestId("pilot-row")).toBeNull();
  });

  it("keeps the collapse toggle live during a search without editing the saved set", () => {
    seed([
      run({ runId: "a", workspaceId: "p1", agentState: "working", title: "auth one" }),
      run({ runId: "b", workspaceId: "p1", agentState: "working", title: "auth two" }),
    ]);
    render(<PilotView />);

    fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "auth" } });
    expect(screen.getAllByTestId("pilot-row")).toHaveLength(2);

    // Collapsing during a search must actually collapse — a header whose
    // aria-expanded never moves is a dead control.
    fireEvent.click(screen.getByTestId("pilot-group-toggle"));
    expect(screen.queryByTestId("pilot-row")).toBeNull();

    // ...and it must not leak into the persisted set, or the group would
    // mysteriously stay collapsed long after the search ended.
    expect(usePilotStore.getState().collapsedWorkspaceIds).toEqual([]);

    fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "" } });
    expect(screen.getAllByTestId("pilot-row")).toHaveLength(2);
  });

  describe("Escape", () => {
    /**
     * Mounts the real dispatcher alongside the dialog. Escape reaches three
     * handlers in this app — the input, the escape stack, and a document-bubble
     * backstop inside `AppPaletteDialog` — and only the full pipeline shows
     * which one actually wins.
     */
    function renderWithEscape() {
      function Dispatcher() {
        useGlobalEscapeDispatcher();
        return null;
      }
      return render(
        <>
          <Dispatcher />
          <PilotView />
        </>
      );
    }

    it("closes on the first press even with a query typed", () => {
      // The project switcher opens this and sits beside it, and closes on the
      // first Escape. Two palettes that hand off to each other must not
      // disagree about what the key does.
      seed([run({ agentState: "working", title: "auth refactor" })]);
      renderWithEscape();

      const search = screen.getByTestId("pilot-search");
      fireEvent.change(search, { target: { value: "auth" } });
      fireEvent.keyDown(search, { key: "Escape" });

      expect(usePilotStore.getState().isOpen).toBe(false);
    });

    it("closes once the box is already empty", () => {
      seed([run({ agentState: "working", title: "auth refactor" })]);
      renderWithEscape();

      fireEvent.keyDown(screen.getByTestId("pilot-search"), { key: "Escape" });

      expect(usePilotStore.getState().isOpen).toBe(false);
    });

    it("starts the next search fully expanded", () => {
      seed([
        run({ runId: "a", workspaceId: "p1", agentState: "working", title: "auth one" }),
        run({ runId: "b", workspaceId: "p1", agentState: "working", title: "auth two" }),
      ]);
      renderWithEscape();

      const search = screen.getByTestId("pilot-search");
      fireEvent.change(search, { target: { value: "auth" } });
      fireEvent.click(screen.getByTestId("pilot-group-toggle"));
      expect(screen.queryByTestId("pilot-row")).toBeNull();

      // A collapse made during one search is scoped to it. Carrying it forward
      // would hide matches the next search went looking for.
      fireEvent.change(search, { target: { value: "" } });
      fireEvent.change(search, { target: { value: "auth" } });

      expect(screen.getAllByTestId("pilot-row")).toHaveLength(2);
    });
  });

  it("distinguishes an empty fleet from an empty search result", () => {
    seed([run({ agentState: "working", title: "auth refactor" })]);
    render(<PilotView />);

    fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "zzzz" } });

    expect(screen.getByText('No matches for "zzzz"')).toBeTruthy();
    expect(screen.queryByText(EMPTY_FLEET_COPY)).toBeNull();
  });

  it("still answers a search that matches nothing while the feed is stale", () => {
    // Retained runs are real rows, so a query matching none of them is a true
    // statement about the query. Leaving the body blank under the stale caption
    // makes a normal no-match read like the search itself gave up.
    seed([run({ agentState: "working", title: "auth refactor" })], {
      degraded: true,
      lastSuccessfulAt: NOW - 12 * 60_000,
    });
    render(<PilotView />);

    fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "zzzz" } });

    expect(screen.getByTestId("pilot-stale")).toBeTruthy();
    expect(screen.getByText('No matches for "zzzz"')).toBeTruthy();
  });

  it("matches on project name as well as title", () => {
    seed([
      run({ runId: "a", workspaceId: "p1", agentState: "working", title: "one" }),
      run({ runId: "b", workspaceId: "s1", agentState: "working", title: "two" }),
    ]);
    render(<PilotView />);

    fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "spike" } });

    expect(screen.getByText("two")).toBeTruthy();
    expect(screen.queryByText("one")).toBeNull();
  });

  it("advances a wait age as time passes without a new snapshot", async () => {
    seed([run({ agentState: "waiting", since: NOW - 60_000 })]);
    render(<PilotView />);
    // The age rides the status line, where it names the quantity it measures.
    const age = () => screen.getByTestId("pilot-row").textContent ?? "";
    expect(age()).toContain("1m");

    // The snapshot is unchanged and suppressed upstream, so only the component's
    // own clock can move this. A tick that never reaches the render is the
    // React Compiler no-op this guards against.
    await vi.advanceTimersByTimeAsync(120_000);

    expect(age()).not.toContain("1m");
    expect(age()).toContain("3m");
  });

  it("re-pins the order on reopen rather than serving the previous session's", async () => {
    seed([
      run({ runId: "a", agentState: "working", title: "a", since: NOW - 10_000 }),
      run({ runId: "b", agentState: "working", title: "b", since: NOW - 5_000 }),
    ]);
    const view = render(<PilotView />);
    expect(screen.getAllByTestId("pilot-row").map((r) => r.textContent)).toEqual([
      expect.stringContaining("a"),
      expect.stringContaining("b"),
    ]);

    // Close, let the fleet change, reopen. The new order must reflect the fleet
    // as it is NOW — a stale pin would keep serving the closed session's order.
    usePilotStore.setState({ isOpen: false });
    view.rerender(<PilotView />);
    seed([
      run({ runId: "a", agentState: "working", title: "a", since: NOW - 10_000 }),
      run({
        runId: "b",
        agentState: "waiting",
        waitingReason: "error",
        title: "b",
        since: NOW,
      }),
    ]);
    usePilotStore.setState({ isOpen: true });
    view.rerender(<PilotView />);
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getAllByTestId("pilot-row").map((r) => r.textContent)).toEqual([
      expect.stringContaining("b"),
      expect.stringContaining("a"),
    ]);
  });

  describe("keyboard navigation", () => {
    /** The row the highlight is on, as the listbox reports it. */
    function selected(): { role: string | null; text: string } {
      const el = document.querySelector('[aria-selected="true"]');
      if (!el) throw new Error("nothing selected");
      return { role: el.getAttribute("role"), text: el.textContent ?? "" };
    }

    function press(key: string): void {
      fireEvent.keyDown(screen.getByTestId("pilot-search"), { key });
    }

    function seedTwoProjects(): void {
      seed([
        run({ runId: "a", workspaceId: "p1", agentState: "working", title: "alpha" }),
        run({ runId: "b", workspaceId: "p1", agentState: "working", title: "bravo" }),
        run({ runId: "c", workspaceId: "s1", agentState: "working", title: "charlie" }),
      ]);
    }

    it("opens with the first agent selected", () => {
      seedTwoProjects();
      render(<PilotView />);

      expect(selected()).toMatchObject({ role: "option", text: expect.stringContaining("alpha") });
    });

    it("walks agents only, stepping over the projects between them", () => {
      seedTwoProjects();
      render(<PilotView />);

      press("ArrowDown");
      expect(selected().text).toContain("bravo");
      // Straight into the next project's first agent. A project is a heading,
      // so stopping on it would cost a keystroke per project on the way to the
      // agent the user actually came for.
      press("ArrowDown");
      expect(selected()).toMatchObject({
        role: "option",
        text: expect.stringContaining("charlie"),
      });
    });

    it("never lets a project become the selected row", () => {
      seedTwoProjects();
      render(<PilotView />);

      // Walk the whole list twice and assert nothing but agents is ever
      // selectable — the header carries no `aria-selected` at all.
      for (let i = 0; i < 8; i++) {
        expect(selected().role).toBe("option");
        press("ArrowDown");
      }
      expect(screen.getAllByTestId("pilot-group-header").length).toBeGreaterThan(0);
      expect(
        screen.getAllByTestId("pilot-group-header").some((h) => h.hasAttribute("aria-selected"))
      ).toBe(false);
    });

    it("wraps at both ends", () => {
      seedTwoProjects();
      render(<PilotView />);

      // Up from the first agent lands on the last one, across the project
      // boundary — the list wraps as agents, not as agents-and-projects.
      press("ArrowUp");
      expect(selected().text).toContain("charlie");
      press("ArrowDown");
      expect(selected().text).toContain("alpha");
    });

    it("opens the selected agent on Enter", () => {
      seedTwoProjects();
      render(<PilotView />);

      press("ArrowDown");
      press("Enter");

      expect(dispatchMock).toHaveBeenCalledWith("pilot.openRun", {
        runId: "b",
        workspaceId: "p1",
      });
    });

    it("always opens an agent on Enter, whatever is selected", () => {
      seedTwoProjects();
      render(<PilotView />);

      // Every selectable row is an agent, so Enter has exactly one meaning —
      // it can no longer land on a project and collapse it by accident.
      press("Enter");

      expect(dispatchMock).toHaveBeenCalledWith("pilot.openRun", {
        runId: "a",
        workspaceId: "p1",
      });
    });

    it("collapses with Left and expands with Right, acting on the selected agent's project", () => {
      seedTwoProjects();
      render(<PilotView />);
      expect(selected().text).toContain("alpha");

      // No project is ever selected, so the disclosure keys act on the group
      // holding the current agent rather than on a highlighted header.
      press("ArrowLeft");
      expect(screen.getAllByTestId("pilot-row")).toHaveLength(1);
      expect(screen.getAllByTestId("pilot-group-toggle")[0]!.getAttribute("aria-expanded")).toBe(
        "false"
      );

      // Selection followed the collapse out to a still-visible agent.
      expect(selected().text).toContain("charlie");

      press("ArrowRight");
      expect(screen.getAllByTestId("pilot-row")).toHaveLength(3);
    });

    it("can reopen a project after collapsing every one of them", () => {
      // Collapsing the last expanded project empties the list. The disclosures
      // are not tab stops, so if Right bailed on an empty list the keyboard
      // user would be shut out of their own fleet with no way back.
      seedTwoProjects();
      render(<PilotView />);

      press("ArrowLeft");
      press("ArrowLeft");
      expect(screen.queryByTestId("pilot-row")).toBeNull();

      press("ArrowRight");
      expect(screen.getAllByTestId("pilot-row").length).toBeGreaterThan(0);
    });

    it("moves the highlight out of a group it collapses", () => {
      seedTwoProjects();
      render(<PilotView />);
      expect(selected().text).toContain("alpha");

      fireEvent.click(screen.getAllByTestId("pilot-group-toggle")[0]!);

      // "alpha" has left the list. A highlight still pointing at it would leave
      // Enter committing a row that isn't on screen.
      expect(selected()).toMatchObject({
        role: "option",
        text: expect.stringContaining("charlie"),
      });
    });

    it("leaves the caret alone while there is a query to edit", () => {
      seedTwoProjects();
      render(<PilotView />);

      fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "a" } });
      const before = screen.getAllByTestId("pilot-row").length;

      // Left/Right are the tree's structural keys AND the search box's editing
      // keys, and the box owns focus. With text in it, the caret wins.
      press("ArrowLeft");
      expect(screen.getAllByTestId("pilot-row")).toHaveLength(before);
      // ...but Up/Down never belong to a single-line caret.
      press("ArrowDown");
      expect(selected().text).not.toContain("alpha");
    });

    it("still collapses from the results region after Tab moves focus there", () => {
      seedTwoProjects();
      render(<PilotView />);

      // Tab moves focus off the input onto the scroll region, which forwards a
      // fixed key set to the palette. Vertical movement survived that move
      // already; the disclosure half has to as well, or the region is half a
      // keyboard.
      const region = screen.getByRole("group", { name: "Agents" });
      fireEvent.keyDown(region, { key: "ArrowLeft" });
      expect(screen.getAllByTestId("pilot-row")).toHaveLength(1);

      fireEvent.keyDown(region, { key: "ArrowRight" });
      expect(screen.getAllByTestId("pilot-row")).toHaveLength(3);
    });

    it("leaves the keys alone when there is nothing listed to navigate", () => {
      seed([]);
      render(<PilotView />);

      // Consuming Enter and the arrows over an empty list would eat keys the
      // browser still has a use for, and the footer would be advertising them.
      const search = screen.getByTestId("pilot-search");
      expect(fireEvent.keyDown(search, { key: "ArrowDown" })).toBe(true);
      expect(fireEvent.keyDown(search, { key: "Enter" })).toBe(true);
      expect(screen.queryByText("Open")).toBeNull();
      expect(screen.queryByText("Navigate")).toBeNull();
    });

    it("keeps the highlight on its row when the list shrinks underneath it", async () => {
      seedTwoProjects();
      render(<PilotView />);

      press("ArrowDown");
      expect(selected().text).toContain("bravo");

      // "alpha" exits. An index-based selection would now address "charlie";
      // the row-based one stays on "bravo".
      seed([
        run({ runId: "b", workspaceId: "p1", agentState: "working", title: "bravo" }),
        run({ runId: "c", workspaceId: "s1", agentState: "working", title: "charlie" }),
      ]);
      await vi.advanceTimersByTimeAsync(0);

      expect(selected().text).toContain("bravo");
    });
  });

  describe("state filter", () => {
    /** Blocked + needs-you in one project, working + an exited shell in another. */
    function seedMixedFleet(): void {
      seed([
        run({
          runId: "blocked",
          workspaceId: "p1",
          agentState: "waiting",
          waitingReason: "error",
          title: "auth blocked",
          since: NOW - 60_000,
        }),
        run({
          runId: "asking",
          workspaceId: "p1",
          agentState: "waiting",
          title: "docs asking",
          since: NOW - 30_000,
        }),
        run({
          runId: "working",
          workspaceId: "s1",
          agentState: "working",
          title: "auth working",
          since: NOW - 10_000,
        }),
        run({
          runId: "idle",
          workspaceId: "s1",
          agentState: "exited",
          title: "old shell",
          since: NOW - 10_000,
        }),
      ]);
    }

    function segment(name: RegExp): HTMLElement {
      return screen.getByRole("radio", { name });
    }

    function rowTitles(): string[] {
      return screen.queryAllByTestId("pilot-row").map((r) => r.textContent ?? "");
    }

    it("narrows the list to one band without touching the query", () => {
      seedMixedFleet();
      render(<PilotView />);
      expect(rowTitles()).toHaveLength(4);

      fireEvent.click(segment(/Needs you/));

      expect(rowTitles()).toHaveLength(2);
      expect(rowTitles().join(" ")).toContain("auth blocked");
      expect(rowTitles().join(" ")).not.toContain("auth working");
    });

    it("intersects with the query instead of replacing it", () => {
      // Two constraints, one question — "the blocked agents in this repo".
      seedMixedFleet();
      render(<PilotView />);

      fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "auth" } });
      expect(rowTitles()).toHaveLength(2);

      fireEvent.click(segment(/Needs you/));

      expect(rowTitles()).toHaveLength(1);
      expect(rowTitles()[0]).toContain("auth blocked");
    });

    it("counts the query-filtered population, not the whole fleet", () => {
      // Counted after the query and before the segment. Count the other way and
      // every segment reports the length of the list already on screen.
      seedMixedFleet();
      render(<PilotView />);
      expect(segment(/^All/).getAttribute("aria-label")).toBe("All, 4 agents");

      fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "auth" } });

      expect(segment(/^All/).getAttribute("aria-label")).toBe("All, 2 agents");
      expect(segment(/Needs you/).getAttribute("aria-label")).toBe("Needs you, 1 agent");
      expect(segment(/Working/).getAttribute("aria-label")).toBe("Working, 1 agent");
    });

    it("holds the counts still while the segment changes", () => {
      // Selecting a segment must not rewrite the numbers next to the others, or
      // the bar stops being a map of the fleet and becomes a mirror of itself.
      seedMixedFleet();
      render(<PilotView />);
      const before = screen.getAllByRole("radio").map((el) => el.getAttribute("aria-label"));

      fireEvent.click(segment(/Needs you/));

      expect(screen.getAllByRole("radio").map((el) => el.getAttribute("aria-label"))).toEqual(
        before
      );
    });

    it("sorts review into Finished and out of Needs you", () => {
      // The asymmetry worth pinning: `review` IS a demand band, so it counts
      // toward `demandCount`, but the Needs-you segment is blocked + needs-you
      // only. A review row must land in exactly one of the two segments.
      seed([
        run({ runId: "r", agentState: "completed", title: "handed back", since: NOW - 30_000 }),
        run({ runId: "w", agentState: "waiting", title: "asking", since: NOW - 30_000 }),
      ]);
      render(<PilotView />);

      expect(segment(/Needs you/).getAttribute("aria-label")).toBe("Needs you, 1 agent");
      expect(segment(/Finished/).getAttribute("aria-label")).toBe("Finished, 1 agent");

      fireEvent.click(segment(/Finished/));
      expect(rowTitles()).toHaveLength(1);
      expect(rowTitles()[0]).toContain("handed back");
    });

    it("leaves an exited run in All and in nothing else", () => {
      seedMixedFleet();
      render(<PilotView />);

      expect(segment(/Finished/).getAttribute("aria-label")).toBe("Finished, 0 agents");
      fireEvent.click(segment(/Working/));

      expect(rowTitles().join(" ")).not.toContain("old shell");
    });

    it("moves the highlight off a row the filter removes", () => {
      seedMixedFleet();
      render(<PilotView />);
      expect(document.querySelector('[aria-selected="true"]')?.textContent).toContain(
        "auth blocked"
      );

      fireEvent.click(segment(/Working/));

      // Enter committing a row that is no longer listed is the bug this guards.
      const selected = document.querySelector('[aria-selected="true"]');
      expect(selected?.textContent).toContain("auth working");
    });

    it("opens a persistently collapsed group that the filter matches", () => {
      seedMixedFleet();
      usePilotStore.setState({ isOpen: true, collapsedWorkspaceIds: ["p1"] });
      render(<PilotView />);
      expect(rowTitles().join(" ")).not.toContain("auth blocked");

      fireEvent.click(segment(/Needs you/));

      // Same rule the query already follows: making someone click to reveal
      // what they just filtered for is the narrowing failing to do its job.
      expect(rowTitles().join(" ")).toContain("auth blocked");
    });

    it("scopes a collapse made under a filter to that filter", () => {
      seedMixedFleet();
      render(<PilotView />);
      fireEvent.click(segment(/Needs you/));

      fireEvent.click(screen.getAllByTestId("pilot-group-toggle")[0]!);
      expect(rowTitles()).toHaveLength(0);
      // It must not leak into the persisted set, or the group would stay
      // collapsed long after the filter was cleared.
      expect(usePilotStore.getState().collapsedWorkspaceIds).toEqual([]);

      fireEvent.click(segment(/^All/));
      expect(rowTitles()).toHaveLength(4);
    });

    it("keeps the bar reachable when the narrowing leaves nothing", () => {
      seedMixedFleet();
      render(<PilotView />);

      fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "zzzz" } });

      // The moment the list is empty is exactly when the bar is the way back.
      expect(screen.getByTestId("pilot-filter-bar")).toBeTruthy();
    });

    it("says nothing about states before the fleet has been read", () => {
      // Four zero segments over an unknown fleet is a claim the surface cannot
      // support, and over a genuinely empty one it is chrome competing with the
      // sentence telling the user what to do.
      seed(null);
      const view = render(<PilotView />);
      expect(screen.queryByTestId("pilot-filter-bar")).toBeNull();

      seed([]);
      view.rerender(<PilotView />);
      expect(screen.queryByTestId("pilot-filter-bar")).toBeNull();
    });

    it("names both constraints when the two of them empty the list", () => {
      // The ghost-filter dead end: hitting zero results with no way to see that
      // a filter you set is the reason.
      seedMixedFleet();
      render(<PilotView />);

      fireEvent.click(segment(/Working/));
      fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "docs" } });

      expect(screen.getByText('No matches for "docs" with Working selected')).toBeTruthy();
      expect(screen.getByTestId("pilot-clear-filter")).toBeTruthy();
    });

    it("names the filter alone when it is the only thing excluding rows", () => {
      seedMixedFleet();
      render(<PilotView />);

      fireEvent.click(segment(/Finished/));

      expect(screen.getByText("No matches with Finished selected")).toBeTruthy();
    });

    it("stops naming a query the moment it is cleared", () => {
      // The filter keeps the narrowed branch mounted after the box empties, so
      // a deferred query value would go on being quoted over text the user has
      // already deleted.
      seedMixedFleet();
      render(<PilotView />);
      fireEvent.click(segment(/Finished/));
      fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "docs" } });
      expect(screen.getByText('No matches for "docs" with Finished selected')).toBeTruthy();

      fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "" } });

      expect(screen.getByText("No matches with Finished selected")).toBeTruthy();
    });

    it("hands focus back when the clear control removes itself", () => {
      // The button unmounts on click, and with an unmatched query left behind
      // there is no row to arrow to either — so focus has to be placed, not
      // dropped on the document.
      seedMixedFleet();
      render(<PilotView />);
      fireEvent.click(segment(/Working/));
      fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "zzzz" } });

      fireEvent.click(screen.getByTestId("pilot-clear-filter"));

      expect(document.activeElement).toBe(screen.getByTestId("pilot-search"));
    });

    it("holds the opening order while a filter comes and goes", () => {
      // `frozenOrder` pins position for the whole opening. A filter must narrow
      // that order, never re-derive one — every row here is a click target.
      seed([
        run({ runId: "a", agentState: "waiting", title: "alpha", since: NOW - 10_000 }),
        run({ runId: "b", agentState: "waiting", title: "bravo", since: NOW - 5_000 }),
      ]);
      render(<PilotView />);
      // Titles, not full text: "bravo" changes band below, so its visible
      // status word legitimately changes. Position is what must not.
      const titles = () =>
        screen.getAllByTestId("pilot-row").map((r) => r.getAttribute("aria-label")?.split(",")[0]);
      const opening = titles();

      // "bravo" becomes the more urgent of the two, which would reorder them
      // on a fresh sort.
      act(() => {
        seed([
          run({ runId: "a", agentState: "waiting", title: "alpha", since: NOW - 10_000 }),
          run({
            runId: "b",
            agentState: "waiting",
            waitingReason: "error",
            title: "bravo",
            since: NOW,
          }),
        ]);
      });
      fireEvent.click(screen.getByRole("radio", { name: /Needs you/ }));
      fireEvent.click(screen.getByRole("radio", { name: /^All/ }));

      expect(titles()).toEqual(opening);
    });

    it("clears the filter without discarding the query", () => {
      // A targeted correction, not a reset — throwing away the typing as well
      // would make the user retype what was never the problem.
      seedMixedFleet();
      render(<PilotView />);
      fireEvent.click(segment(/Working/));
      fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "docs" } });

      fireEvent.click(screen.getByTestId("pilot-clear-filter"));

      expect(screen.getByDisplayValue("docs")).toBeTruthy();
      expect(rowTitles()).toHaveLength(1);
      expect(rowTitles()[0]).toContain("docs asking");
    });

    it("starts every opening back at All", () => {
      seedMixedFleet();
      const view = render(<PilotView />);
      fireEvent.click(segment(/Needs you/));
      expect(rowTitles()).toHaveLength(2);

      usePilotStore.setState({ isOpen: false });
      view.rerender(<PilotView />);
      usePilotStore.setState({ isOpen: true });
      view.rerender(<PilotView />);

      // A filter that persisted would reopen the surface already hiding agents,
      // with the reason two openings in the past.
      expect(rowTitles()).toHaveLength(4);
    });
  });

  describe("footer demand", () => {
    it("isolates exactly the agents it counted", () => {
      seed([
        run({
          runId: "a",
          agentState: "waiting",
          waitingReason: "error",
          title: "one",
          since: NOW - 60_000,
        }),
        run({ runId: "b", agentState: "waiting", title: "two", since: NOW - 30_000 }),
        run({ runId: "c", agentState: "working", title: "three", since: NOW - 10_000 }),
      ]);
      render(<PilotView />);

      const action = screen.getByTestId("pilot-demand-action");
      expect(action.textContent).toBe("2 agents need you");

      fireEvent.click(action);

      // The sentence stated a demand the surface gave no way to act on. As a
      // control it has to deliver the number it advertised.
      expect(screen.getAllByTestId("pilot-row")).toHaveLength(2);
    });

    it("delivers its count even when its filter is already the active one", () => {
      // With the filter already on Needs you, setting it again is a no-op, so
      // nothing clears a collapse the user made — and the button would go on
      // advertising agents while showing none of them.
      seed([
        run({ runId: "a", agentState: "waiting", title: "one", since: NOW - 60_000 }),
        run({ runId: "b", agentState: "waiting", title: "two", since: NOW - 30_000 }),
      ]);
      render(<PilotView />);

      fireEvent.click(screen.getByRole("radio", { name: /Needs you/ }));
      fireEvent.click(screen.getByTestId("pilot-group-toggle"));
      expect(screen.queryAllByTestId("pilot-row")).toHaveLength(0);

      fireEvent.click(screen.getByTestId("pilot-demand-action"));

      expect(screen.getAllByTestId("pilot-row")).toHaveLength(2);
    });

    it("does not count work awaiting review as a demand it can isolate", () => {
      // `review` is a demand band but NOT part of the Needs-you segment, so
      // counting it here would promise agents the button then failed to show.
      seed([
        run({ runId: "a", agentState: "waiting", title: "one", since: NOW - 60_000 }),
        run({ runId: "b", agentState: "completed", title: "two", since: NOW - 30_000 }),
      ]);
      render(<PilotView />);

      expect(screen.getByTestId("pilot-demand-action").textContent).toBe("Agent needs you");

      fireEvent.click(screen.getByTestId("pilot-demand-action"));
      expect(screen.getAllByTestId("pilot-row")).toHaveLength(1);
    });

    it("still reports finished work when nothing else is asking", () => {
      // Dropping review from the demand count must not make a hand-back
      // disappear into "nothing needs you".
      seed([run({ runId: "a", agentState: "completed", title: "one", since: NOW - 30_000 })]);
      render(<PilotView />);

      expect(screen.getByTestId("pilot-summary").textContent).toBe("Ready for review");
      expect(screen.queryByTestId("pilot-demand-action")).toBeNull();
    });

    it("leaves the summary inert when there is no demand to isolate", () => {
      seed([run({ agentState: "working", since: NOW - 60_000 })]);
      render(<PilotView />);

      expect(screen.getByText(/Nothing needs you/)).toBeTruthy();
      expect(screen.queryByTestId("pilot-demand-action")).toBeNull();
    });
  });

  describe("group headers", () => {
    it("summarises a project only once its rows are gone", () => {
      // Expanded, the rows ARE the summary; a sentence restating them is a
      // third thing to read for facts already on screen.
      seed([
        run({
          runId: "a",
          agentState: "waiting",
          waitingReason: "error",
          title: "one",
          since: NOW - 60_000,
        }),
        run({ runId: "b", agentState: "working", title: "two", since: NOW - 60_000 }),
      ]);
      render(<PilotView />);

      const header = () => screen.getByTestId("pilot-group-header").textContent ?? "";
      // Expanded, the header is structure and nothing else — no prose summary,
      // no counts.
      expect(header()).not.toContain("Agent blocked");
      expect(header()).not.toMatch(/\d/);

      fireEvent.click(screen.getByTestId("pilot-group-toggle"));

      // Collapsed, something has to stop a project hiding a blocked agent
      // behind a chevron — one pip per band present, each with its count.
      expect(header()).toMatch(/\d/);
    });

    it("reports a collapsed project's blocked agent through the toggle's name", () => {
      seed([
        run({
          runId: "a",
          agentState: "waiting",
          waitingReason: "error",
          title: "one",
          since: NOW - 60_000,
        }),
        run({ runId: "b", agentState: "working", title: "two", since: NOW - 60_000 }),
      ]);
      usePilotStore.setState({ isOpen: true, collapsedWorkspaceIds: ["p1"] });
      render(<PilotView />);

      // The pips are decorative; the accessible account is the toggle's label,
      // and it has to carry the demand in both states.
      const label = screen.getByTestId("pilot-group-toggle").getAttribute("aria-label") ?? "";
      expect(label).toContain("daintree");
      expect(label).toContain("Agent blocked");
    });
  });

  it("keeps a row in place when its state changes while the dialog is open", async () => {
    seed([
      run({ runId: "first", agentState: "working", title: "first", since: NOW - 10_000 }),
      run({ runId: "second", agentState: "working", title: "second", since: NOW - 5_000 }),
    ]);
    render(<PilotView />);
    expect(screen.getAllByTestId("pilot-row").map((r) => r.textContent)).toEqual([
      expect.stringContaining("first"),
      expect.stringContaining("second"),
    ]);

    // "second" becomes the most urgent run. Its badge must update, but the row
    // must NOT jump above "first" — every row here is a click target, and
    // reordering under the cursor is how a misclick happens.
    seed([
      run({ runId: "first", agentState: "working", title: "first", since: NOW - 10_000 }),
      run({
        runId: "second",
        agentState: "waiting",
        waitingReason: "error",
        title: "second",
        since: NOW,
      }),
    ]);
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getAllByTestId("pilot-row").map((r) => r.textContent)).toEqual([
      expect.stringContaining("first"),
      expect.stringContaining("second"),
    ]);
  });
});
