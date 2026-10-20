import { usePanelStore } from "@/store/panelStore";
import {
  getDeletedWorktreeTerminalIds,
  useWorktreeSelectionStore,
  type DeletedWorktreeHoldReason,
} from "@/store/worktreeStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useTerminalPendingDestructiveActionStore } from "@/store/terminalPendingDestructiveActionStore";
import { isPtyPanel } from "@shared/types/panel";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";
import { isProjectViewCached, subscribeProjectViewLifecycle } from "@/lib/viewCacheState";
import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";

export const DELETED_WORKTREE_SWEEP_INTERVAL_MS = 1000;

/**
 * Unobserved time spends the countdown this many times slower than watched
 * time (#13538): the 60s default takes 5 minutes with the project cached or
 * the window hidden. Slowed rather than paused, because agents create and
 * delete worktrees on hosts nobody is looking at, and a paused countdown left
 * every one of those rows waiting out its full window on the user's return.
 */
export const DELETED_WORKTREE_UNOBSERVED_SLOWDOWN = 5;

/** Countdown an unobserved stretch spends; the rest is credited back. */
function unobservedSpendMs(unobservedMs: number): number {
  return Math.floor(unobservedMs / DELETED_WORKTREE_UNOBSERVED_SLOWDOWN);
}

/**
 * How long a hold may keep a row open before the countdown resumes anyway.
 * Two tiers, because the reasons differ by an order of magnitude in how long
 * they can legitimately last (#11259):
 * - A confirm dialog or a drag is a gesture measured in seconds. Minutes of it
 *   means the flag leaked (the drag flag is app-wide and has no owner to clear
 *   it), so a short cap is a leak recovery, not an interruption.
 * - A working agent can legitimately work for a long time, and the escape
 *   hatch is expensive here: trash holds a terminal for only TRASH_TTL_MS
 *   (20s) before killing the PTY, so force-trashing a live agent is closer to
 *   termination than to a reversible undo.
 * Both are measured across one continuous hold, in observed time only — see
 * `holdStartedAt`, which is credited every unobserved gap in full. Deliberately
 * not slowed like the deadline: a cap is leak recovery, and the sweep cannot
 * see whether a working agent is still working while the view is away, so
 * spending the cap there would force-trash live agents on the user's return.
 */
export const DELETED_WORKTREE_TRANSIENT_HOLD_CAP_MS = 5 * 60_000;
export const DELETED_WORKTREE_AGENT_HOLD_CAP_MS = 60 * 60_000;

function holdCapMs(reason: DeletedWorktreeHoldReason): number {
  return reason === "agent"
    ? DELETED_WORKTREE_AGENT_HOLD_CAP_MS
    : DELETED_WORKTREE_TRANSIENT_HOLD_CAP_MS;
}

/**
 * Auto-cleanup for deleted-worktree rows (#11232): a row's surviving terminals
 * are moved to trash after `deletedWorktreeCleanupSeconds` (default 60s, 0 =
 * never), after which the row prunes itself. Deleted worktrees are deliberately
 * ephemeral — they never persist across restarts, and without this sweep a bulk
 * worktree cleanup would leave ghost rows pinned in the sidebar forever.
 *
 * The row is a rescue surface: its visible countdown is the user's window to
 * drag surviving terminals somewhere else. So the countdown runs in real time
 * only while the user could actually have *seen* it (#11259), and at a fifth
 * of that speed while they could not (#13538):
 * - The sweep refuses to run at all while the view is cached or the window is
 *   hidden, so nothing is trashed where nobody could see it happen. The gap it
 *   then finds on the way back is spent at the slowed rate, and a row whose
 *   slowed countdown ran out in that time is cleaned up on that first sweep
 *   rather than granted a fresh window.
 * - The row is recorded unarmed and this sweep arms it, charging the slowed
 *   rate for however much of the gap the row existed for — a burst of rows
 *   deleted on a host nobody is watching does not each start a full window
 *   when the user comes back.
 * - Every sweep still spends at least one interval, so the countdown is
 *   strictly monotonic — neither project switching nor a stalled renderer can
 *   hold a row open indefinitely.
 *
 * It holds the countdown (pinned at its current remaining, not reset to full)
 * only while firing would actively break something:
 * - ANY drag is in progress. Dragging a terminal out IS the rescue gesture and
 *   expiring mid-drag would yank the source away, but the drag flag
 *   (`documentElement.dataset.dragging`, set by DndProvider) carries no
 *   identity — the dragged panel's owning row is React state inside the
 *   provider, not something this module-level sweep can read. So every ghost
 *   row holds for the duration of any drag anywhere. Drags are short and
 *   deliberate, so the over-broad hold is cheap; the alternative (plumbing the
 *   active drag's worktree out of DndProvider) buys nothing at this cost.
 * - any surviving terminal's agent is still `working` (the Codespaces model:
 *   active output resets the idle clock),
 * - the row's own close-confirm dialog is open.
 *
 * Every hold is capped (see the cap constants). A condition that never clears —
 * an agent wedged in `working`, a leaked drag flag — used to hold a row open
 * forever with no clue why; now it holds for at most its cap, the row says
 * which condition is holding it, and then the preserved countdown resumes.
 *
 * Terminals go through `bulkTrashByWorktree` — the same executor as the row's
 * manual close button — so auto-cleanup lands in the trash with its usual
 * restore window rather than hard-killing anything immediately.
 */
