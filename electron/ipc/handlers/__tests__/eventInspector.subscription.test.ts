import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import { registerEventInspectorHandlers } from "../eventInspector.js";
import type { HandlerDependencies } from "../../types.js";
import type { EventRecord } from "../../../../shared/types/index.js";

describe("event inspector subscription", () => {
  let mockEventBuffer: {
    getAll: Mock;
    getFiltered: Mock;
    clear: Mock;
    onRecord: Mock;
  };
  let onRecordCallback: ((record: EventRecord) => void) | null = null;
  let onRecordUnsubscribe: Mock;
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    onRecordUnsubscribe = vi.fn();
    onRecordCallback = null;

    mockEventBuffer = {
      getAll: vi.fn(() => []),
      getFiltered: vi.fn(() => []),
      clear: vi.fn(),
      onRecord: vi.fn((callback: (record: EventRecord) => void) => {
        onRecordCallback = callback;
        return onRecordUnsubscribe;
      }),
    };

    const deps = {
      eventBuffer: mockEventBuffer as unknown as HandlerDependencies["eventBuffer"],
      mainWindow: {
        webContents: {
          isDestroyed: () => false,
          send: vi.fn(),
        },
        isDestroyed: () => false,
      },
    } as unknown as HandlerDependencies;

    cleanup = registerEventInspectorHandlers(deps);
  });

  afterEach(() => {
    cleanup();
  });

  function getRegisteredHandler(channel: string): ((...args: unknown[]) => void) | undefined {
    const calls = (ipcMain.on as Mock).mock.calls;
    const call = calls.find(([ch]) => ch === channel);
    return call?.[1] as ((...args: unknown[]) => void) | undefined;
  }

  function createMockSender(isDestroyed = false) {
    const destroyedListeners: (() => void)[] = [];
    return {
      isDestroyed: vi.fn(() => isDestroyed),
      send: vi.fn(),
      once: vi.fn((event: string, cb: () => void) => {
        if (event === "destroyed") {
          destroyedListeners.push(cb);
        }
      }),
      removeListener: vi.fn(),
      triggerDestroy: () => {
        destroyedListeners.forEach((cb) => cb());
      },
    };
  }

  it("registers subscribe and unsubscribe handlers", () => {
    const onCalls = (ipcMain.on as Mock).mock.calls.map(([ch]) => ch);
    expect(onCalls).toContain(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE);
    expect(onCalls).toContain(CHANNELS.EVENT_INSPECTOR_UNSUBSCRIBE);
  });

  it("subscribes webcontents to event stream", () => {
    const subscribeHandler = getRegisteredHandler(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE);
    expect(subscribeHandler).toBeDefined();

    const sender = createMockSender();
    const event = { sender };

    subscribeHandler!(event);

    expect(mockEventBuffer.onRecord).toHaveBeenCalled();
  });

  it("broadcasts events to subscribed webcontents", () => {
    const subscribeHandler = getRegisteredHandler(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE);
    const sender = createMockSender();
    const event = { sender };

    subscribeHandler!(event);

    const testRecord: EventRecord = {
      id: "test-1",
      timestamp: Date.now(),
      type: "agent:spawned",
      category: "agent",
      payload: { agentId: "a1" },
      source: "main",
    };

    expect(onRecordCallback).not.toBeNull();
    onRecordCallback!(testRecord);

    expect(sender.send).toHaveBeenCalledWith(CHANNELS.EVENT_INSPECTOR_EVENT, testRecord);
  });

  it("unsubscribes webcontents from event stream", () => {
    const subscribeHandler = getRegisteredHandler(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE);
    const unsubscribeHandler = getRegisteredHandler(CHANNELS.EVENT_INSPECTOR_UNSUBSCRIBE);
    const sender = createMockSender();
    const event = { sender };

    subscribeHandler!(event);
    unsubscribeHandler!(event);

    expect(onRecordUnsubscribe).toHaveBeenCalled();
  });

  it("handles multiple subscribers", () => {
    const subscribeHandler = getRegisteredHandler(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE);
    const sender1 = createMockSender();
    const sender2 = createMockSender();

    subscribeHandler!({ sender: sender1 });
    subscribeHandler!({ sender: sender2 });

    const testRecord: EventRecord = {
      id: "test-2",
      timestamp: Date.now(),
      type: "agent:state-changed",
      category: "agent",
      payload: { agentId: "a1", state: "working" },
      source: "main",
    };

    onRecordCallback!(testRecord);

    expect(sender1.send).toHaveBeenCalledWith(CHANNELS.EVENT_INSPECTOR_EVENT, testRecord);
    expect(sender2.send).toHaveBeenCalledWith(CHANNELS.EVENT_INSPECTOR_EVENT, testRecord);
  });

  it("cleans up destroyed webcontents during broadcast", () => {
    const subscribeHandler = getRegisteredHandler(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE);
    const sender1 = createMockSender(false);
    const sender2 = createMockSender(false);

    subscribeHandler!({ sender: sender1 });
    subscribeHandler!({ sender: sender2 });

    sender1.isDestroyed.mockReturnValue(true);

    const testRecord: EventRecord = {
      id: "test-3",
      timestamp: Date.now(),
      type: "task:created",
      category: "task",
      payload: { taskId: "t1" },
      source: "main",
    };

    onRecordCallback!(testRecord);

    expect(sender1.send).not.toHaveBeenCalled();
    expect(sender2.send).toHaveBeenCalledWith(CHANNELS.EVENT_INSPECTOR_EVENT, testRecord);
  });

  it("cleans up when webcontents is destroyed via event", () => {
    const subscribeHandler = getRegisteredHandler(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE);
    const sender = createMockSender(false);

    subscribeHandler!({ sender });

    expect(sender.once).toHaveBeenCalledWith("destroyed", expect.any(Function));

    sender.triggerDestroy();

    expect(onRecordUnsubscribe).toHaveBeenCalled();
  });

  it("only subscribes to eventBuffer once regardless of subscriber count", () => {
    const subscribeHandler = getRegisteredHandler(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE);

    subscribeHandler!({ sender: createMockSender() });
    subscribeHandler!({ sender: createMockSender() });
    subscribeHandler!({ sender: createMockSender() });

    expect(mockEventBuffer.onRecord).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes from eventBuffer when all subscribers are gone", () => {
    const subscribeHandler = getRegisteredHandler(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE);
    const unsubscribeHandler = getRegisteredHandler(CHANNELS.EVENT_INSPECTOR_UNSUBSCRIBE);

    const sender1 = createMockSender();
    const sender2 = createMockSender();

    subscribeHandler!({ sender: sender1 });
    subscribeHandler!({ sender: sender2 });

    unsubscribeHandler!({ sender: sender1 });
    expect(onRecordUnsubscribe).not.toHaveBeenCalled();

    unsubscribeHandler!({ sender: sender2 });
    expect(onRecordUnsubscribe).toHaveBeenCalled();
  });

  it("cleans up all subscriptions on handler cleanup", () => {
    const subscribeHandler = getRegisteredHandler(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE);

    subscribeHandler!({ sender: createMockSender() });
    subscribeHandler!({ sender: createMockSender() });

    cleanup();

    expect(onRecordUnsubscribe).toHaveBeenCalled();
  });

  it("ignores subscribe from already destroyed sender", () => {
    const subscribeHandler = getRegisteredHandler(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE);
    const sender = createMockSender(true);

    subscribeHandler!({ sender });

    expect(mockEventBuffer.onRecord).not.toHaveBeenCalled();
  });
});
