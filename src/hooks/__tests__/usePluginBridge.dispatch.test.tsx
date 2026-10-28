// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionDispatchOptions, ActionDispatchResult } from "@shared/types/actions";

const dispatch = vi.hoisted(() =>
  vi.fn<
    (id: string, args: unknown, options: ActionDispatchOptions) => Promise<ActionDispatchResult>
  >()
);

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch,
    list: () => [],
    get: () => null,
    deniesPluginDispatch: () => false,
  },
}));
vi.mock("@/services/plugin/pluginPanelReload", () => ({
  handlePanelReloadRequest: vi.fn(),
}));

import { usePluginBridge } from "@/hooks/usePluginBridge";

type DispatchRequest = { requestId: string; actionId: string; args?: unknown; pluginId?: string };

let requestDispatch: ((request: DispatchRequest) => Promise<void>) | null = null;
const sendDispatchActionResponse = vi.fn();

beforeEach(() => {
  dispatch.mockReset();
  dispatch.mockResolvedValue({ ok: true, result: undefined });
  sendDispatchActionResponse.mockReset();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      pluginBridge: {
        onDispatchActionRequest: (cb: typeof requestDispatch) => {
          requestDispatch = cb;
          return () => {};
        },
        sendDispatchActionResponse,
        onActionsListRequest: () => () => {},
        onActionsGetRequest: () => () => {},
      },
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
  requestDispatch = null;
});

describe("usePluginBridge dispatch attribution (#13759)", () => {
  it("dispatches as the plugin source, attributed to the caller main named", async () => {
    renderHook(() => usePluginBridge());
    await requestDispatch?.({
      requestId: "r1",
      actionId: "terminal.new",
      args: { cwd: "/tmp" },
      pluginId: "acme.caller",
    });

    expect(dispatch).toHaveBeenCalledWith(
      "terminal.new",
      { cwd: "/tmp" },
      { source: "plugin", callerPluginId: "acme.caller" }
    );
    expect(sendDispatchActionResponse).toHaveBeenCalledWith({
      requestId: "r1",
      result: { ok: true, result: undefined },
    });
  });

  it("dispatches unattributed when main named no caller", async () => {
    renderHook(() => usePluginBridge());
    await requestDispatch?.({ requestId: "r2", actionId: "plugin.openSettings" });

    const options = dispatch.mock.calls[0]![2];
    expect(options.source).toBe("plugin");
    expect(options.callerPluginId).toBeUndefined();
  });
});
