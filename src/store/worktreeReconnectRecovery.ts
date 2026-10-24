import type { ReconnectRecoveryPhase, WorktreeViewStoreApi } from "@/store/createWorktreeStore";
import { reconnectStallDelayMs } from "@/lib/worktreeReconnect";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logInfo, logWarn } from "@/utils/logger";

/**
 * Gaps before each automatic Retry of a stalled reconnect, counted from the
 * previous attempt settling. The first runs the moment a stall is seen, so a
 * view that lost its port while cached recovers as it comes back.
 */
export const RECONNECT_RECOVERY_DELAYS_MS: readonly number[] = [0, 3_000, 8_000, 15_000];

/**
 * How long a Retry that redelivered the port gets for its snapshot to land
 * before the next attempt replaces that port. A slow host must not have every
 * handshake cut short by the attempt after it.
 */
export const RECONNECT_RECOVERY_HYDRATE_MS = 10_000;

export interface WorktreeReconnectRecoveryDeps {
  store: WorktreeViewStoreApi;
  /** The recovery the banner's Retry runs. Rejects when it couldn't reconnect. */
  retry(): Promise<void>;
  /** Whether a Retry has anything to reload: a project is open in this view. */
  hasProject(): boolean;
  /** Whether someone can see this view: it is neither cached nor in a hidden window. */
  isObserved(): boolean;
  subscribeObserved(listener: () => void): () => void;
  /** Whether calls reach this view's host. */
  isLinkUp(): boolean;
  subscribeLink(listener: () => void): () => void;
  delaysMs?: readonly number[];
  hydrateMs?: number;
  now?: () => number;
}

/**
 * Run Retry on its own for a lost worktree port that no restart brought back
 * (#14313). The banner used to be the only way out, and Retry fixed it every
 * time. Only a snapshot landing ends a round: a Retry that resolves has
 * redelivered a port, which is not the same as data flowing over it.
 *
 * `reconnectRecovery` reads `recovering` for as long as this owns a stall,
 * including while it waits for the view to be seen or the link to come up,
 * since nothing a reload does can cross a dead link and the host banner
 * covers that. It reads `exhausted` once every attempt has failed, which is
 * what lets the stalled banner and its Retry show. Coming back into view, or
 * the link coming back up, starts a fresh round.
 */
export function startWorktreeReconnectRecovery(deps: WorktreeReconnectRecoveryDeps): () => void {
  const { store } = deps;
  const delays = deps.delaysMs ?? RECONNECT_RECOVERY_DELAYS_MS;
  const hydrateMs = deps.hydrateMs ?? RECONNECT_RECOVERY_HYDRATE_MS;
  const now = deps.now ?? Date.now;
  let attempts = 0;
  let lastAttemptRedelivered = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let disposed = false;
  let wasObserved = deps.isObserved();
  let wasLinkUp = deps.isLinkUp();

  const setPhase = (phase: ReconnectRecoveryPhase) => {
    if (store.getState().reconnectRecovery !== phase) store.getState().setReconnectRecovery(phase);
  };

  const cancelTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const schedule = (delayMs: number, run: () => void) => {
    timer = setTimeout(() => {
      timer = null;
      run();
    }, delayMs);
  };

  async function attempt(): Promise<void> {
    attempts += 1;
    inFlight = true;
    const detail = { attempt: attempts, of: delays.length };
    logInfo("Worktree reconnect recovery attempt", detail);
    try {
      await deps.retry();
      lastAttemptRedelivered = true;
      logInfo("Worktree reconnect recovery attempt redelivered the port", detail);
    } catch (error) {
      lastAttemptRedelivered = false;
      logWarn("Worktree reconnect recovery attempt failed", {
        ...detail,
        error: formatErrorMessage(error, "Retry failed"),
      });
    } finally {
      inFlight = false;
    }
    evaluate();
  }

  function evaluate(): void {
    if (disposed) return;
    const state = store.getState();
    // A crashed host has its own banner and Restart; a reload can't stand in.
    if (!state.isReconnecting || state.error !== null || !deps.hasProject()) {
      attempts = 0;
      lastAttemptRedelivered = false;
      cancelTimer();
      setPhase("idle");
      return;
    }
    if (inFlight || timer !== null || state.reconnectRecovery === "exhausted") return;
    const untilStalled = reconnectStallDelayMs(state, now());
    if (untilStalled > 0) {
      // Still inside a restart's budget: something on its way may bring it back.
      schedule(untilStalled, evaluate);
      return;
    }
    if (!deps.isObserved() || !deps.isLinkUp()) {
      setPhase("recovering");
      return;
    }
    if (attempts >= delays.length) {
      if (lastAttemptRedelivered) {
        // The last Retry's snapshot may still be on its way.
        lastAttemptRedelivered = false;
        setPhase("recovering");
        schedule(hydrateMs, evaluate);
        return;
      }
      setPhase("exhausted");
      logWarn("Worktree reconnect recovery gave up", { attempts });
      return;
    }
    setPhase("recovering");
    const delay = delays[attempts] ?? 0;
    const wait = lastAttemptRedelivered ? Math.max(delay, hydrateMs) : delay;
    if (wait === 0) void attempt();
    else schedule(wait, () => void attempt());
  }

  // A fresh round on a real return: the host may hold the project again.
  const resumed = () => {
    attempts = 0;
    lastAttemptRedelivered = false;
    cancelTimer();
    if (store.getState().reconnectRecovery === "exhausted") setPhase("recovering");
  };

  const offStore = store.subscribe((state, prev) => {
    if (
      state.isReconnecting === prev.isReconnecting &&
      state.reconnectingAt === prev.reconnectingAt &&
      state.error === prev.error
    ) {
      return;
    }
    if (!state.isReconnecting && prev.isReconnecting && attempts > 0) {
      logInfo("Worktree reconnect recovered", { attempts });
    }
    evaluate();
  });

  const offObserved = deps.subscribeObserved(() => {
    const observed = deps.isObserved();
    if (observed === wasObserved) return;
    wasObserved = observed;
    if (observed) resumed();
    else cancelTimer();
    evaluate();
  });

  const offLink = deps.subscribeLink(() => {
    const linkUp = deps.isLinkUp();
    if (linkUp === wasLinkUp) return;
    wasLinkUp = linkUp;
    if (linkUp) resumed();
    else cancelTimer();
    evaluate();
  });

  evaluate();

  return () => {
    disposed = true;
    cancelTimer();
    offStore();
    offObserved();
    offLink();
  };
}
