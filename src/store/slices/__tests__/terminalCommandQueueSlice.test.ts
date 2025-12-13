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
    if (id === "test-terminal") {
      return mockTerminal;
    }
    return undefined;
  });

  let slice: TerminalCommandQueueSlice;

  beforeEach(() => {
    vi.clearAllMocks();
    const set = vi.fn();
    const get = vi.fn(
      () =>
        ({
          commandQueue: [],
          queueCommand: vi.fn(),
          processQueue: vi.fn(),
          clearQueue: vi.fn(),
          getQueueCount: vi.fn(),
        }) as TerminalCommandQueueSlice
    );
    slice = createTerminalCommandQueueSlice(getTerminal)(set, get, {} as never);
  });

  describe("User input invariant", () => {
    it("should write user input immediately when agent is working", () => {
      mockTerminal.agentState = "working";
      slice.queueCommand("test-terminal", "test data", "test description", "user");
      expect(terminalClient.write).toHaveBeenCalledWith("test-terminal", "test data");
    });

    it("should write user input immediately when agent is running", () => {
      mockTerminal.agentState = "running";
      slice.queueCommand("test-terminal", "test data", "test description", "user");
      expect(terminalClient.write).toHaveBeenCalledWith("test-terminal", "test data");
    });

    it("should write user input immediately when agent is waiting", () => {
      mockTerminal.agentState = "waiting";
      slice.queueCommand("test-terminal", "test data", "test description", "user");
      expect(terminalClient.write).toHaveBeenCalledWith("test-terminal", "test data");
    });

    it("should write user input immediately when agent is idle", () => {
      mockTerminal.agentState = "idle";
      slice.queueCommand("test-terminal", "test data", "test description", "user");
      expect(terminalClient.write).toHaveBeenCalledWith("test-terminal", "test data");
    });

    it("should write user input immediately when agent is completed", () => {
      mockTerminal.agentState = "completed";
      slice.queueCommand("test-terminal", "test data", "test description", "user");
      expect(terminalClient.write).toHaveBeenCalledWith("test-terminal", "test data");
    });

    it("should write user input immediately when agent is failed", () => {
      mockTerminal.agentState = "failed";
      slice.queueCommand("test-terminal", "test data", "test description", "user");
      expect(terminalClient.write).toHaveBeenCalledWith("test-terminal", "test data");
    });
  });

  describe("Automation input queueing", () => {
    it("should write automation input immediately when agent is idle", () => {
      mockTerminal.agentState = "idle";
      slice.queueCommand("test-terminal", "test data", "test description", "automation");
      expect(terminalClient.write).toHaveBeenCalledWith("test-terminal", "test data");
    });

    it("should write automation input immediately when agent is waiting", () => {
      mockTerminal.agentState = "waiting";
      slice.queueCommand("test-terminal", "test data", "test description", "automation");
      expect(terminalClient.write).toHaveBeenCalledWith("test-terminal", "test data");
    });

    it("should queue automation input when agent is working", () => {
      mockTerminal.agentState = "working";
      slice.queueCommand("test-terminal", "test data", "test description", "automation");
      expect(terminalClient.write).not.toHaveBeenCalled();
    });

    it("should queue automation input when agent is running", () => {
      mockTerminal.agentState = "running";
      slice.queueCommand("test-terminal", "test data", "test description", "automation");
      expect(terminalClient.write).not.toHaveBeenCalled();
    });

    it("should default to automation when origin is not specified", () => {
      mockTerminal.agentState = "working";
      slice.queueCommand("test-terminal", "test data", "test description");
      expect(terminalClient.write).not.toHaveBeenCalled();
    });
  });

  describe("Error handling", () => {
    it("should warn and not write when terminal does not exist", () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      slice.queueCommand("nonexistent-terminal", "test data", "test description", "user");
      expect(terminalClient.write).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        "Cannot queue command: terminal nonexistent-terminal not found"
      );
      consoleSpy.mockRestore();
    });
  });
});
