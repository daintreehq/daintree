import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => {
  const registered = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      registered.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      registered.delete(channel);
    }),
    _invoke: (channel: string, ...args: unknown[]) => {
      const handler = registered.get(channel);
      if (!handler) throw new Error(`No handler for ${channel}`);
      return handler({} as unknown, ...args);
    },
  };
});

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

vi.mock("../../utils.js", () => ({
  typedHandle: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
}));

import { registerEventsHandlers } from "../events.js";

function setup() {
  const emit = vi.fn();
  const on = vi.fn(() => () => {});
  const events = { emit, on } as unknown as Parameters<typeof registerEventsHandlers>[0]["events"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cleanup = registerEventsHandlers({ events } as any);
  return { emit, on, cleanup };
}

const base = {
  actionId: "foo.bar",
  source: "user" as const,
  context: {},
  timestamp: 1_700_000_000_000,
  category: "test",
  durationMs: 5,
};

describe("events IPC handler — action:dispatched", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("strips reserved keys like __proto__ from safeArgs", () => {
    const { emit, cleanup } = setup();
    const polluted = JSON.parse('{"show":true,"__proto__":{"polluted":"yes"}}');
    ipcMainMock._invoke("events:emit", "action:dispatched", {
      ...base,
      safeArgs: polluted,
    });

    expect(emit).toHaveBeenCalledTimes(1);
    const normalized = emit.mock.calls[0]![1] as { safeArgs?: Record<string, unknown> };
    expect(normalized.safeArgs).toEqual({ show: true });
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
    cleanup();
  });

  it("drops non-primitive values in safeArgs (objects, arrays, functions)", () => {
    const { emit, cleanup } = setup();
    ipcMainMock._invoke("events:emit", "action:dispatched", {
      ...base,
      safeArgs: {
        show: true,
        nested: { evil: "payload" },
        list: [1, 2, 3],
        fn: () => "nope",
      },
    });

    const normalized = emit.mock.calls[0]![1] as { safeArgs?: Record<string, unknown> };
    expect(normalized.safeArgs).toEqual({ show: true });
    cleanup();
  });

  it("keeps primitive falsy values (null, false, 0, empty string)", () => {
    const { emit, cleanup } = setup();
    ipcMainMock._invoke("events:emit", "action:dispatched", {
      ...base,
      safeArgs: { a: null, b: false, c: 0, d: "" },
    });

    const normalized = emit.mock.calls[0]![1] as { safeArgs?: Record<string, unknown> };
    expect(normalized.safeArgs).toEqual({ a: null, b: false, c: 0, d: "" });
    cleanup();
  });

  it("drops safeArgs entirely when it exceeds 1024 bytes", () => {
    const { emit, cleanup } = setup();
    const huge = "x".repeat(1100);
    ipcMainMock._invoke("events:emit", "action:dispatched", {
      ...base,
      safeArgs: { payload: huge },
    });

    const normalized = emit.mock.calls[0]![1] as { safeArgs?: Record<string, unknown> };
    expect(normalized.safeArgs).toBeUndefined();
    cleanup();
  });

  it("omits safeArgs when the value is not a plain object", () => {
    const { emit, cleanup } = setup();
    ipcMainMock._invoke("events:emit", "action:dispatched", {
      ...base,
      safeArgs: "not-an-object",
    });

    const normalized = emit.mock.calls[0]![1] as Record<string, unknown>;
    expect(normalized.safeArgs).toBeUndefined();
    cleanup();
  });

  it("normalizes missing category and durationMs to safe defaults", () => {
    const { emit, cleanup } = setup();
    ipcMainMock._invoke("events:emit", "action:dispatched", {
      actionId: "foo.bar",
      source: "user",
      context: {},
      timestamp: 1_700_000_000_000,
    });

    const normalized = emit.mock.calls[0]![1] as Record<string, unknown>;
    expect(normalized.category).toBe("");
    expect(normalized.durationMs).toBe(0);
    cleanup();
  });

  it("rejects invalid action payloads (non-string actionId)", () => {
    const { emit, cleanup } = setup();
    ipcMainMock._invoke("events:emit", "action:dispatched", { ...base, actionId: 123 });
    expect(emit).not.toHaveBeenCalled();
    cleanup();
  });

  it("rejects disallowed event types", () => {
    const { emit, cleanup } = setup();
    ipcMainMock._invoke("events:emit", "agent:killed", { id: "x" });
    expect(emit).not.toHaveBeenCalled();
    cleanup();
  });
});
