import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { isPtyPanel, type PanelLocation, type PtyPanelData } from "@shared/types/panel";
import type { DeletedWorktree } from "@/store/worktreeStore";

vi.mock("@/clients", () => ({
  terminalClient: { resize: vi.fn(), submit: vi.fn().mockResolvedValue(undefined) },
  agentSettingsClient: { get: vi.fn().mockResolvedValue(null) },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
  worktreeClient: { getAll: vi.fn().mockResolvedValue([]) },
}));

const setInputLocked = vi.fn();
vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    resize: vi.fn().mockReturnValue(null),
    wake: vi.fn(),
    wakeForFocus: vi.fn(),
    getInstance: vi.fn(),
    setInputLocked: (...args: unknown[]) => setInputLocked(...args),
    captureBufferText: vi.fn().mockReturnValue(""),
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

const liveWorktrees = new Map<string, unknown>();
vi.mock("@/store/createWorktreeStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/createWorktreeStore")>()),
  getCurrentViewStoreOrNull: () => ({ getState: () => ({ worktrees: liveWorktrees }) }),
}));

const { usePanelStore } = await import("@/store/panelStore");
const { useWorktreeSelectionStore } = await import("@/store/worktreeStore");
const { useWorktreeMoveDecisionStore } = await import("@/store/worktreeMoveDecisionStore");
const { moveTerminalToWorktreeAndFollowRescue } = await import("../crossWorktreeMove");
const { resolveWorktreeMoveDecision, isPanelProcessLive } = await import("../worktreeMoveDecision");

const MAIN = "/repo";
const FEATURE = "/repo/.worktrees/feature";

function livePanel(
  id: string,
  worktreeId: string,
  cwd = MAIN,
  location: PanelLocation = "grid"
): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal" as const,
    cwd,
    cols: 80,
    rows: 24,
    worktreeId,
    location,
    isVisible: location === "grid",
  };
}

function seedPanels(panels: PtyPanelData[]): void {
  const panelIdsByWorktreeId: Record<string, string[]> = {};
  for (const p of panels) {
    const bucket = panelIdsByWorktreeId[p.worktreeId!];
    if (bucket) bucket.push(p.id);
    else panelIdsByWorktreeId[p.worktreeId!] = [p.id];
  }
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
    panelIdsByWorktreeId,
  });
}

function setWorktrees(entries: { id: string; path: string; name?: string }[]): void {
  liveWorktrees.clear();
  for (const entry of entries) liveWorktrees.set(entry.id, entry);
}

