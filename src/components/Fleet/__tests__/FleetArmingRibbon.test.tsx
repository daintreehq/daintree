// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";

vi.mock("framer-motion", () => {
  const MotionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ children, ...props }, ref) => (
      <div ref={ref} {...props}>
        {children}
      </div>
    )
  );
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    LazyMotion: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    domAnimation: {},
    domMax: {},
    m: { div: MotionDiv },
    motion: { div: MotionDiv },
    useReducedMotion: () => false,
  };
});

vi.mock("@/hooks/useWorktreeColorMap", () => ({
  useWorktreeColorMap: () => null,
}));

// ConfirmDialog (via AppDialog/Radix) observes layout; jsdom lacks this.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="fleet-selection-menu">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    destructive,
  }: {
    children: React.ReactNode;
    onSelect?: (e: Event) => void;
    disabled?: boolean;
    destructive?: boolean;
  }) => (
    <div
      role="menuitem"
      data-disabled={disabled ? "true" : undefined}
      data-destructive={destructive ? "true" : undefined}
      onClick={(e) => {
        if (disabled) return;
        onSelect?.(e as unknown as Event);
      }}
    >
      {children}
    </div>
  ),
  DropdownMenuGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-group">{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));

import { FleetArmingRibbon } from "../FleetArmingRibbon";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetPendingActionStore } from "@/store/fleetPendingActionStore";
import { useFleetBroadcastProgressStore } from "@/store/fleetBroadcastProgressStore";
import { useFleetPickerSessionStore } from "@/store/fleetPickerSessionStore";
import { useFleetRunStore, type FleetRun, type FleetRunTarget } from "@/store/fleetRunStore";
import { usePanelStore } from "@/store/panelStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import type { ProjectSettings } from "@shared/types/project";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { dispatchEscape, _resetForTests as resetEscapeStack } from "@/lib/escapeStack";
import type { PtyPanelData } from "@shared/types/panel";

function resetStores() {
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
    previewArmedIds: new Set<string>(),
  });
  useFleetPendingActionStore.setState({ pending: null });
  useFleetRunStore.getState()._reset();
  usePanelStore.setState({ panelsById: {}, panelIds: [], focusedId: null });
  useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1", isFleetScopeActive: false });
  useWorktreeFilterStore.setState({ quickStateFilter: "all" });
  useAnnouncerStore.setState({ polite: null, assertive: null });
  resetEscapeStack();
}

function seed(terminals: PtyPanelData[]): void {
  const panelsById: Record<string, PtyPanelData> = {};
  const panelIds: string[] = [];
  for (const t of terminals) {
    panelsById[t.id] = t;
    panelIds.push(t.id);
  }
  usePanelStore.setState({ panelsById, panelIds });
}

function makeAgent(id: string, agentState: PtyPanelData["agentState"] = "idle"): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    detectedAgentId: "claude",
    worktreeId: "wt-1",
    projectId: "proj-1",
    location: "grid",
    agentState,
    hasPty: true,
  } as PtyPanelData;
}

