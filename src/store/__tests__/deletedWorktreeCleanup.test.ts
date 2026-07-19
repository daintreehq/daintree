// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { usePanelStore } from "@/store/panelStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useTerminalPendingDestructiveActionStore } from "@/store/terminalPendingDestructiveActionStore";
import { useWorktreeSelectionStore, type DeletedWorktree } from "@/store/worktreeStore";
import { notify } from "@/lib/notify";
import {
  resetDeletedWorktreeCleanupState,
  sweepDeletedWorktreeCleanup,
} from "../deletedWorktreeCleanup";

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

const NOW = 100_000;

function makeDeps(
  overrides: Partial<{
    now: () => number;
    isDragActive: () => boolean;
  }> = {}
) {
  return {
    now: () => NOW,
    isDragActive: () => false,
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
    pinnedIndex: -1,
    ...overrides,
  });
}

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

  it("holds the countdown while any drag is in progress", () => {
    addRow({ expiresAt: NOW - 1 });
    sweepDeletedWorktreeCleanup(makeDeps({ isDragActive: () => true }));

    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    expect(getExpiry()).toBe(NOW + 60_000);
  });

  it("fires even while the deleted worktree is the active selection", () => {
    // Viewing the ghost's terminals must not suppress cleanup — the visible
    // countdown is the rescue window, and deletion is the default outcome.
    addRow({ expiresAt: NOW - 1 });
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-1" });
    sweepDeletedWorktreeCleanup(makeDeps());

    expect(bulkTrashByWorktree).toHaveBeenCalledTimes(1);
  });

  it("holds the countdown while an agent in the row is still working", () => {
    setPanels([{ id: "t1", worktreeId: "wt-1", agentState: "working" }]);
    usePanelStore.setState({ bulkTrashByWorktree });
    addRow({ expiresAt: NOW - 1 });
    sweepDeletedWorktreeCleanup(makeDeps());

    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    expect(getExpiry()).toBe(NOW + 60_000);
  });

  it("holds the countdown while the row's close-confirm dialog is open", () => {
    addRow({ expiresAt: NOW - 1 });
    useTerminalPendingDestructiveActionStore.getState().request({
      kind: "deletedWorktreeDismiss",
      targetCount: 1,
      runningAgentCount: 0,
      worktreeId: "wt-1",
    });
    sweepDeletedWorktreeCleanup(makeDeps());

    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    expect(getExpiry()).toBe(NOW + 60_000);
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
    const payload = vi.mocked(notify).mock.calls[0][0];
    // Inbox-only: the sweep fires unattended, so it must never toast.
    expect(payload.priority).toBe("low");
    expect(payload.message).toContain("2 terminals");
    expect(payload.message).toContain("feature/x");
    expect(payload.context?.worktreeId).toBe("wt-1");
  });

  it("uses singular phrasing for a single surviving terminal", () => {
    addRow({ expiresAt: NOW - 1 });
    sweepDeletedWorktreeCleanup(makeDeps());

    const message = vi.mocked(notify).mock.calls[0][0].message;
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

  it("stays silent while the countdown is only being deferred", () => {
    addRow({ expiresAt: NOW - 1 });
    sweepDeletedWorktreeCleanup(makeDeps({ isDragActive: () => true }));

    expect(notify).not.toHaveBeenCalled();
  });

  it("re-arms a disarmed row when cleanup is turned back on", () => {
    usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: 0 });
    addRow({ expiresAt: NOW - 1 });
    sweepDeletedWorktreeCleanup(makeDeps());
    usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: 60 });
    sweepDeletedWorktreeCleanup(makeDeps());

    expect(getExpiry()).toBe(NOW + 60_000);
  });
});
