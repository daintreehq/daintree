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

  it("writes the run's state out in words, not just a coloured glyph", () => {
    // Waiting and idle are both hollow circles; hue is the only thing between
    // them. The switcher never encodes status by colour alone and neither may
    // this — the sentence beside the glyph carries the meaning.
    seed([
      run({ runId: "a", agentState: "waiting", title: "one", since: NOW - 60_000 }),
      run({ runId: "b", agentState: "idle", title: "two", since: NOW - 60_000 }),
    ]);
    render(<PilotView />);

    const rows = screen.getAllByTestId("pilot-row").map((r) => r.textContent ?? "");
    expect(rows[0]).toContain("Needs you");
    expect(rows[1]).toContain("Idle");
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

    const header = screen.getByTestId("pilot-group-header");
    expect(header.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(header);

    expect(screen.queryByTestId("pilot-row")).toBeNull();
    expect(screen.getByTestId("pilot-group-header").getAttribute("aria-expanded")).toBe("false");
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
    fireEvent.click(screen.getByTestId("pilot-group-header"));
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
      fireEvent.click(screen.getByTestId("pilot-group-header"));
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
    /** The row the highlight is on, as the tree reports it. */
    function selected(): { level: string | null; text: string } {
      const el = document.querySelector('[aria-selected="true"]');
      if (!el) throw new Error("nothing selected");
      return { level: el.getAttribute("aria-level"), text: el.textContent ?? "" };
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

    it("opens with the first agent selected rather than a project header", () => {
      seedTwoProjects();
      render(<PilotView />);

      // Landing on the header would make the reflexive open-then-Enter collapse
      // the project instead of opening the agent the user came for.
      expect(selected()).toMatchObject({ level: "2", text: expect.stringContaining("alpha") });
    });

    it("walks headers and agents as one list", () => {
      seedTwoProjects();
      render(<PilotView />);

      press("ArrowDown");
      expect(selected().text).toContain("bravo");
      press("ArrowDown");
      // The next project's header is a stop of its own — it has to be, or there
      // is no keyboard path to collapse it.
      expect(selected()).toMatchObject({ level: "1", text: expect.stringContaining("spike") });
      press("ArrowDown");
      expect(selected().text).toContain("charlie");
    });

    it("wraps at both ends", () => {
      seedTwoProjects();
      render(<PilotView />);

      press("ArrowUp");
      expect(selected()).toMatchObject({ level: "1", text: expect.stringContaining("daintree") });
      press("ArrowUp");
      expect(selected().text).toContain("charlie");
      press("ArrowDown");
      expect(selected()).toMatchObject({ level: "1", text: expect.stringContaining("daintree") });
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

    it("toggles the project on Enter when a header is selected", () => {
      seedTwoProjects();
      render(<PilotView />);

      press("ArrowUp");
      expect(selected().level).toBe("1");
      press("Enter");

      // Only the other project's agent survives the collapse.
      expect(screen.getAllByTestId("pilot-row").map((r) => r.textContent ?? "")).toEqual([
        expect.stringContaining("charlie"),
      ]);
      // Enter on a header must not also dispatch a navigation.
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("collapses with Left and expands with Right", () => {
      seedTwoProjects();
      render(<PilotView />);

      // Left from an agent goes to its parent, mirroring the tree pattern.
      press("ArrowLeft");
      expect(selected()).toMatchObject({ level: "1", text: expect.stringContaining("daintree") });

      press("ArrowLeft");
      expect(screen.getAllByTestId("pilot-row")).toHaveLength(1);
      expect(screen.getAllByTestId("pilot-group-header")[0]!.getAttribute("aria-expanded")).toBe(
        "false"
      );

      press("ArrowRight");
      expect(screen.getAllByTestId("pilot-row")).toHaveLength(3);
    });

    it("moves the highlight out of a group it collapses", () => {
      seedTwoProjects();
      render(<PilotView />);
      expect(selected().text).toContain("alpha");

      fireEvent.click(screen.getAllByTestId("pilot-group-header")[0]!);

      // "alpha" has left the tree. A highlight still pointing at it would leave
      // Enter committing a row that isn't on screen.
      expect(selected()).toMatchObject({ level: "1", text: expect.stringContaining("daintree") });
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
      expect(selected()).toMatchObject({ level: "1", text: expect.stringContaining("daintree") });

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
