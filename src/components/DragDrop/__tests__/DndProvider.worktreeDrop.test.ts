import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { pointerWithin, type ClientRect, type CollisionDetection } from "@dnd-kit/core";
import { resolveCardDropWorktreeId, type OverDropData } from "../dropResolution";
import { getWorktreeSortDragId } from "../SortableWorktreeCard";
import { getAccordionDragId } from "../SortableWorktreeTerminal";

// The sidebar card lights up over either of its two stacked droppables, so a
// panel or tab group released over either must move to that worktree (#14962).
describe("resolveCardDropWorktreeId", () => {
  it("reads the card's drop target, over whatever id dnd-kit reports", () => {
    expect(
      resolveCardDropWorktreeId({ type: "worktree", worktreeId: "wt-b" }, "worktree-drop-wt-b")
    ).toBe("wt-b");
    expect(
      resolveCardDropWorktreeId(
        { type: "worktree", worktreeId: "wt-data" },
        getWorktreeSortDragId("wt-id")
      )
    ).toBe("wt-data");
  });

  it("reads the row's sortable, which pointerWithin can resolve instead", () => {
    expect(
      resolveCardDropWorktreeId(
        { sortable: { containerId: "worktree-list", index: 2 } },
        getWorktreeSortDragId("feature-login-fix")
      )
    ).toBe("feature-login-fix");
    expect(resolveCardDropWorktreeId(undefined, getWorktreeSortDragId("wt-c"))).toBe("wt-c");
  });

  // An expanded card's session rows sit inside its drop target (#16920).
  it("reads a session row as its own worktree's card", () => {
    expect(
      resolveCardDropWorktreeId(
        {
          origin: "accordion",
          worktreeId: "wt-b",
          sortable: { containerId: "worktree-wt-b-accordion", index: 3 },
        },
        getAccordionDragId("t-9")
      )
    ).toBe("wt-b");
  });

  it("is null for a panel, a container, or a target naming no worktree", () => {
    expect(resolveCardDropWorktreeId({ container: "grid" }, "grid-container")).toBeNull();
    expect(
      resolveCardDropWorktreeId(
        { sortable: { containerId: "grid-container", index: 0 } },
        "panel-1"
      )
    ).toBeNull();
    expect(resolveCardDropWorktreeId({ type: "panel", worktreeId: "wt-b" }, "panel-1")).toBeNull();
    expect(resolveCardDropWorktreeId({ type: "worktree" }, "worktree-drop-")).toBeNull();
    expect(resolveCardDropWorktreeId(undefined, getWorktreeSortDragId(""))).toBeNull();
    expect(resolveCardDropWorktreeId({ type: "worktree", worktreeId: "" }, "")).toBeNull();
    expect(
      resolveCardDropWorktreeId({ origin: "accordion", worktreeId: "" }, getAccordionDragId("t-9"))
    ).toBeNull();
    expect(
      resolveCardDropWorktreeId(
        { origin: "accordion", sortable: { containerId: "worktree-wt-b-accordion", index: 3 } },
        getAccordionDragId("t-9")
      )
    ).toBeNull();
  });
});

// The geometry behind #16920, run through dnd-kit's real pointerWithin: a row in
// an expanded session list is a smaller droppable inside its card, so it ranks
// first, and the drop has to resolve it to that card's worktree.
describe("drops over an expanded session list (#16920)", () => {
  type Droppable = Parameters<CollisionDetection>[0]["droppableContainers"][number];

  function rect(left: number, top: number, width: number, height: number): ClientRect {
    return { left, top, width, height, right: left + width, bottom: top + height };
  }

  function droppable(id: string, data: OverDropData): Droppable {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- pointerWithin reads only id and data off a droppable; the node and rect refs it never touches
    return { id, key: id, disabled: false, data: { current: data } } as unknown as Droppable;
  }

  function overAt(
    x: number,
    y: number,
    targets: Array<{ droppable: Droppable; rect: ClientRect }>
  ): { id: string; data: OverDropData } {
    const [first] = pointerWithin({
      active: { id: "panel-1", data: { current: undefined }, rect: { current: {} } },
      collisionRect: rect(x - 10, y - 10, 20, 20),
      droppableRects: new Map(targets.map((t) => [t.droppable.id, t.rect])),
      droppableContainers: targets.map((t) => t.droppable),
      pointerCoordinates: { x, y },
    } as Parameters<CollisionDetection>[0]);
    if (!first) throw new Error(`nothing under ${x},${y}`);
    const target = targets.find((t) => t.droppable.id === first.id)!;
    return { id: String(first.id), data: target.droppable.data.current as OverDropData };
  }

  const card = rect(0, 0, 240, 200);
  const cardTargets = (worktreeId: string, top = 0) => [
    {
      droppable: droppable(`worktree-drop-${worktreeId}`, { type: "worktree", worktreeId }),
      rect: rect(card.left, top, card.width, card.height),
    },
    {
      droppable: droppable(getWorktreeSortDragId(worktreeId), {
        sortable: { containerId: "worktree-list", index: 1 },
      }),
      rect: rect(card.left, top, card.width, card.height),
    },
  ];
  const row = (terminalId: string, worktreeId: string, containerId: string, top: number) => ({
    droppable: droppable(getAccordionDragId(terminalId), {
      origin: "accordion",
      worktreeId,
      sortable: { containerId, index: 2 },
    }),
    rect: rect(8, top, 224, 28),
  });

  it("lands on the card underneath a hovered row", () => {
    const targets = [
      ...cardTargets("wt-b"),
      row("t-1", "wt-b", "worktree-wt-b-accordion", 112),
      row("t-2", "wt-b", "worktree-wt-b-accordion", 140),
    ];

    const over = overAt(100, 150, targets);
    expect(over.id).toBe(getAccordionDragId("t-2"));
    expect(resolveCardDropWorktreeId(over.data, over.id)).toBe("wt-b");

    const header = overAt(100, 20, targets);
    expect(resolveCardDropWorktreeId(header.data, header.id)).toBe("wt-b");
  });

  // A deleted worktree's row sits in its own rail, outside any card. It names
  // that worktree, which the move refuses, so the drop is a no-op rather than a
  // reorder at the row's index.
  it("names the deleted worktree for a row in the deleted rail", () => {
    const targets = [
      ...cardTargets("wt-live"),
      row("t-3", "wt-gone", "deleted-worktree-group-rail", 240),
    ];

    const over = overAt(100, 250, targets);
    expect(over.id).toBe(getAccordionDragId("t-3"));
    expect(resolveCardDropWorktreeId(over.data, over.id)).toBe("wt-gone");
  });
});

