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

  // The value handed on has to be the pane's own prop, not a local that
  // shadows it.
  it("takes agentLaunchFlags from the component's props and never rebinds it", () => {
    const filePath = path.join(REPO_ROOT, TERMINAL_PANE);
    const source = ts.createSourceFile(
      filePath,
      fs.readFileSync(filePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );

    let component: ts.FunctionDeclaration | undefined;
    const bindings: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "TerminalPaneComponent") {
        component = node;
      }
      if (
        (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "agentLaunchFlags"
      ) {
        bindings.push(ts.SyntaxKind[node.kind]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    const props = component?.parameters[0]?.name;
    expect(
      props && ts.isObjectBindingPattern(props),
      "TerminalPaneComponent destructures its props"
    ).toBe(true);
    const destructured = (props as ts.ObjectBindingPattern).elements.some(
      (element) =>
        element.propertyName === undefined &&
        ts.isIdentifier(element.name) &&
        element.name.text === "agentLaunchFlags"
    );
    expect(destructured, "agentLaunchFlags is destructured from the props").toBe(true);
    expect(bindings, "agentLaunchFlags is bound once, by that destructure").toEqual([
      "BindingElement",
    ]);
  });
});
