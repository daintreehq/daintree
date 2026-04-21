// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
      ({ children, ...props }, ref) => (
        <div ref={ref} {...props}>
          {children}
        </div>
      )
    ),
  },
  useReducedMotion: () => false,
}));

import { FleetArmingRibbon } from "../FleetArmingRibbon";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetPendingActionStore } from "@/store/fleetPendingActionStore";
import { useFleetScopeFlagStore } from "@/store/fleetScopeFlagStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { dispatchEscape, _resetForTests as resetEscapeStack } from "@/lib/escapeStack";
import type { TerminalInstance } from "@shared/types";

function resetStores() {
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
  });
  useFleetPendingActionStore.setState({ pending: null });
  useFleetScopeFlagStore.setState({ mode: "legacy", isHydrated: true });
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
  useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1", isFleetScopeActive: false });
  useAnnouncerStore.setState({ polite: null, assertive: null });
  resetEscapeStack();
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
    const chip = screen.getByTestId("fleet-armed-count-chip");
    expect(chip.textContent).toContain("3");
    expect(chip.textContent).toContain("agents armed");
  });

  it("uses singular 'agent' for a single armed terminal", () => {
    useFleetArmingStore.getState().armIds(["a"]);
    render(<FleetArmingRibbon />);
    const chip = screen.getByTestId("fleet-armed-count-chip");
    expect(chip.textContent).toContain("1");
    expect(chip.textContent).toContain("agent armed");
  });

  it("clicking the exit chip disarms all", () => {
    useFleetArmingStore.getState().armIds(["a", "b"]);
    render(<FleetArmingRibbon />);
    const exit = screen.getByTestId("fleet-exit");
    fireEvent.click(exit);
    expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
  });

  it("renders 'Exit' label and 'Esc' kbd on the exit chip", () => {
    useFleetArmingStore.getState().armIds(["a"]);
    render(<FleetArmingRibbon />);
    const exit = screen.getByTestId("fleet-exit");
    expect(exit.textContent).toContain("Exit");
    expect(exit.textContent).toContain("Esc");
  });

  it("count chip opens a popover listing armed terminal titles", () => {
    seed([
      { ...makeAgent("t1"), title: "frontend·main" } as TerminalInstance,
      { ...makeAgent("t2"), title: "backend·main" } as TerminalInstance,
    ]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    render(<FleetArmingRibbon />);
    fireEvent.click(screen.getByTestId("fleet-armed-count-chip"));
    const list = screen.getByTestId("fleet-armed-list");
    expect(list.textContent).toContain("frontend·main");
    expect(list.textContent).toContain("backend·main");
  });

  it("per-row unarm button in the popover calls disarmId", () => {
    seed([
      { ...makeAgent("t1"), title: "frontend·main" } as TerminalInstance,
      { ...makeAgent("t2"), title: "backend·main" } as TerminalInstance,
    ]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    render(<FleetArmingRibbon />);
    fireEvent.click(screen.getByTestId("fleet-armed-count-chip"));
    fireEvent.click(screen.getByLabelText("Unarm frontend·main"));
    const armed = useFleetArmingStore.getState().armedIds;
    expect(armed.has("t1")).toBe(false);
    expect(armed.has("t2")).toBe(true);
  });

  it("Escape with the popover open closes the list first, then disarms", () => {
    seed([
      { ...makeAgent("t1"), title: "frontend·main" } as TerminalInstance,
      { ...makeAgent("t2"), title: "backend·main" } as TerminalInstance,
    ]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    render(<FleetArmingRibbon />);
    fireEvent.click(screen.getByTestId("fleet-armed-count-chip"));
    // First dispatched Escape: popover closes, fleet stays armed.
    act(() => {
      dispatchEscape();
    });
    expect(useFleetArmingStore.getState().armedIds.size).toBe(2);
    // Second dispatched Escape: fleet disarms.
    act(() => {
      dispatchEscape();
    });
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

  it("renders confirmation view when a pending action is set", () => {
    useFleetArmingStore.getState().armIds(["a", "b", "c"]);
    useFleetPendingActionStore.setState({
      pending: { kind: "restart", targetCount: 3, sessionLossCount: 2 },
    });
    render(<FleetArmingRibbon />);
    const ribbon = screen.getByTestId("fleet-arming-ribbon");
    expect(ribbon.getAttribute("data-pending-action")).toBe("restart");
    expect(screen.getByText(/Restart 3 agents\?/)).toBeTruthy();
    expect(screen.getByText(/2 agents will lose their session/)).toBeTruthy();
  });

  it("collapses pending confirmation when the armed set drains", () => {
    useFleetArmingStore.getState().armIds(["a", "b"]);
    useFleetPendingActionStore.setState({
      pending: { kind: "kill", targetCount: 2, sessionLossCount: 0 },
    });
    render(<FleetArmingRibbon />);
    expect(useFleetPendingActionStore.getState().pending).not.toBeNull();
    act(() => {
      useFleetArmingStore.getState().clear();
    });
    expect(useFleetPendingActionStore.getState().pending).toBeNull();
  });

  it("disables quick-action buttons that have no eligible targets", () => {
    seed([makeAgent("t1", "completed")]);
    useFleetArmingStore.getState().armIds(["t1"]);
    render(<FleetArmingRibbon />);
    // No waiting agents armed → Accept/Reject disabled
    const accept = screen.getByTestId("fleet-quick-accept") as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    const reject = screen.getByTestId("fleet-quick-reject") as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    // Completed agent is still "live" → Restart/Kill/Trash enabled
    const kill = screen.getByTestId("fleet-quick-kill") as HTMLButtonElement;
    expect(kill.disabled).toBe(false);
    // Completed agent is NOT a valid interrupt target → Interrupt disabled
    const interrupt = screen.getByTestId("fleet-quick-interrupt") as HTMLButtonElement;
    expect(interrupt.disabled).toBe(true);
  });

  it("Cmd+Esc pressed twice within 350ms dispatches fleet.interrupt", async () => {
    seed([makeAgent("t1", "working"), makeAgent("t2", "working")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    const actionServiceModule = await import("@/services/ActionService");
    const dispatchSpy = vi.spyOn(actionServiceModule.actionService, "dispatch");
    render(<FleetArmingRibbon />);
    // First Cmd+Esc — stamps the ref, no dispatch
    fireEvent.keyDown(window, { key: "Escape", metaKey: true });
    expect(dispatchSpy.mock.calls.some((c) => c[0] === "fleet.interrupt")).toBe(false);
    // Second Cmd+Esc within the window → dispatch
    fireEvent.keyDown(window, { key: "Escape", metaKey: true });
    expect(dispatchSpy.mock.calls.some((c) => c[0] === "fleet.interrupt")).toBe(true);
    dispatchSpy.mockRestore();
  });

  it("bare Escape Escape does NOT dispatch fleet.interrupt (no Cmd modifier)", async () => {
    seed([makeAgent("t1", "working"), makeAgent("t2", "working")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    const actionServiceModule = await import("@/services/ActionService");
    const dispatchSpy = vi.spyOn(actionServiceModule.actionService, "dispatch");
    render(<FleetArmingRibbon />);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(dispatchSpy.mock.calls.some((c) => c[0] === "fleet.interrupt")).toBe(false);
    dispatchSpy.mockRestore();
  });

  it("Enter while a pending action is open re-dispatches the action with confirmed:true", async () => {
    useFleetArmingStore.getState().armIds(["a", "b", "c"]);
    useFleetPendingActionStore.setState({
      pending: { kind: "restart", targetCount: 3, sessionLossCount: 0 },
    });
    const actionServiceModule = await import("@/services/ActionService");
    const dispatchSpy = vi.spyOn(actionServiceModule.actionService, "dispatch");
    render(<FleetArmingRibbon />);
    fireEvent.keyDown(window, { key: "Enter" });
    const match = dispatchSpy.mock.calls.find((c) => c[0] === "fleet.restart");
    expect(match).toBeDefined();
    expect(match?.[1]).toEqual({ confirmed: true });
    dispatchSpy.mockRestore();
  });

  describe("Embedded FleetComposer", () => {
    it("renders the embedded FleetComposer whenever the ribbon is mounted", () => {
      useFleetArmingStore.getState().armIds(["a"]);
      render(<FleetArmingRibbon />);
      expect(screen.queryByTestId("fleet-composer")).toBeTruthy();
    });

    it("renders exactly one FleetComposer in the ribbon when Fleet scope is active", () => {
      // The pinned-header mount point was removed with the orphaned saved-scopes
      // plumbing; the ribbon is now the sole composer host in every mode.
      useFleetArmingStore.getState().armIds(["a"]);
      useFleetScopeFlagStore.setState({ mode: "scoped", isHydrated: true });
      useWorktreeSelectionStore.setState({
        activeWorktreeId: "wt-1",
        isFleetScopeActive: true,
      });
      render(<FleetArmingRibbon />);
      expect(screen.queryAllByTestId("fleet-composer")).toHaveLength(1);
      expect(screen.queryByTestId("fleet-arming-ribbon")).toBeTruthy();
    });
  });
});
