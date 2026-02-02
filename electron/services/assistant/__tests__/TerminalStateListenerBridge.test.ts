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
          timestamp: payload.timestamp,
          trigger: payload.trigger,
          confidence: payload.confidence,
        }),
      });
    });

    it("preserves traceId in terminal:state-changed payload", () => {
      initTerminalStateListenerBridge(mockEmitter);

      listenerManager.register("session-1", "terminal:state-changed");
      const payload = {
        ...createAgentStateChangedPayload(),
        traceId: "trace-123",
      };

      events.emit("agent:state-changed", payload);

      expect(emittedChunks[0].chunk.listenerData.data).toEqual(
        expect.objectContaining({
          traceId: "trace-123",
        })
      );
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

    it("retains one-shot listener if chunkEmitter throws", () => {
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

      expect(listenerManager.get(listenerId)).toBeDefined();
    });
  });

  describe("agent:completed bridging", () => {
    const createAgentCompletedPayload = () => ({
      agentId: "agent-1",
      terminalId: "term-1",
      worktreeId: "wt-1",
      exitCode: 0,
      duration: 5000,
      timestamp: Date.now(),
      traceId: "trace-1",
    });

    it("delivers agent:completed events to matching listeners", () => {
      initTerminalStateListenerBridge(mockEmitter);

      const listenerId = listenerManager.register("session-1", "agent:completed");
      const payload = createAgentCompletedPayload();

      events.emit("agent:completed", payload);

      expect(emittedChunks.length).toBe(1);
      expect(emittedChunks[0].chunk.listenerData).toEqual({
        listenerId,
        eventType: "agent:completed",
        data: expect.objectContaining({
          agentId: payload.agentId,
          terminalId: payload.terminalId,
          worktreeId: payload.worktreeId,
          exitCode: payload.exitCode,
          duration: payload.duration,
          timestamp: payload.timestamp,
          traceId: payload.traceId,
        }),
      });
    });

    it("filters agent:completed by terminalId", () => {
      initTerminalStateListenerBridge(mockEmitter);

      listenerManager.register("session-1", "agent:completed", { terminalId: "term-1" });
      listenerManager.register("session-2", "agent:completed", { terminalId: "term-99" });

      events.emit("agent:completed", createAgentCompletedPayload());

      expect(emittedChunks.length).toBe(1);
      expect(emittedChunks[0].sessionId).toBe("session-1");
    });

    it("filters agent:completed by agentId", () => {
      initTerminalStateListenerBridge(mockEmitter);

      listenerManager.register("session-1", "agent:completed", { agentId: "agent-1" });
      listenerManager.register("session-2", "agent:completed", { agentId: "agent-99" });

      events.emit("agent:completed", createAgentCompletedPayload());

      expect(emittedChunks.length).toBe(1);
      expect(emittedChunks[0].sessionId).toBe("session-1");
    });

    it("removes one-shot agent:completed listener after first event", () => {
      initTerminalStateListenerBridge(mockEmitter);

      const listenerId = listenerManager.register("session-1", "agent:completed", undefined, true);

      expect(listenerManager.get(listenerId)).toBeDefined();
      events.emit("agent:completed", createAgentCompletedPayload());

      expect(emittedChunks.length).toBe(1);
      expect(listenerManager.get(listenerId)).toBeUndefined();
    });
  });

  describe("agent:failed bridging", () => {
    const createAgentFailedPayload = () => ({
      agentId: "agent-1",
      terminalId: "term-1",
      worktreeId: "wt-1",
      error: "Something went wrong",
      timestamp: Date.now(),
      traceId: "trace-1",
    });

    it("delivers agent:failed events to matching listeners", () => {
      initTerminalStateListenerBridge(mockEmitter);

      const listenerId = listenerManager.register("session-1", "agent:failed");
      const payload = createAgentFailedPayload();

      events.emit("agent:failed", payload);

      expect(emittedChunks.length).toBe(1);
      expect(emittedChunks[0].chunk.listenerData).toEqual({
        listenerId,
        eventType: "agent:failed",
        data: expect.objectContaining({
          agentId: payload.agentId,
          terminalId: payload.terminalId,
          worktreeId: payload.worktreeId,
          error: payload.error,
          timestamp: payload.timestamp,
          traceId: payload.traceId,
        }),
      });
    });

    it("filters agent:failed by terminalId", () => {
      initTerminalStateListenerBridge(mockEmitter);

      listenerManager.register("session-1", "agent:failed", { terminalId: "term-1" });
      listenerManager.register("session-2", "agent:failed", { terminalId: "term-99" });

      events.emit("agent:failed", createAgentFailedPayload());

      expect(emittedChunks.length).toBe(1);
      expect(emittedChunks[0].sessionId).toBe("session-1");
    });

    it("includes error message in payload", () => {
      initTerminalStateListenerBridge(mockEmitter);

      listenerManager.register("session-1", "agent:failed");
      const payload = createAgentFailedPayload();

      events.emit("agent:failed", payload);

      expect(emittedChunks[0].chunk.listenerData.data.error).toBe("Something went wrong");
    });

    it("removes one-shot agent:failed listener after first event", () => {
      initTerminalStateListenerBridge(mockEmitter);

      const listenerId = listenerManager.register("session-1", "agent:failed", undefined, true);

      expect(listenerManager.get(listenerId)).toBeDefined();
      events.emit("agent:failed", createAgentFailedPayload());

      expect(emittedChunks.length).toBe(1);
      expect(listenerManager.get(listenerId)).toBeUndefined();
    });
  });

  describe("agent:killed bridging", () => {
    const createAgentKilledPayload = () => ({
      agentId: "agent-1",
      terminalId: "term-1",
      worktreeId: "wt-1",
      reason: "User requested termination",
      timestamp: Date.now(),
      traceId: "trace-1",
    });

    it("delivers agent:killed events to matching listeners", () => {
      initTerminalStateListenerBridge(mockEmitter);

      const listenerId = listenerManager.register("session-1", "agent:killed");
      const payload = createAgentKilledPayload();

      events.emit("agent:killed", payload);

      expect(emittedChunks.length).toBe(1);
      expect(emittedChunks[0].chunk.listenerData).toEqual({
        listenerId,
        eventType: "agent:killed",
        data: expect.objectContaining({
          agentId: payload.agentId,
          terminalId: payload.terminalId,
          worktreeId: payload.worktreeId,
          reason: payload.reason,
          timestamp: payload.timestamp,
          traceId: payload.traceId,
        }),
      });
    });

    it("filters agent:killed by terminalId", () => {
      initTerminalStateListenerBridge(mockEmitter);

      listenerManager.register("session-1", "agent:killed", { terminalId: "term-1" });
      listenerManager.register("session-2", "agent:killed", { terminalId: "term-99" });

      events.emit("agent:killed", createAgentKilledPayload());

      expect(emittedChunks.length).toBe(1);
      expect(emittedChunks[0].sessionId).toBe("session-1");
    });

    it("handles agent:killed without reason", () => {
      initTerminalStateListenerBridge(mockEmitter);

      listenerManager.register("session-1", "agent:killed");

      events.emit("agent:killed", {
        agentId: "agent-1",
        terminalId: "term-1",
        worktreeId: "wt-1",
        timestamp: Date.now(),
        traceId: "trace-1",
      });

      expect(emittedChunks.length).toBe(1);
      expect(emittedChunks[0].chunk.listenerData.data.reason).toBeUndefined();
    });

    it("removes one-shot agent:killed listener after first event", () => {
      initTerminalStateListenerBridge(mockEmitter);

      const listenerId = listenerManager.register("session-1", "agent:killed", undefined, true);

      expect(listenerManager.get(listenerId)).toBeDefined();
      events.emit("agent:killed", createAgentKilledPayload());

      expect(emittedChunks.length).toBe(1);
      expect(listenerManager.get(listenerId)).toBeUndefined();
    });
  });

  describe("multiple event types", () => {
    it("listeners only receive events they subscribed to", () => {
      initTerminalStateListenerBridge(mockEmitter);

      listenerManager.register("session-1", "terminal:state-changed");
      listenerManager.register("session-2", "agent:completed");
      listenerManager.register("session-3", "agent:failed");
      listenerManager.register("session-4", "agent:killed");

      events.emit("agent:state-changed", createAgentStateChangedPayload());

      expect(emittedChunks.length).toBe(1);
      expect(emittedChunks[0].sessionId).toBe("session-1");
      expect(emittedChunks[0].chunk.listenerData.eventType).toBe("terminal:state-changed");
    });

    it("session can listen to multiple event types", () => {
      initTerminalStateListenerBridge(mockEmitter);

      listenerManager.register("session-1", "terminal:state-changed");
      listenerManager.register("session-1", "agent:completed");
      listenerManager.register("session-1", "agent:failed");

      events.emit("agent:state-changed", createAgentStateChangedPayload());
      events.emit("agent:completed", {
        agentId: "agent-1",
        terminalId: "term-1",
        worktreeId: "wt-1",
        exitCode: 0,
        duration: 5000,
        timestamp: Date.now(),
        traceId: "trace-1",
      });

      expect(emittedChunks.length).toBe(2);
      expect(emittedChunks[0].chunk.listenerData.eventType).toBe("terminal:state-changed");
      expect(emittedChunks[1].chunk.listenerData.eventType).toBe("agent:completed");
    });
  });
});
