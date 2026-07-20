// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { usePanelStore } from "@/store/panelStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useTerminalPendingDestructiveActionStore } from "@/store/terminalPendingDestructiveActionStore";
import { useWorktreeSelectionStore, type DeletedWorktree } from "@/store/worktreeStore";
import { notify } from "@/lib/notify";
import {
  DELETED_WORKTREE_AGENT_HOLD_CAP_MS,
  DELETED_WORKTREE_SWEEP_INTERVAL_MS,
  DELETED_WORKTREE_TRANSIENT_HOLD_CAP_MS,
  resetDeletedWorktreeCleanupState,
  sweepDeletedWorktreeCleanup,
} from "../deletedWorktreeCleanup";

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

const NOW = 100_000;

function makeDeps(
  overrides: Partial<{
    now: () => number;
    isDragActive: () => boolean;
    isViewCached: () => boolean;
    maxObservedGapMs: number;
  }> = {}
) {
  return {
    now: () => NOW,
    isDragActive: () => false,
    isViewCached: () => false,
    // These cases step time coarsely to describe the state machine, so every
    // gap is declared observed — the row was on screen the whole time. The
    // unobserved-gap credit has its own cases below and in the lifecycle suite.
    maxObservedGapMs: Number.POSITIVE_INFINITY,
    ...overrides,
  };
}

function addRow(overrides: Partial<DeletedWorktree> = {}): void {
  useWorktreeSelectionStore.getState().addDeletedWorktree({
    id: "wt-1",
    title: "feature/x",
    path: "/repo/x",
    deletedAt: 0,
    expiresAt: null,
    holdReason: null,
    pinnedIndex: -1,
    ...overrides,
  });
}

function getRow(): DeletedWorktree | undefined {
  return useWorktreeSelectionStore.getState().deletedWorktrees.get("wt-1");
}

function getHoldReason(): DeletedWorktree["holdReason"] | undefined {
  return getRow()?.holdReason;
}

/** Remaining the row would display at `now` — the value the countdown shows. */
function getRemainingAt(now: number): number | null {
  const expiresAt = getRow()?.expiresAt;
  return expiresAt == null ? null : expiresAt - now;
}

/**
 * Arm a row with no hold condition active and run it down `consumedMs` into
 * its countdown. Returns that instant, so a test can begin a hold at a known
 * time rather than inferring when the sweep first saw the condition.
 */
function armAndAdvance(consumedMs: number): number {
  addRow();
  sweepDeletedWorktreeCleanup(makeDeps());
  const at = NOW + consumedMs;
  sweepDeletedWorktreeCleanup(makeDeps({ now: () => at }));
  return at;
}

const TTL_MS = 60_000;

function setPanels(
  entries: Array<{
    id: string;
    worktreeId: string;
    agentState?: string;
    location?: string;
    runtimeStatus?: string;
  }>
): void {
  const panelsById: Record<string, unknown> = {};
  const panelIdsByWorktreeId: Record<string, string[]> = {};
  for (const entry of entries) {
    panelsById[entry.id] = {
      id: entry.id,
      kind: "terminal",
      title: entry.id,
      worktreeId: entry.worktreeId,
      location: entry.location ?? "grid",
      agentState: entry.agentState,
      runtimeStatus: entry.runtimeStatus,
    };
    (panelIdsByWorktreeId[entry.worktreeId] ??= []).push(entry.id);
  }
  usePanelStore.setState({
    panelIds: entries.map((e) => e.id),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    panelsById: panelsById as never,
    panelIdsByWorktreeId,
  });
}

function getExpiry(): number | null | undefined {
  return useWorktreeSelectionStore.getState().deletedWorktrees.get("wt-1")?.expiresAt;
}

let bulkTrashByWorktree: ReturnType<typeof vi.fn<(worktreeId: string) => void>>;

beforeEach(() => {
  vi.mocked(notify).mockClear();
  resetDeletedWorktreeCleanupState();
  useWorktreeSelectionStore.getState().reset();
  useTerminalPendingDestructiveActionStore.getState().clear();
  usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: 60 });
  bulkTrashByWorktree = vi.fn<(worktreeId: string) => void>();
  usePanelStore.setState({ bulkTrashByWorktree });
  setPanels([{ id: "t1", worktreeId: "wt-1" }]);
});

