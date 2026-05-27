// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionDispatchResult } from "@shared/types/actions";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: mocks.dispatch,
  },
}));

import { usePluginDispatchBridge } from "../usePluginDispatchBridge";

describe("usePluginDispatchBridge", () => {
  let dispatchHandler:
    | ((payload: {
        requestId: string;
        pluginId: string;
        actionId: string;
        args?: unknown;
      }) => void | Promise<void>)
    | undefined;
  let cleanup: ReturnType<typeof vi.fn>;
  let sendDispatchActionResponse: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    dispatchHandler = undefined;
    cleanup = vi.fn();
    sendDispatchActionResponse = vi.fn();

    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        pluginDispatchBridge: {
          onDispatchActionRequest: (
            callback: (payload: {
              requestId: string;
              pluginId: string;
              actionId: string;
              args?: unknown;
            }) => void | Promise<void>
          ) => {
            dispatchHandler = callback;
            return cleanup;
          },
          sendDispatchActionResponse,
        },
      },
    });
  });

  afterEach(() => {
    // @ts-expect-error reset test global
    delete window.electron;
  });

  it("dispatches as the plugin source threading pluginId, and replies with the result", async () => {
    const result: ActionDispatchResult = { ok: true, result: { done: true } };
    mocks.dispatch.mockResolvedValue(result);

    renderHook(() => usePluginDispatchBridge());

    await dispatchHandler?.({
      requestId: "req-1",
      pluginId: "acme.tools",
      actionId: "terminal.new",
      args: { foo: "bar" },
    });

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "terminal.new",
      { foo: "bar" },
      { source: "plugin", pluginId: "acme.tools" }
    );
    expect(sendDispatchActionResponse).toHaveBeenCalledWith({ requestId: "req-1", result });
  });

  it("forwards a structured error result without throwing across the boundary", async () => {
    const errorResult: ActionDispatchResult = {
      ok: false,
      error: { code: "RESTRICTED", message: "nope" },
    };
    mocks.dispatch.mockResolvedValue(errorResult);

    renderHook(() => usePluginDispatchBridge());

    await dispatchHandler?.({
      requestId: "req-2",
      pluginId: "acme.tools",
      actionId: "system.restart",
    });

    expect(sendDispatchActionResponse).toHaveBeenCalledWith({
      requestId: "req-2",
      result: errorResult,
    });
  });

  it("converts a thrown dispatch into an EXECUTION_ERROR result", async () => {
    mocks.dispatch.mockRejectedValue(new Error("kaboom"));

    renderHook(() => usePluginDispatchBridge());

    await dispatchHandler?.({
      requestId: "req-3",
      pluginId: "acme.tools",
      actionId: "terminal.new",
    });

    expect(sendDispatchActionResponse).toHaveBeenCalledWith({
      requestId: "req-3",
      result: {
        ok: false,
        error: { code: "EXECUTION_ERROR", message: expect.stringContaining("kaboom") },
      },
    });
  });

  it("does not reply after unmount", async () => {
    let resolveDispatch: (value: ActionDispatchResult) => void = () => {};
    mocks.dispatch.mockReturnValue(
      new Promise<ActionDispatchResult>((resolve) => {
        resolveDispatch = resolve;
      })
    );

    const { unmount } = renderHook(() => usePluginDispatchBridge());

    const pending = dispatchHandler?.({
      requestId: "req-4",
      pluginId: "acme.tools",
      actionId: "terminal.new",
    });

    unmount();
    resolveDispatch({ ok: true, result: null });
    await pending;

    expect(sendDispatchActionResponse).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
  });

  it("is a no-op when the bridge is unavailable", () => {
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {},
    });
    expect(() => renderHook(() => usePluginDispatchBridge())).not.toThrow();
  });
});
