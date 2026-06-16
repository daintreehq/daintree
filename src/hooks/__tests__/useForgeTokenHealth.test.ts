// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ForgeTokenHealthChangedPayload } from "@shared/types/ipc/forge";
import type { ForgeTokenHealthState } from "@shared/types/forge";

const PROVIDER_ID = "daintree.github.github";
const SUPERSEDE_KEY = `forge-token:${PROVIDER_ID}`;

let healthListener: ((payload: ForgeTokenHealthChangedPayload) => void) | null = null;
const cleanupMock = vi.fn();
const onTokenHealthChangedMock = vi.fn(
  (callback: (payload: ForgeTokenHealthChangedPayload) => void): (() => void) => {
    healthListener = callback;
    return cleanupMock;
  }
);
const getTokenHealthMock = vi.fn(
  (_providerId: string): Promise<ForgeTokenHealthState | null> =>
    Promise.resolve({ status: "unknown", tokenVersion: 0, checkedAt: 0 })
);

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: {
    onTokenHealthChanged: (cb: (payload: ForgeTokenHealthChangedPayload) => void) =>
      onTokenHealthChangedMock(cb),
    getTokenHealth: (providerId: string) => getTokenHealthMock(providerId),
  },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: { currentProject: { id: string; path: string } }) => unknown) =>
    selector({ currentProject: { id: "proj-1", path: "/repo" } }),
}));

vi.mock("@/hooks/useResolvedForgeProvider", () => ({
  useResolvedForgeProvider: () => ({
    entry: null,
    providerId: "daintree.github.github",
    resolvedVia: null,
    loading: false,
    refresh: () => {},
  }),
}));

import { useForgeTokenHealth, _resetForgeProviderMetaCacheForTest } from "../useForgeTokenHealth";
import { notify, _resetRateLimitBuckets, _resetCoalesceMap } from "@/lib/notify";
import {
  useForgeProviderHealthStore,
  DEFAULT_PROVIDER_HEALTH,
} from "@/store/forgeProviderHealthStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";

function payload(status: "unknown" | "healthy" | "unhealthy"): ForgeTokenHealthChangedPayload {
  return {
    providerId: PROVIDER_ID,
    isUnhealthy: status === "unhealthy",
    state: { status, tokenVersion: 0, checkedAt: 0 },
  };
}

function isUnhealthy(): boolean {
  return (
    useForgeProviderHealthStore.getState().providers[PROVIDER_ID]?.tokenUnhealthy ??
    DEFAULT_PROVIDER_HEALTH.tokenUnhealthy
  );
}

