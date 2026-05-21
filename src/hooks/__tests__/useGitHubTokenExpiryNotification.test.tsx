// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { NotifyPayload } from "@/lib/notify";

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

import { useGitHubTokenHealthStore } from "@/store/githubTokenHealthStore";
import { useGitHubTokenExpiryNotification } from "../useGitHubTokenExpiryNotification";

describe("useGitHubTokenExpiryNotification", () => {
  beforeEach(() => {
    notifyMock.mockReset();
    notifyMock.mockReturnValue("notification-id");
    dispatchMock.mockReset();
    useGitHubTokenHealthStore.setState({ isUnhealthy: false });
  });

  it("does not fire when isTokenError starts false", () => {
    renderHook(({ isTokenError }) => useGitHubTokenExpiryNotification(isTokenError), {
      initialProps: { isTokenError: false },
    });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("fires once on false → true transition when unhealthy", () => {
    useGitHubTokenHealthStore.setState({ isUnhealthy: true });
    const { rerender } = renderHook(
      ({ isTokenError }) => useGitHubTokenExpiryNotification(isTokenError),
      { initialProps: { isTokenError: false } }
    );
    expect(notifyMock).not.toHaveBeenCalled();

    rerender({ isTokenError: true });
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("does not fire again on subsequent true → true renders", () => {
    useGitHubTokenHealthStore.setState({ isUnhealthy: true });
    const { rerender } = renderHook(
      ({ isTokenError }) => useGitHubTokenExpiryNotification(isTokenError),
      { initialProps: { isTokenError: true } }
    );
    expect(notifyMock).toHaveBeenCalledTimes(1);

    rerender({ isTokenError: true });
    rerender({ isTokenError: true });
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("re-fires after a true → false → true cycle (latch resets when error clears)", () => {
    useGitHubTokenHealthStore.setState({ isUnhealthy: true });
    const { rerender } = renderHook(
      ({ isTokenError }) => useGitHubTokenExpiryNotification(isTokenError),
      { initialProps: { isTokenError: true } }
    );
    expect(notifyMock).toHaveBeenCalledTimes(1);

    // Recovery transition emits a low-priority "Token validated" row.
    rerender({ isTokenError: false });
    expect(notifyMock).toHaveBeenCalledTimes(2);
    const recovery = notifyMock.mock.calls[1]?.[0];
    expect(recovery?.type).toBe("success");
    expect(recovery?.priority).toBe("low");
    expect(recovery?.supersedeKey).toBe("github.token");

    rerender({ isTokenError: true });
    expect(notifyMock).toHaveBeenCalledTimes(3);
  });

  it("constructs an action with actionId, actionArgs, and a working onClick", () => {
    useGitHubTokenHealthStore.setState({ isUnhealthy: true });
    renderHook(({ isTokenError }) => useGitHubTokenExpiryNotification(isTokenError), {
      initialProps: { isTokenError: true },
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = notifyMock.mock.calls[0]?.[0];
    if (!payload) throw new Error("notify was not called");

    expect(payload.type).toBe("warning");
    expect(payload.priority).toBe("high");
    expect(payload.correlationId).toBe("github:token-expiry");
    expect(payload.supersedeKey).toBe("github.token");
    expect(payload.title).toBe("GitHub authentication required");
    expect(payload.coalesce?.key).toBe("github:token-expiry");

    expect(payload.action).toBeDefined();
    expect(payload.action?.label).toBe("Open GitHub settings");
    expect(payload.action?.actionId).toBe("app.settings.openTab");
    expect(payload.action?.actionArgs).toEqual({
      tab: "code-forge",
      subtab: "github",
      sectionId: "github-token",
    });

    payload.action?.onClick();
    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "code-forge", subtab: "github", sectionId: "github-token" },
      { source: "user" }
    );
  });

  it("does not fire when isTokenError is true but token is healthy (gate)", () => {
    const { rerender } = renderHook(
      ({ isTokenError }) => useGitHubTokenExpiryNotification(isTokenError),
      { initialProps: { isTokenError: false } }
    );
    rerender({ isTokenError: true });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("fires when isTokenError is true and token becomes unhealthy", () => {
    const { rerender } = renderHook(
      ({ isTokenError }) => useGitHubTokenExpiryNotification(isTokenError),
      { initialProps: { isTokenError: true } }
    );
    expect(notifyMock).not.toHaveBeenCalled();

    useGitHubTokenHealthStore.setState({ isUnhealthy: true });
    rerender({ isTokenError: true });
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("latch resets silently when health recovers while error persists, re-fires on next unhealthy", () => {
    useGitHubTokenHealthStore.setState({ isUnhealthy: true });
    const { rerender } = renderHook(
      ({ isTokenError }) => useGitHubTokenExpiryNotification(isTokenError),
      { initialProps: { isTokenError: true } }
    );
    expect(notifyMock).toHaveBeenCalledTimes(1);

    // `isUnhealthy` clearing while `isTokenError` stays true is not a true
    // recovery — silently re-arm the latch but do NOT emit the success row.
    useGitHubTokenHealthStore.setState({ isUnhealthy: false });
    rerender({ isTokenError: true });
    expect(notifyMock).toHaveBeenCalledTimes(1);

    useGitHubTokenHealthStore.setState({ isUnhealthy: true });
    rerender({ isTokenError: true });
    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(notifyMock.mock.calls[1]?.[0]?.type).toBe("warning");
  });

  it("does not emit recovery when only isUnhealthy clears (isTokenError still true)", () => {
    useGitHubTokenHealthStore.setState({ isUnhealthy: true });
    const { rerender } = renderHook(
      ({ isTokenError }) => useGitHubTokenExpiryNotification(isTokenError),
      { initialProps: { isTokenError: true } }
    );
    expect(notifyMock).toHaveBeenCalledTimes(1);

    useGitHubTokenHealthStore.setState({ isUnhealthy: false });
    rerender({ isTokenError: true });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    // No success row emitted — the token error is still active per the caller's signal.
    expect(notifyMock.mock.calls.every((c) => c[0]?.type === "warning")).toBe(true);
  });

  it("emits a low-priority recovery row with matching supersedeKey on true → false transition", () => {
    useGitHubTokenHealthStore.setState({ isUnhealthy: true });
    const { rerender } = renderHook(
      ({ isTokenError }) => useGitHubTokenExpiryNotification(isTokenError),
      { initialProps: { isTokenError: true } }
    );
    expect(notifyMock).toHaveBeenCalledTimes(1);

    rerender({ isTokenError: false });
    expect(notifyMock).toHaveBeenCalledTimes(2);
    const recovery = notifyMock.mock.calls[1]?.[0];
    if (!recovery) throw new Error("recovery notify was not called");
    expect(recovery.type).toBe("success");
    expect(recovery.priority).toBe("low");
    expect(recovery.supersedeKey).toBe("github.token");
    expect(recovery.title).toBe("GitHub token validated");
  });

  it("does not emit a recovery row when no prior warning was fired", () => {
    const { rerender } = renderHook(
      ({ isTokenError }) => useGitHubTokenExpiryNotification(isTokenError),
      { initialProps: { isTokenError: false } }
    );
    expect(notifyMock).not.toHaveBeenCalled();

    rerender({ isTokenError: false });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("suppresses toast when isTokenError is true but isUnhealthy stays false across renders", () => {
    const { rerender } = renderHook(
      ({ isTokenError }) => useGitHubTokenExpiryNotification(isTokenError),
      { initialProps: { isTokenError: true } }
    );
    rerender({ isTokenError: true });
    rerender({ isTokenError: true });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("reacts to Zustand store change without explicit rerender", () => {
    renderHook(({ isTokenError }) => useGitHubTokenExpiryNotification(isTokenError), {
      initialProps: { isTokenError: true },
    });
    expect(notifyMock).not.toHaveBeenCalled();

    act(() => {
      useGitHubTokenHealthStore.setState({ isUnhealthy: true });
    });
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });
});
