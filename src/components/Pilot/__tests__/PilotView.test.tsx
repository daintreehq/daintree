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
import { isMac } from "@/lib/platform";
import { useGlobalEscapeDispatcher } from "@/hooks/useGlobalEscapeDispatcher";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { usePilotStore } from "@/store/pilotStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore } from "@/store/createWorktreeStore";
import type { WorktreeSnapshot } from "@shared/types";

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

/**
 * The two workspace stores, with explicit opening times.
 *
 * Group order is workspace MRU, so a fixture that left these out would fall
 * through to the name tiebreak and prove nothing about the rule under test.
 * The default below reproduces that old alphabetical order deliberately, so
 * only the tests that care about recency have to think about it.
 */
function seedWorkspaceOpenings(daintreeOpened: number, spikeOpened: number): void {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test carrier: only id/name/lastOpened are read
  useProjectStore.setState({
    projects: [{ id: "p1", name: "daintree", lastOpened: daintreeOpened }],
  } as Partial<ReturnType<typeof useProjectStore.getState>>);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test carrier: only id/name/lastOpened are read
  useScratchStore.setState({
    scratches: [{ id: "s1", name: "spike", lastOpened: spikeOpened }],
  } as Partial<ReturnType<typeof useScratchStore.getState>>);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dispatchMock.mockClear();
  seedViewWorkspace(null);
  seed(null);
  // Scope reset with the open flag: a leaked project scope would silently
  // narrow every later test's population to one workspace's worktrees.
  usePilotStore.setState({ isOpen: true, scope: { kind: "fleet" }, fellBackFrom: null });
  seedWorkspaceOpenings(NOW, NOW - 60_000);
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

    expect(screen.getByRole("option", { name: /Waiting/ }).textContent).toContain("one");
    expect(screen.getByRole("option", { name: /Idle/ }).textContent).toContain("two");
  });

  it("names a row as a sentence rather than a run of jammed-together facts", () => {
    // Left to the name-from-content computation the row's inline spans
    // concatenate with no separators — "Fix auth2m". Naming the parts is what
    // keeps the row a phrase, and what lets the age be read as an age.
    seed([
      run({
        runId: "a",
        agentId: "claude",
        agentState: "waiting",
        title: "Fix auth",
        cwd: "/repo/feature-x",
        since: NOW - 120_000,
      }),
    ]);
    render(<PilotView />);

    expect(screen.getByTestId("pilot-row").getAttribute("aria-label")).toBe(
      "Fix auth, Claude, Waiting, 2m ago"
    );
  });

  it("leaves no dangling separator when a run has no age to report", () => {
    seed([
      run({
        runId: "a",
        agentId: "claude",
        agentState: "working",
        title: "Fix auth",
        cwd: "/repo/feature-x",
      }),
    ]);
    render(<PilotView />);

    expect(screen.getByTestId("pilot-row").getAttribute("aria-label")).toBe(
      "Fix auth, Claude, Working"
    );
  });

  it("tells two identically-titled runs apart by the agent behind them", () => {
    // The brand is on the row as an icon only, so without it in the name the
    // two are one string to a screen reader — and search already matches on it,
    // because "codex" is a plausible thing to type when looking for one.
    seed([
      run({ runId: "a", agentId: "claude", agentState: "working", title: "same", since: NOW }),
      run({ runId: "b", agentId: "codex", agentState: "working", title: "same", since: NOW }),
    ]);
    render(<PilotView />);

    const names = screen.getAllByTestId("pilot-row").map((r) => r.getAttribute("aria-label"));
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });

  it("does not repeat the agent's name when the title already is it", () => {
    // An untitled run falls back to its agent's name for the title, and
    // "Claude, Claude" is a separator promising a second fact and
    // then not delivering one.
    seed([run({ runId: "a", agentId: "claude", agentState: "working", since: NOW })]);
    render(<PilotView />);

    const name = screen.getByTestId("pilot-row").getAttribute("aria-label") ?? "";
    expect(name).toContain("Claude");
    expect(name.match(/Claude/g)).toHaveLength(1);
  });

  it("treats a differently-cased title as the same identity, not a second fact", () => {
    // Titles come from terminal output, which does not agree with the agent
    // registry about capitalisation. A case-sensitive comparison would let
    // "CLAUDE, Claude, Working" through as though the two said different things.
    seed([
      run({ runId: "a", agentId: "claude", agentState: "working", title: "CLAUDE", since: NOW }),
    ]);
    render(<PilotView />);

    const name = screen.getByTestId("pilot-row").getAttribute("aria-label") ?? "";
    expect(name.match(/claude/gi)).toHaveLength(1);
  });

  it("stops spending row width on a status word the glyph already carries", () => {
    // Seven rows, seven states, and not one of them prints what it is doing.
    // The word cost width beside a title that was already truncating, and the
    // glyph two columns to its left had said the same thing.
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
    expect(rows.filter((row) => /Blocked|Working/.test(row.textContent ?? ""))).toHaveLength(0);

    // ...and every one of the seven still says what it is doing, in text.
    expect(screen.getAllByRole("option", { name: /Working/ })).toHaveLength(6);
    expect(screen.getAllByRole("option", { name: /Blocked/ })).toHaveLength(1);
  });

  it("keeps the worktree searchable after it stops being drawn", () => {
    // A scratch project's directory is a UUID, so the label was charging the
    // title for width to say nothing readable. Typing a branch name to find a
    // run is still useful, which is why the field stays on the row.
    seed([
      run({ runId: "a", agentState: "working", title: "one", cwd: "/repo/feature-x", since: NOW }),
      run({ runId: "b", agentState: "working", title: "two", cwd: "/repo/main-line", since: NOW }),
    ]);
    render(<PilotView />);

    const first = screen.getAllByTestId("pilot-row")[0]!;
    expect(first.textContent).not.toContain("feature-x");
    expect(first.getAttribute("aria-label")).not.toContain("feature-x");

    fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "feature-x" } });

    expect(screen.getAllByTestId("pilot-row")).toHaveLength(1);
    expect(screen.getByText("one")).toBeTruthy();
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

  it("qualifies the summary as last-known while the feed is stale", () => {
    // The stale banner sits directly above this sentence. An unqualified
    // "Nothing needs you" underneath it is the surface making a live all-clear
    // claim out of data it cannot currently see.
    //
    // The live sentence is CAPTURED rather than written out: asserting the
    // literal would copy the summary copy into the test, and the claim here is
    // about the transformation, not the wording.
    const runs = [run({ agentState: "working", title: "one", since: NOW - 60_000 })];
    seed(runs);
    const view = render(<PilotView />);
    const liveSummary = screen.getByTestId("pilot-summary").textContent ?? "";
    expect(liveSummary).not.toBe("");

    act(() => {
      seed(runs, { degraded: true, lastSuccessfulAt: NOW - 12 * 60_000 });
    });
    view.rerender(<PilotView />);

    // The qualifier LEADS. Appended, the reader still meets the all-clear
    // first and the correction only after it has landed.
    const stale = screen.getByTestId("pilot-summary").textContent ?? "";
    expect(stale).toMatch(/^last known/i);
    expect(stale).toContain(liveSummary);
  });

  it("does not offer the zero-data prompt over a retained empty fleet", () => {
    // "Start an agent in any project" over a feed that stopped answering an
    // hour ago presents an unknown as an all-clear. The banner is the only
    // honest thing this state can say.
    seed([], { degraded: true, lastSuccessfulAt: NOW - 12 * 60_000 });
    render(<PilotView />);

    expect(screen.getByTestId("pilot-stale")).toBeTruthy();
    expect(screen.queryByText(EMPTY_FLEET_COPY)).toBeNull();
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

  it("groups rows under their project, most recently opened first", () => {
    seedWorkspaceOpenings(NOW - 60_000, NOW);
    seed([
      run({
        runId: "b",
        workspaceId: "p1",
        agentState: "waiting",
        waitingReason: "error",
        since: NOW - 60_000,
      }),
      run({ runId: "w", workspaceId: "s1", agentState: "working", since: NOW - 10_000 }),
    ]);
    render(<PilotView />);

    const headers = screen.getAllByTestId("pilot-group-header").map((h) => h.textContent ?? "");
    // "spike" was opened last, so it leads even though "daintree" sorts first
    // alphabetically AND is the one holding the blocked run.
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

  it("does not carry a pointer's hold across a reopen", async () => {
    seed([
      run({ runId: "a", agentState: "working", title: "a", since: NOW - 10_000 }),
      run({ runId: "b", agentState: "working", title: "b", since: NOW - 5_000 }),
    ]);
    const view = render(<PilotView />);
    fireEvent.pointerMove(screen.getAllByTestId("pilot-row")[0]!);

    // Close with the hold still taken, let the fleet change, reopen. The new
    // order must reflect the fleet as it is NOW — a hold that survived would
    // serve the ranking of a fleet that has moved on.
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

      // Every selectable row is an agent, so Enter has exactly one meaning.
      press("Enter");

      expect(dispatchMock).toHaveBeenCalledWith("pilot.openRun", {
        runId: "a",
        workspaceId: "p1",
      });
    });

    it("leaves the caret alone while there is a query to edit", () => {
      seedTwoProjects();
      render(<PilotView />);

      fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "a" } });

      // Home/End are the list's structural keys AND the search box's editing
      // keys, and the box owns focus. With text in it, the caret wins, so the
      // highlight must not jump to the last row.
      press("End");
      expect(selected().text).toContain("alpha");
      // ...but Up/Down never belong to a single-line caret.
      press("ArrowDown");
      expect(selected().text).not.toContain("alpha");
    });

    it("hands the horizontal arrows to the caret outright", () => {
      // With no disclosure the list has no horizontal axis, so neither the
      // input nor the results region may cancel these — a palette that eats a
      // key it does nothing with is a palette the browser can't work around.
      seedTwoProjects();
      render(<PilotView />);

      const search = screen.getByTestId("pilot-search");
      expect(fireEvent.keyDown(search, { key: "ArrowLeft" })).toBe(true);
      expect(fireEvent.keyDown(search, { key: "ArrowRight" })).toBe(true);

      const region = screen.getByRole("group", { name: "Agents" });
      expect(fireEvent.keyDown(region, { key: "ArrowLeft" })).toBe(true);
      expect(fireEvent.keyDown(region, { key: "ArrowRight" })).toBe(true);
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

      fireEvent.click(segment(/Waiting/));

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

      fireEvent.click(segment(/Waiting/));

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
      expect(segment(/Waiting/).getAttribute("aria-label")).toBe("Waiting, 1 agent");
      expect(segment(/Working/).getAttribute("aria-label")).toBe("Working, 1 agent");
    });

    it("holds the counts still while the segment changes", () => {
      // Selecting a segment must not rewrite the numbers next to the others, or
      // the bar stops being a map of the fleet and becomes a mirror of itself.
      seedMixedFleet();
      render(<PilotView />);
      const before = screen.getAllByRole("radio").map((el) => el.getAttribute("aria-label"));

      fireEvent.click(segment(/Waiting/));

      expect(screen.getAllByRole("radio").map((el) => el.getAttribute("aria-label"))).toEqual(
        before
      );
    });

    it("sorts review into Finished and out of Waiting", () => {
      // The asymmetry worth pinning: `review` IS a demand band, so it counts
      // toward `demandCount`, but the Needs-you segment is blocked + needs-you
      // only. A review row must land in exactly one of the two segments.
      seed([
        run({ runId: "r", agentState: "completed", title: "handed back", since: NOW - 30_000 }),
        run({ runId: "w", agentState: "waiting", title: "asking", since: NOW - 30_000 }),
      ]);
      render(<PilotView />);

      expect(segment(/Waiting/).getAttribute("aria-label")).toBe("Waiting, 1 agent");
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
      // Not merely "the new title exists" — the quoted one must no longer be
      // PRESENTED, or a deleted query goes on being quoted back at the user.
      // `EmptyState` cross-fades, so the old title may still be in the DOM;
      // what it may not be is visible to anyone, which is what its exit cell's
      // `aria-hidden` + `inert` pair guarantees.
      for (const stale of screen.queryAllByText(/No matches for/)) {
        expect(stale.closest('[aria-hidden="true"],[inert]')).not.toBeNull();
      }
    });

    it("keeps the footer honest about whose keys are whose", () => {
      // The hints describe the LIST's keys. On a filter segment those keys move
      // between segments instead, so leaving "↵ Open" up is the same false
      // promise the footer already drops over an empty list.
      seedMixedFleet();
      render(<PilotView />);
      expect(screen.getByText("Open")).toBeTruthy();

      act(() => {
        segment(/^All/).focus();
      });
      expect(screen.queryByText("Open")).toBeNull();

      act(() => {
        screen.getByTestId("pilot-search").focus();
      });
      expect(screen.getByText("Open")).toBeTruthy();
    });

    it("restores the hints after the bar disappears under the cursor", () => {
      // Removing a focused element fires no reliable blur, so a fleet that
      // drains while a segment holds focus would leave the flag stuck and the
      // hints suppressed for the rest of the opening.
      seedMixedFleet();
      const view = render(<PilotView />);
      act(() => {
        segment(/^All/).focus();
      });
      expect(screen.queryByText("Open")).toBeNull();

      act(() => {
        seed([]);
      });
      view.rerender(<PilotView />);
      expect(screen.queryByTestId("pilot-filter-bar")).toBeNull();

      act(() => {
        seedMixedFleet();
      });
      view.rerender(<PilotView />);

      expect(screen.getByText("Open")).toBeTruthy();
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

    it("holds a pointer's order through a filter coming and going", () => {
      // A filter must narrow the order the pointer is holding, never re-derive
      // one underneath it — every row here is a click target.
      seed([
        run({ runId: "a", agentState: "waiting", title: "alpha", since: NOW - 10_000 }),
        run({ runId: "b", agentState: "waiting", title: "bravo", since: NOW - 5_000 }),
      ]);
      render(<PilotView />);
      // Titles, not full text: "bravo" changes band below, so its glyph
      // legitimately changes. Position is what must not.
      const titles = () =>
        screen.getAllByTestId("pilot-row").map((r) => r.getAttribute("aria-label")?.split(",")[0]);
      fireEvent.pointerMove(screen.getAllByTestId("pilot-row")[0]!);
      const held = titles();

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
      fireEvent.click(screen.getByRole("radio", { name: /Waiting/ }));
      // Asserted WHILE narrowed, not only after returning to All: a filter that
      // re-derived the order would be invisible if the check waited until the
      // held order had been restored anyway.
      expect(titles()).toEqual(held);

      fireEvent.click(screen.getByRole("radio", { name: /^All/ }));
      expect(titles()).toEqual(held);
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
      fireEvent.click(segment(/Waiting/));
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

    it("hands focus back to the search box after applying its filter", () => {
      // While focus sits on the button the body's handler bails on events that
      // did not come from the scroller, so the arrow keys do nothing at all —
      // focus has to go back for the list to be navigable again.
      seed([
        run({ runId: "a", agentState: "waiting", title: "one", since: NOW - 60_000 }),
        run({ runId: "b", agentState: "waiting", title: "two", since: NOW - 30_000 }),
      ]);
      render(<PilotView />);

      // Focus has to START on the button, or this passes on whatever the
      // palette's autofocus happened to leave behind and would go on passing
      // with the handoff deleted.
      const action = screen.getByTestId("pilot-demand-action");
      act(() => action.focus());
      expect(document.activeElement).toBe(action);

      fireEvent.click(action);

      expect(document.activeElement).toBe(screen.getByTestId("pilot-search"));
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

    it("is named by the sentence it shows, not by a second phrasing of it", () => {
      // An action-phrased label ("Show 2 agents that need you") does not
      // contain the visible text, which is a label-in-name failure for anyone
      // driving the app by voice — and its singular read "1 agent that need
      // you". The visible sentence has to BE the name.
      seed([
        run({ runId: "a", agentState: "waiting", title: "one", since: NOW - 60_000 }),
        run({ runId: "b", agentState: "waiting", title: "two", since: NOW - 30_000 }),
      ]);
      render(<PilotView />);

      const action = screen.getByTestId("pilot-demand-action");
      expect(screen.getByRole("button", { name: action.textContent ?? "" })).toBe(action);
    });

    it("leaves the summary inert when there is no demand to isolate", () => {
      seed([run({ agentState: "working", since: NOW - 60_000 })]);
      render(<PilotView />);

      expect(screen.getByText(/Nothing needs you/)).toBeTruthy();
      expect(screen.queryByTestId("pilot-demand-action")).toBeNull();
    });
  });

  describe("group headers", () => {
    it("carries the project's name to every option filed under it", () => {
      // The header is not an item, so a screen reader learns which project a
      // run belongs to from the enclosing group's name and nowhere else.
      seed([
        run({ runId: "a", workspaceId: "p1", agentState: "working", since: NOW - 60_000 }),
        run({ runId: "b", workspaceId: "s1", agentState: "working", since: NOW - 60_000 }),
      ]);
      render(<PilotView />);

      const names = screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
      expect(names).toContain("daintree");
      expect(names).toContain("spike");
    });

    it("names the current workspace in the group's own label, not just on screen", () => {
      // Which workspace you are already in decides whether opening a run is
      // instant or swaps the whole view. The header renders that as a word and
      // then hides it, so without this the fact is visual-only.
      seedViewWorkspace("p1");
      seed([
        run({ runId: "a", workspaceId: "p1", agentState: "working", since: NOW - 60_000 }),
        run({ runId: "b", workspaceId: "s1", agentState: "working", since: NOW - 60_000 }),
      ]);
      render(<PilotView />);

      const labelled = screen
        .getAllByRole("group")
        .map((g) => g.getAttribute("aria-label") ?? "")
        .filter((label) => label.includes("current workspace"));

      expect(labelled).toHaveLength(1);
      expect(labelled[0]).toContain("daintree");
    });

    it("is not a control, so the list holds nothing but options", () => {
      // A `<button>` inside a `role="group"` inside a `role="listbox"` was
      // never structurally right: a listbox's children are options. The
      // disclosure it served is gone with it.
      seed([run({ agentState: "working", since: NOW - 10_000 })]);
      render(<PilotView />);

      expect(screen.getByTestId("pilot-group-header")).toBeTruthy();
      expect(screen.queryByTestId("pilot-group-toggle")).toBeNull();
      expect(screen.getByRole("listbox").querySelector("button")).toBeNull();
    });
  });

  describe("ordering", () => {
    /** Row titles in rendered order, read off the name so a glyph change can't confuse it. */
    function order(): (string | undefined)[] {
      return screen
        .getAllByTestId("pilot-row")
        .map((r) => r.getAttribute("aria-label")?.split(",")[0]);
    }

    function seedTwo(secondBlocked: boolean) {
      seed([
        run({ runId: "first", agentState: "working", title: "first", since: NOW - 10_000 }),
        secondBlocked
          ? run({
              runId: "second",
              agentState: "waiting",
              waitingReason: "error",
              title: "second",
              since: NOW,
            })
          : run({ runId: "second", agentState: "working", title: "second", since: NOW - 5_000 }),
      ]);
    }

    it("re-ranks a run that blocks while the list is being read", async () => {
      // The ranking IS the answer this surface gives. An agent that blocks
      // while you are looking at the list sitting below every working one until
      // you close and reopen is the ranking lying.
      seedTwo(false);
      render(<PilotView />);
      expect(order()).toEqual(["first", "second"]);

      act(() => seedTwo(true));
      await vi.advanceTimersByTimeAsync(0);

      expect(order()).toEqual(["second", "first"]);
    });

    it("lands a newly-spawned run at its real rank rather than the end", async () => {
      seedTwo(false);
      render(<PilotView />);

      act(() => {
        seed([
          run({ runId: "first", agentState: "working", title: "first", since: NOW - 10_000 }),
          run({ runId: "second", agentState: "working", title: "second", since: NOW - 5_000 }),
          run({
            runId: "third",
            agentState: "waiting",
            waitingReason: "error",
            title: "third",
            since: NOW,
          }),
        ]);
      });
      await vi.advanceTimersByTimeAsync(0);

      // Appending it would bury a blocked agent under two working ones for the
      // rest of the opening.
      expect(order()[0]).toBe("third");
    });

    it("holds the order still while a pointer is working the list", async () => {
      seedTwo(false);
      render(<PilotView />);
      fireEvent.pointerMove(screen.getAllByTestId("pilot-row")[0]!);

      act(() => seedTwo(true));
      await vi.advanceTimersByTimeAsync(0);

      // Every row is a click target, and a row that moves out from under an
      // aimed cursor is how a misclick happens.
      expect(order()).toEqual(["first", "second"]);
    });

    it("selects the row the pointer is aimed at", () => {
      seedTwo(false);
      render(<PilotView />);

      fireEvent.pointerMove(screen.getAllByTestId("pilot-row")[1]!);

      // Hover and the Enter target were two different lit rows before this.
      expect(
        document.querySelector('[aria-selected="true"]')?.getAttribute("aria-label")
      ).toContain("second");
    });

    it("re-ranks the moment the pointer leaves the list", async () => {
      seedTwo(false);
      render(<PilotView />);
      fireEvent.pointerMove(screen.getAllByTestId("pilot-row")[0]!);
      act(() => seedTwo(true));
      await vi.advanceTimersByTimeAsync(0);
      expect(order()).toEqual(["first", "second"]);

      fireEvent.pointerLeave(document.getElementById("pilot-agent-list")!);

      expect(order()).toEqual(["second", "first"]);
    });

    it("gives the list back to the keyboard on the next arrow, from what was on screen", async () => {
      // Three rows, and the one that blocks is the MIDDLE one. Two rows would
      // prove nothing: whichever order they are in, the row after the first is
      // the other one, so this would pass against an arrow that walked the live
      // ranking instead of the held one.
      const seedThree = (middleBlocked: boolean) => {
        seed([
          run({ runId: "a", agentState: "working", title: "aaa", since: NOW - 30_000 }),
          middleBlocked
            ? run({
                runId: "b",
                agentState: "waiting",
                waitingReason: "error",
                title: "bbb",
                since: NOW,
              })
            : run({ runId: "b", agentState: "working", title: "bbb", since: NOW - 20_000 }),
          run({ runId: "c", agentState: "working", title: "ccc", since: NOW - 10_000 }),
        ]);
      };
      seedThree(false);
      render(<PilotView />);
      fireEvent.pointerMove(screen.getAllByTestId("pilot-row")[0]!);
      act(() => seedThree(true));
      await vi.advanceTimersByTimeAsync(0);
      expect(order()).toEqual(["aaa", "bbb", "ccc"]);

      // Stepping happens against the held order, where "bbb" is still the row
      // below "aaa"; against the live order it would be "ccc". Only then does
      // the hold release, and the id-keyed selection survives the re-rank.
      fireEvent.keyDown(screen.getByTestId("pilot-search"), { key: "ArrowDown" });

      expect(
        document.querySelector('[aria-selected="true"]')?.getAttribute("aria-label")
      ).toContain("bbb");
      expect(order()).toEqual(["bbb", "aaa", "ccc"]);
    });

    it("holds whole projects still, not just the rows inside them", async () => {
      // The group half of the re-sort has its own branch, so a hold that kept
      // rows in place while letting entire projects jump under the pointer
      // would otherwise pass everything above.
      seed([
        run({ runId: "a", workspaceId: "p1", agentState: "working", title: "in daintree" }),
        run({ runId: "b", workspaceId: "s1", agentState: "working", title: "in spike" }),
      ]);
      // Read through the rows rather than the header text: one row per project
      // means row order IS group order, and the workspace-name lookup does not
      // survive the microtask flush this test needs (the name loaders resolve
      // against no IPC host and empty their stores).
      render(<PilotView />);
      expect(order()).toEqual(["in daintree", "in spike"]);

      fireEvent.pointerMove(screen.getAllByTestId("pilot-row")[0]!);
      // Let those mount-time loaders settle first, since they empty both stores:
      // the switch below has to be seeded on top of that, not before it.
      await vi.advanceTimersByTimeAsync(0);
      // Switching to the scratch elsewhere makes it the most recently opened,
      // which is the only thing that reorders groups now.
      act(() => seedWorkspaceOpenings(NOW - 60_000, NOW));
      expect(order()).toEqual(["in daintree", "in spike"]);

      fireEvent.pointerLeave(document.getElementById("pilot-agent-list")!);

      // The newly opened project leads the moment the pointer stops protecting
      // the position it was aimed at.
      expect(order()).toEqual(["in spike", "in daintree"]);
    });

    it("does not re-take the hold at a newer rank on every pointer move", async () => {
      // Capture-once. Re-capturing on each move would make the hold track the
      // live ranking rather than the screen, so a row could still shift under a
      // cursor that had never left the list.
      seedTwo(false);
      render(<PilotView />);
      fireEvent.pointerMove(screen.getAllByTestId("pilot-row")[0]!);
      act(() => seedTwo(true));
      await vi.advanceTimersByTimeAsync(0);

      fireEvent.pointerMove(screen.getAllByTestId("pilot-row")[0]!);

      expect(order()).toEqual(["first", "second"]);
    });

    it("parks a run that arrives during a hold, then ranks it on release", async () => {
      seedTwo(false);
      render(<PilotView />);
      fireEvent.pointerMove(screen.getAllByTestId("pilot-row")[0]!);

      act(() => {
        seed([
          run({ runId: "first", agentState: "working", title: "first", since: NOW - 10_000 }),
          run({ runId: "second", agentState: "working", title: "second", since: NOW - 5_000 }),
          run({
            runId: "third",
            agentState: "waiting",
            waitingReason: "error",
            title: "third",
            since: NOW,
          }),
        ]);
      });
      await vi.advanceTimersByTimeAsync(0);

      // Nothing the capture never saw may displace a row the cursor is aimed
      // at, so it waits at the tail...
      expect(order()).toEqual(["first", "second", "third"]);

      fireEvent.pointerLeave(document.getElementById("pilot-agent-list")!);

      // ...and takes its real rank immediately, rather than being stranded at
      // the end for the rest of the opening the way the old freeze left it.
      expect(order()).toEqual(["third", "first", "second"]);
    });

    it("releases on a key consumed from the results region, not just from the input", async () => {
      // After Tab the scroller owns the keyboard and forwards a fixed key set.
      // A release wired only to the input path would leave the order held for
      // anyone driving the list from there.
      seedTwo(false);
      render(<PilotView />);
      fireEvent.pointerMove(screen.getAllByTestId("pilot-row")[0]!);
      act(() => seedTwo(true));
      await vi.advanceTimersByTimeAsync(0);
      expect(order()).toEqual(["first", "second"]);

      fireEvent.keyDown(screen.getByRole("group", { name: "Agents" }), { key: "ArrowDown" });

      expect(order()).toEqual(["second", "first"]);
    });

    it("releases the hold when the app goes to the background", async () => {
      // Nothing else can: the cursor never moves while another app is focused,
      // so no boundary event fires, and coming back to a ranking frozen since
      // before you left is the staleness this replaced.
      seedTwo(false);
      render(<PilotView />);
      fireEvent.pointerMove(screen.getAllByTestId("pilot-row")[0]!);
      act(() => seedTwo(true));
      await vi.advanceTimersByTimeAsync(0);
      expect(order()).toEqual(["first", "second"]);

      act(() => {
        window.dispatchEvent(new Event("blur"));
      });

      expect(order()).toEqual(["second", "first"]);
    });

    it("leaves the hold alone for a key the list never acted on", async () => {
      seedTwo(false);
      render(<PilotView />);
      fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "s" } });
      fireEvent.pointerMove(screen.getAllByTestId("pilot-row")[0]!);

      // End belongs to the caret while there is a query to edit, so the list
      // never moves — and a hold released by a key that did nothing would let
      // the rows shift under a cursor that had not been given up.
      fireEvent.keyDown(screen.getByTestId("pilot-search"), { key: "End" });
      act(() => {
        seed([
          run({ runId: "first", agentState: "working", title: "first s", since: NOW - 10_000 }),
          run({
            runId: "second",
            agentState: "waiting",
            waitingReason: "error",
            title: "second s",
            since: NOW,
          }),
        ]);
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(order()).toEqual(["first s", "second s"]);
    });
  });

  describe("group demand chips", () => {
    it("summarises each project's demand on its header, worst band first", () => {
      seed([
        run({ runId: "a", workspaceId: "p1", agentState: "waiting", since: NOW - 60_000 }),
        run({ runId: "b", workspaceId: "p1", agentState: "working", since: NOW - 60_000 }),
        run({ runId: "c", workspaceId: "s1", agentState: "working", since: NOW - 60_000 }),
      ]);
      render(<PilotView />);

      // One chip, on the one project with a demand — a busy-but-quiet project
      // earns nothing, or the chip stops meaning "needs you".
      const chips = screen.getAllByTestId("pilot-group-demand");
      expect(chips).toHaveLength(1);
      expect(chips[0]!.textContent).toContain("1");

      // The group's accessible name says the same thing in words.
      expect(screen.getByRole("group", { name: /daintree, Agent needs you/ })).toBeTruthy();
    });

    it("drops the chip when the query filters the demand away", () => {
      // The chip summarises the rows actually beneath the header — a header
      // still announcing a demand its own list no longer shows would be the
      // false signal this surface exists to remove.
      seed([
        run({
          runId: "a",
          workspaceId: "p1",
          agentState: "waiting",
          title: "auth spike",
          since: NOW,
        }),
        run({
          runId: "b",
          workspaceId: "p1",
          agentState: "working",
          title: "docs pass",
          since: NOW,
        }),
      ]);
      render(<PilotView />);
      expect(screen.getByTestId("pilot-group-demand")).toBeTruthy();

      fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "docs" } });

      expect(screen.queryByTestId("pilot-group-demand")).toBeNull();
      expect(screen.queryByRole("group", { name: /needs you/ })).toBeNull();
    });

    it("counts every demand band, not just waiting", () => {
      seed([
        run({
          runId: "a",
          workspaceId: "p1",
          agentState: "waiting",
          waitingReason: "error",
          since: NOW,
        }),
        run({ runId: "b", workspaceId: "p1", agentState: "waiting", since: NOW }),
        run({ runId: "c", workspaceId: "p1", agentState: "completed", since: NOW }),
      ]);
      render(<PilotView />);

      expect(screen.getByTestId("pilot-group-demand").textContent).toContain("3");
    });
  });

  describe("stall cue", () => {
    it("marks a working run that main flagged as quiet", () => {
      seed([
        run({
          agentState: "working",
          title: "long migration",
          since: NOW - 3_600_000,
          quietSince: NOW - 12 * 60_000,
        }),
      ]);
      render(<PilotView />);

      expect(screen.getByText("quiet 12m")).toBeTruthy();
      // And the fact reaches the accessible name, since the cue itself is
      // decoration.
      expect(screen.getByRole("option", { name: /quiet for 12m/ })).toBeTruthy();
    });
  });

  describe("parking", () => {
    const parkRunMock = vi.fn();
    const unparkRunMock = vi.fn();

    beforeEach(() => {
      parkRunMock.mockReset().mockResolvedValue({ parkedAt: NOW });
      unparkRunMock.mockReset().mockResolvedValue(true);
      window.electron = {
        fleet: { parkRun: parkRunMock, unparkRun: unparkRunMock },
      } as unknown as typeof window.electron;
    });

    afterEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any).electron;
    });

    function altEnter() {
      fireEvent.keyDown(screen.getByTestId("pilot-search"), { key: "Enter", altKey: true });
    }

    it("advertises the park verb for the highlighted row", () => {
      seed([run({ agentState: "waiting", title: "auth spike", since: NOW - 60_000 })]);
      render(<PilotView />);

      expect(screen.getByTestId("pilot-park-hint").textContent).toContain("Park");
    });

    it("renames the verb when the highlighted row is already parked", () => {
      seed([
        run({
          agentState: "waiting",
          title: "auth spike",
          since: NOW - 60_000,
          park: { parkedAt: NOW - 30_000 },
        }),
      ]);
      render(<PilotView />);

      expect(screen.getByTestId("pilot-park-hint").textContent).toContain("Edit park");
    });

    it("shows the park note on the row itself", () => {
      seed([
        run({
          agentState: "waiting",
          title: "auth spike",
          since: NOW - 60_000,
          park: { parkedAt: NOW - 30_000, note: "after the migration lands" },
        }),
      ]);
      render(<PilotView />);

      expect(screen.getByText("after the migration lands")).toBeTruthy();
    });

    it("opens the editor with Alt+Enter, replacing the list and its controls", () => {
      seed([run({ agentState: "waiting", title: "auth spike", since: NOW - 60_000 })]);
      render(<PilotView />);

      altEnter();

      expect(screen.getByTestId("pilot-park-editor")).toBeTruthy();
      // A query box filtering an invisible list would be a control acting
      // somewhere the user cannot see.
      expect(screen.queryByTestId("pilot-search")).toBeNull();
      expect(screen.queryByTestId("pilot-filter-bar")).toBeNull();
    });

    it("parks the highlighted run with the typed note", async () => {
      seed([run({ agentState: "waiting", title: "auth spike", since: NOW - 60_000 })]);
      render(<PilotView />);
      altEnter();

      const note = screen.getByTestId("pilot-park-note");
      fireEvent.change(note, { target: { value: "  waiting on studio-02  " } });
      await act(async () => {
        fireEvent.keyDown(note, { key: "Enter" });
      });

      // Trimmed before it crosses the wire — the service would re-trim, but
      // the renderer should not knowingly send padding.
      expect(parkRunMock).toHaveBeenCalledWith("t1", { note: "waiting on studio-02" });
      expect(screen.queryByTestId("pilot-park-editor")).toBeNull();
      // Back on the list, with focus at the palette's home position.
      expect(document.activeElement).toBe(screen.getByTestId("pilot-search"));
    });

    it("parks until a chosen gate", async () => {
      seed([
        run({ runId: "t1", agentState: "waiting", title: "downstream", since: NOW - 60_000 }),
        run({ runId: "t2", agentState: "working", title: "upstream", since: NOW - 30_000 }),
      ]);
      render(<PilotView />);
      altEnter();

      // The waiting run ranks first, so the editor targets t1 and offers t2.
      fireEvent.click(screen.getByRole("radio", { name: /upstream/ }));
      await act(async () => {
        fireEvent.keyDown(screen.getByTestId("pilot-park-note"), { key: "Enter" });
      });

      expect(parkRunMock).toHaveBeenCalledWith("t1", { gateRunId: "t2" });
    });

    it("unparks from the editor of an already-parked run", async () => {
      seed([
        run({
          agentState: "waiting",
          title: "auth spike",
          since: NOW - 60_000,
          park: { parkedAt: NOW - 30_000, note: "old note" },
        }),
      ]);
      render(<PilotView />);
      altEnter();

      await act(async () => {
        fireEvent.click(screen.getByTestId("pilot-park-unpark"));
      });

      expect(unparkRunMock).toHaveBeenCalledWith("t1");
      expect(parkRunMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId("pilot-park-editor")).toBeNull();
    });

    it("cancel returns to the list without touching the park", async () => {
      seed([run({ agentState: "waiting", title: "auth spike", since: NOW - 60_000 })]);
      render(<PilotView />);
      altEnter();

      await act(async () => {
        fireEvent.click(screen.getByTestId("pilot-park-cancel"));
      });

      expect(parkRunMock).not.toHaveBeenCalled();
      expect(unparkRunMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId("pilot-park-editor")).toBeNull();
      expect(screen.getByTestId("pilot-search")).toBeTruthy();
    });

    it("surfaces a rejected park inline and stays open", async () => {
      parkRunMock.mockRejectedValue(new Error("Fleet state is unavailable right now"));
      seed([run({ agentState: "waiting", title: "auth spike", since: NOW - 60_000 })]);
      render(<PilotView />);
      altEnter();

      await act(async () => {
        fireEvent.keyDown(screen.getByTestId("pilot-park-note"), { key: "Enter" });
      });

      expect(screen.getByRole("alert").textContent).toContain("Fleet state is unavailable");
      expect(screen.getByTestId("pilot-park-editor")).toBeTruthy();
    });

    it("closes only the editor on Escape, leaving the palette open", () => {
      seed([run({ agentState: "waiting", title: "auth spike", since: NOW - 60_000 })]);
      render(<PilotView />);
      altEnter();
      expect(screen.getByTestId("pilot-park-editor")).toBeTruthy();

      // A real bubbled Escape, which the palette's document-level backstop
      // sees first — the dialog's onClose is delegated to the editor while it
      // is open, so the key must pop the mode and not the surface.
      fireEvent.keyDown(screen.getByTestId("pilot-park-note"), { key: "Escape" });

      expect(screen.queryByTestId("pilot-park-editor")).toBeNull();
      expect(screen.getByTestId("pilot-search")).toBeTruthy();
    });

    it("ignores the opening chord's key-repeat — a modified Enter never submits", () => {
      seed([run({ agentState: "waiting", title: "auth spike", since: NOW - 60_000 })]);
      render(<PilotView />);
      altEnter();

      const note = screen.getByTestId("pilot-park-note");
      fireEvent.keyDown(note, { key: "Enter", altKey: true });
      fireEvent.keyDown(note, { key: "Enter", repeat: true });

      expect(parkRunMock).not.toHaveBeenCalled();
      expect(screen.getByTestId("pilot-park-editor")).toBeTruthy();
    });

    it("offers no parking over retained data — Main would reject it anyway", () => {
      seed([run({ agentState: "waiting", title: "auth spike", since: NOW - 60_000 })], {
        degraded: true,
        lastSuccessfulAt: NOW - 60_000,
      });
      render(<PilotView />);

      expect(screen.queryByTestId("pilot-park-hint")).toBeNull();
      altEnter();
      expect(screen.queryByTestId("pilot-park-editor")).toBeNull();
    });

    it("falls back to the list when the run being parked disappears", async () => {
      seed([run({ agentState: "waiting", title: "auth spike", since: NOW - 60_000 })]);
      render(<PilotView />);
      altEnter();
      expect(screen.getByTestId("pilot-park-editor")).toBeTruthy();

      act(() => {
        seed([]);
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(screen.queryByTestId("pilot-park-editor")).toBeNull();
    });
  });
});