// handleDragEnd is not unit-drivable, so the wiring between a card drop and the
// move is held at the source. The move itself is covered in crossWorktreeMove.test.ts.
describe("DndProvider card-drop dispatch (#14962)", () => {
  const source = ts.createSourceFile(
    "DndProvider.tsx",
    fs.readFileSync(path.resolve(__dirname, "../DndProvider.tsx"), "utf-8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );

  function collect<T extends ts.Node>(guard: (node: ts.Node) => node is T, root: ts.Node): T[] {
    const found: T[] = [];
    const visit = (node: ts.Node) => {
      if (guard(node)) found.push(node);
      ts.forEachChild(node, visit);
    };
    visit(root);
    return found;
  }

  /**
   * The statements of `branch`'s own block, exactly: nothing can sit beside the
   * move to skip it, whether a nested condition or an early return.
   */
  function branchStatements(branch: ts.IfStatement): string[] {
    const block = branch.thenStatement;
    if (!ts.isBlock(block)) return [block.getText(source)];
    return block.statements.map((statement) => statement.getText(source));
  }

  /** `if` statements in handleDragEnd's own body (not its timers) with this condition. */
  function branchesOn(condition: string): ts.IfStatement[] {
    const callback = handleDragEnd();
    return collect(ts.isIfStatement, callback).filter(
      (node) =>
        node.expression.getText(source) === condition && enclosingFunction(node) === callback
    );
  }

  /** handleDragEnd's own callback, not the timers it schedules. */
  function handleDragEnd(): ts.ArrowFunction {
    const declaration = collect(ts.isVariableDeclaration, source).find(
      (node) => node.name.getText(source) === "handleDragEnd"
    );
    const init = declaration?.initializer;
    if (!init || !ts.isCallExpression(init) || !ts.isArrowFunction(init.arguments[0]!)) {
      throw new Error("handleDragEnd is no longer a useCallback arrow");
    }
    return init.arguments[0];
  }

  function enclosingFunction(node: ts.Node): ts.Node | undefined {
    let current = node.parent;
    while (current && !ts.isFunctionLike(current)) current = current.parent;
    return current;
  }

  it("moves any panel drag, group or not, dropped on a card, then skips the reorder logic", () => {
    const branches = branchesOn("isWorktreeDrop");
    expect(branches).toHaveLength(1);
    const branch = branches[0]!;

    expect(branchStatements(branch)).toEqual([
      "moveDroppedPanelToWorktree(draggedId, dropWorktreeId);",
    ]);

    const declaration = collect(ts.isVariableDeclaration, source).find(
      (node) => node.name.getText(source) === "dropWorktreeId"
    );
    expect(declaration?.initializer?.getText(source)).toBe(
      "resolveCardDropWorktreeId(overData, overId)"
    );

    const reorderGates = collect(ts.isIfStatement, source).filter(
      (node) => node.expression.getText(source) === "!isWorktreeDrop"
    );
    expect(reorderGates.length).toBeGreaterThan(0);
  });

  it("moves a sidebar row dropped on another worktree's card", () => {
    const branches = branchesOn(
      "targetWorktreeId && targetWorktreeId !== (accordionWorktreeId ?? null)"
    );
    expect(branches).toHaveLength(1);
    expect(branchStatements(branches[0]!)).toEqual([
      "moveDroppedPanelToWorktree(actualDraggedId, targetWorktreeId);",
      "return;",
    ]);
    const target = collect(ts.isVariableDeclaration, source).find(
      (node) => node.name.getText(source) === "targetWorktreeId"
    );
    expect(target?.initializer?.getText(source)).toMatch(
      /^resolveCardDropWorktreeId\(overData, overId\)/
    );
  });
});
