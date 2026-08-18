import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  isPtyPanel,
  type PanelInstance,
  type PanelLocation,
  type PtyPanelData,
} from "@shared/types/panel";
import type { DeletedWorktree } from "@/store/worktreeStore";

vi.mock("@/clients", () => ({
  terminalClient: { resize: vi.fn(), submit: vi.fn().mockResolvedValue(undefined) },
  agentSettingsClient: { get: vi.fn().mockResolvedValue(null) },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    resize: vi.fn().mockReturnValue(null),
    wake: vi.fn(),
    wakeForFocus: vi.fn(),
    getInstance: vi.fn(),
    setInputLocked: vi.fn(),
    captureBufferText: vi.fn().mockReturnValue(""),
    getAgentState: vi.fn().mockReturnValue("working"),
    addAgentStateListener: vi.fn().mockReturnValue(() => {}),
    addExitListener: vi.fn().mockReturnValue(() => {}),
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

// The helper confirms the destination is live before following. Only that one
// export is stubbed so the rest of the view-store module keeps its real shape.
const liveWorktrees = new Map<string, unknown>();
vi.mock("@/store/createWorktreeStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/createWorktreeStore")>()),
  getCurrentViewStoreOrNull: () => ({ getState: () => ({ worktrees: liveWorktrees }) }),
}));

const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
const { terminalClient } = await import("@/clients");
const { usePanelStore } = await import("@/store/panelStore");
const { useWorktreeSelectionStore } = await import("@/store/worktreeStore");
const { moveTerminalToWorktreeAndFollowRescue, isPanelProcessLive } =
  await import("../crossWorktreeMove");

/**
 * An exited terminal. A dead panel never raises the move notice, so this keeps
 * the rescue-follow suite testing selection semantics on their own. Live-panel
 * reconciliation has its own describe block below.
 */
function panel(id: string, worktreeId: string, location: PanelLocation = "grid"): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal" as const,
    cwd: "/repo",
    cols: 80,
    rows: 24,
    worktreeId,
    location,
    isVisible: location === "grid",
    runtimeStatus: "exited",
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

function deletedRow(id: string): DeletedWorktree {
  return {
    id,
    title: id,
    path: `/repo/${id}`,
    deletedAt: 1000,
    expiresAt: null,
    holdReason: null,
    pinnedBeforeWorktreeId: null,
  };
}

function setLiveWorktrees(ids: string[]): void {
  liveWorktrees.clear();
  for (const id of ids) liveWorktrees.set(id, { id });
}

/** Live worktrees with real paths, so launch-root classification can resolve. */
function setWorktreesWithPaths(entries: { id: string; path: string }[]): void {
  liveWorktrees.clear();
  for (const entry of entries) liveWorktrees.set(entry.id, entry);
}

/** A running agent pane launched in `cwd`. */
function agentPanel(id: string, worktreeId: string, cwd: string): PtyPanelData {
  return {
    ...panel(id, worktreeId),
    cwd,
    runtimeStatus: "running",
    agentState: "working",
    launchAgentId: "claude",
  };
}

function cwdOf(id: string): string | undefined {
  const p = usePanelStore.getState().panelsById[id];
  return p && isPtyPanel(p) ? p.cwd : undefined;
}

function noticeOf(id: string): string | undefined {
  const p = usePanelStore.getState().panelsById[id];
  return p && "worktreeMoveNotice" in p
    ? (p as PtyPanelData).worktreeMoveNotice?.destinationWorktreeId
    : undefined;
}

/**
 * Mirrors the panel-store subscriber `WorktreeStoreContext` installs in
 * production — the thing that makes an emptied deleted row prune itself
 * synchronously during the move. Without it the helper is being tested against
 * a world where rows never die.
 */
