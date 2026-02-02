import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  initTerminalStateListenerBridge,
  destroyTerminalStateListenerBridge,
  type ChunkEmitter,
} from "../TerminalStateListenerBridge.js";
import { events } from "../../events.js";

vi.mock("../ListenerManager.js", async () => {
  const { ListenerManager } =
    await vi.importActual<typeof import("../ListenerManager.js")>("../ListenerManager.js");
  const instance = new ListenerManager();
  return {
    ListenerManager,
    listenerManager: instance,
  };
});

import { listenerManager } from "../ListenerManager.js";

describe("TerminalStateListenerBridge", () => {
  let emittedChunks: Array<{
    sessionId: string;
    chunk: {
      type: "listener_triggered";
      listenerData: {
        listenerId: string;
        eventType: string;
        data: Record<string, unknown>;
      };
    };
  }>;
  let mockEmitter: ChunkEmitter;

  beforeEach(() => {
    listenerManager.clear();
    emittedChunks = [];
    mockEmitter = (sessionId, chunk) => {
      emittedChunks.push({ sessionId, chunk });
    };
  });

  afterEach(() => {
    destroyTerminalStateListenerBridge();
    listenerManager.clear();
  });

  const createAgentStateChangedPayload = () => ({
    terminalId: "term-1",
    agentId: "agent-1",
    previousState: "idle" as const,
    state: "working" as const,
    trigger: "output" as const,
    confidence: 1,
    worktreeId: "wt-1",
    timestamp: Date.now(),
  });

  describe("one-shot listener auto-removal", () => {
    it("removes one-shot listener after first event", () => {
      initTerminalStateListenerBridge(mockEmitter);

      const listenerId = listenerManager.register(
        "session-1",
        "terminal:state-changed",
        undefined,
        true
      );

      expect(listenerManager.get(listenerId)).toBeDefined();

      events.emit("agent:state-changed", createAgentStateChangedPayload());

      expect(emittedChunks.length).toBe(1);
      expect(emittedChunks[0].sessionId).toBe("session-1");
      expect(listenerManager.get(listenerId)).toBeUndefined();
    });

    it("keeps regular listener after event", () => {
      initTerminalStateListenerBridge(mockEmitter);

      const listenerId = listenerManager.register("session-1", "terminal:state-changed");

      events.emit("agent:state-changed", createAgentStateChangedPayload());

      expect(emittedChunks.length).toBe(1);
      expect(listenerManager.get(listenerId)).toBeDefined();
    });

    it("removes multiple one-shot listeners after same event", () => {
      initTerminalStateListenerBridge(mockEmitter);

      const listenerId1 = listenerManager.register(
        "session-1",
        "terminal:state-changed",
        undefined,
        true
      );
      const listenerId2 = listenerManager.register(
        "session-2",
        "terminal:state-changed",
        undefined,
        true
      );

      events.emit("agent:state-changed", createAgentStateChangedPayload());

      expect(emittedChunks.length).toBe(2);
      expect(listenerManager.get(listenerId1)).toBeUndefined();
      expect(listenerManager.get(listenerId2)).toBeUndefined();
    });

    it("one-shot listener with filter is removed after matching event", () => {
      initTerminalStateListenerBridge(mockEmitter);

      const listenerId = listenerManager.register(
        "session-1",
        "terminal:state-changed",
        { terminalId: "term-1" },
        true
      );

      events.emit("agent:state-changed", createAgentStateChangedPayload());

      expect(emittedChunks.length).toBe(1);
      expect(listenerManager.get(listenerId)).toBeUndefined();
    });

    it("one-shot listener with filter is not removed after non-matching event", () => {
      initTerminalStateListenerBridge(mockEmitter);

      const listenerId = listenerManager.register(
        "session-1",
        "terminal:state-changed",
        { terminalId: "term-99" },
        true
      );

      events.emit("agent:state-changed", createAgentStateChangedPayload());

      expect(emittedChunks.length).toBe(0);
      expect(listenerManager.get(listenerId)).toBeDefined();
    });

    it("mixed one-shot and regular listeners work correctly", () => {
      initTerminalStateListenerBridge(mockEmitter);

      const oneShotId = listenerManager.register(
        "session-1",
        "terminal:state-changed",
        undefined,
        true
      );
      const regularId = listenerManager.register("session-2", "terminal:state-changed");

      events.emit("agent:state-changed", createAgentStateChangedPayload());

      expect(emittedChunks.length).toBe(2);
      expect(listenerManager.get(oneShotId)).toBeUndefined();
      expect(listenerManager.get(regularId)).toBeDefined();
    });

    it("one-shot listener does not fire on second event", () => {
      initTerminalStateListenerBridge(mockEmitter);

      const oneShotId = listenerManager.register(
        "session-1",
        "terminal:state-changed",
        undefined,
        true
      );
      const regularId = listenerManager.register("session-2", "terminal:state-changed");

      events.emit("agent:state-changed", createAgentStateChangedPayload());
      expect(emittedChunks.length).toBe(2);

      emittedChunks = [];

      events.emit("agent:state-changed", createAgentStateChangedPayload());
      expect(emittedChunks.length).toBe(1);
      expect(emittedChunks[0].sessionId).toBe("session-2");
      expect(listenerManager.get(oneShotId)).toBeUndefined();
      expect(listenerManager.get(regularId)).toBeDefined();
    });

    it("validates payload mapping with toState field", () => {
      initTerminalStateListenerBridge(mockEmitter);

      const listenerId = listenerManager.register("session-1", "terminal:state-changed");
      const payload = createAgentStateChangedPayload();

      events.emit("agent:state-changed", payload);

      expect(emittedChunks[0].chunk.listenerData).toEqual({
        listenerId,
        eventType: "terminal:state-changed",
        data: expect.objectContaining({
          terminalId: payload.terminalId,
          oldState: payload.previousState,
          newState: payload.state,
          toState: payload.state,
          worktreeId: payload.worktreeId,
        }),
      });
    });

    it("only removes matching one-shot listeners when multiple filters exist", () => {
      initTerminalStateListenerBridge(mockEmitter);

      const matchId = listenerManager.register(
        "session-1",
        "terminal:state-changed",
        { terminalId: "term-1" },
        true
      );
      const nonMatchId = listenerManager.register(
        "session-1",
        "terminal:state-changed",
        { terminalId: "term-99" },
        true
      );

      events.emit("agent:state-changed", createAgentStateChangedPayload());

      expect(listenerManager.get(matchId)).toBeUndefined();
      expect(listenerManager.get(nonMatchId)).toBeDefined();
    });

    it("removes one-shot listener even if chunkEmitter throws", () => {
      const throwingEmitter: ChunkEmitter = () => {
        throw new Error("IPC error");
      };
      initTerminalStateListenerBridge(throwingEmitter);

      const listenerId = listenerManager.register(
        "session-1",
        "terminal:state-changed",
        undefined,
        true
      );

      expect(listenerManager.get(listenerId)).toBeDefined();

      events.emit("agent:state-changed", createAgentStateChangedPayload());

      expect(listenerManager.get(listenerId)).toBeUndefined();
    });
  });
});
