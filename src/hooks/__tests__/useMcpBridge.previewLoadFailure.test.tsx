// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionManifestEntry } from "@shared/types/actions";
import { __resetMcpConfirmStoreForTesting, useMcpConfirmStore } from "@/store/mcpConfirmStore";
import { hasCautionLine } from "@/lib/mcpPreviewLines";

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

// The preview modules load on demand, so a failed load is a path of its own.
vi.mock("@/lib/mcpTerminalLaunchPreview", () => {
  throw new Error("chunk failed to load");
});

import { useMcpBridge } from "../useMcpBridge";

type DispatchPayload = { requestId: string; actionId: string; args?: unknown };

describe("a confirmation whose preview module fails to load", () => {
  let dispatchHandler: ((payload: DispatchPayload) => void | Promise<void>) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetMcpConfirmStoreForTesting();
    dispatchHandler = undefined;
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
          sendDispatchActionResponse: vi.fn(),
        },
        mcpServer: { holdDispatch: vi.fn(async () => ({ held: true, remainingMs: 30_000 })) },
      },
    });
  });

  afterEach(() => {
    __resetMcpConfirmStoreForTesting();
  });

  it("says the change could not be verified instead of showing an empty preview", async () => {
    mocks.get.mockReturnValue({
      id: "terminal.new",
      name: "terminal.new",
      title: "New terminal",
      description: "Open a terminal.",
      category: "terminal",
      kind: "command",
      danger: "confirm",
      enabled: true,
      requiresArgs: false,
    });
    renderHook(() => useMcpBridge());

    void dispatchHandler?.({
      requestId: "req-load-failure",
      actionId: "terminal.new",
      args: { command: "npm run deploy" },
    });

    await vi.waitFor(() => {
      expect(useMcpConfirmStore.getState().current?.previewPending).toBe(false);
    });
    const preview = useMcpConfirmStore.getState().current?.preview ?? [];
    expect(preview).toHaveLength(1);
    expect(hasCautionLine(preview)).toBe(true);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
