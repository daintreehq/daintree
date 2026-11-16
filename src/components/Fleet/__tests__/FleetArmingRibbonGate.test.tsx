// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ ribbonLoads: 0, rawInputLoads: 0 }));

vi.mock("../FleetArmingRibbon", () => {
  h.ribbonLoads++;
  return { FleetArmingRibbon: () => <div data-testid="fleet-ribbon" /> };
});
vi.mock("../fleetRawInputBroadcast", () => {
  h.rawInputLoads++;
  return {};
});

import { FleetArmingRibbonGate } from "../FleetArmingRibbonGate";
import { useFleetArmingStore, type CrossHostFleetTarget } from "@/store/fleetArmingStore";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import { useFleetPendingActionStore } from "@/store/fleetPendingActionStore";

// Read before any test mounts a gate: the mocks count module evaluations, and a
// module evaluates once per file.
const loadedWithGate = { ribbon: h.ribbonLoads, rawInput: h.rawInputLoads };

function resetFleet() {
  useFleetArmingStore.setState({ armedIds: new Set(), crossHostTargets: [] });
  useFleetFailureStore.setState({ failedIds: new Set() });
  useFleetPendingActionStore.setState({ pending: null });
}

beforeEach(resetFleet);

afterEach(() => {
  cleanup();
  resetFleet();
});

describe("FleetArmingRibbonGate", () => {
  it("registers raw fleet input as it loads, and leaves the ribbon's chunk alone", () => {
    expect(loadedWithGate).toEqual({ ribbon: 0, rawInput: 1 });
  });

  it("draws nothing for a view with no fleet, and the ribbon once one pane is armed", async () => {
    const loadsBefore = h.ribbonLoads;
    render(<FleetArmingRibbonGate />);
    await act(async () => {});
    expect(screen.queryByTestId("fleet-ribbon")).toBeNull();
    expect(h.ribbonLoads).toBe(loadsBefore);

    act(() => useFleetArmingStore.setState({ armedIds: new Set(["a"]) }));

    expect(await screen.findByTestId("fleet-ribbon")).toBeTruthy();
    expect(h.ribbonLoads).toBe(1);
  });

  it("loads for a fleet made only of other hosts' agents", async () => {
    render(<FleetArmingRibbonGate />);
    expect(screen.queryByTestId("fleet-ribbon")).toBeNull();

    act(() =>
      useFleetArmingStore.setState({
        crossHostTargets: [{ key: "host-1:t1" } as CrossHostFleetTarget],
      })
    );

    const ribbon = await screen.findByTestId("fleet-ribbon");

    act(() => useFleetArmingStore.setState({ crossHostTargets: [] }));
    expect(screen.getByTestId("fleet-ribbon")).toBe(ribbon);
  });

  it("loads for a failure banner or a waiting confirmation with no member armed", async () => {
    const failure = render(<FleetArmingRibbonGate />);
    act(() => useFleetFailureStore.setState({ failedIds: new Set(["a"]) }));
    const banner = await failure.findByTestId("fleet-ribbon");
    act(() => useFleetFailureStore.setState({ failedIds: new Set() }));
    expect(failure.getByTestId("fleet-ribbon")).toBe(banner);
    failure.unmount();
    resetFleet();

    const confirm = render(<FleetArmingRibbonGate />);
    expect(confirm.queryByTestId("fleet-ribbon")).toBeNull();
    act(() =>
      useFleetPendingActionStore.setState({
        pending: { kind: "kill", targetCount: 1, sessionLossCount: 0 },
      })
    );
    const confirmBar = await confirm.findByTestId("fleet-ribbon");
    act(() => useFleetPendingActionStore.setState({ pending: null }));
    expect(confirm.getByTestId("fleet-ribbon")).toBe(confirmBar);
  });

  it("keeps the ribbon mounted after the fleet drains", async () => {
    render(<FleetArmingRibbonGate />);
    act(() => useFleetArmingStore.setState({ armedIds: new Set(["a", "b"]) }));
    const ribbon = await screen.findByTestId("fleet-ribbon");

    act(() => useFleetArmingStore.setState({ armedIds: new Set() }));

    expect(screen.getByTestId("fleet-ribbon")).toBe(ribbon);
  });
});