/** The decision resolves asynchronously after the synchronous move. */
async function settleDecision(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Narrow the panel union — every fixture here is a PTY panel. */
function ptyPanel(id: string): PtyPanelData | undefined {
  const panel = usePanelStore.getState().panelsById[id];
  return panel && isPtyPanel(panel) ? panel : undefined;
}

// `reset()` is async: leaving it unawaited lets it land mid-test the first time
// the decision flow yields, wiping the panels out from under the assertions.
beforeEach(async () => {
  await usePanelStore.getState().reset();
  usePanelStore.setState({
    panelsById: {},
    panelIds: [],
    panelIdsByWorktreeId: {},
    tabGroups: new Map(),
    focusedId: null,
    maximizedId: null,
    commandQueue: [],
  });
  useWorktreeSelectionStore.getState().reset();
  useWorktreeMoveDecisionStore.getState().clear();
  setWorktrees([
    { id: "wt-main", path: MAIN, name: "main" },
    { id: "wt-feature", path: FEATURE, name: "feature" },
  ]);
  setInputLocked.mockClear();
  vi.clearAllMocks();
});

afterEach(() => {
  useWorktreeMoveDecisionStore.getState().clear();
});

describe("isPanelProcessLive", () => {
  it("treats every documented exit signal as not live", () => {
    const base = livePanel("t1", "wt-main");
    expect(isPanelProcessLive(base)).toBe(true);
    expect(isPanelProcessLive({ ...base, agentState: "exited" })).toBe(false);
    expect(isPanelProcessLive({ ...base, runtimeStatus: "exited" })).toBe(false);
    expect(isPanelProcessLive({ ...base, runtimeStatus: "error" })).toBe(false);
    expect(isPanelProcessLive({ ...base, exitCode: 0 })).toBe(false);
    expect(isPanelProcessLive({ ...base, location: "trash" })).toBe(false);
    expect(isPanelProcessLive(undefined)).toBe(false);
  });
});

describe("cross-worktree move decision", () => {
  it("locks input, follows the destination, and asks before accepting divergence", async () => {
    seedPanels([livePanel("t1", "wt-main", MAIN)]);
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-main" });

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-feature");

    // Synchronous half: the panel moved, the lock is on, and the view followed
    // so the decision surface is somewhere the user can see it.
    expect(usePanelStore.getState().panelsById["t1"]?.worktreeId).toBe("wt-feature");
    expect(setInputLocked).toHaveBeenCalledWith("t1", true);
    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-feature");

    await settleDecision();

    const pending = useWorktreeMoveDecisionStore.getState().pending;
    expect(pending?.destinationWorktreeId).toBe("wt-feature");
    expect(pending?.members.map((m) => m.panelId)).toEqual(["t1"]);
    expect(pending?.members[0]?.alignment).toBe("launch-root-mismatch");
  });

  it("lets an already-aligned move through without asking, and releases the lock", async () => {
    // Launched inside the destination worktree: relabelling it is a correction,
    // not a divergence.
    seedPanels([livePanel("t1", "wt-main", `${FEATURE}/src`)]);

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-feature");
    await settleDecision();

    expect(useWorktreeMoveDecisionStore.getState().pending).toBeNull();
    expect(setInputLocked).toHaveBeenLastCalledWith("t1", false);
  });

  it("asks when the launch root cannot be resolved at all", async () => {
    // `unknown` is not proof of alignment. Treating it as such is how the
    // silent divergence happened in the first place.
    seedPanels([livePanel("t1", "wt-main", "/tmp/scratch")]);

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-feature");
    await settleDecision();

    expect(useWorktreeMoveDecisionStore.getState().pending?.members[0]?.alignment).toBe("unknown");
  });

  it("does not open the dialog when rescuing a terminal off a deleted row", async () => {
    // #11232 regression guard: the rescue drag is the escape hatch off a dead
    // row and must never be blocked.
    seedPanels([livePanel("t1", "wt-dead", MAIN)]);
    const deleted: DeletedWorktree = {
      id: "wt-dead",
      title: "wt-dead",
      path: "/repo/dead",
      deletedAt: 1000,
      expiresAt: null,
      holdReason: null,
      pinnedBeforeWorktreeId: null,
    };
    useWorktreeSelectionStore.getState().addDeletedWorktree(deleted);
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-dead" });

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-feature");
    await settleDecision();

    expect(useWorktreeMoveDecisionStore.getState().pending).toBeNull();
    expect(setInputLocked).not.toHaveBeenCalled();
    expect(usePanelStore.getState().panelsById["t1"]?.worktreeId).toBe("wt-feature");
  });

  it("skips the decision for an exited panel but aligns its next-launch cwd", async () => {
    // It can't write anything now, but its next restart would reuse the stale
    // cwd and reproduce the bug.
    seedPanels([{ ...livePanel("t1", "wt-main", MAIN), runtimeStatus: "exited" }]);

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-feature");
    await settleDecision();

    expect(useWorktreeMoveDecisionStore.getState().pending).toBeNull();
    expect(ptyPanel("t1")?.cwd).toBe(FEATURE);
  });

  it("leaves an exited panel's cwd alone when it belongs to no worktree", async () => {
    // Only a proven mismatch is re-homed — silently moving a shell the user
    // deliberately launched in /tmp would be its own surprise.
    seedPanels([{ ...livePanel("t1", "wt-main", "/tmp/scratch"), runtimeStatus: "exited" }]);

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-feature");
    await settleDecision();

    expect(ptyPanel("t1")?.cwd).toBe("/tmp/scratch");
  });

  it("decides a tab group as one unit while naming every member", async () => {
    seedPanels([livePanel("t1", "wt-main", MAIN), livePanel("t2", "wt-main", MAIN)]);
    usePanelStore.setState({
      tabGroups: new Map([
        [
          "g1",
          {
            id: "g1",
            location: "grid" as const,
            worktreeId: "wt-main",
            activeTabId: "t1",
            panelIds: ["t1", "t2"],
          },
        ],
      ]),
    });

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-feature");
    await settleDecision();

    const pending = useWorktreeMoveDecisionStore.getState().pending;
    expect(pending?.groupId).toBe("g1");
    expect(pending?.members.map((m) => m.panelId).sort()).toEqual(["t1", "t2"]);
    // One decision, not one per member.
    expect(setInputLocked.mock.calls.filter(([, locked]) => locked === true)).toHaveLength(2);
  });

  it("records consent and the drift baseline when the user keeps the process put", async () => {
    liveWorktrees.set("wt-main", {
      id: "wt-main",
      path: MAIN,
      name: "main",
      worktreeChanges: { headOid: "abc123" },
    });
    seedPanels([livePanel("t1", "wt-main", MAIN)]);

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-feature");
    await settleDecision();

    const pending = useWorktreeMoveDecisionStore.getState().pending!;
    await resolveWorktreeMoveDecision(pending, "move-only");

    const optOut = ptyPanel("t1")?.worktreeMoveOptOut;
    expect(optOut).toMatchObject({
      acknowledgedCwd: MAIN,
      acknowledgedWorktreeId: "wt-feature",
      launchWorktreeId: "wt-main",
      sourceHeadOid: "abc123",
    });
    expect(useWorktreeMoveDecisionStore.getState().pending).toBeNull();
    expect(setInputLocked).toHaveBeenLastCalledWith("t1", false);
  });

  it("restores the panel's worktree on cancel, not just its geometry", async () => {
    seedPanels([livePanel("t1", "wt-main", MAIN)]);
    const { useLayoutUndoStore } = await import("@/store/layoutUndoStore");
    useLayoutUndoStore.getState().pushLayoutSnapshot();

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-feature");
    await settleDecision();

    const pending = useWorktreeMoveDecisionStore.getState().pending!;
    await resolveWorktreeMoveDecision(pending, "cancel");

    expect(usePanelStore.getState().panelsById["t1"]?.worktreeId).toBe("wt-main");
    expect(ptyPanel("t1")?.worktreeMoveOptOut).toBeUndefined();
    expect(setInputLocked).toHaveBeenLastCalledWith("t1", false);
  });

  it("releases the lock even when the outcome handler throws", async () => {
    seedPanels([livePanel("t1", "wt-main", MAIN)]);
    moveTerminalToWorktreeAndFollowRescue("t1", "wt-feature");
    await settleDecision();

    const pending = useWorktreeMoveDecisionStore.getState().pending!;
    const store = usePanelStore.getState();
    const original = store.transferPanelToWorktree;
    usePanelStore.setState({
      transferPanelToWorktree: () => Promise.reject(new Error("boom")),
    });

    await expect(resolveWorktreeMoveDecision(pending, "transfer")).rejects.toThrow("boom");

    // A panel left locked forever is worse than a failed transfer.
    expect(setInputLocked).toHaveBeenLastCalledWith("t1", false);
    expect(useWorktreeMoveDecisionStore.getState().pending).toBeNull();
    usePanelStore.setState({ transferPanelToWorktree: original });
  });
});