/**
 * A gap between sweeps longer than this means time passed that the user could
 * not have been watching the countdown — the machine slept, the renderer
 * stalled, or a guarded state (cached / hidden) was left without the sweep
 * running. Two intervals of slack keeps ordinary event-loop jitter from
 * counting as unobserved time.
 */
const MAX_OBSERVED_SWEEP_GAP_MS = DELETED_WORKTREE_SWEEP_INTERVAL_MS * 2;

interface SweepDeps {
  now: () => number;
  isDragActive: () => boolean;
  isViewCached: () => boolean;
  isViewHidden: () => boolean;
  /**
   * Gap above which the time between two sweeps counts as unobserved. Tests
   * that step time coarsely to describe a state machine pass `Infinity` — "the
   * view was awake for all of it" — so the countdown advances the way it does
   * across the real 1 Hz cadence.
   */
  maxObservedGapMs: number;
}

function defaultIsDragActive(): boolean {
  return document.documentElement.dataset.dragging === "true";
}

function defaultIsViewHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

const DEFAULT_DEPS: SweepDeps = {
  now: () => Date.now(),
  isDragActive: defaultIsDragActive,
  isViewCached: isProjectViewCached,
  isViewHidden: defaultIsViewHidden,
  maxObservedGapMs: MAX_OBSERVED_SWEEP_GAP_MS,
};

function hasWorkingAgent(worktreeId: string): boolean {
  const { panelsById } = usePanelStore.getState();
  return getDeletedWorktreeTerminalIds(worktreeId).some((id) => {
    const panel = panelsById[id];
    if (panel == null || !isPtyPanel(panel)) return false;
    // Same display-state coercion as the sidebar badges: a panel whose chrome
    // no longer renders an agent (exited, errored, plain shell) must not defer
    // cleanup forever on a stale `working` heuristic.
    const displayState = getTerminalAgentDisplayState(
      deriveTerminalChrome(panel),
      panel.agentState
    );
    return displayState === "working";
  });
}

/**
 * Every hold condition currently true for this row, in precedence order. The
 * sweep needs the whole set rather than the first match so an exhausted
 * condition can fall through to a still-eligible one — a leaked drag flag must
 * not mask (or borrow the short cap of) a genuinely working agent.
 */
function activeHoldReasons(worktreeId: string, deps: SweepDeps): DeletedWorktreeHoldReason[] {
  const reasons: DeletedWorktreeHoldReason[] = [];
  const pending = useTerminalPendingDestructiveActionStore.getState().pending;
  // The grouped clear previews several rows at once, so every previewed member
  // holds while the user reads the dialog — expiring one mid-read would trash
  // terminals the confirm is still offering to spare (#11260).
  const confirmHolds =
    (pending?.kind === "deletedWorktreeDismiss" && pending.worktreeId === worktreeId) ||
    (pending?.kind === "deletedWorktreeGroupDismiss" &&
      (pending.preview?.some((entry) => entry.worktreeId === worktreeId) ?? false));
  if (confirmHolds) reasons.push("confirm");
  if (deps.isDragActive()) reasons.push("drag");
  if (hasWorkingAgent(worktreeId)) reasons.push("agent");
  return reasons;
}

