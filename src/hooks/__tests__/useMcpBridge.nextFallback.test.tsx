// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionManifestEntry } from "@shared/types/actions";
import { __resetMcpConfirmStoreForTesting, useMcpConfirmStore } from "@/store/mcpConfirmStore";

const mocks = vi.hoisted(() => ({
  get: vi.fn((_id: string): ActionManifestEntry | null => null),
  dispatch: vi.fn(),
  getContext: vi.fn((): Record<string, unknown> => ({})),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    listForTransfer: () => [],
    getDispatchMeta: mocks.get,
    dispatch: mocks.dispatch,
    getContext: mocks.getContext,
  },
}));

import { useMcpBridge } from "../useMcpBridge";

const MOVE = "terminal.restartOnPreset";
const ARGS = { terminalId: "t-1", presetId: "work" };

function entry(id: string): ActionManifestEntry {
  return {
    id,
    name: id,
    title: "Restart agent on preset",
    description: "Respawn an agent terminal on another preset.",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    enabled: true,
    requiresArgs: true,
  };
}

type DispatchPayload = {
  requestId: string;
  actionId: string;
  args?: unknown;
  confirmed?: boolean;
  sessionOrigin?: "help" | "external";
  confirmationCondition?: "next-own-fallback";
  approvalOnly?: boolean;
};

describe("the assistant's next-fallback tick through the MCP bridge (#17917)", () => {
  let dispatchHandler: ((payload: DispatchPayload) => void | Promise<void>) | undefined;
  let sendDispatchActionResponse: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetMcpConfirmStoreForTesting();
    mocks.get.mockImplementation((id) => entry(id));
    dispatchHandler = undefined;
    sendDispatchActionResponse = vi.fn();
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        mcpBridge: {
          onGetManifestRequest: () => vi.fn(),
          sendGetManifestResponse: vi.fn(),
          onDispatchActionRequest: (callback: (payload: DispatchPayload) => Promise<void>) => {
            dispatchHandler = callback;
            return vi.fn();
          },
          sendDispatchActionResponse,
        },
        mcpServer: {
          holdDispatch: vi.fn(async () => ({ held: true, remainingMs: 30_000 })),
        },
      },
    });
    renderHook(() => useMcpBridge());
  });

  afterEach(() => {
    __resetMcpConfirmStoreForTesting();
  });

  const offered = (overrides: Partial<DispatchPayload> = {}) =>
    dispatchHandler?.({
      requestId: "req",
      actionId: MOVE,
      args: ARGS,
      confirmed: false,
      sessionOrigin: "help",
      confirmationCondition: "next-own-fallback",
      ...overrides,
    });

  it("lets the pane's own run take the move, with nobody asked, and says it ran unasked", async () => {
    const result = { ok: true, result: { terminalId: "t-1", agentPresetId: "work" } };
    mocks.dispatch.mockResolvedValue(result);

    await offered();

    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    const [, , options] = mocks.dispatch.mock.calls[0]!;
    expect(options).toMatchObject({ source: "agent", ownFallbackStep: true });
    expect(options.confirmed).toBeUndefined();
    expect(useMcpConfirmStore.getState().current).toBeNull();
    expect(sendDispatchActionResponse).toHaveBeenCalledWith({
      requestId: "req",
      result,
      authorization: "skip-preference",
    });
  });

  it("asks as for any other move when the run finds it isn't the next step", async () => {
    mocks.dispatch
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "CONFIRMATION_REQUIRED", message: "wasn't the next step" },
      })
      .mockResolvedValueOnce({ ok: true, result: { terminalId: "t-1" } });

    const dispatched = offered({ args: { terminalId: "t-1", presetId: "other" } });
    await vi.waitFor(() => {
      expect(useMcpConfirmStore.getState().current?.previewPending).toBe(false);
    });
    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;

    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    const [, , approved] = mocks.dispatch.mock.calls[1]!;
    expect(approved).toMatchObject({ source: "agent", confirmed: true });
    expect(approved.ownFallbackStep).toBeUndefined();
    const response = sendDispatchActionResponse.mock.calls.at(-1)![0];
    expect(response).toMatchObject({ requestId: "req", confirmationDecision: "approved" });
    expect(response.authorization).toBeUndefined();
  });

  it("answers with a hop that failed once admitted, never asking or trying again", async () => {
    const failed = { ok: false, error: { code: "EXECUTION_ERROR", message: "spawn failed" } };
    mocks.dispatch.mockResolvedValue(failed);

    await offered();

    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(useMcpConfirmStore.getState().current).toBeNull();
    expect(sendDispatchActionResponse).toHaveBeenCalledWith({ requestId: "req", result: failed });
  });

  it.each([
    ["another action", { actionId: "terminal.restartOnAccount" }],
    ["no offer", { confirmationCondition: undefined }],
    ["an approval-only ask", { approvalOnly: true }],
  ])("asks without trying the move for %s", async (_label, overrides) => {
    const dispatched = offered(overrides);
    await vi.waitFor(() => {
      expect(useMcpConfirmStore.getState().current?.previewPending).toBe(false);
    });

    expect(mocks.dispatch).not.toHaveBeenCalled();
    useMcpConfirmStore.getState().resolveCurrent("rejected");
    await dispatched;
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