describe("FleetArmingRibbon", () => {
  beforeEach(() => {
    resetStores();
  });

  it("does not render the armed ribbon when nothing is armed", () => {
    render(<FleetArmingRibbon />);
    expect(screen.queryByTestId("fleet-arming-ribbon")).toBeNull();
    expect(screen.queryByTestId("fleet-arming-ribbon-group")).toBeNull();
  });

  it("does not render the armed ribbon when only one agent is armed", () => {
    useFleetArmingStore.getState().armIds(["a"]);
    render(<FleetArmingRibbon />);
    expect(screen.queryByTestId("fleet-arming-ribbon")).toBeNull();
    expect(screen.queryByTestId("fleet-arming-ribbon-group")).toBeNull();
  });

  it("renders armed count when 2+ are armed", () => {
    useFleetArmingStore.getState().armIds(["a", "b", "c"]);
    render(<FleetArmingRibbon />);
    expect(screen.getByTestId("fleet-arming-ribbon")).toBeTruthy();
    const chip = screen.getByTestId("fleet-armed-count-chip");
    expect(chip.textContent).toContain("3");
    expect(chip.textContent).toContain("in fleet");
  });

  it("clicking the exit chip disarms all", () => {
    useFleetArmingStore.getState().armIds(["a", "b"]);
    render(<FleetArmingRibbon />);
    const exit = screen.getByTestId("fleet-exit");
    fireEvent.click(exit);
    expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
  });

  it("renders a leading × exit affordance that disarms on click", () => {
    useFleetArmingStore.getState().armIds(["a", "b"]);
    render(<FleetArmingRibbon />);
    const lead = screen.getByTestId("fleet-leading-exit");
    expect(lead.getAttribute("aria-label")).toBe("Exit fleet mode");
    fireEvent.click(lead);
    expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
  });

  it("surfaces the cross-worktree count in the chip's visible label", () => {
    seed([
      { ...makeAgent("t1"), worktreeId: "wt-a" } as PtyPanelData,
      { ...makeAgent("t2"), worktreeId: "wt-b" } as PtyPanelData,
    ]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    render(<FleetArmingRibbon />);
    const chip = screen.getByTestId("fleet-armed-count-chip");
    expect(chip.textContent).toContain("2 worktrees");
    expect(chip.getAttribute("aria-label")).toContain("2 worktrees");
  });

  it("does not surface the worktree count when all panes share one worktree", () => {
    seed([makeAgent("t1"), makeAgent("t2")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    render(<FleetArmingRibbon />);
    const chip = screen.getByTestId("fleet-armed-count-chip");
    expect(chip.textContent).not.toContain("worktrees");
  });

  it("surfaces an exited count when any armed pane has agentState=exited", () => {
    seed([makeAgent("t1", "working"), makeAgent("t2", "exited"), makeAgent("t3", "exited")]);
    useFleetArmingStore.getState().armIds(["t1", "t2", "t3"]);
    render(<FleetArmingRibbon />);
    const exited = screen.getByTestId("fleet-exited-count");
    expect(exited.textContent).toContain("2 exited");
    expect(screen.getByTestId("fleet-armed-count-chip").getAttribute("aria-label")).toContain(
      "2 exited"
    );
  });

  it("omits the exited count when no armed pane is exited", () => {
    seed([makeAgent("t1", "working"), makeAgent("t2", "waiting")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    render(<FleetArmingRibbon />);
    expect(screen.queryByTestId("fleet-exited-count")).toBeNull();
  });

  it("renders per-row health badges for working/waiting/exited and skips idle/completed/directing", () => {
    seed([
      { ...makeAgent("t1", "working"), title: "alpha" } as PtyPanelData,
      { ...makeAgent("t2", "waiting"), title: "beta" } as PtyPanelData,
      { ...makeAgent("t3", "exited"), title: "gamma" } as PtyPanelData,
      { ...makeAgent("t4", "idle"), title: "delta" } as PtyPanelData,
      { ...makeAgent("t5", "completed"), title: "epsilon" } as PtyPanelData,
      { ...makeAgent("t6", "directing"), title: "zeta" } as PtyPanelData,
    ]);
    useFleetArmingStore.getState().armIds(["t1", "t2", "t3", "t4", "t5", "t6"]);
    render(<FleetArmingRibbon />);
    fireEvent.click(screen.getByTestId("fleet-armed-count-chip"));
    expect(screen.getByTestId("fleet-pane-state-t1-working").textContent).toBe("Working");
    expect(screen.getByTestId("fleet-pane-state-t2-waiting").textContent).toBe("Waiting");
    expect(screen.getByTestId("fleet-pane-state-t3-exited").textContent).toBe("Exited");
    // idle / completed / directing render no badge — verify by absence
    expect(screen.queryByTestId("fleet-pane-state-t4-idle")).toBeNull();
    expect(screen.queryByTestId("fleet-pane-state-t5-completed")).toBeNull();
    expect(screen.queryByTestId("fleet-pane-state-t6-directing")).toBeNull();
  });

  it("renders one badge per pane when multiple panes share the same state", () => {
    seed([
      { ...makeAgent("t1", "exited"), title: "alpha" } as PtyPanelData,
      { ...makeAgent("t2", "exited"), title: "beta" } as PtyPanelData,
    ]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    render(<FleetArmingRibbon />);
    fireEvent.click(screen.getByTestId("fleet-armed-count-chip"));
    const exitedBadges = screen.getAllByText("Exited");
    expect(exitedBadges.length).toBe(2);
    expect(screen.getByTestId("fleet-pane-state-t1-exited")).toBeTruthy();
    expect(screen.getByTestId("fleet-pane-state-t2-exited")).toBeTruthy();
  });

  it("renders 'Exit' label and ⌘Esc/Ctrl+Esc kbd on the exit chip", () => {
    useFleetArmingStore.getState().armIds(["a", "b"]);
    render(<FleetArmingRibbon />);
    const exit = screen.getByTestId("fleet-exit");
    expect(exit.textContent).toContain("Exit");
    // jsdom reports no platform so isMac() is false → "Ctrl+Esc".
    expect(exit.textContent).toMatch(/Ctrl\+Esc|⌘Esc/);
    expect(exit.getAttribute("aria-label")).toMatch(/Exit fleet mode \((?:⌘Esc|Ctrl\+Esc)\)/);
  });

  it("exit chip click restores focus to lastArmedId via panelStore.setFocused", () => {
    seed([makeAgent("t1"), makeAgent("t2")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    render(<FleetArmingRibbon />);
    fireEvent.click(screen.getByTestId("fleet-exit"));
    expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
    expect(usePanelStore.getState().focusedId).toBe("t2");
  });

  it("count chip opens a popover listing armed terminal titles", () => {
    seed([
      { ...makeAgent("t1"), title: "frontend·main" } as PtyPanelData,
      { ...makeAgent("t2"), title: "backend·main" } as PtyPanelData,
    ]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    render(<FleetArmingRibbon />);
    fireEvent.click(screen.getByTestId("fleet-armed-count-chip"));
    const list = screen.getByTestId("fleet-armed-list");
    expect(list.textContent).toContain("frontend·main");
    expect(list.textContent).toContain("backend·main");
  });

  it("per-row disarm button in the popover calls disarmId", () => {
    seed([
      { ...makeAgent("t1"), title: "frontend·main" } as PtyPanelData,
      { ...makeAgent("t2"), title: "backend·main" } as PtyPanelData,
    ]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    render(<FleetArmingRibbon />);
    fireEvent.click(screen.getByTestId("fleet-armed-count-chip"));
    fireEvent.click(screen.getByLabelText("Disarm frontend·main"));
    const armed = useFleetArmingStore.getState().armedIds;
    expect(armed.has("t1")).toBe(false);
    expect(armed.has("t2")).toBe(true);
  });

  it("bare Escape with the popover open closes the list but does NOT disarm", () => {
    // Under the live-echo exit model (#5750) bare Escape belongs to the
    // targets: it closes the armed-list popover when open, but never
    // disarms the fleet. Exit requires ⌘Esc or the visible ✕ chip.
    seed([
      { ...makeAgent("t1"), title: "frontend·main" } as PtyPanelData,
      { ...makeAgent("t2"), title: "backend·main" } as PtyPanelData,
    ]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    render(<FleetArmingRibbon />);
    fireEvent.click(screen.getByTestId("fleet-armed-count-chip"));
    // First dispatched Escape: popover closes, fleet stays armed.
    act(() => {
      dispatchEscape();
    });
    expect(useFleetArmingStore.getState().armedIds.size).toBe(2);
    // Second dispatched Escape: still armed — bare Esc no longer disarms.
    act(() => {
      dispatchEscape();
    });
    expect(useFleetArmingStore.getState().armedIds.size).toBe(2);
  });

  it("announces armed count via the announcer store", () => {
    render(<FleetArmingRibbon />);
    act(() => {
      useFleetArmingStore.getState().armIds(["a", "b"]);
    });
    expect(useAnnouncerStore.getState().polite?.msg).toBe("2 terminals in fleet");
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
    expect(ribbon.getAttribute("aria-atomic")).toBe("true");
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

  it("renders 'Trash N terminals?' for the trash pending kind", () => {
    // Regression guard for issue #9947: the trash confirmation must use
    // 'terminal(s)' (matching the sibling kill case), not 'worktree(s)' —
    // the action moves armed terminal panels to trash, not worktrees.
    useFleetArmingStore.getState().armIds(["a", "b", "c", "d", "e"]);
    useFleetPendingActionStore.setState({
      pending: { kind: "trash", targetCount: 5, sessionLossCount: 0 },
    });
    render(<FleetArmingRibbon />);
    const ribbon = screen.getByTestId("fleet-arming-ribbon");
    expect(ribbon.getAttribute("data-pending-action")).toBe("trash");
    expect(screen.getByText(/Trash 5 terminals\?/)).toBeTruthy();
    expect(ribbon.textContent).not.toMatch(/worktree/i);
  });

  it("keeps the confirmation view visible when armed count drops to 1", () => {
    // Ribbon hides the normal view at armedCount < 2, but confirmation must
    // stay reachable: fleet.restart / fleet.kill always require confirmation
    // and may be invoked via keybinding with a single agent armed. If the
    // confirmation vanished on drain-to-one, the live window-level Enter
    // listener would still fire the action against hidden UI.
    useFleetArmingStore.getState().armIds(["a", "b", "c"]);
    useFleetPendingActionStore.setState({
      pending: { kind: "restart", targetCount: 3, sessionLossCount: 0 },
    });
    render(<FleetArmingRibbon />);
    expect(screen.getByTestId("fleet-arming-ribbon")).toBeTruthy();
    // Drain to 1 — the ribbon's main view is hidden, but pending is kept.
    act(() => {
      useFleetArmingStore.setState({
        armedIds: new Set(["a"]),
        armOrder: ["a"],
        armOrderById: { a: 0 },
        lastArmedId: "a",
      });
    });
    expect(useFleetPendingActionStore.getState().pending).not.toBeNull();
    expect(screen.getByTestId("fleet-arming-ribbon")).toBeTruthy();
    expect(screen.getByTestId("fleet-arming-ribbon").getAttribute("data-pending-action")).toBe(
      "restart"
    );
  });

  it("bare Escape with focus on a ribbon control exits the fleet", () => {
    seed([makeAgent("t1"), makeAgent("t2")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    render(<FleetArmingRibbon />);
    const exit = screen.getByTestId("fleet-exit");
    exit.focus();
    fireEvent.keyDown(exit, { key: "Escape" });
    expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
  });

  it("bare Escape from outside the ribbon does NOT exit the fleet", () => {
    seed([makeAgent("t1", "working"), makeAgent("t2", "working")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    render(<FleetArmingRibbon />);
    // No ribbon focus — Escape from the document body must not disarm
    // (terminal apps own bare Esc under live echo, #5750).
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useFleetArmingStore.getState().armedIds.size).toBe(2);
  });

  it("Cmd+Esc pressed twice within 350ms dispatches fleet.interrupt", async () => {
    seed([makeAgent("t1", "working"), makeAgent("t2", "working")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    const actionServiceModule = await import("@/services/ActionService");
    const dispatchSpy = vi.spyOn(actionServiceModule.actionService, "dispatch");
    render(<FleetArmingRibbon />);
    // First Cmd+Esc — stamps the ref, no dispatch yet (exit is pending).
    fireEvent.keyDown(window, { key: "Escape", metaKey: true });
    expect(dispatchSpy.mock.calls.some((c) => c[0] === "fleet.interrupt")).toBe(false);
    // Second Cmd+Esc within the window → interrupt wins, pending exit
    // timer is cancelled.
    fireEvent.keyDown(window, { key: "Escape", metaKey: true });
    expect(dispatchSpy.mock.calls.some((c) => c[0] === "fleet.interrupt")).toBe(true);
    // Fleet remains armed — interrupt dispatch doesn't clear selection.
    expect(useFleetArmingStore.getState().armedIds.size).toBe(2);
    dispatchSpy.mockRestore();
  });

  it("single Cmd+Esc exits broadcast after the double-tap window closes", () => {
    vi.useFakeTimers();
    try {
      seed([makeAgent("t1"), makeAgent("t2")]);
      useFleetArmingStore.getState().armIds(["t1", "t2"]);
      render(<FleetArmingRibbon />);
      fireEvent.keyDown(window, { key: "Escape", metaKey: true });
      // Exit is pending — still armed.
      expect(useFleetArmingStore.getState().armedIds.size).toBe(2);
      // Advance past the 350ms double-tap window.
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
      expect(usePanelStore.getState().focusedId).toBe("t2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Ctrl+Esc single-tap also exits (Ctrl is the non-macOS modifier)", () => {
    vi.useFakeTimers();
    try {
      seed([makeAgent("t1"), makeAgent("t2")]);
      useFleetArmingStore.getState().armIds(["t1", "t2"]);
      render(<FleetArmingRibbon />);
      fireEvent.keyDown(window, { key: "Escape", ctrlKey: true });
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("window blur cancels a pending single-tap exit and clears the chord timer", () => {
    vi.useFakeTimers();
    try {
      seed([makeAgent("t1"), makeAgent("t2")]);
      useFleetArmingStore.getState().armIds(["t1", "t2"]);
      render(<FleetArmingRibbon />);
      fireEvent.keyDown(window, { key: "Escape", metaKey: true });
      // User Cmd+Tabs away — blur should cancel the pending exit.
      fireEvent.blur(window);
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(useFleetArmingStore.getState().armedIds.size).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bare Escape Escape within 350ms dispatches fleet.interrupt with confirmed:true", async () => {
    // Bare double-Esc is the universal interrupt for Claude/Codex/Gemini;
    // routing it through batchDoubleEscape gives every armed agent a
    // deterministically-timed interrupt instead of two raw \x1b bytes
    // whose IPC arrival timing depends on user typing speed (#5964).
    seed([makeAgent("t1", "working"), makeAgent("t2", "working")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    const actionServiceModule = await import("@/services/ActionService");
    const dispatchSpy = vi.spyOn(actionServiceModule.actionService, "dispatch");
    render(<FleetArmingRibbon />);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape" });
    const interruptCalls = dispatchSpy.mock.calls.filter((c) => c[0] === "fleet.interrupt");
    expect(interruptCalls.length).toBe(1);
    expect(interruptCalls[0]?.[1]).toEqual({ confirmed: true });
    expect(interruptCalls[0]?.[2]).toEqual({ source: "keybinding" });
    // Fleet remains armed — interrupt doesn't clear selection.
    expect(useFleetArmingStore.getState().armedIds.size).toBe(2);
    dispatchSpy.mockRestore();
  });

  it("single bare Escape does NOT dispatch fleet.interrupt", async () => {
    // First bare Esc passes through so xterm still broadcasts a single
    // raw \x1b for menu/prompt dismissal across the armed set.
    seed([makeAgent("t1", "working"), makeAgent("t2", "working")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    const actionServiceModule = await import("@/services/ActionService");
    const dispatchSpy = vi.spyOn(actionServiceModule.actionService, "dispatch");
    render(<FleetArmingRibbon />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(dispatchSpy.mock.calls.some((c) => c[0] === "fleet.interrupt")).toBe(false);
    expect(useFleetArmingStore.getState().armedIds.size).toBe(2);
    dispatchSpy.mockRestore();
  });

  it("bare Escape Escape outside 350ms window does NOT dispatch fleet.interrupt", async () => {
    vi.useFakeTimers();
    try {
      seed([makeAgent("t1", "working"), makeAgent("t2", "working")]);
      useFleetArmingStore.getState().armIds(["t1", "t2"]);
      const actionServiceModule = await import("@/services/ActionService");
      const dispatchSpy = vi.spyOn(actionServiceModule.actionService, "dispatch");
      render(<FleetArmingRibbon />);
      fireEvent.keyDown(window, { key: "Escape" });
      vi.setSystemTime(new Date(Date.now() + 500));
      fireEvent.keyDown(window, { key: "Escape" });
      expect(dispatchSpy.mock.calls.some((c) => c[0] === "fleet.interrupt")).toBe(false);
      dispatchSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bare Escape Escape while a pending action is open does NOT dispatch fleet.interrupt", async () => {
    // A pending confirmation owns Escape via useEscapeStack; the bare-tap
    // detector must yield so the user can cancel the confirm cleanly.
    seed([makeAgent("t1", "working"), makeAgent("t2", "working"), makeAgent("t3", "working")]);
    useFleetArmingStore.getState().armIds(["t1", "t2", "t3"]);
    useFleetPendingActionStore.setState({
      pending: { kind: "interrupt", targetCount: 3, sessionLossCount: 0 },
    });
    const actionServiceModule = await import("@/services/ActionService");
    const dispatchSpy = vi.spyOn(actionServiceModule.actionService, "dispatch");
    render(<FleetArmingRibbon />);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(dispatchSpy.mock.calls.some((c) => c[0] === "fleet.interrupt")).toBe(false);
    dispatchSpy.mockRestore();
  });

  it("bare Escape Escape while the armed-list popover is open does NOT dispatch fleet.interrupt", async () => {
    seed([makeAgent("t1", "working"), makeAgent("t2", "working")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    const actionServiceModule = await import("@/services/ActionService");
    const dispatchSpy = vi.spyOn(actionServiceModule.actionService, "dispatch");
    render(<FleetArmingRibbon />);
    // Opening the popover sets popoverOpen=true → bareEscapeBlockedRef is true.
    fireEvent.click(screen.getByTestId("fleet-armed-count-chip"));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(dispatchSpy.mock.calls.some((c) => c[0] === "fleet.interrupt")).toBe(false);
    dispatchSpy.mockRestore();
  });

  it("held bare Escape (e.repeat=true) does NOT dispatch fleet.interrupt", async () => {
    // Bare Escape auto-repeats while held; the OS-generated repeat must
    // not satisfy the double-tap window or the user would interrupt the
    // fleet just by leaning on the key.
    seed([makeAgent("t1", "working"), makeAgent("t2", "working")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    const actionServiceModule = await import("@/services/ActionService");
    const dispatchSpy = vi.spyOn(actionServiceModule.actionService, "dispatch");
    render(<FleetArmingRibbon />);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape", repeat: true });
    fireEvent.keyDown(window, { key: "Escape", repeat: true });
    expect(dispatchSpy.mock.calls.some((c) => c[0] === "fleet.interrupt")).toBe(false);
    dispatchSpy.mockRestore();
  });

  it("window blur between bare Escapes resets the double-tap timer", async () => {
    // First tap stamps the ref; blur clears it; the next bare Esc must be
    // treated as a fresh first tap, not the second of a pair.
    seed([makeAgent("t1", "working"), makeAgent("t2", "working")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    const actionServiceModule = await import("@/services/ActionService");
    const dispatchSpy = vi.spyOn(actionServiceModule.actionService, "dispatch");
    render(<FleetArmingRibbon />);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.blur(window);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(dispatchSpy.mock.calls.some((c) => c[0] === "fleet.interrupt")).toBe(false);
    dispatchSpy.mockRestore();
  });

  it("bare Escape Escape inside a non-xterm textarea does NOT dispatch fleet.interrupt", async () => {
    // The composer / settings / recipe-editor surfaces own bare Esc — it
    // dismisses or clears the input. Firing fleet.interrupt from a text
    // input would be a hidden side effect of the visible dismiss action.
    seed([makeAgent("t1", "working"), makeAgent("t2", "working")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    const actionServiceModule = await import("@/services/ActionService");
    const dispatchSpy = vi.spyOn(actionServiceModule.actionService, "dispatch");
    render(<FleetArmingRibbon />);
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    try {
      fireEvent.keyDown(textarea, { key: "Escape" });
      fireEvent.keyDown(textarea, { key: "Escape" });
      expect(dispatchSpy.mock.calls.some((c) => c[0] === "fleet.interrupt")).toBe(false);
    } finally {
      textarea.remove();
    }
    dispatchSpy.mockRestore();
  });

  it("⌘Esc from a textarea still triggers the exit chord", () => {
    // The composer textarea is the primary input surface when armed —
    // the chord must fire from it, not be swallowed by focus heuristics.
    vi.useFakeTimers();
    try {
      seed([makeAgent("t1"), makeAgent("t2")]);
      useFleetArmingStore.getState().armIds(["t1", "t2"]);
      render(<FleetArmingRibbon />);
      const textarea = document.createElement("textarea");
      document.body.appendChild(textarea);
      textarea.focus();
      try {
        fireEvent.keyDown(textarea, { key: "Escape", metaKey: true });
        act(() => {
          vi.advanceTimersByTime(400);
        });
        expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
      } finally {
        textarea.remove();
      }
    } finally {
      vi.useRealTimers();
    }
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

  // This listener is capture-phase, so without a modal guard it beat a focused
  // dialog button to the Enter and confirmed a destructive fleet action instead
  // of activating that button (issue #11106).
  it("ignores Enter that a modal dialog owns", async () => {
    useFleetArmingStore.getState().armIds(["a", "b", "c"]);
    useFleetPendingActionStore.setState({
      pending: { kind: "kill", targetCount: 3, sessionLossCount: 0 },
    });
    const actionServiceModule = await import("@/services/ActionService");
    const dispatchSpy = vi.spyOn(actionServiceModule.actionService, "dispatch");
    render(<FleetArmingRibbon />);

    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    modal.appendChild(cancel);
    document.body.appendChild(modal);

    try {
      cancel.focus();
      fireEvent.keyDown(cancel, { key: "Enter" });

      expect(dispatchSpy.mock.calls.find((c) => c[0] === "fleet.kill")).toBeUndefined();
    } finally {
      modal.remove();
      dispatchSpy.mockRestore();
    }
  });

  describe("Selection menu", () => {
    function findMenuItem(label: RegExp | string): HTMLElement {
      const items = screen.getAllByRole("menuitem");
      for (const el of items) {
        const text = el.textContent ?? "";
        if (typeof label === "string" ? text.includes(label) : label.test(text)) {
          return el;
        }
      }
      throw new Error(`menu item not found for ${label.toString()}`);
    }

    it("renders the trigger on the armed ribbon", () => {
      seed([makeAgent("t1", "working"), makeAgent("t2", "working")]);
      useFleetArmingStore.getState().armIds(["t1", "t2"]);
      render(<FleetArmingRibbon />);
      expect(screen.getByTestId("fleet-selection-menu-trigger")).toBeTruthy();
    });

    it("'All waiting — this worktree' arms waiting agents in the current worktree", () => {
      seed([
        makeAgent("t1", "working"),
        makeAgent("t2", "waiting"),
        { ...makeAgent("t3", "waiting"), worktreeId: "wt-2" } as PtyPanelData,
      ]);
      useFleetArmingStore.getState().armIds(["t1", "t3"]);
      render(<FleetArmingRibbon />);
      fireEvent.click(findMenuItem(/All waiting — this worktree/));
      const armed = useFleetArmingStore.getState().armedIds;
      expect([...armed]).toEqual(["t2"]);
    });

    it("'All waiting — all worktrees' arms waiting agents across every worktree", () => {
      seed([
        makeAgent("t1", "working"),
        makeAgent("t2", "waiting"),
        { ...makeAgent("t3", "waiting"), worktreeId: "wt-2" } as PtyPanelData,
      ]);
      useFleetArmingStore.getState().armIds(["t1", "t2"]);
      render(<FleetArmingRibbon />);
      fireEvent.click(findMenuItem(/All waiting — all worktrees/));
      const armed = useFleetArmingStore.getState().armedIds;
      expect([...armed].sort()).toEqual(["t2", "t3"]);
    });

    it("'All working — this worktree' arms working agents in the current worktree", () => {
      seed([makeAgent("t1", "working"), makeAgent("t2", "waiting")]);
      useFleetArmingStore.getState().armIds(["t1", "t2"]);
      render(<FleetArmingRibbon />);
      fireEvent.click(findMenuItem(/All working — this worktree/));
      const armed = useFleetArmingStore.getState().armedIds;
      expect([...armed]).toEqual(["t1"]);
    });

    it("'All in this worktree' arms every eligible terminal in the current worktree", () => {
      seed([
        makeAgent("t1", "working"),
        makeAgent("t2", "waiting"),
        makeAgent("t3", "completed"),
        { ...makeAgent("t4", "waiting"), worktreeId: "wt-2" } as PtyPanelData,
      ]);
      useFleetArmingStore.getState().armIds(["t1", "t4"]);
      render(<FleetArmingRibbon />);
      fireEvent.click(findMenuItem(/All in this worktree/));
      const armed = useFleetArmingStore.getState().armedIds;
      expect([...armed].sort()).toEqual(["t1", "t2", "t3"]);
    });

    it("'Clear selection' clears the armed set", () => {
      useFleetArmingStore.getState().armIds(["a", "b", "c"]);
      render(<FleetArmingRibbon />);
      fireEvent.click(findMenuItem(/Clear selection/));
      expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
    });

    it("'Focus selection' dispatches fleet.scope.enter with source user", async () => {
      useFleetArmingStore.getState().armIds(["a", "b"]);
      const actionServiceModule = await import("@/services/ActionService");
      const dispatchSpy = vi.spyOn(actionServiceModule.actionService, "dispatch");
      render(<FleetArmingRibbon />);
      fireEvent.click(findMenuItem(/Focus selection/));
      const match = dispatchSpy.mock.calls.find((c) => c[0] === "fleet.scope.enter");
      expect(match).toBeDefined();
      expect(match?.[1]).toBeUndefined();
      expect(match?.[2]).toEqual({ source: "user" });
      dispatchSpy.mockRestore();
    });

    it("'All working' arms agents in 'working' state", () => {
      seed([makeAgent("t1", "working"), makeAgent("t2", "working")]);
      useFleetArmingStore.getState().armIds(["t1", "t2"]);
      render(<FleetArmingRibbon />);
      fireEvent.click(findMenuItem(/All working — this worktree/));
      const armed = useFleetArmingStore.getState().armedIds;
      expect([...armed].sort()).toEqual(["t1", "t2"]);
    });
  });

  describe("broadcast progress counter", () => {
    beforeEach(() => {
      useFleetBroadcastProgressStore.setState({
        completed: 0,
        total: 0,
        failed: 0,
        isActive: false,
        cancelled: false,
      });
    });

    it("does not render when isActive is false", () => {
      useFleetBroadcastProgressStore.setState({ total: 15, isActive: false });
      useFleetArmingStore.getState().armIds(["a", "b"]);
      render(<FleetArmingRibbon />);
      expect(screen.queryByTestId("fleet-broadcast-progress")).toBeNull();
    });

    it("does not render until the Doherty threshold elapses", () => {
      // Count no longer gates visibility — duration does. Counter hidden
      // until the Doherty threshold (400ms) elapses.
      vi.useFakeTimers();
      try {
        useFleetBroadcastProgressStore.setState({ total: 3, isActive: true });
        useFleetArmingStore.getState().armIds(["a", "b"]);
        render(<FleetArmingRibbon />);
        expect(screen.queryByTestId("fleet-broadcast-progress")).toBeNull();
        act(() => {
          vi.advanceTimersByTime(400);
        });
        expect(screen.getByTestId("fleet-broadcast-progress")).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    it("renders when isActive and the Doherty threshold elapses", () => {
      vi.useFakeTimers();
      try {
        useFleetBroadcastProgressStore.setState({
          completed: 5,
          total: 15,
          isActive: true,
        });
        useFleetArmingStore.getState().armIds(["a", "b", "c"]);
        render(<FleetArmingRibbon />);
        act(() => {
          vi.advanceTimersByTime(400);
        });
        const el = screen.getByTestId("fleet-broadcast-progress");
        expect(el.textContent).toContain("5/15");
      } finally {
        vi.useRealTimers();
      }
    });

    it("shows failure count when failed > 0", () => {
      vi.useFakeTimers();
      try {
        useFleetBroadcastProgressStore.setState({
          completed: 8,
          total: 12,
          failed: 2,
          isActive: true,
        });
        useFleetArmingStore.getState().armIds(["a", "b", "c"]);
        render(<FleetArmingRibbon />);
        act(() => {
          vi.advanceTimersByTime(400);
        });
        const el = screen.getByTestId("fleet-broadcast-progress");
        expect(el.textContent).toContain("8/12");
        expect(el.textContent).toContain("2 failed");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not show failure count when failed is 0", () => {
      vi.useFakeTimers();
      try {
        useFleetBroadcastProgressStore.setState({
          completed: 8,
          total: 12,
          failed: 0,
          isActive: true,
        });
        useFleetArmingStore.getState().armIds(["a", "b", "c"]);
        render(<FleetArmingRibbon />);
        act(() => {
          vi.advanceTimersByTime(400);
        });
        const el = screen.getByTestId("fleet-broadcast-progress");
        expect(el.textContent).toContain("8/12");
        expect(el.textContent).not.toContain("failed");
      } finally {
        vi.useRealTimers();
      }
    });

    it("renders progress counter for small fleets after Doherty threshold", () => {
      vi.useFakeTimers();
      try {
        useFleetBroadcastProgressStore.setState({
          completed: 3,
          total: 3,
          isActive: true,
        });
        useFleetArmingStore.getState().armIds(["a", "b"]);
        render(<FleetArmingRibbon />);
        expect(screen.queryByTestId("fleet-broadcast-progress")).toBeNull();
        act(() => {
          vi.advanceTimersByTime(400);
        });
        expect(screen.getByTestId("fleet-broadcast-progress")).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    it("disappears when isActive becomes false mid-broadcast", () => {
      vi.useFakeTimers();
      try {
        useFleetBroadcastProgressStore.setState({
          completed: 10,
          total: 12,
          isActive: true,
        });
        useFleetArmingStore.getState().armIds(["a", "b", "c"]);
        const { rerender } = render(<FleetArmingRibbon />);
        act(() => {
          vi.advanceTimersByTime(400);
        });
        expect(screen.getByTestId("fleet-broadcast-progress")).toBeTruthy();

        act(() => {
          useFleetBroadcastProgressStore.setState({ isActive: false });
        });
        rerender(<FleetArmingRibbon />);
        expect(screen.queryByTestId("fleet-broadcast-progress")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("renders a Cancel button alongside the progress counter when active", () => {
      vi.useFakeTimers();
      try {
        useFleetBroadcastProgressStore.setState({
          completed: 3,
          total: 12,
          isActive: true,
        });
        useFleetArmingStore.getState().armIds(["a", "b", "c"]);
        render(<FleetArmingRibbon />);
        act(() => {
          vi.advanceTimersByTime(400);
        });
        const cancel = screen.getByTestId("fleet-broadcast-cancel");
        expect(cancel.getAttribute("aria-label")).toBe("Cancel broadcast");
        expect(screen.getByTestId("fleet-broadcast-progress")).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    it("clicking Cancel flips the progress store cancelled flag", () => {
      vi.useFakeTimers();
      try {
        useFleetBroadcastProgressStore.setState({
          completed: 3,
          total: 12,
          isActive: true,
        });
        useFleetArmingStore.getState().armIds(["a", "b", "c"]);
        render(<FleetArmingRibbon />);
        act(() => {
          vi.advanceTimersByTime(400);
        });
        fireEvent.click(screen.getByTestId("fleet-broadcast-cancel"));
        expect(useFleetBroadcastProgressStore.getState().cancelled).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("Cancel button is reachable for batched broadcasts — counter visible after Doherty", () => {
      vi.useFakeTimers();
      try {
        useFleetBroadcastProgressStore.setState({
          completed: 1,
          total: 7,
          isActive: true,
        });
        useFleetArmingStore.getState().armIds(["a", "b"]);
        render(<FleetArmingRibbon />);
        act(() => {
          vi.advanceTimersByTime(400);
        });
        expect(screen.getByTestId("fleet-broadcast-cancel")).toBeTruthy();
        expect(screen.getByTestId("fleet-broadcast-progress")).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    it("Cancel button does not render for non-batchable fleets (total ≤ 5)", () => {
      // At/below batch size the executor takes the atomic non-batched path
      // — there's nothing to interrupt cooperatively. Hide Cancel.
      useFleetBroadcastProgressStore.setState({
        completed: 1,
        total: 5,
        isActive: true,
      });
      useFleetArmingStore.getState().armIds(["a", "b"]);
      render(<FleetArmingRibbon />);
      expect(screen.queryByTestId("fleet-broadcast-cancel")).toBeNull();
    });
  });

  describe("count chip popover — picker mode (+ Add panes…)", () => {
    beforeEach(() => {
      // Reset the single-active picker session between cases — leaks across
      // would silently make `acquired` flip in mid-test and mask real bugs.
      useFleetPickerSessionStore.setState({ activeOwner: null });
      Object.assign(window, {
        electron: {
          terminal: {
            searchSemanticBuffers: vi.fn().mockResolvedValue([]),
          },
        },
      });
    });

    it("renders an `+ Add panes…` row in the armed list popover", () => {
      seed([makeAgent("t1"), makeAgent("t2")]);
      useFleetArmingStore.getState().armIds(["t1", "t2"]);
      render(<FleetArmingRibbon />);
      fireEvent.click(screen.getByTestId("fleet-armed-count-chip"));
      expect(screen.getByTestId("fleet-armed-list-add-panes").textContent).toContain("Add panes");
    });

    it("hides `+ Add panes…` row when popover is in picker mode", async () => {
      // Regression: the row belongs to the list view only. When the user
      // swaps into picker mode, the row must not be rendered alongside
      // the picker — that would duplicate affordance and confuse focus.
      seed([makeAgent("t1"), makeAgent("t2"), makeAgent("t3")]);
      useFleetArmingStore.getState().armIds(["t1", "t2"]);
      render(<FleetArmingRibbon />);
      fireEvent.click(screen.getByTestId("fleet-armed-count-chip"));
      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-armed-list-add-panes"));
      });
      expect(screen.queryByTestId("fleet-armed-list-add-panes")).toBeNull();
      expect(screen.getByTestId("fleet-picker-add-root")).toBeTruthy();
    });

    it("clicking `+ Add panes…` swaps popover to picker mode", async () => {
      seed([makeAgent("t1"), makeAgent("t2"), makeAgent("t3")]);
      useFleetArmingStore.getState().armIds(["t1", "t2"]);
      render(<FleetArmingRibbon />);
      fireEvent.click(screen.getByTestId("fleet-armed-count-chip"));
      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-armed-list-add-panes"));
      });
      expect(screen.getByTestId("fleet-picker-add-root")).toBeTruthy();
      expect(screen.getByTestId("fleet-picker-back")).toBeTruthy();
    });

    it("picker mode hides already-armed panes and shows only addable ones", async () => {
      seed([makeAgent("t1"), makeAgent("t2"), makeAgent("t3")]);
      useFleetArmingStore.getState().armIds(["t1", "t2"]);
      render(<FleetArmingRibbon />);
      fireEvent.click(screen.getByTestId("fleet-armed-count-chip"));
      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-armed-list-add-panes"));
      });
      expect(screen.queryByTestId("fleet-picker-add-row-t1")).toBeNull();
      expect(screen.queryByTestId("fleet-picker-add-row-t2")).toBeNull();
      expect(screen.getByTestId("fleet-picker-add-row-t3")).toBeTruthy();
    });

    it("commit appends new ids via addToFleet (preserves existing armOrder)", async () => {
      seed([makeAgent("t1"), makeAgent("t2"), makeAgent("t3")]);
      useFleetArmingStore.getState().armIds(["t1", "t2"]);
      render(<FleetArmingRibbon />);
      fireEvent.click(screen.getByTestId("fleet-armed-count-chip"));
      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-armed-list-add-panes"));
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-picker-add-row-t3"));
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-picker-add-confirm"));
      });
      const s = useFleetArmingStore.getState();
      expect(s.armOrder).toEqual(["t1", "t2", "t3"]);
      expect(s.lastArmedId).toBe("t3");
    });

    it("returns to list mode after commit", async () => {
      seed([makeAgent("t1"), makeAgent("t2"), makeAgent("t3")]);
      useFleetArmingStore.getState().armIds(["t1", "t2"]);
      render(<FleetArmingRibbon />);
      fireEvent.click(screen.getByTestId("fleet-armed-count-chip"));
      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-armed-list-add-panes"));
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-picker-add-row-t3"));
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-picker-add-confirm"));
      });
      // After commit, the list view is back: armed-list-add-panes is visible
      // again; the picker root is gone.
      expect(screen.queryByTestId("fleet-picker-add-root")).toBeNull();
      expect(screen.getByTestId("fleet-armed-list-add-panes")).toBeTruthy();
    });

    it("Back button returns to list mode without committing", async () => {
      seed([makeAgent("t1"), makeAgent("t2"), makeAgent("t3")]);
      useFleetArmingStore.getState().armIds(["t1", "t2"]);
      render(<FleetArmingRibbon />);
      fireEvent.click(screen.getByTestId("fleet-armed-count-chip"));
      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-armed-list-add-panes"));
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-picker-add-row-t3"));
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-picker-back"));
      });
      // Back to list, t3 NOT armed.
      expect(useFleetArmingStore.getState().armOrder).toEqual(["t1", "t2"]);
      expect(screen.queryByTestId("fleet-picker-add-root")).toBeNull();
    });

    it("confirm button is disabled when nothing is selected", async () => {
      seed([makeAgent("t1"), makeAgent("t2"), makeAgent("t3")]);
      useFleetArmingStore.getState().armIds(["t1", "t2"]);
      render(<FleetArmingRibbon />);
      fireEvent.click(screen.getByTestId("fleet-armed-count-chip"));
      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-armed-list-add-panes"));
      });
      const confirm = screen.getByTestId("fleet-picker-add-confirm") as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
    });

    it("popover-mode resets to list when popover closes (Esc twice on empty query)", async () => {
      seed([makeAgent("t1"), makeAgent("t2"), makeAgent("t3")]);
      useFleetArmingStore.getState().armIds(["t1", "t2"]);
      render(<FleetArmingRibbon />);
      fireEvent.click(screen.getByTestId("fleet-armed-count-chip"));
      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-armed-list-add-panes"));
      });
      // 1st Esc: query is empty so the search-clear handler is not registered
      // — this Esc fires the picker→list handler.
      await act(async () => {
        dispatchEscape();
      });
      expect(screen.queryByTestId("fleet-picker-add-root")).toBeNull();
      expect(screen.getByTestId("fleet-armed-list-add-panes")).toBeTruthy();
    });

    it("Esc clears non-empty search query before exiting picker mode", async () => {
      seed([makeAgent("t1"), makeAgent("t2"), makeAgent("t3")]);
      useFleetArmingStore.getState().armIds(["t1", "t2"]);
      render(<FleetArmingRibbon />);
      fireEvent.click(screen.getByTestId("fleet-armed-count-chip"));
      await act(async () => {
        fireEvent.click(screen.getByTestId("fleet-armed-list-add-panes"));
      });
      const search = screen.getByTestId("fleet-picker-add-search") as HTMLInputElement;
      await act(async () => {
        fireEvent.change(search, { target: { value: "hello" } });
      });
      await act(async () => {});
      // 1st Esc clears search; picker mode still active.
      await act(async () => {
        dispatchEscape();
      });
      await act(async () => {});
      expect(screen.getByTestId("fleet-picker-add-root")).toBeTruthy();
      expect((screen.getByTestId("fleet-picker-add-search") as HTMLInputElement).value).toBe("");
      // 2nd Esc backs out of picker.
      await act(async () => {
        dispatchEscape();
      });
      expect(screen.queryByTestId("fleet-picker-add-root")).toBeNull();
    });
  });
});

describe("FleetArmingRibbon — saved fleet delete confirm (#8023)", () => {
  beforeEach(() => {
    resetStores();
    useProjectSettingsStore.setState({
      settings: {
        runCommands: [],
        fleetSavedScopes: [
          { kind: "snapshot", id: "fs-1", name: "My fleet", terminalIds: [], createdAt: 1 },
        ],
      } as ProjectSettings,
    });
  });

  it("trash button opens a confirm dialog instead of deleting immediately", async () => {
    const actionServiceModule = await import("@/services/ActionService");
    const dispatchSpy = vi.spyOn(actionServiceModule.actionService, "dispatch");

    useFleetArmingStore.getState().armIds(["a", "b"]);
    render(<FleetArmingRibbon />);

    const trash = screen.getByTestId("fleet-saved-row-delete");
    await act(async () => {
      fireEvent.click(trash);
    });

    // No immediate dispatch — the confirm must gate the deletion.
    expect(dispatchSpy.mock.calls.some((c) => c[0] === "fleet.deleteNamedFleet")).toBe(false);
    expect(screen.getByText("Delete 'My fleet'?")).toBeTruthy();

    dispatchSpy.mockRestore();
  });

  it("confirming the dialog dispatches fleet.deleteNamedFleet with the scope id", async () => {
    const actionServiceModule = await import("@/services/ActionService");
    const dispatchSpy = vi.spyOn(actionServiceModule.actionService, "dispatch");

    useFleetArmingStore.getState().armIds(["a", "b"]);
    render(<FleetArmingRibbon />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("fleet-saved-row-delete"));
    });

    const confirmBtn = screen.getByRole("button", { name: "Delete fleet" });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    expect(dispatchSpy).toHaveBeenCalledWith(
      "fleet.deleteNamedFleet",
      { id: "fs-1" },
      { source: "user" }
    );

    dispatchSpy.mockRestore();
  });

  it("cancelling the dialog does not dispatch and closes the dialog", async () => {
    const actionServiceModule = await import("@/services/ActionService");
    const dispatchSpy = vi.spyOn(actionServiceModule.actionService, "dispatch");

    useFleetArmingStore.getState().armIds(["a", "b"]);
    render(<FleetArmingRibbon />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("fleet-saved-row-delete"));
    });
    expect(screen.getByText("Delete 'My fleet'?")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    expect(dispatchSpy.mock.calls.some((c) => c[0] === "fleet.deleteNamedFleet")).toBe(false);
    expect(screen.queryByText("Delete 'My fleet'?")).toBeNull();

    dispatchSpy.mockRestore();
  });

  it("clears the pending delete when the armed set drains below 2", async () => {
    useFleetArmingStore.getState().armIds(["a", "b"]);
    render(<FleetArmingRibbon />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("fleet-saved-row-delete"));
    });
    expect(screen.getByText("Delete 'My fleet'?")).toBeTruthy();

    // Drain to 1 — the ribbon (and dialog) unmount via the armedCount<2 guard.
    await act(async () => {
      useFleetArmingStore.getState().armIds(["a"]);
    });
    expect(screen.queryByText("Delete 'My fleet'?")).toBeNull();

    // Re-arm: the dialog must NOT resurface for the stale fleet id.
    await act(async () => {
      useFleetArmingStore.getState().armIds(["a", "b"]);
    });
    expect(screen.queryByText("Delete 'My fleet'?")).toBeNull();
  });
});

describe("supervised run status line (#10930)", () => {
  function makeRunTarget(
    terminalId: string,
    overrides: Partial<FleetRunTarget> = {}
  ): FleetRunTarget {
    return {
      terminalId,
      title: terminalId,
      worktreeId: "wt-1",
      submission: "sent",
      agentState: "working",
      settled: false,
      gone: false,
      ...overrides,
    };
  }

  function seedRun(status: FleetRun["status"], targets: FleetRunTarget[]): void {
    useFleetRunStore.setState({
      run: {
        runId: "run-1",
        status,
        isRetry: false,
        draftPreview: "hello",
        startedAt: Date.now(),
        targets,
      },
    });
  }

  beforeEach(() => {
    resetStores();
    useFleetBroadcastProgressStore.setState({
      completed: 0,
      total: 0,
      failed: 0,
      isActive: false,
      cancelled: false,
    });
    seed([makeAgent("a"), makeAgent("b"), makeAgent("c")]);
    useFleetArmingStore.getState().armIds(["a", "b", "c"]);
  });

  it("shows live counts while the run is watching", () => {
    seedRun("watching", [
      makeRunTarget("a"),
      makeRunTarget("b", { settled: true, agentState: "waiting" }),
      makeRunTarget("c", {
        submission: "failed",
        settled: true,
        failureKind: "transient",
        agentState: "idle",
      }),
    ]);
    render(<FleetArmingRibbon />);
    const status = screen.getByTestId("fleet-run-status");
    expect(status.textContent).toContain("1 working");
    expect(status.textContent).toContain("1 waiting");
    expect(status.textContent).toContain("1 failed");
    // Watching runs are not dismissible — the line reflects live state.
    expect(screen.queryByTestId("fleet-run-dismiss")).toBeNull();
  });

  it("shows a dismissible summary once the run finishes", () => {
    seedRun("completed", [
      makeRunTarget("a", { settled: true, agentState: "completed" }),
      makeRunTarget("b", { settled: true, agentState: "waiting" }),
    ]);
    render(<FleetArmingRibbon />);
    const status = screen.getByTestId("fleet-run-status");
    expect(status.textContent).toContain("Run finished");
    expect(status.textContent).toContain("1 waiting");
    expect(status.textContent).toContain("1 done");

    fireEvent.click(screen.getByTestId("fleet-run-dismiss"));
    expect(useFleetRunStore.getState().run).toBeNull();
    expect(screen.queryByTestId("fleet-run-status")).toBeNull();
  });

  it("shows a dismissible failure summary when nothing was sent", () => {
    seedRun("failed", [
      makeRunTarget("a", {
        submission: "failed",
        settled: true,
        failureKind: "permanent",
        agentState: "idle",
      }),
    ]);
    render(<FleetArmingRibbon />);
    expect(screen.getByTestId("fleet-run-status").textContent).toContain("Run failed");
    expect(screen.getByTestId("fleet-run-dismiss")).toBeTruthy();
  });

  it("renders nothing for cancelled or superseded runs", () => {
    seedRun("cancelled", [makeRunTarget("a", { submission: "skipped", settled: true })]);
    const { unmount } = render(<FleetArmingRibbon />);
    expect(screen.queryByTestId("fleet-run-status")).toBeNull();
    unmount();

    seedRun("superseded", [makeRunTarget("a")]);
    render(<FleetArmingRibbon />);
    expect(screen.queryByTestId("fleet-run-status")).toBeNull();
  });

  it("yields the slot to submission progress while a broadcast is active", () => {
    seedRun("watching", [makeRunTarget("a")]);
    useFleetBroadcastProgressStore.setState({
      completed: 1,
      total: 3,
      failed: 0,
      isActive: true,
      cancelled: false,
    });
    render(<FleetArmingRibbon />);
    expect(screen.queryByTestId("fleet-run-status")).toBeNull();
  });
});