function wirePruneSubscriber(liveWorktreeIds: string[]): () => void {
  setLiveWorktrees(liveWorktreeIds);
  return usePanelStore.subscribe((state, prevState) => {
    if (
      state.panelIdsByWorktreeId === prevState.panelIdsByWorktreeId &&
      state.panelsById === prevState.panelsById
    ) {
      return;
    }
    if (useWorktreeSelectionStore.getState().deletedWorktrees.size === 0) return;
    useWorktreeSelectionStore.getState().pruneDeletedWorktrees(new Set(liveWorktreeIds));
  });
}

let unsubscribe: (() => void) | null = null;

beforeEach(() => {
  usePanelStore.getState().reset();
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
  setLiveWorktrees([]);
  vi.clearAllMocks();
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
});

describe("moveTerminalToWorktreeAndFollowRescue", () => {
  it("follows the rescued terminal when the drag empties the active deleted row", () => {
    seedPanels([panel("t1", "wt-dead")]);
    useWorktreeSelectionStore.getState().addDeletedWorktree(deletedRow("wt-dead"));
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-dead" });
    unsubscribe = wirePruneSubscriber(["wt-live"]);

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-live");

    const selection = useWorktreeSelectionStore.getState();
    expect(selection.activeWorktreeId).toBe("wt-live");
    expect(selection.deletedWorktrees.has("wt-dead")).toBe(false);
    // `source: "user"` is what makes the destination durable — a "focus"
    // promotion would move the active id but leave the restore target behind.
    expect(selection.restoreWorktreeId).toBe("wt-live");
  });

  it("stays put when the emptied row is not the one the user is standing on", () => {
    seedPanels([panel("t1", "wt-dead"), panel("other", "wt-elsewhere")]);
    useWorktreeSelectionStore.getState().addDeletedWorktree(deletedRow("wt-dead"));
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-elsewhere" });
    unsubscribe = wirePruneSubscriber(["wt-live", "wt-elsewhere"]);

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-live");

    const selection = useWorktreeSelectionStore.getState();
    expect(selection.deletedWorktrees.has("wt-dead")).toBe(false);
    expect(selection.activeWorktreeId).toBe("wt-elsewhere");
  });

  it("stays put when the deleted row still holds another terminal", () => {
    seedPanels([panel("t1", "wt-dead"), panel("t2", "wt-dead")]);
    useWorktreeSelectionStore.getState().addDeletedWorktree(deletedRow("wt-dead"));
    useWorktreeSelectionStore.setState({
      activeWorktreeId: "wt-dead",
      restoreWorktreeId: "wt-keep",
    });
    unsubscribe = wirePruneSubscriber(["wt-live"]);

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-live");

    const panels = usePanelStore.getState().panelsById;
    expect(panels["t1"]?.worktreeId).toBe("wt-live");
    expect(panels["t2"]?.worktreeId).toBe("wt-dead");
    const selection = useWorktreeSelectionStore.getState();
    expect(selection.deletedWorktrees.has("wt-dead")).toBe(true);
    expect(selection.activeWorktreeId).toBe("wt-dead");
    expect(selection.restoreWorktreeId).toBe("wt-keep");
  });

  it("follows once the row's only survivors are panels a dismiss would not close", () => {
    // `getDeletedWorktreeTerminalIds` excludes trash/overlay/dialog, so a row
    // holding only those is already empty as far as the prune is concerned.
    seedPanels([
      panel("t1", "wt-dead"),
      panel("binned", "wt-dead", "trash"),
      panel("assistant", "wt-dead", "overlay"),
    ]);
    useWorktreeSelectionStore.getState().addDeletedWorktree(deletedRow("wt-dead"));
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-dead" });
    unsubscribe = wirePruneSubscriber(["wt-live"]);

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-live");

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-live");
  });

  it("keeps the follow alive across a fleet-scope cycle", () => {
    seedPanels([panel("t1", "wt-dead")]);
    useWorktreeSelectionStore.getState().addDeletedWorktree(deletedRow("wt-dead"));
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-dead" });
    unsubscribe = wirePruneSubscriber(["wt-live"]);
    const token = useWorktreeSelectionStore.getState().enterFleetScope();

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-live");
    useWorktreeSelectionStore.getState().exitFleetScope(token);

    // Exiting scope restores the parked pre-scope selection verbatim. Without
    // retargeting it, that would hand the user back the pruned row and the
    // fallback would strand the rescued session on main all over again.
    const selection = useWorktreeSelectionStore.getState();
    expect(selection.activeWorktreeId).toBe("wt-live");
    expect(selection.restoreWorktreeId).toBe("wt-live");
  });

  it("does not follow to a destination the view store cannot vouch for", () => {
    seedPanels([panel("t1", "wt-dead")]);
    useWorktreeSelectionStore.getState().addDeletedWorktree(deletedRow("wt-dead"));
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-dead" });
    // The row still empties, but "wt-ghost" is absent from the live map — the
    // action layer accepts any string, and a bogus id must never become the
    // durable restore target.
    unsubscribe = wirePruneSubscriber(["wt-live"]);

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-ghost");

    const selection = useWorktreeSelectionStore.getState();
    expect(selection.activeWorktreeId).toBe("wt-dead");
    expect(selection.restoreWorktreeId).toBeNull();
  });

  it("moves a panel with no worktree of its own without touching selection", () => {
    const orphan: PtyPanelData = { ...panel("t1", "wt-a"), worktreeId: undefined };
    usePanelStore.setState({
      panelsById: { t1: orphan },
      panelIds: ["t1"],
      panelIdsByWorktreeId: {},
    });
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-a" });
    unsubscribe = wirePruneSubscriber(["wt-a", "wt-live"]);

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-live");

    expect(usePanelStore.getState().panelsById["t1"]?.worktreeId).toBe("wt-live");
    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-a");
  });

  it("never changes selection for a move between two live worktrees", () => {
    seedPanels([panel("t1", "wt-a")]);
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-a" });
    unsubscribe = wirePruneSubscriber(["wt-a", "wt-b"]);

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-b");

    expect(usePanelStore.getState().panelsById["t1"]?.worktreeId).toBe("wt-b");
    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-a");
  });

  it("follows when a grouped move carries the row's last terminals away", () => {
    seedPanels([panel("t1", "wt-dead"), panel("t2", "wt-dead")]);
    usePanelStore.setState({
      tabGroups: new Map([
        [
          "g1",
          {
            id: "g1",
            location: "grid" as const,
            worktreeId: "wt-dead",
            activeTabId: "t1",
            panelIds: ["t1", "t2"],
          },
        ],
      ]),
    });
    useWorktreeSelectionStore.getState().addDeletedWorktree(deletedRow("wt-dead"));
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-dead" });
    unsubscribe = wirePruneSubscriber(["wt-live"]);

    // Moving one grouped panel relocates the whole group, so the row empties in
    // a single move — the follow decision must come from the row's actual
    // disappearance, not from counting the panels named in the call.
    moveTerminalToWorktreeAndFollowRescue("t1", "wt-live");

    const panels = usePanelStore.getState().panelsById;
    expect(panels["t1"]?.worktreeId).toBe("wt-live");
    expect(panels["t2"]?.worktreeId).toBe("wt-live");
    const selection = useWorktreeSelectionStore.getState();
    expect(selection.deletedWorktrees.has("wt-dead")).toBe(false);
    expect(selection.activeWorktreeId).toBe("wt-live");
  });

  it("hands focus to the destination's last-focused terminal on a rescue", () => {
    seedPanels([panel("t1", "wt-dead"), panel("resident", "wt-live")]);
    useWorktreeSelectionStore.getState().addDeletedWorktree(deletedRow("wt-dead"));
    useWorktreeSelectionStore.setState({
      activeWorktreeId: "wt-dead",
      lastFocusedTerminalByWorktree: new Map([["wt-live", "resident"]]),
    });
    unsubscribe = wirePruneSubscriber(["wt-live"]);

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-live");

    // The pre-fix path cleared focus and then let the fallback select main,
    // which restored main's last-focused terminal. Landing on the destination
    // has to behave the same way — only the worktree changes.
    expect(usePanelStore.getState().focusedId).toBe("resident");
  });

  it("clears focus without selecting anything when no rescue is involved", () => {
    seedPanels([panel("t1", "wt-a")]);
    usePanelStore.getState().setFocused("t1");
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-a", restoreWorktreeId: "wt-a" });
    setLiveWorktrees(["wt-a", "wt-b"]);

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-b");

    expect(usePanelStore.getState().focusedId).toBeNull();
    const selection = useWorktreeSelectionStore.getState();
    expect(selection.activeWorktreeId).toBe("wt-a");
    expect(selection.restoreWorktreeId).toBe("wt-a");
  });

  it("leaves focus alone when the panel is already in the target worktree", () => {
    seedPanels([panel("t1", "wt-a")]);
    usePanelStore.getState().setFocused("t1");

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-a");

    expect(usePanelStore.getState().focusedId).toBe("t1");
  });

  it("leaves focus alone when the panel does not exist", () => {
    seedPanels([panel("t1", "wt-a")]);
    usePanelStore.getState().setFocused("t1");

    moveTerminalToWorktreeAndFollowRescue("ghost", "wt-b");

    expect(usePanelStore.getState().focusedId).toBe("t1");
  });
});

