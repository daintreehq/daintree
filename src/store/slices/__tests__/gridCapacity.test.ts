/**
 * Tests for terminal grid capacity enforcement
 * Verifies that the 16-terminal limit is enforced for programmatic moves
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MAX_GRID_TERMINALS } from "../terminalRegistrySlice";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn().mockResolvedValue("test-id"),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
    setBuffering: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    destroy: vi.fn(),
    applyRendererPolicy: vi.fn(),
  },
}));

vi.mock("../../persistence/terminalPersistence", () => ({
  terminalPersistence: {
    save: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

const { useTerminalStore } = await import("../../terminalStore");

function createMockTerminal(id: string, location: "grid" | "dock" | "trash" = "grid"): any {
  return {
    id,
    type: "terminal",
    title: `Terminal ${id}`,
    cwd: "/test",
    cols: 80,
    rows: 24,
    location,
  };
}

function createGridTerminals(count: number): any[] {
  return Array.from({ length: count }, (_, i) => createMockTerminal(`grid-${i}`, "grid"));
}

function createDockedTerminals(count: number): any[] {
  return Array.from({ length: count }, (_, i) => createMockTerminal(`dock-${i}`, "dock"));
}

describe("Grid Capacity Enforcement", () => {
  beforeEach(() => {
    useTerminalStore.getState().reset();
    useTerminalStore.setState({
      terminals: [],
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
    vi.clearAllMocks();
  });

  describe("MAX_GRID_TERMINALS constant", () => {
    it("should be 16", () => {
      expect(MAX_GRID_TERMINALS).toBe(16);
    });
  });

  describe("moveTerminalToGrid", () => {
    it("should move terminal to grid when under capacity", () => {
      const gridTerminals = createGridTerminals(14);
      const dockedTerminal = createMockTerminal("docked-1", "dock");

      useTerminalStore.setState({
        terminals: [...gridTerminals, dockedTerminal],
      });

      useTerminalStore.getState().moveTerminalToGrid("docked-1");

      const terminal = useTerminalStore.getState().terminals.find((t) => t.id === "docked-1");
      expect(terminal?.location).toBe("grid");
    });

    it("should move terminal to grid when exactly at capacity minus one", () => {
      const gridTerminals = createGridTerminals(15);
      const dockedTerminal = createMockTerminal("docked-1", "dock");

      useTerminalStore.setState({
        terminals: [...gridTerminals, dockedTerminal],
      });

      useTerminalStore.getState().moveTerminalToGrid("docked-1");

      const terminal = useTerminalStore.getState().terminals.find((t) => t.id === "docked-1");
      expect(terminal?.location).toBe("grid");

      const gridCount = useTerminalStore
        .getState()
        .terminals.filter((t) => t.location === "grid").length;
      expect(gridCount).toBe(16);
    });

    it("should NOT move terminal to grid when at capacity", () => {
      const gridTerminals = createGridTerminals(16);
      const dockedTerminal = createMockTerminal("docked-1", "dock");

      useTerminalStore.setState({
        terminals: [...gridTerminals, dockedTerminal],
      });

      useTerminalStore.getState().moveTerminalToGrid("docked-1");

      const terminal = useTerminalStore.getState().terminals.find((t) => t.id === "docked-1");
      expect(terminal?.location).toBe("dock");

      const gridCount = useTerminalStore
        .getState()
        .terminals.filter((t) => t.location === "grid").length;
      expect(gridCount).toBe(16);
    });

    it("should NOT move terminal if already in grid", () => {
      const gridTerminal = createMockTerminal("grid-1", "grid");

      useTerminalStore.setState({
        terminals: [gridTerminal],
      });

      useTerminalStore.getState().moveTerminalToGrid("grid-1");

      const terminal = useTerminalStore.getState().terminals.find((t) => t.id === "grid-1");
      expect(terminal?.location).toBe("grid");
    });
  });

  describe("bulkMoveToGrid", () => {
    it("should move all docked terminals when under capacity", () => {
      const gridTerminals = createGridTerminals(10);
      const dockedTerminals = createDockedTerminals(4);

      useTerminalStore.setState({
        terminals: [...gridTerminals, ...dockedTerminals],
      });

      useTerminalStore.getState().bulkMoveToGrid();

      const gridCount = useTerminalStore
        .getState()
        .terminals.filter((t) => t.location === "grid").length;
      const dockCount = useTerminalStore
        .getState()
        .terminals.filter((t) => t.location === "dock").length;

      expect(gridCount).toBe(14);
      expect(dockCount).toBe(0);
    });

    it("should move only available capacity when docked terminals exceed available slots", () => {
      const gridTerminals = createGridTerminals(14);
      const dockedTerminals = createDockedTerminals(5);

      useTerminalStore.setState({
        terminals: [...gridTerminals, ...dockedTerminals],
      });

      useTerminalStore.getState().bulkMoveToGrid();

      const gridCount = useTerminalStore
        .getState()
        .terminals.filter((t) => t.location === "grid").length;
      const dockCount = useTerminalStore
        .getState()
        .terminals.filter((t) => t.location === "dock").length;

      expect(gridCount).toBe(16);
      expect(dockCount).toBe(3);
    });

    it("should NOT move any terminals when grid is at capacity", () => {
      const gridTerminals = createGridTerminals(16);
      const dockedTerminals = createDockedTerminals(3);

      useTerminalStore.setState({
        terminals: [...gridTerminals, ...dockedTerminals],
      });

      useTerminalStore.getState().bulkMoveToGrid();

      const gridCount = useTerminalStore
        .getState()
        .terminals.filter((t) => t.location === "grid").length;
      const dockCount = useTerminalStore
        .getState()
        .terminals.filter((t) => t.location === "dock").length;

      expect(gridCount).toBe(16);
      expect(dockCount).toBe(3);
    });

    it("should move first N terminals when limited capacity", () => {
      const gridTerminals = createGridTerminals(15);
      const dockedTerminals = createDockedTerminals(3);

      useTerminalStore.setState({
        terminals: [...gridTerminals, ...dockedTerminals],
      });

      useTerminalStore.getState().bulkMoveToGrid();

      const movedTerminal = useTerminalStore.getState().terminals.find((t) => t.id === "dock-0");
      const remainingTerminal1 = useTerminalStore
        .getState()
        .terminals.find((t) => t.id === "dock-1");
      const remainingTerminal2 = useTerminalStore
        .getState()
        .terminals.find((t) => t.id === "dock-2");

      expect(movedTerminal?.location).toBe("grid");
      expect(remainingTerminal1?.location).toBe("dock");
      expect(remainingTerminal2?.location).toBe("dock");
    });

    it("should preserve grid focus when moving terminals", () => {
      const gridTerminals = createGridTerminals(10);
      const dockedTerminals = createDockedTerminals(2);

      useTerminalStore.setState({
        terminals: [...gridTerminals, ...dockedTerminals],
        focusedId: "grid-0",
      });

      useTerminalStore.getState().bulkMoveToGrid();

      const { focusedId } = useTerminalStore.getState();
      expect(focusedId).toBe("grid-0");
    });

    it("should do nothing when no docked terminals", () => {
      const gridTerminals = createGridTerminals(10);

      useTerminalStore.setState({
        terminals: gridTerminals,
      });

      useTerminalStore.getState().bulkMoveToGrid();

      const gridCount = useTerminalStore
        .getState()
        .terminals.filter((t) => t.location === "grid").length;
      expect(gridCount).toBe(10);
    });
  });

  describe("Edge cases", () => {
    it("should handle empty terminal list", () => {
      useTerminalStore.setState({ terminals: [] });

      useTerminalStore.getState().bulkMoveToGrid();

      expect(useTerminalStore.getState().terminals).toHaveLength(0);
    });

    it("should handle exactly fitting capacity", () => {
      const gridTerminals = createGridTerminals(12);
      const dockedTerminals = createDockedTerminals(4);

      useTerminalStore.setState({
        terminals: [...gridTerminals, ...dockedTerminals],
      });

      useTerminalStore.getState().bulkMoveToGrid();

      const gridCount = useTerminalStore
        .getState()
        .terminals.filter((t) => t.location === "grid").length;
      expect(gridCount).toBe(16);
    });

    it("should count terminals with undefined location as grid", () => {
      const gridTerminals = createGridTerminals(14);
      const undefinedTerminals = [
        createMockTerminal("undefined-1", "grid"),
        createMockTerminal("undefined-2", "grid"),
      ];
      undefinedTerminals.forEach((t) => (t.location = undefined));
      const dockedTerminal = createMockTerminal("docked-1", "dock");

      useTerminalStore.setState({
        terminals: [...gridTerminals, ...undefinedTerminals, dockedTerminal],
      });

      useTerminalStore.getState().moveTerminalToGrid("docked-1");

      const terminal = useTerminalStore.getState().terminals.find((t) => t.id === "docked-1");
      expect(terminal?.location).toBe("dock");

      const gridAndUndefinedCount = useTerminalStore
        .getState()
        .terminals.filter((t) => t.location === "grid" || t.location === undefined).length;
      expect(gridAndUndefinedCount).toBe(16);
    });

    it("should NOT set focus when move is blocked", () => {
      const gridTerminals = createGridTerminals(16);
      const dockedTerminal = createMockTerminal("docked-1", "dock");

      useTerminalStore.setState({
        terminals: [...gridTerminals, dockedTerminal],
        focusedId: "grid-0",
      });

      useTerminalStore.getState().moveTerminalToGrid("docked-1");

      const { focusedId } = useTerminalStore.getState();
      expect(focusedId).toBe("grid-0");
    });

    it("should set focus when move succeeds", () => {
      const gridTerminals = createGridTerminals(15);
      const dockedTerminal = createMockTerminal("docked-1", "dock");

      useTerminalStore.setState({
        terminals: [...gridTerminals, dockedTerminal],
        focusedId: "grid-0",
      });

      useTerminalStore.getState().moveTerminalToGrid("docked-1");

      const { focusedId } = useTerminalStore.getState();
      expect(focusedId).toBe("docked-1");
    });
  });
});
