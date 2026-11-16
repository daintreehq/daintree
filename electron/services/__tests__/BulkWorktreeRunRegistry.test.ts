import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BulkWorktreeRunRegistry,
  MAX_ENDED_BULK_RUNS,
  _resetBulkWorktreeRunHoldsForTests,
  isBulkWorktreeRunViewHeld,
  onBulkWorktreeRunViewReleased,
} from "../BulkWorktreeRunRegistry.js";
import type {
  BulkWorktreeRunCommand,
  BulkWorktreeRunItem,
  BulkWorktreeRunSnapshot,
} from "../../../shared/types/ipc/bulkWorktreeRuns.js";

const OWNER = 7;
const OTHER = 9;

function wc(id: number, destroyed = false): Electron.WebContents {
  return { id, isDestroyed: () => destroyed } as Electron.WebContents;
}

function item(number: number, overrides: Partial<BulkWorktreeRunItem> = {}): BulkWorktreeRunItem {
  return { number, title: `Issue ${number}`, stage: "pending", attempt: 0, ...overrides };
}

function snapshot(
  runId: string,
  overrides: Partial<BulkWorktreeRunSnapshot> = {}
): BulkWorktreeRunSnapshot {
  return {
    runId,
    projectId: "ignored",
    mode: "issue",
    phase: "running",
    items: [item(1), item(2)],
    startedAt: 1,
    updatedAt: 1,
    controllable: true,
    ...overrides,
  };
}

