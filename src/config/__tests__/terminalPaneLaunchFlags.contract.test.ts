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

    const missing = elements
      .filter(
        (element) =>
          !element.attributes.properties.some(
            (attribute) =>
              ts.isJsxAttribute(attribute) &&
              attribute.name.getText(source) === "agentLaunchFlags" &&
              attribute.initializer !== undefined &&
              ts.isJsxExpression(attribute.initializer) &&
              attribute.initializer.expression?.getText(source) === "agentLaunchFlags"
          )
      )
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
    let component: ts.FunctionDeclaration | undefined;
    const rebinds: number[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "TerminalPaneComponent") {
        component = node;
      }
      const rebound =
        (ts.isVariableDeclaration(node) && isFlagsName(node.name)) ||
        (ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          isFlagsName(node.left));
      if (rebound)
        rebinds.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
      ts.forEachChild(node, visit);
    };
    visit(source);

    const props = component?.parameters[0]?.name;
    expect(
      props !== undefined && ts.isObjectBindingPattern(props),
      "TerminalPaneComponent destructures its props"
    ).toBe(true);
    const destructured = (props as ts.ObjectBindingPattern).elements.some(
      (element) => element.propertyName === undefined && isFlagsName(element.name)
    );
    expect(destructured, "agentLaunchFlags is destructured from the props").toBe(true);
    expect(rebinds, `${TERMINAL_PANE} lines rebinding agentLaunchFlags`).toEqual([]);
  });
});
