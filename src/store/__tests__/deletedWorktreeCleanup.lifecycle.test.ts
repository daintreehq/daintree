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
const TTL_SECONDS = 60;
const TTL_MS = TTL_SECONDS * 1000;

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
let disposeCleanup: (() => void) | undefined;

/** Start the sweep and register its disposer, so a failing assertion can't leak it. */
function start(): void {
  disposeCleanup = startDeletedWorktreeCleanup();
}

function stop(): void {
  disposeCleanup?.();
  disposeCleanup = undefined;
}

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
    pinnedBeforeWorktreeId: null,
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
  usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: TTL_SECONDS });

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
  // Before the timers and globals go away, or a failed assertion leaves the
  // interval and the document listener behind for the next test.
  stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  __resetProjectViewCacheStateForTests();
  resetDeletedWorktreeCleanupState();
});

describe("startDeletedWorktreeCleanup view lifecycle", () => {
  it("does not trash a row whose deadline elapsed while the view was cached", () => {
    start();
    addRow();
    advance(DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    advance(10_000);
    const remainingWhenCached = remainingNow();
    // Guard the guard: if arming ever broke, `null === null` below would still
    // "pass" while proving nothing.
    expect(remainingWhenCached).toBeGreaterThan(0);

    goCached();
    // Away far longer than the whole TTL — this is the case that used to trash
    // surviving agents on the first tick after thaw with no window to react.
    advance(60 * 60_000);
    goActive();
    goRevealed();

    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    // The hour is credited back; only the interval every sweep always spends
    // comes off, so the user still returns to a real rescue window.
    const spentWhileAway = (remainingWhenCached ?? 0) - (remainingNow() ?? 0);
    expect(spentWhileAway).toBeLessThanOrEqual(DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    expect(remainingNow()).toBeGreaterThan(0);
  });

  it("arms a row recorded while the view was cached instead of trashing it on wake", () => {
    start();
    goCached();
    // Main keeps broadcasting worktree-removed to a cached view.
    addRow();
    advance(60 * 60_000);
    goActive();
    goRevealed();

    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    expect(remainingNow()).toBe(TTL_MS);
  });

  it("charges only awake time across repeated cache cycles", () => {
    start();
    addRow();
    advance(DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    const startRemaining = remainingNow() ?? 0;
    expect(startRemaining).toBeGreaterThan(0);

    const cycles = 3;
    let awakeMs = 0;
    for (let cycle = 0; cycle < cycles; cycle++) {
      advance(5_000);
      awakeMs += 5_000;
      goCached();
      advance(30 * 60_000);
      goActive();
      goRevealed();
    }

    // An hour and a half of wall clock passed, of which 15s was watchable.
    // Each cycle spends its awake seconds plus the one interval every sweep
    // always spends, and none of its cached ones — so the countdown neither
    // stalls nor gets re-granted by switching projects.
    const spent = startRemaining - (remainingNow() ?? 0);
    expect(spent).toBeGreaterThanOrEqual(awakeMs);
    expect(spent).toBeLessThanOrEqual(awakeMs + cycles * DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
  });

  it("owns exactly one interval across cache, repeated activation, and disposal", () => {
    // Asserted on timer ownership rather than on the deadline: an absolute
    // deadline is idempotent, so stacked intervals cannot be detected by
    // watching how fast the countdown moves.
    const idle = vi.getTimerCount();
    start();
    expect(vi.getTimerCount()).toBe(idle + 1);

    goCached();
    expect(vi.getTimerCount()).toBe(idle);

    goActive();
    goActive();
    goRevealed();
    expect(vi.getTimerCount()).toBe(idle + 1);

    stop();
    expect(vi.getTimerCount()).toBe(idle);
  });

  it("arms no interval when the module starts inside a cached window", () => {
    latchedCached = true;
    const idle = vi.getTimerCount();
    start();

    // No `cached` phase is ever delivered in this case, so the arm has to
    // consult the seeded latch itself.
    expect(vi.getTimerCount()).toBe(idle);
  });

  it("arms a row added during a cached start only once the view is back", () => {
    // The switch-storm case: the view was already cached before this module
    // evaluated, so no `cached` phase is ever delivered and the latch is the
    // only thing that knows.
    latchedCached = true;
    start();
    addRow();
    advance(60 * 60_000);
    expect(getRow()?.expiresAt).toBeNull();

    goActive();
    goRevealed();

    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    expect(remainingNow()).toBe(TTL_MS);
  });

  it("keeps a hold's remaining and its cap across a long cache", () => {
    start();
    addRow();
    advance(DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    advance(10_000);
    // An agent starts working, so the row holds.
    usePanelStore.setState({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      panelsById: {
        t1: {
          id: "t1",
          kind: "terminal",
          title: "t1",
          worktreeId: "wt-1",
          location: "grid",
          agentState: "working",
        },
      } as never,
    });
    advance(DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    const heldRemaining = remainingNow();
    expect(getRow()?.holdReason).toBe("agent");

    goCached();
    advance(90 * 60_000);
    goActive();
    goRevealed();

    // The agent is still working, and the hour and a half spent cached is not
    // charged against either the countdown or the hold's cap — otherwise the
    // agent's protection would be gone the moment the user came back.
    expect(getRow()?.holdReason).toBe("agent");
    expect(remainingNow()).toBe(heldRemaining);
    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
  });

  it("re-arms to the new TTL when the preference changed while cached", () => {
    start();
    addRow();
    advance(DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    advance(10_000);

    goCached();
    usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: 30 });
    advance(30 * 60_000);
    goActive();
    goRevealed();

    // A remaining measured against the old 60s TTL would overflow the card's
    // bar, which divides by the current one.
    expect(remainingNow()).toBe(30_000);
    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
  });

  it("leaves rows disarmed across a cache cycle when cleanup is off", () => {
    usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: 0 });
    start();
    addRow({ expiresAt: NOW + 20_000 });
    advance(DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    expect(getRow()?.expiresAt).toBeNull();

    goCached();
    advance(60 * 60_000);
    goActive();
    goRevealed();

    expect(getRow()?.expiresAt).toBeNull();
    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
  });

  it("still fires once the countdown is genuinely spent while awake", () => {
    start();
    addRow();
    advance(DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    advance(TTL_MS + DELETED_WORKTREE_SWEEP_INTERVAL_MS);

    expect(bulkTrashByWorktree).toHaveBeenCalledTimes(1);
  });

  it("stops sweeping after disposal", () => {
    start();
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
