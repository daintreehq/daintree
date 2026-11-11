// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { FleetRunRow, FleetSnapshot } from "@shared/types/ipc/fleet";
import { usePanelStore } from "@/store/panelStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import type { PtyPanelData } from "@shared/types/panel";
import { bandForRun, type FleetBand } from "@/lib/fleetAttention";
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

    it("counts an approval wait by its band: waiting for an unread ask, unread without one", () => {
      // Bands as the fleet places these runs, over a hand-back already read.
      const approval = {
        agentState: "waiting",
        waitingReason: "approval",
        handBack: { stoppedAt: 1, seenAt: 2 },
      } as const;
      const bands = new Map<string, FleetBand>([
        [
          "asked",
          bandForRun({
            ...approval,
            canopy: { kind: "asked", quote: "Run it?", readAt: 3, seen: false },
          }),
        ],
        ["guessed", bandForRun(approval)],
      ]);
      const asked = aggregateAgentStates([agent("asked", { waitingReason: "approval" })], (id) =>
        bands.get(id)
      );
      expect(asked.byState.waiting).toBe(1);
      expect(asked.byState.completed).toBe(0);
      expect(asked.unread).toBe(0);
      expect(asked.blocked).toBe(0);

      const guessed = aggregateAgentStates(
        [agent("guessed", { waitingReason: "approval" })],
        (id) => bands.get(id)
      );
      expect(guessed.unread).toBe(1);
      expect(guessed.byState.waiting).toBe(0);
      expect(guessed.byState.completed).toBe(0);
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

  describe("useWorktreeTerminals under streaming panel patches (#16800)", () => {
    afterEach(() => {
      usePanelStore.setState({ panelsById: {}, panelIdsByWorktreeId: {} });
      useFleetSnapshotStore.setState({ snapshot: null });
      vi.useRealTimers();
    });

    const seed = (panels: PtyPanelData[]) => {
      const panelsById: Record<string, PtyPanelData> = {};
      const panelIdsByWorktreeId: Record<string, string[]> = {};
      for (const panel of panels) {
        panelsById[panel.id] = panel;
        const key = panel.worktreeId ?? "__none__";
        (panelIdsByWorktreeId[key] ??= []).push(panel.id);
      }
      usePanelStore.setState({ panelsById, panelIdsByWorktreeId });
    };

    // Patches a panel the way the status buffer does: a fresh object in a
    // fresh `panelsById`, with every bucket array left as it was.
    const patch = (id: string, fields: Partial<PtyPanelData>) =>
      act(() => {
        usePanelStore.setState((state) => ({
          panelsById: {
            ...state.panelsById,
            [id]: { ...(state.panelsById[id] as PtyPanelData), ...fields },
          },
        }));
      });

    const advance = (ms: number) =>
      act(() => {
        vi.advanceTimersByTime(ms);
      });

    it("lands a count change within the debounce while a sibling streams patches", () => {
      vi.useFakeTimers();
      seed([
        term({ id: "agent", worktreeId: "wt-s", agentState: "working" }),
        term({ id: "streamer", worktreeId: "wt-s" }),
      ]);
      const { result } = renderHook(() => useWorktreeTerminals("wt-s"));
      expect(result.current.counts.byState.working).toBe(1);

      patch("agent", { agentState: "idle" });
      advance(100);
      patch("streamer", { activityHeadline: "line 1" });
      advance(100);
      patch("streamer", { activityHeadline: "line 2" });
      advance(49);
      expect(result.current.counts.byState.working).toBe(1);

      advance(1);
      expect(result.current.counts.byState.working).toBe(0);
      expect(result.current.counts.byState.idle).toBe(2);

      // The stream carrying on neither republishes nor rebuilds the counts.
      const landed = result.current.counts;
      for (let i = 3; i < 7; i++) {
        patch("streamer", { activityHeadline: `line ${i}` });
        advance(100);
      }
      expect(result.current.counts).toBe(landed);
    });

    it("keeps the counts object through a change that reverts before it lands", () => {
      vi.useFakeTimers();
      seed([term({ id: "a", worktreeId: "wt-s", agentState: "working" })]);
      const { result } = renderHook(() => useWorktreeTerminals("wt-s"));
      const before = result.current.counts;

      patch("a", { agentState: "idle" });
      advance(100);
      patch("a", { agentState: "working" });
      advance(300);

      expect(result.current.counts).toBe(before);
    });

    it("keeps the counts object when a patch leaves every count unchanged", () => {
      vi.useFakeTimers();
      seed([
        term({ id: "a", worktreeId: "wt-s", agentState: "working" }),
        term({ id: "b", worktreeId: "wt-s" }),
      ]);
      const { result } = renderHook(() => useWorktreeTerminals("wt-s"));
      const before = result.current;

      patch("b", { activityHeadline: "compiling" });
      advance(300);

      // The panel changed, so the list carries it; the counts did not.
      expect(result.current.terminals).not.toBe(before.terminals);
      expect(result.current.terminals[1]?.activityHeadline).toBe("compiling");
      expect(result.current.counts).toBe(before.counts);
    });

    it("hands back a fresh counts object once a count does change", () => {
      vi.useFakeTimers();
      seed([term({ id: "a", worktreeId: "wt-s", agentState: "working" })]);
      const { result } = renderHook(() => useWorktreeTerminals("wt-s"));
      const before = result.current.counts;

      patch("a", { agentState: "idle" });
      advance(300);

      expect(result.current.counts).not.toBe(before);
      expect(result.current.counts.byState.idle).toBe(1);
      expect(before.byState.working).toBe(1);
    });

    it("neither re-renders nor rebuilds anything when another worktree's panel streams", () => {
      vi.useFakeTimers();
      seed([
        term({ id: "mine", worktreeId: "wt-s", agentState: "working" }),
        term({ id: "theirs", worktreeId: "wt-other" }),
      ]);
      let renders = 0;
      const { result } = renderHook(() => {
        renders += 1;
        return useWorktreeTerminals("wt-s");
      });
      const before = result.current;
      const rendersBefore = renders;

      for (let i = 0; i < 3; i++) {
        patch("theirs", { activityHeadline: `line ${i}` });
        advance(100);
      }

      expect(renders).toBe(rendersBefore);
      expect(result.current.terminals).toBe(before.terminals);
      expect(result.current.counts).toBe(before.counts);
    });
  });
});
