// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { NotifyPayload } from "@/lib/notify";

const PROVIDER_ID = "daintree.github.github";
const SUPERSEDE_KEY = `forge-token:${PROVIDER_ID}`;

const notifyMock = vi.fn<(payload: NotifyPayload) => string>();

vi.mock("@/lib/notify", () => ({
  notify: (...args: [NotifyPayload]) => notifyMock(...args),
}));

const dispatchMock = vi.fn();

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => dispatchMock(...args),
  },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: { currentProject: { id: string; path: string } }) => unknown) =>
    selector({ currentProject: { id: "proj-1", path: "/repo" } }),
}));

vi.mock("@/hooks/useResolvedForgeProvider", () => ({
  useResolvedForgeProvider: () => ({
    entry: {
      pluginId: "daintree.github",
      contribution: { id: "github", name: "GitHub", matches: ["github.com"] },
    },
    providerId: "daintree.github.github",
    resolvedVia: "hostname",
    loading: false,
    refresh: () => {},
  }),
}));

import { useForgeProviderHealthStore } from "@/store/forgeProviderHealthStore";
import { useForgeTokenExpiryNotification } from "../useForgeTokenExpiryNotification";

function setUnhealthy(value: boolean) {
  useForgeProviderHealthStore.getState().setTokenUnhealthy(PROVIDER_ID, value);
}

