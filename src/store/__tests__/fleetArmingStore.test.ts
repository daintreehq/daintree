import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  useFleetArmingStore,
  computeArmByStateIds,
  isFleetArmEligible,
  isAgentFleetActionEligible,
  isFleetInterruptAgentEligible,
  isFleetRestartAgentEligible,
  isFleetWaitingAgentEligible,
  isTerminalErrorClusterEligible,
  isTerminalFleetEligible,
  resolveFleetAgentCapabilityId,
  subscribeFleetArmingPanelPruning,
} from "../fleetArmingStore";
import { usePanelStore } from "../panelStore";
import { useWorktreeSelectionStore } from "../worktreeStore";
import type { PanelInstance } from "@shared/types/panel";

function resetStore() {
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
    broadcastSignal: 0,
    previewArmedIds: new Set<string>(),
  });
}

function makeAgentTerminal(id: string, overrides: Record<string, unknown> = {}): PanelInstance {
  return {
    id,
    title: id,
    kind: "terminal",
    detectedAgentId: "claude",
    everDetectedAgent: true,
    worktreeId: "wt-1",
    location: "grid",
    agentState: "idle",
    hasPty: true,
    ...overrides,
  } as PanelInstance;
}

function seedPanels(terminals: PanelInstance[]): void {
  const panelsById: Record<string, PanelInstance> = {};
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

  describe("addToFleet (batch append)", () => {
    beforeEach(() => {
      seedPanels([
        makeAgentTerminal("t1"),
        makeAgentTerminal("t2"),
        makeAgentTerminal("t3"),
        makeAgentTerminal("t4"),
      ]);
    });

    it("appends new ids to the existing armOrder, preserving order", () => {
      useFleetArmingStore.getState().armIds(["t1", "t2"]);
      useFleetArmingStore.getState().addToFleet(["t3", "t4"]);
      const s = useFleetArmingStore.getState();
      expect(s.armOrder).toEqual(["t1", "t2", "t3", "t4"]);
      expect(s.armOrderById).toEqual({ t1: 1, t2: 2, t3: 3, t4: 4 });
      expect(s.lastArmedId).toBe("t4");
    });

    it("dedupes ids already in the fleet without disturbing existing order", () => {
      useFleetArmingStore.getState().armIds(["t1", "t2"]);
      useFleetArmingStore.getState().addToFleet(["t2", "t3"]);
      const s = useFleetArmingStore.getState();
      expect(s.armOrder).toEqual(["t1", "t2", "t3"]);
      expect(s.lastArmedId).toBe("t3");
    });

    it("dedupes within a single batch", () => {
      useFleetArmingStore.getState().addToFleet(["t1", "t1", "t2", "t1"]);
      const s = useFleetArmingStore.getState();
      expect(s.armOrder).toEqual(["t1", "t2"]);
      expect(s.lastArmedId).toBe("t2");
    });

    it("is a no-op (preserves lastArmedId) when every id is already armed", () => {
      useFleetArmingStore.getState().armIds(["t1", "t2"]);
      const before = useFleetArmingStore.getState().lastArmedId;
      useFleetArmingStore.getState().addToFleet(["t1", "t2"]);
      const s = useFleetArmingStore.getState();
      expect(s.armOrder).toEqual(["t1", "t2"]);
      expect(s.lastArmedId).toBe(before);
    });

    it("is a no-op (preserves lastArmedId) when called with an empty batch", () => {
      useFleetArmingStore.getState().armIds(["t1"]);
      const before = useFleetArmingStore.getState().lastArmedId;
      useFleetArmingStore.getState().addToFleet([]);
      expect(useFleetArmingStore.getState().lastArmedId).toBe(before);
    });

    it("filters out ineligible ids silently", () => {
      seedPanels([
        makeAgentTerminal("t1"),
        makeAgentTerminal("t2", { location: "trash" }),
        makeAgentTerminal("t3", { hasPty: false }),
      ]);
      useFleetArmingStore.getState().addToFleet(["t1", "t2", "t3", "unknown"]);
      const s = useFleetArmingStore.getState();
      expect(s.armOrder).toEqual(["t1"]);
      expect(s.lastArmedId).toBe("t1");
    });

    it("is a no-op when every id in the batch is a non-PTY kind (#8957 batch B)", () => {
      // Locks the no-op + lastArmedId-preservation contract for non-PTY input.
      // addToFleet calls isFleetArmEligible(getNarrowPanel(...)) — the
      // isPtyPanel guard rejects browser/dev-preview/review, so the batch
      // should leave the prior fleet (and lastArmedId) untouched.
      seedPanels([
        makeAgentTerminal("t1"),
        makeAgentTerminal("b1", { kind: "browser", hasPty: undefined }),
        makeAgentTerminal("d1", { kind: "dev-preview", hasPty: undefined }),
        makeAgentTerminal("r1", { kind: "review", hasPty: undefined }),
      ]);
      useFleetArmingStore.getState().armIds(["t1"]);
      const before = useFleetArmingStore.getState().lastArmedId;
      useFleetArmingStore.getState().addToFleet(["b1", "d1", "r1"]);
      const s = useFleetArmingStore.getState();
      expect(s.armOrder).toEqual(["t1"]);
      expect(s.lastArmedId).toBe(before);
    });

    it("seeds an empty fleet when armedIds is initially empty", () => {
      useFleetArmingStore.getState().addToFleet(["t2", "t3"]);
      const s = useFleetArmingStore.getState();
      expect(s.armOrder).toEqual(["t2", "t3"]);
      expect(s.armedIds.has("t2")).toBe(true);
      expect(s.armedIds.has("t3")).toBe(true);
      expect(s.lastArmedId).toBe("t3");
    });

    it("preserves caller order when caller passes ids in non-panel order", () => {
      // Locks the contract: addToFleet preserves the order the caller
      // provides, NOT the panelIds order. This matters because the picker
      // commits its `confirmedIds` (built from a Set seeded by user toggle
      // order), so users see new entries appear in the order they checked
      // them — not the order panels happen to live in the sidebar.
      useFleetArmingStore.getState().addToFleet(["t4", "t1", "t3"]);
      const s = useFleetArmingStore.getState();
      expect(s.armOrder).toEqual(["t4", "t1", "t3"]);
      expect(s.lastArmedId).toBe("t3");
    });
  });

  describe("armByState", () => {
    beforeEach(() => {
      seedPanels([
        makeAgentTerminal("t1", { agentState: "working" }),
        makeAgentTerminal("t2", { agentState: "working" }),
        makeAgentTerminal("t3", { agentState: "waiting" }),
        makeAgentTerminal("t4", { agentState: "completed" }),
        makeAgentTerminal("t5", { agentState: "exited" }),
        makeAgentTerminal("t6", { agentState: "idle" }),
        makeAgentTerminal("t7", { agentState: "working", worktreeId: "wt-2" }),
      ]);
      useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    });

    it("arms only 'working' agents for 'working' preset in current scope", () => {
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

    it("excludes trash/background/dock/hasPty=false panels", () => {
      seedPanels([
        makeAgentTerminal("t1", { agentState: "working" }),
        makeAgentTerminal("t2", { agentState: "working", location: "trash" }),
        makeAgentTerminal("t3", { agentState: "working", location: "background" }),
        makeAgentTerminal("t4", { agentState: "working", hasPty: false }),
        makeAgentTerminal("t5", { agentState: "working", location: "dock" }),
      ]);
      useFleetArmingStore.getState().armByState("working", "current", false);
      expect([...useFleetArmingStore.getState().armedIds]).toEqual(["t1"]);
    });

    it("excludes plain terminals whose agentState matches the preset", () => {
      // Fleet is detection-based. A plain shell with no detectedAgentId must not
      // enter the fleet even if its agentState matches the preset.
      seedPanels([
        makeAgentTerminal("a1", { agentState: "working" }),
        makeAgentTerminal("p1", {
          agentState: "working",
          kind: "terminal",
          detectedAgentId: undefined,
          everDetectedAgent: false,
        }),
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

    it("skips dock-located terminals", () => {
      seedPanels([makeAgentTerminal("a1"), makeAgentTerminal("a2", { location: "dock" })]);
      useFleetArmingStore.getState().armAll("current");
      expect([...useFleetArmingStore.getState().armedIds]).toEqual(["a1"]);
    });

    it("scope 'all' arms across worktrees", () => {
      seedPanels([makeAgentTerminal("a1"), makeAgentTerminal("a2", { worktreeId: "wt-2" })]);
      useFleetArmingStore.getState().armAll("all");
      expect([...useFleetArmingStore.getState().armedIds].sort()).toEqual(["a1", "a2"]);
    });

    it("arms live-agent terminals, ex-agent shells, and plain shells", () => {
      // Fleet broadcast membership is terminal-based. Agent-only quick actions
      // still filter down to terminals with a live agent capability.
      seedPanels([
        makeAgentTerminal("a1"),
        makeAgentTerminal("p1", {
          kind: "terminal",
          detectedAgentId: undefined,
          everDetectedAgent: true,
        }),
        makeAgentTerminal("p2", {
          kind: "terminal",
          detectedAgentId: undefined,
          everDetectedAgent: false,
        }),
      ]);
      useFleetArmingStore.getState().armAll("current");
      expect([...useFleetArmingStore.getState().armedIds]).toEqual(["a1", "p1", "p2"]);
    });

    it("arms terminals whose live agent identity is carried by runtimeIdentity", () => {
      seedPanels([
        makeAgentTerminal("runtime-a1", {
          detectedAgentId: undefined,
          runtimeIdentity: {
            kind: "agent",
            id: "claude",
            iconId: "claude",
            agentId: "claude",
          },
        }),
      ]);

      useFleetArmingStore.getState().armAll("current");

      expect([...useFleetArmingStore.getState().armedIds]).toEqual(["runtime-a1"]);
    });

    it("skips non-PTY panel kinds via collectEligibleIds (#8957 batch B)", () => {
      // collectEligibleIds → getNarrowPanel → isFleetArmEligible — the
      // isPtyPanel guard must drop browser/dev-preview/review even when the
      // panel reports a matching worktree.
      seedPanels([
        makeAgentTerminal("a1"),
        makeAgentTerminal("b1", { kind: "browser", hasPty: undefined }),
        makeAgentTerminal("d1", { kind: "dev-preview", hasPty: undefined }),
        makeAgentTerminal("r1", { kind: "review", hasPty: undefined }),
      ]);
      useFleetArmingStore.getState().armAll("all");
      expect([...useFleetArmingStore.getState().armedIds]).toEqual(["a1"]);
    });
  });

  describe("armMatchingFilter", () => {
    it("arms eligible terminals in the matching worktree set", () => {
      seedPanels([
        makeAgentTerminal("a1", { worktreeId: "wt-1" }),
        makeAgentTerminal("a2", { worktreeId: "wt-2" }),
        makeAgentTerminal("a3", { worktreeId: "wt-3" }),
      ]);
      useFleetArmingStore.getState().armMatchingFilter(["wt-1", "wt-3"]);
      expect([...useFleetArmingStore.getState().armedIds].sort()).toEqual(["a1", "a3"]);
    });

    it("skips structurally ineligible and non-agent panels even when worktree matches", () => {
      seedPanels([
        makeAgentTerminal("a1", { worktreeId: "wt-1" }),
        makeAgentTerminal("a2", { worktreeId: "wt-1", location: "trash" }),
        makeAgentTerminal("a3", { worktreeId: "wt-1", location: "background" }),
        makeAgentTerminal("a4", { worktreeId: "wt-1", hasPty: false }),
        // a5 is a plain shell: no live detection, no launch affinity, no
        // runtime identity. Filter-scoped bulk arming is agent-scoped (#11637),
        // so it is excluded on capability rather than structure.
        makeAgentTerminal("a5", {
          worktreeId: "wt-1",
          kind: "terminal",
          detectedAgentId: undefined,
          launchAgentId: undefined,
          runtimeIdentity: undefined,
          agentState: undefined,
          everDetectedAgent: false,
        }),
        makeAgentTerminal("a6", { worktreeId: "wt-1", location: "dock" }),
      ]);
      useFleetArmingStore.getState().armMatchingFilter(["wt-1"]);
      expect([...useFleetArmingStore.getState().armedIds]).toEqual(["a1"]);
    });

    it("skips non-PTY panel kinds (browser, dev-preview, review) (#8957 batch B)", () => {
      // The carrier surfaces non-PTY panels via the narrowed PanelInstance
      // union now that #8957 routes reads through getNarrowPanel. Confirms
      // collectFilterArmEligibleIds drops them via the isPtyPanel guard.
      seedPanels([
        makeAgentTerminal("a1", { worktreeId: "wt-1" }),
        makeAgentTerminal("b1", { worktreeId: "wt-1", kind: "browser", hasPty: undefined }),
        makeAgentTerminal("d1", { worktreeId: "wt-1", kind: "dev-preview", hasPty: undefined }),
        makeAgentTerminal("r1", { worktreeId: "wt-1", kind: "review", hasPty: undefined }),
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

    it("no eligible terminals in matching worktrees preserves any prior armed set", () => {
      seedPanels([
        makeAgentTerminal("a1", { worktreeId: "wt-1" }),
        makeAgentTerminal("a2", { worktreeId: "wt-2" }),
      ]);
      useFleetArmingStore.getState().armIds(["a1", "a2"]);
      // wt-9 has no panels — the button must not clobber the user's selection
      useFleetArmingStore.getState().armMatchingFilter(["wt-9"]);
      expect([...useFleetArmingStore.getState().armedIds].sort()).toEqual(["a1", "a2"]);
    });

    it("no eligible terminals and no prior selection leaves armed set empty", () => {
      seedPanels([makeAgentTerminal("a1", { worktreeId: "wt-1" })]);
      useFleetArmingStore.getState().armMatchingFilter(["wt-9"]);
      expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
    });

    it("replaces the existing armed set when armed set is empty", () => {
      seedPanels([
        makeAgentTerminal("a1", { worktreeId: "wt-1" }),
        makeAgentTerminal("a2", { worktreeId: "wt-2" }),
      ]);
      // Armed set starts empty — armMatchingFilter replaces it with matches
      useFleetArmingStore.getState().armMatchingFilter(["wt-1"]);
      expect([...useFleetArmingStore.getState().armedIds]).toEqual(["a1"]);
    });

    it("unions with existing armed set when non-empty", () => {
      seedPanels([
        makeAgentTerminal("a1", { worktreeId: "wt-1" }),
        makeAgentTerminal("a2", { worktreeId: "wt-2" }),
      ]);
      useFleetArmingStore.getState().armIds(["a2"]);
      // Non-empty armed set → armMatchingFilter adds matches without removing existing
      useFleetArmingStore.getState().armMatchingFilter(["wt-1"]);
      const s = useFleetArmingStore.getState();
      expect([...s.armedIds].sort()).toEqual(["a1", "a2"]);
      // Existing armed entries keep their position; new ones are appended
      expect(s.armOrder).toEqual(["a2", "a1"]);
    });

    it("preserves existing armOrder and appends new matches in panel order", () => {
      seedPanels([
        makeAgentTerminal("a1", { worktreeId: "wt-1" }),
        makeAgentTerminal("a2", { worktreeId: "wt-2" }),
        makeAgentTerminal("a3", { worktreeId: "wt-1" }),
      ]);
      useFleetArmingStore.getState().armIds(["a2"]);
      // a2 already armed. a1 and a3 match the filter — both are new.
      // a1 appears before a3 in panel order, so a2,a1,a3 is the expected result.
      useFleetArmingStore.getState().armMatchingFilter(["wt-1"]);
      const s = useFleetArmingStore.getState();
      expect(s.armOrder).toEqual(["a2", "a1", "a3"]);
      expect(s.armOrderById).toEqual({ a2: 1, a1: 2, a3: 3 });
      expect(s.lastArmedId).toBe("a3");
    });

    it("no-op when all filter matches are already armed (additive path)", () => {
      seedPanels([
        makeAgentTerminal("a1", { worktreeId: "wt-1" }),
        makeAgentTerminal("a2", { worktreeId: "wt-1" }),
        makeAgentTerminal("a3", { worktreeId: "wt-2" }),
      ]);
      useFleetArmingStore.getState().armMatchingFilter(["wt-1"]);
      // Add a3 from wt-2 — additive since a1,a2 are already armed
      useFleetArmingStore.getState().armMatchingFilter(["wt-2"]);
      // Now a1,a2,a3 are all armed. Call armMatchingFilter with wt-1 — a1 and a2
      // are already armed, so the additive path should be a no-op.
      const preState = useFleetArmingStore.getState();
      useFleetArmingStore.getState().armMatchingFilter(["wt-1"]);
      const postState = useFleetArmingStore.getState();
      expect(postState.armOrder).toEqual(preState.armOrder);
      expect(postState.armOrderById).toEqual(preState.armOrderById);
      expect(postState.lastArmedId).toBe(preState.lastArmedId);
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

    it("excludes demoted ex-agent terminals — filter-scoped arming needs a live agent", () => {
      // A real demoted record: launch affinity survives but detection, runtime
      // identity, and agentState are all gone, so `isDemotedExAgent` fires.
      // `armAll` still takes these (broadcast membership is PTY-based); the
      // sidebar's filter-scoped arm is agent-scoped instead (#11637).
      seedPanels([
        makeAgentTerminal("a1", { worktreeId: "wt-1" }),
        makeAgentTerminal("p1", {
          worktreeId: "wt-1",
          kind: "terminal",
          detectedAgentId: undefined,
          runtimeIdentity: undefined,
          launchAgentId: "claude",
          agentState: undefined,
          everDetectedAgent: true,
        }),
      ]);
      useFleetArmingStore.getState().armMatchingFilter(["wt-1"]);
      expect([...useFleetArmingStore.getState().armedIds]).toEqual(["a1"]);
    });

    it("arms plugin-contributed agents whose id is not a built-in", () => {
      // Arming only adds a terminal to the broadcast set, so it must not gate on
      // built-in agent capability the way accept/interrupt/restart do — plugin
      // and user agent ids are non-built-in by construction (#11637).
      seedPanels([
        makeAgentTerminal("plugin", {
          worktreeId: "wt-1",
          detectedAgentId: undefined,
          launchAgentId: "acme-plugin-agent",
          everDetectedAgent: false,
        }),
      ]);
      useFleetArmingStore.getState().armMatchingFilter(["wt-1"]);
      expect([...useFleetArmingStore.getState().armedIds]).toEqual(["plugin"]);
    });

    it("preserves the prior fleet when the matched worktree holds only shells", () => {
      // Newly reachable after #11637: the worktree matches the filter and has
      // live terminals, but none are agents, so the collector returns empty and
      // the early return must leave the user's existing selection intact.
      seedPanels([
        makeAgentTerminal("agent-elsewhere", { worktreeId: "wt-2" }),
        makeAgentTerminal("shell", {
          worktreeId: "wt-1",
          kind: "terminal",
          detectedAgentId: undefined,
          launchAgentId: undefined,
          runtimeIdentity: undefined,
          agentState: undefined,
          everDetectedAgent: false,
        }),
      ]);
      useFleetArmingStore.getState().armIds(["agent-elsewhere"]);
      const before = useFleetArmingStore.getState();
      const beforeOrder = [...before.armOrder];
      const beforeLast = before.lastArmedId;

      useFleetArmingStore.getState().armMatchingFilter(["wt-1"]);

      const after = useFleetArmingStore.getState();
      expect([...after.armedIds]).toEqual(["agent-elsewhere"]);
      expect(after.armOrder).toEqual(beforeOrder);
      expect(after.lastArmedId).toBe(beforeLast);
    });

    it("excludes plain shells but still arms agents in the same worktree", () => {
      // Direct regression for #11637: the zap affordance next to the quick
      // state filter bar must not sweep up shells sharing a worktree.
      seedPanels([
        makeAgentTerminal("a1", { worktreeId: "wt-1" }),
        makeAgentTerminal("shell", {
          worktreeId: "wt-1",
          kind: "terminal",
          detectedAgentId: undefined,
          launchAgentId: undefined,
          runtimeIdentity: undefined,
          agentState: undefined,
          everDetectedAgent: false,
        }),
        makeAgentTerminal("a2", { worktreeId: "wt-1" }),
      ]);
      useFleetArmingStore.getState().armMatchingFilter(["wt-1"]);
      expect([...useFleetArmingStore.getState().armedIds]).toEqual(["a1", "a2"]);
    });

    it("arms terminals whose agent identity comes from launchAgentId or runtimeIdentity", () => {
      // The agent predicate resolves identity from more than `detectedAgentId`;
      // narrowing the sidebar arm must not drop restored or toolbar-launched
      // agent terminals that have not re-detected yet.
      seedPanels([
        makeAgentTerminal("launched", {
          worktreeId: "wt-1",
          detectedAgentId: undefined,
          launchAgentId: "claude",
          everDetectedAgent: false,
        }),
        makeAgentTerminal("runtime", {
          worktreeId: "wt-1",
          detectedAgentId: undefined,
          runtimeIdentity: {
            kind: "agent",
            id: "claude",
            iconId: "claude",
            agentId: "claude",
          },
        }),
      ]);
      useFleetArmingStore.getState().armMatchingFilter(["wt-1"]);
      expect([...useFleetArmingStore.getState().armedIds]).toEqual(["launched", "runtime"]);
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

    it("rejects dock terminals", () => {
      expect(isFleetArmEligible(makeAgentTerminal("a", { location: "dock" }))).toBe(false);
    });

    it("rejects hasPty=false terminals", () => {
      expect(isFleetArmEligible(makeAgentTerminal("a", { hasPty: false }))).toBe(false);
    });

    it("rejects terminals whose PTY has exited", () => {
      expect(isFleetArmEligible(makeAgentTerminal("a", { runtimeStatus: "exited" }))).toBe(false);
    });

    it("rejects terminals with a runtime error", () => {
      expect(isFleetArmEligible(makeAgentTerminal("a", { runtimeStatus: "error" }))).toBe(false);
    });

    it("accepts plain terminals with no detectedAgentId", () => {
      // Fleet broadcast membership only requires a live writable PTY.
      expect(
        isFleetArmEligible(
          makeAgentTerminal("a", { detectedAgentId: undefined, everDetectedAgent: false })
        )
      ).toBe(true);
    });

    it("rejects undefined", () => {
      expect(isFleetArmEligible(undefined)).toBe(false);
    });

    it("accepts ex-agent terminals (detectedAgentId cleared, everDetectedAgent sticky)", () => {
      expect(
        isFleetArmEligible(
          makeAgentTerminal("a", {
            detectedAgentId: undefined,
            everDetectedAgent: true,
          })
        )
      ).toBe(true);
    });

    it("trash guard beats live detectedAgentId", () => {
      expect(
        isFleetArmEligible(
          makeAgentTerminal("a", {
            detectedAgentId: "claude",
            everDetectedAgent: true,
            location: "trash",
          })
        )
      ).toBe(false);
    });

    it("hasPty=false guard beats live detectedAgentId", () => {
      expect(
        isFleetArmEligible(
          makeAgentTerminal("a", {
            detectedAgentId: "claude",
            everDetectedAgent: true,
            hasPty: false,
          })
        )
      ).toBe(false);
    });

    it("rejects non-PTY panel kinds (browser, dev-preview, review)", () => {
      // Documents the isPtyPanel guard added in #8957 — the carrier now
      // surfaces non-PTY panels via the narrowed PanelInstance union, and
      // fleet predicates must drop them before checking PTY-specific fields.
      const browser = makeAgentTerminal("a", { kind: "browser", hasPty: undefined });
      const devPreview = makeAgentTerminal("a", { kind: "dev-preview", hasPty: undefined });
      const review = makeAgentTerminal("a", { kind: "review", hasPty: undefined });
      expect(isFleetArmEligible(browser)).toBe(false);
      expect(isFleetArmEligible(devPreview)).toBe(false);
      expect(isFleetArmEligible(review)).toBe(false);
    });
  });

  describe("agent Fleet action eligibility", () => {
    it("treats live detectedAgentId as full agent capability", () => {
      const terminal = makeAgentTerminal("a", { detectedAgentId: "claude" });
      expect(resolveFleetAgentCapabilityId(terminal)).toBe("claude");
      expect(isAgentFleetActionEligible(terminal)).toBe(true);
      expect(isFleetRestartAgentEligible(terminal)).toBe(true);
    });

    it("treats ex-agent (detectedAgentId cleared) as non-agent-capable", () => {
      const exAgent = makeAgentTerminal("a", {
        detectedAgentId: undefined,
        everDetectedAgent: true,
      });
      expect(resolveFleetAgentCapabilityId(exAgent)).toBeUndefined();
      expect(isAgentFleetActionEligible(exAgent)).toBe(false);
      expect(
        isFleetWaitingAgentEligible({ ...exAgent, agentState: "waiting" } as PanelInstance)
      ).toBe(false);
      expect(
        isFleetInterruptAgentEligible({ ...exAgent, agentState: "working" } as PanelInstance)
      ).toBe(false);
      expect(isFleetRestartAgentEligible(exAgent)).toBe(false);
    });

    it("still applies structural liveness guards to agent-capable terminals", () => {
      expect(isAgentFleetActionEligible(makeAgentTerminal("a", { location: "trash" }))).toBe(false);
      expect(isAgentFleetActionEligible(makeAgentTerminal("a", { hasPty: false }))).toBe(false);
      expect(isAgentFleetActionEligible(makeAgentTerminal("a", { runtimeStatus: "exited" }))).toBe(
        false
      );
    });

    it("classifies waiting and interrupt candidates only for live-agent terminals", () => {
      const waiting = makeAgentTerminal("a", { agentState: "waiting" });
      const working = makeAgentTerminal("b", { agentState: "working" });
      const idle = makeAgentTerminal("c", { agentState: "idle" });
      expect(isFleetWaitingAgentEligible(waiting)).toBe(true);
      expect(isFleetInterruptAgentEligible(waiting)).toBe(true);
      expect(isFleetInterruptAgentEligible(working)).toBe(true);
      expect(isFleetWaitingAgentEligible(working)).toBe(false);
      expect(isFleetInterruptAgentEligible(idle)).toBe(false);
    });

    it("rejects non-PTY panel kinds across every fleet predicate (#8957 batch B)", () => {
      // The narrowed PanelInstance union now flows non-PTY panels through these
      // predicates; each must drop browser/dev-preview/review before touching
      // PTY-specific fields. Mirrors the isFleetArmEligible coverage above so
      // the entire fleet eligibility surface is covered.
      const browser = makeAgentTerminal("a", {
        kind: "browser",
        hasPty: undefined,
        agentState: "waiting",
      });
      const devPreview = makeAgentTerminal("a", {
        kind: "dev-preview",
        hasPty: undefined,
        agentState: "working",
      });
      const review = makeAgentTerminal("a", {
        kind: "review",
        hasPty: undefined,
        agentState: "waiting",
      });
      for (const panel of [browser, devPreview, review]) {
        expect(isTerminalFleetEligible(panel)).toBe(false);
        expect(isTerminalErrorClusterEligible(panel)).toBe(false);
        expect(resolveFleetAgentCapabilityId(panel)).toBeUndefined();
        expect(isAgentFleetActionEligible(panel)).toBe(false);
        expect(isFleetWaitingAgentEligible(panel)).toBe(false);
        expect(isFleetInterruptAgentEligible(panel)).toBe(false);
        expect(isFleetRestartAgentEligible(panel)).toBe(false);
      }
    });
  });

  describe("broadcastSignal", () => {
    it("starts at 0", () => {
      expect(useFleetArmingStore.getState().broadcastSignal).toBe(0);
    });

    it("monotonically increments on noteBroadcastCommit()", () => {
      const { noteBroadcastCommit } = useFleetArmingStore.getState();
      noteBroadcastCommit();
      expect(useFleetArmingStore.getState().broadcastSignal).toBe(1);
      noteBroadcastCommit();
      noteBroadcastCommit();
      expect(useFleetArmingStore.getState().broadcastSignal).toBe(3);
    });

    it("is unaffected by clear()", () => {
      const { noteBroadcastCommit, clear } = useFleetArmingStore.getState();
      noteBroadcastCommit();
      noteBroadcastCommit();
      clear();
      expect(useFleetArmingStore.getState().broadcastSignal).toBe(2);
    });
  });

  describe("previewArmedIds", () => {
    it("starts empty", () => {
      expect(useFleetArmingStore.getState().previewArmedIds.size).toBe(0);
    });

    it("setPreviewArmedIds replaces the set", () => {
      const { setPreviewArmedIds } = useFleetArmingStore.getState();
      setPreviewArmedIds(new Set(["a", "b"]));
      const ids = useFleetArmingStore.getState().previewArmedIds;
      expect([...ids].sort()).toEqual(["a", "b"]);
    });

    it("setPreviewArmedIds is a no-op when the set is unchanged (referential stability)", () => {
      const { setPreviewArmedIds } = useFleetArmingStore.getState();
      setPreviewArmedIds(new Set(["a", "b"]));
      const before = useFleetArmingStore.getState().previewArmedIds;
      setPreviewArmedIds(new Set(["b", "a"]));
      expect(useFleetArmingStore.getState().previewArmedIds).toBe(before);
    });

    it("clearPreviewArmedIds empties the set", () => {
      const { setPreviewArmedIds, clearPreviewArmedIds } = useFleetArmingStore.getState();
      setPreviewArmedIds(new Set(["a"]));
      clearPreviewArmedIds();
      expect(useFleetArmingStore.getState().previewArmedIds.size).toBe(0);
    });

    it("clearPreviewArmedIds is a no-op when already empty (referential stability)", () => {
      const before = useFleetArmingStore.getState().previewArmedIds;
      useFleetArmingStore.getState().clearPreviewArmedIds();
      expect(useFleetArmingStore.getState().previewArmedIds).toBe(before);
    });

    it("clear() also resets previewArmedIds", () => {
      const { setPreviewArmedIds, clear } = useFleetArmingStore.getState();
      setPreviewArmedIds(new Set(["a", "b"]));
      clear();
      expect(useFleetArmingStore.getState().previewArmedIds.size).toBe(0);
    });
  });

  describe("computeArmByStateIds", () => {
    beforeEach(() => {
      seedPanels([
        makeAgentTerminal("t1", { agentState: "working" }),
        makeAgentTerminal("t2", { agentState: "waiting" }),
        makeAgentTerminal("t3", { agentState: "working", worktreeId: "wt-2" }),
      ]);
    });

    it("returns ids that armByState would arm — current scope", () => {
      const ids = computeArmByStateIds("working", "current", "wt-1");
      expect(ids).toEqual(["t1"]);
    });

    it("returns ids that armByState would arm — all scope", () => {
      const ids = computeArmByStateIds("working", "all", "wt-1");
      expect(ids.sort()).toEqual(["t1", "t3"]);
    });

    it("returns empty when no panels match the preset", () => {
      const ids = computeArmByStateIds("finished", "current", "wt-1");
      expect(ids).toEqual([]);
    });

    it("does not mutate the store", () => {
      const before = useFleetArmingStore.getState();
      computeArmByStateIds("working", "all", "wt-1");
      expect(useFleetArmingStore.getState()).toBe(before);
    });
  });

  describe("panel prune subscription", () => {
    let unsubscribe: (() => void) | null = null;

    beforeEach(() => {
      unsubscribe = subscribeFleetArmingPanelPruning();
    });

    afterEach(() => {
      unsubscribe?.();
      unsubscribe = null;
    });

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

    it("drops armed ids when a panel transitions to dock", () => {
      seedPanels([makeAgentTerminal("a"), makeAgentTerminal("b")]);
      useFleetArmingStore.getState().armIds(["a", "b"]);

      seedPanels([makeAgentTerminal("a"), makeAgentTerminal("b", { location: "dock" })]);

      expect([...useFleetArmingStore.getState().armedIds]).toEqual(["a"]);
    });

    it("drops armed ids when a panel mutates into a non-PTY kind (#8957 batch B)", () => {
      // The reconcileAgainst path inside the subscription now consumes
      // the narrowed PanelInstance union via getNarrowPanel. A panel
      // whose kind flips to browser/dev-preview/review must fail the
      // isPtyPanel guard and be pruned from the armed set.
      seedPanels([makeAgentTerminal("a"), makeAgentTerminal("b")]);
      useFleetArmingStore.getState().armIds(["a", "b"]);

      seedPanels([
        makeAgentTerminal("a"),
        makeAgentTerminal("b", { kind: "browser", hasPty: undefined }),
      ]);

      expect([...useFleetArmingStore.getState().armedIds]).toEqual(["a"]);
    });
  });
});
