import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorktreeStore } from "@/store/createWorktreeStore";
import type { WorktreeSnapshot, WorktreeEventVersion } from "@shared/types";
import type { PluginWorktreeLinked } from "@shared/types/plugin";
import { BUILTIN_GITHUB_PROVIDER_ID } from "@shared/utils/forgeProviderIds";

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
});

describe("createWorktreeStore — reconnectingAt timestamp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
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

// Comfortably past any plausible suppression window without restating its
// length — the point is that a stamped comparison ignores the clock entirely.
const TOMBSTONE_WINDOW_OVERSHOOT_MS = 60_000;

// Past any plausible fence lifetime. A stamped fence is deliberately kept far
// longer than the suppression window, so this has to clear a much bigger gap.
const FENCE_LIFETIME_OVERSHOOT_MS = 24 * 60 * 60_000;

describe("createWorktreeStore — same-path re-creation (#11994)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // A worktree id is its path, so deleting and re-creating at the same location
  // reuses the id and lands inside the removal tombstone's suppression window.
  // The monitor incarnation is what separates the two cases: the host builds a
  // new monitor for the new worktree, while the buffered update the tombstone
  // exists to suppress is closure-bound to the torn-down one.
  it("accepts a higher-generation update inside the suppression window", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { generation: 4 })], { epoch: "e", seq: 1 });
    store.getState().applyRemove("wt-1", { epoch: "e", seq: 2 }, 4);
    expect(store.getState().worktrees.has("wt-1")).toBe(false);

    vi.advanceTimersByTime(10_000);
    const applied = store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { generation: 5 }), { epoch: "e", seq: 3 });

    expect(applied).toBe(true);
    expect(store.getState().worktrees.has("wt-1")).toBe(true);
    expect(store.getState().tombstones.has("wt-1")).toBe(false);
  });

  it("still suppresses a same-generation update inside the window", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { generation: 4 })], { epoch: "e", seq: 1 });
    store.getState().applyRemove("wt-1", { epoch: "e", seq: 2 }, 4);

    // The buffered pre-delete poll: same monitor, so same stamp, even though
    // the host minted it a higher seq than the removal.
    const applied = store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { generation: 4 }), { epoch: "e", seq: 3 });

    expect(applied).toBe(false);
    expect(store.getState().worktrees.has("wt-1")).toBe(false);
  });

  it("takes the removed row's generation when the event omits one", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { generation: 4 })], { epoch: "e", seq: 1 });
    store.getState().applyRemove("wt-1", { epoch: "e", seq: 2 });

    store.getState().applyUpdate(makeSnapshot("wt-1", { generation: 5 }), { epoch: "e", seq: 3 });

    expect(store.getState().worktrees.has("wt-1")).toBe(true);
  });

  it("rejects a stale-incarnation update after the re-created row is live", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1", { generation: 4, branch: "old" })], {
      epoch: "e",
      seq: 1,
    });
    store.getState().applyRemove("wt-1", { epoch: "e", seq: 2 }, 4);
    store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { generation: 5, branch: "new" }), { epoch: "e", seq: 3 });

    // The torn-down monitor's in-flight poll finally resolves and emits.
    const applied = store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { generation: 4, branch: "old" }), { epoch: "e", seq: 4 });

    expect(applied).toBe(false);
    expect(store.getState().worktrees.get("wt-1")?.branch).toBe("new");
  });

  it("keeps accepting same-generation updates for a live row", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { generation: 5 })], { epoch: "e", seq: 1 });

    const applied = store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { generation: 5, branch: "renamed" }), {
        epoch: "e",
        seq: 2,
      });

    expect(applied).toBe(true);
    expect(store.getState().worktrees.get("wt-1")?.branch).toBe("renamed");
  });

  it.each([
    ["the update is unstamped", undefined, 4],
    ["the tombstone is unstamped", 5, undefined],
  ])("falls back to the suppression window when %s", (_label, updateGen, tombstoneGen) => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { generation: tombstoneGen })], { epoch: "e", seq: 1 });
    store.getState().applyRemove("wt-1", { epoch: "e", seq: 2 }, tombstoneGen);

    const applied = store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { generation: updateGen }), { epoch: "e", seq: 3 });

    expect(applied).toBe(false);
    expect(store.getState().worktrees.has("wt-1")).toBe(false);
  });

  it("keeps suppressing a stale incarnation once the suppression window lapses", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { generation: 4 })], { epoch: "e", seq: 1 });
    store.getState().applyRemove("wt-1", { epoch: "e", seq: 2 }, 4);

    // A poll can outlive the window — its watchdog does not cancel the
    // underlying git call — so the wall clock must not decide a case both
    // sides carry an incarnation for.
    vi.advanceTimersByTime(TOMBSTONE_WINDOW_OVERSHOOT_MS);
    const applied = store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { generation: 4 }), { epoch: "e", seq: 3 });

    expect(applied).toBe(false);
    expect(store.getState().worktrees.has("wt-1")).toBe(false);
  });

  it("keeps a stamped fence across a snapshot that still omits the worktree", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { generation: 4 })], { epoch: "e", seq: 1 });
    store.getState().applyRemove("wt-1", { epoch: "e", seq: 2 }, 4);

    // The host re-hydrates and agrees the worktree is gone. Dropping the fence
    // here would leave the dead monitor's next poll free to resurrect it.
    store.getState().applySnapshot([makeSnapshot("wt-2")], { epoch: "e", seq: 3 });
    const applied = store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { generation: 4 }), { epoch: "e", seq: 4 });

    expect(applied).toBe(false);
    expect(store.getState().worktrees.has("wt-1")).toBe(false);
  });

  it("retires the fence once a snapshot reports the id alive again", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { generation: 4 })], { epoch: "e", seq: 1 });
    store.getState().applyRemove("wt-1", { epoch: "e", seq: 2 }, 4);

    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { generation: 5 })], { epoch: "e", seq: 3 });

    expect(store.getState().tombstones.has("wt-1")).toBe(false);
    expect(store.getState().worktrees.has("wt-1")).toBe(true);
  });

  it("records the event's generation for an id the store never held", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-other")], { epoch: "e", seq: 1 });

    // No outgoing row to fall back to, so the event's own stamp is the only
    // thing that can seed the fence.
    store.getState().applyRemove("wt-1", { epoch: "e", seq: 2 }, 4);

    expect(
      store.getState().applyUpdate(makeSnapshot("wt-1", { generation: 4 }), { epoch: "e", seq: 3 })
    ).toBe(false);
    expect(
      store.getState().applyUpdate(makeSnapshot("wt-1", { generation: 5 }), { epoch: "e", seq: 4 })
    ).toBe(true);
  });

  it("adopts a newer incarnation even when nothing else about the row changed", () => {
    const store = createWorktreeStore();
    const snapshot = makeSnapshot("wt-1", { generation: 4 });
    store.getState().applySnapshot([snapshot], { epoch: "e", seq: 1 });

    // Value-equal apart from the stamp. Collapsing this as "no change" would
    // leave the row judging later events against the dead monitor's fence.
    store.getState().applyUpdate({ ...snapshot, generation: 5 }, { epoch: "e", seq: 2 });

    expect(store.getState().worktrees.get("wt-1")?.generation).toBe(5);
    expect(
      store.getState().applyUpdate({ ...snapshot, generation: 4 }, { epoch: "e", seq: 3 })
    ).toBe(false);
  });

  it("does not spend the event counter rejecting a stale incarnation", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { generation: 5 })], { epoch: "e", seq: 1 });

    store.getState().applyUpdate(makeSnapshot("wt-1", { generation: 4 }), { epoch: "e", seq: 9 });

    // Burning the counter on a rejection would make an in-flight snapshot
    // minted at a lower seq look stale, stranding the row it carries.
    expect(store.getState().version.seq).toBe(1);
    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { generation: 5 }), makeSnapshot("wt-2")], {
        epoch: "e",
        seq: 2,
      });
    expect(store.getState().worktrees.has("wt-2")).toBe(true);
  });

  it("retires a stamped fence only once it is far older than any in-flight poll", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { generation: 4 })], { epoch: "e", seq: 1 });
    store.getState().applyRemove("wt-1", { epoch: "e", seq: 2 }, 4);

    // Reaping happens on write, so a later unrelated removal is what sweeps it.
    vi.advanceTimersByTime(TOMBSTONE_WINDOW_OVERSHOOT_MS);
    store.getState().applyRemove("wt-2", { epoch: "e", seq: 3 }, 9);
    expect(store.getState().tombstones.has("wt-1")).toBe(true);

    vi.advanceTimersByTime(FENCE_LIFETIME_OVERSHOOT_MS);
    store.getState().applyRemove("wt-3", { epoch: "e", seq: 4 }, 9);
    expect(store.getState().tombstones.has("wt-1")).toBe(false);
  });

  it("accepts a lower generation from a restarted host", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { generation: 9 })], { epoch: "e1", seq: 5 });
    store.getState().applyRemove("wt-1", { epoch: "e1", seq: 6 }, 9);

    // A restart resets the host's counter, so the new run's first monitor can
    // carry a lower stamp than the tombstone. The epoch transition clears the
    // tombstones before any incarnation comparison, so it must still land.
    const applied = store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { generation: 1 }), { epoch: "e2", seq: 1 });

    expect(applied).toBe(true);
    expect(store.getState().worktrees.has("wt-1")).toBe(true);
  });
});

