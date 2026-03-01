import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionManifestEntry } from "../../../../shared/types/actions.js";

const {
  sendMock,
  getAllWindowsMock,
  ipcMainMock,
  emitDispatchResponse,
  clearDispatchListeners,
  dispatchListenerCount,
} = vi.hoisted(() => {
  const listeners = new Set<(event: unknown, payload: unknown) => void>();
  const sendMock = vi.fn();
  const windowRef = {
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: sendMock,
    },
  };

  const ipcMainMock = {
    on: vi.fn((channel: string, handler: (event: unknown, payload: unknown) => void) => {
      if (channel === "app-agent:dispatch-action-response") {
        listeners.add(handler);
      }
      return ipcMainMock;
    }),
    removeListener: vi.fn(
      (channel: string, handler: (event: unknown, payload: unknown) => void) => {
        if (channel === "app-agent:dispatch-action-response") {
          listeners.delete(handler);
        }
        return ipcMainMock;
      }
    ),
  };

  return {
    sendMock,
    getAllWindowsMock: vi.fn(() => [windowRef]),
    ipcMainMock,
    emitDispatchResponse: (payload: unknown) => {
      for (const handler of [...listeners]) {
        handler({}, payload);
      }
    },
    clearDispatchListeners: () => listeners.clear(),
    dispatchListenerCount: () => listeners.size,
  };
});

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: getAllWindowsMock,
  },
  ipcMain: ipcMainMock,
}));

vi.mock("ai", () => ({
  tool: (definition: unknown) => definition,
  jsonSchema: (schema: unknown) => schema,
}));

import {
  createActionTools,
  sanitizeSchema,
  sanitizeToolName,
  unsanitizeToolName,
} from "../actionTools.js";

function createAction(overrides: Partial<ActionManifestEntry> = {}): ActionManifestEntry {
  return {
    id: "terminal.list",
    name: "terminal.list",
    title: "List terminals",
    description: "List all terminals",
    category: "terminal",
    kind: "query",
    danger: "safe",
    enabled: true,
    requiresArgs: false,
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

describe("actionTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDispatchListeners();
    getAllWindowsMock.mockReturnValue([
      {
        isDestroyed: vi.fn(() => false),
        webContents: { send: sendMock },
      },
    ]);
  });

  it("sanitizes and unsanitizes tool names", () => {
    expect(sanitizeToolName("terminal.list")).toBe("terminal_list");
    expect(unsanitizeToolName("terminal_list")).toBe("terminal.list");
  });

  it("sanitizes malformed nested property schemas", () => {
    const schema = sanitizeSchema({
      type: "object",
      properties: {
        anything: {},
        nested: {
          properties: {
            deep: {},
          },
        },
      },
    });

    expect(schema).toEqual({
      type: "object",
      properties: {
        anything: { type: "object", additionalProperties: true },
        nested: {
          type: "object",
          properties: {
            deep: { type: "object", additionalProperties: true },
          },
        },
      },
    });
  });

  it("ignores malformed IPC payloads and resolves on the first valid matching response", async () => {
    const tools = createActionTools([createAction()], {});
    const execute = (
      tools.terminal_list as unknown as {
        execute: (args: Record<string, unknown>, options: unknown) => Promise<unknown>;
      }
    ).execute;

    sendMock.mockImplementation((_channel: string, payload: { requestId: string }) => {
      emitDispatchResponse({ requestId: payload.requestId });
      emitDispatchResponse({
        requestId: payload.requestId,
        result: { ok: true, result: { count: 3 } },
      });
    });

    const result = (await execute({}, {})) as { success: boolean; result?: unknown };
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ count: 3 });
    expect(dispatchListenerCount()).toBe(0);
  });

  it("returns a structured error when dispatch send throws", async () => {
    const tools = createActionTools([createAction()], {});
    const execute = (
      tools.terminal_list as unknown as {
        execute: (args: Record<string, unknown>, options: unknown) => Promise<unknown>;
      }
    ).execute;

    sendMock.mockImplementation(() => {
      throw new Error("send failed");
    });

    const result = (await execute({}, {})) as { success: boolean; error?: string; code?: string };
    expect(result).toEqual({
      success: false,
      error: "Action dispatch failed",
      code: "DISPATCH_FAILED",
    });
    expect(dispatchListenerCount()).toBe(0);
  });
});
