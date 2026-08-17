import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";

vi.mock("@/clients", () => ({
  terminalClient: { resize: vi.fn() },
  agentSettingsClient: { get: vi.fn().mockResolvedValue(null) },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    resize: vi.fn().mockReturnValue(null),
    wake: vi.fn(),
    getInstance: vi.fn(),
    setInputLocked: vi.fn(),
  },
}));

vi.mock("@/store/persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: vi.fn(),
    saveTabGroups: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

const { usePanelStore } = await import("@/store/panelStore");
const { agentLifecycleLedger } = await import("@/services/terminal/lifecycleLedger");

function panel(id: string, worktreeId: string): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal" as const,
    cwd: "/repo",
    cols: 80,
    rows: 24,
    worktreeId,
    location: "grid",
    isVisible: true,
  };
}

beforeEach(async () => {
  // `reset()` is async; leaving it unawaited lets it land mid-test.
  await usePanelStore.getState().reset();
  // The ledger is a module singleton shared across suites — stale entries for
  // these ids would let a missing attribution write look like a passing one.
  agentLifecycleLedger.clear();
  usePanelStore.setState({
    panelsById: {},
    panelIds: [],
    panelIdsByWorktreeId: {},
    tabGroups: new Map(),
    focusedId: null,
    maximizedId: null,
    commandQueue: [],
  });
  vi.clearAllMocks();
});

describe("grouped cross-worktree move attribution (#11840)", () => {
  function seedGroup(): void {
    usePanelStore.setState({
      panelsById: { t1: panel("t1", "wt-a"), t2: panel("t2", "wt-a") },
      panelIds: ["t1", "t2"],
      panelIdsByWorktreeId: { "wt-a": ["t1", "t2"] },
      tabGroups: new Map([
        [
          "g1",
          {
            id: "g1",
            location: "grid" as const,
            worktreeId: "wt-a",
            activeTabId: "t1",
            panelIds: ["t1", "t2"],
          },
        ],
      ]),
    });
    for (const id of ["t1", "t2"]) {
      agentLifecycleLedger.recordLaunch(id, { worktreeId: "wt-a", worktreeSource: "explicit" });
    }
  }

  it("records attribution for every member, not just the dragged one", () => {
    // The grouped branch used to return before any ledger write ran, so one drag
    // could re-file several agents with no attribution at all.
    seedGroup();

    usePanelStore.getState().moveTerminalToWorktree("t1", "wt-b");

    for (const id of ["t1", "t2"]) {
      expect(agentLifecycleLedger.getEntry(id)?.facts.worktreeId).toBe("wt-b");
      expect(agentLifecycleLedger.getEntry(id)?.facts.worktreeSource).toBe("explicit");
    }
  });

  it("leaves the attribution beyond the reach of later cwd inference", () => {
    // A deliberate filing must not be silently re-homed back to the launch root
    // — that would undo the user's own choice. The divergence it creates is
    // corrected by the visible opt-out marker instead.
    seedGroup();
    usePanelStore.getState().moveTerminalToWorktree("t1", "wt-b");

    const generation = agentLifecycleLedger.currentGeneration("t2")!;
    const verdict = agentLifecycleLedger.recordWorktreeAttribution(
      "t2",
      generation,
      "wt-a",
      "inferred"
    );

    expect(verdict.accepted).toBe(false);
    expect(agentLifecycleLedger.getEntry("t2")?.facts.worktreeId).toBe("wt-b");
  });

  it("moves every member's panel record to the destination", () => {
    seedGroup();

    usePanelStore.getState().moveTerminalToWorktree("t1", "wt-b");

    const panels = usePanelStore.getState().panelsById;
    expect(panels["t1"]?.worktreeId).toBe("wt-b");
    expect(panels["t2"]?.worktreeId).toBe("wt-b");
  });
});