describe("createWorktreeStore — manual issue associations (#8079)", () => {
  it("applySnapshot merges associations over auto-detected issue (MANUAL_OVER_AUTO)", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot(
        [makeSnapshot("wt-1", { issueNumber: 11, issueTitle: "Auto detected" })],
        nextV(),
        { "wt-1": { issueNumber: 42, issueTitle: "Manual issue" } }
      );

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBe(42);
    expect(wt?.issueTitle).toBe("Manual issue");
    expect(store.getState().manualAssociations.get("wt-1")?.issueNumber).toBe(42);
  });

  it("applyUpdate preserves a manual association the snapshot omits", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV(), {
      "wt-1": { issueNumber: 42, issueTitle: "Manual issue" },
    });

    // A worktree-update with no issue fields must NOT clobber the manual assoc.
    store.getState().applyUpdate(makeSnapshot("wt-1", { branch: "feature/x" }), nextV());

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBe(42);
    expect(wt?.issueTitle).toBe("Manual issue");
    expect(wt?.branch).toBe("feature/x");
  });

  it("setManualAssociation re-merges the existing snapshot immediately", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());

    store.getState().setManualAssociation("wt-1", { issueNumber: 99, issueTitle: "Attached" });

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBe(99);
    expect(wt?.issueTitle).toBe("Attached");
  });

  it("clearManualAssociation stops resurrecting the issue on the next update", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV(), {
      "wt-1": { issueNumber: 42, issueTitle: "Manual issue" },
    });

    store.getState().clearManualAssociation("wt-1");
    store.getState().applyUpdate(makeSnapshot("wt-1", { issueNumber: undefined }), nextV());

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBeUndefined();
    expect(store.getState().manualAssociations.has("wt-1")).toBe(false);
  });

  it("preserves the previous title when the issue number is unchanged", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot(
        [makeSnapshot("wt-1", { issueNumber: 7, issueTitle: "Loaded title" })],
        nextV()
      );

    // Poll re-fetch drops the title but keeps the same issue number.
    store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { issueNumber: 7, issueTitle: undefined }), nextV());

    expect(store.getState().worktrees.get("wt-1")?.issueTitle).toBe("Loaded title");
  });

  it("clears the title when the issue number changes", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { issueNumber: 7, issueTitle: "Old title" })], nextV());

    store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { issueNumber: 8, issueTitle: undefined }), nextV());

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBe(8);
    expect(wt?.issueTitle).toBeUndefined();
  });

  it("applySnapshot without associations preserves the cached map", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV(), {
      "wt-1": { issueNumber: 42, issueTitle: "Manual issue" },
    });

    // A later refresh whose association IPC failed passes `undefined`.
    store.getState().applySnapshot([makeSnapshot("wt-1", { branch: "feature/x" })], nextV());

    expect(store.getState().manualAssociations.get("wt-1")?.issueNumber).toBe(42);
    expect(store.getState().worktrees.get("wt-1")?.issueNumber).toBe(42);
    expect(store.getState().worktrees.get("wt-1")?.branch).toBe("feature/x");
  });

  it("a stale-version applySnapshot does not revert a newer applyUpdate", () => {
    const store = createWorktreeStore();
    // Version minted while the snapshot data was "fresh".
    const snapshotVersion = nextV();
    // A worktree-update races ahead during the association fetch.
    store.getState().applyUpdate(makeSnapshot("wt-1", { branch: "feature/new" }), nextV());

    // The now-stale snapshot tries to apply with the older version.
    store.getState().applySnapshot([makeSnapshot("wt-1", { branch: "old" })], snapshotVersion);

    expect(store.getState().worktrees.get("wt-1")?.branch).toBe("feature/new");
  });

  it("manual association overrides an issue-detected-style update (MANUAL_OVER_AUTO)", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV());
    store.getState().setManualAssociation("wt-1", { issueNumber: 42, issueTitle: "Manual" });

    // issue-detected builds a snapshot with a different (auto) issue.
    store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { issueNumber: 99, issueTitle: "Auto detected" }), nextV());

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBe(42);
    expect(wt?.issueTitle).toBe("Manual");
  });

  it("setFatalError drops cached manual associations", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1")], nextV(), {
      "wt-1": { issueNumber: 42, issueTitle: "Manual issue" },
    });

    store.getState().setFatalError("host crashed");

    expect(store.getState().manualAssociations.size).toBe(0);
    expect(store.getState().isInitialized).toBe(false);
  });
});

