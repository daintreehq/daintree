import { useCallback, useEffect, useSyncExternalStore } from "react";

import { assistantAccountClient } from "@/clients/assistantAccountClient";
import { systemClient } from "@/clients/systemClient";
import { logError } from "@/utils/logger";
import type {
  AssistantAccountLoginProgress,
  AssistantAccountState,
  AssistantAccountStatusResult,
} from "@shared/types/ipc/assistantAccount";

/**
 * The renderer's live view of the Daintree Assistant account.
 *
 * The state lives at MODULE level rather than per-component, and that is the important
 * design decision here. An account is one thing: the settings panel and the assistant's
 * launch gate are two views of the same fact, and giving each its own copy would let them
 * disagree — and would spawn two CLI child processes on every focus event, since each
 * read shells out. One store, one in-flight read, one watch.
 *
 * The refresh policy is event-driven rather than periodic. Account state changes when the
 * user does something — signs in, signs out, buys a plan — and each of those is
 * observable. A background poll would spend a process spawn every interval, forever, to
 * discover something we are already told about. The single exception is the checkout
 * watch, where the change happens in a browser we cannot see into.
 */

/**
 * How often to re-ask while waiting for a just-completed checkout.
 *
 * Deliberately slower than the five seconds the design notes suggest, because a
 * re-verifying status is not free the way that figure assumes. The CLI keeps no access
 * token on disk — only the rotating refresh token — so each invocation starts a fresh
 * process with nothing cached and rotates the credential to get one. At five seconds that
 * is two dozen rotations of a one-time-use token across a two-minute wait, which is
 * exactly what "polling must not refresh the token on every iteration" is warning about.
 *
 * Fifteen seconds is also the interval the answer can actually change on: it matches the
 * backend's negative-entitlement TTL, so faster asking cannot learn anything sooner.
 */
const CHECKOUT_POLL_INTERVAL_MS = 15_000;

/**
 * How long to keep watching before giving up and leaving the user a manual retry.
 *
 * Bounded because an unbounded poll is indistinguishable from a leak: someone who opens
 * the plans page and buys nothing would otherwise leave a process spawning forever.
 */
const CHECKOUT_POLL_CEILING_MS = 120_000;

interface AccountSnapshot {
  result: AssistantAccountStatusResult | null;
  loading: boolean;
  loaded: boolean;
  loginProgress: AssistantAccountLoginProgress | null;
  loginInProgress: boolean;
  awaitingCheckout: boolean;
  /**
   * The last operation failure, in Daintree's own words.
   *
   * Sign-in and sign-out report failure by RESOLVING with a negative result rather than
   * throwing, so without somewhere to put that, every ordinary failure — a bound port, a
   * denied consent — would vanish and the button would appear to do nothing. Cleared when
   * the next operation starts.
   */
  lastError: string | null;
  /**
   * The backend has no account layer, discovered by trying to sign in.
   *
   * Separate from `lastError` because it is not one. Only knowable by asking — a status
   * read answers about a credential, and there is none — so it is recorded from the
   * attempt, and dropped as soon as a sign-in succeeds or the environment moves.
   */
  accountsUnavailable: boolean;
}

const EMPTY: AccountSnapshot = {
  result: null,
  loading: false,
  loaded: false,
  loginProgress: null,
  loginInProgress: false,
  awaitingCheckout: false,
  lastError: null,
  accountsUnavailable: false,
};

let snapshot: AccountSnapshot = EMPTY;
const subscribers = new Set<() => void>();

/**
 * The read currently in flight, and which question it answers.
 *
 * The kind matters because the two reads are not interchangeable. A cached request is
 * satisfied by any read in flight; a refreshing request is satisfied only by another
 * refreshing one, since joining a cached read would hand back the very answer it asked
 * to bypass.
 */
let inflight: { promise: Promise<void>; refresh: boolean } | null = null;

/**
 * Sequence number of the most recently STARTED read.
 *
 * A cached read and a refreshing read can legitimately overlap, and they do not finish in
 * the order they began: the refresh can return first with the true answer, and the older
 * cached read then lands on top of it with a stale one — or with its own timeout, turning
 * a good result into `available:false`. Only the newest request is allowed to commit.
 */
let latestRequest = 0;

let checkoutTimer: ReturnType<typeof setInterval> | null = null;
let checkoutStartedAt = 0;
let checkoutBaseline: AssistantAccountState | null = null;

function emit(patch: Partial<AccountSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const notify of subscribers) notify();
}

function subscribe(onChange: () => void): () => void {
  subscribers.add(onChange);
  return () => {
    subscribers.delete(onChange);
  };
}

function getSnapshot(): AccountSnapshot {
  return snapshot;
}