describe("useForgeTokenExpiryNotification", () => {
  beforeEach(() => {
    notifyMock.mockReset();
    notifyMock.mockReturnValue("notification-id");
    dispatchMock.mockReset();
    useForgeProviderHealthStore.setState({ providers: {} });
  });

  it("does not fire when isTokenError starts false", () => {
    renderHook(({ isTokenError }) => useForgeTokenExpiryNotification(isTokenError), {
      initialProps: { isTokenError: false },
    });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("fires once on false → true transition when unhealthy", () => {
    setUnhealthy(true);
    const { rerender } = renderHook(
      ({ isTokenError }) => useForgeTokenExpiryNotification(isTokenError),
      { initialProps: { isTokenError: false } }
    );
    expect(notifyMock).not.toHaveBeenCalled();

    rerender({ isTokenError: true });
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("does not fire again on subsequent true → true renders", () => {
    setUnhealthy(true);
    const { rerender } = renderHook(
      ({ isTokenError }) => useForgeTokenExpiryNotification(isTokenError),
      { initialProps: { isTokenError: true } }
    );
    expect(notifyMock).toHaveBeenCalledTimes(1);

    rerender({ isTokenError: true });
    rerender({ isTokenError: true });
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("re-fires after a true → false → true cycle (latch resets when error clears)", () => {
    setUnhealthy(true);
    const { rerender } = renderHook(
      ({ isTokenError }) => useForgeTokenExpiryNotification(isTokenError),
      { initialProps: { isTokenError: true } }
    );
    expect(notifyMock).toHaveBeenCalledTimes(1);

    // Recovery transition emits a low-priority "Token validated" row.
    rerender({ isTokenError: false });
    expect(notifyMock).toHaveBeenCalledTimes(2);
    const recovery = notifyMock.mock.calls[1]?.[0];
    expect(recovery?.type).toBe("success");
    expect(recovery?.priority).toBe("low");
    expect(recovery?.supersedeKey).toBe(SUPERSEDE_KEY);

    rerender({ isTokenError: true });
    expect(notifyMock).toHaveBeenCalledTimes(3);
  });

  it("constructs a provider-named action with actionId, actionArgs, and a working onClick", () => {
    setUnhealthy(true);
    renderHook(({ isTokenError }) => useForgeTokenExpiryNotification(isTokenError), {
      initialProps: { isTokenError: true },
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = notifyMock.mock.calls[0]?.[0];
    if (!payload) throw new Error("notify was not called");

    expect(payload.type).toBe("warning");
    expect(payload.priority).toBe("high");
    expect(payload.correlationId).toBe(`forge:token-expiry:${PROVIDER_ID}`);
    expect(payload.supersedeKey).toBe(SUPERSEDE_KEY);
    expect(payload.title).toBe("GitHub authentication required");
    expect(payload.coalesce?.key).toBe(`forge:token-expiry:${PROVIDER_ID}`);

    expect(payload.action).toBeDefined();
    expect(payload.action?.label).toBe("Open GitHub settings");
    expect(payload.action?.actionId).toBe("app.settings.openTab");
    expect(payload.action?.actionArgs).toEqual({
      tab: "code-forge",
      subtab: PROVIDER_ID,
    });

    payload.action?.onClick();
    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "code-forge", subtab: PROVIDER_ID },
      { source: "user" }
    );
  });

  it("does not fire when isTokenError is true but token is healthy (gate)", () => {
    const { rerender } = renderHook(
      ({ isTokenError }) => useForgeTokenExpiryNotification(isTokenError),
      { initialProps: { isTokenError: false } }
    );
    rerender({ isTokenError: true });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("fires when isTokenError is true and token becomes unhealthy", () => {
    const { rerender } = renderHook(
      ({ isTokenError }) => useForgeTokenExpiryNotification(isTokenError),
      { initialProps: { isTokenError: true } }
    );
    expect(notifyMock).not.toHaveBeenCalled();

    act(() => setUnhealthy(true));
    rerender({ isTokenError: true });
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("latch resets silently when health recovers while error persists, re-fires on next unhealthy", () => {
    setUnhealthy(true);
    const { rerender } = renderHook(
      ({ isTokenError }) => useForgeTokenExpiryNotification(isTokenError),
      { initialProps: { isTokenError: true } }
    );
    expect(notifyMock).toHaveBeenCalledTimes(1);

    // `isUnhealthy` clearing while `isTokenError` stays true is not a true
    // recovery — silently re-arm the latch but do NOT emit the success row.
    act(() => setUnhealthy(false));
    rerender({ isTokenError: true });
    expect(notifyMock).toHaveBeenCalledTimes(1);

    act(() => setUnhealthy(true));
    rerender({ isTokenError: true });
    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(notifyMock.mock.calls[1]?.[0]?.type).toBe("warning");
  });

  it("does not emit recovery when only isUnhealthy clears (isTokenError still true)", () => {
    setUnhealthy(true);
    const { rerender } = renderHook(
      ({ isTokenError }) => useForgeTokenExpiryNotification(isTokenError),
      { initialProps: { isTokenError: true } }
    );
    expect(notifyMock).toHaveBeenCalledTimes(1);

    act(() => setUnhealthy(false));
    rerender({ isTokenError: true });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    // No success row emitted — the token error is still active per the caller's signal.
    expect(notifyMock.mock.calls.every((c) => c[0]?.type === "warning")).toBe(true);
  });

  it("emits a low-priority recovery row with matching supersedeKey on true → false transition", () => {
    setUnhealthy(true);
    const { rerender } = renderHook(
      ({ isTokenError }) => useForgeTokenExpiryNotification(isTokenError),
      { initialProps: { isTokenError: true } }
    );
    expect(notifyMock).toHaveBeenCalledTimes(1);

    rerender({ isTokenError: false });
    expect(notifyMock).toHaveBeenCalledTimes(2);
    const recovery = notifyMock.mock.calls[1]?.[0];
    if (!recovery) throw new Error("recovery notify was not called");
    expect(recovery.type).toBe("success");
    expect(recovery.priority).toBe("low");
    expect(recovery.supersedeKey).toBe(SUPERSEDE_KEY);
    expect(recovery.title).toBe("GitHub token validated");
  });

  it("does not emit a recovery row when no prior warning was fired", () => {
    const { rerender } = renderHook(
      ({ isTokenError }) => useForgeTokenExpiryNotification(isTokenError),
      { initialProps: { isTokenError: false } }
    );
    expect(notifyMock).not.toHaveBeenCalled();

    rerender({ isTokenError: false });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("suppresses toast when isTokenError is true but isUnhealthy stays false across renders", () => {
    const { rerender } = renderHook(
      ({ isTokenError }) => useForgeTokenExpiryNotification(isTokenError),
      { initialProps: { isTokenError: true } }
    );
    rerender({ isTokenError: true });
    rerender({ isTokenError: true });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("reacts to Zustand store change without explicit rerender", () => {
    renderHook(({ isTokenError }) => useForgeTokenExpiryNotification(isTokenError), {
      initialProps: { isTokenError: true },
    });
    expect(notifyMock).not.toHaveBeenCalled();

    act(() => {
      setUnhealthy(true);
    });
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });
});