describe("createWorktreeStore — linked PR preservation (#8870)", () => {
  function makePr(number: number, title: string): PluginWorktreeLinked["pr"] {
    return {
      ref: { providerId: "github", owner: "acme", repo: "demo", number, rawData: null },
      title,
      url: `https://example/pr/${number}`,
      state: "open",
    };
  }

  const linkedWithPr: PluginWorktreeLinked = {
    providerId: "github",
    pr: makePr(123, "Fix the thing"),
  };

  it("preserves existing linked.pr when an update omits the linked field", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1", { linked: linkedWithPr })], nextV());

    // Startup-race scenario: a worktree-update fires before initializePRService
    // populates `_linked`. The host emits the snapshot without a `linked` key.
    store.getState().applyUpdate(makeSnapshot("wt-1", { branch: "feature/x" }), nextV());

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.linked).toEqual(linkedWithPr);
    expect(wt?.branch).toBe("feature/x");
  });

  it("preserves existing linked.pr when an update has linked: undefined", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1", { linked: linkedWithPr })], nextV());

    store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { branch: "feature/x", linked: undefined }), nextV());

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.linked).toEqual(linkedWithPr);
  });

  it("clears existing linked when an update has linked: null (explicit clear)", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1", { linked: linkedWithPr })], nextV());

    // Branch switch -> WorktreeMonitor.clearLinked() emits `linked: null`.
    store.getState().applyUpdate(makeSnapshot("wt-1", { linked: null }), nextV());

    expect(store.getState().worktrees.get("wt-1")?.linked).toBeNull();
  });

  it("replaces existing linked when an update carries a different linked object", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1", { linked: linkedWithPr })], nextV());

    const replacement: PluginWorktreeLinked = {
      providerId: "github",
      pr: makePr(456, "New PR"),
    };
    store.getState().applyUpdate(makeSnapshot("wt-1", { linked: replacement }), nextV());

    expect(store.getState().worktrees.get("wt-1")?.linked).toEqual(replacement);
  });

  it("clears existing linked when a later null arrives after a series of omitted updates", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1", { linked: linkedWithPr })], nextV());

    // PR service hasn't run yet — several updates omit `linked`.
    store.getState().applyUpdate(makeSnapshot("wt-1", { branch: "a" }), nextV());
    store.getState().applyUpdate(makeSnapshot("wt-1", { branch: "b" }), nextV());
    expect(store.getState().worktrees.get("wt-1")?.linked).toEqual(linkedWithPr);

    // PR service finally finishes and reports "no PR found" — host emits null.
    store.getState().applyUpdate(makeSnapshot("wt-1", { linked: null }), nextV());

    expect(store.getState().worktrees.get("wt-1")?.linked).toBeNull();
  });

  it("replaces linked when only the CI counts or base branch move", () => {
    const ci = (failed: number) => ({
      state: "failure" as const,
      total: 5,
      passed: 5 - failed,
      failed,
      pending: 0,
      rawData: null,
    });
    const withCi = (failed: number, baseRef = "develop"): PluginWorktreeLinked => ({
      providerId: "github",
      pr: { ...makePr(123, "Fix the thing")!, ciStatus: ci(failed), baseRef },
    });
    const store = createWorktreeStore();
    // Same prLastUpdatedAt throughout: the host no longer bumps it for
    // unchanged PRs, so it can't be what carries these changes.
    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { linked: withCi(1), prLastUpdatedAt: 1 })], nextV());

    store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { linked: withCi(2), prLastUpdatedAt: 1 }), nextV());
    expect(store.getState().worktrees.get("wt-1")?.linked?.pr?.ciStatus?.failed).toBe(2);

    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { linked: withCi(2, "main"), prLastUpdatedAt: 1 }),
        nextV()
      );
    expect(store.getState().worktrees.get("wt-1")?.linked?.pr?.baseRef).toBe("main");
  });

  it("preserves linked.pr when applySnapshot omits the linked field", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1", { linked: linkedWithPr })], nextV());

    // A later get-all-states snapshot during the startup window omits `linked`.
    store.getState().applySnapshot([makeSnapshot("wt-1", { branch: "feature/x" })], nextV());

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.linked).toEqual(linkedWithPr);
    expect(wt?.branch).toBe("feature/x");
  });

  it("preserves an explicit null clear through a subsequent undefined update", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1", { linked: linkedWithPr })], nextV());

    store.getState().applyUpdate(makeSnapshot("wt-1", { linked: null }), nextV());
    expect(store.getState().worktrees.get("wt-1")?.linked).toBeNull();

    // A later update with `linked` omitted must not resurrect the prior linked object.
    store.getState().applyUpdate(makeSnapshot("wt-1", { branch: "feature/x" }), nextV());

    expect(store.getState().worktrees.get("wt-1")?.linked).toBeNull();
  });
});

