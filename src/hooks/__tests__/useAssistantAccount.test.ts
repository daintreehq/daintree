// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AssistantAccountState,
  AssistantAccountStatusResult,
} from "@shared/types/ipc/assistantAccount";

vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import { useAssistantAccount, resetAssistantAccountStateForTests } from "../useAssistantAccount";

type ProgressListener = (event: { type: string }) => void;

let getStatus: ReturnType<typeof vi.fn>;
let login: ReturnType<typeof vi.fn>;
let cancelLogin: ReturnType<typeof vi.fn>;
let logout: ReturnType<typeof vi.fn>;
let openExternal: ReturnType<typeof vi.fn>;
let progressListeners: ProgressListener[];

const LINKS = {
  account: "https://daintree.org/account",
  subscribe: "https://daintree.org/subscribe",
};

function statusOf(state: AssistantAccountState, links = LINKS): AssistantAccountStatusResult {
  return {
    available: true,
    status: { state, authenticated: true, storageTier: "keychain", links },
  };
}

/** A promise a test resolves by hand, so two reads can be finished out of order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  resetAssistantAccountStateForTests();
  progressListeners = [];
  getStatus = vi.fn().mockResolvedValue(statusOf("signed_in_subscription_required"));
  login = vi.fn().mockResolvedValue({ signedIn: true });
  cancelLogin = vi.fn().mockResolvedValue({ cancelled: true });
  logout = vi.fn().mockResolvedValue({ signedOut: true });
  openExternal = vi.fn().mockResolvedValue(undefined);

  (globalThis as unknown as { window: Window }).window.electron = {
    assistantAccount: {
      getStatus,
      login,
      cancelLogin,
      logout,
      onLoginProgress: (cb: ProgressListener) => {
        progressListeners.push(cb);
        return () => {
          progressListeners = progressListeners.filter((l) => l !== cb);
        };
      },
    },
    system: { openExternal },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
});

afterEach(() => {
  resetAssistantAccountStateForTests();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useAssistantAccount", () => {
  it("reads status on mount without asking the CLI to re-verify", async () => {
    const { result } = renderHook(() => useAssistantAccount());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    // The cheap read is the default; a refresh costs a backend round trip and, because
    // the CLI holds no access token between processes, a credential rotation.
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(getStatus.mock.calls[0]?.[0]).toBeFalsy();
  });

  it("does not read at all while disabled", async () => {
    renderHook(() => useAssistantAccount(false));
    await Promise.resolve();
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("re-reads when the window regains focus", async () => {
    const { result } = renderHook(() => useAssistantAccount());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    const before = getStatus.mock.calls.length;

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    await waitFor(() => expect(getStatus.mock.calls.length).toBeGreaterThan(before));
  });

  /**
   * Two views of one account must not be two accounts.
   *
   * Every read shells out to the CLI, so a per-component copy would double the child
   * processes on every focus event and let the settings panel and the launch gate render
   * different answers.
   */
  it("shares one read and one state across every consumer", async () => {
    const first = renderHook(() => useAssistantAccount());
    const second = renderHook(() => useAssistantAccount());
    await waitFor(() => expect(first.result.current.loaded).toBe(true));
    await waitFor(() => expect(second.result.current.loaded).toBe(true));

    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(second.result.current.result).toBe(first.result.current.result);
  });

  it("collapses overlapping cached reads into one call", async () => {
    const { result } = renderHook(() => useAssistantAccount());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    const gate = deferred<AssistantAccountStatusResult>();
    getStatus.mockClear();
    getStatus.mockImplementation(() => gate.promise);

    await act(async () => {
      void result.current.reload();
      void result.current.reload();
      await Promise.resolve();
    });

    expect(getStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      gate.resolve(statusOf("signed_in_active"));
      await Promise.resolve();
    });
  });

  /**
   * The checkout watch re-verifies, and a re-verifying read is allowed far longer than
   * the poll interval, so ticks can outpace their own answers. Without joining, a slow
   * backend turns the wait into a pile of concurrent CLI spawns.
   */
  it("does not stack refreshing reads on top of one already in flight", async () => {
    const { result } = renderHook(() => useAssistantAccount());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    const gate = deferred<AssistantAccountStatusResult>();
    getStatus.mockClear();
    getStatus.mockImplementation(() => gate.promise);

    await act(async () => {
      void result.current.reload({ refresh: true });
      void result.current.reload({ refresh: true });
      void result.current.reload({ refresh: true });
      await Promise.resolve();
    });

    expect(getStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      gate.resolve(statusOf("signed_in_active"));
      await Promise.resolve();
    });
  });

  /**
   * The other half of that rule: a refresh must NOT be satisfied by a cached read that
   * happens to be in flight, because the cached answer is the one it exists to bypass.
   */
  it("does not let an in-flight cached read satisfy a refresh", async () => {
    const { result } = renderHook(() => useAssistantAccount());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    const gates: Array<ReturnType<typeof deferred<AssistantAccountStatusResult>>> = [];
    getStatus.mockClear();
    getStatus.mockImplementation(() => {
      const g = deferred<AssistantAccountStatusResult>();
      gates.push(g);
      return g.promise;
    });

    await act(async () => {
      void result.current.reload();
      await Promise.resolve();
    });
    await act(async () => {
      void result.current.reload({ refresh: true });
      await Promise.resolve();
    });

    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(getStatus).toHaveBeenCalledWith({ refresh: true });
    await act(async () => {
      for (const g of gates) g.resolve(statusOf("signed_in_active"));
      await Promise.resolve();
    });
  });

  /**
   * The two reads above finish out of order in practice: the refresh returns the true
   * answer, then the older cached read lands on top of it with a stale one. Only the
   * newest request may commit.
   */
  it("does not let an older cached read overwrite a newer refreshed one", async () => {
    const { result } = renderHook(() => useAssistantAccount());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    const gates: Array<ReturnType<typeof deferred<AssistantAccountStatusResult>>> = [];
    getStatus.mockClear();
    getStatus.mockImplementation(() => {
      const g = deferred<AssistantAccountStatusResult>();
      gates.push(g);
      return g.promise;
    });

    await act(async () => {
      void result.current.reload();
      await Promise.resolve();
    });
    await act(async () => {
      void result.current.reload({ refresh: true });
      await Promise.resolve();
    });
    expect(gates).toHaveLength(2);

    // The NEWER refresh answers first with the truth...
    await act(async () => {
      gates[1]!.resolve(statusOf("signed_in_active"));
      await Promise.resolve();
    });
    // ...then the OLDER cached read lands with a stale answer.
    await act(async () => {
      gates[0]!.resolve(statusOf("signed_in_subscription_required"));
      await Promise.resolve();
    });

    expect(result.current.result?.available).toBe(true);
    expect(result.current.result?.available && result.current.result.status.state).toBe(
      "signed_in_active"
    );
  });

  it("keeps the exact last good status when a read fails", async () => {
    const { result } = renderHook(() => useAssistantAccount());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    const good = result.current.result;
    expect(good?.available).toBe(true);

    getStatus.mockRejectedValueOnce(new Error("spawn failed"));
    await act(async () => {
      await result.current.reload();
    });

    // Identity, not just `available` — a bogus signed_out replacement is also
    // `available: true`, so the looser assertion would pass against the very bug this
    // names. A failed read means "could not ask", never "signed out".
    expect(result.current.result).toBe(good);
  });

  it("re-reads when a sign-in reports it authenticated", async () => {
    const { result } = renderHook(() => useAssistantAccount());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    const before = getStatus.mock.calls.length;

    await act(async () => {
      for (const l of progressListeners) l({ type: "authenticated" });
      await Promise.resolve();
    });

    await waitFor(() => expect(getStatus.mock.calls.length).toBeGreaterThan(before));
    expect(result.current.loginProgress).toEqual({ type: "authenticated" });
  });

  it("opens the plans page and then watches for the purchase with live re-checks", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAssistantAccount());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await result.current.openSubscribe();
    });
    expect(openExternal).toHaveBeenCalledWith(LINKS.subscribe);
    expect(result.current.awaitingCheckout).toBe(true);

    getStatus.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    // The wait is the one place a cached answer is useless by construction.
    expect(getStatus).toHaveBeenCalledWith({ refresh: true });
  });

  /**
   * Without this, an implementation that cleared the flag on the very first tick would
   * still satisfy "it polls", "it stops when the plan arrives" and "it stops at the
   * ceiling".
   */
  it("keeps watching while the account still says the same thing", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAssistantAccount());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await result.current.openSubscribe();
    });

    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(result.current.awaitingCheckout).toBe(true);
    }
    expect(getStatus.mock.calls.filter((c) => c[0]?.refresh).length).toBeGreaterThanOrEqual(3);
  });

  /**
   * Stops on CHANGE, not on `signed_in_active` specifically — the CLI cannot report that
   * state today, so keying on it would wait out the full ceiling after every purchase.
   */
  it("stops watching as soon as the account says something different", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAssistantAccount());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await result.current.openSubscribe();
    });
    expect(result.current.awaitingCheckout).toBe(true);

    getStatus.mockResolvedValue(statusOf("signed_in_unverified"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(result.current.awaitingCheckout).toBe(false);
  });

  it("gives up watching after the ceiling and stops polling", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAssistantAccount());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await result.current.openSubscribe();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(135_000);
    });
    expect(result.current.awaitingCheckout).toBe(false);

    getStatus.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(getStatus).not.toHaveBeenCalled();
  });

  /**
   * Managing an existing subscription is not a purchase. Starting the re-verifying watch
   * there would rotate the credential every tick for two minutes to observe a change that
   * was never coming.
   */
  it("does not start the checkout watch merely to open account management", async () => {
    const { result } = renderHook(() => useAssistantAccount());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    await act(async () => {
      await result.current.openAccount();
    });

    expect(openExternal).toHaveBeenCalledWith(LINKS.account);
    expect(result.current.awaitingCheckout).toBe(false);
  });

  it("does not try to open a link the backend never supplied", async () => {
    getStatus.mockResolvedValue({
      available: true,
      status: { state: "signed_in_active", authenticated: true, storageTier: "keychain" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const { result } = renderHook(() => useAssistantAccount());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    await act(async () => {
      await result.current.openSubscribe();
    });

    expect(openExternal).not.toHaveBeenCalled();
    expect(result.current.awaitingCheckout).toBe(false);
  });

  it("re-reads after a sign-out instead of assuming it worked", async () => {
    const { result } = renderHook(() => useAssistantAccount());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    const before = getStatus.mock.calls.length;

    await act(async () => {
      await result.current.logout();
    });

    expect(logout).toHaveBeenCalled();
    expect(getStatus.mock.calls.length).toBeGreaterThan(before);
  });

  it("re-reads after a sign-in that threw, rather than reporting nothing changed", async () => {
    const { result } = renderHook(() => useAssistantAccount());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    const before = getStatus.mock.calls.length;

    login.mockRejectedValueOnce(new Error("ipc died"));
    await act(async () => {
      await result.current.login();
    });

    expect(result.current.loginInProgress).toBe(false);
    expect(getStatus.mock.calls.length).toBeGreaterThan(before);
  });

  it("cancels a sign-in through the CLI", async () => {
    const { result } = renderHook(() => useAssistantAccount());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => {
      await result.current.cancelLogin();
    });
    expect(cancelLogin).toHaveBeenCalled();
  });

  /**
   * "This backend has no accounts" is a fact about ONE backend, learned by asking.
   *
   * A status read cannot report it — it answers about a credential, and there is no
   * credential to answer about — so the only way to find out is to attempt a sign-in.
   * That makes the lifetime of the answer the whole problem: it has to be recorded, and
   * it has to stop being believed the moment anything proves otherwise.
   */
  describe("a backend without accounts", () => {
    const NOT_OFFERED = {
      signedIn: false,
      cancelled: false,
      code: "auth_accounts_unavailable",
      message: "This backend doesn't use accounts, so there's nothing to sign in to.",
    };

    it("records it as a state rather than an error", async () => {
      login.mockResolvedValueOnce(NOT_OFFERED);
      const { result } = renderHook(() => useAssistantAccount());
      await waitFor(() => expect(result.current.loaded).toBe(true));

      await act(async () => {
        await result.current.login();
      });

      expect(result.current.accountsUnavailable).toBe(true);
      // Not an error: an error banner here invites a retry that can only fail again.
      expect(result.current.lastError).toBeNull();
    });

    it("stops believing it once a sign-in succeeds", async () => {
      login.mockResolvedValueOnce(NOT_OFFERED);
      const { result } = renderHook(() => useAssistantAccount());
      await waitFor(() => expect(result.current.loaded).toBe(true));
      await act(async () => {
        await result.current.login();
      });
      expect(result.current.accountsUnavailable).toBe(true);

      login.mockResolvedValueOnce({ signedIn: true });
      await act(async () => {
        await result.current.login();
      });

      // A sign-in that worked is proof the backend has accounts, whatever an earlier
      // attempt concluded.
      expect(result.current.accountsUnavailable).toBe(false);
    });

    it("stops believing it when the environment moves", async () => {
      login.mockResolvedValueOnce(NOT_OFFERED);
      const { result } = renderHook(() => useAssistantAccount());
      await waitFor(() => expect(result.current.loaded).toBe(true));
      await act(async () => {
        await result.current.login();
      });
      expect(result.current.accountsUnavailable).toBe(true);

      // `restart` is what the environment-change effect passes. The next backend is a
      // different question, and carrying this answer across would answer it wrongly.
      await act(async () => {
        await result.current.reload({ restart: true });
      });

      expect(result.current.accountsUnavailable).toBe(false);
    });

    it("drops the previous environment's answer on the way across", async () => {
      // The stale-result trap. A failed read normally KEEPS the last good result — a
      // read we could not make says nothing about the credential — but across an
      // environment change that reasoning inverts: the answer being kept is about a
      // different backend, and it would offer a Sign out for an account this endpoint
      // has never heard of.
      const { result } = renderHook(() => useAssistantAccount());
      await waitFor(() => expect(result.current.loaded).toBe(true));
      expect(result.current.result).not.toBeNull();

      const pending = deferred<AssistantAccountStatusResult>();
      getStatus.mockReturnValueOnce(pending.promise);
      act(() => {
        void result.current.reload({ restart: true });
      });

      await waitFor(() => expect(result.current.result).toBeNull());
      pending.resolve(statusOf("signed_out"));
    });
  });
});
