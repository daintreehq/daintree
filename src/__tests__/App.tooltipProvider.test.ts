import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// Every UI App renders sits under a TooltipProvider: Radix throws when a
// Tooltip mounts without one, and the crash-recovery branch returns before the
// main tree's provider, so a clipped action-trail row there would take the
// recovery dialog down with it.

const APP = path.resolve(__dirname, "../App.tsx");

function renderedBranches(): { root: string; line: number }[] {
  const source = ts.createSourceFile(
    APP,
    fs.readFileSync(APP, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const app = source.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "AppInner"
  );
  if (!app?.body) throw new Error("AppInner not found");
  const branches: { root: string; line: number }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node) && node !== app) return;
    if (ts.isReturnStatement(node) && node.expression) {
      let expr: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
      if (ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        branches.push({ root: expr.getText(source), line: line + 1 });
      }
    }
    node.forEachChild(visit);
  };
  app.body.forEachChild(visit);
  return branches;
}

describe("App tooltip provider", () => {
  it("mounts a TooltipProvider in every branch that renders a Radix-backed dialog or layout", () => {
    const branches = renderedBranches();
    const crash = branches.find((b) => b.root.includes("CrashRecoveryDialog"));
    expect(crash).toBeDefined();
    const unprovided = branches
      .filter((b) => /CrashRecoveryDialog|AppLayout/.test(b.root))
      .filter((b) => !b.root.includes("<TooltipProvider"))
      .map((b) => `App.tsx:${b.line}`);
    expect(unprovided).toEqual([]);
  });
});
