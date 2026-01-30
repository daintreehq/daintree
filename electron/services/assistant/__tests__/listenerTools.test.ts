import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createListenerTools, type ListenerToolContext } from "../listenerTools.js";

// Mock the listenerManager module
vi.mock("../ListenerManager.js", async () => {
  const { ListenerManager } = await vi.importActual<typeof import("../ListenerManager.js")>(
    "../ListenerManager.js"
  );
  const instance = new ListenerManager();
  return {
    ListenerManager,
    listenerManager: instance,
  };
});

// Import mocked instance after mock setup
import { listenerManager } from "../ListenerManager.js";

describe("listenerTools", () => {
  let tools: any; // Use any to bypass strict AI SDK Tool typing in tests
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
    it("registers a listener and returns success", async () => {
      const result = await tools.register_listener.execute!(
        { eventType: "agent:state-changed", filter: undefined },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({
        success: true,
        listenerId: expect.any(String),
        eventType: "agent:state-changed",
        message: "Successfully subscribed to agent:state-changed events",
      });
      expect(listenerManager.size()).toBe(1);
    });

    it("registers a listener with filter", async () => {
      const result = await tools.register_listener.execute!(
        {
          eventType: "terminal:activity",
          filter: { terminalId: "term-123" },
        },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result).toEqual({
        success: true,
        listenerId: expect.any(String),
        eventType: "terminal:activity",
        filter: { terminalId: "term-123" },
        message: "Successfully subscribed to terminal:activity events",
      });

      const listeners = listenerManager.listForSession("test-session-1");
      expect(listeners.length).toBe(1);
      expect(listeners[0].filter).toEqual({ terminalId: "term-123" });
    });

    it("creates listeners scoped to the session", async () => {
      await tools.register_listener.execute!(
        { eventType: "agent:spawned", filter: undefined },
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
        error: expect.stringContaining("Invalid listener registration"),
      });
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
      // Register multiple listeners
      await tools.register_listener.execute!(
        { eventType: "agent:state-changed", filter: undefined },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );
      await tools.register_listener.execute!(
        { eventType: "terminal:activity", filter: { terminalId: "term-1" } },
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
            eventType: "agent:state-changed",
            createdAt: expect.any(Number),
          },
          {
            listenerId: expect.any(String),
            eventType: "terminal:activity",
            filter: { terminalId: "term-1" },
            createdAt: expect.any(Number),
          },
        ]),
      });
    });

    it("only returns listeners for the current session", async () => {
      // Register listener in our session
      await tools.register_listener.execute!(
        { eventType: "agent:state-changed", filter: undefined },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );

      // Register listener in another session directly
      listenerManager.register("other-session", "terminal:activity");

      const result = await tools.list_listeners.execute!(
        {},
        { toolCallId: "tc-2", messages: [], abortSignal: new AbortController().signal }
      );

      expect(result.count).toBe(1);
      expect(result.listeners[0].eventType).toBe("agent:state-changed");
    });
  });

  describe("remove_listener", () => {
    it("removes a registered listener", async () => {
      const registerResult = await tools.register_listener.execute!(
        { eventType: "agent:state-changed", filter: undefined },
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
      // Register listener in another session directly
      const otherSessionListenerId = listenerManager.register("other-session", "terminal:activity");

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
        { eventType: "agent:state-changed", filter: undefined },
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
    it("register_listener has correct description", () => {
      expect(tools.register_listener.description).toContain("Subscribe to Canopy events");
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
      const tools1 = createListenerTools(context1) as any;
      const tools2 = createListenerTools(context2) as any;

      // Register listeners in both sessions
      await tools1.register_listener.execute(
        { eventType: "agent:state-changed", filter: undefined },
        { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal }
      );
      await tools2.register_listener.execute(
        { eventType: "terminal:activity", filter: undefined },
        { toolCallId: "tc-2", messages: [], abortSignal: new AbortController().signal }
      );

      // Verify each session sees only its own listeners
      const list1 = await tools1.list_listeners.execute(
        {},
        { toolCallId: "tc-3", messages: [], abortSignal: new AbortController().signal }
      );
      const list2 = await tools2.list_listeners.execute(
        {},
        { toolCallId: "tc-4", messages: [], abortSignal: new AbortController().signal }
      );

      expect(list1.count).toBe(1);
      expect(list1.listeners[0].eventType).toBe("agent:state-changed");
      expect(list2.count).toBe(1);
      expect(list2.listeners[0].eventType).toBe("terminal:activity");
    });
  });
});