/**
 * Reads status, letting only the newest request commit.
 *
 * `restart` forces a NEW read rather than joining one already running, and it exists
 * for one specific reason: a read in flight is bound to the endpoint it was spawned
 * against. When the backend environment changes, joining that read returns an answer
 * about the environment the user just LEFT — a credential belongs to one backend, so
 * that answer is not merely stale, it is about a different account. Coalescing is right
 * for every other caller and wrong for this one.
 *
 * The `latestRequest` counter then does the rest: the superseded read's result is
 * dropped when it lands, because a newer id exists by the time it gets there.
 */
async function readStatus(refresh: boolean, restart = false): Promise<void> {
  if (!restart && inflight && (!refresh || inflight.refresh)) return inflight.promise;

  // A restart means the ENVIRONMENT moved, and everything held is a fact about one
  // backend. The failed-read path below deliberately keeps a stale result; that
  // reasoning inverts here, where keeping it would offer a Sign out for an account this
  // endpoint has never heard of.
  if (restart) emit({ accountsUnavailable: false, result: null, loaded: false });

  const id = ++latestRequest;
  const run = (async () => {
    emit({ loading: true });
    try {
      const next = await assistantAccountClient.getStatus(refresh ? { refresh: true } : undefined);
      if (id !== latestRequest) return;
      emit({ result: next, loaded: true, loading: false });
      settleCheckoutWatch(next);
    } catch (err) {
      logError("Failed to read assistant account status", err);
      // Deliberately does NOT clear `result`. A failed read means we could not ask, not
      // that the user is signed out, and blanking a good answer would present a
      // signed-in person as signed out every time the read hiccups.
      if (id !== latestRequest) return;
      emit({ loaded: true, loading: false });
    }
  })();

  const entry = { promise: run, refresh };
  inflight = entry;
  try {
    await run;
  } finally {
    if (inflight === entry) inflight = null;
  }
}

/**
 * Ends the checkout watch once the account stops saying what it said when we started.
 *
 * Keyed on CHANGE rather than on reaching `signed_in_active`, because the CLI cannot
 * currently report that state at all: a status read proves the credential works and
 * deliberately says nothing about the plan, so waiting for "active" specifically would
 * wait out the full ceiling every time. Any movement is the signal, and it stays correct
 * once the CLI learns to report entitlement.
 */
function settleCheckoutWatch(next: AssistantAccountStatusResult): void {
  if (!snapshot.awaitingCheckout || checkoutBaseline === null) return;
  if (next.available && next.status.state !== checkoutBaseline) stopCheckoutWatch();
}

function stopCheckoutWatch(): void {
  if (checkoutTimer !== null) {
    clearInterval(checkoutTimer);
    checkoutTimer = null;
  }
  checkoutBaseline = null;
  if (snapshot.awaitingCheckout) emit({ awaitingCheckout: false });
}

/**
 * Starts the bounded post-checkout watch.
 *
 * Module-level rather than an effect, because the watch belongs to the account and not to
 * whichever component happened to open the link — two mounted views must not run two
 * intervals, and closing the panel mid-wait must not abandon it.
 */
function startCheckoutWatch(): void {
  if (checkoutTimer !== null) return;
  checkoutStartedAt = Date.now();
  checkoutBaseline = snapshot.result?.available ? snapshot.result.status.state : null;
  emit({ awaitingCheckout: true });
  checkoutTimer = setInterval(() => {
    if (Date.now() - checkoutStartedAt >= CHECKOUT_POLL_CEILING_MS) {
      stopCheckoutWatch();
      return;
    }
    void readStatus(true);
  }, CHECKOUT_POLL_INTERVAL_MS);
}

/**
 * Drops all shared state. Test-only.
 *
 * Module-level state outlives a test file's `beforeEach`, so without this each test would
 * inherit the previous one's account, timers and subscribers.
 */
export function resetAssistantAccountStateForTests(): void {
  if (checkoutTimer !== null) clearInterval(checkoutTimer);
  checkoutTimer = null;
  checkoutBaseline = null;
  inflight = null;
  latestRequest = 0;
  snapshot = EMPTY;
  subscribers.clear();
}

export interface UseAssistantAccountResult extends AccountSnapshot {
  /**
   * Re-reads status.
   *
   * `refresh` makes the CLI re-verify against the backend rather than answer from disk.
   * `restart` refuses to join a read already in flight — needed when the backend
   * ENVIRONMENT has changed, because an in-flight read is bound to the endpoint it was
   * spawned against and would answer about the account on the environment just left.
   */
  reload: (options?: { refresh?: boolean; restart?: boolean }) => Promise<void>;
  /** Starts an interactive sign-in. Resolves when it settles. */
  login: () => Promise<void>;
  /** Cancels a sign-in this window started. */
  cancelLogin: () => Promise<void>;
  /** Signs out on this machine. */
  logout: () => Promise<void>;
  /** Opens the account page. */
  openAccount: () => Promise<void>;
  /** Opens the plans page and starts watching for the purchase to land. */
  openSubscribe: () => Promise<void>;
  /** Clears the last operation failure once the user has seen it. */
  dismissError: () => void;
}

