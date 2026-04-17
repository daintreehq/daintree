// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";
import { FleetArmingRibbon } from "../FleetArmingRibbon";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import type { TerminalInstance } from "@shared/types";

function resetStores() {
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
  });
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
  useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
  useAnnouncerStore.setState({ polite: null, assertive: null });
}

function seed(terminals: TerminalInstance[]): void {
  const panelsById: Record<string, TerminalInstance> = {};
  const panelIds: string[] = [];
  for (const t of terminals) {
    panelsById[t.id] = t;
    panelIds.push(t.id);
  }
  usePanelStore.setState({ panelsById, panelIds });
}

function makeAgent(
  id: string,
  agentState: TerminalInstance["agentState"] = "idle"
): TerminalInstance {
  return {
    id,
    title: id,
    type: "terminal",
    kind: "agent",
    agentId: "claude",
    worktreeId: "wt-1",
    projectId: "proj-1",
    location: "grid",
    agentState,
    hasPty: true,
  } as TerminalInstance;
}

describe("FleetArmingRibbon", () => {
  beforeEach(() => {
    resetStores();
  });

  it("renders nothing when nothing is armed", () => {
    const { container } = render(<FleetArmingRibbon />);
    expect(container.firstChild).toBeNull();
  });

  it("renders armed count when armed", () => {
    useFleetArmingStore.getState().armIds(["a", "b", "c"]);
    render(<FleetArmingRibbon />);
    expect(screen.getByTestId("fleet-arming-ribbon")).toBeTruthy();
    expect(screen.getByText("3 agents armed")).toBeTruthy();
  });

  it("uses singular 'agent' for a single armed terminal", () => {
    useFleetArmingStore.getState().armIds(["a"]);
    render(<FleetArmingRibbon />);
    expect(screen.getByText("1 agent armed")).toBeTruthy();
  });

  it("clicking the close button disarms all", () => {
    useFleetArmingStore.getState().armIds(["a", "b"]);
    render(<FleetArmingRibbon />);
    const close = screen.getByLabelText("Disarm all");
    fireEvent.click(close);
    expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
  });

  it("preset buttons arm agents by state", () => {
    seed([makeAgent("t1", "working"), makeAgent("t2", "waiting"), makeAgent("t3", "completed")]);
    useFleetArmingStore.getState().armIds(["t1"]); // open the ribbon
    render(<FleetArmingRibbon />);

    const waitingBtn = screen.getByLabelText(/Arm waiting agents/);
    fireEvent.click(waitingBtn);

    const armed = useFleetArmingStore.getState().armedIds;
    expect([...armed]).toEqual(["t2"]);
  });

  it("shift-clicking a preset extends the armed set", () => {
    seed([makeAgent("t1", "working"), makeAgent("t2", "waiting")]);
    useFleetArmingStore.getState().armIds(["t1"]);
    render(<FleetArmingRibbon />);

    const waitingBtn = screen.getByLabelText(/Arm waiting agents/);
    fireEvent.click(waitingBtn, { shiftKey: true });

    const armed = useFleetArmingStore.getState().armedIds;
    expect([...armed].sort()).toEqual(["t1", "t2"]);
  });

  it("announces armed count via the announcer store", () => {
    render(<FleetArmingRibbon />);
    act(() => {
      useFleetArmingStore.getState().armIds(["a", "b"]);
    });
    expect(useAnnouncerStore.getState().polite?.msg).toBe("2 agents armed");
  });

  it("announces 'Fleet disarmed' when count returns to zero", () => {
    render(<FleetArmingRibbon />);
    act(() => {
      useFleetArmingStore.getState().armIds(["a", "b"]);
    });
    act(() => {
      useFleetArmingStore.getState().clear();
    });
    expect(useAnnouncerStore.getState().polite?.msg).toBe("Fleet disarmed");
  });
});
