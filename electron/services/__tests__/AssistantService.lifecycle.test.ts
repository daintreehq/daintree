import { describe, it, expect, beforeEach, vi, beforeAll } from "vitest";
import { listenerManager } from "../assistant/ListenerManager.js";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => "/tmp"),
  },
}));

let AssistantService: typeof import("../AssistantService.js").AssistantService;

beforeAll(async () => {
  const module = await import("../AssistantService.js");
  AssistantService = module.AssistantService;
});

describe("AssistantService lifecycle management", () => {
  let service: InstanceType<typeof AssistantService>;

  beforeEach(() => {
    service = new AssistantService();
    listenerManager.clear();
  });

  describe("clearAllSessions", () => {
    it("clears all active streams and listeners", () => {
      listenerManager.register("session-1", "terminal:state-changed");
      listenerManager.register("session-2", "agent:spawned");
      listenerManager.register("session-3", "terminal:state-changed");

      expect(listenerManager.size()).toBe(3);

      service.clearAllSessions();

      expect(listenerManager.size()).toBe(0);
    });

    it("aborts all active streams", () => {
      const mockAbort = vi.fn();
      const mockController = {
        abort: mockAbort,
      } as unknown as AbortController;

      service["activeStreams"].set("session-1", mockController);
      service["activeStreams"].set("session-2", mockController);

      service.clearAllSessions();

      expect(mockAbort).toHaveBeenCalledTimes(2);
      expect(service["activeStreams"].size).toBe(0);
    });

    it("clears chunk callbacks", () => {
      service["chunkCallbacks"].set("session-1", vi.fn());
      service["chunkCallbacks"].set("session-2", vi.fn());

      expect(service["chunkCallbacks"].size).toBe(2);

      service.clearAllSessions();

      expect(service["chunkCallbacks"].size).toBe(0);
    });

    it("handles empty state gracefully", () => {
      expect(() => service.clearAllSessions()).not.toThrow();
      expect(listenerManager.size()).toBe(0);
    });

    it("can be called multiple times safely", () => {
      listenerManager.register("session-1", "terminal:state-changed");

      service.clearAllSessions();
      service.clearAllSessions();

      expect(listenerManager.size()).toBe(0);
    });
  });

  describe("cancel vs clearSession vs clearAllSessions", () => {
    it("cancel aborts stream and clears chunk callback", () => {
      listenerManager.register("session-1", "terminal:state-changed");

      const mockAbort = vi.fn();
      const mockController = {
        abort: mockAbort,
      } as unknown as AbortController;
      const mockCallback = vi.fn();

      service["activeStreams"].set("session-1", mockController);
      service["chunkCallbacks"].set("session-1", mockCallback);

      service.cancel("session-1");

      expect(mockAbort).toHaveBeenCalled();
      expect(service["activeStreams"].has("session-1")).toBe(false);
      expect(service["chunkCallbacks"].has("session-1")).toBe(false);
      expect(listenerManager.size()).toBe(1);
    });

    it("clearSession aborts stream and clears session listeners and callback", () => {
      listenerManager.register("session-1", "terminal:state-changed");
      listenerManager.register("session-2", "agent:spawned");

      const mockAbort = vi.fn();
      const mockController = {
        abort: mockAbort,
      } as unknown as AbortController;
      const mockCallback = vi.fn();

      service["activeStreams"].set("session-1", mockController);
      service["chunkCallbacks"].set("session-1", mockCallback);

      service.clearSession("session-1");

      expect(mockAbort).toHaveBeenCalled();
      expect(service["activeStreams"].has("session-1")).toBe(false);
      expect(service["chunkCallbacks"].has("session-1")).toBe(false);
      expect(listenerManager.listForSession("session-1").length).toBe(0);
      expect(listenerManager.size()).toBe(1);
    });

    it("clearAllSessions clears all sessions and listeners", () => {
      listenerManager.register("session-1", "terminal:state-changed");
      listenerManager.register("session-2", "agent:spawned");

      const mockAbort = vi.fn();
      const mockController = {
        abort: mockAbort,
      } as unknown as AbortController;

      service["activeStreams"].set("session-1", mockController);
      service["activeStreams"].set("session-2", mockController);

      service.clearAllSessions();

      expect(mockAbort).toHaveBeenCalledTimes(2);
      expect(service["activeStreams"].size).toBe(0);
      expect(listenerManager.size()).toBe(0);
    });

    it("cancelAll clears callbacks for all active sessions", () => {
      listenerManager.register("session-1", "terminal:state-changed");
      listenerManager.register("session-2", "agent:spawned");

      const mockAbort = vi.fn();
      const mockController = {
        abort: mockAbort,
      } as unknown as AbortController;

      service["activeStreams"].set("session-1", mockController);
      service["activeStreams"].set("session-2", mockController);
      service["chunkCallbacks"].set("session-1", vi.fn());
      service["chunkCallbacks"].set("session-2", vi.fn());

      service.cancelAll();

      expect(mockAbort).toHaveBeenCalledTimes(2);
      expect(service["activeStreams"].size).toBe(0);
      expect(service["chunkCallbacks"].size).toBe(0);
      expect(listenerManager.size()).toBe(0);
    });
  });

  describe("navigation cleanup scenario", () => {
    it("clears all listeners when user navigates to different project", () => {
      listenerManager.register("session-1", "terminal:state-changed", {
        terminalId: "term-1",
      });
      listenerManager.register("session-2", "terminal:state-changed", {
        terminalId: "term-2",
      });

      service.clearAllSessions();

      expect(listenerManager.size()).toBe(0);
    });

    it("clears listeners even for idle sessions without active streams", () => {
      listenerManager.register("idle-session-1", "terminal:state-changed");
      listenerManager.register("idle-session-2", "agent:spawned");

      service.clearAllSessions();

      expect(listenerManager.size()).toBe(0);
    });
  });
});
