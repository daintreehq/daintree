// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { FleetSnapshot } from "@shared/types/ipc/fleet";

vi.mock("@/utils/safeFireAndForget", () => ({ safeFireAndForget: vi.fn() }));

// The header reserves space for the OS window controls, so it subscribes to
// fullscreen changes. Returns a no-op unsubscribe.
vi.stubGlobal("window", {
  ...globalThis.window,
  electron: { window: { onFullscreenChange: vi.fn(() => () => {}) } },
});

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
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test carrier: only id/name are read for name resolution
  useProjectStore.setState({ projects: [{ id: "p1", name: "daintree" }] } as Parameters<
    typeof useProjectStore.setState
  >[0]);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test carrier: only id/name are read for name resolution
  useScratchStore.setState({ scratches: [{ id: "s1", name: "spike" }] } as Parameters<
    typeof useScratchStore.setState
  >[0]);
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
    expect(screen.queryByText("Launch an agent")).toBeNull();
  });

  it("claims all-clear only once a genuinely empty fleet is delivered", () => {
    seed([]);
    render(<PilotView />);

    expect(screen.queryByTestId("pilot-skeleton")).toBeNull();
    expect(screen.getByText("Launch an agent")).toBeTruthy();
  });

  it("stays quiet when the fleet is busy but asking nothing", () => {
    seed([run({ agentState: "working", since: NOW - 60_000 })]);
    render(<PilotView />);

    expect(screen.getByText(/Nothing needs you/)).toBeTruthy();
  });

  it("leads with the demand count when runs need the user", () => {
    seed([
      run({ runId: "a", agentState: "waiting", waitingReason: "error", since: NOW - 60_000 }),
      run({ runId: "b", agentState: "waiting", since: NOW - 30_000 }),
      run({ runId: "c", agentState: "working", since: NOW - 10_000 }),
    ]);
    render(<PilotView />);

    expect(screen.getByText("2 runs need you")).toBeTruthy();
  });

  it("renders demand bands above in-flight ones", () => {
    seed([
      run({ runId: "w", agentState: "working", since: NOW - 10_000 }),
      run({ runId: "b", agentState: "waiting", waitingReason: "error", since: NOW - 60_000 }),
    ]);
    render(<PilotView />);

    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent ?? "");
    expect(headings[0]).toContain("Blocked");
    expect(headings.findIndex((h) => h.includes("Running"))).toBeGreaterThan(0);
  });

  it("resolves names for a workspace that is not the active project", () => {
    seed([run({ workspaceId: "s1", agentState: "working", since: NOW - 10_000 })]);
    render(<PilotView />);

    // The snapshot spans every workspace, so a row must not fall back to
    // "Unknown workspace" merely because it isn't the one on screen.
    expect(screen.getByText("spike")).toBeTruthy();
    expect(screen.queryByText("Unknown workspace")).toBeNull();
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

  it("closes through the store when the close control is used", () => {
    seed([]);
    usePilotStore.setState({ isOpen: true });
    render(<PilotView />);

    screen.getByLabelText("Close fleet overview").click();

    expect(usePilotStore.getState().isOpen).toBe(false);
  });
});
