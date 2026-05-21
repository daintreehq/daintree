import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorktreeStore } from "@/store/createWorktreeStore";
import type { WorktreeSnapshot, WorktreeEventVersion } from "@shared/types";

// Host-minted versions are now `(epoch, seq)` tuples (#8403). Each fresh store
// starts at epoch "" so the first non-empty epoch is accepted as a transition;
// within an epoch the higher seq wins.
const TEST_EPOCH = "test-epoch";
let _seq = 0;
function nextV(): WorktreeEventVersion {
  return { epoch: TEST_EPOCH, seq: ++_seq };
}

function makeSnapshot(id: string, overrides: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return {
    id,
    name: id,
    branch: "main",
    path: `/repo/${id}`,
    isCurrent: false,
    isMainWorktree: false,
    modifiedCount: 0,
    changes: [],
    summary: "",
    mood: null,
    gitDir: "",
    ...overrides,
  } as unknown as WorktreeSnapshot;
}

describe("createWorktreeStore — reconnecting state", () => {
  it("starts with isReconnecting=false", () => {
    const store = createWorktreeStore();
    expect(store.getState().isReconnecting).toBe(false);
  });

  it("setReconnecting(true) flips the flag", () => {
    const store = createWorktreeStore();
    store.getState().setReconnecting(true);
    expect(store.getState().isReconnecting).toBe(true);
  });

  it("applySnapshot clears isReconnecting after successful hydration", () => {
    const store = createWorktreeStore();
    store.getState().setReconnecting(true);
    expect(store.getState().isReconnecting).toBe(true);

    const version = nextV();
    store.getState().applySnapshot([makeSnapshot("wt-1")], version);

    expect(store.getState().isReconnecting).toBe(false);
    expect(store.getState().isInitialized).toBe(true);
    expect(store.getState().worktrees.size).toBe(1);
  });

  it("applySnapshot with stale version does NOT clear isReconnecting", () => {
    const store = createWorktreeStore();

    // Advance version by applying a first snapshot
    const v1 = nextV();
    store.getState().applySnapshot([makeSnapshot("wt-1")], v1);

    // Start reconnecting, then deliver a STRICTLY older snapshot. Equal seq is
    // the host's authoritative state and is now accepted (#8403 review), so a
    // genuinely stale snapshot must carry a lower seq in the same epoch.
    store.getState().setReconnecting(true);
    store
      .getState()
      .applySnapshot([makeSnapshot("wt-stale")], { epoch: v1.epoch, seq: v1.seq - 1 });

    expect(store.getState().isReconnecting).toBe(true);
  });

  it("applyUpdate does NOT clear isReconnecting (only applySnapshot does)", () => {
    const store = createWorktreeStore();

    // Seed with a worktree so applyUpdate can modify it
    const v1 = nextV();
    store.getState().applySnapshot([makeSnapshot("wt-1")], v1);

    store.getState().setReconnecting(true);
    const v2 = nextV();
    store.getState().applyUpdate(makeSnapshot("wt-1"), v2);

    expect(store.getState().isReconnecting).toBe(true);
  });

  it("setReconnecting(false) clears the flag independently", () => {
    const store = createWorktreeStore();
    store.getState().setReconnecting(true);
    store.getState().setReconnecting(false);
    expect(store.getState().isReconnecting).toBe(false);
  });
});

