// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { usePanelStore } from "@/store/panelStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useWorktreeSelectionStore, type DeletedWorktree } from "@/store/worktreeStore";
import { __resetProjectViewCacheStateForTests } from "@/lib/viewCacheState";
import {
  DELETED_WORKTREE_SWEEP_INTERVAL_MS,
  DELETED_WORKTREE_UNOBSERVED_SLOWDOWN,
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

/** What an unobserved gap of `gapMs` spends: one interval in full, the rest slowed. */
function spentAcrossGap(gapMs: number): number {
  return (
    DELETED_WORKTREE_SWEEP_INTERVAL_MS +
    Math.floor((gapMs - DELETED_WORKTREE_SWEEP_INTERVAL_MS) / DELETED_WORKTREE_UNOBSERVED_SLOWDOWN)
  );
}

function setAgentState(agentState: string): void {
  usePanelStore.setState({
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    panelsById: {
      t1: {
        id: "t1",
        kind: "terminal",
        title: "t1",
        worktreeId: "wt-1",
        location: "grid",
        agentState,
      },
    } as never,
  });
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
  it("spends a cached stretch at the slowed rate instead of in real time", () => {
    start();
    addRow();
    advance(DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    advance(10_000);
    const remainingWhenCached = remainingNow();
    // Guard the guard: if arming ever broke, `null === null` below would still
    // "pass" while proving nothing.
    expect(remainingWhenCached).toBeGreaterThan(0);

    goCached();
    // Two minutes away is longer than the remaining TTL in wall time, which
    // used to be the case that trashed surviving agents on the first tick
    // after thaw with no window to react.
    const awayMs = 2 * 60_000;
    advance(awayMs);
    goActive();
    goRevealed();

    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    const spentWhileAway = (remainingWhenCached ?? 0) - (remainingNow() ?? 0);
    expect(spentWhileAway).toBe(spentAcrossGap(awayMs));
  });

  it("cleans up on reveal a row whose slowed countdown ran out while cached", () => {
    start();
    addRow();
    advance(DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    advance(10_000);

    goCached();
    advance(60 * 60_000);
    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    goActive();
    goRevealed();

    // No fresh window: the hour away spent far more than the row had left.
    expect(bulkTrashByWorktree).toHaveBeenCalledTimes(1);
  });

  it("charges a row recorded while the view was cached for its time away", () => {
    start();
    goCached();
    // Main keeps broadcasting worktree-removed to a cached view.
    addRow();
    const awayMs = 2 * 60_000;
    advance(awayMs);
    expect(getRow()?.expiresAt).toBeNull();
    goActive();
    goRevealed();

    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    expect(remainingNow()).toBe(
      TTL_MS + DELETED_WORKTREE_SWEEP_INTERVAL_MS - spentAcrossGap(awayMs)
    );
  });

  it("cleans up on reveal a row recorded while cached that has outlived its slowed window", () => {
    start();
    goCached();
    addRow();
    advance(60 * 60_000);
    goActive();
    goRevealed();

    expect(bulkTrashByWorktree).toHaveBeenCalledTimes(1);
  });

  it("charges awake time in full and cached time slowed across repeated cache cycles", () => {
    start();
    addRow();
    advance(DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    const startRemaining = remainingNow() ?? 0;
    expect(startRemaining).toBeGreaterThan(0);

    const cycles = 3;
    const cachedMs = 30_000;
    let awakeMs = 0;
    for (let cycle = 0; cycle < cycles; cycle++) {
      advance(5_000);
      awakeMs += 5_000;
      goCached();
      advance(cachedMs);
      goActive();
      goRevealed();
    }

    // Each cycle spends its awake seconds in full and its cached ones at the
    // slowed rate — so the countdown neither stalls nor gets re-granted by
    // switching projects.
    const spent = startRemaining - (remainingNow() ?? 0);
    expect(spent).toBe(awakeMs + cycles * spentAcrossGap(cachedMs));
    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
  });

  it("owns exactly one interval across cache, repeated activation, and disposal", () => {
    // Asserted on timer ownership rather than on the deadline: an absolute
    // deadline is idempotent, so stacked intervals cannot be detected by
    // watching how fast the countdown moves. A row is needed: with none there
    // is nothing to sweep and no interval at all.
    const idle = vi.getTimerCount();
    addRow();
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
    // only thing that knows. No sweep has ever run, so the row's own
    // `deletedAt` is the only start its time away can be measured from.
    latchedCached = true;
    start();
    addRow();
    const awayMs = 2 * 60_000;
    advance(awayMs);
    expect(getRow()?.expiresAt).toBeNull();

    goActive();
    goRevealed();

    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    expect(remainingNow()).toBe(
      TTL_MS + DELETED_WORKTREE_SWEEP_INTERVAL_MS - spentAcrossGap(awayMs)
    );
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

    // Past the agent cap even at the slowed rate, so a cap charged a fifth of
    // the cached stretch would show up here too.
    goCached();
    advance(6 * 60 * 60_000);
    goActive();
    goRevealed();

    // The agent is still working, and the six hours spent cached are not
    // charged against either the countdown or the hold's cap — not even at the
    // slowed rate, since the sweep could not see the agent — otherwise the
    // agent's protection would be gone the moment the user came back.
    expect(getRow()?.holdReason).toBe("agent");
    expect(remainingNow()).toBe(heldRemaining);
    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
  });

  it("resumes a hold released while cached from its pinned remaining", () => {
    start();
    addRow();
    advance(DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    advance(10_000);
    setAgentState("working");
    advance(DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    const heldRemaining = remainingNow() ?? 0;
    expect(getRow()?.holdReason).toBe("agent");

    // The agent finishes while nobody is looking. The sweep could not see when,
    // so the cached stretch is not charged — the pin is all it knows.
    goCached();
    setAgentState("idle");
    advance(60 * 60_000);
    goActive();
    goRevealed();

    expect(getRow()?.holdReason).toBeNull();
    expect(remainingNow()).toBe(heldRemaining);
    expect(bulkTrashByWorktree).not.toHaveBeenCalled();

    advance(heldRemaining + DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    expect(bulkTrashByWorktree).toHaveBeenCalledTimes(1);
  });

  it("charges a row only from when cleanup was switched back on", () => {
    // Never was on when the row arrived, and was switched off from another
    // project's settings while this view was cached — the sweep never saw it.
    usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: 0 });
    start();
    goCached();
    addRow();
    advance(10 * 60_000);
    usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: TTL_SECONDS });
    const sinceEnabledMs = 60_000;
    advance(sinceEnabledMs);
    goActive();
    goRevealed();

    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    expect(remainingNow()).toBe(
      TTL_MS + DELETED_WORKTREE_SWEEP_INTERVAL_MS - spentAcrossGap(sinceEnabledMs)
    );
  });

  it("re-arms an armed row when cleanup went off and back on with no sweep between", () => {
    start();
    addRow();
    advance(DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    advance(10_000);
    goCached();
    usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: 0 });
    advance(10 * 60_000);
    usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: TTL_SECONDS });
    advance(DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    goActive();
    goRevealed();

    // The old deadline would have spent the ten minutes under Never.
    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    expect(remainingNow()).toBe(TTL_MS);
  });

  it("grants a full window when cleanup is switched back on while watching", () => {
    usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: 0 });
    start();
    goCached();
    addRow();
    advance(10 * 60_000);
    goActive();
    goRevealed();
    expect(getRow()?.expiresAt).toBeNull();

    usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: TTL_SECONDS });
    advance(DELETED_WORKTREE_SWEEP_INTERVAL_MS);
    expect(remainingNow()).toBe(TTL_MS);
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

