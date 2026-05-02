// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionManifestEntry } from "@shared/types/actions";
import { __resetMcpConfirmStoreForTesting, useMcpConfirmStore } from "@/store/mcpConfirmStore";

const mocks = vi.hoisted(() => ({
  list: vi.fn(() => [] as ActionManifestEntry[]),
  get: vi.fn((_id: string): ActionManifestEntry | null => null),
  dispatch: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    list: mocks.list,
    get: mocks.get,
    dispatch: mocks.dispatch,
  },
}));

import { useMcpBridge } from "../useMcpBridge";

function safeManifestEntry(overrides: Partial<ActionManifestEntry> = {}): ActionManifestEntry {
  return {
    id: "actions.list",
    name: "actions.list",
    title: "List Actions",
    description: "Read actions",
    category: "test",
    kind: "query",
    danger: "safe",
    enabled: true,
    requiresArgs: false,
    ...overrides,
  };
}

function confirmManifestEntry(overrides: Partial<ActionManifestEntry> = {}): ActionManifestEntry {
  return {
    id: "worktree.delete",
    name: "worktree.delete",
    title: "Delete Worktree",
    description: "Permanently delete a worktree from disk.",
    category: "worktree",
    kind: "command",
    danger: "confirm",
    enabled: true,
    requiresArgs: true,
    ...overrides,
  };
}

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
    __resetMcpConfirmStoreForTesting();
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
    __resetMcpConfirmStoreForTesting();
  });

  it("returns the current action manifest and falls back to an empty manifest on failure", () => {
    mocks.list.mockReturnValueOnce([safeManifestEntry()]);

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

  it("dispatches safe actions immediately without surfacing a confirmation modal", async () => {
    mocks.get.mockReturnValue(safeManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

    renderHook(() => useMcpBridge());

    await dispatchHandler?.({
      requestId: "req-safe",
      actionId: "actions.list",
      args: { limit: 10 },
    });

    expect(useMcpConfirmStore.getState().current).toBeNull();
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "actions.list",
      { limit: 10 },
      { source: "agent", confirmed: undefined }
    );
    expect(sendDispatchActionResponse).toHaveBeenCalledWith({
      requestId: "req-safe",
      result: { ok: true, result: { ok: true } },
      confirmationDecision: undefined,
    });
  });

  it("queues a confirm-class dispatch and only forwards it after user approval", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-confirm",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-1" },
    });

    await Promise.resolve();
    const pending = useMcpConfirmStore.getState().current;
    expect(pending).not.toBeNull();
    expect(pending?.actionTitle).toBe("Delete Worktree");
    expect(pending?.argsSummary).toContain("wt-1");
    expect(mocks.dispatch).not.toHaveBeenCalled();

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "worktree.delete",
      { worktreeId: "wt-1" },
      { source: "agent", confirmed: true }
    );
    expect(sendDispatchActionResponse).toHaveBeenCalledWith({
      requestId: "req-confirm",
      result: { ok: true, result: { ok: true } },
      confirmationDecision: "approved",
    });
  });

  it("returns USER_REJECTED without ever calling actionService.dispatch when the user cancels", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-reject",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-2" },
    });

    await Promise.resolve();
    useMcpConfirmStore.getState().resolveCurrent("rejected");
    await dispatched;

    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(sendDispatchActionResponse).toHaveBeenCalledWith({
      requestId: "req-reject",
      result: {
        ok: false,
        error: {
          code: "USER_REJECTED",
          message: expect.stringContaining("rejected"),
        },
      },
      confirmationDecision: "rejected",
    });
  });

  it("returns CONFIRMATION_TIMEOUT when the modal ages out without a decision", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

    renderHook(() => useMcpBridge());

    const dispatched = dispatchHandler?.({
      requestId: "req-timeout",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-3" },
    });

    await Promise.resolve();
    useMcpConfirmStore.getState().resolveCurrent("timeout");
    await dispatched;

    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(sendDispatchActionResponse).toHaveBeenCalledWith({
      requestId: "req-timeout",
      result: {
        ok: false,
        error: {
          code: "CONFIRMATION_TIMEOUT",
          message: expect.stringContaining("timed out"),
        },
      },
      confirmationDecision: "timeout",
    });
  });

  it("skips the modal when the agent already supplied confirmed=true", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());
    mocks.dispatch.mockResolvedValue({ ok: true, result: { ok: true } });

    renderHook(() => useMcpBridge());

    await dispatchHandler?.({
      requestId: "req-pre-confirmed",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-4" },
      confirmed: true,
    });

    expect(useMcpConfirmStore.getState().current).toBeNull();
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "worktree.delete",
      { worktreeId: "wt-4" },
      { source: "agent", confirmed: true }
    );
    expect(sendDispatchActionResponse).toHaveBeenCalledWith({
      requestId: "req-pre-confirmed",
      result: { ok: true, result: { ok: true } },
      confirmationDecision: undefined,
    });
  });

  it("wraps bridge dispatch failures as execution errors", async () => {
    mocks.get.mockReturnValue(safeManifestEntry());
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
      confirmationDecision: undefined,
    });
  });

  it("cleans up bridge listeners on unmount", () => {
    const { unmount } = renderHook(() => useMcpBridge());

    unmount();

    expect(cleanupManifest).toHaveBeenCalledTimes(1);
    expect(cleanupDispatch).toHaveBeenCalledTimes(1);
  });

  it("drops in-flight confirmations from the store on unmount and never sends a late response", async () => {
    mocks.get.mockReturnValue(confirmManifestEntry());

    const { unmount } = renderHook(() => useMcpBridge());

    void dispatchHandler?.({
      requestId: "req-late",
      actionId: "worktree.delete",
      args: { worktreeId: "wt-late" },
    });

    await Promise.resolve();
    expect(useMcpConfirmStore.getState().current?.requestId).toBe("req-late");

    unmount();
    expect(useMcpConfirmStore.getState().current).toBeNull();
    expect(useMcpConfirmStore.getState().queue).toHaveLength(0);

    // resolveCurrent is now a no-op (nothing visible) and the resolver was
    // dropped, so no response is ever sent — main's 30s dispatch timer
    // handles the orphaned pending entry.
    useMcpConfirmStore.getState().resolveCurrent("approved");
    await Promise.resolve();
    await Promise.resolve();

    expect(sendDispatchActionResponse).not.toHaveBeenCalled();
  });
});