// A row whose cleanup has been dispatched must not re-fire on the next tick —
// the trash commit and the row prune land asynchronously. Entries clear when
// the row leaves the map (or the sweep resets, in tests).
const firedIds = new Set<string>();

// TTL each row's deadline was armed with, so changing the preference mid-
// countdown re-arms the row to `now + newTTL` instead of honoring a deadline
// computed from the old value (30→300 would otherwise still fire at 30s, and
// the card's progress bar — which divides by the CURRENT TTL — would lie).
const armedTtlMs = new Map<string, number>();

// Remaining at the moment the countdown stopped advancing, tagged with the TTL
// it was captured under so a preference change can invalidate it rather than
// resuming a remaining that no longer means anything.
interface RemainingSnapshot {
  remainingMs: number;
  ttlMs: number;
}

// Captured once per hold (not per tick) — re-capturing every tick is what made
// a held row re-arm to full forever.
const heldRemaining = new Map<string, RemainingSnapshot>();

// Start of the current *continuous* hold, in observed time. Cleared only when
// no hold condition is true at all, which is what latches an exhausted hold: a
// condition that stays true past its cap can never restart the clock and hold
// again.
const holdStartedAt = new Map<string, number>();

// Rows the sweep disarmed because cleanup was off. They are unarmed again, but
// not fresh: turning cleanup back on grants a full window rather than charging
// them for time the countdown was switched off.
const disarmedIds = new Set<string>();

/**
 * When the last sweep actually ran. The gap to the next one is time nobody
 * could have watched the countdown, and every armed row spends it at the
 * slowed rate rather than in real time.
 *
 * This is measured rather than driven off lifecycle edges on purpose: an edge
 * you miss is a row that thaws already expired, and there are several ways to
 * miss one (a view cached before this module evaluated, a switch superseded
 * mid-flight, a minimized window that never goes `cached` at all, the machine
 * sleeping). A gap is impossible to miss — if the sweep did not run, the gap is
 * there to be seen on the next tick.
 */
let lastSweepAt: number | null = null;

function forgetRow(id: string): void {
  firedIds.delete(id);
  armedTtlMs.delete(id);
  heldRemaining.delete(id);
  holdStartedAt.delete(id);
  disarmedIds.delete(id);
}

function forgetAllRows(): void {
  firedIds.clear();
  armedTtlMs.clear();
  heldRemaining.clear();
  holdStartedAt.clear();
  disarmedIds.clear();
}

export function resetDeletedWorktreeCleanupState(): void {
  forgetAllRows();
  lastSweepAt = null;
}

/**
 * The interval does not run while there are no rows, so nothing advances
 * `lastSweepAt` across that stretch. Stamp it wherever an idle sweep would
 * have: at any moment the view was observable. Left alone while cached or
 * hidden, so the stretch stays in the gap and is charged at the slowed rate. A
 * fresh row is only ever charged from its own `deletedAt`, so a stale stamp
 * cannot bill it for time from before it existed.
 */
function markIdleObservation(deps: SweepDeps = DEFAULT_DEPS): void {
  if (deps.isViewCached() || deps.isViewHidden()) return;
  lastSweepAt = deps.now();
}

function clampRemaining(remainingMs: number, ttlMs: number): number {
  return Math.max(0, Math.min(remainingMs, ttlMs));
}

/**
 * The sweep is the one path that closes terminals with nobody watching: the
 * row vanishes and the trash TTL kills the PTYs seconds later, so a user who
 * stepped away would otherwise have no record it happened. The entry is only a
 * record — the inbox is usually read long after the trash window closes, so it
 * carries no restore action and its copy is past tense. Inbox-only — the event
 * is unattended by definition, so a toast would interrupt whatever the user
 * moved on to.
 */
interface SweptRow {
  worktreeId: string;
  title: string;
  count: number;
}

