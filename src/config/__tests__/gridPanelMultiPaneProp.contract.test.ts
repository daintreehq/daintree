import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");

// `ContentPanel`'s `isMultiPanelGrid` prop defaults to `true`, and every grid
// chrome branch is gated on it. A grid host that forgets to pass it therefore
// gets multi-pane chrome on a lone pane — silently, because the default is a
// plausible value rather than a crash. `GridPanel`'s missing-definition
// fallback did exactly that until #11837, so an unavailable plugin pane was
// the one lone pane in the app wearing full-strength selection chrome.
//
// Source enforcement rather than a rendering assertion is deliberate: the
// prop's absence is invisible to any test that renders `ContentPanel`
// directly, and the fallback branch only renders when a panel kind has no
// registered component — a state the unit suites construct by mocking the
// registry away entirely.
const GRID_HOSTS = ["src/components/Terminal/GridPanel.tsx"];

function contentPanelElements(source: ts.SourceFile) {
  const found: ts.JsxOpeningLikeElement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText(source) === "ContentPanel") found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** True when the element passes the prop by name or could via a spread. */
function suppliesMultiPanelGrid(element: ts.JsxOpeningLikeElement, source: ts.SourceFile) {
  return element.attributes.properties.some((attribute) => {
    if (ts.isJsxSpreadAttribute(attribute)) return true;
    return attribute.name?.getText(source) === "isMultiPanelGrid";
  });
}

describe("grid hosts propagate isMultiPanelGrid to ContentPanel (#11837)", () => {
  for (const relativePath of GRID_HOSTS) {
    it(`${relativePath} passes it at every ContentPanel call site`, () => {
      const filePath = path.join(REPO_ROOT, relativePath);
      const source = ts.createSourceFile(
        filePath,
        fs.readFileSync(filePath, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      );

      const elements = contentPanelElements(source);
      // Guards the guard: a rename or refactor that stops matching would
      // otherwise make this suite pass by finding nothing to check.
      expect(elements.length, `${relativePath} renders ContentPanel`).toBeGreaterThan(0);

      const missing = elements
        .filter((element) => !suppliesMultiPanelGrid(element, source))
        .map((element) => source.getLineAndCharacterOfPosition(element.getStart(source)).line + 1);

      expect(missing, `${relativePath} lines missing isMultiPanelGrid`).toEqual([]);
    });
  }
});
