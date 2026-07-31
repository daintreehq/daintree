// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";

vi.mock("@/utils/safeFireAndForget", () => ({ safeFireAndForget: vi.fn() }));

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: dispatchMock } }));

import { PilotView } from "../PilotView";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { usePilotStore } from "@/store/pilotStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";

const NOW = 1_830_000_000_000;

function run(overrides: Partial<FleetSnapshot["runs"][number]> = {}) {
  return {
    runId: "t1",
    workspaceId: "p1",
    spawnedAt: NOW - 3_600_000,
    cwd: "/repo/feature-x",
    ...overrides,
  };
}

function seed(runs: FleetSnapshot["runs"] | null) {
  useFleetSnapshotStore.setState({
    snapshot: runs === null ? null : { runs, changedAt: NOW },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
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
  it("shows a skeleton, not an all-clear, before any snapshot arrives", () => {
    seed(null);
    render(<PilotView />);

    // Claiming "no agents running" from an unreported fleet would be a lie the
    // user acts on — the two states must not render the same.
    expect(screen.getByTestId("pilot-skeleton")).toBeTruthy();
    expect(screen.queryByTestId("pilot-empty")).toBeNull();
  });

  it("claims all-clear only once a genuinely empty fleet is delivered", () => {
    seed([]);
    render(<PilotView />);

    expect(screen.queryByTestId("pilot-skeleton")).toBeNull();
    expect(screen.getByText("No agents running")).toBeTruthy();
  });

  it("stays quiet when the fleet is busy but asking nothing", () => {
    seed([run({ agentState: "working", since: NOW - 60_000 })]);
    render(<PilotView />);

    expect(screen.getByText(/Nothing needs you/)).toBeTruthy();
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
    expect(screen.getAllByTestId("pilot-project-group")).toHaveLength(2);

    fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "auth" } });

    expect(screen.getAllByTestId("pilot-project-group")).toHaveLength(1);
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

  it("distinguishes an empty fleet from an empty search result", () => {
    seed([run({ agentState: "working", title: "auth refactor" })]);
    render(<PilotView />);

    fireEvent.change(screen.getByTestId("pilot-search"), { target: { value: "zzzz" } });

    expect(screen.getByText("No agents match your search")).toBeTruthy();
    expect(screen.queryByText("No agents running")).toBeNull();
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
    expect(screen.getByText("1m")).toBeTruthy();

    // The snapshot is unchanged and suppressed upstream, so only the component's
    // own clock can move this. A tick that never reaches the render is the
    // React Compiler no-op this guards against.
    await vi.advanceTimersByTimeAsync(120_000);

    expect(screen.queryByText("1m")).toBeNull();
    expect(screen.getByText("3m")).toBeTruthy();
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