/**
 * One inbox entry per sweep pass, not per row (#11260). A burst of deletions is
 * armed with the same TTL at the same moment, so its rows all expire on one
 * tick — announcing each of them wrote N entries describing a single event. The
 * low-priority inbox path skips `notify`'s rate limiter and coalescing
 * entirely, so collapsing the burst has to happen here, at the call site.
 */
function notifySweepTrashed(swept: readonly SweptRow[]): void {
  if (swept.length === 0) return;
  const terminalCount = swept.reduce((n, row) => n + row.count, 0);
  const single = swept.length === 1 ? swept[0]! : null;
  const where = single ? single.title : pluralize(swept.length, "worktree");
  const message = `Closed ${pluralize(terminalCount, "terminal")} left open in ${where}.`;
  notify({
    type: "info",
    title: single ? "Deleted worktree cleaned up" : "Deleted worktrees cleaned up",
    message,
    // `agent` is the right domain (these are agent sessions) but its policy
    // baseline is active/high; pin low so the unattended record stays a record
    // and never interrupts whatever the user moved on to.
    priority: "low",
    // A multi-row sweep has no single worktree to attribute, and pinning one
    // member's id would make the entry navigate somewhere arbitrary.
    context: { ...(single ? { worktreeId: single.worktreeId } : {}), eventKind: "agent" },
  });
}

