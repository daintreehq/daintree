import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const TERMINAL_PANE = "src/components/Terminal/TerminalPane.tsx";

// The pane header draws the permission-bypass warning from the launch flags
// `buildPanelProps` hands the terminal pane (#16785). The pane rendered its
// `ContentPanel` without them, so the header never showed the mark, and no
// unit suite renders the whole pane to notice: the header suites render
// `PanelHeader` directly. Source enforcement, as for `isMultiPanelGrid`
// (gridPanelMultiPaneProp.contract.test.ts), and for the same reason a spread
// does not count.
describe("the terminal pane hands its launch flags to its header (#16785)", () => {
  it("passes agentLaunchFlags at every ContentPanel call site", () => {
    const filePath = path.join(REPO_ROOT, TERMINAL_PANE);
    const source = ts.createSourceFile(
      filePath,
      fs.readFileSync(filePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );

    const elements: ts.JsxOpeningLikeElement[] = [];
    const visit = (node: ts.Node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.tagName.getText(source) === "ContentPanel"
      ) {
        elements.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(elements.length, `${TERMINAL_PANE} renders ContentPanel`).toBeGreaterThan(0);

    // After every spread, which would otherwise override it.
    const missing = elements
      .filter((element) => {
        const attributes = element.attributes.properties;
        const forwarded = attributes.findIndex(
          (attribute) =>
            ts.isJsxAttribute(attribute) &&
            attribute.name.getText(source) === "agentLaunchFlags" &&
            attribute.initializer !== undefined &&
            ts.isJsxExpression(attribute.initializer) &&
            attribute.initializer.expression?.getText(source) === "agentLaunchFlags"
        );
        return (
          forwarded === -1 ||
          attributes.slice(forwarded + 1).some((attribute) => ts.isJsxSpreadAttribute(attribute))
        );
      })
      .map((element) => source.getLineAndCharacterOfPosition(element.getStart(source)).line + 1);
    expect(missing, `${TERMINAL_PANE} lines missing agentLaunchFlags`).toEqual([]);
  });

  // The value handed on has to be the pane's own prop: destructured from the
  // props, never declared again or reassigned.
  it("takes agentLaunchFlags from the component's props and never rebinds it", () => {
    const filePath = path.join(REPO_ROOT, TERMINAL_PANE);
    const source = ts.createSourceFile(
      filePath,
      fs.readFileSync(filePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );

    const isFlagsName = (node: ts.Node | undefined) =>
      node !== undefined && ts.isIdentifier(node) && node.text === "agentLaunchFlags";
    // An assignment target, plain or destructured (`({ agentLaunchFlags } = panel)`).
    const writesFlags = (target: ts.Node): boolean => {
      if (isFlagsName(target)) return true;
      if (ts.isShorthandPropertyAssignment(target)) return isFlagsName(target.name);
      if (ts.isPropertyAssignment(target)) return writesFlags(target.initializer);
      if (ts.isSpreadAssignment(target) || ts.isSpreadElement(target)) {
        return writesFlags(target.expression);
      }
      if (ts.isObjectLiteralExpression(target)) return target.properties.some(writesFlags);
      if (ts.isArrayLiteralExpression(target)) return target.elements.some(writesFlags);
      return false;
    };
    const lineOf = (node: ts.Node) =>
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    let component: ts.FunctionDeclaration | undefined;
    const bindingElements: ts.BindingElement[] = [];
    const rebinds: number[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "TerminalPaneComponent") {
        component = node;
      }
      if (ts.isBindingElement(node) && isFlagsName(node.name)) bindingElements.push(node);
      // A parameter shadows only inside a function with a body; one in a type
      // annotation binds nothing.
      const shadowingParameter =
        ts.isParameter(node) &&
        isFlagsName(node.name) &&
        ts.isFunctionLike(node.parent) &&
        "body" in node.parent &&
        node.parent.body !== undefined;
      const rebound =
        shadowingParameter ||
        (ts.isVariableDeclaration(node) && isFlagsName(node.name)) ||
        (ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          writesFlags(node.left));
      if (rebound) rebinds.push(lineOf(node));
      ts.forEachChild(node, visit);
    };
    visit(source);

    const props = component?.parameters[0]?.name;
    expect(
      props !== undefined && ts.isObjectBindingPattern(props),
      "TerminalPaneComponent destructures its props"
    ).toBe(true);
    const own = (props as ts.ObjectBindingPattern).elements.find(
      (element) => element.propertyName === undefined && isFlagsName(element.name)
    );
    expect(own, "agentLaunchFlags is destructured from the props").toBeDefined();
    for (const element of bindingElements) {
      if (element !== own) rebinds.push(lineOf(element));
    }
    expect(rebinds, `${TERMINAL_PANE} lines rebinding agentLaunchFlags`).toEqual([]);
  });
});