describe("createWorktreeStore — issue number carried by the linked PR (#12381)", () => {
  function githubPr(number: number): PluginWorktreeLinked {
    return {
      providerId: BUILTIN_GITHUB_PROVIDER_ID,
      pr: {
        ref: {
          providerId: BUILTIN_GITHUB_PROVIDER_ID,
          owner: "daintreehq",
          repo: "daintree",
          number,
          rawData: null,
        },
        url: `https://github.com/daintreehq/daintree/pull/${number}`,
        state: "open",
      },
    };
  }

  it("drops a parsed issue number and its title when the linked GitHub PR carries it", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot(
      [
        makeSnapshot("wt-1", {
          issueNumber: 12189,
          issueTitle: "Stale title",
          branchDerivedTitle: "Native assistant",
          linked: githubPr(12189),
        }),
      ],
      nextV()
    );

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBeUndefined();
    expect(wt?.issueTitle).toBeUndefined();
    expect(wt?.branchDerivedTitle).toBe("Native assistant");
    expect(wt?.linked?.pr?.ref.number).toBe(12189);
  });

  it("drops it when an update omits linked and the stored row carries the PR", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot([makeSnapshot("wt-1", { linked: githubPr(12189) })], nextV());

    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { branch: "feature/native-daintree-assistant", issueNumber: 12189 }),
        nextV()
      );

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.branch).toBe("feature/native-daintree-assistant");
    expect(wt?.issueNumber).toBeUndefined();
  });

  it("clears a title the unchanged-number flicker rule would otherwise restore", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot(
        [makeSnapshot("wt-1", { issueNumber: 12189, issueTitle: "Stale title" })],
        nextV()
      );
    expect(store.getState().worktrees.get("wt-1")?.issueTitle).toBe("Stale title");

    store.getState().applyUpdate(
      makeSnapshot("wt-1", {
        issueNumber: 12189,
        issueTitle: undefined,
        linked: githubPr(12189),
      }),
      nextV()
    );

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBeUndefined();
    expect(wt?.issueTitle).toBeUndefined();
    expect(wt?.linked?.pr?.ref.number).toBe(12189);
  });

  it("lets a manual association with the PR's number win (MANUAL_OVER_AUTO)", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot(
        [makeSnapshot("wt-1", { issueNumber: 12189, linked: githubPr(12189) })],
        nextV(),
        { "wt-1": { issueNumber: 12189, issueTitle: "Chosen by hand" } }
      );

    const wt = store.getState().worktrees.get("wt-1");
    expect(wt?.issueNumber).toBe(12189);
    expect(wt?.issueTitle).toBe("Chosen by hand");
  });

  it("keeps equal numbers on a forge that numbers merge requests separately", () => {
    const store = createWorktreeStore();
    store.getState().applySnapshot(
      [
        makeSnapshot("wt-1", {
          issueNumber: 12,
          linked: {
            providerId: "acme.gitlab",
            pr: {
              ref: {
                providerId: "acme.gitlab",
                owner: "acme",
                repo: "demo",
                number: 12,
                rawData: null,
              },
              url: "https://gitlab.acme.test/acme/demo/-/merge_requests/12",
              state: "open",
            },
          },
        }),
      ],
      nextV()
    );

    expect(store.getState().worktrees.get("wt-1")?.issueNumber).toBe(12);
  });
});