describe("sweepDeletedWorktreeCleanup", () => {
  it("arms an unarmed row with the full configured TTL", () => {
    addRow();
    sweepDeletedWorktreeCleanup(makeDeps());

    expect(getExpiry()).toBe(NOW + 60_000);
    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
  });

  it("trashes the row's terminals once the deadline passes", () => {
    addRow({ expiresAt: NOW - 1 });
    sweepDeletedWorktreeCleanup(makeDeps());

    expect(bulkTrashByWorktree).toHaveBeenCalledTimes(1);
    expect(bulkTrashByWorktree).toHaveBeenCalledWith("wt-1");
  });

  it("fires only once even if the row lingers across further sweeps", () => {
    addRow({ expiresAt: NOW - 1 });
    sweepDeletedWorktreeCleanup(makeDeps());
    sweepDeletedWorktreeCleanup(makeDeps());
    sweepDeletedWorktreeCleanup(makeDeps());

    expect(bulkTrashByWorktree).toHaveBeenCalledTimes(1);
  });

  it("re-fires for a fresh row after the original was pruned and re-recorded", () => {
    addRow({ expiresAt: NOW - 1 });
    sweepDeletedWorktreeCleanup(makeDeps());
    useWorktreeSelectionStore.getState().dismissDeletedWorktree("wt-1");
    // Fresh rows always start unarmed; the sweep arms them, then fires once
    // the deadline passes.
    addRow();
    sweepDeletedWorktreeCleanup(makeDeps());
    expect(getExpiry()).toBe(NOW + 60_000);
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => NOW + 60_001 }));

    expect(bulkTrashByWorktree).toHaveBeenCalledTimes(2);
  });

  it("holds the countdown at its remaining while any drag is in progress", () => {
    // Two thirds spent before the drag starts: the hold must preserve the
    // third that is left, not hand back a fresh full window.
    const held = armAndAdvance(40_000);
    const deps = { isDragActive: () => true };

    sweepDeletedWorktreeCleanup(makeDeps({ ...deps, now: () => held }));
    const pinned = getRemainingAt(held);
    sweepDeletedWorktreeCleanup(makeDeps({ ...deps, now: () => held + 5_000 }));

    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    // Frozen where it stood, and demonstrably not snapped back to full — the
    // re-arm-to-full is what held rows open forever.
    expect(getRemainingAt(held + 5_000)).toBe(pinned);
    expect(pinned).toBeLessThan(TTL_MS);
    expect(getHoldReason()).toBe("drag");
  });

  it("fires even while the deleted worktree is the active selection", () => {
    // Viewing the ghost's terminals must not suppress cleanup — the visible
    // countdown is the rescue window, and deletion is the default outcome.
    addRow({ expiresAt: NOW - 1 });
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    sweepDeletedWorktreeCleanup(makeDeps());

    expect(bulkTrashByWorktree).toHaveBeenCalledTimes(1);
  });

  it("holds the countdown at its remaining while an agent in the row is still working", () => {
    const held = armAndAdvance(40_000);

    setPanels([{ id: "t1", worktreeId: "wt-1", agentState: "working" }]);
    usePanelStore.setState({ bulkTrashByWorktree });
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => held }));
    const pinned = getRemainingAt(held);
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => held + 5_000 }));

    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    expect(getRemainingAt(held + 5_000)).toBe(pinned);
    expect(pinned).toBeLessThan(TTL_MS);
    expect(getHoldReason()).toBe("agent");
  });

  it("holds the countdown at its remaining while the row's close-confirm dialog is open", () => {
    const held = armAndAdvance(40_000);

    useTerminalPendingDestructiveActionStore.getState().request({
      kind: "deletedWorktreeDismiss",
      targetCount: 1,
      runningAgentCount: 0,
      worktreeId: "wt-1",
    });
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => held }));
    const pinned = getRemainingAt(held);
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => held + 5_000 }));

    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    expect(getRemainingAt(held + 5_000)).toBe(pinned);
    expect(pinned).toBeLessThan(TTL_MS);
    expect(getHoldReason()).toBe("confirm");
  });

  it("does not defer on a stale working state whose runtime already exited", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1", agentState: "working", runtimeStatus: "exited" }]);
    usePanelStore.setState({ bulkTrashByWorktree });
    addRow({ expiresAt: NOW - 1 });
    sweepDeletedWorktreeCleanup(makeDeps());

    expect(bulkTrashByWorktree).toHaveBeenCalledTimes(1);
  });

  it("re-arms an armed row when the TTL preference lengthens", () => {
    addRow();
    sweepDeletedWorktreeCleanup(makeDeps());
    expect(getExpiry()).toBe(NOW + 60_000);

    usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: 300 });
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => NOW + 10_000 }));

    expect(getExpiry()).toBe(NOW + 10_000 + 300_000);
    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
  });

  it("re-arms to the shorter TTL rather than honoring the old longer deadline", () => {
    usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: 300 });
    addRow();
    sweepDeletedWorktreeCleanup(makeDeps());
    expect(getExpiry()).toBe(NOW + 300_000);

    usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: 30 });
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => NOW + 1_000 }));

    expect(getExpiry()).toBe(NOW + 1_000 + 30_000);
    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
  });

  it("disarms rows and never fires when cleanup is off", () => {
    usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: 0 });
    addRow({ expiresAt: NOW - 1 });
    sweepDeletedWorktreeCleanup(makeDeps());

    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    expect(getExpiry()).toBeNull();
  });

  it("records an inbox-only notification naming the terminals it trashed", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-1" },
    ]);
    usePanelStore.setState({ bulkTrashByWorktree });
    addRow({ expiresAt: NOW - 1 });
    sweepDeletedWorktreeCleanup(makeDeps());

    expect(notify).toHaveBeenCalledTimes(1);
    const call = vi.mocked(notify).mock.calls[0];
    expect(call).toBeDefined();
    const payload = call![0];
    // Inbox-only: the sweep fires unattended, so it must never toast.
    expect(payload.priority).toBe("low");
    expect(payload.message).toContain("2 terminals");
    expect(payload.message).toContain("feature/x");
    expect(payload.context?.worktreeId).toBe("wt-1");
  });

  it("uses singular phrasing for a single surviving terminal", () => {
    addRow({ expiresAt: NOW - 1 });
    sweepDeletedWorktreeCleanup(makeDeps());

    expect(notify).toHaveBeenCalledTimes(1);
    const call = vi.mocked(notify).mock.calls[0];
    expect(call).toBeDefined();
    const message = call![0].message;
    expect(message).toContain("1 terminal ");
    expect(message).not.toContain("terminals");
  });

  it("stays silent when the sweep had no surviving terminals to trash", () => {
    setPanels([]);
    usePanelStore.setState({ bulkTrashByWorktree });
    addRow({ expiresAt: NOW - 1 });
    sweepDeletedWorktreeCleanup(makeDeps());

    expect(bulkTrashByWorktree).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("stays silent while the countdown is only being held", () => {
    const held = armAndAdvance(59_000);
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => held + 5_000, isDragActive: () => true }));

    expect(notify).not.toHaveBeenCalled();
    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
  });

  it("collapses a same-tick burst into one inbox entry (#11260)", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-2" },
      { id: "t3", worktreeId: "wt-2" },
      { id: "t4", worktreeId: "wt-3" },
    ]);
    usePanelStore.setState({ bulkTrashByWorktree });
    addRow({ id: "wt-1", title: "feature/a", expiresAt: NOW - 1 });
    addRow({ id: "wt-2", title: "feature/b", expiresAt: NOW - 1 });
    addRow({ id: "wt-3", title: "feature/c", expiresAt: NOW - 1 });
    sweepDeletedWorktreeCleanup(makeDeps());

    expect(bulkTrashByWorktree).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(notify).mock.calls[0]![0];
    expect(payload.priority).toBe("low");
    expect(payload.message).toContain("3 deleted worktrees");
    expect(payload.message).toContain("4 terminals");
    // No single worktree owns a multi-row sweep, so the entry must not pin one.
    expect(payload.context?.worktreeId).toBeUndefined();
  });

  it("counts only the rows that actually expired on this tick", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-2" },
    ]);
    usePanelStore.setState({ bulkTrashByWorktree });
    addRow({ id: "wt-1", title: "feature/a", expiresAt: NOW - 1 });
    // Still counting down — it must not appear in this tick's summary.
    addRow({ id: "wt-2", title: "feature/b", expiresAt: NOW + 30_000 });
    sweepDeletedWorktreeCleanup(makeDeps());

    expect(notify).toHaveBeenCalledTimes(1);
    const message = vi.mocked(notify).mock.calls[0]![0].message;
    expect(message).toContain("feature/a");
    expect(message).not.toContain("feature/b");
  });

  it("holds every previewed row while the grouped clear dialog is open", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-2" },
    ]);
    usePanelStore.setState({ bulkTrashByWorktree });
    addRow({ id: "wt-1", title: "feature/a", expiresAt: NOW - 1 });
    addRow({ id: "wt-2", title: "feature/b", expiresAt: NOW - 1 });
    useTerminalPendingDestructiveActionStore.getState().request({
      kind: "deletedWorktreeGroupDismiss",
      targetCount: 2,
      runningAgentCount: 0,
      preview: [
        { worktreeId: "wt-1", worktreeTitle: "feature/a", terminals: [] },
        { worktreeId: "wt-2", worktreeTitle: "feature/b", terminals: [] },
      ],
    });
    sweepDeletedWorktreeCleanup(makeDeps());

    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("only holds rows the grouped clear is actually previewing", () => {
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-2" },
    ]);
    usePanelStore.setState({ bulkTrashByWorktree });
    addRow({ id: "wt-1", title: "feature/a", expiresAt: NOW - 1 });
    addRow({ id: "wt-2", title: "feature/b", expiresAt: NOW - 1 });
    useTerminalPendingDestructiveActionStore.getState().request({
      kind: "deletedWorktreeGroupDismiss",
      targetCount: 1,
      runningAgentCount: 0,
      preview: [{ worktreeId: "wt-1", worktreeTitle: "feature/a", terminals: [] }],
    });
    sweepDeletedWorktreeCleanup(makeDeps());

    expect(bulkTrashByWorktree).toHaveBeenCalledTimes(1);
    expect(bulkTrashByWorktree).toHaveBeenCalledWith("wt-2");
  });

  it("re-arms a disarmed row when cleanup is turned back on", () => {
    usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: 0 });
    addRow({ expiresAt: NOW - 1 });
    sweepDeletedWorktreeCleanup(makeDeps());
    usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: 60 });
    sweepDeletedWorktreeCleanup(makeDeps());

    expect(getExpiry()).toBe(NOW + 60_000);
  });

  it("resumes from the preserved remaining once the hold clears", () => {
    const held = armAndAdvance(40_000);

    sweepDeletedWorktreeCleanup(makeDeps({ now: () => held, isDragActive: () => true }));
    const pinned = getRemainingAt(held);
    const releasedAt = held + 10_000;
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => releasedAt }));

    // Picks up where it stopped — the 10s spent held is not charged, and the
    // row is not handed a fresh window either.
    expect(getRemainingAt(releasedAt)).toBe(pinned);
    expect(getHoldReason()).toBeNull();
  });

  it("gives up on a drag that never clears and fires once its cap is spent", () => {
    const held = armAndAdvance(40_000);
    const deps = { isDragActive: () => true };

    // Still inside the transient cap: holding, nothing trashed.
    sweepDeletedWorktreeCleanup(makeDeps({ ...deps, now: () => held }));
    const pinned = getRemainingAt(held) ?? 0;
    const beforeCap = held + DELETED_WORKTREE_TRANSIENT_HOLD_CAP_MS - 1_000;
    sweepDeletedWorktreeCleanup(makeDeps({ ...deps, now: () => beforeCap }));
    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    expect(getHoldReason()).toBe("drag");

    // Past the cap the hold gives up: the preserved countdown resumes rather
    // than the row being trashed on the spot.
    const afterCap = held + DELETED_WORKTREE_TRANSIENT_HOLD_CAP_MS + 1_000;
    sweepDeletedWorktreeCleanup(makeDeps({ ...deps, now: () => afterCap }));
    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    expect(getHoldReason()).toBeNull();
    expect(getRemainingAt(afterCap)).toBe(pinned);

    // ...and then it actually fires, even though the drag flag never cleared.
    sweepDeletedWorktreeCleanup(makeDeps({ ...deps, now: () => afterCap + pinned }));
    expect(bulkTrashByWorktree).toHaveBeenCalledTimes(1);
  });

  it("lets a working agent hold far longer than a drag before giving up", () => {
    const held = armAndAdvance(40_000);
    setPanels([{ id: "t1", worktreeId: "wt-1", agentState: "working" }]);
    usePanelStore.setState({ bulkTrashByWorktree });
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => held }));

    // A drag would have surrendered by now; a working agent must not, because
    // trash only holds a terminal for TRASH_TTL_MS before killing the PTY.
    const pastTransientCap = held + DELETED_WORKTREE_TRANSIENT_HOLD_CAP_MS + 60_000;
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => pastTransientCap }));
    expect(getHoldReason()).toBe("agent");

    sweepDeletedWorktreeCleanup(
      makeDeps({ now: () => held + DELETED_WORKTREE_AGENT_HOLD_CAP_MS + 1_000 })
    );
    expect(getHoldReason()).toBeNull();
  });

  it("does not let an exhausted hold restart itself on the next tick", () => {
    const held = armAndAdvance(40_000);
    const deps = { isDragActive: () => true };
    sweepDeletedWorktreeCleanup(makeDeps({ ...deps, now: () => held }));
    const pinned = getRemainingAt(held) ?? 0;
    expect(getHoldReason()).toBe("drag");

    // The condition is still true, so the hold clock must not be cleared and
    // restarted — that is what let a permanent condition hold forever.
    const afterCap = held + DELETED_WORKTREE_TRANSIENT_HOLD_CAP_MS + 1_000;
    sweepDeletedWorktreeCleanup(makeDeps({ ...deps, now: () => afterCap }));
    sweepDeletedWorktreeCleanup(makeDeps({ ...deps, now: () => afterCap + 1_000 }));
    expect(getHoldReason()).toBeNull();
    // Released, not fired: the row still owes its preserved countdown.
    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    // And the countdown is genuinely running again, not re-pinned.
    expect(getRemainingAt(afterCap + 1_000)).toBe(pinned - 1_000);

    sweepDeletedWorktreeCleanup(makeDeps({ ...deps, now: () => afterCap + pinned }));
    sweepDeletedWorktreeCleanup(makeDeps({ ...deps, now: () => afterCap + pinned + 1_000 }));
    expect(bulkTrashByWorktree).toHaveBeenCalledTimes(1);
  });

  it("eventually trashes a row an agent held past its cap", () => {
    const held = armAndAdvance(40_000);
    setPanels([{ id: "t1", worktreeId: "wt-1", agentState: "working" }]);
    usePanelStore.setState({ bulkTrashByWorktree });
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => held }));
    const pinned = getRemainingAt(held) ?? 0;

    const afterCap = held + DELETED_WORKTREE_AGENT_HOLD_CAP_MS + 1_000;
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => afterCap }));
    expect(bulkTrashByWorktree).not.toHaveBeenCalled();

    // The agent never stops working, and the row still goes — that is the
    // whole "eventually gives up" guarantee.
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => afterCap + pinned }));
    expect(bulkTrashByWorktree).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("eventually trashes a row an abandoned close-confirm held past its cap", () => {
    const held = armAndAdvance(40_000);
    useTerminalPendingDestructiveActionStore.getState().request({
      kind: "deletedWorktreeDismiss",
      targetCount: 1,
      runningAgentCount: 0,
      worktreeId: "wt-1",
    });
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => held }));
    const pinned = getRemainingAt(held) ?? 0;
    expect(getHoldReason()).toBe("confirm");

    // The dialog is never answered — the sweep must not wait on it forever.
    const afterCap = held + DELETED_WORKTREE_TRANSIENT_HOLD_CAP_MS + 1_000;
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => afterCap }));
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => afterCap + pinned }));

    expect(bulkTrashByWorktree).toHaveBeenCalledTimes(1);
  });

  it("falls through an exhausted drag to a still-eligible working agent", () => {
    const held = armAndAdvance(40_000);
    setPanels([{ id: "t1", worktreeId: "wt-1", agentState: "working" }]);
    usePanelStore.setState({ bulkTrashByWorktree });
    const deps = { isDragActive: () => true };

    sweepDeletedWorktreeCleanup(makeDeps({ ...deps, now: () => held }));
    expect(getHoldReason()).toBe("drag");

    // Drag outranks agent while both are eligible; once the drag's shorter cap
    // is spent the agent keeps holding under its own, longer one.
    const afterDragCap = held + DELETED_WORKTREE_TRANSIENT_HOLD_CAP_MS + 1_000;
    sweepDeletedWorktreeCleanup(makeDeps({ ...deps, now: () => afterDragCap }));
    expect(getHoldReason()).toBe("agent");
    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
  });

  it("bounds the total hold even as the reason changes underneath it", () => {
    const held = armAndAdvance(40_000);
    setPanels([{ id: "t1", worktreeId: "wt-1", agentState: "working" }]);
    usePanelStore.setState({ bulkTrashByWorktree });

    // Alternating conditions must not each restart the clock: the whole
    // continuous hold is measured from when it began.
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => held, isDragActive: () => true }));
    sweepDeletedWorktreeCleanup(
      makeDeps({ now: () => held + DELETED_WORKTREE_AGENT_HOLD_CAP_MS - 1_000 })
    );
    expect(getHoldReason()).toBe("agent");

    sweepDeletedWorktreeCleanup(
      makeDeps({
        now: () => held + DELETED_WORKTREE_AGENT_HOLD_CAP_MS + 1_000,
        isDragActive: () => true,
      })
    );
    expect(getHoldReason()).toBeNull();
  });

  it("re-captures the held remaining against the new TTL when the preference changes", () => {
    const held = armAndAdvance(40_000);
    const deps = { isDragActive: () => true };
    sweepDeletedWorktreeCleanup(makeDeps({ ...deps, now: () => held + 1_000 }));

    usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: 30 });
    const at = held + 2_000;
    sweepDeletedWorktreeCleanup(makeDeps({ ...deps, now: () => at }));

    // A remaining captured against the old TTL is meaningless under the new
    // one — and would make the card's bar (which divides by the current TTL)
    // overflow. The row re-arms to a full window of the new TTL instead.
    expect(getRemainingAt(at)).toBe(30_000);
    expect(getHoldReason()).toBe("drag");
  });

  it("credits a gap between sweeps back to the deadline instead of spending it", () => {
    // The sweep runs at 1 Hz, so a gap this large means it did not run: the
    // window was minimized (Chromium throttles hidden timers to roughly one a
    // minute), the view was cached, or the machine slept. None of that is time
    // the user could have watched the countdown in.
    const observed = { maxObservedGapMs: DELETED_WORKTREE_SWEEP_INTERVAL_MS * 2 };
    addRow();
    sweepDeletedWorktreeCleanup(makeDeps({ ...observed }));
    const at = NOW + 30 * 60_000;
    sweepDeletedWorktreeCleanup(makeDeps({ ...observed, now: () => at }));

    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    expect(getRemainingAt(at)).toBe(TTL_MS);
  });

  it("still spends time across the ordinary tick-by-tick cadence", () => {
    // The mirror of the case above: normal 1 Hz sweeps must not be mistaken for
    // unobserved gaps, or the countdown would never move at all.
    const observed = { maxObservedGapMs: DELETED_WORKTREE_SWEEP_INTERVAL_MS * 2 };
    addRow();
    sweepDeletedWorktreeCleanup(makeDeps({ ...observed }));
    let at = NOW;
    for (let tick = 0; tick < 5; tick++) {
      at += DELETED_WORKTREE_SWEEP_INTERVAL_MS;
      sweepDeletedWorktreeCleanup(makeDeps({ ...observed, now: () => at }));
    }

    expect(getRemainingAt(at)).toBe(TTL_MS - 5 * DELETED_WORKTREE_SWEEP_INTERVAL_MS);
  });

  it("does not let an unobserved gap spend a hold's cap", () => {
    const observed = { maxObservedGapMs: DELETED_WORKTREE_SWEEP_INTERVAL_MS * 2 };
    setPanels([{ id: "t1", worktreeId: "wt-1", agentState: "working" }]);
    usePanelStore.setState({ bulkTrashByWorktree });
    addRow();
    sweepDeletedWorktreeCleanup(makeDeps({ ...observed }));
    expect(getHoldReason()).toBe("agent");

    // Cached for longer than the agent cap. If the cap counted that, the row
    // would wake with its protection already gone and trash a working agent.
    const at = NOW + DELETED_WORKTREE_AGENT_HOLD_CAP_MS + 60_000;
    sweepDeletedWorktreeCleanup(makeDeps({ ...observed, now: () => at }));

    expect(getHoldReason()).toBe("agent");
    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
  });

  it("performs no store write and no trash while the project view is cached", () => {
    addRow({ expiresAt: NOW - 1 });
    const before = useWorktreeSelectionStore.getState().deletedWorktrees;

    sweepDeletedWorktreeCleanup(makeDeps({ isViewCached: () => true }));

    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    // Same map reference — nothing about a view nobody can see was touched.
    expect(useWorktreeSelectionStore.getState().deletedWorktrees).toBe(before);
  });

  it("holds one row without touching another row's countdown", () => {
    // Everything the sweep remembers lives in module-level maps keyed by row
    // id, so a leak between rows would be silent — and an app-wide drag holds
    // every ghost row at once, which is exactly when it would bite.
    setPanels([
      { id: "t1", worktreeId: "wt-1" },
      { id: "t2", worktreeId: "wt-2", agentState: "working" },
    ]);
    usePanelStore.setState({ bulkTrashByWorktree });
    addRow();
    addRow({ id: "wt-2", title: "feature/y", path: "/repo/y" });
    sweepDeletedWorktreeCleanup(makeDeps());

    // wt-2 holds on its working agent; wt-1 has nothing holding it.
    const at = NOW + 30_000;
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => at }));
    const rows = useWorktreeSelectionStore.getState().deletedWorktrees;
    expect(rows.get("wt-1")?.holdReason).toBeNull();
    expect(rows.get("wt-2")?.holdReason).toBe("agent");
    expect((rows.get("wt-1")?.expiresAt ?? 0) - at).toBeLessThan(
      (rows.get("wt-2")?.expiresAt ?? 0) - at
    );

    // The unheld row expires on schedule while the held one stays.
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => NOW + 61_000 }));
    expect(bulkTrashByWorktree).toHaveBeenCalledTimes(1);
    expect(bulkTrashByWorktree).toHaveBeenCalledWith("wt-1");
    expect(
      useWorktreeSelectionStore.getState().deletedWorktrees.get("wt-2")?.holdReason
    ).toBe("agent");
  });

  it("does not let a re-recorded row inherit the previous row's hold", () => {
    const held = armAndAdvance(40_000);
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => held, isDragActive: () => true }));
    expect(getHoldReason()).toBe("drag");

    useWorktreeSelectionStore.getState().dismissDeletedWorktree("wt-1");
    addRow();
    const at = held + 1_000;
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => at }));

    // A fresh row under a reused id starts from a clean full window, not the
    // remaining its predecessor was holding.
    expect(getRemainingAt(at)).toBe(TTL_MS);
    expect(getHoldReason()).toBeNull();
  });

  it("clears hold state when cleanup is switched off mid-hold", () => {
    const held = armAndAdvance(40_000);
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => held + 1_000, isDragActive: () => true }));
    expect(getHoldReason()).toBe("drag");

    usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: 0 });
    sweepDeletedWorktreeCleanup(makeDeps({ now: () => held + 2_000, isDragActive: () => true }));

    expect(getExpiry()).toBeNull();
    expect(getHoldReason()).toBeNull();
  });
});
