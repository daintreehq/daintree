// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginPanelReloadRequest,
  PluginPanelReloadResponse,
} from "@shared/types/pluginPanelReload";

const handleMock = vi.hoisted(() =>
  vi.fn<(request: PluginPanelReloadRequest) => Promise<PluginPanelReloadResponse>>()
);
vi.mock("@/services/plugin/pluginPanelReload", () => ({
  handlePanelReloadRequest: handleMock,
}));
vi.mock("@/services/ActionService", () => ({ actionService: {} }));

import { usePluginBridge } from "@/hooks/usePluginBridge";

let deliver: ((request: PluginPanelReloadRequest) => void) | null = null;
const sendPanelReloadResponse = vi.fn<(response: PluginPanelReloadResponse) => void>();
const stopPanelReload = vi.fn();

const request: PluginPanelReloadRequest = {
  requestId: "r1",
  panelId: "p1",
  pluginId: "acme",
  expiresAt: Date.now() + 10_000,
};

beforeEach(() => {
  deliver = null;
  handleMock.mockReset();
  sendPanelReloadResponse.mockReset();
  stopPanelReload.mockReset();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      pluginBridge: {
        onDispatchActionRequest: () => () => {},
        onActionsListRequest: () => () => {},
        onActionsGetRequest: () => () => {},
        onPanelReloadRequest: (cb: (request: PluginPanelReloadRequest) => void) => {
          deliver = cb;
          return stopPanelReload;
        },
        sendPanelReloadResponse,
      },
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
});

describe("usePluginBridge panel reload (#12610)", () => {
  it("answers each request with the service's response", async () => {
    handleMock.mockResolvedValue({ requestId: "r1", result: "scheduled" });
    renderHook(() => usePluginBridge());
    deliver?.(request);
    await waitFor(() =>
      expect(sendPanelReloadResponse).toHaveBeenCalledWith({ requestId: "r1", result: "scheduled" })
    );
  });

  it("answers unavailable rather than leaving main waiting when handling fails", async () => {
    handleMock.mockRejectedValue(new Error("boom"));
    renderHook(() => usePluginBridge());
    deliver?.(request);
    await waitFor(() =>
      expect(sendPanelReloadResponse).toHaveBeenCalledWith({
        requestId: "r1",
        result: "unavailable",
      })
    );
  });

  it("contains a failed send", async () => {
    handleMock.mockResolvedValue({ requestId: "r1", result: "scheduled" });
    sendPanelReloadResponse.mockImplementation(() => {
      throw new Error("could not clone");
    });
    renderHook(() => usePluginBridge());
    deliver?.(request);
    await waitFor(() => expect(sendPanelReloadResponse).toHaveBeenCalled());
  });

  it("stops listening and stays silent after unmount", async () => {
    let settle: (response: PluginPanelReloadResponse) => void = () => {};
    handleMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    const { unmount } = renderHook(() => usePluginBridge());
    deliver?.(request);
    unmount();
    expect(stopPanelReload).toHaveBeenCalledTimes(1);

    settle({ requestId: "r1", result: "scheduled" });
    await Promise.resolve();
    await Promise.resolve();
    expect(sendPanelReloadResponse).not.toHaveBeenCalled();
  });
});
