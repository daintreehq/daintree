/**
 * Tests for the scrollable panel grid's location-move behavior (#8805).
 *
 * Earlier versions of this file enforced a 16-panel screen-fit cap; that cap
 * was removed when the grid became vertically scrollable. The tests below
 * verify the new contract: programmatic `moveTerminalToGrid` and
 * `bulkMoveToGrid` always honor the requested location. The hardware-adaptive
 * `panelLimitStore.hardLimit` is a separate, upstream creation-time ceiling.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { MAX_GRID_TERMINALS } from "../panelRegistrySlice";
import type { PtyPanelData, DevPreviewPanelData } from "@shared/types/panel";

initBuiltInPanelKinds();

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn().mockResolvedValue("test-id"),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    // No attached renderer xterm in these tests — spawn falls back to the
    // default/estimated dims path.
    get: vi.fn(() => null),
    destroy: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    wake: vi.fn(),
    wakeForFocus: vi.fn(),
  },
}));

vi.mock("../../persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

const { usePanelStore } = await import("../../panelStore");

function setTerminals(terminals: any[]) {
  usePanelStore.setState({
    panelsById: Object.fromEntries(terminals.map((t: any) => [t.id, t])),
    panelIds: terminals.map((t: any) => t.id),
  });
}

function getTerminals() {
  const s = usePanelStore.getState();
  return s.panelIds.map((id) => s.panelsById[id]);
}

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
    usePanelStore.getState().reset();
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
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

  describe("dev-preview state", () => {
    it("preserves dev server fields when adding a dev-preview panel", async () => {
      await usePanelStore.getState().addPanel({
        kind: "dev-preview",
        requestedId: "dev-preview-1",
        title: "Dev Preview",
        cwd: "/test",
        devCommand: "npm run dev",
        devServerStatus: "running",
        devServerUrl: "http://localhost:5173",
        devServerError: { type: "unknown", message: "Detected warning" },
        devServerTerminalId: "dev-preview-pty-1",
      });

      const panel = usePanelStore.getState().getTerminal("dev-preview-1") as
        | DevPreviewPanelData
        | undefined;

      expect(panel?.kind).toBe("dev-preview");
      expect(panel?.devServerStatus).toBe("running");
      expect(panel?.devServerUrl).toBe("http://localhost:5173");
      expect(panel?.devServerError).toEqual({ type: "unknown", message: "Detected warning" });
      expect(panel?.devServerTerminalId).toBe("dev-preview-pty-1");
    });
  });

  describe("moveTerminalToGrid", () => {
    it("should move terminal to grid when under capacity", () => {
      const gridTerminals = createGridTerminals(14);
      const dockedTerminal = createMockTerminal("docked-1", "dock");

      setTerminals([...gridTerminals, dockedTerminal]);

      const result = usePanelStore.getState().moveTerminalToGrid("docked-1");

      const terminal = usePanelStore.getState().panelsById["docked-1"] as PtyPanelData | undefined;
      expect(result).toBe(true);
      expect(terminal?.location).toBe("grid");
      expect(terminal?.isVisible).toBe(true);
      expect(terminal?.runtimeStatus).toBe("running");
    });

    it("should move terminal to grid when exactly at capacity minus one", () => {
      const gridTerminals = createGridTerminals(15);
      const dockedTerminal = createMockTerminal("docked-1", "dock");

      setTerminals([...gridTerminals, dockedTerminal]);

      const result = usePanelStore.getState().moveTerminalToGrid("docked-1");

      const terminal = usePanelStore.getState().panelsById["docked-1"];
      expect(result).toBe(true);
      expect(terminal?.location).toBe("grid");

      const gridCount = getTerminals().filter((t) => t!.location === "grid").length;
      expect(gridCount).toBe(16);
    });

    it("should move terminal to grid even past the legacy 16-cap (grid scrolls)", () => {
      const gridTerminals = createGridTerminals(16);
      const dockedTerminal = createMockTerminal("docked-1", "dock");

      setTerminals([...gridTerminals, dockedTerminal]);

      const result = usePanelStore.getState().moveTerminalToGrid("docked-1");

      const terminal = usePanelStore.getState().panelsById["docked-1"];
      expect(result).toBe(true);
      expect(terminal?.location).toBe("grid");

      const gridCount = getTerminals().filter((t) => t!.location === "grid").length;
      expect(gridCount).toBe(17);
    });

    it("should NOT move terminal if already in grid", () => {
      const gridTerminal = createMockTerminal("grid-1", "grid");

      setTerminals([gridTerminal]);

      usePanelStore.getState().moveTerminalToGrid("grid-1");

      const terminal = usePanelStore.getState().panelsById["grid-1"];
      expect(terminal?.location).toBe("grid");
    });
  });

  describe("bulkMoveToGrid", () => {
    it("should move all docked terminals when under capacity", () => {
      const gridTerminals = createGridTerminals(10);
      const dockedTerminals = createDockedTerminals(4);

      setTerminals([...gridTerminals, ...dockedTerminals]);

      usePanelStore.getState().bulkMoveToGrid();

      const gridCount = getTerminals().filter((t) => t!.location === "grid").length;
      const dockCount = getTerminals().filter((t) => t!.location === "dock").length;

      expect(gridCount).toBe(14);
      expect(dockCount).toBe(0);
    });

    it("should move every docked terminal even past the legacy 16-cap", () => {
      const gridTerminals = createGridTerminals(14);
      const dockedTerminals = createDockedTerminals(5);

      setTerminals([...gridTerminals, ...dockedTerminals]);

      usePanelStore.getState().bulkMoveToGrid();

      const gridCount = getTerminals().filter((t) => t!.location === "grid").length;
      const dockCount = getTerminals().filter((t) => t!.location === "dock").length;

      expect(gridCount).toBe(19);
      expect(dockCount).toBe(0);
    });

    it("should move all docked terminals when grid already exceeds the legacy 16-cap", () => {
      const gridTerminals = createGridTerminals(16);
      const dockedTerminals = createDockedTerminals(3);

      setTerminals([...gridTerminals, ...dockedTerminals]);

      usePanelStore.getState().bulkMoveToGrid();

      const gridCount = getTerminals().filter((t) => t!.location === "grid").length;
      const dockCount = getTerminals().filter((t) => t!.location === "dock").length;

      expect(gridCount).toBe(19);
      expect(dockCount).toBe(0);
    });

    it("should move every docked terminal regardless of starting grid count", () => {
      const gridTerminals = createGridTerminals(15);
      const dockedTerminals = createDockedTerminals(3);

      setTerminals([...gridTerminals, ...dockedTerminals]);

      usePanelStore.getState().bulkMoveToGrid();

      expect(usePanelStore.getState().panelsById["dock-0"]?.location).toBe("grid");
      expect(usePanelStore.getState().panelsById["dock-1"]?.location).toBe("grid");
      expect(usePanelStore.getState().panelsById["dock-2"]?.location).toBe("grid");
    });

    it("should preserve grid focus when moving terminals", () => {
      const gridTerminals = createGridTerminals(10);
      const dockedTerminals = createDockedTerminals(2);

      setTerminals([...gridTerminals, ...dockedTerminals]);
      usePanelStore.setState({ focusedId: "grid-0" });

      usePanelStore.getState().bulkMoveToGrid();

      const { focusedId } = usePanelStore.getState();
      expect(focusedId).toBe("grid-0");
    });

    it("should do nothing when no docked terminals", () => {
      const gridTerminals = createGridTerminals(10);

      setTerminals(gridTerminals);

      usePanelStore.getState().bulkMoveToGrid();

      const gridCount = getTerminals().filter((t) => t!.location === "grid").length;
      expect(gridCount).toBe(10);
    });
  });

  describe("Edge cases", () => {
    it("should handle empty terminal list", () => {
      setTerminals([]);

      usePanelStore.getState().bulkMoveToGrid();

      expect(getTerminals()).toHaveLength(0);
    });

    it("should move all docked terminals into the scrolling grid", () => {
      const gridTerminals = createGridTerminals(12);
      const dockedTerminals = createDockedTerminals(4);

      setTerminals([...gridTerminals, ...dockedTerminals]);

      usePanelStore.getState().bulkMoveToGrid();

      const gridCount = getTerminals().filter((t) => t!.location === "grid").length;
      expect(gridCount).toBe(16);
    });

    it("treats panels with undefined location as grid members but still allows moves", () => {
      const gridTerminals = createGridTerminals(14);
      const undefinedTerminals = [
        createMockTerminal("undefined-1", "grid"),
        createMockTerminal("undefined-2", "grid"),
      ];
      undefinedTerminals.forEach((t) => (t.location = undefined));
      const dockedTerminal = createMockTerminal("docked-1", "dock");

      setTerminals([...gridTerminals, ...undefinedTerminals, dockedTerminal]);

      const result = usePanelStore.getState().moveTerminalToGrid("docked-1");

      const terminal = usePanelStore.getState().panelsById["docked-1"];
      expect(result).toBe(true);
      expect(terminal?.location).toBe("grid");
    });

    it("should set focus on the docked terminal that moved to the grid", () => {
      const gridTerminals = createGridTerminals(16);
      const dockedTerminal = createMockTerminal("docked-1", "dock");

      setTerminals([...gridTerminals, dockedTerminal]);
      usePanelStore.setState({ focusedId: "grid-0" });

      usePanelStore.getState().moveTerminalToGrid("docked-1");

      const { focusedId } = usePanelStore.getState();
      expect(focusedId).toBe("docked-1");
    });

    it("should set focus when move succeeds", () => {
      const gridTerminals = createGridTerminals(15);
      const dockedTerminal = createMockTerminal("docked-1", "dock");

      setTerminals([...gridTerminals, dockedTerminal]);
      usePanelStore.setState({ focusedId: "grid-0" });

      usePanelStore.getState().moveTerminalToGrid("docked-1");

      const { focusedId } = usePanelStore.getState();
      expect(focusedId).toBe("docked-1");
    });
  });

  describe("getGridCount", () => {
    it("should return 0 when no terminals", () => {
      setTerminals([]);
      expect(usePanelStore.getState().getGridCount()).toBe(0);
    });

    it("should count grid-location terminals", () => {
      setTerminals(createGridTerminals(5));
      expect(usePanelStore.getState().getGridCount()).toBe(5);
    });

    it("should count undefined-location terminals as grid", () => {
      const terminals = createGridTerminals(3);
      terminals.forEach((t) => (t.location = undefined));
      setTerminals(terminals);
      expect(usePanelStore.getState().getGridCount()).toBe(3);
    });

    it("should count mixed grid + undefined but not dock or trash", () => {
      const grid = createGridTerminals(4);
      const undefinedLoc = [createMockTerminal("u-1", "grid"), createMockTerminal("u-2", "grid")];
      undefinedLoc.forEach((t) => (t.location = undefined));
      const dock = createDockedTerminals(3);
      const trash = [createMockTerminal("trash-1", "trash")];

      setTerminals([...grid, ...undefinedLoc, ...dock, ...trash]);
      expect(usePanelStore.getState().getGridCount()).toBe(6);
    });
  });

  describe("hasGridFocus with undefined location", () => {
    it("should preserve focus when focused terminal has undefined location (bulkMoveToGrid)", () => {
      const focusedTerminal = createMockTerminal("focused-1", "grid");
      focusedTerminal.location = undefined;
      const dockedTerminals = createDockedTerminals(2);

      setTerminals([focusedTerminal, ...dockedTerminals]);
      usePanelStore.setState({ focusedId: "focused-1" });

      usePanelStore.getState().bulkMoveToGrid();

      expect(usePanelStore.getState().focusedId).toBe("focused-1");
    });

    it("should not treat null focused terminal as having grid focus (bulkMoveToGrid)", () => {
      const dockedTerminals = createDockedTerminals(2);

      setTerminals(dockedTerminals);
      usePanelStore.setState({ focusedId: null });

      usePanelStore.getState().bulkMoveToGrid();

      // Focus should not be forcibly set to null — moved terminals get focus via moveTerminalToGrid
      const { focusedId } = usePanelStore.getState();
      expect(focusedId).not.toBe(null);
    });

    it("should preserve focus when focused terminal has undefined location (bulkMoveToGridByWorktree)", () => {
      const focusedTerminal = createMockTerminal("focused-1", "grid");
      focusedTerminal.location = undefined;
      focusedTerminal.worktreeId = "wt-1";
      const dockedTerminal = createMockTerminal("dock-1", "dock");
      dockedTerminal.worktreeId = "wt-1";

      setTerminals([focusedTerminal, dockedTerminal]);
      usePanelStore.setState({ focusedId: "focused-1" });

      usePanelStore.getState().bulkMoveToGridByWorktree("wt-1");

      expect(usePanelStore.getState().focusedId).toBe("focused-1");
    });
  });
});