describe("BulkWorktreeRunRegistry", () => {
  let broadcast: ReturnType<typeof vi.fn<(runs: BulkWorktreeRunSnapshot[]) => void>>;
  let sendCommand: ReturnType<
    typeof vi.fn<(ownerId: number, command: BulkWorktreeRunCommand) => boolean>
  >;
  let registry: BulkWorktreeRunRegistry;

  beforeEach(() => {
    _resetBulkWorktreeRunHoldsForTests();
    broadcast = vi.fn();
    sendCommand = vi.fn(() => true);
    registry = new BulkWorktreeRunRegistry({ broadcast, sendCommand, holdTtlMs: 1000 });
  });

  afterEach(() => {
    registry.dispose();
    vi.useRealTimers();
  });

  it("keeps each run under its own id, stamped with the publishing view's project", () => {
    registry.publish(OWNER, "proj-a", snapshot("run-a"));
    registry.publish(OTHER, "proj-b", snapshot("run-b", { items: [item(5)] }));

    const runs = registry.list();
    expect(runs.map((r) => [r.runId, r.projectId])).toEqual([
      ["run-a", "proj-a"],
      ["run-b", "proj-b"],
    ]);
    expect(broadcast).toHaveBeenLastCalledWith(runs);
  });

  it("ignores a publish for a run another view owns", () => {
    registry.publish(OWNER, "proj-a", snapshot("run-a"));
    expect(registry.publish(OTHER, "proj-b", snapshot("run-a", { phase: "done" }))).toBe(false);
    expect(registry.list()[0]).toMatchObject({ phase: "running", projectId: "proj-a" });
  });

  it("holds the view while any of its runs is live, and releases it once the last ends", () => {
    const released = vi.fn();
    const off = onBulkWorktreeRunViewReleased(released);

    registry.publish(OWNER, "proj-a", snapshot("run-a"));
    registry.publish(OWNER, "proj-a", snapshot("run-b"));
    expect(isBulkWorktreeRunViewHeld(wc(OWNER))).toBe(true);
    expect(isBulkWorktreeRunViewHeld(wc(OTHER))).toBe(false);

    registry.publish(OWNER, "proj-a", snapshot("run-a", { phase: "cancelling" }));
    registry.publish(OWNER, "proj-a", snapshot("run-a", { phase: "cancelled" }));
    expect(isBulkWorktreeRunViewHeld(wc(OWNER))).toBe(true);
    expect(released).not.toHaveBeenCalled();

    registry.publish(OWNER, "proj-a", snapshot("run-b", { phase: "done" }));
    expect(isBulkWorktreeRunViewHeld(wc(OWNER))).toBe(false);
    expect(released).toHaveBeenCalledWith(OWNER);
    off();
  });

  it("lets a hold lapse when its view stops publishing, and renews it on each publish", () => {
    vi.useFakeTimers();
    registry.publish(OWNER, "proj-a", snapshot("run-a"));
    vi.advanceTimersByTime(900);
    registry.publish(OWNER, "proj-a", snapshot("run-a", { updatedAt: 2 }));
    vi.advanceTimersByTime(900);
    expect(isBulkWorktreeRunViewHeld(wc(OWNER))).toBe(true);

    vi.advanceTimersByTime(100);
    expect(isBulkWorktreeRunViewHeld(wc(OWNER))).toBe(false);
    // The run itself is still reported as it was last seen.
    expect(registry.list()[0]?.phase).toBe("running");
  });

  it("never holds a destroyed view", () => {
    registry.publish(OWNER, "proj-a", snapshot("run-a"));
    expect(isBulkWorktreeRunViewHeld(wc(OWNER, true))).toBe(false);
  });

  it("routes a cancel to the view running the run, and refuses one for an ended run", () => {
    registry.publish(OWNER, "proj-a", snapshot("run-a"));
    expect(registry.command({ runId: "run-a", kind: "cancel" })).toEqual({ accepted: true });
    expect(sendCommand).toHaveBeenCalledWith(OWNER, { runId: "run-a", kind: "cancel" });

    registry.publish(OWNER, "proj-a", snapshot("run-a", { phase: "done" }));
    expect(registry.command({ runId: "run-a", kind: "cancel" })).toEqual({
      accepted: false,
      reason: "not-live",
    });
    expect(registry.command({ runId: "missing", kind: "cancel" })).toEqual({
      accepted: false,
      reason: "not-found",
    });
  });

  it("routes a retry only for an ended run with failures", () => {
    registry.publish(OWNER, "proj-a", snapshot("run-a"));
    expect(registry.command({ runId: "run-a", kind: "retry-failed" })).toEqual({
      accepted: false,
      reason: "busy",
    });

    registry.publish(OWNER, "proj-a", snapshot("run-a", { phase: "done" }));
    expect(registry.command({ runId: "run-a", kind: "retry-failed" })).toEqual({
      accepted: false,
      reason: "nothing-to-retry",
    });

    registry.publish(
      OWNER,
      "proj-a",
      snapshot("run-a", { phase: "done", items: [item(1, { stage: "failed" })] })
    );
    expect(registry.command({ runId: "run-a", kind: "retry-failed" })).toEqual({
      accepted: true,
    });
    expect(sendCommand).toHaveBeenLastCalledWith(OWNER, { runId: "run-a", kind: "retry-failed" });
  });

  it("holds an ended run's view before it sends the retry that wakes it", () => {
    registry.publish(
      OWNER,
      "proj-a",
      snapshot("run-a", { phase: "done", items: [item(1, { stage: "failed" })] })
    );
    expect(isBulkWorktreeRunViewHeld(wc(OWNER))).toBe(false);
    sendCommand.mockImplementation(() => {
      expect(isBulkWorktreeRunViewHeld(wc(OWNER))).toBe(true);
      return true;
    });

    expect(registry.command({ runId: "run-a", kind: "retry-failed" })).toEqual({
      accepted: true,
    });
    expect(sendCommand).toHaveBeenCalledTimes(1);

    // A view that turns it down republishes the run as it was, which lets go.
    registry.publish(
      OWNER,
      "proj-a",
      snapshot("run-a", { phase: "done", items: [item(1, { stage: "failed" })] })
    );
    expect(isBulkWorktreeRunViewHeld(wc(OWNER))).toBe(false);
  });

  it("keeps a run with a retry on its way through pruning and dismissal", () => {
    registry.publish(
      OWNER,
      "proj-a",
      snapshot("oldest", { phase: "done", items: [item(1, { stage: "failed" })] })
    );
    for (let i = 0; i < MAX_ENDED_BULK_RUNS - 1; i++) {
      registry.publish(OTHER, "proj-b", snapshot(`ended-${i}`, { phase: "done" }));
    }
    expect(registry.command({ runId: "oldest", kind: "retry-failed" })).toEqual({
      accepted: true,
    });
    expect(registry.dismiss("oldest")).toBe(false);

    // Another run ending takes the cache past its cap before the retry reports.
    registry.publish(OTHER, "proj-b", snapshot("newest", { phase: "done" }));
    expect(registry.list().map((r) => r.runId)).toContain("oldest");
    expect(isBulkWorktreeRunViewHeld(wc(OWNER))).toBe(true);
  });

  it("settles a run whose view went away, keeping every worktree that landed", () => {
    registry.publish(
      OWNER,
      "proj-a",
      snapshot("run-a", {
        items: [
          item(1, { stage: "succeeded", worktreeId: "wt-1" }),
          item(2, { stage: "terminals-spawning", worktreeId: "wt-2" }),
          item(3, { stage: "worktree-creating", attempt: 1 }),
          item(4),
        ],
      })
    );
    registry.publish(OWNER, "proj-a", snapshot("run-b", { phase: "cancelling" }));
    registry.publish(OTHER, "proj-b", snapshot("run-c"));

    registry.ownerGone(OWNER);

    const byId = Object.fromEntries(registry.list().map((r) => [r.runId, r]));
    expect(byId["run-a"]).toMatchObject({ phase: "done", controllable: false });
    expect(byId["run-a"]!.items.map((i) => [i.stage, i.worktreeId])).toEqual([
      ["succeeded", "wt-1"],
      ["interrupted", "wt-2"],
      ["interrupted", undefined],
      ["interrupted", undefined],
    ]);
    expect(byId["run-b"]).toMatchObject({ phase: "cancelled", controllable: false });
    // Another view's run is untouched.
    expect(byId["run-c"]).toMatchObject({ phase: "running", controllable: true });
    expect(isBulkWorktreeRunViewHeld(wc(OWNER))).toBe(false);
    expect(isBulkWorktreeRunViewHeld(wc(OTHER))).toBe(true);

    expect(registry.command({ runId: "run-a", kind: "retry-failed" })).toEqual({
      accepted: false,
      reason: "uncontrollable",
    });
    // A late publish from the same view id (a reloaded document) can't revive it.
    expect(registry.publish(OWNER, "proj-a", snapshot("run-a"))).toBe(false);
  });

  it("settles the run when the command can't reach its view", () => {
    sendCommand.mockReturnValue(false);
    registry.publish(OWNER, "proj-a", snapshot("run-a"));

    expect(registry.command({ runId: "run-a", kind: "cancel" })).toEqual({
      accepted: false,
      reason: "uncontrollable",
    });
    expect(registry.list()[0]).toMatchObject({ phase: "done", controllable: false });
  });

  it("keeps a live run through dismissal and forgets an ended one", () => {
    registry.publish(OWNER, "proj-a", snapshot("run-a"));
    expect(registry.dismiss("run-a")).toBe(false);
    expect(registry.list()).toHaveLength(1);

    registry.publish(OWNER, "proj-a", snapshot("run-a", { phase: "done" }));
    expect(registry.dismiss("run-a")).toBe(true);
    expect(registry.list()).toEqual([]);
    expect(broadcast).toHaveBeenLastCalledWith([]);
  });

  it("drops the oldest ended runs past the cap, never a live one", () => {
    registry.publish(OWNER, "proj-a", snapshot("live"));
    for (let i = 0; i <= MAX_ENDED_BULK_RUNS; i++) {
      registry.publish(OWNER, "proj-a", snapshot(`ended-${i}`, { phase: "done" }));
    }

    const ids = registry.list().map((r) => r.runId);
    expect(ids).toContain("live");
    expect(ids).not.toContain("ended-0");
    expect(ids).toHaveLength(MAX_ENDED_BULK_RUNS + 1);
  });
});