describe("isPanelProcessLive", () => {
  // Relocated from the deleted decision suite. Each of these is a distinct
  // signal that the process can no longer write anything, and each one
  // independently means "no banner, realign the next launch instead".
  const live = (overrides: Partial<PtyPanelData>): PtyPanelData => ({
    ...agentPanel("t1", "wt-a", "/repo/wt-a"),
    ...overrides,
  });

  it("accepts a running pane", () => {
    expect(isPanelProcessLive(live({}))).toBe(true);
  });

  it("rejects a missing pane", () => {
    expect(isPanelProcessLive(undefined)).toBe(false);
  });

  it("rejects a non-PTY pane", () => {
    const browser: PanelInstance = {
      id: "b1",
      kind: "browser",
      title: "b1",
      location: "grid",
    };
    expect(isPanelProcessLive(browser)).toBe(false);
  });

  it.each([
    ["a trashed pane", { location: "trash" as const }],
    ["an exited agent", { agentState: "exited" as const }],
    ["an exited runtime", { runtimeStatus: "exited" as const }],
    ["an errored runtime", { runtimeStatus: "error" as const }],
    ["a pane carrying an exit code", { exitCode: 0 }],
    ["a pane carrying a non-zero exit code", { exitCode: 137 }],
  ])("rejects %s", (_label, overrides) => {
    expect(isPanelProcessLive(live(overrides))).toBe(false);
  });
});