// Freshness (lastGitStatusCheckedAt) advances on EVERY completed host poll —
// including polls where nothing user-visible changed. It is tracked in the
// statusCheckedAt side map so a quiet poll can't churn the worktrees Map
// identity and fan out to every whole-map subscriber.
describe("createWorktreeStore — statusCheckedAt freshness side map", () => {
  it("a freshness-only update advances statusCheckedAt without a new worktrees Map identity", () => {
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { lastGitStatusCheckedAt: 1_000 }), nextV());
    const mapBefore = store.getState().worktrees;
    const snapshotBefore = store.getState().worktrees.get("wt-1");

    // Same content, newer freshness stamp — the quiet-poll shape.
    store.getState().applyUpdate(makeSnapshot("wt-1", { lastGitStatusCheckedAt: 2_000 }), nextV());

    expect(store.getState().worktrees).toBe(mapBefore);
    expect(store.getState().worktrees.get("wt-1")).toBe(snapshotBefore);
    expect(store.getState().statusCheckedAt.get("wt-1")).toBe(2_000);
  });

  it("a content change still produces a new Map identity and records freshness", () => {
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { lastGitStatusCheckedAt: 1_000 }), nextV());
    const mapBefore = store.getState().worktrees;

    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { modifiedCount: 3, lastGitStatusCheckedAt: 2_000 }),
        nextV()
      );

    expect(store.getState().worktrees).not.toBe(mapBefore);
    expect(store.getState().worktrees.get("wt-1")?.modifiedCount).toBe(3);
    expect(store.getState().statusCheckedAt.get("wt-1")).toBe(2_000);
  });

  it("an identical freshness stamp keeps the statusCheckedAt identity stable", () => {
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { lastGitStatusCheckedAt: 1_000 }), nextV());
    const freshnessBefore = store.getState().statusCheckedAt;

    store.getState().applyUpdate(makeSnapshot("wt-1", { lastGitStatusCheckedAt: 1_000 }), nextV());

    expect(store.getState().statusCheckedAt).toBe(freshnessBefore);
  });

  it("applySnapshot rebuilds freshness for all worktrees and prunes removed ids", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot(
        [
          makeSnapshot("wt-1", { lastGitStatusCheckedAt: 1_000 }),
          makeSnapshot("wt-2", { lastGitStatusCheckedAt: 1_500 }),
        ],
        nextV()
      );
    expect(store.getState().statusCheckedAt.get("wt-1")).toBe(1_000);
    expect(store.getState().statusCheckedAt.get("wt-2")).toBe(1_500);

    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { lastGitStatusCheckedAt: 2_000 })], nextV());
    expect(store.getState().statusCheckedAt.get("wt-1")).toBe(2_000);
    expect(store.getState().statusCheckedAt.has("wt-2")).toBe(false);
  });

  it("a value-equal snapshot with fresher stamps updates freshness but not the worktrees identity", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { lastGitStatusCheckedAt: 1_000 })], nextV());
    const mapBefore = store.getState().worktrees;

    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { lastGitStatusCheckedAt: 2_000 })], nextV());

    expect(store.getState().worktrees).toBe(mapBefore);
    expect(store.getState().statusCheckedAt.get("wt-1")).toBe(2_000);
  });

  it("applyRemove drops the worktree's freshness entry", () => {
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { lastGitStatusCheckedAt: 1_000 }), nextV());
    expect(store.getState().statusCheckedAt.has("wt-1")).toBe(true);

    store.getState().applyRemove("wt-1", nextV());

    expect(store.getState().statusCheckedAt.has("wt-1")).toBe(false);
    expect(store.getState().worktrees.has("wt-1")).toBe(false);
  });
});