describe("createWorktreeStore — reconnectingAt timestamp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with reconnectingAt=null", () => {
    const store = createWorktreeStore();
    expect(store.getState().reconnectingAt).toBeNull();
  });

  it("setReconnecting(true) captures Date.now() in reconnectingAt", () => {
    const store = createWorktreeStore();
    const before = Date.now();
    store.getState().setReconnecting(true);
    expect(store.getState().reconnectingAt).toBe(before);
  });

  it("setReconnecting(false) clears reconnectingAt to null", () => {
    const store = createWorktreeStore();
    store.getState().setReconnecting(true);
    expect(store.getState().reconnectingAt).not.toBeNull();
    store.getState().setReconnecting(false);
    expect(store.getState().reconnectingAt).toBeNull();
  });

  it("repeated setReconnecting(true) preserves the original baseline", () => {
    // During a workspace-host crash-retry loop, `onDisconnected` fires on
    // every restart. If `reconnectingAt` were re-stamped on each call, the
    // elapsed clock would reset and the escalation copy would never appear
    // before the restart budget exhausts (~14s) and `setFatalError` fires.
    const store = createWorktreeStore();
    store.getState().setReconnecting(true);
    const first = store.getState().reconnectingAt;
    vi.advanceTimersByTime(5000);
    store.getState().setReconnecting(true);
    expect(store.getState().reconnectingAt).toBe(first);
  });

  it("setReconnecting(true) after recovery captures a fresh timestamp", () => {
    const store = createWorktreeStore();
    store.getState().setReconnecting(true);
    const first = store.getState().reconnectingAt;
    vi.advanceTimersByTime(5000);
    store.getState().setReconnecting(false);
    vi.advanceTimersByTime(1000);
    store.getState().setReconnecting(true);
    const second = store.getState().reconnectingAt;
    expect(second).not.toBeNull();
    expect(second).toBeGreaterThan(first ?? 0);
  });

  it("applySnapshot normal-path clears reconnectingAt", () => {
    const store = createWorktreeStore();
    store.getState().setReconnecting(true);
    expect(store.getState().reconnectingAt).not.toBeNull();

    const version = nextV();
    store.getState().applySnapshot([makeSnapshot("wt-1")], version);

    expect(store.getState().reconnectingAt).toBeNull();
  });

  it("applySnapshot no-op early-return path clears reconnectingAt", () => {
    const store = createWorktreeStore();

    // Hydrate so the value-equality early-return path triggers on the next call
    const v1 = nextV();
    store.getState().applySnapshot([makeSnapshot("wt-1")], v1);
    store.getState().setReconnecting(true);
    expect(store.getState().reconnectingAt).not.toBeNull();

    const v2 = nextV();
    store.getState().applySnapshot([makeSnapshot("wt-1")], v2);

    expect(store.getState().reconnectingAt).toBeNull();
  });

  it("setFatalError clears reconnectingAt", () => {
    const store = createWorktreeStore();
    store.getState().setReconnecting(true);
    expect(store.getState().reconnectingAt).not.toBeNull();

    store.getState().setFatalError("host crashed");

    expect(store.getState().reconnectingAt).toBeNull();
  });

  it("stale-version applySnapshot does NOT clear reconnectingAt", () => {
    const store = createWorktreeStore();

    const v1 = nextV();
    store.getState().applySnapshot([makeSnapshot("wt-1")], v1);

    store.getState().setReconnecting(true);
    const captured = store.getState().reconnectingAt;
    // Strictly older — equal seq is now accepted (#8403 review).
    store
      .getState()
      .applySnapshot([makeSnapshot("wt-stale")], { epoch: v1.epoch, seq: v1.seq - 1 });

    expect(store.getState().reconnectingAt).toBe(captured);
  });
});