describe("PilotView worktree scope", () => {
  /**
   * The drill modifier, resolved the way the component resolves it.
   *
   * Hard-coding `metaKey` would make this suite pass on a developer's Mac and
   * fail on CI's Linux — the chord under test is genuinely different there, so
   * the fixture has to be too.
   */
  const DRILL_MODIFIER = isMac() ? { metaKey: true } : { ctrlKey: true };

  /** A project spread over two worktrees plus one root-launched run. */
  function seedSpread(): void {
    seed([
      run({
        runId: "alpha-1",
        worktreeId: "/repo/wt/alpha",
        title: "auth refactor",
        agentState: "waiting",
        since: NOW - 60_000,
      }),
      run({
        runId: "beta-1",
        worktreeId: "/repo/wt/beta",
        title: "docs pass",
        agentState: "working",
        since: NOW - 60_000,
      }),
      run({ runId: "root-1", title: "shell", agentState: "working", since: NOW - 60_000 }),
    ]);
  }

  /**
   * Section names in rendered order, read off the group labels.
   *
   * Scoped to the listbox: the palette body is itself a `role="group"` (it
   * carries the scroller's accessible name), so an unscoped query would count
   * the container as a section.
   */
  function sections(): string[] {
    return [...screen.getByRole("listbox").querySelectorAll('[role="group"]')].map(
      (group) => (group.getAttribute("aria-label") ?? "").split(",")[0] ?? ""
    );
  }

  /** The first project heading, which is `daintree` under the default MRU seed. */
  function drillHeader(): HTMLElement {
    return screen.getAllByTestId("pilot-group-header")[0]!;
  }

  describe("drilling in", () => {
    it("regroups one project's runs by worktree when its header is clicked", () => {
      seedSpread();
      render(<PilotView />);

      fireEvent.click(drillHeader());

      // The unbucketed run leads. With no worktree store behind this render
      // there is no root to name, so nothing can be promoted over it.
      expect(sections()).toEqual(["No worktree", "alpha", "beta"]);
      expect(screen.getAllByTestId("pilot-row")).toHaveLength(3);
    });

    it("offers no drill on a project with a single worktree bucket", () => {
      // Regrouping would produce one section holding the rows already on
      // screen, so the affordance would promise something it cannot deliver.
      seed([
        run({ runId: "a", worktreeId: "/repo/wt/alpha", agentState: "working" }),
        run({ runId: "b", worktreeId: "/repo/wt/alpha", agentState: "working" }),
      ]);
      render(<PilotView />);

      expect(screen.queryByTestId("pilot-group-drill")).toBeNull();
      fireEvent.click(drillHeader());
      expect(usePilotStore.getState().scope).toEqual({ kind: "fleet" });
    });

    it("withdraws the drill when a query narrows the project to one worktree", () => {
      // The affordance is computed from the rows actually drawn, so it cannot
      // outlive the axis the user can currently see.
      seedSpread();
      render(<PilotView />);

      fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "auth" } });

      expect(screen.queryByTestId("pilot-group-drill")).toBeNull();
    });

    it("drills from the keyboard on the highlighted run", () => {
      // The heading is outside the arrow-key domain by design, so the keyboard
      // form lands on the run — which names its project unambiguously.
      seedSpread();
      render(<PilotView />);

      fireEvent.keyDown(screen.getByTestId("pilot-search"), {
        key: "Enter",
        ...DRILL_MODIFIER,
      });

      expect(usePilotStore.getState().scope).toEqual({ kind: "project", workspaceId: "p1" });
      expect(sections()).toEqual(["No worktree", "alpha", "beta"]);
    });

    it("does not open the highlighted run when the chord drills", () => {
      seedSpread();
      render(<PilotView />);

      fireEvent.keyDown(screen.getByTestId("pilot-search"), {
        key: "Enter",
        ...DRILL_MODIFIER,
      });

      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("leaves the chord inert where there is no worktree axis", () => {
      // Inert means inert. The navigation model reads `Enter` and nothing else
      // about the event, so a chord the drill declines falls straight through
      // to "open the highlighted run" — acting on a verb the user did not ask
      // for is a worse answer than doing nothing.
      seed([run({ runId: "a", worktreeId: "/repo/wt/alpha", agentState: "working" })]);
      render(<PilotView />);

      fireEvent.keyDown(screen.getByTestId("pilot-search"), {
        key: "Enter",
        ...DRILL_MODIFIER,
      });

      expect(usePilotStore.getState().scope).toEqual({ kind: "fleet" });
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("leaves a repeat of the chord inert once it has already drilled", () => {
      // Holding the chord repeats it. The second event arrives in the scoped
      // view where there is nothing left to drill into, and must not turn into
      // an activation of whatever row the reset selection landed on.
      seedSpread();
      render(<PilotView />);
      const search = screen.getByTestId("pilot-search");

      fireEvent.keyDown(search, { key: "Enter", ...DRILL_MODIFIER });
      fireEvent.keyDown(search, { key: "Enter", ...DRILL_MODIFIER, repeat: true });

      expect(usePilotStore.getState().scope).toEqual({ kind: "project", workspaceId: "p1" });
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("drills into the project the arrows are on, not the first one listed", () => {
      // With one project in the fixture a regression that always took the top
      // group would pass. The selection has to be what decides.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test carrier: only id/name/lastOpened are read
      useProjectStore.setState({
        projects: [
          { id: "p1", name: "daintree", lastOpened: NOW },
          { id: "p2", name: "atlas", lastOpened: NOW - 60_000 },
        ],
      } as Partial<ReturnType<typeof useProjectStore.getState>>);
      seed([
        run({ runId: "d-a", worktreeId: "/d/alpha", agentState: "working", since: NOW - 60_000 }),
        run({ runId: "d-b", worktreeId: "/d/beta", agentState: "working", since: NOW - 60_000 }),
        run({
          runId: "a-a",
          workspaceId: "p2",
          worktreeId: "/a/alpha",
          agentState: "working",
          since: NOW - 60_000,
        }),
        run({
          runId: "a-b",
          workspaceId: "p2",
          worktreeId: "/a/beta",
          agentState: "working",
          since: NOW - 60_000,
        }),
      ]);
      render(<PilotView />);
      const search = screen.getByTestId("pilot-search");

      // Past daintree's two runs and onto the first of atlas's.
      fireEvent.keyDown(search, { key: "ArrowDown" });
      fireEvent.keyDown(search, { key: "ArrowDown" });
      fireEvent.keyDown(search, { key: "Enter", ...DRILL_MODIFIER });

      expect(usePilotStore.getState().scope).toEqual({ kind: "project", workspaceId: "p2" });
    });

    it("still parks when the park modifier rides along with the drill one", () => {
      // Alt+Enter is the park chord and it has to win: letting the drill run
      // first would regroup a project instead of shelving the run under the
      // cursor, on a keystroke the user aimed at one row.
      seedSpread();
      render(<PilotView />);

      fireEvent.keyDown(screen.getByTestId("pilot-search"), {
        key: "Enter",
        altKey: true,
        ...DRILL_MODIFIER,
      });

      expect(usePilotStore.getState().scope).toEqual({ kind: "fleet" });
      expect(screen.getByTestId("pilot-park-editor")).toBeTruthy();
    });

    it("does not turn an unavailable park into a drill", () => {
      // Alt+Enter is the park chord, and parking needs a snapshot Main can
      // validate against. Over a degraded one it has to stay inert — falling
      // through to the drill would make the surface do the OTHER verb that
      // happens to share the keystroke, purely because the asked-for one was
      // unavailable.
      seed(
        [
          run({
            runId: "alpha-1",
            worktreeId: "/repo/wt/alpha",
            agentState: "working",
            since: NOW - 60_000,
          }),
          run({
            runId: "beta-1",
            worktreeId: "/repo/wt/beta",
            agentState: "working",
            since: NOW - 60_000,
          }),
        ],
        { degraded: true, lastSuccessfulAt: NOW - 12 * 60_000 }
      );
      render(<PilotView />);

      fireEvent.keyDown(screen.getByTestId("pilot-search"), {
        key: "Enter",
        altKey: true,
        ...DRILL_MODIFIER,
      });

      expect(usePilotStore.getState().scope).toEqual({ kind: "fleet" });
      expect(screen.queryByTestId("pilot-park-editor")).toBeNull();
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("advertises the chord only while the highlighted run can use it", () => {
      seedSpread();
      render(<PilotView />);
      expect(screen.getByTestId("pilot-drill-hint")).toBeTruthy();

      fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "auth" } });
      expect(screen.queryByTestId("pilot-drill-hint")).toBeNull();
    });
  });

  describe("opening straight into a scope", () => {
    it("renders by worktree on the first render when the scope preceded the mount", () => {
      // `PilotView` is lazy-mounted on `isOpen`, so the shortcut records its
      // destination in the store and this component has to honour it before any
      // drill gesture exists to fall back on.
      seedSpread();
      usePilotStore.setState({ isOpen: true, scope: { kind: "project", workspaceId: "p1" } });
      render(<PilotView />);

      expect(sections()).toEqual(["No worktree", "alpha", "beta"]);
      expect(screen.getByTestId("pilot-scope-name").textContent).toBe("daintree");
    });

    it("scopes off retained data without dropping the staleness", () => {
      // A degraded feed still holds real rows, so the scoped view is honest —
      // as long as it keeps saying how old they are.
      seed(
        [
          run({ runId: "alpha-1", worktreeId: "/repo/wt/alpha", agentState: "working" }),
          run({ runId: "beta-1", worktreeId: "/repo/wt/beta", agentState: "working" }),
        ],
        { degraded: true, lastSuccessfulAt: NOW - 12 * 60_000 }
      );
      usePilotStore.setState({ isOpen: true, scope: { kind: "project", workspaceId: "p1" } });
      render(<PilotView />);

      expect(sections()).toEqual(["alpha", "beta"]);
      expect(screen.getByTestId("pilot-stale")).toBeTruthy();
      // Parking needs a snapshot Main can validate against, so the hint goes
      // with the data that would back it — scoped or not.
      expect(screen.queryByTestId("pilot-park-hint")).toBeNull();
    });
  });

  describe("the way back", () => {
    function drillIn(): void {
      seedSpread();
      render(<PilotView />);
      fireEvent.click(drillHeader());
    }

    it("names where you are, and offers the way out", () => {
      drillIn();

      expect(screen.getByTestId("pilot-scope-name").textContent).toBe("daintree");
      expect(screen.getByTestId("pilot-scope-back")).toBeTruthy();
    });

    it("returns to the fleet when the breadcrumb is clicked", () => {
      drillIn();

      fireEvent.click(screen.getByTestId("pilot-scope-back"));

      expect(usePilotStore.getState().scope).toEqual({ kind: "fleet" });
      expect(usePilotStore.getState().isOpen).toBe(true);
    });

    it("leaves the scope on Escape before it closes anything", () => {
      function Dispatcher() {
        useGlobalEscapeDispatcher();
        return null;
      }
      seedSpread();
      render(
        <>
          <Dispatcher />
          <PilotView />
        </>
      );
      fireEvent.click(drillHeader());

      fireEvent.keyDown(screen.getByTestId("pilot-search"), { key: "Escape" });
      expect(usePilotStore.getState()).toMatchObject({ isOpen: true, scope: { kind: "fleet" } });

      fireEvent.keyDown(screen.getByTestId("pilot-search"), { key: "Escape" });
      expect(usePilotStore.getState().isOpen).toBe(false);
    });

    it("leaves the scope on Backspace once the box is empty", () => {
      drillIn();

      fireEvent.keyDown(screen.getByTestId("pilot-search"), { key: "Backspace" });

      expect(usePilotStore.getState().scope).toEqual({ kind: "fleet" });
    });

    it("leaves a Backspace alone while there is still a query to delete", () => {
      // The box owns focus by default, so a bare Backspace is an editing key
      // first — taking a character the user meant to remove is the failure.
      drillIn();

      fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "auth" } });
      fireEvent.keyDown(screen.getByTestId("pilot-search"), { key: "Backspace" });

      expect(usePilotStore.getState().scope).toEqual({
        kind: "project",
        workspaceId: "p1",
      });
    });
  });

  describe("the scoped surface", () => {
    /**
     * Two projects in the fleet, so the scoped surface has a population it must
     * be seen to exclude — a fixture holding only the scoped project would let
     * every count below pass while still describing the whole fleet.
     */
    function drillIn(): void {
      seed([
        run({
          runId: "alpha-1",
          worktreeId: "/repo/wt/alpha",
          title: "auth refactor",
          agentState: "waiting",
          since: NOW - 60_000,
        }),
        run({
          runId: "beta-1",
          worktreeId: "/repo/wt/beta",
          title: "docs pass",
          agentState: "working",
          since: NOW - 60_000,
        }),
        run({
          runId: "elsewhere",
          workspaceId: "s1",
          title: "spike run",
          agentState: "waiting",
          since: NOW - 60_000,
        }),
      ]);
      render(<PilotView />);
      fireEvent.click(drillHeader());
    }

    it("counts the scoped population, not the fleet behind it", () => {
      // The footer's sentence is a control that applies a filter, so a count
      // taken over the whole fleet would promise agents it cannot then show.
      drillIn();

      expect(screen.getByTestId("pilot-demand-action").textContent).toBe("Agent needs you");
      expect(screen.getAllByTestId("pilot-row")).toHaveLength(2);
    });

    it("says the list is cut by worktree", () => {
      drillIn();

      expect(screen.getByRole("listbox").getAttribute("aria-label")).toBe("Agents by worktree");
    });

    it("keeps the arrows walking runs and never stopping on a worktree", () => {
      // Resolved to the ELEMENT rather than matched against the id prefix the
      // implementation happens to use: what must hold is that the active
      // descendant names a rendered option, never a heading or the role-less
      // group container — the dangling reference #11071 was about.
      drillIn();
      const search = screen.getByTestId("pilot-search");
      const list = screen.getByRole("listbox");
      const options = new Set([...list.querySelectorAll('[role="option"]')]);
      expect(options.size).toBeGreaterThan(1);

      for (let i = 0; i < 4; i++) {
        const id = search.getAttribute("aria-activedescendant");
        expect(id).not.toBeNull();
        const active = document.getElementById(id!);
        expect(active).not.toBeNull();
        expect(options.has(active!)).toBe(true);
        fireEvent.keyDown(search, { key: "ArrowDown" });
      }
    });

    it("drops the highlight back to the top when the scope changes", () => {
      // Drilling replaces the whole population, so a highlight carried across
      // would land on whatever row inherited its position rather than on the
      // one the user can see is selected.
      seed([
        run({
          runId: "waiting",
          worktreeId: "/repo/wt/alpha",
          agentState: "waiting",
          since: NOW - 600_000,
        }),
        run({ runId: "root", agentState: "working", since: NOW - 600_000 }),
        run({ runId: "beta", worktreeId: "/repo/wt/beta", agentState: "working", since: NOW }),
      ]);
      render(<PilotView />);
      const search = screen.getByTestId("pilot-search");

      // End lands on the fleet's LAST row, which the drill then files under
      // the last section — so inheriting the selection is visibly different
      // from resetting it.
      fireEvent.keyDown(search, { key: "End" });
      const beforeDrill = search.getAttribute("aria-activedescendant");

      fireEvent.click(drillHeader());

      const firstRow = screen.getAllByTestId("pilot-row")[0]!;
      expect(search.getAttribute("aria-activedescendant")).toBe(firstRow.id);
      expect(search.getAttribute("aria-activedescendant")).not.toBe(beforeDrill);
    });

    it("lets the pointer take a fresh hold after a scope change", () => {
      // The hold is a set of ids from ONE axis. Carried across, it ranks every
      // incoming group against ids none of them have and strands them all at
      // the tail — the stale order the hold exists to prevent, arriving through
      // the scope instead of through time.
      seedSpread();
      render(<PilotView />);

      // Take a hold on the fleet axis, then drill out from under it.
      fireEvent.pointerMove(screen.getAllByTestId("pilot-row")[0]!);
      fireEvent.click(drillHeader());

      // Every scoped section still renders in its own order, not swept to the
      // tail behind a snapshot that never saw it.
      expect(sections()).toEqual(["No worktree", "alpha", "beta"]);
    });

    it("holds nothing but options, drillable heading or not", () => {
      // The ruling that removed the old disclosure: a focusable control inside
      // a `role="group"` inside a `role="listbox"` is both invalid and
      // unreachable by the keyboard this surface is driven with (#11669).
      seedSpread();
      render(<PilotView />);

      expect(screen.getByTestId("pilot-group-drill")).toBeTruthy();
      expect(screen.getByRole("listbox").querySelector("button")).toBeNull();
    });

    it("still narrows by query inside the scope", () => {
      drillIn();

      fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "docs" } });

      expect(sections()).toEqual(["beta"]);
    });

    it("admits a whole worktree typed by name", () => {
      drillIn();

      fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "alpha" } });

      expect(screen.getAllByTestId("pilot-row")).toHaveLength(1);
    });

    it("still narrows by band inside the scope", () => {
      drillIn();

      fireEvent.click(screen.getByTestId("pilot-demand-action"));

      expect(sections()).toEqual(["alpha"]);
    });

    it("opens a run with its own workspace, never the section it was filed under", () => {
      // A section id names a worktree here. Handing it to `pilot.openRun` as a
      // workspace would send every scoped run through a switch to a project
      // that does not exist.
      drillIn();
      // Proving we are on the axis where the group id is a worktree, or the
      // assertion below would hold for the wrong reason.
      expect(sections()).toEqual(["alpha", "beta"]);

      fireEvent.click(screen.getAllByTestId("pilot-row")[0]!);

      expect(dispatchMock).toHaveBeenCalledWith("pilot.openRun", {
        runId: "alpha-1",
        workspaceId: "p1",
      });
    });

    it("dismisses a park editor when the scope changes under it", () => {
      // The target resolves against every project's rows, so it survives a
      // re-scope on its own — and the scoped shortcut fires from outside the
      // dialog, while the editor owns the body. Without this the user lands in
      // one project's worktrees with another project's note open on top.
      seedSpread();
      render(<PilotView />);
      fireEvent.keyDown(screen.getByTestId("pilot-search"), { key: "Enter", altKey: true });
      expect(screen.getByTestId("pilot-park-editor")).toBeTruthy();

      act(() => {
        usePilotStore.getState().openProject("p1");
      });

      expect(screen.queryByTestId("pilot-park-editor")).toBeNull();
      expect(sections()).toEqual(["No worktree", "alpha", "beta"]);
    });

    it("keeps saying the scope is empty while other projects are still running", () => {
      // The empty state and the filter bar both describe the SCOPE. Reading
      // the fleet behind it would leave a bar filtering nothing, over a list
      // insisting there are agents to find.
      drillIn();

      act(() => {
        seed([
          run({
            runId: "elsewhere",
            workspaceId: "s1",
            agentState: "waiting",
            since: NOW - 60_000,
          }),
        ]);
      });

      expect(screen.getByText("Start an agent in daintree")).toBeTruthy();
      expect(screen.queryByTestId("pilot-filter-bar")).toBeNull();
    });

    it("keeps the filter bar as the way back out of a narrowing that emptied", () => {
      // A scope with rows in it must keep the control that undoes the
      // constraint the user cannot otherwise see, even with nothing on screen.
      drillIn();

      fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "zzzz" } });

      expect(screen.getByTestId("pilot-filter-bar")).toBeTruthy();
    });

    it("names the project when the scoped list drains", () => {
      // The scope survives the last agent exiting, and says so rather than
      // navigating itself somewhere the user did not ask for.
      drillIn();

      act(() => {
        seed([]);
      });

      expect(screen.getByText("Start an agent in daintree")).toBeTruthy();
      expect(screen.getByTestId("pilot-scope-back")).toBeTruthy();
    });
  });
});

