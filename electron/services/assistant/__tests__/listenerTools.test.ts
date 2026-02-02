import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createListenerTools, type ListenerToolContext } from "../listenerTools.js";

// Mock the listenerManager module
vi.mock("../ListenerManager.js", async () => {
  const { ListenerManager } =
    await vi.importActual<typeof import("../ListenerManager.js")>("../ListenerManager.js");
  const instance = new ListenerManager();
  return {
    ListenerManager,
    listenerManager: instance,
  };
});

// Import mocked instance after mock setup
import { listenerManager } from "../ListenerManager.js";
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
      expect(schema.properties.eventType.enum).toEqual(["terminal:state-changed"]);
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
});