describe("useForgeTokenHealth", () => {
  beforeEach(() => {
    healthListener = null;
    onTokenHealthChangedMock.mockClear();
    cleanupMock.mockClear();
    getTokenHealthMock
      .mockReset()
      .mockResolvedValue({ status: "unknown", tokenVersion: 0, checkedAt: 0 });
    _resetForgeProviderMetaCacheForTest();
    window.electron = {
      forge: {
        getProviders: vi.fn(async () => [
          {
            pluginId: "daintree.github",
            contribution: { id: "github", name: "GitHub", matches: ["github.com"] },
          },
        ]),
      },
    } as unknown as typeof window.electron;
    useForgeProviderHealthStore.setState({ providers: {} });
    useNotificationHistoryStore.setState({ entries: [], unreadCount: 0 });
    // notify() runs for real here — keep toasts enabled (so a re-promotion
    // regression would actually mark `seenAsToast`) and clear cross-test
    // rate-limit / coalesce state.
    useNotificationSettingsStore.setState({ enabled: true });
    _resetRateLimitBuckets();
    _resetCoalesceMap();
  });

  it("subscribes on mount and cleans up on unmount", () => {
    const { unmount } = renderHook(() => useForgeTokenHealth());
    expect(onTokenHealthChangedMock).toHaveBeenCalledOnce();
    unmount();
    expect(cleanupMock).toHaveBeenCalledOnce();
  });

  it("flips the provider's slice to unhealthy on a transition payload", async () => {
    renderHook(() => useForgeTokenHealth());
    await act(async () => {});

    act(() => healthListener?.(payload("unhealthy")));

    expect(isUnhealthy()).toBe(true);
  });

  it("stores the full token-health snapshot for reauth display", async () => {
    renderHook(() => useForgeTokenHealth());
    await act(async () => {});

    act(() =>
      healthListener?.({
        providerId: PROVIDER_ID,
        isUnhealthy: true,
        state: {
          status: "unhealthy",
          tokenVersion: 3,
          checkedAt: 99,
          reauthUrl: "https://example.com/sso",
        },
      })
    );

    const slice = useForgeProviderHealthStore.getState().providers[PROVIDER_ID];
    expect(slice?.tokenHealth?.reauthUrl).toBe("https://example.com/sso");
  });

  it("resolves and stores provider registration metadata", async () => {
    renderHook(() => useForgeTokenHealth());
    await act(async () => {});

    act(() => healthListener?.(payload("unhealthy")));
    await act(async () => {});

    const slice = useForgeProviderHealthStore.getState().providers[PROVIDER_ID];
    expect(slice?.providerName).toBe("GitHub");
    expect(slice?.pluginId).toBe("daintree.github");
  });

  it("clears the slice when state returns to healthy", async () => {
    renderHook(() => useForgeTokenHealth());
    await act(async () => {});

    act(() => healthListener?.(payload("unhealthy")));
    expect(isUnhealthy()).toBe(true);

    act(() => healthListener?.(payload("healthy")));
    expect(isUnhealthy()).toBe(false);
  });

  it("adds an inbox entry exactly once per unhealthy transition", async () => {
    renderHook(() => useForgeTokenHealth());
    await act(async () => {});

    act(() => healthListener?.(payload("unhealthy")));
    await act(async () => {});
    act(() => healthListener?.(payload("unhealthy")));
    await act(async () => {});

    const entries = useNotificationHistoryStore.getState().entries;
    const healthEntries = entries.filter((e) => e.supersedeKey === SUPERSEDE_KEY);
    expect(healthEntries).toHaveLength(1);
  });

  it("writes an inbox-only backstop row with the provider display name that does not toast or count", async () => {
    renderHook(() => useForgeTokenHealth());
    await act(async () => {});

    act(() => healthListener?.(payload("unhealthy")));
    await act(async () => {});

    const entry = useNotificationHistoryStore
      .getState()
      .entries.find((e) => e.supersedeKey === SUPERSEDE_KEY);
    expect(entry?.supersedeKey).toBe(SUPERSEDE_KEY);
    expect(entry?.title).toBe("GitHub token expired");
    // Inbox-only backstop: must not surface as a toast, must not bump the badge.
    expect(entry?.seenAsToast).toBe(false);
    expect(entry?.countable).toBe(false);
    expect(useNotificationHistoryStore.getState().unreadCount).toBe(0);
  });

  it("keeps a single active row when a higher-priority notify() with the same supersedeKey arrives", async () => {
    renderHook(() => useForgeTokenHealth());
    await act(async () => {});

    act(() => healthListener?.(payload("unhealthy")));
    await act(async () => {});

    // Emit a high-priority notification sharing the supersedeKey through the
    // real notify() so this exercises supersedeKey forwarding end-to-end, not a
    // hand-rolled addEntry that could mask a notify() regression. (The toolbar
    // toast that used to do this was removed; the supersede mechanic it relied
    // on still must hold for any future same-key emitter.)
    act(() => {
      notify({
        type: "warning",
        priority: "high",
        title: "GitHub authentication required",
        message: "Reconnect in settings.",
        correlationId: `forge:token-expiry:${PROVIDER_ID}`,
        supersedeKey: SUPERSEDE_KEY,
      });
    });

    const active = useNotificationHistoryStore
      .getState()
      .entries.filter((e) => e.supersedeKey === SUPERSEDE_KEY && !e.archivedAt);
    expect(active).toHaveLength(1);
    expect(active[0]?.correlationId).toBe(`forge:token-expiry:${PROVIDER_ID}`);
  });

  it("does not re-promote the backstop into a toast on a second expiry cycle", async () => {
    renderHook(() => useForgeTokenHealth());
    await act(async () => {});

    // First cycle: backstop fires, then the toolbar path archives it.
    act(() => healthListener?.(payload("unhealthy")));
    await act(async () => {});
    act(() => {
      notify({
        type: "warning",
        priority: "high",
        title: "GitHub authentication required",
        message: "Reconnect in settings.",
        correlationId: `forge:token-expiry:${PROVIDER_ID}`,
        supersedeKey: SUPERSEDE_KEY,
      });
    });
    act(() => healthListener?.(payload("healthy")));

    // Second expiry: the backstop must stay inbox-only — no un-snooze re-toast.
    act(() => healthListener?.(payload("unhealthy")));
    await act(async () => {});

    // Inspect the freshly written, still-active backstop row. (Superseded rows
    // get `seenAsToast: true` flipped on archival — that's the resolved state,
    // not a toast — so the active row is the one that reflects re-promotion.)
    const active = useNotificationHistoryStore
      .getState()
      .entries.find(
        (e) =>
          e.supersedeKey === SUPERSEDE_KEY && e.title === "GitHub token expired" && !e.archivedAt
      );
    expect(active).toBeDefined();
    expect(active?.seenAsToast).toBe(false);
  });

  it("writes the backstop row on an unhealthy initial replay (no live push)", async () => {
    getTokenHealthMock.mockResolvedValueOnce({
      status: "unhealthy",
      tokenVersion: 0,
      checkedAt: 0,
    });
    renderHook(() => useForgeTokenHealth());
    await act(async () => {});
    await act(async () => {});

    const backstops = useNotificationHistoryStore
      .getState()
      .entries.filter((e) => e.supersedeKey === SUPERSEDE_KEY);
    expect(backstops).toHaveLength(1);
    expect(backstops[0]?.countable).toBe(false);
  });

  it("re-arms the inbox entry after recovery + a new failure", async () => {
    renderHook(() => useForgeTokenHealth());
    await act(async () => {});

    act(() => healthListener?.(payload("unhealthy")));
    await act(async () => {});
    act(() => healthListener?.(payload("healthy")));
    await act(async () => {});
    act(() => healthListener?.(payload("unhealthy")));
    await act(async () => {});

    // Two distinct "token expired" warning rows were written — one per failure
    // cycle. (A recovery "token validated" row sits between them, also sharing
    // the supersedeKey, so filter by title to assert the re-arm specifically.)
    const expired = useNotificationHistoryStore
      .getState()
      .entries.filter((e) => e.title === "GitHub token expired");
    expect(expired).toHaveLength(2);
  });

  it("emits an inbox-only recovery row on the unhealthy → healthy transition", async () => {
    renderHook(() => useForgeTokenHealth());
    await act(async () => {});

    act(() => healthListener?.(payload("unhealthy")));
    await act(async () => {});
    act(() => healthListener?.(payload("healthy")));
    await act(async () => {});

    const recovery = useNotificationHistoryStore
      .getState()
      .entries.find((e) => e.title === "GitHub token validated");
    expect(recovery).toBeDefined();
    expect(recovery?.type).toBe("success");
    expect(recovery?.supersedeKey).toBe(SUPERSEDE_KEY);
    // Inbox-only acknowledgement: never a toast, never bumps the badge.
    expect(recovery?.seenAsToast).toBe(false);
    expect(recovery?.countable).toBe(false);
    expect(useNotificationHistoryStore.getState().unreadCount).toBe(0);

    // The recovery row supersedes the warning, leaving one active row.
    const active = useNotificationHistoryStore
      .getState()
      .entries.filter((e) => e.supersedeKey === SUPERSEDE_KEY && !e.archivedAt);
    expect(active).toHaveLength(1);
    expect(active[0]?.title).toBe("GitHub token validated");
  });

  it("does not emit a recovery row for a healthy state with no prior failure", async () => {
    renderHook(() => useForgeTokenHealth());
    await act(async () => {});

    act(() => healthListener?.(payload("healthy")));
    await act(async () => {});

    const entries = useNotificationHistoryStore.getState().entries;
    expect(entries.filter((e) => e.supersedeKey === SUPERSEDE_KEY)).toHaveLength(0);
  });

  it("does not emit a recovery row when unmounted before the async notify runs", async () => {
    const { unmount } = renderHook(() => useForgeTokenHealth());
    await act(async () => {});

    act(() => healthListener?.(payload("unhealthy")));
    await act(async () => {});

    // Recovery fires async (awaits resolveProviderMeta). Unmount sets the
    // cancelled flag before the listener's then() runs, so no row appears.
    act(() => healthListener?.(payload("healthy")));
    unmount();
    await act(async () => {});

    const recovery = useNotificationHistoryStore
      .getState()
      .entries.find((e) => e.title === "GitHub token validated");
    expect(recovery).toBeUndefined();
  });

  it("replays initial state on mount via getTokenHealth for the resolved provider", async () => {
    getTokenHealthMock.mockResolvedValueOnce({
      status: "unhealthy",
      tokenVersion: 0,
      checkedAt: 0,
    });
    renderHook(() => useForgeTokenHealth());
    await act(async () => {});

    expect(getTokenHealthMock).toHaveBeenCalledWith(PROVIDER_ID);
    expect(isUnhealthy()).toBe(true);
  });

  it("tolerates a null replay (provider reports no health state)", async () => {
    getTokenHealthMock.mockResolvedValueOnce(null);
    renderHook(() => useForgeTokenHealth());
    await act(async () => {});

    expect(isUnhealthy()).toBe(false);
  });

  it("ignores payloads delivered after unmount", async () => {
    const { unmount } = renderHook(() => useForgeTokenHealth());
    await act(async () => {});

    unmount();
    act(() => healthListener?.(payload("unhealthy")));

    // The slice should remain false because the cancelled flag short-circuits apply().
    // (Note: cleanup() is called too, but our mock retains the listener reference for testing.)
    expect(isUnhealthy()).toBe(false);
  });

  it("clears the slice when payload status is unknown", async () => {
    renderHook(() => useForgeTokenHealth());
    await act(async () => {});

    act(() => healthListener?.(payload("unhealthy")));
    expect(isUnhealthy()).toBe(true);

    act(() => healthListener?.(payload("unknown")));
    expect(isUnhealthy()).toBe(false);
  });

  it("ignores a stale initial-replay response when a live push has already arrived", async () => {
    let resolveReplay!: (state: ForgeTokenHealthState | null) => void;
    getTokenHealthMock.mockImplementationOnce(
      () =>
        new Promise<ForgeTokenHealthState | null>((resolve) => {
          resolveReplay = resolve;
        })
    );

    renderHook(() => useForgeTokenHealth());
    // Subscribe is sync; let the hook attach.
    await act(async () => {});

    // Live push lands first.
    act(() => healthListener?.(payload("unhealthy")));
    expect(isUnhealthy()).toBe(true);

    // Now the slow replay resolves with stale data — must NOT overwrite the live state.
    await act(async () => {
      resolveReplay({ status: "healthy", tokenVersion: 0, checkedAt: 0 });
    });
    expect(isUnhealthy()).toBe(true);
  });
});
