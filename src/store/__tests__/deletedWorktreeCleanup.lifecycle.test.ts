// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { usePanelStore } from "@/store/panelStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useWorktreeSelectionStore, type DeletedWorktree } from "@/store/worktreeStore";
import { __resetProjectViewCacheStateForTests } from "@/lib/viewCacheState";
import {
  DELETED_WORKTREE_SWEEP_INTERVAL_MS,
  resetDeletedWorktreeCleanupState,
  startDeletedWorktreeCleanup,
} from "../deletedWorktreeCleanup";

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

const NOW = 1_700_000_000_000;
const TTL_MS = 60_000;

/**
 * The cached-view half of #11259 is a *lifecycle* bug, so these drive the real
 * `viewCacheState` bridge (stubbed at the preload boundary, as the watchdog's
 * tests do) rather than injecting a cached flag. Kept out of the pure sweep
 * suite because fake timers plus the lifecycle bridge would otherwise leak
 * across every state-machine case.
 */
let cachedHandlers: Array<() => void>;
let warmHandlers: Array<() => void>;
let revealedHandlers: Array<() => void>;
let latchedCached: boolean;
let bulkTrashByWorktree: ReturnType<typeof vi.fn<(worktreeId: string) => void>>;

function goCached(): void {
  latchedCached = true;
  for (const handler of cachedHandlers) handler();
}

function goActive(): void {
  latchedCached = false;
  for (const handler of warmHandlers) handler();
}

function goRevealed(): void {
  latchedCached = false;
  for (const handler of revealedHandlers) handler();
}

/** Advance wall-clock time. Any live interval ticks along the way. */
function advance(ms: number): void {
  vi.advanceTimersByTime(ms);
}

function addRow(overrides: Partial<DeletedWorktree> = {}): void {
  useWorktreeSelectionStore.getState().addDeletedWorktree({
    id: "wt-1",
    title: "feature/x",
    path: "/repo/x",
    deletedAt: NOW,
    expiresAt: null,
    holdReason: null,
    pinnedIndex: -1,
    ...overrides,
  });
}

function getRow(): DeletedWorktree | undefined {
  return useWorktreeSelectionStore.getState().deletedWorktrees.get("wt-1");
}

/** Remaining the row would display right now. */
function remainingNow(): number | null {
  const expiresAt = getRow()?.expiresAt;
  return expiresAt == null ? null : expiresAt - Date.now();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetDeletedWorktreeCleanupState();
  __resetProjectViewCacheStateForTests();
  useWorktreeSelectionStore.getState().reset();
  usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: TTL_MS / 1000 });

  cachedHandlers = [];
  warmHandlers = [];
  revealedHandlers = [];
  latchedCached = false;
  vi.stubGlobal("electron", {
    app: {
      onViewCached: (cb: () => void) => {
        cachedHandlers.push(cb);
        return vi.fn();
      },
      onViewWarmActivated: (cb: () => void) => {
        warmHandlers.push(cb);
        return vi.fn();
      },
      onViewRevealed: (cb: () => void) => {
        revealedHandlers.push(cb);
        return vi.fn();
      },
      // Preload's latch — seeding it before start reproduces the switch-storm
      // case where the view was cached before this module ever evaluated.
      isViewCached: () => latchedCached,
    },
  });

  bulkTrashByWorktree = vi.fn<(worktreeId: string) => void>();
  usePanelStore.setState({
    panelIds: ["t1"],
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    panelsById: {
      t1: { id: "t1", kind: "terminal", title: "t1", worktreeId: "wt-1", location: "grid" },
    } as never,
    panelIdsByWorktreeId: { "wt-1": ["t1"] },
    bulkTrashByWorktree,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  __resetProjectViewCacheStateForTests();
  resetDeletedWorktreeCleanupState();
});

describe("startDeletedWorktreeCleanup view lifecycle", () => {
  it("does not trash a row whose deadline elapsed while the view was cached", () => {
    const stop = startDeletedWorktreeCleanup();
    addRow();
    advance(DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    advance(10_000);
    const remainingWhenCached = remainingNow();

    goCached();
    // Away far longer than the whole TTL — this is the case that used to trash
    // surviving agents on the first tick after thaw with no window to react.
    advance(60 * 60_000);
    goActive();
    goRevealed();

    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    expect(remainingNow()).toBe(remainingWhenCached);
    stop();
  });

  it("arms a row recorded while the view was cached instead of trashing it on wake", () => {
    const stop = startDeletedWorktreeCleanup();
    goCached();
    // Main keeps broadcasting worktree-removed to a cached view.
    addRow();
    advance(60 * 60_000);
    goActive();
    goRevealed();

    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    expect(remainingNow()).toBe(TTL_MS);
    stop();
  });

  it("charges only awake time across repeated cache cycles", () => {
    const stop = startDeletedWorktreeCleanup();
    addRow();
    advance(DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    const startRemaining = remainingNow() ?? 0;

    let awakeMs = 0;
    for (let cycle = 0; cycle < 3; cycle++) {
      advance(5_000);
      awakeMs += 5_000;
      goCached();
      advance(30 * 60_000);
      goActive();
      goRevealed();
    }

    // Each cycle spends its awake seconds and none of its cached ones, so the
    // countdown neither stalls nor gets re-granted by switching projects.
    expect(remainingNow()).toBe(startRemaining - awakeMs);
    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    stop();
  });

  it("stops sweeping while cached and resumes on activation", () => {
    const stop = startDeletedWorktreeCleanup();
    addRow();
    advance(DELETED_WORKTREE_SWEEP_INTERVAL_MS);

    goCached();
    const expiryWhenCached = getRow()?.expiresAt;
    advance(10 * DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    // No sweep ran: the deadline is untouched despite ten intervals passing.
    expect(getRow()?.expiresAt).toBe(expiryWhenCached);

    goActive();
    advance(DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    expect(getRow()?.expiresAt).not.toBe(expiryWhenCached);
    stop();
  });

  it("does not stack intervals when activation fires repeatedly", () => {
    const stop = startDeletedWorktreeCleanup();
    addRow();
    advance(DELETED_WORKTREE_SWEEP_INTERVAL_MS);

    goActive();
    goActive();
    goRevealed();
    advance(5_000);

    // A stacked interval would spend the countdown several times per second.
    expect(remainingNow()).toBe(TTL_MS - 5_000);
    stop();
  });

  it("grants a fresh window to an armed row when the module started already cached", () => {
    // No `cached` edge is ever delivered here, so there is no snapshot to
    // restore — the row's deadline is of unknown provenance and may have aged
    // entirely while nobody could see it.
    latchedCached = true;
    addRow({ expiresAt: NOW - 1 });
    const stop = startDeletedWorktreeCleanup();
    advance(10 * DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    expect(bulkTrashByWorktree).not.toHaveBeenCalled();

    goActive();
    goRevealed();

    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    expect(remainingNow()).toBe(TTL_MS);
    stop();
  });

  it("still fires once the countdown is genuinely spent while awake", () => {
    const stop = startDeletedWorktreeCleanup();
    addRow();
    advance(DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    advance(TTL_MS + DELETED_WORKTREE_SWEEP_INTERVAL_MS);

    expect(bulkTrashByWorktree).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops sweeping after disposal", () => {
    const stop = startDeletedWorktreeCleanup();
    addRow();
    advance(DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    stop();

    advance(TTL_MS * 2);
    // Neither the interval nor a lifecycle edge may revive a disposed sweep.
    goActive();
    goRevealed();

    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
  });
});
