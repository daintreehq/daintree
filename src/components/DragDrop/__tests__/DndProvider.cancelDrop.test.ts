// Contract tests for the production cancel-drop verdict (#11291). dnd-kit
// awaits `cancelDrop` with no try/catch before releasing its internal active
// lock, so a single throw wedges every future drag until reload. The resolver
// must therefore be total: any input — including the empty-dock placeholder's
// terminal-less drag data — produces a verdict instead of throwing.
import { describe, expect, it } from "vitest";

import { shouldCancelDrop, type OverDropData } from "../dropResolution";
import type { PanelInstance } from "@shared/types/panel";

// ── Helpers ──────────────────────────────────────────────

function run(params: {
  overData?: OverDropData | null;
  activeData?: unknown;
  isWorktreeSort?: boolean;
  hasOver?: boolean;
  panelsById?: Record<string, PanelInstance | undefined>;
}): boolean {
  const { overData = null, activeData, isWorktreeSort = false, hasOver, panelsById = {} } = params;
  return shouldCancelDrop({
    hasOver: hasOver ?? overData != null,
    activeData,
    overData: overData ?? undefined,
    isWorktreeSort,
    panelsById,
  });
}

function makeDragData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    terminal: { id: "panel-1", title: "Test Panel", kind: "terminal", location: "grid" },
    sourceLocation: "grid",
    sourceIndex: 0,
    ...overrides,
  };
}

/** Drag data for a panel of a specific kind (for the #11054 dockability guard). */
function makeDragDataOfKind(kind: string): Record<string, unknown> {
  return makeDragData({
    terminal: { id: "panel-1", title: "Test Panel", kind, location: "grid" },
  });
}

// ── Tests ────────────────────────────────────────────────

