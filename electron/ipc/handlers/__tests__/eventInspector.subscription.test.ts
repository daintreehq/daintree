import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { wrapSuccess } from "../../../../shared/utils/ipcErrorSerialization.js";

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
import { getIpcDispatcher } from "../../dispatcher.js";
import type { ClientEndpoint, ClientRef, HostFrame } from "../../endpoint.js";

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
    vi.useFakeTimers();
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
    vi.useRealTimers();
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

  function createTestRecord(id: string): EventRecord {
    return {
      id,
      timestamp: Date.now(),
      type: "agent:spawned",
      category: "agent",
      payload: { agentId: "a1" },
      source: "main",
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

  it("broadcasts batched events to subscribed webcontents after flush", () => {
    const subscribeHandler = getRegisteredHandler(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE);
    const sender = createMockSender();

    subscribeHandler!({ sender });

    const testRecord = createTestRecord("test-1");
    expect(onRecordCallback).not.toBeNull();
    onRecordCallback!(testRecord);

    expect(sender.send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);

    expect(sender.send).toHaveBeenCalledWith(CHANNELS.EVENT_INSPECTOR_EVENT_BATCH, [testRecord]);
  });

  it("batches multiple events within the batch window into one send", () => {
    const subscribeHandler = getRegisteredHandler(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE);
    const sender = createMockSender();

    subscribeHandler!({ sender });

    const record1 = createTestRecord("batch-1");
    const record2 = createTestRecord("batch-2");
    const record3 = createTestRecord("batch-3");

    onRecordCallback!(record1);
    onRecordCallback!(record2);
    onRecordCallback!(record3);

    expect(sender.send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);

    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledWith(CHANNELS.EVENT_INSPECTOR_EVENT_BATCH, [
      record1,
      record2,
      record3,
    ]);
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

    const testRecord = createTestRecord("test-2");
    onRecordCallback!(testRecord);

    vi.advanceTimersByTime(50);

    expect(sender1.send).toHaveBeenCalledWith(CHANNELS.EVENT_INSPECTOR_EVENT_BATCH, [testRecord]);
    expect(sender2.send).toHaveBeenCalledWith(CHANNELS.EVENT_INSPECTOR_EVENT_BATCH, [testRecord]);
  });

  it("cleans up destroyed webcontents during broadcast", () => {
    const subscribeHandler = getRegisteredHandler(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE);
    const sender1 = createMockSender(false);
    const sender2 = createMockSender(false);

    subscribeHandler!({ sender: sender1 });
    subscribeHandler!({ sender: sender2 });

    sender1.isDestroyed.mockReturnValue(true);

    const testRecord = createTestRecord("test-3");
    onRecordCallback!(testRecord);

    vi.advanceTimersByTime(50);

    expect(sender1.send).not.toHaveBeenCalled();
    expect(sender2.send).toHaveBeenCalledWith(CHANNELS.EVENT_INSPECTOR_EVENT_BATCH, [testRecord]);
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

  it("flushes pending events immediately on cleanup without waiting for timer", () => {
    const subscribeHandler = getRegisteredHandler(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE);
    const sender = createMockSender();

    subscribeHandler!({ sender });

    const record1 = createTestRecord("flush-1");
    const record2 = createTestRecord("flush-2");
    onRecordCallback!(record1);
    onRecordCallback!(record2);

    expect(sender.send).not.toHaveBeenCalled();

    cleanup();

    expect(sender.send).toHaveBeenCalledWith(CHANNELS.EVENT_INSPECTOR_EVENT_BATCH, [
      record1,
      record2,
    ]);
  });
  describe("views attached over a link", () => {
    const REMOTE_CLIENT: ClientRef = {
      clientId: "client-b",
      clientName: "greg-mbp",
      platform: "darwin",
      kind: "remote",
    };

    function createRemoteEndpoint() {
      const closeListeners = new Set<() => void>();
      let closed = false;
      const endpoint: ClientEndpoint & { send: Mock<(frame: HostFrame) => void> } = {
        endpointId: "remote:-3",
        clientId: "client-b",
        projectId: "proj-1",
        kind: "remote-view",
        handle: -3,
        send: vi.fn<(frame: HostFrame) => void>(),
        request: vi.fn(),
        onClose: (cb) => {
          closeListeners.add(cb);
          return { dispose: () => closeListeners.delete(cb) };
        },
        isClosed: () => closed,
      };
      const close = () => {
        closed = true;
        for (const cb of [...closeListeners]) cb();
      };
      return { endpoint, close, closeListeners };
    }

    function linkSend(endpoint: ClientEndpoint, channel: string): Promise<void> {
      getIpcDispatcher().sendForEndpoint({ endpoint, client: REMOTE_CLIENT }, channel, []);
      // The dispatcher runs listeners inside the (async) envelope.
      return Promise.resolve().then(() => undefined);
    }

    beforeEach(() => {
      getIpcDispatcher().setInvokeEnveloper(async (_channel, _args, call) => {
        await call();
        return wrapSuccess(undefined);
      });
    });

    afterEach(() => {
      getIpcDispatcher().setInvokeEnveloper(null);
    });

    it("delivers batches to a subscribed endpoint", async () => {
      const { endpoint } = createRemoteEndpoint();
      await linkSend(endpoint, CHANNELS.EVENT_INSPECTOR_SUBSCRIBE);

      const record = createTestRecord("remote-1");
      expect(onRecordCallback).not.toBeNull();
      onRecordCallback!(record);
      vi.advanceTimersByTime(50);

      expect(endpoint.send).toHaveBeenCalledWith({
        type: "event",
        channel: CHANNELS.EVENT_INSPECTOR_EVENT_BATCH,
        args: [[record]],
      });
    });

    it("releases the event buffer when the endpoint unsubscribes", async () => {
      const { endpoint, closeListeners } = createRemoteEndpoint();
      await linkSend(endpoint, CHANNELS.EVENT_INSPECTOR_SUBSCRIBE);
      await linkSend(endpoint, CHANNELS.EVENT_INSPECTOR_UNSUBSCRIBE);

      expect(onRecordUnsubscribe).toHaveBeenCalled();
      expect(closeListeners.size).toBe(0);
    });

    it("drops the subscription when the endpoint closes", async () => {
      const { endpoint, close } = createRemoteEndpoint();
      await linkSend(endpoint, CHANNELS.EVENT_INSPECTOR_SUBSCRIBE);

      close();

      expect(onRecordUnsubscribe).toHaveBeenCalled();
    });

    it("keeps local and remote subscribers apart", async () => {
      const { endpoint } = createRemoteEndpoint();
      const sender = createMockSender();
      getRegisteredHandler(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE)!({ sender });
      await linkSend(endpoint, CHANNELS.EVENT_INSPECTOR_SUBSCRIBE);

      await linkSend(endpoint, CHANNELS.EVENT_INSPECTOR_UNSUBSCRIBE);
      expect(onRecordUnsubscribe).not.toHaveBeenCalled();

      const record = createTestRecord("local-only");
      onRecordCallback!(record);
      vi.advanceTimersByTime(50);

      expect(sender.send).toHaveBeenCalledWith(CHANNELS.EVENT_INSPECTOR_EVENT_BATCH, [record]);
      expect(endpoint.send).not.toHaveBeenCalled();
    });
  });
});
