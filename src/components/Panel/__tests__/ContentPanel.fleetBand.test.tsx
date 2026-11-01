// @vitest-environment jsdom
/**
 * Amber on a pane is the fleet band's `needs-you` and nothing else (#16056):
 * an unread Canopy ask. This renders the real chrome derivation, display-state
 * fold, header indicator and error-wait debounce, and drives the band through
 * the fleet snapshot the way main delivers it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import type { AgentState, WaitingReason } from "@shared/types/agent";
import type { FleetRunRow, FleetSnapshot, RunCanopyRefinement } from "@shared/types/ipc/fleet";
import {
  cleanupFleetSnapshotListeners,
  setupFleetSnapshotListeners,
  useFleetSnapshotStore,
} from "@/store/fleetSnapshotStore";

vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: new Map() }),
  useWorktreeStoreOptional: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: new Map() }),
}));

vi.mock("@/hooks/useWorktreeColorMap", () => ({
  useWorktreeColorMap: () => undefined,
}));

vi.mock("@/components/DragDrop", () => ({
  useIsDragging: () => false,
}));

vi.mock("@/components/Terminal/SubagentChip", () => ({
  SubagentChip: () => null,
}));

const mockState = {
  showGridAgentHighlights: false,
  panel: {} as Record<string, unknown>,
};

vi.mock("@/store", () => ({
  usePreferencesStore: (
    selector: (s: { showGridAgentHighlights: boolean; showAgentTaskTitles: boolean }) => unknown
  ) =>
    selector({
      showGridAgentHighlights: mockState.showGridAgentHighlights,
      showAgentTaskTitles: true,
    }),
  usePanelStore: (selector: (s: { panelsById: Record<string, unknown> }) => unknown) =>
    selector({ panelsById: { "t-1": { id: "t-1", kind: "terminal", ...mockState.panel } } }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

import { ContentPanel } from "../ContentPanel";

const UNREAD_ASK: RunCanopyRefinement = {
  kind: "asked",
  quote: "Run the migration?",
  readAt: 0,
  seen: false,
};

function snapshot(overrides: Partial<FleetRunRow>): FleetSnapshot {
  return {
    runs: [{ runId: "t-1", workspaceId: "p1", spawnedAt: 0, cwd: "/repo", ...overrides }],
    changedAt: 0,
    degraded: false,
    lastSuccessfulAt: null,
  };
}

function fleet(overrides: Partial<FleetRunRow>) {
  act(() => useFleetSnapshotStore.setState({ snapshot: snapshot(overrides) }));
}

/** The pane's own observation, as the panel store holds it. */
function observe(agentState: AgentState, waitingReason?: WaitingReason, extra = {}) {
  mockState.panel = { agentState, waitingReason, ...extra };
}

interface PaneProps {
  agentState?: AgentState;
  isFocused?: boolean;
  isExited?: boolean;
  exitCode?: number | null;
  ambientAgentState?: AgentState;
}

function pane({ isFocused = false, ...props }: PaneProps = {}) {
  return (
    <ContentPanel
      id="t-1"
      title="Claude"
      kind="terminal"
      agentId="claude"
      isFocused={isFocused}
      isMultiPanelGrid
      onFocus={() => {}}
      onClose={() => {}}
      onToggleMaximize={() => {}}
      {...props}
    >
      <div data-testid="panel-body" />
    </ContentPanel>
  );
}

const frame = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-panel-id="t-1"]')!;
const hasEdge = (container: HTMLElement, state: string) =>
  frame(container).classList.contains(`panel-state-${state}`);
const glyph = () =>
  screen
    .queryAllByRole("status")
    .find((el) => (el.getAttribute("aria-label") ?? "").startsWith("Agent state:"));
const glyphLabel = () => glyph()?.getAttribute("aria-label") ?? null;