/**
 * The 1 Hz sweep is only there to count down deleted-worktree rows. Nearly every
 * session has none, so the idle cost of the timer is what this pins: interval
 * callbacks the renderer is woken for with nothing to sweep.
 */
describe("deleted-worktree sweep idle cost", () => {
  let ticks = 0;
  let hidden = false;

  function addRow(id: string, expiresAt: number | null = null): void {
    useWorktreeSelectionStore.getState().addDeletedWorktree({
      id,
      title: id,
      path: `/repo/${id}`,
      deletedAt: Date.now(),
      expiresAt,
      holdReason: null,
      pinnedBeforeWorktreeId: null,
    });
  }

  function removeRows(): void {
    useWorktreeSelectionStore.getState().pruneDeletedWorktrees(new Set(), new Set());
  }

  beforeEach(() => {
    usePanelStore.setState({ panelIds: [], panelsById: {}, panelIdsByWorktreeId: {} });
    hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });

    ticks = 0;
    const fakeSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: () => void, ms?: number) =>
      fakeSetInterval(() => {
        ticks++;
        handler();
      }, ms)) as typeof setInterval);
  });

  afterEach(() => {
    stop();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "hidden");
  });

  it("wakes the renderer zero times a minute with no deleted worktrees", () => {
    const idle = vi.getTimerCount();
    disposeCleanup = startDeletedWorktreeCleanup();
    expect(vi.getTimerCount()).toBe(idle);
    vi.advanceTimersByTime(60_000);
    expect(ticks).toBe(0);
  });

  it("sweeps once a second while a row exists and goes quiet once it is gone", () => {
    const idle = vi.getTimerCount();
    disposeCleanup = startDeletedWorktreeCleanup();
    addRow("wt-1");
    expect(vi.getTimerCount()).toBe(idle + 1);
    vi.advanceTimersByTime(10_000);
    expect(ticks).toBe(10);

    removeRows();
    expect(useWorktreeSelectionStore.getState().deletedWorktrees.size).toBe(0);
    expect(vi.getTimerCount()).toBe(idle);
    ticks = 0;
    vi.advanceTimersByTime(60_000);
    expect(ticks).toBe(0);

    addRow("wt-2");
    vi.advanceTimersByTime(1_000);
    expect(ticks).toBe(1);
    expect(useWorktreeSelectionStore.getState().deletedWorktrees.get("wt-2")?.expiresAt).toBe(
      NOW + 71_000 + 60_000
    );
  });

  it("arms a re-recorded row under the same id at the full TTL", () => {
    disposeCleanup = startDeletedWorktreeCleanup();
    addRow("wt-1");
    vi.advanceTimersByTime(5_000);
    removeRows();
    vi.advanceTimersByTime(30_000);

    addRow("wt-1");
    vi.advanceTimersByTime(1_000);
    expect(useWorktreeSelectionStore.getState().deletedWorktrees.get("wt-1")?.expiresAt).toBe(
      Date.now() + 60_000
    );
  });

  it("still slows a hidden stretch for a row that arrives already armed after the map emptied", () => {
    disposeCleanup = startDeletedWorktreeCleanup();
    addRow("wt-1");
    vi.advanceTimersByTime(1_000);
    removeRows();
    vi.advanceTimersByTime(5_000);

    hidden = true;
    addRow("wt-2", Date.now() + 60_000);
    vi.advanceTimersByTime(120_000);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));

    // The two minutes nobody could see — plus the idle five before them, still
    // in the gap — spend at the slowed rate, not in full.
    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    const expiresAt = useWorktreeSelectionStore.getState().deletedWorktrees.get("wt-2")?.expiresAt;
    const gapMs = 125_000;
    expect((expiresAt ?? 0) - Date.now()).toBe(60_000 - 120_000 + gapMs - spentAcrossGap(gapMs));
  });
});
