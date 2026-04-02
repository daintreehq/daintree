import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTerminalCommandQueueSlice,
  type TerminalCommandQueueSlice,
} from "../terminalCommandQueueSlice";
import { terminalClient } from "@/clients";
import type { TerminalInstance } from "../terminalRegistrySlice";

vi.mock("@/clients", () => ({
  terminalClient: {
    write: vi.fn(),
  },
}));

describe("TerminalCommandQueueSlice", () => {
  const mockTerminal = {
    id: "test-terminal",
    title: "Test Terminal",
    type: "claude",
    cwd: "/test",
    location: "grid",
    agentState: "working",
    isVisible: true,
    cols: 80,
    rows: 24,
  } as TerminalInstance;

  const getTerminal = vi.fn((id: string) => {
    if (id === "test-terminal" || id === "terminal-b") {
      return { ...mockTerminal, id };
    }
    return undefined;
  });

  let state: TerminalCommandQueueSlice;

  function createSlice() {
    const set = vi.fn((updater: unknown) => {
      if (typeof updater === "function") {
        const partial = updater(state);
        if (partial !== state) {
          Object.assign(state, partial);
        }
      } else {
        Object.assign(state, updater);
      }
    });
    const get = vi.fn(() => state);
    const slice = createTerminalCommandQueueSlice(getTerminal)(set, get, {} as never);
    Object.assign(state, slice);
    return slice;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockTerminal.agentState = "working";
    state = {
      commandQueue: [],
      commandQueueCountById: {},
      queueCommand: vi.fn(),
      processQueue: vi.fn(),
      clearQueue: vi.fn(),
      getQueueCount: vi.fn(),
    };
    createSlice();
  });

  describe("User input invariant", () => {
    it("should write user input immediately when agent is working", () => {
      mockTerminal.agentState = "working";
      state.queueCommand("test-terminal", "test data", "test description", "user");
      expect(terminalClient.write).toHaveBeenCalledWith("test-terminal", "test data");
    });

    it("should write user input immediately when agent is running", () => {
      mockTerminal.agentState = "running";
      state.queueCommand("test-terminal", "test data", "test description", "user");
      expect(terminalClient.write).toHaveBeenCalledWith("test-terminal", "test data");
    });

    it("should write user input immediately when agent is waiting", () => {
      mockTerminal.agentState = "waiting";
      state.queueCommand("test-terminal", "test data", "test description", "user");
      expect(terminalClient.write).toHaveBeenCalledWith("test-terminal", "test data");
    });

    it("should write user input immediately when agent is idle", () => {
      mockTerminal.agentState = "idle";
      state.queueCommand("test-terminal", "test data", "test description", "user");
      expect(terminalClient.write).toHaveBeenCalledWith("test-terminal", "test data");
    });

    it("should write user input immediately when agent is completed", () => {
      mockTerminal.agentState = "completed";
      state.queueCommand("test-terminal", "test data", "test description", "user");
      expect(terminalClient.write).toHaveBeenCalledWith("test-terminal", "test data");
    });

    it("should write user input immediately when agent is directing", () => {
      mockTerminal.agentState = "directing";
      state.queueCommand("test-terminal", "test data", "test description", "user");
      expect(terminalClient.write).toHaveBeenCalledWith("test-terminal", "test data");
    });
  });

  describe("Automation input queueing", () => {
    it("should write automation input immediately when agent is idle", () => {
      mockTerminal.agentState = "idle";
      state.queueCommand("test-terminal", "test data", "test description", "automation");
      expect(terminalClient.write).toHaveBeenCalledWith("test-terminal", "test data");
    });

    it("should write automation input immediately when agent is waiting", () => {
      mockTerminal.agentState = "waiting";
      state.queueCommand("test-terminal", "test data", "test description", "automation");
      expect(terminalClient.write).toHaveBeenCalledWith("test-terminal", "test data");
    });

    it("should queue automation input when agent is working", () => {
      mockTerminal.agentState = "working";
      state.queueCommand("test-terminal", "test data", "test description", "automation");
      expect(terminalClient.write).not.toHaveBeenCalled();
    });

    it("should queue automation input when agent is running", () => {
      mockTerminal.agentState = "running";
      state.queueCommand("test-terminal", "test data", "test description", "automation");
      expect(terminalClient.write).not.toHaveBeenCalled();
    });

    it("should default to automation when origin is not specified", () => {
      mockTerminal.agentState = "working";
      state.queueCommand("test-terminal", "test data", "test description");
      expect(terminalClient.write).not.toHaveBeenCalled();
    });
  });

  describe("Error handling", () => {
    it("should warn and not write when terminal does not exist", () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      state.queueCommand("nonexistent-terminal", "test data", "test description", "user");
      expect(terminalClient.write).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        "Cannot queue command: terminal nonexistent-terminal not found"
      );
      consoleSpy.mockRestore();
    });
  });

  describe("commandQueueCountById", () => {
    it("should increment count when a command is queued", () => {
      state.queueCommand("test-terminal", "cmd1", "desc1");
      expect(state.commandQueueCountById["test-terminal"]).toBe(1);
      expect(state.commandQueue).toHaveLength(1);

      state.queueCommand("test-terminal", "cmd2", "desc2");
      expect(state.commandQueueCountById["test-terminal"]).toBe(2);
      expect(state.commandQueue).toHaveLength(2);
    });

    it("should not increment count when command is written immediately", () => {
      mockTerminal.agentState = "idle";
      state.queueCommand("test-terminal", "cmd1", "desc1");
      expect(state.commandQueueCountById["test-terminal"]).toBeUndefined();
      expect(state.commandQueue).toHaveLength(0);
    });

    it("should decrement count when a command is processed", () => {
      state.queueCommand("test-terminal", "cmd1", "desc1");
      state.queueCommand("test-terminal", "cmd2", "desc2");
      expect(state.commandQueueCountById["test-terminal"]).toBe(2);

      mockTerminal.agentState = "idle";
      state.processQueue("test-terminal");
      expect(state.commandQueueCountById["test-terminal"]).toBe(1);
      expect(state.commandQueue).toHaveLength(1);
    });

    it("should not go below 0 on processQueue", () => {
      mockTerminal.agentState = "idle";
      state.processQueue("test-terminal");
      expect(state.commandQueueCountById["test-terminal"]).toBeUndefined();
    });

    it("should reset count on clearQueue", () => {
      state.queueCommand("test-terminal", "cmd1", "desc1");
      state.queueCommand("test-terminal", "cmd2", "desc2");
      expect(state.commandQueueCountById["test-terminal"]).toBe(2);

      state.clearQueue("test-terminal");
      expect(state.commandQueueCountById["test-terminal"]).toBe(0);
      expect(state.commandQueue).toHaveLength(0);
    });

    it("should track counts independently per terminal", () => {
      state.queueCommand("test-terminal", "cmd1", "desc1");
      state.queueCommand("test-terminal", "cmd2", "desc2");
      state.queueCommand("terminal-b", "cmd3", "desc3");

      expect(state.commandQueueCountById["test-terminal"]).toBe(2);
      expect(state.commandQueueCountById["terminal-b"]).toBe(1);

      state.clearQueue("test-terminal");
      expect(state.commandQueueCountById["test-terminal"]).toBe(0);
      expect(state.commandQueueCountById["terminal-b"]).toBe(1);
    });

    it("should return correct count from getQueueCount", () => {
      state.queueCommand("test-terminal", "cmd1", "desc1");
      state.queueCommand("test-terminal", "cmd2", "desc2");
      expect(state.getQueueCount("test-terminal")).toBe(2);
      expect(state.getQueueCount("nonexistent")).toBe(0);
    });
  });
});