describe("createWorktreeStore — applySnapshot identity preservation", () => {
  it("preserves Map identity when every snapshot is value-equal", () => {
    const store = createWorktreeStore();

    const v1 = nextV();
    store.getState().applySnapshot([makeSnapshot("wt-1"), makeSnapshot("wt-2")], v1);
    const firstMap = store.getState().worktrees;

    const v2 = nextV();
    store.getState().applySnapshot([makeSnapshot("wt-1"), makeSnapshot("wt-2")], v2);

    expect(store.getState().worktrees).toBe(firstMap);
    expect(store.getState().version).toBe(v2);
  });

  it("rebuilds the Map when any snapshot's value differs", () => {
    const store = createWorktreeStore();

    const v1 = nextV();
    store.getState().applySnapshot([makeSnapshot("wt-1")], v1);
    const firstMap = store.getState().worktrees;

    const changed = makeSnapshot("wt-1");
    (changed as { branch: string }).branch = "feature/x";

    const v2 = nextV();
    store.getState().applySnapshot([changed], v2);

    expect(store.getState().worktrees).not.toBe(firstMap);
    expect(store.getState().worktrees.get("wt-1")?.branch).toBe("feature/x");
  });

  it("rebuilds when the snapshot set has different size", () => {
    const store = createWorktreeStore();

    const v1 = nextV();
    store.getState().applySnapshot([makeSnapshot("wt-1")], v1);
    const firstMap = store.getState().worktrees;

    const v2 = nextV();
    store.getState().applySnapshot([makeSnapshot("wt-1"), makeSnapshot("wt-2")], v2);

    expect(store.getState().worktrees).not.toBe(firstMap);
    expect(store.getState().worktrees.size).toBe(2);
  });

  it("rebuilds when only prCiStatus changes (CI flip should trigger re-render)", () => {
    const store = createWorktreeStore();

    const initial = makeSnapshot("wt-1");
    (initial as { prCiStatus?: string }).prCiStatus = "PENDING";

    const v1 = nextV();
    store.getState().applySnapshot([initial], v1);
    const firstMap = store.getState().worktrees;

    const updated = makeSnapshot("wt-1");
    (updated as { prCiStatus?: string }).prCiStatus = "SUCCESS";

    const v2 = nextV();
    store.getState().applySnapshot([updated], v2);

    // snapshotsEqual must include prCiStatus so the Map is rebuilt and
    // selectors using useShallow re-render with the new CI state.
    expect(store.getState().worktrees).not.toBe(firstMap);
    expect(store.getState().worktrees.get("wt-1")?.prCiStatus).toBe("SUCCESS");
  });

  it("rebuilds when an id is replaced (same size, different keys)", () => {
    const store = createWorktreeStore();

    const v1 = nextV();
    store.getState().applySnapshot([makeSnapshot("wt-1")], v1);
    const firstMap = store.getState().worktrees;

    const v2 = nextV();
    store.getState().applySnapshot([makeSnapshot("wt-2")], v2);

    expect(store.getState().worktrees).not.toBe(firstMap);
    expect(store.getState().worktrees.has("wt-2")).toBe(true);
    expect(store.getState().worktrees.has("wt-1")).toBe(false);
  });

  it("always rebuilds on cold start so isInitialized flips", () => {
    const store = createWorktreeStore();
    expect(store.getState().isInitialized).toBe(false);
    const initialMap = store.getState().worktrees;

    const v1 = nextV();
    store.getState().applySnapshot([], v1);

    expect(store.getState().isInitialized).toBe(true);
    expect(store.getState().worktrees).not.toBe(initialMap);
  });

  it("advances version on a no-op snapshot", () => {
    const store = createWorktreeStore();

    const v1 = nextV();
    store.getState().applySnapshot([makeSnapshot("wt-1")], v1);

    const v2 = nextV();
    store.getState().applySnapshot([makeSnapshot("wt-1")], v2);

    expect(store.getState().version).toBe(v2);
  });

  it("clears isReconnecting on a no-op snapshot", () => {
    const store = createWorktreeStore();

    const v1 = nextV();
    store.getState().applySnapshot([makeSnapshot("wt-1")], v1);
    store.getState().setReconnecting(true);

    const v2 = nextV();
    store.getState().applySnapshot([makeSnapshot("wt-1")], v2);

    expect(store.getState().isReconnecting).toBe(false);
  });
});

