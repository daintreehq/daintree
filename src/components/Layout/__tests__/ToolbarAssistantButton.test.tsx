// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { ToolbarAssistantButton } from "../ToolbarAssistantButton";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { usePanelStore } from "@/store";
import { __resetMcpAnomalyStoreForTesting, useMcpAnomalyStore } from "@/store/mcpAnomalyStore";
import type { McpRuntimeSnapshot } from "@shared/types";

const mcpReadiness: () => McpRuntimeSnapshot = vi.fn((): McpRuntimeSnapshot => ({
  enabled: true,
  state: "ready",
  port: 0,
  lastError: null,
}));
const mcpReadinessMock = mcpReadiness as ReturnType<typeof vi.fn>;

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...rest
  }: { children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...rest}>{children}</button>
  ),
}));

vi.mock("@/components/icons/DaintreeIcon", () => ({
  DaintreeIcon: () => <span data-testid="icon-daintree" />,
}));

vi.mock("@/hooks", () => ({
  useAriaKeyshortcuts: () => "",
  useKeybindingDisplay: () => "",
  useShortcutHintHover: () => ({}),
}));

vi.mock("@/lib/tooltipShortcut", () => ({
  createTooltipContent: () => null,
}));

vi.mock("@/lib/sidebarToggle", () => ({
  suppressSidebarResizes: vi.fn(),
}));

vi.mock("@/hooks/useMcpReadiness", () => ({
  useMcpReadiness: () => mcpReadiness(),
}));

let mockGestureAssistantHidden = false;
const clearAssistantGestureMock = vi.fn(() => {
  mockGestureAssistantHidden = false;
});

vi.mock("@/store/focusStore", () => ({
  useFocusStore: Object.assign(
    (selector: (s: { gestureAssistantHidden: boolean }) => unknown) =>
      selector({ gestureAssistantHidden: mockGestureAssistantHidden }),
    {
      getState: () => ({
        gestureAssistantHidden: mockGestureAssistantHidden,
        clearAssistantGesture: clearAssistantGestureMock,
      }),
    }
  ),
}));

/**
 * Seed the panel with a single assistant lane (#12108). These cases predate
 * lanes and all describe one session, so they seed slot 0; the aggregate
 * behaviour across lanes has its own tests below.
 */
function setHelpPanel(state: { isOpen: boolean; terminalId: string | null }) {
  useHelpPanelStore.setState({
    isOpen: state.isOpen,
    sessions: { 0: { ...emptyLane(), terminalId: state.terminalId } },
    activeSlot: 0,
  });
}

function emptyLane() {
  return {
    terminalId: null,
    agentId: null,
    sessionId: null,
    conversationTouched: false,
    figures: [],
    activeFigureNumber: null,
  };
}

function setPanel(id: string, agentState: string | undefined): void {
  usePanelStore.setState((s) => ({
    ...s,
    panelsById: {
      ...s.panelsById,
      [id]: {
        id,
        kind: "terminal",
        title: "test",
        cwd: "/tmp",
        location: "dock",
        worktreeId: undefined,
        agentState: agentState as never,
      } as never,
    },
    panelIds: s.panelIds.includes(id) ? s.panelIds : [...s.panelIds, id],
  }));
}

