// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { FleetRunRow, FleetSnapshot } from "@shared/types/ipc/fleet";
import { usePanelStore } from "@/store/panelStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import type { PtyPanelData } from "@shared/types/panel";
import type { FleetBand } from "@/lib/fleetAttention";
import { aggregateAgentStates, useWorktreeTerminals } from "../useWorktreeTerminals";

// #6650 — Active agentState (working/waiting/directing) credited to counts
// even when agent identity hasn't committed yet, so collapsed worktree badges
// surface live progress instead of staying idle until detection lands.
describe("aggregateAgentStates (#6650)", () => {
  function term(overrides: Partial<PtyPanelData>): PtyPanelData {
    return {
      id: "t-" + Math.random().toString(36).slice(2),
      kind: "terminal" as const,
      worktreeId: "wt-1",
      title: "T",
      cwd: "/x",
      cols: 80,
      rows: 24,
      location: "grid",
      ...overrides,
    } as PtyPanelData;
  }

  it("counts a working terminal toward byState.working even with no agent identity", () => {
    const { byState, agentStates } = aggregateAgentStates([term({ agentState: "working" })]);
    expect(byState.working).toBe(1);
    expect(byState.idle).toBe(0);
    expect(agentStates).toEqual(["working"]);
  });

  it("does NOT credit completed for an identity-less terminal (no stale signal)", () => {
    const { byState, agentStates } = aggregateAgentStates([term({ agentState: "completed" })]);
    expect(byState.completed).toBe(0);
    expect(byState.idle).toBe(1);
    expect(agentStates).toEqual([]);
  });

  it("counts a live agent at its prompt as idle, not waiting, with no band behind it", () => {
    const { byState, agentStates } = aggregateAgentStates([
      term({ launchAgentId: "claude", agentState: "working" }),
      term({ launchAgentId: "claude", agentState: "completed" }),
      term({ launchAgentId: "claude", agentState: "idle" }),
      term({ launchAgentId: "claude", agentState: "waiting" }),
    ]);
    expect(byState.working).toBe(1);
    expect(byState.waiting).toBe(0);
    expect(byState.completed).toBe(0);
    expect(byState.idle).toBe(3);
    // The dominant state still reads the display state the badge smooths to.
    expect(agentStates).toEqual(["working", "waiting", "waiting", "waiting"]);
  });

  it("treats a plain shell with no agentState as idle", () => {
    const { byState, agentStates } = aggregateAgentStates([term({})]);
    expect(byState.idle).toBe(1);
    expect(agentStates).toEqual([]);
  });

  describe("fleet bands (#16057)", () => {
    const agent = (id: string, overrides: Partial<PtyPanelData> = {}) =>
      term({ id, launchAgentId: "claude", agentState: "waiting", ...overrides });

    it("counts done as completed, review apart as unread, and needs-you alone as waiting", () => {
      const bands = new Map<string, FleetBand>([
        ["done", "done"],
        ["review", "review"],
        ["ask", "needs-you"],
        ["prompt", "idle"],
      ]);
      const { byState, unread, blocked, agentStates } = aggregateAgentStates(
        [
          agent("done"),
          agent("review", { agentState: "completed" }),
          agent("ask"),
          agent("prompt"),
          agent("unreported"),
        ],
        (id) => bands.get(id)
      );
      expect(byState.completed).toBe(1);
      expect(unread).toBe(1);
      expect(byState.waiting).toBe(1);
      expect(byState.idle).toBe(2);
      expect(blocked).toBe(0);
      // The dominant state follows the observation, not the band.
      expect(agentStates).toEqual(["waiting", "waiting", "waiting", "waiting", "waiting"]);
    });

    it("counts an error wait as blocked, never as waiting", () => {
      const { byState, blocked } = aggregateAgentStates(
        [agent("a", { waitingReason: "error" })],
        () => "blocked"
      );
      expect(blocked).toBe(1);
      expect(byState.waiting).toBe(0);
    });

    it("drops an unread ask the pane has moved past before the band catches up", () => {
      const { byState } = aggregateAgentStates(
        [agent("restarting", { isRestarting: true }), agent("exited", { runtimeStatus: "exited" })],
        () => "needs-you"
      );
      expect(byState.waiting).toBe(0);
    });

    it("counts nothing as waiting or unread without a band", () => {
      const { byState, unread } = aggregateAgentStates([agent("a", { waitingReason: "approval" })]);
      expect(byState.waiting).toBe(0);
      expect(unread).toBe(0);
    });
  });

  describe("useWorktreeTerminals fleet band subscription", () => {
    afterEach(() => {
      usePanelStore.setState({ panelsById: {}, panelIdsByWorktreeId: {} });
      useFleetSnapshotStore.setState({ snapshot: null });
      vi.useRealTimers();
    });

    it("recounts when only the fleet snapshot changes", () => {
      vi.useFakeTimers();
      const panel = term({
        id: "hb-hook",
        worktreeId: "wt-hb",
        launchAgentId: "claude",
        agentState: "waiting",
      });
      usePanelStore.setState({
        panelsById: { [panel.id]: panel },
        panelIdsByWorktreeId: { "wt-hb": [panel.id] },
      });
      const setRun = (overrides: Partial<FleetRunRow>) =>
        act(() => {
          useFleetSnapshotStore.setState({
            snapshot: {
              runs: [
                {
                  runId: panel.id,
                  workspaceId: "p1",
                  spawnedAt: 0,
                  cwd: "/x",
                  agentState: "waiting",
                  ...overrides,
                },
              ],
              changedAt: 0,
              degraded: false,
              lastSuccessfulAt: null,
            } satisfies FleetSnapshot,
          });
        });
      // A second act: the debounce timer is only scheduled once the first
      // act has flushed the re-render's effects.
      const settle = () =>
        act(() => {
          vi.advanceTimersByTime(300);
        });

      const { result } = renderHook(() => useWorktreeTerminals("wt-hb"));
      // A prompt with no reading behind it is not waiting.
      expect(result.current.counts.byState.waiting).toBe(0);
      expect(result.current.counts.unread).toBe(0);

      setRun({ canopy: { kind: "asked", quote: "Run it?", readAt: 1, seen: false } });
      settle();
      expect(result.current.counts.byState.waiting).toBe(1);

      setRun({ handBack: { stoppedAt: 1 } });
      settle();
      expect(result.current.counts.unread).toBe(1);
      expect(result.current.counts.byState.waiting).toBe(0);

      setRun({ handBack: { stoppedAt: 1, seenAt: 2 } });
      settle();
      expect(result.current.counts.unread).toBe(0);
      expect(result.current.counts.byState.completed).toBe(1);
      // The dominant state follows the observation, not the read state.
      expect(result.current.dominantAgentState).toBe("waiting");
    });
  });
});