describe("createWorktreeStore — fatal error state", () => {
  it("setFatalError sets error, clears isReconnecting, and resets isInitialized", () => {
    const store = createWorktreeStore();

    // Simulate a fully-hydrated store before the host crashes
    const v1 = nextV();
    store.getState().applySnapshot([makeSnapshot("wt-1")], v1);
    store.getState().setReconnecting(true);
    expect(store.getState().isInitialized).toBe(true);

    store.getState().setFatalError("host crashed");

    expect(store.getState().error).toBe("host crashed");
    expect(store.getState().isReconnecting).toBe(false);
    // isInitialized must be reset so the next fetch is treated as a cold
    // start, not a silent wake refresh (which swallows fetch errors).
    expect(store.getState().isInitialized).toBe(false);
  });

  it("setFatalError clears isLoading so the error UI surfaces before first hydration", () => {
    // If the host exhausts its restart budget before the first snapshot
    // ever arrives, `isLoading` is still `true` and `worktrees` is empty.
    // `SidebarContent` checks `isLoading && worktrees.length === 0` BEFORE
    // the error branch — so without clearing `isLoading`, the Restart
    // Service button would never appear.
    const store = createWorktreeStore();
    expect(store.getState().isLoading).toBe(true);
    expect(store.getState().worktrees.size).toBe(0);

    store.getState().setFatalError("host crashed before first fetch");

    expect(store.getState().isLoading).toBe(false);
    expect(store.getState().error).toBe("host crashed before first fetch");
  });

  it("applySnapshot after setFatalError clears error and restores isInitialized", () => {
    const store = createWorktreeStore();
    store.getState().setFatalError("host crashed");
    expect(store.getState().error).toBe("host crashed");
    expect(store.getState().isInitialized).toBe(false);

    const version = nextV();
    store.getState().applySnapshot([makeSnapshot("wt-1")], version);

    expect(store.getState().error).toBeNull();
    expect(store.getState().isInitialized).toBe(true);
    expect(store.getState().worktrees.size).toBe(1);
  });
});

describe("createWorktreeStore — host epoch transitions (#8403)", () => {
  it("a snapshot from a new epoch replaces state even with a lower seq", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-old")], { epoch: "epoch-A", seq: 50 });
    expect(store.getState().worktrees.has("wt-old")).toBe(true);

    // Host restarted: new epoch, seq reset to 1. Must still win.
    store.getState().applySnapshot([makeSnapshot("wt-new")], { epoch: "epoch-B", seq: 1 });

    expect(store.getState().worktrees.has("wt-old")).toBe(false);
    expect(store.getState().worktrees.has("wt-new")).toBe(true);
    expect(store.getState().version).toEqual({ epoch: "epoch-B", seq: 1 });
  });

  it("a stale same-epoch update is rejected (lower seq)", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], { epoch: "e", seq: 10 });

    store.getState().applyUpdate(makeSnapshot("wt-1", { branch: "stale" }), { epoch: "e", seq: 9 });

    expect(store.getState().worktrees.get("wt-1")?.branch).toBe("main");
    expect(store.getState().version).toEqual({ epoch: "e", seq: 10 });
  });

  it("an update from a new epoch is always accepted", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], { epoch: "e1", seq: 99 });

    store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { branch: "post-restart" }), { epoch: "e2", seq: 1 });

    expect(store.getState().worktrees.get("wt-1")?.branch).toBe("post-restart");
    expect(store.getState().version).toEqual({ epoch: "e2", seq: 1 });
  });

  it("an equal-seq snapshot still hydrates a cold store (no init deadlock)", () => {
    // `get-all-states` reports the host's high-water seq without advancing it,
    // so a `worktree-update` racing the cold-start fetch lands at the SAME seq
    // the snapshot carries. The equal-seq snapshot must still apply or the
    // store never initializes (#8403 review finding #1).
    const store = createWorktreeStore();
    expect(store.getState().isInitialized).toBe(false);

    store.getState().applyUpdate(makeSnapshot("wt-1", { branch: "live" }), { epoch: "e", seq: 1 });
    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1"), makeSnapshot("wt-2")], { epoch: "e", seq: 1 });

    expect(store.getState().isInitialized).toBe(true);
    expect(store.getState().worktrees.size).toBe(2);
  });

  it("an equal-seq snapshot replaces stale rows after an epoch-change re-hydrate", () => {
    // After a restart the first new-epoch event advances the store to {B,1};
    // the re-hydrate's `get-all-states` returns {B,1} too. That equal-seq
    // snapshot must replace the stale epoch-A rows (#8403 review finding #2).
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("old-1")], { epoch: "A", seq: 50 });
    store.getState().applyUpdate(makeSnapshot("post-restart"), { epoch: "B", seq: 1 });
    expect(store.getState().worktrees.has("old-1")).toBe(true);

    store.getState().applySnapshot([makeSnapshot("post-restart"), makeSnapshot("fresh-2")], {
      epoch: "B",
      seq: 1,
    });

    expect(store.getState().worktrees.has("old-1")).toBe(false);
    expect(store.getState().worktrees.has("fresh-2")).toBe(true);
  });

  it("an equal-seq host removal is not dropped by an overlay at the same seq", () => {
    // Overlays reuse the current stamp (no seq bump), so the store can sit at
    // {e,5} from a renderer overlay. A host `worktree-removed` minted at the
    // same seq must still delete the row (#8403 review finding #3).
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], { epoch: "e", seq: 5 });
    // Overlay-style merge at the same seq (equal accepted).
    store.getState().applyUpdate(makeSnapshot("wt-1", { prNumber: 7 }), { epoch: "e", seq: 5 });
    expect(store.getState().worktrees.has("wt-1")).toBe(true);

    store.getState().applyRemove("wt-1", { epoch: "e", seq: 5 });

    expect(store.getState().worktrees.has("wt-1")).toBe(false);
  });
});