// workingTreeChangedAt is the raw filesystem-write stamp (#11330). Like
// lastGitStatusCheckedAt it advances on events that change nothing else in the
// snapshot, so it lives in the workingTreeChangedAtById side map to keep the
// worktrees Map identity stable on a timestamp-only bump. Unlike freshness, it
// is independent of git status — a write into a gitignored path advances it
// without moving worktreeChanges.
describe("createWorktreeStore — workingTreeChangedAt side map", () => {
  it("a timestamp-only update advances the side map without a new worktrees Map identity", () => {
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { workingTreeChangedAt: 1_000 }), nextV());
    const mapBefore = store.getState().worktrees;
    const snapshotBefore = store.getState().worktrees.get("wt-1");

    store.getState().applyUpdate(makeSnapshot("wt-1", { workingTreeChangedAt: 2_000 }), nextV());

    expect(store.getState().worktrees).toBe(mapBefore);
    expect(store.getState().worktrees.get("wt-1")).toBe(snapshotBefore);
    expect(store.getState().workingTreeChangedAtById.get("wt-1")).toBe(2_000);
  });

  it("advances independently of git status — no lastGitStatusCheckedAt, no content change", () => {
    // This is the issue's core: a write into a gitignored folder moves the fs
    // stamp while git-status content (and freshness) stays put.
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { workingTreeChangedAt: 1_000 }), nextV());
    const freshnessBefore = store.getState().statusCheckedAt;
    const mapBefore = store.getState().worktrees;

    store.getState().applyUpdate(makeSnapshot("wt-1", { workingTreeChangedAt: 2_000 }), nextV());

    expect(store.getState().workingTreeChangedAtById.get("wt-1")).toBe(2_000);
    // Neither the worktrees identity nor the freshness map moved.
    expect(store.getState().worktrees).toBe(mapBefore);
    expect(store.getState().statusCheckedAt).toBe(freshnessBefore);
  });

  it("a content change produces a new Map identity and records the fs stamp", () => {
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { workingTreeChangedAt: 1_000 }), nextV());
    const mapBefore = store.getState().worktrees;

    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { modifiedCount: 3, workingTreeChangedAt: 2_000 }),
        nextV()
      );

    expect(store.getState().worktrees).not.toBe(mapBefore);
    expect(store.getState().worktrees.get("wt-1")?.modifiedCount).toBe(3);
    expect(store.getState().workingTreeChangedAtById.get("wt-1")).toBe(2_000);
  });

  it("an identical fs stamp keeps the side-map identity stable", () => {
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { workingTreeChangedAt: 1_000 }), nextV());
    const before = store.getState().workingTreeChangedAtById;

    store.getState().applyUpdate(makeSnapshot("wt-1", { workingTreeChangedAt: 1_000 }), nextV());

    expect(store.getState().workingTreeChangedAtById).toBe(before);
  });

  it("applySnapshot rebuilds the side map for all worktrees and prunes removed ids", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot(
        [
          makeSnapshot("wt-1", { workingTreeChangedAt: 1_000 }),
          makeSnapshot("wt-2", { workingTreeChangedAt: 1_500 }),
        ],
        nextV()
      );
    expect(store.getState().workingTreeChangedAtById.get("wt-1")).toBe(1_000);
    expect(store.getState().workingTreeChangedAtById.get("wt-2")).toBe(1_500);

    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { workingTreeChangedAt: 2_000 })], nextV());
    expect(store.getState().workingTreeChangedAtById.get("wt-1")).toBe(2_000);
    expect(store.getState().workingTreeChangedAtById.has("wt-2")).toBe(false);
  });

  it("a value-equal snapshot with a fresher fs stamp updates the side map, not worktrees identity", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { workingTreeChangedAt: 1_000 })], nextV());
    const mapBefore = store.getState().worktrees;

    store
      .getState()
      .applySnapshot([makeSnapshot("wt-1", { workingTreeChangedAt: 2_000 })], nextV());

    expect(store.getState().worktrees).toBe(mapBefore);
    expect(store.getState().workingTreeChangedAtById.get("wt-1")).toBe(2_000);
  });

  it("applyRemove drops the worktree's fs stamp entry", () => {
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { workingTreeChangedAt: 1_000 }), nextV());
    expect(store.getState().workingTreeChangedAtById.has("wt-1")).toBe(true);

    store.getState().applyRemove("wt-1", nextV());

    expect(store.getState().workingTreeChangedAtById.has("wt-1")).toBe(false);
    expect(store.getState().worktrees.has("wt-1")).toBe(false);
  });
});