describe("shouldCancelDrop", () => {
  describe("no over target", () => {
    it("cancels when there is no over target", () => {
      expect(run({ overData: null, activeData: makeDragData() })).toBe(true);
    });

    it("cancels when activeData is undefined", () => {
      expect(run({ overData: { container: "grid" }, activeData: undefined })).toBe(true);
    });
  });

  describe("placeholder and malformed drag data (#11291)", () => {
    const placeholderData = { container: "dock", isPlaceholder: true };

    it("cancels the empty-dock placeholder's terminal-less drag data without throwing", () => {
      let result: boolean | undefined;
      expect(() => {
        result = run({ overData: { container: "grid" }, activeData: placeholderData });
      }).not.toThrow();
      expect(result).toBe(true);
    });

    it("cancels placeholder data dropped on a dock chip (sortable container)", () => {
      expect(
        run({
          overData: { sortable: { containerId: "dock-container", index: 0 } },
          activeData: placeholderData,
        })
      ).toBe(true);
    });

    it("cancels when terminal is present but has no string id", () => {
      expect(
        run({
          overData: { container: "grid" },
          activeData: makeDragData({ terminal: { kind: "terminal" } }),
        })
      ).toBe(true);
      expect(
        run({
          overData: { container: "grid" },
          activeData: makeDragData({ terminal: { id: 42, kind: "terminal" } }),
        })
      ).toBe(true);
    });

    it("cancels non-object drag data", () => {
      expect(run({ overData: { container: "grid" }, activeData: "panel-1" })).toBe(true);
    });

    it("cancels placeholder data even on a data-less droppable like trash", () => {
      expect(run({ hasOver: true, overData: null, activeData: placeholderData })).toBe(true);
    });

    it("fails closed when reading the drag data throws", () => {
      const hostile = {
        get terminal(): never {
          throw new Error("boom");
        },
      };
      expect(run({ overData: { container: "grid" }, activeData: hostile })).toBe(true);
    });

    it("fails closed when a terminal field getter throws", () => {
      const hostile = {
        terminal: {
          get id(): never {
            throw new Error("boom");
          },
        },
      };
      expect(run({ overData: { container: "grid" }, activeData: hostile })).toBe(true);
    });

    it("is total even when the params object itself throws on read", () => {
      const hostile = {
        get hasOver(): never {
          throw new Error("boom");
        },
        get activeData(): never {
          throw new Error("boom");
        },
        get overData(): never {
          throw new Error("boom");
        },
        get isWorktreeSort(): never {
          throw new Error("boom");
        },
        get panelsById(): never {
          throw new Error("boom");
        },
      };
      expect(() => shouldCancelDrop(hostile)).not.toThrow();
      expect(shouldCancelDrop(hostile)).toBe(true);
    });
  });

  describe("valid drops pass through", () => {
    it("does not cancel a normal grid-to-grid drop", () => {
      expect(
        run({ overData: { container: "grid", sortable: { index: 1 } }, activeData: makeDragData() })
      ).toBe(false);
    });

    it("does not cancel a dock-to-dock drop", () => {
      expect(
        run({
          overData: { container: "dock" },
          activeData: makeDragData({ sourceLocation: "dock" }),
        })
      ).toBe(false);
    });

    it("does not cancel a drop on a data-less droppable like trash", () => {
      expect(run({ overData: {}, activeData: makeDragData() })).toBe(false);
      expect(run({ hasOver: true, overData: null, activeData: makeDragData() })).toBe(false);
    });
  });

  describe("non-dockable dock drop (#11054)", () => {
    it("cancels a review panel dropped on the dock (direct container)", () => {
      expect(
        run({ overData: { container: "dock" }, activeData: makeDragDataOfKind("review") })
      ).toBe(true);
    });

    it("cancels a dev-preview panel dropped on a dock chip (sortable container)", () => {
      expect(
        run({
          overData: { sortable: { containerId: "dock-container", index: 0 } },
          activeData: makeDragDataOfKind("dev-preview"),
        })
      ).toBe(true);
    });

    it("does not cancel a dockable non-PTY (file) panel dropped on the dock", () => {
      expect(run({ overData: { container: "dock" }, activeData: makeDragDataOfKind("file") })).toBe(
        false
      );
    });

    it("treats a missing kind as a legacy PTY panel, which is dockable", () => {
      expect(
        run({
          overData: { container: "dock" },
          activeData: makeDragData({ terminal: { id: "panel-1" } }),
        })
      ).toBe(false);
    });

    it("does not cancel a dev-preview panel dropped on the grid (dock guard is target-scoped)", () => {
      expect(
        run({ overData: { container: "grid" }, activeData: makeDragDataOfKind("dev-preview") })
      ).toBe(false);
    });
  });

  describe("non-dockable group dock drop (#11375)", () => {
    const kindPanel = (id: string, kind: string) =>
      ({ id, kind, location: "grid" }) as unknown as PanelInstance;
    const panelsById: Record<string, PanelInstance | undefined> = {
      "panel-1": kindPanel("panel-1", "terminal"),
      "panel-2": kindPanel("panel-2", "review"), // non-dockable
      "panel-3": kindPanel("panel-3", "browser"),
    };
    const groupDrag = (memberIds: string[], repKind = "terminal") =>
      makeDragData({
        terminal: { id: memberIds[0], title: "T", kind: repKind, location: "grid" },
        groupId: "group-1",
        groupPanelIds: memberIds,
      });

    it("cancels a group whose representative is dockable but a member is not", () => {
      expect(
        run({
          overData: { container: "dock" },
          activeData: groupDrag(["panel-1", "panel-2"]),
          panelsById,
        })
      ).toBe(true);
    });

    it("cancels the same mixed group dropped on a dock chip (sortable container)", () => {
      expect(
        run({
          overData: { sortable: { containerId: "dock-container", index: 0 } },
          activeData: groupDrag(["panel-1", "panel-2"]),
          panelsById,
        })
      ).toBe(true);
    });

    it("allows a group where every member is dockable", () => {
      expect(
        run({
          overData: { container: "dock" },
          activeData: groupDrag(["panel-1", "panel-3"]),
          panelsById,
        })
      ).toBe(false);
    });

    it("fails closed when a group member is missing from the store", () => {
      expect(
        run({
          overData: { container: "dock" },
          activeData: groupDrag(["panel-1", "gone"]),
          panelsById,
        })
      ).toBe(true);
    });

    it("allows a mixed group dropped on the grid (dock guard is target-scoped)", () => {
      expect(
        run({
          overData: { container: "grid" },
          activeData: groupDrag(["panel-1", "panel-2"]),
          panelsById,
        })
      ).toBe(false);
    });
  });

  describe("multi-panel group on worktree", () => {
    const groupData = makeDragData({
      groupId: "group-1",
      groupPanelIds: ["panel-1", "panel-2"],
    });

    it("cancels a multi-panel group dropped on a worktree", () => {
      expect(
        run({ overData: { type: "worktree", worktreeId: "wt-1" }, activeData: groupData })
      ).toBe(true);
    });

    it("does not cancel a single panel dropped on a worktree", () => {
      expect(
        run({ overData: { type: "worktree", worktreeId: "wt-1" }, activeData: makeDragData() })
      ).toBe(false);
    });

    it("does not cancel a group whose groupPanelIds has only one entry", () => {
      const singleEntryGroup = makeDragData({ groupId: "group-1", groupPanelIds: ["panel-1"] });
      expect(
        run({ overData: { type: "worktree", worktreeId: "wt-1" }, activeData: singleEntryGroup })
      ).toBe(false);
    });

    it("does not cancel a multi-panel group dropped on the grid", () => {
      expect(run({ overData: { container: "grid" }, activeData: groupData })).toBe(false);
    });
  });

  describe("worktree-sort drags", () => {
    it("does not cancel worktree-sort with a valid over target", () => {
      expect(
        run({
          overData: { type: "worktree", worktreeId: "wt-2" },
          activeData: makeDragData(),
          isWorktreeSort: true,
        })
      ).toBe(false);
    });

    it("does not cancel worktree-sort even when the source row unmounted mid-drag", () => {
      // Virtuoso can unmount the source row, dropping active.data.current to
      // undefined — the snapshot ref in DndProvider still owns the reorder.
      expect(
        run({
          overData: { type: "worktree", worktreeId: "wt-2" },
          activeData: undefined,
          isWorktreeSort: true,
        })
      ).toBe(false);
    });

    it("cancels worktree-sort with no over target (no-over predicate fires first)", () => {
      expect(run({ overData: null, activeData: makeDragData(), isWorktreeSort: true })).toBe(true);
    });
  });
});