describe("createWorktreeStore — removal tombstones (#8403)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a late same-epoch update cannot resurrect a removed worktree within the TTL", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], { epoch: "e", seq: 1 });

    store.getState().applyRemove("wt-1", { epoch: "e", seq: 2 });
    expect(store.getState().worktrees.has("wt-1")).toBe(false);

    // A buffered worktree-update for the just-removed id arrives late.
    store.getState().applyUpdate(makeSnapshot("wt-1"), { epoch: "e", seq: 3 });

    expect(store.getState().worktrees.has("wt-1")).toBe(false);
  });

  it("an update is accepted once the tombstone TTL has elapsed", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], { epoch: "e", seq: 1 });
    store.getState().applyRemove("wt-1", { epoch: "e", seq: 2 });

    vi.advanceTimersByTime(30_001);
    store.getState().applyUpdate(makeSnapshot("wt-1"), { epoch: "e", seq: 3 });

    expect(store.getState().worktrees.has("wt-1")).toBe(true);
  });

  it("an epoch transition clears tombstones so a fresh-host update lands", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], { epoch: "e1", seq: 1 });
    store.getState().applyRemove("wt-1", { epoch: "e1", seq: 2 });
    expect(store.getState().tombstones.size).toBe(1);

    // New host run re-creates the same id — must not be suppressed.
    store.getState().applyUpdate(makeSnapshot("wt-1"), { epoch: "e2", seq: 1 });

    expect(store.getState().worktrees.has("wt-1")).toBe(true);
    expect(store.getState().tombstones.size).toBe(0);
  });

  it("a snapshot clears all tombstones (host is authoritative)", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], { epoch: "e", seq: 1 });
    store.getState().applyRemove("wt-1", { epoch: "e", seq: 2 });
    expect(store.getState().tombstones.size).toBe(1);

    store.getState().applySnapshot([makeSnapshot("wt-2")], { epoch: "e", seq: 3 });

    expect(store.getState().tombstones.size).toBe(0);
  });
});
