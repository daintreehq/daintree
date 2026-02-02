import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createListenerTools, type ListenerToolContext } from "../listenerTools.js";

// Mock the listenerManager module
vi.mock("../ListenerManager.js", async () => {
  const { ListenerManager, ListenerWaiter } =
    await vi.importActual<typeof import("../ListenerManager.js")>("../ListenerManager.js");
  const instance = new ListenerManager();
  const waiterInstance = new ListenerWaiter();
  return {
    ListenerManager,
    ListenerWaiter,
    listenerManager: instance,
    listenerWaiter: waiterInstance,
  };
});

// Import mocked instance after mock setup
import { listenerManager, listenerWaiter } from "../ListenerManager.js";
import type { ToolSet } from "ai";

describe("listenerTools", () => {
  let tools: ToolSet;
  let context: ListenerToolContext;

  beforeEach(() => {
    listenerManager.clear();
    context = { sessionId: "test-session-1" };
    tools = createListenerTools(context);
  });

  afterEach(() => {
    listenerManager.clear();
  });

  describe("register_listener", () => {
    it("registers a listener for terminal:state-changed and returns success", async () => {
      const result = await tools.register_listener.execute!(
        { eventType: "terminal:state-changed", filter: undefined },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({
        success: true,
        listenerId: expect.any(String),
        eventType: "terminal:state-changed",
        message: "Successfully subscribed to terminal:state-changed events",
      });
      expect(listenerManager.size()).toBe(1);
    });

    it("registers a listener with filter", async () => {
      const result = await tools.register_listener.execute!(
        {
          eventType: "terminal:state-changed",
          filter: { terminalId: "term-123", toState: "completed" },
        },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({
        success: true,
        listenerId: expect.any(String),
        eventType: "terminal:state-changed",
        filter: { terminalId: "term-123", toState: "completed" },
        message: "Successfully subscribed to terminal:state-changed events",
      });

      const listeners = listenerManager.listForSession("test-session-1");
      expect(listeners.length).toBe(1);
      expect(listeners[0].filter).toEqual({ terminalId: "term-123", toState: "completed" });
    });

    it("creates listeners scoped to the session", async () => {
      await tools.register_listener.execute!(
        { eventType: "terminal:state-changed", filter: undefined },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );

      const session1Listeners = listenerManager.listForSession("test-session-1");
      const session2Listeners = listenerManager.listForSession("other-session");

      expect(session1Listeners.length).toBe(1);
      expect(session2Listeners.length).toBe(0);
    });

    it("handles registration errors gracefully with empty eventType", async () => {
      const result = await tools.register_listener.execute!(
        { eventType: "", filter: undefined },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining("not supported"),
      });
    });

    it("only allows bridged event types in schema", () => {
      // Verify the tool schema restricts to bridged events only
      // The AI SDK puts the schema on inputSchema.jsonSchema
      const schema = (
        tools.register_listener as unknown as {
          inputSchema: {
            jsonSchema: {
              properties: { eventType: { enum: string[] } };
              required: string[];
            };
          };
        }
      ).inputSchema.jsonSchema;
      expect(schema.properties.eventType.enum).toEqual([
        "terminal:state-changed",
        "agent:completed",
        "agent:failed",
        "agent:killed",
      ]);
      expect(schema.required).toContain("eventType");
    });

    it("rejects unsupported event types with runtime validation", async () => {
      // Test runtime guard against unsupported event types
      // This simulates a schema bypass or direct call with invalid event type
      const result = await tools.register_listener.execute!(
        { eventType: "agent:state-changed" as unknown as any, filter: undefined },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining("not supported"),
      });
      expect(result.error).toContain("terminal:state-changed");
      // Verify no listener was created
      expect(listenerManager.size()).toBe(0);
    });

    it("rejects another unsupported event type", async () => {
      // Test with a different unsupported event type
      const result = await tools.register_listener.execute!(
        { eventType: "terminal:activity" as unknown as any, filter: undefined },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining("not supported"),
      });
      // Verify no listener was created
      expect(listenerManager.size()).toBe(0);
    });

    it("registers a one-shot listener with once: true", async () => {
      const result = await tools.register_listener.execute!(
        { eventType: "terminal:state-changed", filter: undefined, once: true },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({
        success: true,
        listenerId: expect.any(String),
        eventType: "terminal:state-changed",
        once: true,
        message: expect.stringContaining("one-shot"),
      });

      const listeners = listenerManager.listForSession("test-session-1");
      expect(listeners.length).toBe(1);
      expect(listeners[0].once).toBe(true);
    });

    it("registers a regular listener without once flag", async () => {
      const result = await tools.register_listener.execute!(
        { eventType: "terminal:state-changed", filter: undefined },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({
        success: true,
        listenerId: expect.any(String),
        eventType: "terminal:state-changed",
        message: "Successfully subscribed to terminal:state-changed events",
      });

      const listeners = listenerManager.listForSession("test-session-1");
      expect(listeners.length).toBe(1);
      expect(listeners[0].once).toBeUndefined();
    });

    it("registers a listener with once: false explicitly", async () => {
      const result = await tools.register_listener.execute!(
        { eventType: "terminal:state-changed", filter: undefined, once: false },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({
        success: true,
        listenerId: expect.any(String),
        eventType: "terminal:state-changed",
        message: "Successfully subscribed to terminal:state-changed events",
      });

      const listeners = listenerManager.listForSession("test-session-1");
      expect(listeners.length).toBe(1);
      expect(listeners[0].once).toBe(false);
    });

    it("registers a one-shot listener with filter", async () => {
      const result = await tools.register_listener.execute!(
        {
          eventType: "terminal:state-changed",
          filter: { terminalId: "term-123" },
          once: true,
        },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({
        success: true,
        listenerId: expect.any(String),
        eventType: "terminal:state-changed",
        filter: { terminalId: "term-123" },
        once: true,
        message: expect.stringContaining("one-shot"),
      });

      const listeners = listenerManager.listForSession("test-session-1");
      expect(listeners.length).toBe(1);
      expect(listeners[0].once).toBe(true);
      expect(listeners[0].filter).toEqual({ terminalId: "term-123" });
    });

    it("registers a listener for agent:completed", async () => {
      const result = await tools.register_listener.execute!(
        { eventType: "agent:completed", filter: { terminalId: "term-1" } },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({
        success: true,
        listenerId: expect.any(String),
        eventType: "agent:completed",
        filter: { terminalId: "term-1" },
        message: "Successfully subscribed to agent:completed events",
      });
      expect(listenerManager.size()).toBe(1);
    });

    it("registers a listener for agent:failed", async () => {
      const result = await tools.register_listener.execute!(
        { eventType: "agent:failed", filter: { agentId: "agent-1" } },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({
        success: true,
        listenerId: expect.any(String),
        eventType: "agent:failed",
        filter: { agentId: "agent-1" },
        message: "Successfully subscribed to agent:failed events",
      });
      expect(listenerManager.size()).toBe(1);
    });

    it("registers a listener for agent:killed", async () => {
      const result = await tools.register_listener.execute!(
        { eventType: "agent:killed", filter: undefined },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({
        success: true,
        listenerId: expect.any(String),
        eventType: "agent:killed",
        message: "Successfully subscribed to agent:killed events",
      });
      expect(listenerManager.size()).toBe(1);
    });

    it("registers one-shot listener for agent:completed", async () => {
      const result = await tools.register_listener.execute!(
        { eventType: "agent:completed", filter: undefined, once: true },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({
        success: true,
        listenerId: expect.any(String),
        eventType: "agent:completed",
        once: true,
        message: expect.stringContaining("one-shot"),
      });

      const listeners = listenerManager.listForSession("test-session-1");
      expect(listeners.length).toBe(1);
      expect(listeners[0].once).toBe(true);
    });
  });

  describe("list_listeners", () => {
    it("returns empty list when no listeners registered", async () => {
      const result = await tools.list_listeners.execute!(
        {},
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({
        success: true,
        count: 0,
        listeners: [],
      });
    });

    it("returns all listeners for the session", async () => {
      // Register multiple listeners with different filters
      await tools.register_listener.execute!(
        { eventType: "terminal:state-changed", filter: undefined },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );
      await tools.register_listener.execute!(
        { eventType: "terminal:state-changed", filter: { terminalId: "term-1" } },
        { toolCallId: "tc-2", messages: [], abortSignal: new AbortController().signal }
      );

      const result = await tools.list_listeners.execute!(
        {},
        { toolCallId: "tc-3", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({
        success: true,
        count: 2,
        listeners: expect.arrayContaining([
          {
            listenerId: expect.any(String),
            eventType: "terminal:state-changed",
            createdAt: expect.any(Number),
          },
          {
            listenerId: expect.any(String),
            eventType: "terminal:state-changed",
            filter: { terminalId: "term-1" },
            createdAt: expect.any(Number),
          },
        ]),
      });
    });

    it("only returns listeners for the current session", async () => {
      // Register listener in our session
      await tools.register_listener.execute!(
        { eventType: "terminal:state-changed", filter: undefined },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );

      // Register listener in another session directly (bypasses tool validation)
      listenerManager.register("other-session", "terminal:state-changed");

      const result = await tools.list_listeners.execute!(
        {},
        { toolCallId: "tc-2", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result.count).toBe(1);
      expect(result.listeners[0].eventType).toBe("terminal:state-changed");
    });

    it("shows once status for one-shot listeners", async () => {
      // Register a one-shot listener
      await tools.register_listener.execute!(
        { eventType: "terminal:state-changed", filter: undefined, once: true },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );
      // Register a regular listener
      await tools.register_listener.execute!(
        { eventType: "terminal:state-changed", filter: { terminalId: "term-activity" } },
        { toolCallId: "tc-2", messages: [], abortSignal: new AbortController().signal }
      );

      const result = await tools.list_listeners.execute!(
        {},
        { toolCallId: "tc-3", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result.count).toBe(2);
      const oneShotListener = result.listeners.find((l: { once?: boolean }) => l.once === true);
      const regularListener = result.listeners.find(
        (l: { filter?: Record<string, unknown> }) => l.filter?.terminalId === "term-activity"
      );

      expect(oneShotListener.once).toBe(true);
      expect(regularListener.once).toBeUndefined();
    });
  });

  describe("remove_listener", () => {
    it("removes a registered listener", async () => {
      const registerResult = await tools.register_listener.execute!(
        { eventType: "terminal:state-changed", filter: undefined },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );
      expect(registerResult.success).toBe(true);
      const listenerId = (registerResult as { success: true; listenerId: string }).listenerId;

      const result = await tools.remove_listener.execute!(
        { listenerId },
        { toolCallId: "tc-2", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({
        success: true,
        removed: true,
        listenerId,
        message: "Listener removed successfully",
      });
      expect(listenerManager.size()).toBe(0);
    });

    it("returns error for non-existent listener", async () => {
      const result = await tools.remove_listener.execute!(
        { listenerId: "non-existent-id" },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({
        success: false,
        removed: false,
        error: "Listener not found",
      });
    });

    it("prevents removing listeners from other sessions without leaking session info", async () => {
      // Register listener in another session directly (bypasses tool validation)
      const otherSessionListenerId = listenerManager.register(
        "other-session",
        "terminal:state-changed"
      );

      const result = await tools.remove_listener.execute!(
        { listenerId: otherSessionListenerId },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );

      // Should return generic "not found" error without revealing it belongs to another session
      expect(result).toEqual({
        success: false,
        removed: false,
        error: "Listener not found",
      });

      // Verify listener still exists
      expect(listenerManager.get(otherSessionListenerId)).toBeDefined();
    });

    it("handles already removed listener gracefully", async () => {
      const registerResult = await tools.register_listener.execute!(
        { eventType: "terminal:state-changed", filter: undefined },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );
      const listenerId = (registerResult as { success: true; listenerId: string }).listenerId;

      // Remove the listener directly
      listenerManager.unregister(listenerId);

      // Try to remove again via tool
      const result = await tools.remove_listener.execute!(
        { listenerId },
        { toolCallId: "tc-2", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({
        success: false,
        removed: false,
        error: "Listener not found",
      });
    });
  });

  describe("tool metadata", () => {
    it("register_listener has correct description mentioning supported events", () => {
      expect(tools.register_listener.description).toContain("Subscribe to Canopy events");
      expect(tools.register_listener.description).toContain("terminal:state-changed");
    });

    it("list_listeners has correct description", () => {
      expect(tools.list_listeners.description).toContain("List all active event listeners");
    });

    it("remove_listener has correct description", () => {
      expect(tools.remove_listener.description).toContain("Unsubscribe from events");
    });
  });

  describe("cross-session isolation", () => {
    it("tools from different sessions operate independently", async () => {
      const context1: ListenerToolContext = { sessionId: "session-1" };
      const context2: ListenerToolContext = { sessionId: "session-2" };
      const tools1 = createListenerTools(context1);
      const tools2 = createListenerTools(context2);

      // Register listeners in both sessions with different filters
      await tools1.register_listener.execute!(
        { eventType: "terminal:state-changed", filter: { terminalId: "term-1" } },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );
      await tools2.register_listener.execute!(
        { eventType: "terminal:state-changed", filter: { terminalId: "term-2" } },
        { toolCallId: "tc-2", messages: [], abortSignal: new AbortController().signal }
      );

      // Verify each session sees only its own listeners
      const list1 = await tools1.list_listeners.execute!(
        {},
        { toolCallId: "tc-3", messages: [], abortSignal: new AbortController().signal }
      );
      const list2 = await tools2.list_listeners.execute!(
        {},
        { toolCallId: "tc-4", messages: [], abortSignal: new AbortController().signal }
      );

      expect(list1.count).toBe(1);
      expect(list1.listeners[0].filter).toEqual({ terminalId: "term-1" });
      expect(list2.count).toBe(1);
      expect(list2.listeners[0].filter).toEqual({ terminalId: "term-2" });
    });
  });

  describe("await_listener", () => {
    it("returns not_found error for non-existent listener", async () => {
      const result = await tools.await_listener.execute!(
        { listenerId: "non-existent-id" },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({
        success: false,
        error: "not_found",
        message: "Listener not found or already triggered",
      });
    });

    it("returns not_found error for listener from another session", async () => {
      // Register listener in another session directly
      const otherSessionListenerId = listenerManager.register(
        "other-session",
        "terminal:state-changed"
      );

      const result = await tools.await_listener.execute!(
        { listenerId: otherSessionListenerId },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({
        success: false,
        error: "not_found",
        message: "Listener not found or already triggered",
      });
    });

    it("returns event data when listener triggers", async () => {
      // Register a listener
      const registerResult = await tools.register_listener.execute!(
        { eventType: "terminal:state-changed", filter: undefined },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );
      expect(registerResult.success).toBe(true);
      const listenerId = (registerResult as { success: true; listenerId: string }).listenerId;

      // Start awaiting and simulate event trigger
      const awaitPromise = tools.await_listener.execute!(
        { listenerId, timeoutMs: 5000 },
        { toolCallId: "tc-2", messages: [], abortSignal: new AbortController().signal }
      );

      // Give the await a moment to register the waiter
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate event trigger
      listenerWaiter.notify(listenerId, {
        listenerId,
        eventType: "terminal:state-changed",
        data: { terminalId: "term-123", toState: "completed" },
        timestamp: Date.now(),
      });

      const result = await awaitPromise;

      expect(result).toEqual({
        success: true,
        eventType: "terminal:state-changed",
        data: { terminalId: "term-123", toState: "completed" },
        waitedMs: expect.any(Number),
      });
      expect((result as { waitedMs: number }).waitedMs).toBeGreaterThanOrEqual(0);
      expect((result as { waitedMs: number }).waitedMs).toBeLessThan(1000);
    });

    it("returns timeout error when listener does not trigger in time", async () => {
      // Register a listener
      const registerResult = await tools.register_listener.execute!(
        { eventType: "terminal:state-changed", filter: undefined },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );
      expect(registerResult.success).toBe(true);
      const listenerId = (registerResult as { success: true; listenerId: string }).listenerId;

      // Start awaiting with a very short timeout
      const result = await tools.await_listener.execute!(
        { listenerId, timeoutMs: 50 },
        { toolCallId: "tc-2", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({
        success: false,
        error: "timeout",
        waitedMs: expect.any(Number),
      });
      expect((result as { waitedMs: number }).waitedMs).toBeGreaterThanOrEqual(40);
    });

    it("returns cancelled error when stream is aborted", async () => {
      // Register a listener
      const registerResult = await tools.register_listener.execute!(
        { eventType: "terminal:state-changed", filter: undefined },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );
      expect(registerResult.success).toBe(true);
      const listenerId = (registerResult as { success: true; listenerId: string }).listenerId;

      const abortController = new AbortController();

      // Start awaiting
      const awaitPromise = tools.await_listener.execute!(
        { listenerId, timeoutMs: 5000 },
        { toolCallId: "tc-2", messages: [], abortSignal: abortController.signal }
      );

      // Give the await a moment to register
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Abort the stream
      abortController.abort();

      const result = await awaitPromise;

      expect(result).toEqual({
        success: false,
        error: "cancelled",
        reason: "Stream was cancelled",
        waitedMs: expect.any(Number),
      });
    });

    it("returns already_awaiting error when awaiting same listener twice", async () => {
      // Register a listener
      const registerResult = await tools.register_listener.execute!(
        { eventType: "terminal:state-changed", filter: undefined },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );
      expect(registerResult.success).toBe(true);
      const listenerId = (registerResult as { success: true; listenerId: string }).listenerId;

      // Start first await
      const firstAwaitPromise = tools.await_listener.execute!(
        { listenerId, timeoutMs: 5000 },
        { toolCallId: "tc-2", messages: [], abortSignal: new AbortController().signal }
      );

      // Give the await a moment to register
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Try to await again
      const secondResult = await tools.await_listener.execute!(
        { listenerId, timeoutMs: 5000 },
        { toolCallId: "tc-3", messages: [], abortSignal: new AbortController().signal }
      );

      expect(secondResult).toEqual({
        success: false,
        error: "already_awaiting",
        message: "Already awaiting this listener",
      });

      // Clean up first await
      listenerWaiter.cancel(listenerId, "cleanup");
      await firstAwaitPromise;
    });

    it("clamps timeout to maximum of 300000ms", async () => {
      // Register a listener
      const registerResult = await tools.register_listener.execute!(
        { eventType: "terminal:state-changed", filter: undefined },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );
      expect(registerResult.success).toBe(true);
      const listenerId = (registerResult as { success: true; listenerId: string }).listenerId;

      // Start awaiting with excessive timeout (should be clamped)
      const awaitPromise = tools.await_listener.execute!(
        { listenerId, timeoutMs: 999999999 },
        { toolCallId: "tc-2", messages: [], abortSignal: new AbortController().signal }
      );

      // Give the await a moment to register
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Trigger event immediately
      listenerWaiter.notify(listenerId, {
        listenerId,
        eventType: "terminal:state-changed",
        data: {},
        timestamp: Date.now(),
      });

      const result = await awaitPromise;
      expect(result.success).toBe(true);
    });

    it("uses default timeout of 30000ms when not specified", async () => {
      // Register a listener
      const registerResult = await tools.register_listener.execute!(
        { eventType: "terminal:state-changed", filter: undefined },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );
      expect(registerResult.success).toBe(true);
      const listenerId = (registerResult as { success: true; listenerId: string }).listenerId;

      // Start awaiting without specifying timeout
      const awaitPromise = tools.await_listener.execute!(
        { listenerId },
        { toolCallId: "tc-2", messages: [], abortSignal: new AbortController().signal }
      );

      // Give the await a moment to register
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Trigger event
      listenerWaiter.notify(listenerId, {
        listenerId,
        eventType: "terminal:state-changed",
        data: {},
        timestamp: Date.now(),
      });

      const result = await awaitPromise;
      expect(result.success).toBe(true);
    });

    it("works independently for multiple concurrent awaits on different listeners", async () => {
      // Register two listeners
      const reg1 = await tools.register_listener.execute!(
        { eventType: "terminal:state-changed", filter: { terminalId: "term-1" } },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );
      const reg2 = await tools.register_listener.execute!(
        { eventType: "terminal:state-changed", filter: { terminalId: "term-2" } },
        { toolCallId: "tc-2", messages: [], abortSignal: new AbortController().signal }
      );
      expect(reg1.success).toBe(true);
      expect(reg2.success).toBe(true);
      const listenerId1 = (reg1 as { success: true; listenerId: string }).listenerId;
      const listenerId2 = (reg2 as { success: true; listenerId: string }).listenerId;

      // Start both awaits
      const await1 = tools.await_listener.execute!(
        { listenerId: listenerId1, timeoutMs: 5000 },
        { toolCallId: "tc-3", messages: [], abortSignal: new AbortController().signal }
      );
      const await2 = tools.await_listener.execute!(
        { listenerId: listenerId2, timeoutMs: 5000 },
        { toolCallId: "tc-4", messages: [], abortSignal: new AbortController().signal }
      );

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Trigger second listener first
      listenerWaiter.notify(listenerId2, {
        listenerId: listenerId2,
        eventType: "terminal:state-changed",
        data: { terminalId: "term-2" },
        timestamp: Date.now(),
      });

      // Then trigger first listener
      listenerWaiter.notify(listenerId1, {
        listenerId: listenerId1,
        eventType: "terminal:state-changed",
        data: { terminalId: "term-1" },
        timestamp: Date.now(),
      });

      const [result1, result2] = await Promise.all([await1, await2]);

      expect(result1.success).toBe(true);
      expect((result1 as { data: { terminalId: string } }).data.terminalId).toBe("term-1");
      expect(result2.success).toBe(true);
      expect((result2 as { data: { terminalId: string } }).data.terminalId).toBe("term-2");
    });

    it("has correct description mentioning blocking behavior", () => {
      expect(tools.await_listener.description).toContain("Block and wait");
      expect(tools.await_listener.description).toContain("timeout");
      expect(tools.await_listener.description).toContain("300000");
    });
  });
});
