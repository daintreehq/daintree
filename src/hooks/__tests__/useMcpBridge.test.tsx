// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionManifestEntry } from "@shared/types/actions";

const mocks = vi.hoisted(() => ({
  list: vi.fn(() => [] as ActionManifestEntry[]),
  dispatch: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    list: mocks.list,
    dispatch: mocks.dispatch,
  },
}));

import { useMcpBridge } from "../useMcpBridge";

describe("useMcpBridge", () => {
  let manifestHandler: ((requestId: string) => void) | undefined;
  let dispatchHandler:
    | ((payload: {
        requestId: string;
        actionId: string;
        args?: unknown;
        confirmed?: boolean;
      }) => void | Promise<void>)
    | undefined;
  let cleanupManifest: ReturnType<typeof vi.fn>;
  let cleanupDispatch: ReturnType<typeof vi.fn>;
  let sendGetManifestResponse: ReturnType<typeof vi.fn>;
  let sendDispatchActionResponse: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    manifestHandler = undefined;
    dispatchHandler = undefined;
    cleanupManifest = vi.fn();
    cleanupDispatch = vi.fn();
    sendGetManifestResponse = vi.fn();
    sendDispatchActionResponse = vi.fn();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        mcpBridge: {
          onGetManifestRequest: (callback: (requestId: string) => void) => {
            manifestHandler = callback;
            return cleanupManifest;
          },
          sendGetManifestResponse,
          onDispatchActionRequest: (
            callback: (payload: {
              requestId: string;
              actionId: string;
              args?: unknown;
              confirmed?: boolean;
            }) => void | Promise<void>
          ) => {
            dispatchHandler = callback;
            return cleanupDispatch;
          },
          sendDispatchActionResponse,
        },
      },
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("returns the current action manifest and falls back to an empty manifest on failure", () => {
    mocks.list.mockReturnValueOnce([
      {
        id: "actions.list",
        name: "actions.list",
        title: "List Actions",
        description: "Read actions",
        category: "test",
        kind: "query",
        danger: "safe",
        enabled: true,
        requiresArgs: false,
      },
    ]);

    renderHook(() => useMcpBridge());

    manifestHandler?.("req-1");
    expect(sendGetManifestResponse).toHaveBeenCalledWith("req-1", [
      expect.objectContaining({ id: "actions.list" }),
    ]);

    mocks.list.mockImplementationOnce(() => {
      throw new Error("manifest exploded");
    });

    manifestHandler?.("req-2");
    expect(sendGetManifestResponse).toHaveBeenCalledWith("req-2", []);
  });

  it("passes explicit confirmation through instead of auto-confirming every MCP action", async () => {
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

    renderHook(() => useMcpBridge());

    await dispatchHandler?.({
      requestId: "req-unconfirmed",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-1" },
    });
    await dispatchHandler?.({
      requestId: "req-confirmed",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-1" },
      confirmed: true,
    });

    expect(mocks.dispatch).toHaveBeenNthCalledWith(
      1,
      "worktree.delete",
      { worktreeId: "wt-1" },
      { source: "agent", confirmed: undefined }
    );
    expect(mocks.dispatch).toHaveBeenNthCalledWith(
      2,
      "worktree.delete",
      { worktreeId: "wt-1" },
      { source: "agent", confirmed: true }
    );
  });

  it("wraps bridge dispatch failures as execution errors", async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error("dispatch exploded"));

    renderHook(() => useMcpBridge());

    await dispatchHandler?.({
      requestId: "req-err",
      actionId: "actions.list",
      args: { search: "test" },
    });

    expect(sendDispatchActionResponse).toHaveBeenCalledWith({
      requestId: "req-err",
      result: {
        ok: false,
        error: {
          code: "EXECUTION_ERROR",
          message: "dispatch exploded",
        },
      },
    });
  });

  it("cleans up bridge listeners on unmount", () => {
    const { unmount } = renderHook(() => useMcpBridge());

    unmount();

    expect(cleanupManifest).toHaveBeenCalledTimes(1);
    expect(cleanupDispatch).toHaveBeenCalledTimes(1);
  });
});