// The affected-directory side map (#12244) rides the same stamp: it lets the
// file browser re-list only what a burst touched. Its `previousAt` chain is the
// only thing standing between "scoped refresh" and "silently dropped a burst",
// so these assert the chain, not just the payload.
describe("createWorktreeStore — workingTreeChangedDirs side map", () => {
  it("records the burst's directories alongside the stamp they belong to", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { workingTreeChangedAt: 1_000, workingTreeChangedDirs: ["src"] }),
        nextV()
      );

    expect(store.getState().workingTreeChangedDirsById.get("wt-1")).toMatchObject({
      at: 1_000,
      previousAt: null,
      dirs: ["src"],
    });
  });

  it("chains previousAt across consecutive updates so a consumer can prove continuity", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { workingTreeChangedAt: 1_000, workingTreeChangedDirs: ["src"] }),
        nextV()
      );
    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { workingTreeChangedAt: 2_000, workingTreeChangedDirs: ["electron"] }),
        nextV()
      );

    expect(store.getState().workingTreeChangedDirsById.get("wt-1")).toMatchObject({
      at: 2_000,
      previousAt: 1_000,
      dirs: ["electron"],
    });
  });

  it("never carries a previous burst's directories forward onto a new stamp", () => {
    // The absent field means "this host described no burst for this stamp",
    // which is not the same as "the same directories again" — inheriting would
    // scope a refresh to directories that had nothing to do with the change.
    const store = createWorktreeStore();
    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { workingTreeChangedAt: 1_000, workingTreeChangedDirs: ["src"] }),
        nextV()
      );
    store.getState().applyUpdate(makeSnapshot("wt-1", { workingTreeChangedAt: 2_000 }), nextV());

    expect(store.getState().workingTreeChangedDirsById.get("wt-1")).toMatchObject({
      at: 2_000,
      previousAt: 1_000,
      dirs: null,
    });
  });

  it("keeps a known-empty burst distinct from an undescribed one", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { workingTreeChangedAt: 1_000, workingTreeChangedDirs: [] }),
        nextV()
      );

    expect(store.getState().workingTreeChangedDirsById.get("wt-1")?.dirs).toEqual([]);
  });

  it("holds the map identity when a snapshot repeats the stamp it already recorded", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { workingTreeChangedAt: 1_000, workingTreeChangedDirs: ["src"] }),
        nextV()
      );
    const before = store.getState().workingTreeChangedDirsById;

    // A git-status pass re-emits the same stamp; nothing new happened.
    store.getState().applyUpdate(
      makeSnapshot("wt-1", {
        workingTreeChangedAt: 1_000,
        workingTreeChangedDirs: ["src"],
        modifiedCount: 3,
      }),
      nextV()
    );

    expect(store.getState().workingTreeChangedDirsById).toBe(before);
  });

  it("refuses to claim continuity on the authoritative snapshot path", () => {
    // A full snapshot is the host's whole state and can jump across flushes the
    // store never saw one by one, so the record it writes must say so — the
    // consumer then takes one full re-read rather than scoping to a set that
    // may be missing a burst.
    const store = createWorktreeStore();
    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { workingTreeChangedAt: 1_000, workingTreeChangedDirs: ["src"] }),
        nextV()
      );
    store.getState().applySnapshot(
      [
        makeSnapshot("wt-1", {
          workingTreeChangedAt: 3_000,
          workingTreeChangedDirs: ["electron"],
        }),
      ],
      nextV()
    );

    expect(store.getState().workingTreeChangedDirsById.get("wt-1")).toMatchObject({
      at: 3_000,
      previousAt: null,
      dirs: ["electron"],
    });
  });

  it("carries an unchanged record through the authoritative snapshot path untouched", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { workingTreeChangedAt: 1_000, workingTreeChangedDirs: ["src"] }),
        nextV()
      );
    const record = store.getState().workingTreeChangedDirsById.get("wt-1");

    store
      .getState()
      .applySnapshot(
        [makeSnapshot("wt-1", { workingTreeChangedAt: 1_000, workingTreeChangedDirs: ["src"] })],
        nextV()
      );

    expect(store.getState().workingTreeChangedDirsById.get("wt-1")).toBe(record);
  });

  it("breaks the chain when the worktree is re-created at the same path", () => {
    // Same epoch, new incarnation: the stamp keeps climbing (it is clock-based)
    // so nothing about the number says the old tree died, but its record
    // describes a different timeline.
    const store = createWorktreeStore();
    store.getState().applyUpdate(
      makeSnapshot("wt-1", {
        generation: 1,
        workingTreeChangedAt: 1_000,
        workingTreeChangedDirs: ["src"],
      }),
      nextV()
    );
    store.getState().applyUpdate(
      makeSnapshot("wt-1", {
        generation: 2,
        workingTreeChangedAt: 2_000,
        workingTreeChangedDirs: ["electron"],
      }),
      nextV()
    );

    expect(store.getState().workingTreeChangedDirsById.get("wt-1")?.previousAt).toBeNull();
  });

  it("does not chain a later new-epoch event back onto the dead run", () => {
    // Only the FIRST event of a new epoch sees the transition, so a guard that
    // tests the incoming event rather than the record lets the second one
    // reconnect. Here the first new-epoch update carries no fs stamp at all.
    const store = createWorktreeStore();
    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { workingTreeChangedAt: 1_000, workingTreeChangedDirs: ["src"] }),
        { epoch: "epoch-a", seq: 1 }
      );
    store.getState().applyUpdate(makeSnapshot("wt-1"), { epoch: "epoch-b", seq: 1 });
    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { workingTreeChangedAt: 2_000, workingTreeChangedDirs: ["b"] }),
        { epoch: "epoch-b", seq: 2 }
      );

    expect(store.getState().workingTreeChangedDirsById.get("wt-1")?.previousAt).toBeNull();
  });

  it("prunes the record when its worktree is removed", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applyUpdate(
        makeSnapshot("wt-1", { workingTreeChangedAt: 1_000, workingTreeChangedDirs: ["src"] }),
        nextV()
      );
    store.getState().applyRemove("wt-1", nextV());

    expect(store.getState().workingTreeChangedDirsById.has("wt-1")).toBe(false);
  });
});

