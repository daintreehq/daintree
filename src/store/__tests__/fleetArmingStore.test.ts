import { describe, it, expect, beforeEach } from "vitest";
import { useFleetArmingStore, isFleetArmEligible } from "../fleetArmingStore";
import { usePanelStore } from "../panelStore";
import { useWorktreeSelectionStore } from "../worktreeStore";
import type { TerminalInstance } from "@shared/types";

function resetStore() {
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
  });
}

function makeAgentTerminal(
  id: string,
  overrides: Partial<TerminalInstance> = {}
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
    agentState: "idle",
    hasPty: true,
    ...(overrides as object),
  } as TerminalInstance;
}

function seedPanels(terminals: TerminalInstance[]): void {
  const panelsById: Record<string, TerminalInstance> = {};
  const panelIds: string[] = [];
  for (const t of terminals) {
    panelsById[t.id] = t;
    panelIds.push(t.id);
  }
  usePanelStore.setState({ panelsById, panelIds });
}

describe("fleetArmingStore", () => {
  beforeEach(() => {
    resetStore();
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    seedPanels([]);
  });

  describe("armId / disarmId / toggleId", () => {
    it("arms a single id and records order and last armed", () => {
      useFleetArmingStore.getState().armId("a");
      const s = useFleetArmingStore.getState();
      expect(s.armedIds.has("a")).toBe(true);
      expect(s.armOrder).toEqual(["a"]);
      expect(s.armOrderById).toEqual({ a: 1 });
      expect(s.lastArmedId).toBe("a");
    });

    it("is idempotent when arming the same id twice", () => {
      useFleetArmingStore.getState().armId("a");
      useFleetArmingStore.getState().armId("a");
      const s = useFleetArmingStore.getState();
      expect(s.armOrder).toEqual(["a"]);
      expect(s.armOrderById).toEqual({ a: 1 });
      expect(s.lastArmedId).toBe("a");
    });

    it("arms multiple ids in insertion order with 1-based badges", () => {
      const { armId } = useFleetArmingStore.getState();
      armId("a");
      armId("b");
      armId("c");
      const s = useFleetArmingStore.getState();
      expect(s.armOrder).toEqual(["a", "b", "c"]);
      expect(s.armOrderById).toEqual({ a: 1, b: 2, c: 3 });
    });

    it("disarms and renumbers badges", () => {
      const { armId, disarmId } = useFleetArmingStore.getState();
      armId("a");
      armId("b");
      armId("c");
      disarmId("b");
      const s = useFleetArmingStore.getState();
      expect(s.armOrder).toEqual(["a", "c"]);
      expect(s.armOrderById).toEqual({ a: 1, c: 2 });
      expect(s.armedIds.has("b")).toBe(false);
    });

    it("disarm of unknown id is a no-op", () => {
      useFleetArmingStore.getState().armId("a");
      useFleetArmingStore.getState().disarmId("nope");
      expect(useFleetArmingStore.getState().armOrder).toEqual(["a"]);
    });

    it("disarming lastArmedId moves lastArmedId to the previous entry", () => {
      const { armId, disarmId } = useFleetArmingStore.getState();
      armId("a");
      armId("b");
      disarmId("b");
      expect(useFleetArmingStore.getState().lastArmedId).toBe("a");
    });

    it("toggleId flips membership", () => {
      const { toggleId } = useFleetArmingStore.getState();
      toggleId("a");
      expect(useFleetArmingStore.getState().armedIds.has("a")).toBe(true);
      toggleId("a");
      expect(useFleetArmingStore.getState().armedIds.has("a")).toBe(false);
    });
  });

  describe("armIds (batch replace)", () => {
    it("replaces armed set and dedupes", () => {
      useFleetArmingStore.getState().armId("x");
      useFleetArmingStore.getState().armIds(["a", "b", "a", "c"]);
      const s = useFleetArmingStore.getState();
      expect(s.armOrder).toEqual(["a", "b", "c"]);
      expect(s.armedIds.has("x")).toBe(false);
      expect(s.lastArmedId).toBe("c");
    });

    it("empty batch clears the set", () => {
      useFleetArmingStore.getState().armId("a");
      useFleetArmingStore.getState().armIds([]);
      expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
      expect(useFleetArmingStore.getState().lastArmedId).toBeNull();
    });
  });

  describe("armByState", () => {
    beforeEach(() => {
      seedPanels([
        makeAgentTerminal("t1", { agentState: "working" }),
        makeAgentTerminal("t2", { agentState: "running" }),
        makeAgentTerminal("t3", { agentState: "waiting" }),
        makeAgentTerminal("t4", { agentState: "completed" }),
        makeAgentTerminal("t5", { agentState: "exited" }),
        makeAgentTerminal("t6", { agentState: "idle" }),
        makeAgentTerminal("t7", { agentState: "working", worktreeId: "wt-2" }),
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    });

    it("arms working+running for 'working' preset in current scope", () => {
      useFleetArmingStore.getState().armByState("working", "current", false);
      const s = useFleetArmingStore.getState();
      expect([...s.armedIds].sort()).toEqual(["t1", "t2"]);
    });

    it("arms only 'waiting' agents for 'waiting' preset", () => {
      useFleetArmingStore.getState().armByState("waiting", "current", false);
      expect([...useFleetArmingStore.getState().armedIds]).toEqual(["t3"]);
    });

    it("arms completed+exited for 'finished' preset", () => {
      useFleetArmingStore.getState().armByState("finished", "current", false);
      expect([...useFleetArmingStore.getState().armedIds].sort()).toEqual(["t4", "t5"]);
    });

    it("scope 'all' includes other worktrees", () => {
      useFleetArmingStore.getState().armByState("working", "all", false);
      expect([...useFleetArmingStore.getState().armedIds].sort()).toEqual(["t1", "t2", "t7"]);
    });

    it("extend=true unions with existing armed set", () => {
      useFleetArmingStore.getState().armId("t3");
      useFleetArmingStore.getState().armByState("working", "current", true);
      expect([...useFleetArmingStore.getState().armedIds].sort()).toEqual(["t1", "t2", "t3"]);
    });

    it("extend=true preserves lastArmedId when all matches are already armed", () => {
      // Arm t3 (waiting) as anchor, then arm both working matches
      useFleetArmingStore.getState().armId("t3");
      useFleetArmingStore.getState().armByState("working", "current", true);
      // lastArmedId moved to t2 (last newly added). Extend again with all
      // matches already armed — anchor must not slide.
      useFleetArmingStore.getState().armByState("working", "current", true);
      expect(useFleetArmingStore.getState().lastArmedId).toBe("t2");
    });

    it("excludes trash/background/hasPty=false panels", () => {
      seedPanels([
        makeAgentTerminal("t1", { agentState: "working" }),
        makeAgentTerminal("t2", { agentState: "working", location: "trash" }),
        makeAgentTerminal("t3", { agentState: "working", location: "background" }),
        makeAgentTerminal("t4", { agentState: "working", hasPty: false }),
      ]);
      useFleetArmingStore.getState().armByState("working", "current", false);
      expect([...useFleetArmingStore.getState().armedIds]).toEqual(["t1"]);
    });

    it("excludes non-agent panels", () => {
      seedPanels([
        makeAgentTerminal("a1", { agentState: "working" }),
        makeAgentTerminal("p1", { agentState: "working", kind: "terminal", agentId: undefined }),
      ]);
      useFleetArmingStore.getState().armByState("working", "current", false);
      expect([...useFleetArmingStore.getState().armedIds]).toEqual(["a1"]);
    });
  });

  describe("armAll", () => {
    it("arms all eligible in current worktree", () => {
      seedPanels([
        makeAgentTerminal("a1"),
        makeAgentTerminal("a2"),
        makeAgentTerminal("a3", { worktreeId: "wt-2" }),
      ]);
      useFleetArmingStore.getState().armAll("current");
      expect([...useFleetArmingStore.getState().armedIds].sort()).toEqual(["a1", "a2"]);
    });

    it("scope 'all' arms across worktrees", () => {
      seedPanels([makeAgentTerminal("a1"), makeAgentTerminal("a2", { worktreeId: "wt-2" })]);
      useFleetArmingStore.getState().armAll("all");
      expect([...useFleetArmingStore.getState().armedIds].sort()).toEqual(["a1", "a2"]);
    });

    it("includes plain terminals currently running a detected agent", () => {
      seedPanels([
        makeAgentTerminal("a1"),
        makeAgentTerminal("p1", {
          kind: "terminal",
          agentId: undefined,
          detectedAgentId: "claude",
        }),
        makeAgentTerminal("p2", {
          kind: "terminal",
          agentId: undefined,
          everDetectedAgent: true,
        }),
        makeAgentTerminal("p3", { kind: "terminal", agentId: undefined }),
      ]);
      useFleetArmingStore.getState().armAll("current");
      expect([...useFleetArmingStore.getState().armedIds].sort()).toEqual(["a1", "p1", "p2"]);
    });
  });

  describe("armMatchingFilter", () => {
    it("arms eligible agents only in the matching worktree set", () => {
      seedPanels([
        makeAgentTerminal("a1", { worktreeId: "wt-1" }),
        makeAgentTerminal("a2", { worktreeId: "wt-2" }),
        makeAgentTerminal("a3", { worktreeId: "wt-3" }),
      ]);
      useFleetArmingStore.getState().armMatchingFilter(["wt-1", "wt-3"]);
      expect([...useFleetArmingStore.getState().armedIds].sort()).toEqual(["a1", "a3"]);
    });

    it("skips ineligible panels even when worktree matches", () => {
      seedPanels([
        makeAgentTerminal("a1", { worktreeId: "wt-1" }),
        makeAgentTerminal("a2", { worktreeId: "wt-1", location: "trash" }),
        makeAgentTerminal("a3", { worktreeId: "wt-1", location: "background" }),
        makeAgentTerminal("a4", { worktreeId: "wt-1", hasPty: false }),
        makeAgentTerminal("a5", {
          worktreeId: "wt-1",
          kind: "terminal",
          agentId: undefined,
        }),
      ]);
      useFleetArmingStore.getState().armMatchingFilter(["wt-1"]);
      expect([...useFleetArmingStore.getState().armedIds]).toEqual(["a1"]);
    });

    it("empty worktreeIds is a no-op and preserves any prior armed set", () => {
      seedPanels([makeAgentTerminal("a1"), makeAgentTerminal("a2")]);
      useFleetArmingStore.getState().armIds(["a1", "a2"]);
      useFleetArmingStore.getState().armMatchingFilter([]);
      expect([...useFleetArmingStore.getState().armedIds].sort()).toEqual(["a1", "a2"]);
    });

    it("no eligible agents in matching worktrees preserves any prior armed set", () => {
      seedPanels([
        makeAgentTerminal("a1", { worktreeId: "wt-1" }),
        makeAgentTerminal("a2", { worktreeId: "wt-2" }),
      ]);
      useFleetArmingStore.getState().armIds(["a1", "a2"]);
      // wt-9 has no panels — the button must not clobber the user's selection
      useFleetArmingStore.getState().armMatchingFilter(["wt-9"]);
      expect([...useFleetArmingStore.getState().armedIds].sort()).toEqual(["a1", "a2"]);
    });

    it("no eligible agents and no prior selection leaves armed set empty", () => {
      seedPanels([makeAgentTerminal("a1", { worktreeId: "wt-1" })]);
      useFleetArmingStore.getState().armMatchingFilter(["wt-9"]);
      expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
    });

    it("replaces the existing armed set rather than merging", () => {
      seedPanels([
        makeAgentTerminal("a1", { worktreeId: "wt-1" }),
        makeAgentTerminal("a2", { worktreeId: "wt-2" }),
      ]);
      useFleetArmingStore.getState().armIds(["a2"]);
      useFleetArmingStore.getState().armMatchingFilter(["wt-1"]);
      expect([...useFleetArmingStore.getState().armedIds]).toEqual(["a1"]);
    });

    it("preserves panel iteration order, not worktreeIds input order", () => {
      seedPanels([
        makeAgentTerminal("a1", { worktreeId: "wt-1" }),
        makeAgentTerminal("a2", { worktreeId: "wt-2" }),
        makeAgentTerminal("a3", { worktreeId: "wt-1" }),
      ]);
      // Input worktree order is wt-2 then wt-1, but panel order is a1,a2,a3.
      // The armed list should follow panel order so badge numbers match
      // the sidebar's rendered sequence.
      useFleetArmingStore.getState().armMatchingFilter(["wt-2", "wt-1"]);
      const s = useFleetArmingStore.getState();
      expect(s.armOrder).toEqual(["a1", "a2", "a3"]);
      expect(s.lastArmedId).toBe("a3");
    });

    it("duplicate worktreeIds do not duplicate armed terminals", () => {
      seedPanels([
        makeAgentTerminal("a1", { worktreeId: "wt-1" }),
        makeAgentTerminal("a2", { worktreeId: "wt-1" }),
      ]);
      useFleetArmingStore.getState().armMatchingFilter(["wt-1", "wt-1", "wt-1"]);
      expect(useFleetArmingStore.getState().armOrder).toEqual(["a1", "a2"]);
    });

    it("includes plain terminals with runtime-detected agent identity", () => {
      seedPanels([
        makeAgentTerminal("a1", { worktreeId: "wt-1" }),
        makeAgentTerminal("p1", {
          worktreeId: "wt-1",
          kind: "terminal",
          agentId: undefined,
          detectedAgentId: "claude",
        }),
        makeAgentTerminal("p2", {
          worktreeId: "wt-1",
          kind: "terminal",
          agentId: undefined,
          everDetectedAgent: true,
        }),
      ]);
      useFleetArmingStore.getState().armMatchingFilter(["wt-1"]);
      expect([...useFleetArmingStore.getState().armedIds].sort()).toEqual(["a1", "p1", "p2"]);
    });

    it("is fully idempotent — repeated calls preserve armOrder, armOrderById, and lastArmedId", () => {
      seedPanels([
        makeAgentTerminal("a1", { worktreeId: "wt-1" }),
        makeAgentTerminal("a2", { worktreeId: "wt-1" }),
      ]);
      useFleetArmingStore.getState().armMatchingFilter(["wt-1"]);
      const first = useFleetArmingStore.getState();
      const firstOrder = [...first.armOrder];
      const firstById = { ...first.armOrderById };
      const firstLast = first.lastArmedId;
      useFleetArmingStore.getState().armMatchingFilter(["wt-1"]);
      const second = useFleetArmingStore.getState();
      expect(second.armOrder).toEqual(firstOrder);
      expect(second.armOrderById).toEqual(firstById);
      expect(second.lastArmedId).toBe(firstLast);
    });
  });

  describe("clear", () => {
    it("resets to empty state", () => {
      useFleetArmingStore.getState().armId("a");
      useFleetArmingStore.getState().armId("b");
      useFleetArmingStore.getState().clear();
      const s = useFleetArmingStore.getState();
      expect(s.armedIds.size).toBe(0);
      expect(s.armOrder).toEqual([]);
      expect(s.armOrderById).toEqual({});
      expect(s.lastArmedId).toBeNull();
    });

    it("is idempotent on repeated clear", () => {
      useFleetArmingStore.getState().clear();
      useFleetArmingStore.getState().clear();
      expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
    });
  });

  describe("prune", () => {
    it("drops ids not in validIds and renumbers badges", () => {
      useFleetArmingStore.getState().armIds(["a", "b", "c"]);
      useFleetArmingStore.getState().prune(new Set(["a", "c"]));
      const s = useFleetArmingStore.getState();
      expect(s.armOrder).toEqual(["a", "c"]);
      expect(s.armOrderById).toEqual({ a: 1, c: 2 });
    });

    it("preserves lastArmedId if it survives prune", () => {
      useFleetArmingStore.getState().armIds(["a", "b", "c"]);
      useFleetArmingStore.getState().prune(new Set(["a", "b"]));
      expect(useFleetArmingStore.getState().lastArmedId).toBe("b");
    });

    it("resets lastArmedId to tail when the previous lastArmedId is pruned", () => {
      useFleetArmingStore.getState().armIds(["a", "b", "c"]);
      useFleetArmingStore.getState().prune(new Set(["a"]));
      expect(useFleetArmingStore.getState().lastArmedId).toBe("a");
    });

    it("is a no-op when all ids are valid", () => {
      useFleetArmingStore.getState().armIds(["a", "b"]);
      const before = useFleetArmingStore.getState();
      useFleetArmingStore.getState().prune(new Set(["a", "b", "c"]));
      expect(useFleetArmingStore.getState()).toEqual(before);
    });
  });

  describe("isFleetArmEligible", () => {
    it("returns true for a non-trash non-background agent with pty", () => {
      expect(isFleetArmEligible(makeAgentTerminal("a"))).toBe(true);
    });

    it("rejects trashed terminals", () => {
      expect(isFleetArmEligible(makeAgentTerminal("a", { location: "trash" }))).toBe(false);
    });

    it("rejects background terminals", () => {
      expect(isFleetArmEligible(makeAgentTerminal("a", { location: "background" }))).toBe(false);
    });

    it("rejects hasPty=false terminals", () => {
      expect(isFleetArmEligible(makeAgentTerminal("a", { hasPty: false }))).toBe(false);
    });

    it("rejects non-agent terminals", () => {
      expect(
        isFleetArmEligible(makeAgentTerminal("a", { kind: "terminal", agentId: undefined }))
      ).toBe(false);
    });

    it("rejects undefined", () => {
      expect(isFleetArmEligible(undefined)).toBe(false);
    });

    it("accepts a plain terminal currently running a detected agent", () => {
      expect(
        isFleetArmEligible(
          makeAgentTerminal("a", {
            kind: "terminal",
            agentId: undefined,
            detectedAgentId: "claude",
          })
        )
      ).toBe(true);
    });

    it("accepts a plain terminal that has ever run an agent this session", () => {
      expect(
        isFleetArmEligible(
          makeAgentTerminal("a", {
            kind: "terminal",
            agentId: undefined,
            everDetectedAgent: true,
          })
        )
      ).toBe(true);
    });

    it("remains eligible after detectedAgentId clears when everDetectedAgent is sticky", () => {
      // Sticky rule: once a panel has ever run an agent, it stays fleet-eligible
      // even after the live process exits. Prevents the armed set from collapsing
      // mid-operation when agents bounce.
      expect(
        isFleetArmEligible(
          makeAgentTerminal("a", {
            kind: "terminal",
            agentId: undefined,
            detectedAgentId: undefined,
            everDetectedAgent: true,
          })
        )
      ).toBe(true);
    });

    it("trash guard beats runtime-detected identity", () => {
      expect(
        isFleetArmEligible(
          makeAgentTerminal("a", {
            kind: "terminal",
            agentId: undefined,
            detectedAgentId: "claude",
            everDetectedAgent: true,
            location: "trash",
          })
        )
      ).toBe(false);
    });

    it("hasPty=false guard beats runtime-detected identity", () => {
      expect(
        isFleetArmEligible(
          makeAgentTerminal("a", {
            kind: "terminal",
            agentId: undefined,
            everDetectedAgent: true,
            hasPty: false,
          })
        )
      ).toBe(false);
    });
  });

  describe("panel prune subscription", () => {
    it("drops armed ids when a panel is removed from panelStore", () => {
      seedPanels([makeAgentTerminal("a"), makeAgentTerminal("b"), makeAgentTerminal("c")]);
      useFleetArmingStore.getState().armIds(["a", "b", "c"]);

      // Simulate removal of 'b'
      seedPanels([makeAgentTerminal("a"), makeAgentTerminal("c")]);

      const s = useFleetArmingStore.getState();
      expect([...s.armedIds].sort()).toEqual(["a", "c"]);
    });

    it("drops armed ids when a panel transitions to trash", () => {
      seedPanels([makeAgentTerminal("a"), makeAgentTerminal("b")]);
      useFleetArmingStore.getState().armIds(["a", "b"]);

      seedPanels([makeAgentTerminal("a"), makeAgentTerminal("b", { location: "trash" })]);

      expect([...useFleetArmingStore.getState().armedIds]).toEqual(["a"]);
    });
  });
});
