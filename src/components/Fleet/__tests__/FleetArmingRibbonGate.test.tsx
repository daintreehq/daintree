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
  it("registers raw fleet input without loading the ribbon, which waits for a member", async () => {
    // A fresh module graph, so what the gate loads is measured from nothing.
    vi.resetModules();
    h.ribbonLoads = 0;
    h.rawInputLoads = 0;
    const { FleetArmingRibbonGate: Gate } = await import("../FleetArmingRibbonGate");
    const { useFleetArmingStore: arming } = await import("@/store/fleetArmingStore");
    expect(h.rawInputLoads).toBe(1);

    render(<Gate />);
    await act(async () => {});
    expect(h.ribbonLoads).toBe(0);
    expect(screen.queryByTestId("fleet-ribbon")).toBeNull();

    act(() => arming.setState({ armedIds: new Set(["a"]) }));

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

    expect(await screen.findByTestId("fleet-ribbon")).toBeTruthy();
  });

  it("loads for a failure banner or a waiting confirmation with no member armed", async () => {
    const failure = render(<FleetArmingRibbonGate />);
    act(() => useFleetFailureStore.setState({ failedIds: new Set(["a"]) }));
    expect(await failure.findByTestId("fleet-ribbon")).toBeTruthy();
    failure.unmount();
    resetFleet();

    const confirm = render(<FleetArmingRibbonGate />);
    expect(confirm.queryByTestId("fleet-ribbon")).toBeNull();
    act(() =>
      useFleetPendingActionStore.setState({
        pending: { kind: "kill", targetCount: 1, sessionLossCount: 0 },
      })
    );
    expect(await confirm.findByTestId("fleet-ribbon")).toBeTruthy();
  });

  it("keeps the ribbon mounted after the fleet drains", async () => {
    render(<FleetArmingRibbonGate />);
    act(() => useFleetArmingStore.setState({ armedIds: new Set(["a", "b"]) }));
    const ribbon = await screen.findByTestId("fleet-ribbon");

    act(() => useFleetArmingStore.setState({ armedIds: new Set() }));

    expect(screen.getByTestId("fleet-ribbon")).toBe(ribbon);
  });
});
