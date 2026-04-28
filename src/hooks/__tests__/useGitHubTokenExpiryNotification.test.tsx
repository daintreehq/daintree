// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
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

import { useGitHubTokenExpiryNotification } from "../useGitHubTokenExpiryNotification";

describe("useGitHubTokenExpiryNotification", () => {
  beforeEach(() => {
    notifyMock.mockReset();
    notifyMock.mockReturnValue("notification-id");
    dispatchMock.mockReset();
  });

  it("does not fire when isTokenError starts false", () => {
    renderHook(({ isTokenError }) => useGitHubTokenExpiryNotification(isTokenError), {
      initialProps: { isTokenError: false },
    });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("fires once on false → true transition", () => {
    const { rerender } = renderHook(
      ({ isTokenError }) => useGitHubTokenExpiryNotification(isTokenError),
      { initialProps: { isTokenError: false } }
    );
    expect(notifyMock).not.toHaveBeenCalled();

    rerender({ isTokenError: true });
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("does not fire again on subsequent true → true renders", () => {
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
    const { rerender } = renderHook(
      ({ isTokenError }) => useGitHubTokenExpiryNotification(isTokenError),
      { initialProps: { isTokenError: true } }
    );
    expect(notifyMock).toHaveBeenCalledTimes(1);

    rerender({ isTokenError: false });
    expect(notifyMock).toHaveBeenCalledTimes(1);

    rerender({ isTokenError: true });
    expect(notifyMock).toHaveBeenCalledTimes(2);
  });

  it("constructs an action with actionId, actionArgs, and a working onClick", () => {
    renderHook(({ isTokenError }) => useGitHubTokenExpiryNotification(isTokenError), {
      initialProps: { isTokenError: true },
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = notifyMock.mock.calls[0]?.[0];
    if (!payload) throw new Error("notify was not called");

    expect(payload.type).toBe("warning");
    expect(payload.priority).toBe("high");
    expect(payload.correlationId).toBe("github:token-expiry");
    expect(payload.title).toBe("GitHub authentication required");
    expect(payload.coalesce?.key).toBe("github:token-expiry");

    expect(payload.action).toBeDefined();
    expect(payload.action?.label).toBe("Open GitHub settings");
    expect(payload.action?.actionId).toBe("app.settings.openTab");
    expect(payload.action?.actionArgs).toEqual({
      tab: "github",
      sectionId: "github-token",
    });

    payload.action?.onClick();
    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "github", sectionId: "github-token" },
      { source: "user" }
    );
  });
});