describe("ToolbarAssistantButton — agent state pip", () => {
  beforeEach(() => {
    mcpReadinessMock.mockReturnValue({ enabled: true, state: "ready", port: 0, lastError: null });
    useHelpPanelStore.setState({
      isOpen: false,
      sessions: { 0: emptyLane() },
      activeSlot: 0,
    });
    usePanelStore.setState({ panelsById: {}, panelIds: [] } as never);
    mockGestureAssistantHidden = false;
    clearAssistantGestureMock.mockClear();
    __resetMcpAnomalyStoreForTesting();
  });

  it("does not render the pip when the assistant is idle", () => {
    setHelpPanel({ isOpen: false, terminalId: "t-1" });
    setPanel("t-1", "idle");

    const { queryByTestId } = render(<ToolbarAssistantButton />);
    expect(queryByTestId("assistant-working-pip")?.getAttribute("data-visible")).toBe("false");
  });

  it("renders a green pip when the assistant terminal's agentState is working", () => {
    setHelpPanel({ isOpen: false, terminalId: "t-2" });
    setPanel("t-2", "working");

    const { queryByTestId } = render(<ToolbarAssistantButton />);
    const pip = queryByTestId("assistant-working-pip");
    expect(pip?.getAttribute("data-visible")).toBe("true");
    expect(pip!.className).toMatch(/bg-state-working/);
    expect(pip!.className).not.toMatch(/animate-pulse/);
    expect(pip!.className).not.toMatch(/accent/);
    expect(pip!.className).not.toMatch(/bg-status-/);
    expect(pip!.getAttribute("data-agent-state")).toBe("working");
  });

  it("renders a green pip when the assistant terminal's agentState is directing", () => {
    setHelpPanel({ isOpen: false, terminalId: "t-2d" });
    setPanel("t-2d", "directing");

    const { queryByTestId, container } = render(<ToolbarAssistantButton />);
    const pip = queryByTestId("assistant-working-pip");
    expect(pip?.getAttribute("data-visible")).toBe("true");
    expect(pip!.className).toMatch(/bg-state-working/);
    expect(pip!.getAttribute("data-agent-state")).toBe("directing");
    // Coarse-signal design: directing intentionally surfaces as "working" in
    // the toolbar tooltip — both signal "something is in flight" without
    // proliferating tooltip variants.
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Daintree Assistant — Assistant is working"
    );
  });

  it("renders a yellow pip when the assistant terminal's agentState is waiting", () => {
    setHelpPanel({ isOpen: false, terminalId: "t-w" });
    setPanel("t-w", "waiting");

    const { queryByTestId } = render(<ToolbarAssistantButton />);
    const pip = queryByTestId("assistant-working-pip");
    expect(pip?.getAttribute("data-visible")).toBe("true");
    expect(pip!.className).toMatch(/bg-state-waiting/);
    expect(pip!.className).not.toMatch(/animate-pulse/);
    expect(pip!.getAttribute("data-agent-state")).toBe("waiting");
  });

  it("does not render the pip for completed or exited states", () => {
    setHelpPanel({ isOpen: false, terminalId: "t-c" });
    setPanel("t-c", "completed");
    const { queryByTestId, rerender } = render(<ToolbarAssistantButton />);
    expect(queryByTestId("assistant-working-pip")?.getAttribute("data-visible")).toBe("false");

    act(() => {
      setPanel("t-c", "exited");
    });
    rerender(<ToolbarAssistantButton />);
    expect(queryByTestId("assistant-working-pip")?.getAttribute("data-visible")).toBe("false");
  });

  it("does not render the pip when there is no assistant terminal", () => {
    setHelpPanel({ isOpen: false, terminalId: null });

    const { queryByTestId } = render(<ToolbarAssistantButton />);
    expect(queryByTestId("assistant-working-pip")?.getAttribute("data-visible")).toBe("false");
  });

  it("hides the pip when the panel is open (the user can already see the state)", () => {
    setHelpPanel({ isOpen: true, terminalId: "t-3" });
    setPanel("t-3", "working");

    const { queryByTestId } = render(<ToolbarAssistantButton />);
    expect(queryByTestId("assistant-working-pip")?.getAttribute("data-visible")).toBe("false");
  });

  it("hides the pip when the panel is open even for waiting state", () => {
    setHelpPanel({ isOpen: true, terminalId: "t-3w" });
    setPanel("t-3w", "waiting");

    const { queryByTestId } = render(<ToolbarAssistantButton />);
    expect(queryByTestId("assistant-working-pip")?.getAttribute("data-visible")).toBe("false");
  });

  it("MCP-health failed pip takes precedence over the agent pip when both would apply", () => {
    mcpReadinessMock.mockReturnValue({
      state: "failed",
      port: 0,
      lastError: "oops",
    });
    setHelpPanel({ isOpen: false, terminalId: "t-4" });
    setPanel("t-4", "working");

    const { container, queryByTestId } = render(<ToolbarAssistantButton />);
    const pip = queryByTestId("assistant-working-pip");
    expect(pip?.getAttribute("data-visible")).toBe("true");
    expect(pip!.className).toMatch(/bg-status-danger/);
    expect(pip!.className).not.toMatch(/bg-state-/);
    expect(container.querySelector(".bg-status-danger")).not.toBeNull();
  });

  it("MCP-health starting pip takes precedence over a waiting agent pip", () => {
    mcpReadinessMock.mockReturnValue({
      state: "starting",
      port: 0,
      lastError: null,
    });
    setHelpPanel({ isOpen: false, terminalId: "t-4w" });
    setPanel("t-4w", "waiting");

    const { container, queryByTestId } = render(<ToolbarAssistantButton />);
    const pip = queryByTestId("assistant-working-pip");
    expect(pip?.getAttribute("data-visible")).toBe("true");
    expect(pip!.className).toMatch(/bg-status-warning/);
    // `starting` is the delayed (pulsing) MCP state — preserved through the
    // always-in-DOM conversion.
    expect(pip!.className).toMatch(/animate-pulse-delayed/);
    expect(container.querySelector(".bg-status-warning")).not.toBeNull();
  });

  it("acknowledges the current state on open; pip stays hidden after close if state has not changed", () => {
    setHelpPanel({ isOpen: false, terminalId: "t-ack" });
    setPanel("t-ack", "working");

    const { queryByTestId } = render(<ToolbarAssistantButton />);
    expect(queryByTestId("assistant-working-pip")).not.toBeNull();

    // Opening the panel marks the current state as read.
    act(() => {
      useHelpPanelStore.setState({ isOpen: true });
    });
    expect(queryByTestId("assistant-working-pip")?.getAttribute("data-visible")).toBe("false");

    // Closing without a state change leaves the pip suppressed.
    act(() => {
      useHelpPanelStore.setState({ isOpen: false });
    });
    expect(queryByTestId("assistant-working-pip")?.getAttribute("data-visible")).toBe("false");
  });

  it("re-shows the pip after acknowledgement when the agent state changes again", () => {
    setHelpPanel({ isOpen: false, terminalId: "t-ack2" });
    setPanel("t-ack2", "working");

    const { queryByTestId } = render(<ToolbarAssistantButton />);
    act(() => useHelpPanelStore.setState({ isOpen: true }));
    act(() => useHelpPanelStore.setState({ isOpen: false }));
    expect(queryByTestId("assistant-working-pip")?.getAttribute("data-visible")).toBe("false");

    act(() => {
      setPanel("t-ack2", "waiting");
    });
    const pip = queryByTestId("assistant-working-pip");
    expect(pip?.getAttribute("data-visible")).toBe("true");
    expect(pip!.className).toMatch(/bg-state-waiting/);
  });

  it("treats a re-spawned assistant terminal as unread even if the new state matches the previously-seen value", () => {
    setHelpPanel({ isOpen: false, terminalId: "t-old" });
    setPanel("t-old", "waiting");

    const { queryByTestId } = render(<ToolbarAssistantButton />);
    // Acknowledge "waiting" on the old terminal.
    act(() => useHelpPanelStore.setState({ isOpen: true }));
    act(() => useHelpPanelStore.setState({ isOpen: false }));
    expect(queryByTestId("assistant-working-pip")?.getAttribute("data-visible")).toBe("false");

    // Respawn: a brand-new assistant terminal lands on the same state value.
    // The user has not seen *this* session, so the pip should fire.
    act(() => {
      setPanel("t-new", "waiting");
      useHelpPanelStore.setState({ sessions: { 0: { ...emptyLane(), terminalId: "t-new" } } });
    });
    const pip = queryByTestId("assistant-working-pip");
    expect(pip?.getAttribute("data-visible")).toBe("true");
    expect(pip!.className).toMatch(/bg-state-waiting/);
  });

  it("tracks state changes that happen while the panel is open as already seen", () => {
    setHelpPanel({ isOpen: true, terminalId: "t-ack3" });
    setPanel("t-ack3", "working");

    const { queryByTestId } = render(<ToolbarAssistantButton />);
    expect(queryByTestId("assistant-working-pip")?.getAttribute("data-visible")).toBe("false");

    // State changes while panel is open — user can already see it via the
    // panel header, so closing afterwards must not flash the pip.
    act(() => {
      setPanel("t-ack3", "waiting");
    });
    act(() => {
      useHelpPanelStore.setState({ isOpen: false });
    });
    expect(queryByTestId("assistant-working-pip")?.getAttribute("data-visible")).toBe("false");
  });

  describe("gesture-hidden desync", () => {
    // The toolbar button's highlighted state must mirror the panel's *actual*
    // visibility — `!gestureAssistantHidden && helpPanelOpen` — not just
    // `helpPanelStore.isOpen`. The focus-mode gesture can collapse the panel
    // without flipping isOpen, and the button must stop reading as pressed
    // and resume showing the pip in that case.

    it("renders aria-pressed=false when the panel is open but gesture-hidden", () => {
      mockGestureAssistantHidden = true;
      setHelpPanel({ isOpen: true, terminalId: "t-gh-1" });
      setPanel("t-gh-1", "idle");

      const { container } = render(<ToolbarAssistantButton />);
      expect(container.querySelector("button")?.getAttribute("aria-pressed")).toBe("false");
    });

    it("renders aria-pressed=true when isOpen and the gesture is not hiding the panel", () => {
      mockGestureAssistantHidden = false;
      setHelpPanel({ isOpen: true, terminalId: "t-gh-2" });
      setPanel("t-gh-2", "idle");

      const { container } = render(<ToolbarAssistantButton />);
      expect(container.querySelector("button")?.getAttribute("aria-pressed")).toBe("true");
    });

    it("renders aria-pressed=false when isOpen=false regardless of gesture", () => {
      mockGestureAssistantHidden = true;
      setHelpPanel({ isOpen: false, terminalId: null });

      const { container } = render(<ToolbarAssistantButton />);
      expect(container.querySelector("button")?.getAttribute("aria-pressed")).toBe("false");
    });

    it("shows the agent pip when the panel is gesture-hidden even if isOpen=true", () => {
      // The lastSeenMarker effect is gated on isVisible (not isOpen) for the
      // same reason: while the panel is gesture-hidden the user can't see
      // the assistant header, so state transitions during that window must
      // remain unread. Because isVisible=false here the effect does not
      // advance the marker, isAcknowledged stays false, and the pip surfaces
      // through every state change while the gesture holds.
      mockGestureAssistantHidden = true;
      setHelpPanel({ isOpen: true, terminalId: "t-gh-3" });
      setPanel("t-gh-3", "working");

      const { queryByTestId } = render(<ToolbarAssistantButton />);
      const pip = queryByTestId("assistant-working-pip");
      expect(pip?.getAttribute("data-visible")).toBe("true");
      expect(pip!.className).toMatch(/bg-state-working/);

      // Agent transitions while gesture-hidden — pip tracks the new state
      // because the marker was never advanced.
      act(() => {
        setPanel("t-gh-3", "waiting");
      });
      const pip2 = queryByTestId("assistant-working-pip");
      expect(pip2?.getAttribute("data-visible")).toBe("true");
      expect(pip2!.className).toMatch(/bg-state-waiting/);
    });

    it("click reveals the panel without toggling isOpen when gesture-hidden", () => {
      // Button labelled "Open" must actually open. Clearing the gesture
      // already restores visibility; calling toggle() on top would flip
      // isOpen to false and re-hide what the user just asked to reveal.
      mockGestureAssistantHidden = true;
      setHelpPanel({ isOpen: true, terminalId: "t-gh-click-1" });

      const { container } = render(<ToolbarAssistantButton />);
      fireEvent.click(container.querySelector("button")!);

      expect(clearAssistantGestureMock).toHaveBeenCalledTimes(1);
      expect(useHelpPanelStore.getState().isOpen).toBe(true);
      expect(mockGestureAssistantHidden).toBe(false);
    });

    it("click toggles isOpen when the panel is visible (no gesture)", () => {
      mockGestureAssistantHidden = false;
      setHelpPanel({ isOpen: true, terminalId: "t-gh-click-2" });

      const { container } = render(<ToolbarAssistantButton />);
      fireEvent.click(container.querySelector("button")!);

      expect(clearAssistantGestureMock).toHaveBeenCalledTimes(1);
      expect(useHelpPanelStore.getState().isOpen).toBe(false);
    });

    it("click opens the panel when isOpen=false regardless of gesture flag", () => {
      mockGestureAssistantHidden = false;
      setHelpPanel({ isOpen: false, terminalId: null });

      const { container } = render(<ToolbarAssistantButton />);
      fireEvent.click(container.querySelector("button")!);

      expect(useHelpPanelStore.getState().isOpen).toBe(true);
    });
  });

  it("re-renders when agentState transitions through working → waiting → idle", () => {
    setHelpPanel({ isOpen: false, terminalId: "t-5" });
    setPanel("t-5", "working");

    const { queryByTestId } = render(<ToolbarAssistantButton />);
    let pip = queryByTestId("assistant-working-pip");
    expect(pip?.getAttribute("data-visible")).toBe("true");
    expect(pip!.className).toMatch(/bg-state-working/);

    act(() => {
      setPanel("t-5", "waiting");
    });

    pip = queryByTestId("assistant-working-pip");
    expect(pip?.getAttribute("data-visible")).toBe("true");
    expect(pip!.className).toMatch(/bg-state-waiting/);

    act(() => {
      setPanel("t-5", "idle");
    });

    expect(queryByTestId("assistant-working-pip")?.getAttribute("data-visible")).toBe("false");
  });
});