describe("PilotView worktree axis from the project's own store", () => {
  const DRILL_MODIFIER = isMac() ? { metaKey: true } : { ctrlKey: true };

  /** A root whose basename sorts last, so only the lead rule can move it. */
  const ZEBRA_ROOT = "/repo/zebra";

  function worktree(id: string, isMain = false): WorktreeSnapshot {
    return {
      id,
      worktreeId: id,
      path: id,
      name: id.split("/").pop() ?? id,
      isCurrent: false,
      isMainWorktree: isMain,
    };
  }

  /**
   * `PilotView` inside a real view store, which is the only place the project's
   * actual worktrees exist. The store is returned so a test can move the
   * topology under a mounted surface.
   */
  function renderWithWorktrees(worktrees: WorktreeSnapshot[]) {
    const store = createWorktreeStore();
    store.getState().applySnapshot(worktrees, { epoch: "test", seq: 1 });
    render(
      <WorktreeStoreContext.Provider value={store}>
        <PilotView />
      </WorktreeStoreContext.Provider>
    );
    return store;
  }

  function sections(): string[] {
    return [...screen.getByRole("listbox").querySelectorAll('[role="group"]')].map(
      (group) => (group.getAttribute("aria-label") ?? "").split(",")[0] ?? ""
    );
  }

  /** Two agents sharing one worktree — the shape that used to lose the drill. */
  function seedOneBucket(): void {
    seed([
      run({ runId: "a", worktreeId: "/repo/wt/alpha", agentState: "working", since: NOW - 60_000 }),
      run({ runId: "b", worktreeId: "/repo/wt/alpha", agentState: "working", since: NOW - 60_000 }),
    ]);
  }

  it("offers the drill where the runs share a worktree but the project has several", () => {
    // The measured bug (#11957): a fleet row exists only for a terminal
    // classified an agent, so the affordance tracked where agents happened to
    // be sitting rather than whether the project has an axis at all.
    seedViewWorkspace("p1");
    seedOneBucket();
    renderWithWorktrees([worktree(ZEBRA_ROOT, true), worktree("/repo/wt/alpha")]);

    expect(screen.getByTestId("pilot-group-drill")).toBeTruthy();
  });

  it("keeps the chord and the chevron saying the same thing", () => {
    // The constraint #11955 established by construction, which the fix has to
    // keep: the two forms of one gesture cannot disagree about drillability.
    seedViewWorkspace("p1");
    seedOneBucket();
    renderWithWorktrees([worktree(ZEBRA_ROOT, true), worktree("/repo/wt/alpha")]);

    fireEvent.keyDown(screen.getByTestId("pilot-search"), { key: "Enter", ...DRILL_MODIFIER });

    expect(usePilotStore.getState().scope).toEqual({ kind: "project", workspaceId: "p1" });
  });

  it("withholds the drill where the project has only its own root", () => {
    seedViewWorkspace("p1");
    seedOneBucket();
    renderWithWorktrees([worktree(ZEBRA_ROOT, true)]);

    expect(screen.queryByTestId("pilot-group-drill")).toBeNull();
  });

  it("never lends this view's worktrees to another project's heading", () => {
    // The store answers for the workspace this renderer owns and for no other,
    // so a foreign heading stays on what its own runs prove.
    seedViewWorkspace("s1");
    seedOneBucket();
    renderWithWorktrees([worktree(ZEBRA_ROOT, true), worktree("/repo/wt/alpha")]);

    expect(screen.queryByTestId("pilot-group-drill")).toBeNull();
  });

  it("grows the affordance when a worktree appears under the open surface", () => {
    // Subscribed, not read once: creating a worktree while the overview is up
    // has to move the chevron with it.
    seedViewWorkspace("p1");
    seedOneBucket();
    const store = renderWithWorktrees([worktree(ZEBRA_ROOT, true)]);

    expect(screen.queryByTestId("pilot-group-drill")).toBeNull();

    act(() => {
      store.getState().applySnapshot([worktree(ZEBRA_ROOT, true), worktree("/repo/wt/alpha")], {
        epoch: "test",
        seq: 2,
      });
    });

    expect(screen.getByTestId("pilot-group-drill")).toBeTruthy();
  });

  it("leads the scoped list with the root even where its name sorts last", () => {
    // #11957's second half: a root run carries a worktree id like any other
    // checkout, so root work sorted alphabetically among the branches.
    seedViewWorkspace("p1");
    seed([
      run({ runId: "root", worktreeId: ZEBRA_ROOT, agentState: "working", since: NOW - 60_000 }),
      run({ runId: "a", worktreeId: "/repo/wt/alpha", agentState: "working", since: NOW - 60_000 }),
      run({ runId: "b", worktreeId: "/repo/wt/beta", agentState: "working", since: NOW - 60_000 }),
    ]);
    usePilotStore.setState({ isOpen: true, scope: { kind: "project", workspaceId: "p1" } });
    renderWithWorktrees([
      worktree(ZEBRA_ROOT, true),
      worktree("/repo/wt/alpha"),
      worktree("/repo/wt/beta"),
    ]);

    expect(sections()).toEqual(["zebra", "alpha", "beta"]);
  });

  it("keeps the label order when no worktree is tagged as the root", () => {
    // A miss costs the lead position and nothing else, which is what makes the
    // one id comparison here safe against the two mint sites.
    seedViewWorkspace("p1");
    seed([
      run({ runId: "root", worktreeId: ZEBRA_ROOT, agentState: "working", since: NOW - 60_000 }),
      run({ runId: "a", worktreeId: "/repo/wt/alpha", agentState: "working", since: NOW - 60_000 }),
    ]);
    usePilotStore.setState({ isOpen: true, scope: { kind: "project", workspaceId: "p1" } });
    renderWithWorktrees([worktree(ZEBRA_ROOT), worktree("/repo/wt/alpha")]);

    expect(sections()).toEqual(["alpha", "zebra"]);
  });
});