export function sweepDeletedWorktreeCleanup(deps: SweepDeps = DEFAULT_DEPS): void {
  const selection = useWorktreeSelectionStore.getState();
  const { deletedWorktrees, setDeletedWorktreeCleanupState } = selection;

  // Prune first, and even while cached: a row removed while this view was
  // frozen must not leave its bookkeeping behind to be inherited by a later
  // row reusing the id.
  for (const id of [
    ...firedIds,
    ...armedTtlMs.keys(),
    ...heldRemaining.keys(),
    ...holdStartedAt.keys(),
    ...disarmedIds,
  ]) {
    if (!deletedWorktrees.has(id)) forgetRow(id);
  }

  // Nothing below this line may write a deadline or trash a terminal on behalf
  // of a view nobody can see. Both signals are needed and neither implies the
  // other (`viewCacheState`'s docstring spells this out): a cached view still
  // reports `visible`, and a minimized window is hidden while its project stays
  // active. Hidden especially — Chromium's first background tier throttles
  // timers to 1 Hz, which is this interval exactly, so the sweep keeps firing
  // on time and would spend the countdown at full speed behind a minimized
  // window and trash the row where nobody could see it happen.
  //
  // Returning BEFORE `lastSweepAt` is updated is what makes this safe: the
  // whole guarded stretch stays in the gap, so the first sweep back charges it
  // at the slowed rate.
  // Guarded in the body rather than only by stopping the interval, because
  // clearing an interval cannot retract a callback the event loop has already
  // picked up, and the visibility listener reaches this too.
  if (deps.isViewCached() || deps.isViewHidden()) return;

  const now = deps.now();
  const swept: SweptRow[] = [];
  // A row can only be armed by a sweep (they are recorded unarmed), so an
  // armed row implies a sweep has run and `lastSweepAt` is set. There is no
  // reachable "armed but never swept" state whose deadline would have to be
  // treated as unmeasurable.
  const sinceLastSweep = lastSweepAt === null ? 0 : now - lastSweepAt;
  // Credit the gap MINUS one interval, never the whole thing, so every sweep
  // always spends at least one interval of countdown. Crediting in full would
  // mean a run of gaps just over the threshold — a debugger pause, a renderer
  // pegged under load, a project revealed for under a second between longer
  // cached stretches — consumed exactly zero countdown forever, which is the
  // never-fires half of this bug arriving by a different road. Against a
  // genuinely long gap the difference is one second.
  const unobservedMs =
    sinceLastSweep > deps.maxObservedGapMs
      ? sinceLastSweep - DELETED_WORKTREE_SWEEP_INTERVAL_MS
      : 0;
  const previousSweepAt = lastSweepAt;
  lastSweepAt = now;
  if (unobservedMs > 0) {
    // A hold's cap counts observed time only, and is credited the whole gap
    // rather than the deadline's slowed share — otherwise a project left cached
    // overnight comes back with its agent's protection already spent.
    for (const [id, startedAt] of holdStartedAt) {
      holdStartedAt.set(id, startedAt + unobservedMs);
    }
  }
  const ttlSeconds = usePreferencesStore.getState().deletedWorktreeCleanupSeconds;

  for (const entry of deletedWorktrees.values()) {
    // An unarmed entry is a fresh (or re-recorded) row — any stale state from a
    // previous row under the same id must not leak into its countdown.
    const wasDisarmed = entry.expiresAt === null && disarmedIds.has(entry.id);
    if (entry.expiresAt === null) forgetRow(entry.id);
    else if (firedIds.has(entry.id)) continue;

    if (ttlSeconds === 0) {
      if (entry.expiresAt !== null || entry.holdReason !== null) {
        setDeletedWorktreeCleanupState(entry.id, { expiresAt: null, holdReason: null });
      }
      forgetRow(entry.id);
      disarmedIds.add(entry.id);
      continue;
    }

    const ttlMs = ttlSeconds * 1000;
    const armedWith = armedTtlMs.get(entry.id);
    const ttlChanged = armedWith !== undefined && armedWith !== ttlMs;
    if (ttlChanged) {
      // A preserved remaining was measured against the old TTL and means
      // nothing now. The hold *clock* survives on purpose: toggling the
      // preference must not reset the cap and re-open an indefinite hold.
      heldRemaining.delete(entry.id);
    }
    armedTtlMs.set(entry.id, ttlMs);

    // Resolve this row's deadline before any hold or expiry decision.
    let expiresAt: number;
    if (ttlChanged || wasDisarmed) {
      // The TTL just changed, or cleanup was just turned back on: a full
      // window of the current TTL from now.
      expiresAt = now + ttlMs;
    } else if (entry.expiresAt === null) {
      // Fresh row. Charge the slowed rate for the part of the gap it existed
      // for — measured from `deletedAt`, never earlier, and with no sweep on
      // record that is the only start there is. Same threshold and the same
      // one-interval allowance as the shared gap, so a row recorded between
      // two ordinary ticks is armed at a full window.
      const rowGapMs = now - Math.max(entry.deletedAt, previousSweepAt ?? entry.deletedAt);
      const rowUnobservedMs =
        rowGapMs > deps.maxObservedGapMs ? rowGapMs - DELETED_WORKTREE_SWEEP_INTERVAL_MS : 0;
      expiresAt = now + ttlMs - unobservedSpendMs(rowUnobservedMs);
    } else {
      // Push the deadline out by the unobserved gap minus its slowed share, so
      // watched time spends in real time and unwatched time at a fifth of it.
      expiresAt = entry.expiresAt + unobservedMs - unobservedSpendMs(unobservedMs);
    }

    const reasons = activeHoldReasons(entry.id, deps);
    if (reasons.length === 0) {
      holdStartedAt.delete(entry.id);
    } else if (!holdStartedAt.has(entry.id)) {
      holdStartedAt.set(entry.id, now);
    }
    const heldSince = holdStartedAt.get(entry.id) ?? now;
    // First reason still inside its cap. All exhausted (or none active) means
    // the countdown runs — that is the "eventually gives up" guarantee.
    const holdReason = reasons.find((reason) => now - heldSince < holdCapMs(reason)) ?? null;

    if (holdReason !== null) {
      // Capture once per hold, then pin. Re-capturing every tick is what made
      // the old code re-arm a held row to a fresh full TTL forever.
      let snapshot = heldRemaining.get(entry.id);
      if (snapshot === undefined || snapshot.ttlMs !== ttlMs) {
        snapshot = { remainingMs: clampRemaining(expiresAt - now, ttlMs), ttlMs };
        heldRemaining.set(entry.id, snapshot);
      }
      setDeletedWorktreeCleanupState(entry.id, {
        expiresAt: now + snapshot.remainingMs,
        holdReason,
      });
      continue;
    }

    // Released: resume from the remaining the hold preserved, so the countdown
    // picks up where it stopped rather than losing (or re-granting) time.
    const held = heldRemaining.get(entry.id);
    if (held !== undefined) {
      heldRemaining.delete(entry.id);
      if (held.ttlMs === ttlMs) expiresAt = now + held.remainingMs;
    }

    if (now < expiresAt) {
      setDeletedWorktreeCleanupState(entry.id, { expiresAt, holdReason: null });
      continue;
    }

    firedIds.add(entry.id);
    setDeletedWorktreeCleanupState(entry.id, { expiresAt, holdReason: null });
    // Same executor as the row's manual close: terminals land in trash
    // (restorable until trash GC), and trashing the last one prunes the row.
    // Count first — the executor mirrors this exact filter, and once it runs
    // the panels have already left the row.
    const trashedCount = getDeletedWorktreeTerminalIds(entry.id).length;
    try {
      usePanelStore.getState().bulkTrashByWorktree(entry.id);
    } catch (error) {
      // `firedIds` is what stops a dispatched row re-firing every tick, so a
      // throw after it was set would retire the row permanently while its
      // terminals are still on it — the row would sit there forever and the
      // PTYs would never be reclaimed. Retry is safe because the executor
      // skips panels already in trash, so a partial batch resumes rather than
      // re-trashing. Warned, not notified: the next tick is one second away.
      firedIds.delete(entry.id);
      console.warn("[DeletedWorktreeCleanup] Trash dispatch failed; retrying next tick", error);
      continue;
    }
    if (trashedCount > 0) {
      swept.push({ worktreeId: entry.id, title: entry.title, count: trashedCount });
    }
  }

  notifySweepTrashed(swept);
}