describe("ToolbarAssistantButton — MCP anomaly pip (#10022)", () => {
  beforeEach(() => {
    mcpReadinessMock.mockReturnValue({ enabled: true, state: "ready", port: 0, lastError: null });
    useHelpPanelStore.setState({ isOpen: false, sessions: { 0: emptyLane() }, activeSlot: 0 });
    usePanelStore.setState({ panelsById: {}, panelIds: [] } as never);
    mockGestureAssistantHidden = false;
    __resetMcpAnomalyStoreForTesting();
  });

  it("shows a warning pip when an anomaly is set and no other pip applies", () => {
    setHelpPanel({ isOpen: false, terminalId: null });
    act(() => {
      useMcpAnomalyStore.setState({ hasAnomaly: true, anomalyCount: 2 });
    });

    const { container, queryByTestId } = render(<ToolbarAssistantButton />);
    const pip = queryByTestId("assistant-working-pip");
    expect(pip?.getAttribute("data-visible")).toBe("true");
    expect(pip!.className).toMatch(/bg-status-warning/);
    expect(pip!.className).not.toMatch(/animate-pulse/);
    expect(pip!.className).not.toMatch(/accent/);
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Daintree Assistant — MCP anomaly signals detected"
    );
  });

  it("stays visible even when the panel is open (unlike the agent pip)", () => {
    setHelpPanel({ isOpen: true, terminalId: null });
    act(() => {
      useMcpAnomalyStore.setState({ hasAnomaly: true, anomalyCount: 1 });
    });

    const { queryByTestId } = render(<ToolbarAssistantButton />);
    const pip = queryByTestId("assistant-working-pip");
    expect(pip?.getAttribute("data-visible")).toBe("true");
    expect(pip!.className).toMatch(/bg-status-warning/);
  });

  it("is suppressed by the MCP-failed pip", () => {
    mcpReadinessMock.mockReturnValue({ state: "failed", port: 0, lastError: "oops" } as never);
    setHelpPanel({ isOpen: false, terminalId: null });
    act(() => {
      useMcpAnomalyStore.setState({ hasAnomaly: true, anomalyCount: 1 });
    });

    const { queryByTestId } = render(<ToolbarAssistantButton />);
    const pip = queryByTestId("assistant-working-pip");
    expect(pip!.className).toMatch(/bg-status-danger/);
    expect(pip!.className).not.toMatch(/bg-status-warning/);
  });

  it("is suppressed by the MCP-starting pip", () => {
    mcpReadinessMock.mockReturnValue({ state: "starting", port: 0, lastError: null } as never);
    setHelpPanel({ isOpen: false, terminalId: null });
    act(() => {
      useMcpAnomalyStore.setState({ hasAnomaly: true, anomalyCount: 1 });
    });

    const { queryByTestId } = render(<ToolbarAssistantButton />);
    const pip = queryByTestId("assistant-working-pip");
    expect(pip!.className).toMatch(/bg-status-warning/);
    // The starting pip pulses; the anomaly pip never does — proves which one won.
    expect(pip!.className).toMatch(/animate-pulse-delayed/);
  });

  it("is suppressed by an active agent pip", () => {
    setHelpPanel({ isOpen: false, terminalId: "t-anom" });
    setPanel("t-anom", "working");
    act(() => {
      useMcpAnomalyStore.setState({ hasAnomaly: true, anomalyCount: 1 });
    });

    const { queryByTestId } = render(<ToolbarAssistantButton />);
    const pip = queryByTestId("assistant-working-pip");
    expect(pip!.className).toMatch(/bg-state-working/);
    expect(pip!.className).not.toMatch(/bg-status-warning/);
  });

  it("does not show a pip when there is no anomaly", () => {
    setHelpPanel({ isOpen: false, terminalId: null });

    const { queryByTestId } = render(<ToolbarAssistantButton />);
    expect(queryByTestId("assistant-working-pip")?.getAttribute("data-visible")).toBe("false");
  });
});