describe("PilotView fallback explanation", () => {
  it("says which project it could not scope to", () => {
    // Without this the scoped chord lands on a surface byte for byte identical
    // to the unscoped one, which reads as a dead key (#11957).
    seed([run({ runId: "a", worktreeId: "/repo/wt/alpha", agentState: "working" })]);
    usePilotStore.setState({ isOpen: true, scope: { kind: "fleet" }, fellBackFrom: "p1" });
    render(<PilotView />);

    expect(screen.getByTestId("pilot-fallback-note").textContent).toContain("daintree");
  });

  it("stays out of an ordinary fleet opening", () => {
    seed([run({ runId: "a", worktreeId: "/repo/wt/alpha", agentState: "working" })]);
    render(<PilotView />);

    expect(screen.queryByTestId("pilot-fallback-note")).toBeNull();
  });

  it("goes away when the user scopes somewhere from the fleet", () => {
    seed([
      run({ runId: "a", worktreeId: "/repo/wt/alpha", agentState: "working", since: NOW - 60_000 }),
      run({ runId: "b", worktreeId: "/repo/wt/beta", agentState: "working", since: NOW - 60_000 }),
    ]);
    usePilotStore.setState({ isOpen: true, scope: { kind: "fleet" }, fellBackFrom: "p1" });
    render(<PilotView />);

    fireEvent.click(screen.getAllByTestId("pilot-group-header")[0]!);

    expect(screen.queryByTestId("pilot-fallback-note")).toBeNull();
  });

  it("says nothing when the workspace cannot be named", () => {
    // A line claiming something has no worktree axis without saying WHICH
    // something is worse than the silence it replaces.
    seed([run({ runId: "a", worktreeId: "/repo/wt/alpha", agentState: "working" })]);
    usePilotStore.setState({
      isOpen: true,
      scope: { kind: "fleet" },
      fellBackFrom: "not-a-workspace",
    });
    render(<PilotView />);

    expect(screen.queryByTestId("pilot-fallback-note")).toBeNull();
  });
});