describe("moveTerminalToWorktreeAndFollowRescue — move notice (#11853)", () => {
  const WORKTREES = [
    { id: "wt-a", path: "/repo/wt-a" },
    { id: "wt-b", path: "/repo/wt-b" },
  ];

  beforeEach(() => {
    setWorktreesWithPaths(WORKTREES);
  });

  it("raises the notice on a live agent left off its launch root", () => {
    seedPanels([agentPanel("t1", "wt-a", "/repo/wt-a")]);

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-b");

    expect(noticeOf("t1")).toBe("wt-b");
  });

  it("raises the notice when the launch root cannot be classified at all", () => {
    // `unknown` is not proof of alignment — treating "can't prove it" as "it's
    // fine" is the silence this feature exists to end.
    seedPanels([agentPanel("t1", "wt-a", "/somewhere/else")]);

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-b");

    expect(noticeOf("t1")).toBe("wt-b");
  });

  it("raises no notice for a plain shell pane", () => {
    // Injecting "please continue in ..." at a shell prompt just types junk.
    const shell: PtyPanelData = { ...agentPanel("t1", "wt-a", "/repo/wt-a") };
    delete shell.launchAgentId;
    seedPanels([shell]);

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-b");

    expect(noticeOf("t1")).toBeUndefined();
  });

  it("raises no notice when the agent is already running in the destination", () => {
    seedPanels([agentPanel("t1", "wt-a", "/repo/wt-b")]);

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-b");

    expect(noticeOf("t1")).toBeUndefined();
  });

  it("realigns an exited pane's next launch instead of raising a notice", () => {
    seedPanels([{ ...panel("t1", "wt-a"), cwd: "/repo/wt-a" }]);

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-b");

    expect(noticeOf("t1")).toBeUndefined();
    expect(cwdOf("t1")).toBe("/repo/wt-b");
  });

  it("leaves an exited pane's custom cwd alone when it maps to no worktree", () => {
    // Re-homing an `unknown` cwd would silently relocate a shell the user
    // deliberately launched outside every worktree.
    seedPanels([{ ...panel("t1", "wt-a"), cwd: "/somewhere/else" }]);

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-b");

    expect(cwdOf("t1")).toBe("/somewhere/else");
  });

  it("retargets the notice when a second move lands before the first is answered", () => {
    setWorktreesWithPaths([...WORKTREES, { id: "wt-c", path: "/repo/wt-c" }]);
    seedPanels([agentPanel("t1", "wt-a", "/repo/wt-a")]);

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-b");
    moveTerminalToWorktreeAndFollowRescue("t1", "wt-c");

    expect(noticeOf("t1")).toBe("wt-c");
  });

  it("clears the notice when the panel is dragged back to its launch worktree", () => {
    seedPanels([agentPanel("t1", "wt-a", "/repo/wt-a")]);

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-b");
    expect(noticeOf("t1")).toBe("wt-b");
    moveTerminalToWorktreeAndFollowRescue("t1", "wt-a");

    expect(noticeOf("t1")).toBeUndefined();
  });

  it("gives every member of a moved tab group its own notice", () => {
    // Per panel, never per group — one click must not message four agents.
    seedPanels([agentPanel("t1", "wt-a", "/repo/wt-a"), agentPanel("t2", "wt-a", "/repo/wt-a")]);
    usePanelStore.setState({
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

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-b");

    expect(noticeOf("t1")).toBe("wt-b");
    expect(noticeOf("t2")).toBe("wt-b");
  });

  it("classifies a mixed group per member", () => {
    const dead = { ...panel("t2", "wt-a"), cwd: "/repo/wt-a" };
    seedPanels([agentPanel("t1", "wt-a", "/repo/wt-a"), dead]);
    usePanelStore.setState({
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

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-b");

    expect(noticeOf("t1")).toBe("wt-b");
    expect(noticeOf("t2")).toBeUndefined();
    expect(cwdOf("t2")).toBe("/repo/wt-b");
  });

  it("never locks input or changes the active worktree on an ordinary move", () => {
    // The whole point of #11853: the gesture stays instant. Asserted against
    // the real seam — the removed lock went through the instance service, not
    // through the panel's own `isInputLocked` field, so checking that field
    // would have proved nothing.
    seedPanels([agentPanel("t1", "wt-a", "/repo/wt-a")]);
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-a" });

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-b");

    expect(terminalInstanceService.setInputLocked).not.toHaveBeenCalled();
    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-a");
  });

  it("writes nothing into the live session on the move itself", () => {
    // Nothing reaches a running conversation without the banner's own click.
    seedPanels([agentPanel("t1", "wt-a", "/repo/wt-a")]);

    moveTerminalToWorktreeAndFollowRescue("t1", "wt-b");

    expect(terminalClient.submit).not.toHaveBeenCalled();
    expect(terminalInstanceService.addAgentStateListener).not.toHaveBeenCalled();
    expect(terminalInstanceService.captureBufferText).not.toHaveBeenCalled();
  });
});