/** Past the error wait's debounce, so nothing amber can still be on its way. */
function settle() {
  act(() => {
    vi.advanceTimersByTime(1_000);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mockState.showGridAgentHighlights = false;
  mockState.panel = {};
  useFleetSnapshotStore.setState({ snapshot: null });
});

afterEach(() => {
  cleanup();
  cleanupFleetSnapshotListeners();
  useFleetSnapshotStore.setState({ snapshot: null });
  delete window.__DAINTREE_HOST_ID__;
  vi.useRealTimers();
});

describe("ContentPanel amber from the fleet band", () => {
  it.each([
    ["on this machine", undefined],
    ["in a remote host's view", { id: "host-1" }],
  ])("draws no amber for an agent at its prompt with no Canopy reading %s", (_label, host) => {
    // A remote project's view reaches the host's fleet over the same channels;
    // the snapshot it holds is the host's, matched to panes by terminal id.
    if (host) window.__DAINTREE_HOST_ID__ = host;
    let push: ((snapshot: FleetSnapshot) => void) | undefined;
    const hostFleet = snapshot({ agentState: "waiting", waitingReason: "prompt" });
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: {
        fleet: {
          onSnapshotUpdated: (cb: (s: FleetSnapshot) => void) => {
            push = cb;
            return () => {};
          },
          getSnapshot: () => Promise.resolve(hostFleet),
        },
      },
    });
    observe("waiting", "prompt");
    setupFleetSnapshotListeners();
    act(() => push?.(hostFleet));

    const { container } = render(pane({ agentState: "waiting" }));
    settle();

    expect(hasEdge(container, "waiting")).toBe(false);
    expect(glyph()).toBeUndefined();
    // The observation itself is still reported as seen.
    expect(frame(container).getAttribute("data-agent-state")).toBe("waiting");

    // The same view lights up for an ask the host's Canopy read.
    act(() =>
      push?.(snapshot({ agentState: "waiting", waitingReason: "prompt", canopy: UNREAD_ASK }))
    );
    expect(hasEdge(container, "waiting")).toBe(true);
    expect(glyphLabel()).toMatch(/^Agent state: waiting/);
  });

  it("draws the unread mark, not the edge, for an unread hand-back", () => {
    observe("completed");
    fleet({ agentState: "completed", handBack: { stoppedAt: 0 } });
    const { container } = render(pane({ agentState: "completed" }));
    settle();

    expect(hasEdge(container, "waiting")).toBe(false);
    expect(glyphLabel()).toBe("Agent state: unread");
  });

  it("draws the edge and ring for an unread ask, and takes both away once it is seen", () => {
    observe("waiting", "question");
    fleet({ agentState: "waiting", waitingReason: "question", canopy: UNREAD_ASK });
    const { container, rerender } = render(pane({ agentState: "waiting" }));

    expect(hasEdge(container, "waiting")).toBe(true);
    expect(glyphLabel()).toBe("Agent state: waiting (question)");

    // Focus alone answers nothing: the edge keeps over the selected fill.
    rerender(pane({ agentState: "waiting", isFocused: true }));
    expect(hasEdge(container, "waiting")).toBe(true);
    expect(frame(container).classList.contains("terminal-selected")).toBe(true);

    // Canopy's read mark for the turn is what clears it, everywhere at once.
    fleet({
      agentState: "waiting",
      waitingReason: "question",
      canopy: { ...UNREAD_ASK, seen: true },
    });
    expect(hasEdge(container, "waiting")).toBe(false);
    expect(glyph()).toBeUndefined();

    // A new ask is a new turn, unread again.
    fleet({
      agentState: "waiting",
      waitingReason: "question",
      canopy: { ...UNREAD_ASK, readAt: 9 },
    });
    expect(hasEdge(container, "waiting")).toBe(true);
  });

  it("reads a Canopy ask on a finished turn as amber", () => {
    observe("completed");
    fleet({ agentState: "completed", handBack: { stoppedAt: 0, seenAt: 1 }, canopy: UNREAD_ASK });
    const { container } = render(pane({ agentState: "completed" }));

    expect(hasEdge(container, "waiting")).toBe(true);
    expect(glyphLabel()).toBe("Agent state: waiting");
  });

  it("draws no amber before the fleet snapshot arrives, then follows it", () => {
    observe("waiting", "approval");
    const { container } = render(pane({ agentState: "waiting" }));
    settle();

    expect(hasEdge(container, "waiting")).toBe(false);
    expect(glyph()).toBeUndefined();

    fleet({ agentState: "waiting", waitingReason: "approval", canopy: UNREAD_ASK });
    expect(hasEdge(container, "waiting")).toBe(true);
  });

  it("lets the pane's own newer observation end the amber before the band catches up", () => {
    fleet({ agentState: "waiting", waitingReason: "question", canopy: UNREAD_ASK });
    observe("working");
    mockState.showGridAgentHighlights = true;
    const { container } = render(pane({ agentState: "working" }));

    expect(hasEdge(container, "waiting")).toBe(false);
    expect(hasEdge(container, "working")).toBe(true);

    observe("waiting", "question", { isRestarting: true });
    const restarting = render(pane({ agentState: "waiting" }));
    expect(hasEdge(restarting.container, "waiting")).toBe(false);
  });

  it("raises the edge for a hidden tab's ask even while the shown tab sits at its prompt", () => {
    observe("waiting", "prompt");
    fleet({ agentState: "waiting", waitingReason: "prompt" });
    const { container } = render(pane({ agentState: "waiting", ambientAgentState: "waiting" }));

    expect(hasEdge(container, "waiting")).toBe(true);
    // The shown tab's own glyph keeps to its own band.
    expect(glyph()).toBeUndefined();
  });

  it("keeps the failed edge for an error wait, with the blocked mark in place of the ring", () => {
    observe("waiting", "error");
    fleet({ agentState: "waiting", waitingReason: "error" });
    const { container } = render(pane({ agentState: "waiting" }));

    // The error edge keeps its debounce.
    expect(hasEdge(container, "failed")).toBe(false);
    settle();
    expect(hasEdge(container, "failed")).toBe(true);
    expect(hasEdge(container, "waiting")).toBe(false);
    expect(glyphLabel()).toBe("Agent state: blocked (error)");
  });

  it("keeps the failed edge for a failed exit", () => {
    observe("exited", undefined, { exitCode: 1 });
    fleet({ agentState: "exited" });
    const { container } = render(pane({ agentState: "exited", isExited: true, exitCode: 1 }));

    expect(hasEdge(container, "failed")).toBe(true);
  });

  it("keeps the working edge behind the highlights setting", () => {
    observe("working");
    fleet({ agentState: "working" });
    const off = render(pane({ agentState: "working" }));
    expect(hasEdge(off.container, "working")).toBe(false);
    off.unmount();

    mockState.showGridAgentHighlights = true;
    const on = render(pane({ agentState: "working" }));
    expect(hasEdge(on.container, "working")).toBe(true);
  });
});
