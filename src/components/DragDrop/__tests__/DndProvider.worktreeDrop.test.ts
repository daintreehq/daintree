import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { resolveCardDropWorktreeId } from "../DndProvider";
import { getWorktreeSortDragId } from "../SortableWorktreeCard";

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
   * The move calls made as statements of `branch`'s own block: unconditional
   * once the branch is taken, so a nested `if` around one doesn't count.
   */
  function directMoveCalls(branch: ts.IfStatement): string[][] {
    const block = branch.thenStatement;
    if (!ts.isBlock(block)) return [];
    return block.statements.flatMap((statement) => {
      if (!ts.isExpressionStatement(statement)) return [];
      const call = statement.expression;
      if (!ts.isCallExpression(call)) return [];
      if (call.expression.getText(source) !== "moveDroppedPanelToWorktree") return [];
      return [call.arguments.map((arg) => arg.getText(source))];
    });
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

    expect(directMoveCalls(branch)).toEqual([["draggedId", "dropWorktreeId"]]);
    expect(collect(ts.isReturnStatement, branch.thenStatement)).toHaveLength(0);

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
    expect(directMoveCalls(branches[0]!)).toEqual([["actualDraggedId", "targetWorktreeId"]]);
    const target = collect(ts.isVariableDeclaration, source).find(
      (node) => node.name.getText(source) === "targetWorktreeId"
    );
    expect(target?.initializer?.getText(source)).toMatch(
      /^resolveCardDropWorktreeId\(overData, overId\)/
    );
  });
});
