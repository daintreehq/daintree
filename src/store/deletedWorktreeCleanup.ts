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

export const DELETED_WORKTREE_SWEEP_INTERVAL_MS = 1000;

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
 * Both are measured across one continuous hold, in observed time — see
 * `holdStartedAt`, which is credited for unobserved gaps like any deadline.
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
 * drag surviving terminals somewhere else. So the countdown measures time the
 * user could actually have *seen* it, not wall time (#11259):
 * - The row is recorded unarmed; this sweep arms it, so a project cached at
 *   deletion time is never charged for the hours it spent frozen before the
 *   countdown could be shown at all.
 * - The sweep refuses to run at all while the view is cached or the window is
 *   hidden, and any gap it then finds on the way back is credited to every
 *   armed deadline instead of spent. Every sweep still spends at least one
 *   interval, so the countdown is strictly monotonic — neither project
 *   switching nor a stalled renderer can hold a row open indefinitely.
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

/**
 * When the last sweep actually ran. The gap to the next one is time nobody
 * could have watched the countdown, and it is credited back to every armed row
 * rather than spent.
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
}

export function resetDeletedWorktreeCleanupState(): void {
  firedIds.clear();
  armedTtlMs.clear();
  heldRemaining.clear();
  holdStartedAt.clear();
  lastSweepAt = null;
}

function clampRemaining(remainingMs: number, ttlMs: number): number {
  return Math.max(0, Math.min(remainingMs, ttlMs));
}

/**
 * The sweep is the one path that closes terminals with nobody watching: the
 * row vanishes and the trash TTL kills the PTYs shortly after, so a user who
 * stepped away would otherwise have no record it happened and no chance at the
 * only inverse (restore from trash). Inbox-only — the event is unattended by
 * definition, so a toast would interrupt whatever the user moved on to.
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
  const terminalNoun = terminalCount === 1 ? "terminal" : "terminals";
  const single = swept.length === 1 ? swept[0]! : null;
  let message: string;
  if (single === null) {
    message = `${swept.length} deleted worktrees still had ${terminalCount} ${terminalNoun} open — they moved to trash and close shortly.`;
  } else if (single.count === 1) {
    message = `${single.title} still had 1 terminal open — it moved to trash and closes shortly.`;
  } else {
    message = `${single.title} still had ${single.count} terminals open — they moved to trash and close shortly.`;
  }
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
  // whole guarded stretch stays in the gap, so the first sweep back credits it.
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
  lastSweepAt = now;
  if (unobservedMs > 0) {
    // A hold's cap counts observed time too — otherwise a project left cached
    // overnight comes back with its agent's protection already spent.
    for (const [id, startedAt] of holdStartedAt) {
      holdStartedAt.set(id, startedAt + unobservedMs);
    }
  }
  const ttlSeconds = usePreferencesStore.getState().deletedWorktreeCleanupSeconds;

  for (const entry of deletedWorktrees.values()) {
    // An unarmed entry is a fresh (or re-recorded) row — any stale state from a
    // previous row under the same id must not leak into its countdown.
    if (entry.expiresAt === null) forgetRow(entry.id);
    else if (firedIds.has(entry.id)) continue;

    if (ttlSeconds === 0) {
      if (entry.expiresAt !== null || entry.holdReason !== null) {
        setDeletedWorktreeCleanupState(entry.id, { expiresAt: null, holdReason: null });
      }
      forgetRow(entry.id);
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
    if (entry.expiresAt === null || ttlChanged) {
      // Fresh row, or one whose TTL just changed: a full window from now.
      expiresAt = now + ttlMs;
    } else {
      // Push the deadline out by whatever went unobserved, so the countdown
      // only ever spends time the row was actually on screen.
      expiresAt = entry.expiresAt + unobservedMs;
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
    usePanelStore.getState().bulkTrashByWorktree(entry.id);
    if (trashedCount > 0) {
      swept.push({ worktreeId: entry.id, title: entry.title, count: trashedCount });
    }
  }

  notifySweepTrashed(swept);
}

/**
 * Start the 1 Hz cleanup sweep.
 *
 * A cached project view keeps reporting `visibilityState === "visible"` while
 * main has it detached, CPU-throttled and (absent a live agent) frozen, so the
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

  const onVisibilityChange = () => {
    if (!document.hidden) sweepDeletedWorktreeCleanup();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    stopSweeping();
    offViewLifecycle();
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