/**
 * Start the 1 Hz cleanup sweep. The interval only runs while there is at
 * least one deleted-worktree row to count down.
 *
 * A cached project view keeps reporting `visibilityState === "visible"` while
 * main has it detached, hidden and (absent a live agent) frozen, so the
 * `visibilitychange` catch-up this used to rely on is dead code for exactly the
 * case that matters (#11212). The sweep therefore stops while cached and
 * catches up on the way back, mirroring `TerminalReconciliationWatchdog`; the
 * visibility listener stays for the case it does still cover, a minimized or
 * occluded window.
 *
 * Neither signal is load-bearing for correctness. Both are prompts to sweep
 * sooner; the deadline itself is protected by the sweep-gap credit, which
 * needs no edge to arrive.
 */
export function startDeletedWorktreeCleanup(): () => void {
  let interval: ReturnType<typeof setInterval> | undefined;

  /** Idempotent — a rearm while already sweeping keeps the existing timer. */
  const startSweeping = (): void => {
    if (interval !== undefined) return;
    // A controller constructed during a cached window never receives a
    // `cached` phase, so the arm has to check the seeded state itself.
    if (isProjectViewCached()) return;
    // Nearly every session has no deleted rows; a 1 Hz timer with nothing to
    // count down is an idle wakeup a second for the life of the view.
    if (useWorktreeSelectionStore.getState().deletedWorktrees.size === 0) return;
    interval = setInterval(() => sweepDeletedWorktreeCleanup(), DELETED_WORKTREE_SWEEP_INTERVAL_MS);
  };

  const stopSweeping = (): void => {
    if (interval === undefined) return;
    clearInterval(interval);
    interval = undefined;
  };

  startSweeping();

  const offViewLifecycle = subscribeProjectViewLifecycle((phase) => {
    if (phase === "cached") {
      // Purely a cost saving — correctness rides on the sweep-gap measurement,
      // not on this edge arriving.
      stopSweeping();
      return;
    }
    startSweeping();
    // Reveal is when a stale deadline is most likely and most visible: the
    // credit has to land before the user can read a wrong number off the row,
    // so catch up now rather than waiting out the rest of the interval.
    if (phase === "revealed") sweepDeletedWorktreeCleanup();
  });

  const offRows = useWorktreeSelectionStore.subscribe((state, prevState) => {
    if (state.deletedWorktrees === prevState.deletedWorktrees) return;
    if (state.deletedWorktrees.size > 0) {
      if (prevState.deletedWorktrees.size === 0) markIdleObservation();
      startSweeping();
      return;
    }
    stopSweeping();
    forgetAllRows();
    markIdleObservation();
  });

  const onVisibilityChange = () => {
    if (!document.hidden) sweepDeletedWorktreeCleanup();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    stopSweeping();
    offRows();
    offViewLifecycle();
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