export function useAssistantAccount(enabled = true): UseAssistantAccountResult {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const reload = useCallback(
    (options?: { refresh?: boolean; restart?: boolean }) =>
      readStatus(options?.refresh === true, options?.restart === true),
    []
  );

  // First read, and a re-read whenever the surface becomes enabled.
  useEffect(() => {
    if (!enabled) return;
    void readStatus(false);
  }, [enabled]);

  /**
   * Re-read when the window regains focus.
   *
   * This is what makes a sign-in or a purchase completed in the browser show up on the
   * way back into the app, with no polling at all — returning to Daintree is the signal,
   * and it is a better one than any interval because it is exactly when the user expects
   * to see the result.
   */
  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => void readStatus(false);
    const onVisibility = () => {
      if (!document.hidden) void readStatus(false);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);

  // Progress from a sign-in. There is only ever one, so every view sees the same one.
  useEffect(() => {
    if (!enabled) return;
    return assistantAccountClient.onLoginProgress((event) => {
      emit({ loginProgress: event });
      // An error event carries the main process's own copy, keyed to a stable code. It
      // is the only place a mid-flight failure is described, so it has to be kept —
      // `loginProgress` alone is transient and gets cleared by the next attempt.
      if (event.type === "error" && event.message) emit({ lastError: event.message });
      // A finished sign-in changes the account, so read it back rather than inferring the
      // resulting state from the event.
      if (event.type === "authenticated") void readStatus(false);
    });
  }, [enabled]);

  const login = useCallback(async (): Promise<void> => {
    emit({ loginInProgress: true, loginProgress: null, lastError: null });
    try {
      const outcome = await assistantAccountClient.login();
      // A sign-in that fails RESOLVES — it does not throw — so ignoring the result would
      // discard every ordinary failure: a port already bound, a denied consent, a wrong
      // client for this backend. The user would press Sign in and watch nothing happen.
      // A sign-in that WORKED is proof the backend has accounts, whatever an earlier
      // attempt concluded. Without this the verdict outlives the thing it described.
      if (outcome.signedIn) emit({ accountsUnavailable: false });
      if (!outcome.signedIn && !outcome.cancelled) {
        // "This backend has no accounts" is an ANSWER, not a failure — the CLI exits
        // zero on it — so it is recorded as a state rather than raised as an error the
        // user is invited to retry forever.
        if (outcome.code === "auth_accounts_unavailable") {
          emit({ accountsUnavailable: true });
        } else {
          emit({ lastError: outcome.message });
        }
      }
    } catch (err) {
      logError("Assistant account sign-in failed", err);
      emit({ lastError: "Couldn't start the sign-in." });
    } finally {
      emit({ loginInProgress: false });
      // Read the real state either way: a sign-in that failed late may still have changed
      // something, and a thrown IPC error says nothing about the account.
      await readStatus(false);
    }
  }, []);

  const cancelLogin = useCallback(async (): Promise<void> => {
    try {
      await assistantAccountClient.cancelLogin();
    } catch (err) {
      logError("Failed to cancel assistant account sign-in", err);
    }
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    emit({ lastError: null });
    try {
      const outcome = await assistantAccountClient.logout();
      // Same shape as login: a sign-out that could not complete resolves with
      // `signedOut: false`. Reporting that is the difference between a credential the
      // user thinks is gone and one that is still on the machine.
      if (!outcome.signedOut) {
        emit({ lastError: outcome.message ?? "Couldn't sign out." });
      }
    } catch (err) {
      logError("Assistant account sign-out failed", err);
      emit({ lastError: "Couldn't sign out." });
    } finally {
      emit({ loginProgress: null });
      stopCheckoutWatch();
      await readStatus(false);
    }
  }, []);

  /**
   * Opens one of the account links.
   *
   * The URL is validated on the way out of the main process: https only, with query,
   * fragment and userinfo stripped. The host itself is pinned upstream, by the CLI's
   * manifest validation — Electron does not re-check it, so this is only as good as the
   * engine that produced it. An absent link is a real state, not an error: a deployment
   * with no accounts configured returns none, and opening `undefined` must not be tried.
   */
  const openLink = useCallback(async (url: string | undefined, watch: boolean): Promise<void> => {
    if (!url) return;
    try {
      await systemClient.openExternal(url);
      if (watch) startCheckoutWatch();
    } catch (err) {
      logError("Failed to open the assistant account link", err);
    }
  }, []);

  const links = state.result?.available ? state.result.status.links : undefined;

  // Managing an existing subscription is not a purchase, so it does not start the watch —
  // returning to the window re-reads anyway, at no cost.
  const openAccount = useCallback(
    async (): Promise<void> => openLink(links?.account, false),
    [openLink, links?.account]
  );

  const openSubscribe = useCallback(
    async (): Promise<void> => openLink(links?.subscribe, true),
    [openLink, links?.subscribe]
  );

  const dismissError = useCallback(() => emit({ lastError: null }), []);

  return {
    ...state,
    reload,
    login,
    cancelLogin,
    logout,
    openAccount,
    openSubscribe,
    dismissError,
  };
}
