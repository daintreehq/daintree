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
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));

import { FleetArmingRibbon } from "../FleetArmingRibbon";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetPendingActionStore } from "@/store/fleetPendingActionStore";
import { useFleetBroadcastConfirmStore } from "@/store/fleetBroadcastConfirmStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";
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
  useFleetBroadcastConfirmStore.setState({ pending: null });
  usePanelStore.setState({ panelsById: {}, panelIds: [], focusedId: null });
  useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1", isFleetScopeActive: false });
  useWorktreeFilterStore.setState({ quickStateFilter: "all" });
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
    kind: "terminal",
    detectedAgentId: "claude",
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

  it("bare Escape with the popover open closes the list but does NOT disarm", () => {
    // Under the live-echo exit model (#5750) bare Escape belongs to the
    // targets: it closes the armed-list popover when open, but never
    // disarms the fleet. Exit requires ⌘Esc or the visible ✕ chip.
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

  it("bare Escape Escape while a pending broadcast confirm is open does NOT dispatch fleet.interrupt", async () => {
    seed([makeAgent("t1", "working"), makeAgent("t2", "working")]);
    useFleetArmingStore.getState().armIds(["t1", "t2"]);
    useFleetBroadcastConfirmStore.setState({
      pending: {
        text: "rm -rf /",
        warningReasons: ["destructive"],
        onConfirm: async () => {},
      },
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
        { ...makeAgent("t3", "waiting"), worktreeId: "wt-2" } as TerminalInstance,
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
        { ...makeAgent("t3", "waiting"), worktreeId: "wt-2" } as TerminalInstance,
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
        { ...makeAgent("t4", "waiting"), worktreeId: "wt-2" } as TerminalInstance,
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
});