// `snapshotsEqual` compares fields by hand. An update whose only change is the
// approval flag is exactly the one the host sends after the user approves, so
// dropping it would leave the card asking for an approval already given.
describe("createWorktreeStore — command approval flag", () => {
  it("surfaces an update whose only change is lifecycleCommandsNeedApproval", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { lifecycleCommandsNeedApproval: true }), nextV());
    const mapBefore = store.getState().worktrees;

    store.getState().applyUpdate(makeSnapshot("wt-1"), nextV());

    expect(store.getState().worktrees).not.toBe(mapBefore);
    expect(store.getState().worktrees.get("wt-1")?.lifecycleCommandsNeedApproval).toBeUndefined();
  });

  it("does not churn the map identity when the flag is unchanged", () => {
    const store = createWorktreeStore();
    store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { lifecycleCommandsNeedApproval: true }), nextV());
    const mapBefore = store.getState().worktrees;

    store
      .getState()
      .applyUpdate(makeSnapshot("wt-1", { lifecycleCommandsNeedApproval: true }), nextV());

    expect(store.getState().worktrees).toBe(mapBefore);
  });
});

// `snapshotsEqual` compares snapshot fields by hand, so a field it doesn't
// compare is a field whose changes never reach the renderer (#11434). These
// tests pin `isExternal` into that comparison.
describe("createWorktreeStore — external classification updates", () => {
  it("surfaces an update whose only change is isExternal", () => {
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { isExternal: false }), nextV());
    const mapBefore = store.getState().worktrees;

    store.getState().applyUpdate(makeSnapshot("wt-1", { isExternal: true }), nextV());

    expect(store.getState().worktrees).not.toBe(mapBefore);
    expect(store.getState().worktrees.get("wt-1")?.isExternal).toBe(true);
  });

  it("distinguishes unknown classification from a confirmed internal one", () => {
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { isExternal: undefined }), nextV());
    const mapBefore = store.getState().worktrees;

    store.getState().applyUpdate(makeSnapshot("wt-1", { isExternal: false }), nextV());

    expect(store.getState().worktrees).not.toBe(mapBefore);
    expect(store.getState().worktrees.get("wt-1")?.isExternal).toBe(false);
  });

  it("does not churn the map identity when classification is unchanged", () => {
    const store = createWorktreeStore();
    store.getState().applyUpdate(makeSnapshot("wt-1", { isExternal: true }), nextV());
    const mapBefore = store.getState().worktrees;

    store.getState().applyUpdate(makeSnapshot("wt-1", { isExternal: true }), nextV());

    expect(store.getState().worktrees).toBe(mapBefore);
  });
});

describe("createWorktreeStore — topologyWatcherDark (#9908)", () => {
  it("setTopologyWatcherDark toggles the flag", () => {
    const store = createWorktreeStore();
    store.getState().setTopologyWatcherDark(true);
    expect(store.getState().topologyWatcherDark).toBe(true);
    store.getState().setTopologyWatcherDark(false);
    expect(store.getState().topologyWatcherDark).toBe(false);
  });

  it("is a no-op (same state reference) when the value is unchanged", () => {
    const store = createWorktreeStore();
    const before = store.getState();
    store.getState().setTopologyWatcherDark(false);
    // Functional updater returns the previous state object when unchanged, so a
    // redundant set must not produce a new reference (no needless re-render).
    expect(store.getState()).toBe(before);
  });
});
